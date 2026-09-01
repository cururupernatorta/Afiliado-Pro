import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import path from 'path'
import fs from 'fs'
import log from 'electron-log'
import { DatabaseManager } from './database'
import { QueueManager, SendProductsExtra } from './queue'
import { ScraperManager } from './scraper'
import { sendToRenderer, ErroDeConexao } from './utils'
import { autoRepostProduct } from './messageHelper'

const API_ID = 2040
const API_HASH = 'b18441a1ff607e10a989891a5462e627'

export class TelegramManager {
  private dbManager: DatabaseManager
  private queueManager: QueueManager
  private scraperManager: ScraperManager
  private client: TelegramClient | null = null
  private stringSession: StringSession
  private status: 'disconnected' | 'connecting' | 'code_required' | 'connected' = 'disconnected'
  private authPath: string
  private codeResolve: ((code: string) => void) | null = null

  constructor(dbManager: DatabaseManager, queueManager: QueueManager, scraperManager: ScraperManager, userDataPath: string) {
    this.dbManager = dbManager
    this.queueManager = queueManager
    this.scraperManager = scraperManager
    this.authPath = path.join(userDataPath, 'telegram-session')

    // Carregar session salva anteriormente
    let savedSession = ''
    try {
      if (fs.existsSync(this.authPath)) {
        savedSession = fs.readFileSync(this.authPath, 'utf-8')
        log.info('Session do Telegram carregada do disco')
      }
    } catch (err) {
      log.warn('Erro ao carregar session do Telegram:', err)
    }
    this.stringSession = new StringSession(savedSession)
  }

  async connect(phoneNumber: string): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return

    this.status = 'connecting'
    sendToRenderer('telegram:status', 'connecting')

    try {
      this.client = new TelegramClient(
        this.stringSession,
        API_ID,
        API_HASH,
        { connectionRetries: 5, useWSS: true }
      )

      await this.client.start({
        phoneNumber: () => Promise.resolve(phoneNumber),
        phoneCode: () => new Promise((resolve) => {
          this.status = 'code_required'
          this.codeResolve = resolve
          sendToRenderer('telegram:code-required')
          sendToRenderer('telegram:status', 'code_required')
        }),
        onError: (err) => {
          log.error('Erro no login Telegram:', err)
          this.status = 'disconnected'
          sendToRenderer('telegram:status', 'error')
        },
      })

      this.status = 'connected'
      sendToRenderer('telegram:status', 'connected')
      log.info('Telegram conectado')

      // Persistir session no disco
      try {
        const sessionString = (this.client.session.save() as unknown as string) || ''
        fs.writeFileSync(this.authPath, sessionString, 'utf-8')
        log.info('Session do Telegram salva no disco')
      } catch (err) {
        log.warn('Nao foi possivel salvar session do Telegram:', err)
      }

      this.startMonitoring()

    } catch (error) {
      log.error('Erro ao conectar Telegram:', error)
      this.status = 'disconnected'
      sendToRenderer('telegram:status', 'error')
    }
  }

  async sendCode(code: string): Promise<void> {
    if (this.codeResolve) {
      this.codeResolve(code)
      this.codeResolve = null
    } else {
      log.warn('Codigo recebido mas nenhuma promise estava aguardando')
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect()
      } catch (err) {
        log.warn('Erro ao desconectar do Telegram (sessão provavelmente já inválida):', err)
      }
      this.client = null
    }
    // Limpa a sessão salva em disco e em memória. Sem isso, um próximo connect()
    // reusa a mesma string session (válida ou não) — se ela tiver sido invalidada
    // por fora do app (revogada no Telegram, etc.), o login trava sem nunca pedir
    // o código de novo.
    try {
      if (fs.existsSync(this.authPath)) fs.unlinkSync(this.authPath)
    } catch (err) {
      log.warn('Erro ao limpar session do Telegram:', err)
    }
    this.stringSession = new StringSession('')
    this.status = 'disconnected'
    this.codeResolve = null
    sendToRenderer('telegram:status', 'disconnected')
  }

  // Fecha a conexão sem apagar a session salva — usado quando o app está
  // fechando (troca de versão, fechar a janela), não quando o usuário pede
  // pra desconectar de propósito. disconnect() apaga a session em disco;
  // chamar isso a cada fechamento do app forçava reautenticar com código por
  // SMS toda vez que uma atualização reiniciava o programa.
  async closeConnection(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect()
      } catch (err) {
        log.warn('Erro ao fechar conexão do Telegram:', err)
      }
      this.client = null
    }
  }

  getStatus(): { status: string } {
    return { status: this.status }
  }

  async getGroups(): Promise<any[]> {
    if (!this.client || this.status !== 'connected') return []
    try {
      const dialogs = await this.client.getDialogs()
      const groups = dialogs.filter((d) => d.isGroup)
      return groups.map((g) => ({
        id: g.id?.toString(),
        name: g.title || 'Sem nome',
        participants: (g as any).participantsCount || 0,
      }))
    } catch (error) {
      log.error('Erro ao buscar grupos Telegram:', error)
      return []
    }
  }

  // Ver o comentário equivalente em WhatsAppManager.toggleMonitor: groupName
  // vem da tela em vez de refazer uma busca ao vivo aqui, pra não depender da
  // conexão estar de pé bem na hora do clique.
  async toggleMonitor(groupId: string, groupName: string, enabled: boolean): Promise<void> {
    this.dbManager.saveGroup({
      platform: 'telegram',
      group_id: groupId,
      group_name: groupName,
      monitored: enabled,
    })
    log.info(`Monitoramento ${enabled ? 'ativado' : 'desativado'} para grupo Telegram: ${groupName}`)
  }

  async sendProducts(groupIds: string[], productIds: number[], extra?: SendProductsExtra): Promise<void> {
    if (!this.client || this.status !== 'connected') {
      throw new ErroDeConexao('Telegram nao esta conectado')
    }
    const config = this.dbManager.getConfig()
    const products = productIds.map((id) => this.dbManager.getProductById(id)).filter(Boolean)

    let delay = 0
    for (const groupId of groupIds) {
      for (const product of products) {
        if (!product) continue
        const delayMs = delay * 1000 * (config.min_delay_seconds + Math.random() * (config.max_delay_seconds - config.min_delay_seconds))
        delay++
        await this.queueManager.addJob({
          platform: 'telegram',
          groupId,
          productId: product.id!,
          productTitle: product.title,
          productPrice: product.price,
          productImagePath: product.image_path,
          affiliateUrl: product.affiliate_url || product.original_url,
          overrideDescription: extra?.description,
          overrideCoupon: extra?.coupon,
          overrideImagePath: extra?.imageUrl,
          overrideTemplateText: extra?.templateText,
        }, delayMs)
      }
    }
  }

  async sendMessage(groupId: string, message: string, imagePath?: string): Promise<void> {
    if (!this.client || this.status !== 'connected') {
      throw new ErroDeConexao('Telegram nao esta conectado')
    }
    if (imagePath) {
      await this.client.sendFile(groupId, {
        file: imagePath,
        caption: message,
      })
    } else {
      await this.client.sendMessage(groupId, { message })
    }
  }

  private async startMonitoring(): Promise<void> {
    if (!this.client) return
    log.info('Monitoramento de grupos Telegram iniciado')

    this.client.addEventHandler(async (event: any) => {
      if (!event.message) return
      const msg = event.message
      const text = msg.text || msg.caption || ''
      if (!text) return

      const urlRegex = /(https?:\/\/[^\s]+)/g
      const urls = text.match(urlRegex)
      if (!urls) return

      const chatId = msg.chatId?.toString()
      const monitoredGroups = this.dbManager.getMonitoredGroups('telegram')
      const isMonitored = monitoredGroups.some((g) => g.group_id === chatId)
      if (!isMonitored) return

      // Em paralelo, não um de cada vez: vários links na mesma mensagem não
      // precisam esperar a raspagem+repost completo de um pra começar o outro.
      await Promise.all(urls.map((url: string) => this.processDetectedUrl(url)))
    })
  }

  private async processDetectedUrl(url: string, viaAgregador = false): Promise<void> {
    const store = this.scraperManager.affiliateManager?.detectStore(url)
    if (!store) {
      // Mesmo tratamento do WhatsApp: grupo agregador manda o encurtador dele,
      // não o link da loja. A página tem um botão apontando para a loja, e daí
      // o fluxo normal chega ao produto e gera o link de afiliado DO USUÁRIO.
      // `viaAgregador` corta a recursão em um nível.
      if (!viaAgregador) {
        const daLoja = await this.scraperManager.resolverLinkDeAgregador(url)
        if (daLoja) {
          this.dbManager.addLog({
            type: 'info',
            platform: 'telegram',
            message: 'Link de agregador resolvido para a loja',
            details: `${url.substring(0, 70)} -> ${daLoja.substring(0, 90)}`,
          })
          await this.processDetectedUrl(daLoja, true)
        }
      }
      return
    }
    try {
      log.info(`Link detectado no Telegram: ${url}`)

      // Mesmo tratamento do WhatsApp: produto já conhecido não quer dizer
      // produto já anunciado. Se nunca saiu para algum grupo de destino, vai
      // pra fila; a barreira do `send_history` no auto-repost impede repetição
      // de verdade.
      if (this.dbManager.productExistsByUrl(url)) {
        const existente = this.dbManager.getProductByUrl(url)
        if (existente?.id) {
          await autoRepostProduct(existente, 'telegram', this.dbManager, this.queueManager)
          return
        }
        log.warn(`Produto ignorado - URL ja capturada anteriormente: ${url}`)
        this.dbManager.addLog({
          type: 'warning',
          platform: 'telegram',
          message: 'Produto duplicado ignorado',
          details: `URL ja existente no banco: ${url}`,
        })
        return
      }

      const scraped = await this.scraperManager.scrapeProduct(url)
      // Ver o comentário equivalente em whatsapp.ts: usa a URL que a captura
      // resolveu, não a que veio no grupo — que costuma ser o link de afiliado
      // de outra pessoa.
      const urlDoProduto = scraped.original_url || url
      const affiliateUrl = await this.scraperManager.affiliateManager?.convertLink(urlDoProduto, store)
      const product = this.dbManager.createProduct({
        ...scraped,
        source: 'telegram',
        // Era gravado como `affiliateUrl` (camelCase), nome que não existe na
        // tabela — o objeto ia com `as any`, então nada reclamava e o link de
        // afiliado simplesmente não era salvo em nenhuma captura do Telegram.
        affiliate_url: affiliateUrl || undefined,
      } as any)

      if (!product) {
        log.warn(`Produto nao criado - provavelmente duplicado: ${url}`)
        return
      }

      this.dbManager.addLog({
        type: 'success',
        platform: 'telegram',
        message: `Produto capturado: ${product.title}`,
        details: `URL: ${url}`,
      })
      sendToRenderer('product:created', product)

      await autoRepostProduct(product, 'telegram', this.dbManager, this.queueManager)

    } catch (error) {
      log.error('Erro ao processar link do Telegram:', error)
      this.dbManager.addLog({
        type: 'error',
        platform: 'telegram',
        message: 'Falha ao capturar produto do Telegram',
        details: (error as Error).message,
      })
    }
  }

}
