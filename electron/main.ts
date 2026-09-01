import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'path'
import { DatabaseManager } from './database'
import { QueueManager, SendProductsExtra } from './queue'
import { WhatsAppManager } from './whatsapp'
import { TelegramManager } from './telegram'
import { ScraperManager } from './scraper'
import { AffiliateManager } from './affiliate'
import { setMainWindow } from './utils'
import { formatMessage, DEFAULT_TEMPLATE_TEXT, autoRepostProduct } from './messageHelper'
import log from 'electron-log'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// Fechar a janela (X) deveria minimizar pra bandeja, não encerrar o app — quem
// tem grupo/canal monitorado precisa do app rodando o dia todo. isQuitting só
// vira true quando o usuário escolhe "Sair" no menu da bandeja, ou quando o
// app está realmente encerrando (update, Cmd+Q no Mac etc.) — nesses casos o
// fechamento da janela segue normal em vez de ser interceptado.
let isQuitting = false
let dbManager: DatabaseManager
let queueManager: QueueManager
let whatsappManager: WhatsAppManager
let telegramManager: TelegramManager
let scraperManager: ScraperManager
let affiliateManager: AffiliateManager

const isDev = !app.isPackaged

// Garante que o produto tem um link de afiliado real antes de montar a mensagem —
// usada tanto no envio de verdade quanto no preview, pra que o preview nunca mostre
// o link original (não monetizado) quando o envio real vai gerar um afiliado.
// Produtos cujo link do Mercado Livre já foi regerado (ou tentado) nesta
// sessão. Some quando o app fecha, que é o comportamento desejado: se o
// usuário conectar a conta do ML depois, a próxima abertura tenta de novo.
const mlLinkJaRegenerado = new Set<number>()

async function ensureAffiliateUrl(product: { id?: number; affiliate_url?: string; original_url: string }): Promise<string> {
  const store = affiliateManager.detectStore(product.original_url)

  // Produto capturado antes de a conta do Mercado Livre ser conectada ficou
  // com o link no formato simples gravado no banco, e nunca era regerado — o
  // app só gerava link pra produto que ainda não tinha nenhum. Na prática,
  // tudo que a busca automática pegou antes do login continuava saindo sem a
  // vitrine, mesmo depois de conectar. Aqui essa conversão é refeita uma vez,
  // e só pro Mercado Livre com a conta conectada.
  // A condição antiga era "não contém meli.la". Ela pulava justamente o caso
  // pior: um produto capturado de grupo antes da v1.6.3 ficou com o `meli.la`
  // de OUTRO afiliado gravado, passava no teste e era republicado para sempre —
  // mandando a comissão para o concorrente. Não dá para distinguir o link dele
  // do nosso olhando o encurtador, então regeramos e pronto: gerar a partir da
  // URL canônica sempre produz o link do usuário.
  //
  // Uma vez por produto por sessão. Antes não havia marca nenhuma e, com a
  // conta do ML desconectada, cada envio repetia a tentativa (rede + janela
  // oculta) para sempre.
  const jaTentado = product.id != null && mlLinkJaRegenerado.has(product.id)
  const linkAntigoDoML = store === 'mercado_livre' && !!product.affiliate_url && !jaTentado
  if (linkAntigoDoML) {
    if (product.id != null) mlLinkJaRegenerado.add(product.id)
    try {
      const novo = await affiliateManager.mercadoLivreLink.generate(
        product.original_url,
        dbManager.getConfig().mercado_livre_matt_word
      )
      const link = novo?.shortUrl || novo?.longUrl
      if (link) {
        if (product.id) dbManager.updateProduct(product.id, { affiliate_url: link })
        product.affiliate_url = link
        log.info(`Link do Mercado Livre atualizado para o formato com vitrine: ${link}`)
        return link
      }
    } catch (err) {
      log.warn('Não consegui atualizar o link do Mercado Livre para o formato com vitrine:', err)
    }
  }

  if (product.affiliate_url) return product.affiliate_url
  try {
    if (store) {
      const affiliateUrl = await affiliateManager.convertLink(product.original_url, store)
      if (affiliateUrl) {
        if (product.id) dbManager.updateProduct(product.id, { affiliate_url: affiliateUrl })
        product.affiliate_url = affiliateUrl
        log.info(`Link de afiliado gerado: ${affiliateUrl}`)
        return affiliateUrl
      }
    }
  } catch (err) {
    log.warn('Erro ao gerar link de afiliado:', err)
  }
  return product.original_url
}

// A página de cupons é colada à mão pelo usuário (nenhuma loja expõe cupom por
// API — confirmado na documentação da Shopee e do Mercado Livre). Aqui ela vira
// um link de afiliado próprio, do mesmo jeito que o link do produto: é assim
// que os grupos concorrentes publicam o "resgate o cupom aqui" e ainda assim
// recebem comissão. Se a conversão falhar, publica a URL original — que leva
// pro cupom certo, só sem atribuição.
async function ensureCouponUrl(product: { coupon_url?: string }): Promise<string | undefined> {
  if (!product.coupon_url) return undefined
  try {
    const store = affiliateManager.detectStore(product.coupon_url)
    if (store) {
      const link = await affiliateManager.convertLink(product.coupon_url, store)
      if (link) return link
    }
  } catch (err) {
    log.warn('Erro ao gerar link de afiliado para a página de cupons:', err)
  }
  return product.coupon_url
}

// ==================== AUTO UPDATE ====================
function setupAutoUpdater(): void {
  if (isDev) {
    log.info('Modo desenvolvimento — auto-update desabilitado')
    return
  }

  autoUpdater.logger = log as any
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('Verificando atualizacoes...')
    sendToRenderer('update:checking')
  })

  autoUpdater.on('update-available', (info) => {
    log.info('Atualizacao disponivel:', info.version)
    sendToRenderer('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
    })
    dbManager.addLog({
      type: 'info',
      platform: 'system',
      message: `Nova versão disponível: v${info.version}`,
      details: 'Baixando automaticamente em segundo plano...',
    })
  })

  autoUpdater.on('update-not-available', () => {
    log.info('Nenhuma atualizacao disponivel')
    sendToRenderer('update:not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info(`Download progresso: ${progress.percent.toFixed(1)}%`)
    sendToRenderer('update:progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Atualizacao baixada:', info.version)
    sendToRenderer('update:downloaded', {
      version: info.version,
    })
    dbManager.addLog({
      type: 'success',
      platform: 'system',
      message: `Atualização v${info.version} pronta para instalar`,
      details: 'Reinicie o app para aplicar.',
    })
  })

  autoUpdater.on('error', (err) => {
    log.error('Erro no auto-update:', err)
    sendToRenderer('update:error', err.message)
    dbManager.addLog({
      type: 'error',
      platform: 'system',
      message: 'Erro ao verificar atualizações',
      details: err.message,
    })
  })

  // Verificar updates 30 segundos apos iniciar
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.error('Falha ao verificar updates:', err)
    })
  }, 30000)

  // Verificar a cada 4 horas
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.error('Falha ao verificar updates (periodico):', err)
    })
  }, 4 * 60 * 60 * 1000)
}

function sendToRenderer(channel: string, data?: any): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

// ==================== /AUTO UPDATE ====================

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  setMainWindow(mainWindow)

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })
}

const createTray = (): void => {
  const iconPath = path.join(__dirname, '../../assets/icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Afiliado Pro')

  const showWindow = () => {
    if (!mainWindow) { createWindow(); return }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Afiliado Pro', click: showWindow },
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit() } },
  ]))

  tray.on('click', showWindow)
}

// Busca automática de ofertas: o agendamento precisa ser refeito quando a
// configuração muda, e o botão "Buscar agora" (definido em setupIpcHandlers,
// fora deste escopo) precisa alcançar a mesma função. Por isso ficam aqui fora.
let autoScrapeTimer: NodeJS.Timeout | null = null
let buscaEmAndamento = false
let buscarOfertasAgora: (() => Promise<number>) | null = null
let reagendarBuscaAutomatica: (() => void) | null = null

app.whenReady().then(async () => {
  try {
    log.info('Afiliado Pro iniciando...')

    const userDataPath = app.getPath('userData')
    const dbPath = path.join(userDataPath, 'afiliado-pro.db')

    dbManager = new DatabaseManager(dbPath)
    dbManager.on('log', (entry) => sendToRenderer('log:entry', entry))

    queueManager = new QueueManager()
    queueManager.setDatabaseManager(dbManager)
    affiliateManager = new AffiliateManager(dbManager)
    // Os cookies do Mercado Livre são de sessão e não sobrevivem em disco por
    // conta própria — restaura os que foram guardados cifrados, senão o
    // usuário teria que reconectar a cada vez que abre o app.
    affiliateManager.mercadoLivreLink
      .restoreSession()
      .then((ok) => { if (ok) sendToRenderer('mercadolivre:status', 'connected') })
      .catch((err) => log.warn('Erro ao restaurar sessão do Mercado Livre:', err))
    scraperManager = new ScraperManager(affiliateManager, dbManager)
    whatsappManager = new WhatsAppManager(dbManager, queueManager, scraperManager, userDataPath)
    telegramManager = new TelegramManager(dbManager, queueManager, scraperManager, userDataPath)

    queueManager.setSendHandler(async (job) => {
      try {
        const { platform, groupId, productId } = job.data

        const product = dbManager.getProductById(productId)
        if (!product) {
          throw new Error(`Produto ${productId} não encontrado no banco`)
        }

        // Garantir que o link de afiliado existe
        await ensureAffiliateUrl(product)

        const config = dbManager.getConfig()

        // Prioridade: template escolhido na hora do envio (modal "Enviar Produtos",
        // só quando o usuário mexeu de propósito no seletor) > template associado ao
        // grupo (biblioteca) > template padrão do sistema. "??" em vez de "||" pra
        // não tratar um texto vazio de propósito como "nada foi escolhido".
        const template = dbManager.getAdTemplate(platform, groupId)
        const templateText = job.data.overrideTemplateText ?? template?.template_text ?? DEFAULT_TEMPLATE_TEXT

        // Aplica as edições manuais feitas antes do envio (modal "Enviar Produtos"),
        // que antes eram coletadas na tela e descartadas sem nunca chegar aqui.
        const effectiveProduct = {
          ...product,
          description: job.data.overrideDescription ?? product.description,
        }

        const message = formatMessage(effectiveProduct, templateText, {
          groupLink: config.group_link,
          coupon: job.data.overrideCoupon,
          couponUrl: await ensureCouponUrl(product),
        })

        const imagePath = job.data.overrideImagePath || product.image_path || product.image_url

        if (platform === 'whatsapp') {
          await whatsappManager.sendMessage(groupId, message, imagePath)
        } else if (platform === 'telegram') {
          await telegramManager.sendMessage(groupId, message, imagePath)
        }
      } catch (error) {
        log.error('Erro ao processar job de envio:', error)
        throw error
      }
    })

    await queueManager.init()
    queueManager.startWorker()

    setupIpcHandlers()
    createWindow()
    createTray()
    setupAutoUpdater()

    // Iniciar busca automática de ofertas
    const startAutoScrape = async (): Promise<number> => {
      // O botão "Buscar agora" e o agendamento podem cair em cima um do outro.
      // Duas varreduras simultâneas nas 4 lojas dobrariam as chamadas de API e
      // ainda disputariam o mesmo produto no `productExistsByUrl`, criando
      // duplicata — a checagem e a inserção não são atômicas entre si.
      if (buscaEmAndamento) {
        log.info('Busca de ofertas já está rodando — ignorando o novo disparo')
        return 0
      }
      buscaEmAndamento = true
      let novasOfertas = 0
      try {
        const cfg = dbManager.getConfig()
        if (!cfg.auto_scrape_enabled) return 0

        // A busca procura a união do nicho geral com o nicho de cada grupo de
        // destino. Sem isso, quem define nichos diferentes por grupo só
        // receberia ofertas do nicho global — os grupos ficariam brigando pelo
        // mesmo acervo, e os de assunto próprio nunca teriam o que postar.
        // A separação de qual oferta vai pra qual grupo acontece no envio.
        const nichosDosGrupos = dbManager
          .getEnabledAutoSendTargets()
          .map((t) => t.niche || '')
          .filter(Boolean)
        const nicho = [...new Set([cfg.niche || '', ...nichosDosGrupos].join(',').split(',').map((k) => k.trim()).filter(Boolean))].join(', ')
        if (!nicho) return 0

        // A busca de cada loja só faz sentido se der pra gerar link de afiliado
        // dela depois — sem credencial, o produto capturado ficaria com o link
        // original (sem comissão nenhuma). Antes a busca rodava pras 4 lojas
        // sempre, mesmo sem credencial configurada: remover a credencial de uma
        // loja em Configurações não parava a captura dela, só a geração do link.
        const storeHasCredentials: Record<string, boolean> = {
          amazon: !!cfg.amazon_tag,
          mercado_livre: !!cfg.mercado_livre_matt_tool,
          shopee: !!(cfg.shopee_app_id && cfg.shopee_app_secret),
          aliexpress: !!(cfg.aliexpress_app_key && cfg.aliexpress_app_secret && cfg.aliexpress_tracking_id),
        }

        const stores = ['amazon', 'mercado_livre', 'shopee', 'aliexpress']
        for (const store of stores) {
          if (!storeHasCredentials[store]) continue
          const deals = await scraperManager.searchDeals(nicho, store)
          for (const deal of deals) {
            if (!dbManager.productExistsByUrl(deal.original_url!)) {
              // Sem isto a oferta entrava como 'manual' (o padrão que o raspador
            // deixa), e o card "Produtos Capturados" — que conta source != 'manual'
            // — dava sempre zero mesmo com o app achando oferta o dia todo.
            const created = dbManager.createProduct({ ...deal, source: 'busca' } as any)
              if (created) {
                const affiliateUrl = await affiliateManager.convertLink(deal.original_url!, store as any)
                if (affiliateUrl) {
                  dbManager.updateProduct(created.id!, { affiliate_url: affiliateUrl })
                  created.affiliate_url = affiliateUrl
                }
                novasOfertas++
                log.info(`Oferta encontrada e salva: ${deal.title}`)
                dbManager.addLog({
                  type: 'success',
                  platform: 'system',
                  message: `Oferta encontrada (${store}): ${deal.title}`,
                  details: `Nicho: ${cfg.niche}`,
                })

                // Posta automaticamente nos grupos configurados (respeita o toggle
                // "Ativar Auto-Repost" em Configurações). Sem isso a oferta só ficava
                // salva na lista de Produtos, sem nunca ser enviada pra lugar nenhum.
                await Promise.all([
                  autoRepostProduct(created, 'whatsapp', dbManager, queueManager),
                  autoRepostProduct(created, 'telegram', dbManager, queueManager),
                ])
              }
            }
          }
        }
      } catch (err) {
        log.error('Erro na busca automática:', err)
      } finally {
        buscaEmAndamento = false
      }
      return novasOfertas
    }

    // Antes o agendamento era criado uma única vez, na inicialização, dentro de
    // um `if` que lia a configuração daquele momento. Ligar a busca automática
    // (ou mudar o intervalo) com o app aberto não tinha efeito nenhum até
    // reiniciar: quem ligava e ficava esperando não recebia nada, sem nenhum
    // sinal do porquê. Agora o agendamento é refeito toda vez que a
    // configuração é salva.
    reagendarBuscaAutomatica = () => {
      if (autoScrapeTimer) { clearInterval(autoScrapeTimer); autoScrapeTimer = null }
      const atual = dbManager.getConfig()
      if (!atual.auto_scrape_enabled) return
      const minutos = Math.max(15, atual.auto_scrape_interval_minutes || 360)
      autoScrapeTimer = setInterval(startAutoScrape, minutos * 60 * 1000)
      log.info(`Busca automática de ofertas agendada a cada ${minutos} min`)
    }
    buscarOfertasAgora = startAutoScrape

    const cfg = dbManager.getConfig()
    reagendarBuscaAutomatica()
    if (cfg.auto_scrape_enabled && cfg.niche) startAutoScrape()

    app.on('activate', () => {
      if (mainWindow === null) createWindow()
    })
  } catch (error) {
    log.error('Erro fatal na inicialização:', error)
    isQuitting = true
    app.quit()
  }
})

app.on('before-quit', async () => {
  // Marca antes de tudo: antes-quit dispara pra qualquer encerramento de
  // verdade (menu "Sair" da bandeja já marca isso também, mas cobre outros
  // gatilhos: atualização automática, Cmd+Q no Mac, etc.) — sem isso, o
  // listener de 'close' da janela (que virou "minimizar pra bandeja") ia
  // interceptar e impedir esses encerramentos.
  isQuitting = true
  log.info('Encerrando Afiliado Pro...')
  try {
    // WhatsApp/Telegram primeiro, e em paralelo: no desligamento do Windows (ao
    // contrário de um "Sair" manual), o SO só dá um tempo curto pra encerrar
    // antes de matar o processo à força. Se o fechamento das sessões ficasse
    // por último atrás de queueManager/dbManager, um kill no meio do caminho
    // podia interromper a gravação das credenciais do WhatsApp/Telegram e
    // corromper o arquivo — daí precisar escanear o QR Code de novo mesmo sem
    // ter feito logout de verdade.
    whatsappManager?.closeConnection()
    await Promise.all([
      telegramManager?.closeConnection(),
      queueManager?.close(),
    ])
    dbManager?.close()
  } catch (error) {
    log.error('Erro ao encerrar:', error)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

const setupIpcHandlers = (): void => {
  ipcMain.handle('whatsapp:connect', () => whatsappManager.connect())
  ipcMain.handle('whatsapp:disconnect', () => whatsappManager.disconnect())
  ipcMain.handle('whatsapp:getStatus', () => whatsappManager.getStatus())
  ipcMain.handle('whatsapp:getGroups', () => whatsappManager.getGroups())
  ipcMain.handle('whatsapp:toggleMonitor', (_, groupId: string, groupName: string, enabled: boolean) =>
    whatsappManager.toggleMonitor(groupId, groupName, enabled)
  )
  ipcMain.handle('whatsapp:sendProducts', (_, groupIds: string[], productIds: number[], extra?: SendProductsExtra) =>
    whatsappManager.sendProducts(groupIds, productIds, extra)
  )
  ipcMain.handle('whatsapp:getQrCode', () => whatsappManager.getQrCode())
  ipcMain.handle('whatsapp:addChannel', (_, inviteLinkOrCode: string) => whatsappManager.addChannel(inviteLinkOrCode))

  ipcMain.handle('group:getSaved', (_, platform: 'whatsapp' | 'telegram') => dbManager.getGroups(platform))

  ipcMain.handle('telegram:connect', (_, phoneNumber: string) => telegramManager.connect(phoneNumber))
  ipcMain.handle('telegram:disconnect', () => telegramManager.disconnect())
  ipcMain.handle('telegram:getStatus', () => telegramManager.getStatus())
  ipcMain.handle('telegram:getGroups', () => telegramManager.getGroups())
  ipcMain.handle('telegram:toggleMonitor', (_, groupId: string, groupName: string, enabled: boolean) =>
    telegramManager.toggleMonitor(groupId, groupName, enabled)
  )
  ipcMain.handle('telegram:sendProducts', (_, groupIds: string[], productIds: number[], extra?: SendProductsExtra) =>
    telegramManager.sendProducts(groupIds, productIds, extra)
  )
  ipcMain.handle('telegram:sendCode', (_, code: string) => telegramManager.sendCode(code))

  ipcMain.handle('mercadolivre:getStatus', () => affiliateManager.mercadoLivreLink.getStatus())
  ipcMain.handle('mercadolivre:login', () => affiliateManager.mercadoLivreLink.openLoginWindow())
  ipcMain.handle('mercadolivre:logout', () => affiliateManager.mercadoLivreLink.logout())

  ipcMain.handle('product:getAll', () => dbManager.getAllProducts())
  // O Dashboard calculava tudo a partir do que estava carregado no renderer —
  // e o renderer nunca carregava nada do banco, então os quatro cards viviam
  // zerados (ou contando só o que foi cadastrado à mão naquela sessão).
  ipcMain.handle('stats:get', () => dbManager.getDashboardStats())
  ipcMain.handle('product:getById', (_, id: number) => dbManager.getProductById(id))
  ipcMain.handle('product:create', async (_, data) => {
    let product = dbManager.createProduct(data)

    // createProduct devolve null quando a URL já está no banco. Recusar aqui
    // atrapalhava justamente quem queria consertar um produto capturado antes
    // — por exemplo, refazer o link de afiliado de algo que entrou pelo grupo.
    // Em vez de barrar, atualiza o que já existe com os dados novos e refaz o
    // link de afiliado.
    if (!product) {
      const existente = dbManager.getProductByUrl(data.original_url)
      if (!existente) {
        throw new Error('Não consegui salvar nem localizar este produto. Tente novamente.')
      }
      dbManager.updateProduct(existente.id!, {
        title: data.title ?? existente.title,
        price: data.price ?? existente.price,
        original_price: data.original_price ?? existente.original_price,
        image_url: data.image_url ?? existente.image_url,
        description: data.description ?? existente.description,
        // Zera o link pra ser regerado logo abaixo com as configurações e a
        // sessão atuais — é o que resolve produto capturado antes de conectar
        // a conta do Mercado Livre.
        affiliate_url: undefined,
      })
      product = dbManager.getProductById(existente.id!)!
      product.affiliate_url = undefined
      log.info(`Produto já existia e foi atualizado: ${product.title}`)
      dbManager.addLog({
        type: 'info',
        platform: 'system',
        message: `Produto já cadastrado foi atualizado: ${product.title}`,
        details: 'Os dados foram substituídos e o link de afiliado, regerado.',
      })
    }
    // Tentar converter para link de afiliado automaticamente
    if (product.original_url && !product.affiliate_url) {
      try {
        const store = affiliateManager.detectStore(product.original_url)
        if (store) {
          const affiliateUrl = await affiliateManager.convertLink(product.original_url, store)
          if (affiliateUrl) {
            dbManager.updateProduct(product.id!, { affiliate_url: affiliateUrl })
            product.affiliate_url = affiliateUrl
            log.info(`Link de afiliado gerado para produto manual: ${product.title}`)
          }
        }
      } catch (err) {
        log.warn('Erro ao gerar link de afiliado para produto manual:', err)
      }
    }
    return product
  })
  ipcMain.handle('product:update', (_, id: number, data) => dbManager.updateProduct(id, data))
  ipcMain.handle('product:delete', (_, id: number) => dbManager.deleteProduct(id))
  ipcMain.handle('product:scrape', (_, url: string) => scraperManager.scrapeProduct(url))

  ipcMain.handle('config:get', () => dbManager.getConfig())
  ipcMain.handle('config:save', (_, config) => {
    dbManager.saveConfig(config)
    // Sem isto, mudar o intervalo ou ligar a busca só passa a valer no próximo
    // início do app.
    reagendarBuscaAutomatica?.()
    // Credencial nova do AliExpress merece uma tentativa imediata, sem esperar
    // a trava de 6h que uma credencial inválida deixou armada.
    affiliateManager.resetarBloqueioAliExpress()
  })
  ipcMain.handle('whatsapp:sweep-history', async (_, horas: number) => {
    return whatsappManager.varrerHistorico(Number(horas) || 1)
  })
  ipcMain.handle('scrape:run-now', async () => {
    if (!buscarOfertasAgora) return { ok: false, erro: 'A busca de ofertas ainda não foi inicializada.' }
    const cfg = dbManager.getConfig()
    if (!cfg.auto_scrape_enabled) return { ok: false, erro: 'A busca automática está desligada.' }
    const novas = await buscarOfertasAgora()
    return { ok: true, novas }
  })

  ipcMain.handle('queue:getJobs', () => queueManager.getJobs())
  ipcMain.handle('queue:pause', () => queueManager.pause())
  ipcMain.handle('queue:resume', () => queueManager.resume())
  ipcMain.handle('queue:clear', () => queueManager.clear())

  ipcMain.handle('logs:get', (_, limit: number, offset: number) => dbManager.getLogs(limit, offset))

  ipcMain.handle('autoSend:getTargets', (_, platform?: string) => dbManager.getAutoSendTargets(platform as any))
  ipcMain.handle('autoSend:saveTarget', (_, target) => dbManager.saveAutoSendTarget(target))
  ipcMain.handle('autoSend:removeTarget', (_, platform: string, groupId: string) => dbManager.removeAutoSendTarget(platform, groupId))
  ipcMain.handle('autoSend:toggleTarget', (_, platform: string, groupId: string, enabled: boolean) => dbManager.toggleAutoSendTarget(platform, groupId, enabled))

  ipcMain.handle('adTemplate:get', (_, platform: string, groupId: string) => dbManager.getAdTemplate(platform, groupId))
  ipcMain.handle('adTemplate:assign', (_, platform: string, groupId: string, templateId: number | null) =>
    dbManager.assignAdTemplate(platform, groupId, templateId)
  )

  // Biblioteca de templates de mensagem
  ipcMain.handle('messageTemplate:list', () => dbManager.getMessageTemplates())
  ipcMain.handle('messageTemplate:create', (_, template: { name: string; template_text: string }) =>
    dbManager.createMessageTemplate(template)
  )
  ipcMain.handle('messageTemplate:update', (_, id: number, template: { name?: string; template_text?: string }) =>
    dbManager.updateMessageTemplate(id, template)
  )
  ipcMain.handle('messageTemplate:delete', (_, id: number) => dbManager.deleteMessageTemplate(id))
  ipcMain.handle('messageTemplate:getDefault', () => DEFAULT_TEMPLATE_TEXT)

  // Renderiza uma prévia de mensagem usando o mesmo formatador do envio real
  // (evita ter uma segunda lógica de montagem de texto só pra preview, que pode
  // ficar diferente do que é realmente enviado).
  ipcMain.handle('product:previewMessage', async (_, productId: number, templateText: string, extra: { coupon?: string; description?: string }) => {
    const product = dbManager.getProductById(productId)
    if (!product) return ''
    const affiliateUrl = await ensureAffiliateUrl(product)
    const config = dbManager.getConfig()
    const effectiveProduct = { ...product, affiliate_url: affiliateUrl, description: extra?.description ?? product.description }
    return formatMessage(effectiveProduct, templateText, {
      groupLink: config.group_link,
      coupon: extra?.coupon,
    })
  })

  // Auto Update
  ipcMain.handle('update:check', () => autoUpdater.checkForUpdatesAndNotify())
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true)
  })
  ipcMain.handle('app:getVersion', () => app.getVersion())
}
