import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'path'
import { DatabaseManager } from './database'
import { QueueManager, SendProductsExtra } from './queue'
import { WhatsAppManager } from './whatsapp'
import { TelegramManager } from './telegram'
import { ScraperManager } from './scraper'
import { AffiliateManager } from './affiliate'
import { setMainWindow } from './utils'
import { formatMessage } from './messageHelper'
import log from 'electron-log'

let mainWindow: BrowserWindow | null = null
let dbManager: DatabaseManager
let queueManager: QueueManager
let whatsappManager: WhatsAppManager
let telegramManager: TelegramManager
let scraperManager: ScraperManager
let affiliateManager: AffiliateManager

const isDev = !app.isPackaged

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
  })

  autoUpdater.on('error', (err) => {
    log.error('Erro no auto-update:', err)
    sendToRenderer('update:error', err.message)
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

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })
}

app.whenReady().then(async () => {
  try {
    log.info('Afiliado Pro iniciando...')

    const userDataPath = app.getPath('userData')
    const dbPath = path.join(userDataPath, 'afiliado-pro.db')

    dbManager = new DatabaseManager(dbPath)
    queueManager = new QueueManager()
    queueManager.setDatabaseManager(dbManager)
    affiliateManager = new AffiliateManager(dbManager)
    scraperManager = new ScraperManager(affiliateManager)
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
        if (!product.affiliate_url && product.original_url) {
          try {
            const store = affiliateManager.detectStore(product.original_url)
            if (store) {
              const affiliateUrl = await affiliateManager.convertLink(product.original_url, store)
              if (affiliateUrl) {
                dbManager.updateProduct(product.id!, { affiliate_url: affiliateUrl })
                product.affiliate_url = affiliateUrl
                log.info(`Link de afiliado gerado no envio: ${product.title}`)
              }
            }
          } catch (err) {
            log.warn('Erro ao gerar link de afiliado no envio:', err)
          }
        }

        const config = dbManager.getConfig()
        const template = dbManager.getAdTemplate(platform, groupId)

        // Template padrao SEM link da plataforma, COM link do grupo
        const templateText = template?.template_text ||
          '*{title}*\n\n' +
          '💰 {price_line}\n\n' +
          '📝 {description}\n\n' +
          '🔗 {affiliate_url}\n\n' +
          '⚡ Corra antes que acabe!\n\n' +
          '👥 Entre no nosso grupo de ofertas: {group_link}'

        // Aplica as edições manuais feitas antes do envio (modal "Enviar Produtos"),
        // que antes eram coletadas na tela e descartadas sem nunca chegar aqui.
        const effectiveProduct = {
          ...product,
          description: job.data.overrideDescription ?? product.description,
        }

        const message = formatMessage(effectiveProduct, templateText, {
          groupLink: config.group_link,
          coupon: job.data.overrideCoupon,
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
    setupAutoUpdater()

    // Iniciar busca automática de ofertas
    const startAutoScrape = async () => {
      try {
        const cfg = dbManager.getConfig()
        if (!cfg.auto_scrape_enabled || !cfg.niche) return

        const stores = ['amazon', 'mercado_livre', 'shopee', 'aliexpress']
        for (const store of stores) {
          const deals = await scraperManager.searchDeals(cfg.niche, store)
          for (const deal of deals) {
            if (!dbManager.productExistsByUrl(deal.original_url!)) {
              const created = dbManager.createProduct(deal as any)
              if (created) {
                const affiliateUrl = await affiliateManager.convertLink(deal.original_url!, store as any)
                if (affiliateUrl) {
                  dbManager.updateProduct(created.id!, { affiliate_url: affiliateUrl })
                }
                log.info(`Oferta encontrada e salva: ${deal.title}`)
              }
            }
          }
        }
      } catch (err) {
        log.error('Erro na busca automática:', err)
      }
    }

    const cfg = dbManager.getConfig()
    if (cfg.auto_scrape_enabled && cfg.niche) {
      startAutoScrape()
      setInterval(startAutoScrape, (cfg.auto_scrape_interval_hours || 6) * 60 * 60 * 1000)
    }

    app.on('activate', () => {
      if (mainWindow === null) createWindow()
    })
  } catch (error) {
    log.error('Erro fatal na inicialização:', error)
    app.quit()
  }
})

app.on('before-quit', async () => {
  log.info('Encerrando Afiliado Pro...')
  try {
    await queueManager?.close()
    dbManager?.close()
    await whatsappManager?.disconnect()
    await telegramManager?.disconnect()
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
  ipcMain.handle('whatsapp:toggleMonitor', (_, groupId: string, enabled: boolean) =>
    whatsappManager.toggleMonitor(groupId, enabled)
  )
  ipcMain.handle('whatsapp:sendProducts', (_, groupIds: string[], productIds: number[], extra?: SendProductsExtra) =>
    whatsappManager.sendProducts(groupIds, productIds, extra)
  )
  ipcMain.handle('whatsapp:getQrCode', () => whatsappManager.getQrCode())

  ipcMain.handle('telegram:connect', (_, phoneNumber: string) => telegramManager.connect(phoneNumber))
  ipcMain.handle('telegram:disconnect', () => telegramManager.disconnect())
  ipcMain.handle('telegram:getStatus', () => telegramManager.getStatus())
  ipcMain.handle('telegram:getGroups', () => telegramManager.getGroups())
  ipcMain.handle('telegram:toggleMonitor', (_, groupId: string, enabled: boolean) =>
    telegramManager.toggleMonitor(groupId, enabled)
  )
  ipcMain.handle('telegram:sendProducts', (_, groupIds: string[], productIds: number[], extra?: SendProductsExtra) =>
    telegramManager.sendProducts(groupIds, productIds, extra)
  )
  ipcMain.handle('telegram:sendCode', (_, code: string) => telegramManager.sendCode(code))

  ipcMain.handle('product:getAll', () => dbManager.getAllProducts())
  ipcMain.handle('product:getById', (_, id: number) => dbManager.getProductById(id))
  ipcMain.handle('product:create', async (_, data) => {
    const product = dbManager.createProduct(data)
    // Tentar converter para link de afiliado automaticamente
    if (product && product.original_url && !product.affiliate_url) {
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
  ipcMain.handle('config:save', (_, config) => dbManager.saveConfig(config))

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
  ipcMain.handle('adTemplate:save', (_, template) => dbManager.saveAdTemplate(template))

  // Auto Update
  ipcMain.handle('update:check', () => autoUpdater.checkForUpdatesAndNotify())
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true)
  })
  ipcMain.handle('app:getVersion', () => app.getVersion())
}
