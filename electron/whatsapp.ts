import { makeWASocket, DisconnectReason, useMultiFileAuthState, proto } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import path from 'path'
import QRCode from 'qrcode'
import log from 'electron-log'
import { DatabaseManager } from './database'
import { QueueManager } from './queue'
import { ScraperManager } from './scraper'
import { sendToRenderer } from './utils'
import { autoRepostProduct } from './messageHelper'

export class WhatsAppManager {
  private dbManager: DatabaseManager
  private queueManager: QueueManager
  private scraperManager: ScraperManager
  private sock: ReturnType<typeof makeWASocket> | null = null
  private qrCode: string | null = null
  private status: 'disconnected' | 'connecting' | 'connected' = 'disconnected'
  private authPath: string
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 5

  constructor(dbManager: DatabaseManager, queueManager: QueueManager, scraperManager: ScraperManager, userDataPath: string) {
    this.dbManager = dbManager
    this.queueManager = queueManager
    this.scraperManager = scraperManager
    this.authPath = path.join(userDataPath, 'whatsapp-auth')
  }

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return

    this.status = 'connecting'
    this.reconnectAttempts = 0
    sendToRenderer('whatsapp:status', 'connecting')

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath)

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Afiliado Pro', 'Desktop', '1.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      })

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          this.qrCode = await QRCode.toDataURL(qr)
          sendToRenderer('whatsapp:qr-code', this.qrCode)
          log.info('QR Code gerado para WhatsApp')
        }

        if (connection === 'close') {
          const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
          log.info('Conexão WhatsApp fechada. Reconectar:', shouldReconnect)

          this.status = 'disconnected'
          this.qrCode = null
          sendToRenderer('whatsapp:status', 'disconnected')

          if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++
            log.info(`Tentativa de reconexão ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)
            setTimeout(() => this.connect(), 5000)
          } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.error('Máximo de tentativas de reconexão atingido')
            sendToRenderer('whatsapp:status', 'error')
          }
        } else if (connection === 'open') {
          this.status = 'connected'
          this.qrCode = null
          this.reconnectAttempts = 0
          sendToRenderer('whatsapp:status', 'connected')
          log.info('WhatsApp conectado')
          this.startMonitoring()
        }
      })

      this.sock.ev.on('creds.update', saveCreds)

      this.sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return
        for (const msg of m.messages) {
          await this.handleIncomingMessage(msg)
        }
      })

    } catch (error) {
      log.error('Erro ao conectar WhatsApp:', error)
      this.status = 'disconnected'
      sendToRenderer('whatsapp:status', 'error')
    }
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout()
      this.sock = null
    }
    this.status = 'disconnected'
    this.qrCode = null
    this.reconnectAttempts = 0
    sendToRenderer('whatsapp:status', 'disconnected')
  }

  getStatus(): { status: string; qrCode: string | null } {
    return { status: this.status, qrCode: this.qrCode }
  }

  getQrCode(): string | null {
    return this.qrCode
  }

  async getGroups(): Promise<any[]> {
    if (!this.sock || this.status !== 'connected') return []
    try {
      const groups = await this.sock.groupFetchAllParticipating()
      return Object.values(groups).map((g: any) => ({
        id: g.id,
        name: g.subject,
        participants: g.participants?.length || 0,
      }))
    } catch (error) {
      log.error('Erro ao buscar grupos WhatsApp:', error)
      return []
    }
  }

  async toggleMonitor(groupId: string, enabled: boolean): Promise<void> {
    const groups = await this.getGroups()
    const group = groups.find((g) => g.id === groupId)
    if (!group) throw new Error('Grupo não encontrado')

    this.dbManager.saveGroup({
      platform: 'whatsapp',
      group_id: groupId,
      group_name: group.name,
      monitored: enabled,
    })
    log.info(`Monitoramento ${enabled ? 'ativado' : 'desativado'} para grupo WhatsApp: ${group.name}`)
  }

  async sendProducts(groupIds: string[], productIds: number[]): Promise<void> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp não está conectado')
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
          platform: 'whatsapp',
          groupId,
          productId: product.id!,
          productTitle: product.title,
          productPrice: product.price,
          productImagePath: product.image_path,
          affiliateUrl: product.affiliate_url || product.original_url,
        }, delayMs)
      }
    }
  }

  async sendMessage(groupId: string, message: string, imagePath?: string): Promise<void> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp nao esta conectado')
    }
    if (imagePath) {
      await this.sock.sendMessage(groupId, {
        image: { url: imagePath },
        caption: message,
      })
    } else {
      await this.sock.sendMessage(groupId, { text: message })
    }
  }

  private async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!msg.message || msg.key.fromMe) return
    const text = msg.message.conversation ||
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption || ''
    if (!text) return

    const urlRegex = /(https?:\/\/[^\s]+)/g
    const urls = text.match(urlRegex)
    if (!urls) return

    const monitoredGroups = this.dbManager.getMonitoredGroups('whatsapp')
    const isMonitored = monitoredGroups.some((g) => g.group_id === msg.key.remoteJid)
    if (!isMonitored) return

    for (const url of urls) {
      const store = this.scraperManager.affiliateManager?.detectStore(url)
      if (!store) continue
      try {
        log.info(`Link detectado no WhatsApp: ${url}`)

        // Verificar se já existe produto com essa URL (deduplicação)
        if (this.dbManager.productExistsByUrl(url)) {
          log.warn(`Produto ignorado - URL já capturada anteriormente: ${url}`)
          this.dbManager.addLog({
            type: 'warning',
            platform: 'whatsapp',
            message: 'Produto duplicado ignorado',
            details: `URL já existente no banco: ${url}`,
          })
          continue
        }

        const scraped = await this.scraperManager.scrapeProduct(url)
        const affiliateUrl = await this.scraperManager.affiliateManager?.convertLink(url, store)
        const product = this.dbManager.createProduct({
          ...scraped,
          source: 'whatsapp',
          affiliate_url: affiliateUrl || undefined,
        } as any)

        if (!product) {
          log.warn(`Produto não criado - provavelmente duplicado: ${url}`)
          continue
        }

        this.dbManager.addLog({
          type: 'success',
          platform: 'whatsapp',
          message: `Produto capturado: ${product.title}`,
          details: `URL: ${url}`,
        })
        sendToRenderer('product:created', product)

        await autoRepostProduct(product, 'whatsapp', this.dbManager, this.queueManager)

      } catch (error) {
        log.error('Erro ao processar link do WhatsApp:', error)
        this.dbManager.addLog({
          type: 'error',
          platform: 'whatsapp',
          message: 'Falha ao capturar produto do WhatsApp',
          details: (error as Error).message,
        })
      }
    }
  }

  private async startMonitoring(): Promise<void> {
    log.info('Monitoramento de grupos WhatsApp iniciado')
  }
}
