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
import { bufferMessages, selectRecoverableMessages, trimProcessedIds } from './historyRecovery'

export class WhatsAppManager {
  private dbManager: DatabaseManager
  private queueManager: QueueManager
  private scraperManager: ScraperManager
  private sock: ReturnType<typeof makeWASocket> | null = null
  private qrCode: string | null = null
  private status: 'disconnected' | 'connecting' | 'connected' = 'disconnected'
  private authPath: string
  private reconnectAttempts: number = 0
  // Teto da espera entre tentativas. Não existe mais limite de tentativas: o
  // app precisa se recuperar sozinho de uma queda de qualquer duração, já que
  // fica aberto o dia todo monitorando grupos.
  private readonly MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000
  private reconnectTimer: NodeJS.Timeout | null = null

  // Mensagens que o WhatsApp entrega na sincronização de histórico, guardadas
  // por grupo/canal. Servem pra duas recuperações: (1) o que passou enquanto o
  // app estava fechado ou o WhatsApp caído — como só processamos mensagens
  // novas em tempo real, cada queda (a cada 30-90min, segundo os logs reais)
  // era uma janela cega permanente; (2) o histórico recente de um grupo que
  // acabou de ser marcado como monitorado, que antes só valia dali pra frente.
  private historyBuffer = new Map<string, proto.IWebMessageInfo[]>()
  private processedHistoryIds = new Set<string>()
  // Janela curta de propósito: recuperar oferta de dias atrás encheria os
  // grupos de destino com promoção provavelmente vencida.
  private readonly HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000
  private readonly HISTORY_MAX_PER_GROUP = 30
  private readonly PROCESSED_IDS_CAP = 5000

  // Diagnóstico de recepção. Quando o tester diz "parou de capturar", o log
  // não distinguia as causas possíveis: mensagem nenhuma chegando, mensagem
  // chegando de grupo não monitorado, ou chegando sem link de loja. Estes
  // contadores viram um resumo periódico na tela de Logs.
  private recepcao = {
    lotes: 0,
    mensagens: 0,
    porTipo: {} as Record<string, number>,
    porChat: {} as Record<string, number>,
    flushesForcados: 0,
    aposFiltroDeTipo: 0,
    semConteudo: 0,
    stubs: {} as Record<string, number>,
    semTexto: 0,
    comTexto: 0,
    deGrupoMonitorado: 0,
    comLink: 0,
  }
  private flushWatchdog: NodeJS.Timeout | null = null
  // O Baileys libera o buffer sozinho em 1-2 segundos quando o servidor avisa
  // que terminou de mandar o acumulado. 15 segundos é margem larga pra isso.
  private readonly FLUSH_WATCHDOG_MS = 15 * 1000
  private avisouBufferTravado = false
  private relatorioTimer: NodeJS.Timeout | null = null
  private readonly RELATORIO_INTERVALO_MS = 30 * 60 * 1000

  constructor(dbManager: DatabaseManager, queueManager: QueueManager, scraperManager: ScraperManager, userDataPath: string) {
    this.dbManager = dbManager
    this.queueManager = queueManager
    this.scraperManager = scraperManager
    this.authPath = path.join(userDataPath, 'whatsapp-auth')
  }

  // Resumo periódico do que o WhatsApp entregou. Sem isto, "parou de capturar"
  // é um silêncio sem causa no log: não dá pra saber se o socket parou de
  // receber, se o filtro de tipo descartou, se veio de grupo não monitorado ou
  // se simplesmente não passou oferta nenhuma no período.
  private iniciarRelatorioDeRecepcao(): void {
    if (this.relatorioTimer) return
    this.relatorioTimer = setInterval(() => this.reportarRecepcao(), this.RELATORIO_INTERVALO_MS)
  }

  private reportarRecepcao(): void {
    const r = this.recepcao
    const tipos = Object.entries(r.porTipo).map(([t, n]) => `${t}=${n}`).join(', ') || 'nenhum'
    const monitorados = this.dbManager.getMonitoredGroups('whatsapp')
    const chats = Object.entries(r.porChat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([jid, n]) => `${jid}=${n}`)
      .join(', ') || 'nenhum'
    const salvos = monitorados.map((g) => g.group_id).join(', ') || 'nenhum'

    this.dbManager.addLog({
      // Receber zero mensagem por 30 minutos com N grupos monitorados é o
      // sintoma exato que estamos caçando — sobe pra warning pra ficar visível.
      type: r.mensagens === 0 && monitorados.length > 0 ? 'warning' : 'info',
      platform: 'whatsapp',
      message: r.mensagens === 0 && monitorados.length > 0
        ? `Nenhuma mensagem recebida do WhatsApp nos últimos 30 min (${monitorados.length} grupo(s)/canal(is) monitorado(s))`
        : `Recepção do WhatsApp nos últimos 30 min: ${r.mensagens} mensagem(ns), ${r.deGrupoMonitorado} de grupo monitorado`,
      details: `lotes=${r.lotes}, mensagens=${r.mensagens}, tipos=[${tipos}], apos_filtro_de_tipo=${r.aposFiltroDeTipo}, flushes_forcados=${r.flushesForcados}, nao_decifradas=${r.semConteudo}, stubs=[${Object.entries(r.stubs).map(([t, n]) => `${t}=${n}`).join(', ') || 'nenhum'}], com_texto=${r.comTexto}, sem_texto=${r.semTexto}, com_link=${r.comLink}, de_grupo_monitorado=${r.deGrupoMonitorado}, monitorados=${monitorados.length}
chats_que_mandaram=[${chats}]
monitorados_salvos=[${salvos}]`,
    })

    this.recepcao = { lotes: 0, mensagens: 0, porTipo: {}, porChat: {}, flushesForcados: 0, aposFiltroDeTipo: 0, semConteudo: 0, stubs: {}, semTexto: 0, comTexto: 0, deGrupoMonitorado: 0, comLink: 0 }
  }

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return

    // Encerra o socket anterior antes de abrir outro. Cada reconexão criava um
    // socket novo e deixava o antigo pendurado com os listeners ainda ligados —
    // e, pior, com uma segunda cópia em memória do estado de autenticação
    // (`useMultiFileAuthState` é chamado de novo abaixo). Duas cópias gravando
    // as mesmas chaves do Signal na mesma pasta é caminho conhecido pra sessão
    // corrompida, que é o `badSession` (statusCode 500) que aparece o dia todo
    // no log do testador.
    this.encerrarSocketAnterior()

    this.status = 'connecting'
    // O contador NÃO é zerado aqui: cada tentativa de reconexão passa por este
    // método, e zerar no início deixaria a espera progressiva presa nos 5
    // segundos iniciais pra sempre. Só uma conexão de fato aberta zera.
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

      this.iniciarWatchdogDeBuffer()

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
            details: `statusCode=${statusCode ?? 'desconhecido'}, tentativas seguidas=${this.reconnectAttempts}`,
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

          if (shouldReconnect) {
            // Antes eram 5 tentativas de 5 em 5 segundos e depois o app
            // desistia PARA SEMPRE — 25 segundos de tolerância. Qualquer queda
            // de rede mais longa que isso matava a captura pelo resto do dia,
            // com o app aberto e sem nada indicando o problema (relato real:
            // parou às 19h e nunca mais voltou sozinho).
            //
            // Agora tenta indefinidamente, com espera progressiva até 5
            // minutos: reconecta rápido numa oscilação curta, sem martelar o
            // WhatsApp quando a queda é longa.
            this.reconnectAttempts++
            const espera = Math.min(5000 * 2 ** (this.reconnectAttempts - 1), this.MAX_RECONNECT_DELAY_MS)
            log.info(`Tentativa de reconexão ${this.reconnectAttempts} em ${Math.round(espera / 1000)}s`)

            // Avisa uma vez quando a coisa deixa de ser uma oscilação passageira,
            // pra não descobrir horas depois que nada estava sendo capturado.
            if (this.reconnectAttempts === 5) {
              this.dbManager.addLog({
                type: 'warning',
                platform: 'whatsapp',
                message: 'WhatsApp fora do ar há alguns minutos — nada está sendo capturado dos grupos',
                details: 'O app continua tentando reconectar sozinho. Se persistir, verifique a conexão ou reconecte em Conexões.',
              })
            }

            if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
            this.reconnectTimer = setTimeout(() => this.connect(), espera)
          }
        } else if (connection === 'open') {
          this.status = 'connected'
          this.qrCode = null
          this.reconnectAttempts = 0
          if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
          sendToRenderer('whatsapp:status', 'connected')
          log.info('WhatsApp conectado')
          this.startMonitoring()
          this.iniciarRelatorioDeRecepcao()
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
        // Contadores do diagnóstico (ver reportarRecepcao): sem eles, "não
        // capturou nada" era indistinguível de "não chegou mensagem nenhuma",
        // "chegou e o tipo foi descartado" ou "chegou de grupo não monitorado".
        this.recepcao.lotes++
        this.recepcao.mensagens += m.messages.length
        this.recepcao.porTipo[m.type] = (this.recepcao.porTipo[m.type] ?? 0) + 1
        // De QUAIS chats veio. Sem isso, "chegaram 40 mensagens e nenhuma de
        // grupo monitorado" não diz se o grupo certo está calado ou se o JID
        // que chega é diferente do que está salvo — que são problemas opostos.
        for (const msg of m.messages) {
          const jid = msg.key.remoteJid || 'sem-jid'
          this.recepcao.porChat[jid] = (this.recepcao.porChat[jid] ?? 0) + 1
        }

        const messages = m.type === 'notify'
          ? m.messages
          : m.messages.filter((msg) => msg.key.remoteJid?.endsWith('@newsletter'))
        this.recepcao.aposFiltroDeTipo += messages.length
        if (messages.length === 0) return
        // Em paralelo: um burst de várias mensagens não deve esperar a
        // raspagem+repost completo de uma pra só então começar a próxima.
        await Promise.all(messages.map((msg) => this.handleIncomingMessage(msg)))
      })

      // Sincronização de histórico: é por aqui que chega o que passou nos
      // grupos enquanto o app estava fora do ar. Guarda tudo no buffer (pra
      // quem for monitorado depois) e já processa o que é de grupo monitorado.
      this.sock.ev.on('messaging-history.set', async ({ messages }) => {
        this.bufferHistoryMessages(messages)
        await this.recoverMonitoredFromHistory(messages, 'reconexão')
      })

    } catch (error) {
      log.error('Erro ao conectar WhatsApp:', error)
      this.status = 'disconnected'
      sendToRenderer('whatsapp:status', 'error')
    }
  }

  // O Baileys põe o emissor em modo BUFFER em toda conexão (socket.js chama
  // ev.buffer() num process.nextTick assim que há credencial salva) e só libera
  // quando o servidor manda o nó `ib,,offline` dizendo que terminou de entregar
  // o acumulado. `messages.upsert` está na lista de eventos bufferáveis;
  // `connection.update` NÃO está.
  //
  // Quando esse nó não chega, o resultado é exatamente o que apareceu no log do
  // testador: o app loga "Monitorando 5 grupos" a cada reconexão, a conexão
  // parece perfeita, e nenhuma mensagem chega NUNCA — lotes=0 por 18 horas
  // seguidas. Fica tudo preso no buffer até o socket morrer, e aí se perde.
  //
  // Não temos como fazer o servidor mandar o nó que falta, então liberamos o
  // buffer por conta própria quando ele passa do tempo razoável.
  private iniciarWatchdogDeBuffer(): void {
    if (this.flushWatchdog) clearInterval(this.flushWatchdog)
    this.avisouBufferTravado = false
    this.flushWatchdog = setInterval(() => {
      const ev = this.sock?.ev as unknown as {
        isBuffering?: () => boolean
        flush?: () => boolean
      } | undefined
      // Versão do Baileys sem essas funções: não há o que fazer, e tentar
      // seria pior que não fazer nada.
      if (typeof ev?.isBuffering !== 'function' || typeof ev.flush !== 'function') return
      if (!ev.isBuffering()) return

      ev.flush()
      this.recepcao.flushesForcados++
      log.warn('Buffer de eventos do Baileys estava travado — liberado manualmente')

      // Uma linha por conexão, não uma a cada 15 segundos.
      if (!this.avisouBufferTravado) {
        this.avisouBufferTravado = true
        this.dbManager.addLog({
          type: 'warning',
          platform: 'whatsapp',
          message: 'Mensagens estavam presas na fila interna do WhatsApp — liberadas automaticamente',
          details: 'O servidor do WhatsApp não avisou que terminou de entregar o acumulado, e sem esse aviso nenhuma mensagem chegava ao app. Liberado por conta própria; a captura continua normalmente.',
        })
      }
    }, this.FLUSH_WATCHDOG_MS)
  }

  private encerrarSocketAnterior(): void {
    if (this.flushWatchdog) { clearInterval(this.flushWatchdog); this.flushWatchdog = null }
    if (!this.sock) return
    const antigo = this.sock
    this.sock = null
    try {
      // Ordem importa: tirar os listeners primeiro, senão o `end()` dispara um
      // 'connection.update' de fechamento que voltaria pelo handler antigo e
      // agendaria mais uma reconexão em cima da que já está acontecendo.
      antigo.ev.removeAllListeners('connection.update')
      antigo.ev.removeAllListeners('messages.upsert')
      antigo.ev.removeAllListeners('messaging-history.set')
      antigo.ev.removeAllListeners('creds.update')
      antigo.end(undefined)
    } catch (err) {
      log.warn('Erro ao encerrar o socket anterior do WhatsApp:', err)
    }
  }

  async disconnect(): Promise<void> {
    // Cancela qualquer reconexão agendada: desconectar de propósito não pode
    // ser desfeito por um timer que já estava correndo.
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.reconnectAttempts = 0
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
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.flushWatchdog) { clearInterval(this.flushWatchdog); this.flushWatchdog = null }
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

    // Ao ligar o monitoramento, aproveita o que já veio na sincronização de
    // histórico dessa sessão em vez de só valer dali pra frente. Roda solto
    // (sem await) pra não segurar o clique do toggle na tela enquanto raspa.
    if (enabled) {
      const buffered = this.historyBuffer.get(groupId)
      if (buffered?.length) {
        void this.recoverMonitoredFromHistory(buffered, `monitoramento ativado em ${groupName}`)
          .catch((err) => log.warn('Erro ao recuperar histórico do grupo recém-monitorado:', err))
      }
    }
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

  private bufferHistoryMessages(messages: proto.IWebMessageInfo[]): void {
    bufferMessages(this.historyBuffer, messages, this.HISTORY_MAX_AGE_MS, this.HISTORY_MAX_PER_GROUP)
  }

  // Processa mensagens antigas como se fossem novas, mas só as de grupo
  // monitorado, dentro da janela de tempo e com teto de quantidade. A
  // deduplicação por URL no banco garante que nada que já virou produto seja
  // capturado (nem repostado) de novo.
  private async recoverMonitoredFromHistory(
    messages: proto.IWebMessageInfo[],
    reason: string
  ): Promise<void> {
    const monitoredIds = new Set(
      this.dbManager.getMonitoredGroups('whatsapp').map((g) => g.group_id)
    )

    const toProcess = selectRecoverableMessages(messages, {
      monitoredIds,
      alreadyProcessedIds: this.processedHistoryIds,
      maxAgeMs: this.HISTORY_MAX_AGE_MS,
      maxPerGroup: this.HISTORY_MAX_PER_GROUP,
    })

    for (const msg of toProcess) {
      if (msg.key?.id) this.processedHistoryIds.add(msg.key.id)
    }
    trimProcessedIds(this.processedHistoryIds, this.PROCESSED_IDS_CAP)

    if (toProcess.length === 0) return

    log.info(`Recuperando ${toProcess.length} mensagem(ns) do histórico do WhatsApp (${reason})`)
    this.dbManager.addLog({
      type: 'info',
      platform: 'whatsapp',
      message: `Verificando ${toProcess.length} mensagem(ns) recentes de grupos monitorados (${reason})`,
      details: 'Ofertas já capturadas antes são ignoradas automaticamente.',
    })

    // Em série, não em paralelo: recuperação pode ter dezenas de mensagens de
    // uma vez, e cada uma dispara raspagem + geração de link (que no caso do
    // Mercado Livre abre uma janela de navegador). Em paralelo isso viraria
    // uma rajada tanto pro site quanto pra memória do app.
    for (const msg of toProcess) {
      await this.handleIncomingMessage(msg)
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
    if (msg.key.fromMe) return
    // Mensagem sem conteúdo é o ponto cego mais perigoso do fluxo: quando a
    // sessão Signal do dispositivo se desencontra, o WhatsApp entrega a
    // mensagem mas o Baileys não consegue decifrar, e ela chega com
    // `message` nulo (é o "Aguardando esta mensagem" do celular). Antes isso
    // saía por um `return` mudo — do lado de fora ficava idêntico a "não
    // chegou mensagem nenhuma", que é exatamente a dúvida que os relatos dos
    // testadores levantaram.
    if (!msg.message) {
      this.recepcao.semConteudo++
      if (msg.messageStubType != null) {
        const nome = String(msg.messageStubType)
        this.recepcao.stubs[nome] = (this.recepcao.stubs[nome] ?? 0) + 1
      }
      return
    }
    // Grupo grande de ofertas costuma ter mensagens temporárias ativadas —
    // nesse caso o Baileys embrulha a mensagem de verdade um nível mais
    // fundo (ephemeralMessage.message), e o mesmo vale pra "ver uma vez"
    // (viewOnceMessage/V2) e documento-com-legenda. Sem desembrulhar, os 3
    // campos abaixo ficam todos undefined e a mensagem passa batida com
    // texto vazio — sem log nenhum, porque essa função retorna cedo demais.
    const content = this.unwrapMessage(msg.message)
    // Grupo de ofertas manda o link na legenda de mídia tanto quanto em texto
    // solto — vídeo e documento estavam de fora e sumiam sem rastro.
    const text = content?.conversation ||
                 content?.extendedTextMessage?.text ||
                 content?.imageMessage?.caption ||
                 content?.videoMessage?.caption ||
                 content?.documentMessage?.caption || ''
    if (!text) {
      this.recepcao.semTexto++
      return
    }
    this.recepcao.comTexto++

    const urlRegex = /(https?:\/\/[^\s]+)/g
    const urls = text.match(urlRegex)
    if (!urls) return

    this.recepcao.comLink++

    const monitoredGroups = this.dbManager.getMonitoredGroups('whatsapp')
    const isMonitored = monitoredGroups.some((g) => g.group_id === msg.key.remoteJid)
    if (isMonitored) this.recepcao.deGrupoMonitorado++
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
      // Gera o link a partir da URL que a captura resolveu, não da que veio no
      // grupo. O que circula em grupo costuma ser o link de afiliado de OUTRA
      // pessoa (meli.la/..., s.shopee.com.br/...), que aponta pra vitrine dela
      // — usando essa URL, o app acabava divulgando o link do concorrente em
      // vez de trocar pelo nosso.
      const urlDoProduto = scraped.original_url || url
      const affiliateUrl = await this.scraperManager.affiliateManager?.convertLink(urlDoProduto, store)
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
