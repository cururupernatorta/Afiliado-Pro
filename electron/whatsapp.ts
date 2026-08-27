import { makeWASocket, DisconnectReason, useMultiFileAuthState, proto } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import path from 'path'
import fs from 'fs'
import QRCode from 'qrcode'
import log from 'electron-log'
import { DatabaseManager } from './database'
import { QueueManager, SendProductsExtra } from './queue'
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
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
          const isLoggedOut = statusCode === DisconnectReason.loggedOut
          const shouldReconnect = !isLoggedOut
          log.info('Conexão WhatsApp fechada. Reconectar:', shouldReconnect)

          // Sem isso não tinha nenhum rastro de quando/por que o WhatsApp caiu —
          // só descobria pela reclamação do usuário, sem saber se foi sessão
          // realmente invalidada (precisa QR de novo) ou queda passageira que
          // reconecta sozinha.
          this.dbManager.addLog({
            type: isLoggedOut ? 'error' : 'warning',
            platform: 'whatsapp',
            message: isLoggedOut
              ? 'WhatsApp desconectado — sessão invalidada, será necessário escanear o QR Code novamente'
              : 'WhatsApp desconectado — tentando reconectar automaticamente',
            details: `statusCode=${statusCode ?? 'desconhecido'}, tentativa=${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
          })

          this.status = 'disconnected'
          this.qrCode = null
          sendToRenderer('whatsapp:status', 'disconnected')

          if (isLoggedOut) {
            // A sessão foi invalidada (logout feito pelo celular, dispositivo removido,
            // etc.). As credenciais salvas ficam mortas — sem limpar, o próximo connect()
            // reusa esses creds inválidos e o Baileys nunca gera um QR Code novo, só
            // fica tentando (e falhando) usar uma sessão que a Meta já invalidou.
            this.clearAuthState()
          }

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
        // Mensagem de grupo normal chega com type "notify" — o filtro original
        // evitava reprocessar a sincronização de histórico antiga (que vem com
        // outro type) toda vez que reconecta. Mas o Baileys manda TODA mensagem
        // de canal de transmissão com type "append", sempre, mesmo em tempo
        // real (não é sinal de histórico antigo pra canal) — com o filtro
        // batendo só em "notify", canal nunca capturava nada, ou capturava só
        // por acaso quando batch de tipos diferentes vinha misturado. Mantém o
        // filtro de histórico pra grupo, mas deixa passar "append" quando a
        // mensagem é de um canal (@newsletter).
        const messages = m.type === 'notify'
          ? m.messages
          : m.messages.filter((msg) => msg.key.remoteJid?.endsWith('@newsletter'))
        if (messages.length === 0) return
        // Em paralelo: um burst de várias mensagens não deve esperar a
        // raspagem+repost completo de uma pra só então começar a próxima.
        await Promise.all(messages.map((msg) => this.handleIncomingMessage(msg)))
      })

    } catch (error) {
      log.error('Erro ao conectar WhatsApp:', error)
      this.status = 'disconnected'
      sendToRenderer('whatsapp:status', 'error')
    }
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout()
      } catch (err) {
        log.warn('Erro ao deslogar do WhatsApp (sessão provavelmente já inválida):', err)
      }
      this.sock = null
    }
    this.clearAuthState()
    this.status = 'disconnected'
    this.qrCode = null
    this.reconnectAttempts = 0
    sendToRenderer('whatsapp:status', 'disconnected')
  }

  // Fecha a conexão sem deslogar nem apagar as credenciais — usado quando o
  // app está fechando (troca de versão, fechar a janela), não quando o usuário
  // pede pra desconectar de propósito. disconnect() faz logout de verdade e
  // apaga a sessão salva; chamar isso a cada fechamento do app forçava o
  // usuário a escanear o QR Code de novo toda vez que uma atualização reiniciava
  // o programa.
  closeConnection(): void {
    if (this.sock) {
      try {
        this.sock.end(undefined)
      } catch (err) {
        log.warn('Erro ao fechar conexão do WhatsApp:', err)
      }
      this.sock = null
    }
  }

  private clearAuthState(): void {
    try {
      fs.rmSync(this.authPath, { recursive: true, force: true })
      log.info('Credenciais do WhatsApp removidas — pronto para gerar um novo QR Code.')
    } catch (err) {
      log.warn('Erro ao limpar credenciais do WhatsApp:', err)
    }
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

  // groupName vem da tela, que já tem o nome (a lista exibida já é ao vivo ou
  // já foi salva antes). Antes esta função refazia a busca ao vivo dos grupos
  // no Baileys só pra redescobrir o nome — uma chamada de rede ao WhatsApp a
  // cada toggle, sem necessidade. Isso falhava sempre que o WhatsApp estava
  // no meio de uma das quedas/reconexões automáticas (frequentes, a cada
  // 30-90min segundo os logs), fazendo o toggle "desligar sozinho": o clique
  // lançava erro, a tela revertia silenciosamente e nada era salvo no banco.
  async toggleMonitor(groupId: string, groupName: string, enabled: boolean): Promise<void> {
    this.dbManager.saveGroup({
      platform: 'whatsapp',
      group_id: groupId,
      group_name: groupName,
      monitored: enabled,
    })
    log.info(`Monitoramento ${enabled ? 'ativado' : 'desativado'} para grupo/canal WhatsApp: ${groupName}`)
  }

  // Não existe API no Baileys pra listar todos os canais que a conta segue —
  // só dá pra resolver um canal específico a partir do link/código de convite.
  // Segue o canal (necessário pra receber as mensagens dele) e já salva como
  // monitorado, já que o propósito de adicionar é justamente capturar ofertas.
  async addChannel(inviteLinkOrCode: string): Promise<{ id: string; name: string }> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp não está conectado')
    }

    const code = inviteLinkOrCode.trim().split('/').pop()?.split('?')[0]
    if (!code) throw new Error('Link de convite do canal inválido')

    const metadata: any = await this.sock.newsletterMetadata('invite', code)
    if (!metadata?.id) {
      throw new Error('Não consegui encontrar esse canal. Confira o link de convite.')
    }

    // O tipo do Baileys promete `metadata.name` como string direto, mas o
    // newsletterCreate() do próprio Baileys (mesmo arquivo) mostra que a API
    // às vezes devolve o nome aninhado em thread_metadata.name.text — e
    // newsletterMetadata() não faz esse "unwrap", só repassa a resposta crua.
    // Sem checar os dois formatos, o nome vinha undefined e caía no fallback
    // "Canal sem nome" mesmo pra canais que têm nome normal.
    const name: string | undefined =
      (typeof metadata.name === 'string' && metadata.name) ||
      metadata.thread_metadata?.name?.text ||
      metadata.thread?.name?.text

    if (!name) {
      log.warn('Nome do canal não veio em nenhum formato conhecido:', JSON.stringify(metadata).substring(0, 400))
      this.dbManager.addLog({
        type: 'warning',
        platform: 'whatsapp',
        message: 'Canal adicionado sem conseguir extrair o nome',
        details: JSON.stringify(metadata).substring(0, 400),
      })
    }

    // O passo que importa é achar o ID real do canal (feito acima) — seguir é
    // só pra garantir o recebimento das mensagens. Se a conta já segue esse
    // canal, o WhatsApp responde de um jeito que o Baileys não reconhece e
    // isso derruba a chamada com um erro genérico ("unexpected response
    // structure"); não deixa isso travar o cadastro do canal.
    try {
      await this.sock.newsletterFollow(metadata.id)
    } catch (err) {
      log.warn(`Não consegui confirmar "seguir" o canal ${name} (pode já estar seguindo):`, (err as Error).message)
    }

    this.dbManager.saveGroup({
      platform: 'whatsapp',
      group_id: metadata.id,
      group_name: name || 'Canal sem nome',
      monitored: true,
    })

    log.info(`Canal WhatsApp adicionado e seguido: ${name} (${metadata.id})`)
    return { id: metadata.id, name: name || 'Canal sem nome' }
  }

  async sendProducts(groupIds: string[], productIds: number[], extra?: SendProductsExtra): Promise<void> {
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
          overrideDescription: extra?.description,
          overrideCoupon: extra?.coupon,
          overrideImagePath: extra?.imageUrl,
          overrideTemplateText: extra?.templateText,
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

  private unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | null | undefined {
    const inner = message?.ephemeralMessage?.message ||
                  message?.viewOnceMessage?.message ||
                  message?.viewOnceMessageV2?.message ||
                  message?.documentWithCaptionMessage?.message
    return inner ? this.unwrapMessage(inner) : message
  }

  private async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!msg.message || msg.key.fromMe) return
    // Grupo grande de ofertas costuma ter mensagens temporárias ativadas —
    // nesse caso o Baileys embrulha a mensagem de verdade um nível mais
    // fundo (ephemeralMessage.message), e o mesmo vale pra "ver uma vez"
    // (viewOnceMessage/V2) e documento-com-legenda. Sem desembrulhar, os 3
    // campos abaixo ficam todos undefined e a mensagem passa batida com
    // texto vazio — sem log nenhum, porque essa função retorna cedo demais.
    const content = this.unwrapMessage(msg.message)
    const text = content?.conversation ||
                 content?.extendedTextMessage?.text ||
                 content?.imageMessage?.caption || ''
    if (!text) return

    const urlRegex = /(https?:\/\/[^\s]+)/g
    const urls = text.match(urlRegex)
    if (!urls) return

    const monitoredGroups = this.dbManager.getMonitoredGroups('whatsapp')
    const isMonitored = monitoredGroups.some((g) => g.group_id === msg.key.remoteJid)
    if (!isMonitored) {
      // Só loga quando o link já bate com uma loja suportada (não é ruído de
      // qualquer URL em qualquer grupo) — serve pra distinguir "o grupo nem
      // está marcado como monitorado" de "está marcado, mas o remoteJid da
      // mensagem não bate com o group_id salvo" (ex.: WhatsApp trocando o
      // formato do JID entre a lista de grupos e o evento de mensagem — os
      // dois viriam de chamadas diferentes do Baileys).
      const hasStoreLink = urls.some((url) => this.scraperManager.affiliateManager?.detectStore(url))
      if (hasStoreLink) {
        log.warn(`Link de loja recebido, mas o grupo não está marcado como monitorado: ${msg.key.remoteJid}`)
        this.dbManager.addLog({
          type: 'warning',
          platform: 'whatsapp',
          message: 'Link de oferta recebido de um grupo não marcado como monitorado',
          details: `remoteJid: ${msg.key.remoteJid}`,
        })
      }
      return
    }

    // Em paralelo, não um de cada vez: se a mensagem (ou um burst de mensagens
    // processado quase junto) tem vários links, o segundo não precisa esperar
    // o raspador+repost do primeiro terminar pra começar — cada raspagem
    // já é uma operação de rede independente.
    await Promise.all(urls.map((url) => this.processDetectedUrl(url)))
  }

  private async processDetectedUrl(url: string): Promise<void> {
    const store = this.scraperManager.affiliateManager?.detectStore(url)
    if (!store) {
      // Isso só roda pra link vindo de grupo já marcado como monitorado (o
      // usuário escolheu esse grupo de propósito pra capturar ofertas), então
      // não é dado sensível de grupo aleatório — mas antes retornava aqui sem
      // nenhum rastro, e um link de loja não suportada (ou um encurtador que
      // o detectStore não reconhece) desaparecia sem deixar pista nenhuma.
      log.warn(`Link de grupo monitorado ignorado - loja não reconhecida: ${url}`)
      this.dbManager.addLog({
        type: 'warning',
        platform: 'whatsapp',
        message: 'Link recebido de grupo monitorado, mas loja não reconhecida',
        details: `URL: ${url}`,
      })
      return
    }
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
        return
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
        return
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

  private async startMonitoring(): Promise<void> {
    // Sem isso, um log export nunca deixava claro se o problema era "nenhum
    // grupo está marcado como monitorado" ou "está marcado mas as mensagens
    // não estão sendo capturadas" — as duas causas pareciam idênticas de
    // fora (zero produto capturado de grupo).
    const monitored = this.dbManager.getMonitoredGroups('whatsapp')
    log.info(`Monitoramento de grupos WhatsApp iniciado (${monitored.length} grupo(s)/canal(is) monitorado(s))`)
    this.dbManager.addLog({
      type: monitored.length > 0 ? 'info' : 'warning',
      platform: 'whatsapp',
      message: monitored.length > 0
        ? `Monitorando ${monitored.length} grupo(s)/canal(is): ${monitored.map((g) => g.group_name).join(', ')}`
        : 'Nenhum grupo ou canal do WhatsApp está marcado como monitorado — nenhuma oferta será capturada de grupos até ativar o monitoramento em Grupos',
      details: monitored.map((g) => g.group_id).join(', '),
    })
  }
}
