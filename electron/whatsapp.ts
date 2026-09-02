import { makeWASocket, DisconnectReason, useMultiFileAuthState, proto, getAllBinaryNodeChildren } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import path from 'path'
import fs from 'fs'
import QRCode from 'qrcode'
import log from 'electron-log'
import { DatabaseManager } from './database'
import { QueueManager, SendProductsExtra } from './queue'
import { ScraperManager } from './scraper'
import { sendToRenderer, ErroDeConexao } from './utils'
import { autoRepostProduct } from './messageHelper'
import { bufferMessages, messageTimestampMs, selectRecoverableMessages, trimProcessedIds } from './historyRecovery'

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
  // Última mensagem vista de cada grupo, em tempo real. É a âncora que o
  // `fetchMessageHistory` exige, e precisa vir daqui: a versão anterior da
  // varredura usava o `historyBuffer`, que só o `messaging-history.set`
  // preenche — e esse evento nunca dispara nas máquinas dos testadores. Sem
  // âncora, a varredura não tinha o que reprocessar nem o que pedir, e ainda
  // respondia "0 mensagens", que soa como "não havia nada perdido".
  private ultimaMensagemPorGrupo = new Map<string, proto.IWebMessageInfo>()
  private varreduraJanelaMs = 0
  private varreduraValidaAte = 0
  // O histórico pedido chega em segundos, mas a folga evita que uma resposta
  // atrasada seja processada com a janela padrão em vez da escolhida.
  private readonly VARREDURA_VALIDADE_MS = 2 * 60 * 1000

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
    proprias: 0,
    jaVistas: 0,
    reenviosPedidos: 0,
    aposFiltroDeTipo: 0,
    semConteudo: 0,
    stubs: {} as Record<string, number>,
    semTexto: 0,
    comTexto: 0,
    deGrupoMonitorado: 0,
    comLink: 0,
  }
  private estabilidadeTimer: NodeJS.Timeout | null = null
  // Uma conexão precisa se sustentar por este tempo pra ser considerada boa.
  private readonly CONEXAO_ESTAVEL_MS = 60 * 1000
  private flushWatchdog: NodeJS.Timeout | null = null
  // O Baileys libera o buffer sozinho em 1-2 segundos quando o servidor avisa
  // que terminou de mandar o acumulado. 15 segundos é margem larga pra isso.
  private readonly FLUSH_WATCHDOG_MS = 15 * 1000
  private avisouBufferTravado = false
  // Um aviso por grupo por sessão — ver avisarMensagemPropriaIgnorada.
  private avisouMensagemPropria = new Set<string>()
  // Ate 3 amostras por chat - ver diagnosticarMensagemIlegivel.
  private amostrasIlegiveis = new Map<string, number>()
  // Teto de pedidos de reenvio por janela de relatorio - ver pedirReenvio.
  private readonly MAX_REENVIOS_POR_JANELA = 15
  // Canais cujo conteudo precisa ser BUSCADO - ver buscarConteudoDeCanais.
  private canaisParaBuscar = new Set<string>()
  private buscaCanalTimer: NodeJS.Timeout | null = null
  private jaLogueiFormatoDoCanal = false
  private readonly BUSCA_CANAL_DEBOUNCE_MS = 5000
  private readonly BUSCA_CANAL_QUANTIDADE = 20
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

  /**
   * Contadores da janela atual, sem esperar o relatório de 30 minutos. Numa
   * sessão de teste ao vivo, esperar meia hora para saber se a mensagem chegou
   * é a diferença entre ver e adivinhar.
   */
  recepcaoAgora(): {
    mensagens: number; deGrupoMonitorado: number; proprias: number; jaVistas: number
    naoDecifradas: number; comTexto: number; comLink: number; flushesForcados: number
    monitorados: number; porChat: { jid: string; n: number }[]
  } {
    const r = this.recepcao
    return {
      mensagens: r.mensagens,
      deGrupoMonitorado: r.deGrupoMonitorado,
      proprias: r.proprias,
      jaVistas: r.jaVistas,
      naoDecifradas: r.semConteudo,
      comTexto: r.comTexto,
      comLink: r.comLink,
      flushesForcados: r.flushesForcados,
      monitorados: this.dbManager.getMonitoredGroups('whatsapp').length,
      porChat: Object.entries(r.porChat).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([jid, n]) => ({ jid, n })),
    }
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
      details: `lotes=${r.lotes}, mensagens=${r.mensagens}, tipos=[${tipos}], apos_filtro_de_tipo=${r.aposFiltroDeTipo}, flushes_forcados=${r.flushesForcados}, minhas_proprias=${r.proprias}, ja_vistas=${r.jaVistas}, reenvios_pedidos=${r.reenviosPedidos}, nao_decifradas=${r.semConteudo}, stubs=[${Object.entries(r.stubs).map(([t, n]) => `${t}=${n}`).join(', ') || 'nenhum'}], com_texto=${r.comTexto}, sem_texto=${r.semTexto}, com_link=${r.comLink}, de_grupo_monitorado=${r.deGrupoMonitorado}, monitorados=${monitorados.length}
chats_que_mandaram=[${chats}]
monitorados_salvos=[${salvos}]`,
    })

    this.recepcao = { lotes: 0, mensagens: 0, porTipo: {}, porChat: {}, flushesForcados: 0, proprias: 0, jaVistas: 0, reenviosPedidos: 0, aposFiltroDeTipo: 0, semConteudo: 0, stubs: {}, semTexto: 0, comTexto: 0, deGrupoMonitorado: 0, comLink: 0 }
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
        // Quando o Baileys não consegue decifrar, ele pede reenvio ao
        // remetente. O padrão é 250 ms, e no log de um testador 25 de 29
        // mensagens chegaram como CIPHERTEXT (não decifradas) mesmo com as 5
        // tentativas padrão — 250 ms pode ser cedo demais para o outro lado
        // responder. Vale medir: o campo `nao_decifradas` do relatório de
        // recepção diz se ajudou.
        retryRequestDelayMs: 3000,
        maxMsgRetryCount: 8,
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
          // 440 = connectionReplaced: outra sessão assumiu a conexão. Reconectar
          // aqui é o pior movimento possível — a nossa reconexão derruba a outra,
          // a outra reconecta e derruba a nossa, e vira um pingue-pongue de 5 em
          // 5 segundos. No log do testador foram ~35 ciclos em 4 minutos, e o
          // WhatsApp terminou INVALIDANDO a sessão (401), ou seja, o loop custou
          // o pareamento dele. Melhor ficar desconectado e avisar.
          const isReplaced = statusCode === DisconnectReason.connectionReplaced
          const shouldReconnect = !isLoggedOut && !isReplaced
          log.info('Conexão WhatsApp fechada. Reconectar:', shouldReconnect)

          // Sem isso não tinha nenhum rastro de quando/por que o WhatsApp caiu —
          // só descobria pela reclamação do usuário, sem saber se foi sessão
          // realmente invalidada (precisa QR de novo) ou queda passageira que
          // reconecta sozinha.
          this.dbManager.addLog({
            type: isLoggedOut || isReplaced ? 'error' : 'warning',
            platform: 'whatsapp',
            message: isLoggedOut
              ? 'WhatsApp desconectado — sessão invalidada, será necessário escanear o QR Code novamente'
              : isReplaced
                ? 'WhatsApp desconectado — outro aparelho ou aba assumiu esta conexão'
                : 'WhatsApp desconectado — tentando reconectar automaticamente',
            details: isReplaced
              ? 'Feche o WhatsApp Web em outras abas e qualquer outra cópia do Afiliado Pro, depois reconecte em Conexões. O app NÃO vai reconectar sozinho de propósito: as duas conexões ficariam se derrubando e o WhatsApp acaba invalidando a sessão.'
              : `statusCode=${statusCode ?? 'desconhecido'}, tentativas seguidas=${this.reconnectAttempts}`,
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
          // O contador NÃO zera aqui. Zerar no 'open' fazia a espera progressiva
          // nunca sair dos 5 segundos numa conexão instável: abre, cai em 1
          // segundo, tenta de novo em 5, abre, cai... foi assim que o log do
          // testador acumulou ~35 ciclos em 4 minutos, sempre com
          // "tentativas seguidas=0". Só zera se a conexão se sustentar.
          if (this.estabilidadeTimer) clearTimeout(this.estabilidadeTimer)
          this.estabilidadeTimer = setTimeout(() => {
            if (this.status === 'connected') this.reconnectAttempts = 0
          }, this.CONEXAO_ESTAVEL_MS)
          if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
          sendToRenderer('whatsapp:status', 'connected')
          log.info('WhatsApp conectado')
          this.startMonitoring()
          this.iniciarRelatorioDeRecepcao()
          void this.assinarCanaisMonitorados()
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
          // Guarda a mais ANTIGA vista nesta sessão: é dela que se pede o que
          // veio antes. Guardar a mais recente pediria histórico de um ponto
          // que já processamos.
          if (msg.key.id && jid !== 'sem-jid') {
            const atual = this.ultimaMensagemPorGrupo.get(jid)
            if (!atual || messageTimestampMs(msg) < messageTimestampMs(atual)) {
              this.ultimaMensagemPorGrupo.set(jid, msg)
              // Também no banco: a versão em memória zera a cada reinício, e é
              // logo depois de uma atualização que a varredura mais importa.
              try {
                this.dbManager.salvarAncoraDeHistorico('whatsapp', jid, msg.key, messageTimestampMs(msg))
              } catch (err) {
                log.warn('Não consegui salvar a âncora de histórico:', (err as Error).message)
              }
            }
          }
        }

        // Antes, num lote que não fosse 'notify', só mensagem de canal passava —
        // e mensagem de grupo era descartada. Isso ficou destrutivo depois do
        // watchdog de buffer: TODO lote liberado por ele chega como 'append', e
        // o watchdog dispara em toda conexão. No log do testador, 4 mensagens de
        // um grupo monitorado sumiram exatamente assim (33 recebidas, 29 depois
        // do filtro), e isso acontecia o tempo todo.
        //
        // O filtro existia para não reprocessar histórico antigo. Hoje existem
        // duas camadas de deduplicação que não existiam quando ele foi escrito
        // — a URL normalizada e o `send_history` — então ele deixou de proteger
        // e passou só a causar perda. Agora passa tudo que for de chat
        // monitorado, seja grupo ou canal, em qualquer tipo de lote.
        const monitoradosAgora = new Set(
          this.dbManager.getMonitoredGroups('whatsapp').map((g) => g.group_id)
        )
        const messages = m.type === 'notify'
          ? m.messages
          : m.messages.filter((msg) => {
              const jid = msg.key.remoteJid
              return !!jid && (jid.endsWith('@newsletter') || monitoradosAgora.has(jid))
            })
        this.recepcao.aposFiltroDeTipo += messages.length
        if (messages.length === 0) return
        // Em paralelo: um burst de várias mensagens não deve esperar a
        // raspagem+repost completo de uma pra só então começar a próxima.
        await Promise.all(messages.map((msg) => this.handleIncomingMessage(msg)))
      })

      // Sincronização de histórico: é por aqui que chega o que passou nos
      // grupos enquanto o app estava fora do ar. Guarda tudo no buffer (pra
      // quem for monitorado depois) e já processa o que é de grupo monitorado.
      // Este listener e a UNICA porta por onde a resposta da varredura entra:
      // `fetchMessageHistory` so pede, quem entrega e este evento. Ele nao
      // logava nada, e por isso "a varredura nao pegou nada" era ambiguo entre
      // dois casos opostos - o WhatsApp nunca respondeu, ou respondeu e o que
      // veio nao servia. Sem separar os dois, a proxima tentativa seria chute.
      this.sock.ev.on('messaging-history.set', async ({ messages }) => {
        const porChat: Record<string, number> = {}
        for (const msg of messages) {
          const jid = msg.key?.remoteJid || 'sem-jid'
          porChat[jid] = (porChat[jid] ?? 0) + 1
        }
        const semCorpo = messages.filter((msg) => !msg.message).length
        this.dbManager.addLog({
          type: 'info',
          platform: 'whatsapp',
          message: `WhatsApp respondeu com histórico: ${messages.length} mensagem(ns)`,
          details: [
            'mensagens=' + String(messages.length),
            'sem_corpo=' + String(semCorpo),
            'de=[' + Object.entries(porChat).map(([j, n]) => j + '=' + String(n)).join(', ') + ']',
          ].join(' | ').substring(0, 900),
        })
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
  /**
   * Inscreve o app nas atualizações dos canais monitorados.
   *
   * Motivo: no log de um testador, UM canal específico entregou 26 de 26
   * mensagens como CIPHERTEXT (não decifradas) em toda janela medida, enquanto
   * os outros dois canais decifravam normalmente. A contagem batia exata com o
   * total daquele canal nas quatro medições. Não é sessão corrompida nem
   * limitação de canal em geral — é aquele canal.
   *
   * `subscribeNewsletterUpdates` nunca era chamado. É uma hipótese, não um
   * conserto confirmado: os outros canais funcionam sem isso. O campo
   * `nao_decifradas` do relatório de recepção vai dizer se resolveu.
   */
  private async assinarCanaisMonitorados(): Promise<void> {
    // Fixa o socket: o laço abaixo tem `await` a cada canal, e uma queda no meio
    // (acontece a cada 30-90 min nos logs reais) trocaria `this.sock` por null
    // ou por um socket novo — chamando o método de um socket com o `this` de
    // outro.
    const sock = this.sock
    const inscrever = (sock as unknown as {
      subscribeNewsletterUpdates?: (jid: string) => Promise<unknown>
    })?.subscribeNewsletterUpdates
    if (!sock || typeof inscrever !== 'function') return

    const canais = this.dbManager
      .getMonitoredGroups('whatsapp')
      .filter((g) => g.group_id.endsWith('@newsletter'))
    if (canais.length === 0) return

    let ok = 0
    const falhas: string[] = []
    for (const canal of canais) {
      // Conexão trocou no meio: o resto do laço seria feito no socket errado.
      if (this.sock !== sock) break
      try {
        await inscrever.call(sock, canal.group_id)
        ok++
      } catch (err) {
        // Falhar aqui não pode derrubar a conexão: o canal continua sendo lido
        // pelo caminho normal, só sem a inscrição.
        falhas.push(`${canal.group_name || canal.group_id}: ${(err as Error).message}`)
      }
    }
    log.info(`Inscrição em canais: ${ok} de ${canais.length}`)
    if (falhas.length > 0) {
      this.dbManager.addLog({
        type: 'warning',
        platform: 'whatsapp',
        message: `Não consegui me inscrever em ${falhas.length} de ${canais.length} canal(is) monitorado(s)`,
        details: falhas.join(' | ').substring(0, 400),
      })
    }
  }

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
    if (this.estabilidadeTimer) { clearTimeout(this.estabilidadeTimer); this.estabilidadeTimer = null }
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
    if (this.estabilidadeTimer) { clearTimeout(this.estabilidadeTimer); this.estabilidadeTimer = null }
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
      throw new ErroDeConexao('WhatsApp não está conectado')
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
      throw new ErroDeConexao('WhatsApp não está conectado')
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
      throw new ErroDeConexao('WhatsApp nao esta conectado')
    }
    try {
      if (imagePath) {
        await this.sock.sendMessage(groupId, {
          image: { url: imagePath },
          caption: message,
        })
      } else {
        await this.sock.sendMessage(groupId, { text: message })
      }
    } catch (err) {
      // O Baileys devolve um "forbidden" seco quando o servidor recusa o envio
      // com 403, e isso ia pro log do usuário exatamente assim — uma palavra,
      // sem dizer nem em qual grupo nem o que fazer. Aconteceu de verdade: um
      // testador reparou o WhatsApp com OUTRA conta depois de perder a sessão,
      // e o grupo de destino salvo continuou sendo o da conta antiga, onde a
      // nova não está. Quatro ofertas morreram com "forbidden" e nenhuma pista.
      const bruto = (err as Error)?.message || ''
      const status = (err as { output?: { statusCode?: number } })?.output?.statusCode
      if (/forbidden/i.test(bruto) || status === 403) {
        throw new Error(
          `O WhatsApp recusou o envio para ${groupId}. Normalmente é um destes: a conta conectada não é mais membro desse grupo ` +
          '(acontece depois de parear o WhatsApp com outro número — o grupo salvo continua sendo o de antes), ' +
          'o grupo está configurado para só administradores enviarem, ou o destino é um canal que não é seu. ' +
          'Confira os grupos de destino em Configurações e selecione de novo.'
        )
      }
      throw err
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
    reason: string,
    janelaMs?: number
  ): Promise<number> {
    const monitoredIds = new Set(
      this.dbManager.getMonitoredGroups('whatsapp').map((g) => g.group_id)
    )

    const toProcess = selectRecoverableMessages(messages, {
      monitoredIds,
      alreadyProcessedIds: this.processedHistoryIds,
      maxAgeMs: janelaMs ?? this.janelaAtiva(),
      maxPerGroup: this.HISTORY_MAX_PER_GROUP,
    })

    // NÃO marcar os ids como processados aqui. `handleIncomingMessage` passou a
    // descartar mensagem já vista, então pré-marcar fazia a recuperação inteira
    // virar no-op: as mensagens eram selecionadas, marcadas, e todas descartadas
    // na entrada — enquanto a função ainda devolvia `toProcess.length` e o log
    // dizia "N mensagens reprocessadas". Quem marca agora é só o handler, uma
    // vez, no ponto em que a mensagem de fato passa.
    if (toProcess.length === 0) return 0

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
    return toProcess.length
  }

  // Enquanto uma varredura manual está correndo, o histórico que o WhatsApp
  // entregar em resposta ao nosso pedido precisa usar a janela que o usuário
  // escolheu — senão o pedido traz 8 horas e o processamento descarta tudo que
  // for mais velho que as 12h padrão... ou, pior, no sentido contrário: o
  // usuário pede 2 horas e recebe 12.
  private janelaAtiva(): number {
    if (this.varreduraJanelaMs && Date.now() < this.varreduraValidaAte) {
      return this.varreduraJanelaMs
    }
    return this.HISTORY_MAX_AGE_MS
  }

  /**
   * Varredura manual: reprocessa o que passou nos grupos monitorados nas
   * últimas N horas. Faz duas coisas, porque nenhuma sozinha é confiável —
   * o buffer só tem o que o WhatsApp mandou espontaneamente, e o pedido
   * explícito depende de o servidor responder (e a resposta chega depois,
   * pelo mesmo `messaging-history.set` de sempre).
   */
  async varrerHistorico(horas: number): Promise<{ ok: boolean; erro?: string; processadas: number; pedidos: number; grupos: number; semAncora?: boolean }> {
    if (this.status !== 'connected' || !this.sock) {
      return { ok: false, erro: 'O WhatsApp não está conectado.', processadas: 0, pedidos: 0, grupos: 0 }
    }
    const monitorados = this.dbManager.getMonitoredGroups('whatsapp')
    if (monitorados.length === 0) {
      return { ok: false, erro: 'Nenhum grupo ou canal está marcado como monitorado.', processadas: 0, pedidos: 0, grupos: 0 }
    }

    const janelaMs = Math.max(1, Math.min(10, Math.round(horas))) * 60 * 60 * 1000
    this.varreduraJanelaMs = janelaMs
    this.varreduraValidaAte = Date.now() + this.VARREDURA_VALIDADE_MS

    this.dbManager.addLog({
      type: 'info',
      platform: 'whatsapp',
      message: `Varredura manual iniciada — procurando anúncios das últimas ${Math.round(janelaMs / 3600000)}h`,
      details: `${monitorados.length} grupo(s)/canal(is) monitorado(s). Ofertas já capturadas são ignoradas.`,
    })

    // 1) O que já está no buffer, agora com a janela escolhida.
    const doBuffer = [...this.historyBuffer.values()].flat()
    const processadas = await this.recoverMonitoredFromHistory(doBuffer, `varredura manual de ${Math.round(janelaMs / 3600000)}h`, janelaMs)

    // 2) Pede ao WhatsApp o que veio antes da mensagem mais antiga que temos de
    //    cada grupo. A resposta não é imediata: chega depois pelo listener.
    let pedidos = 0
    const buscar = (this.sock as unknown as {
      fetchMessageHistory?: (count: number, key: proto.IMessageKey, ts: number) => Promise<string>
    }).fetchMessageHistory
    if (typeof buscar === 'function') {
      for (const grupo of monitorados) {
        // Âncora: a mais antiga do buffer, se houver, senão a mais antiga vista
        // em tempo real. A segunda é o caminho que funciona na prática.
        const doBufferDoGrupo = this.historyBuffer.get(grupo.group_id) ?? []
        const candidatas = [...doBufferDoGrupo, this.ultimaMensagemPorGrupo.get(grupo.group_id)]
          .filter((m): m is proto.IWebMessageInfo => !!m && !!m.key && messageTimestampMs(m) > 0)

        let chave: proto.IMessageKey | undefined
        let ts = 0
        if (candidatas.length > 0) {
          const maisAntiga = candidatas.reduce((a, b) => (messageTimestampMs(a) <= messageTimestampMs(b) ? a : b))
          chave = maisAntiga.key ?? undefined
          ts = messageTimestampMs(maisAntiga)
        } else {
          // Nada em memória — é o caso de logo depois de um reinício. A âncora
          // salva no banco cobre exatamente esse buraco.
          const salva = this.dbManager.getAncoraDeHistorico('whatsapp', grupo.group_id)
          if (salva) {
            chave = { remoteJid: grupo.group_id, id: salva.id, fromMe: salva.fromMe, participant: salva.participant }
            ts = salva.ts
          }
        }
        if (!chave || !ts) continue
        const maisAntiga = { key: chave } as proto.IWebMessageInfo
        try {
          await buscar.call(this.sock, this.HISTORY_MAX_PER_GROUP, maisAntiga.key, Math.floor(ts / 1000))
          pedidos++
        } catch (err) {
          log.warn(`Não consegui pedir histórico de ${grupo.group_id}:`, (err as Error).message)
        }
      }
    }

    // Sem âncora nenhuma não dá pra pedir histórico ao WhatsApp — e dizer só
    // "0 mensagens" faria parecer que nada tinha se perdido.
    const semAncora = pedidos === 0 && processadas === 0
    this.dbManager.addLog({
      type: semAncora ? 'warning' : 'info',
      platform: 'whatsapp',
      message: semAncora
        ? 'Varredura sem resultado — o app ainda não viu nenhuma mensagem destes grupos'
        : `Varredura concluída — ${processadas} mensagem(ns) reprocessada(s), ${pedidos} pedido(s) de histórico enviado(s)`,
      details: semAncora
        ? 'A varredura precisa de ao menos uma mensagem já recebida de cada grupo para saber de onde pedir o histórico. Deixe o app conectado alguns minutos e tente de novo.'
        : 'O histórico pedido chega em segundo plano e é capturado como mensagem normal. Ofertas já capturadas são ignoradas.',
    })

    return { ok: true, processadas, pedidos, grupos: monitorados.length, semAncora }
  }

  // Mensagem própria some em silêncio, e isso é correto: sem esse filtro o app
  // capturaria os próprios anúncios que posta no grupo de destino e entraria em
  // laço. Mas quando o usuário está TESTANDO — manda o link no grupo monitorado
  // do próprio número e não acontece nada — o silêncio parece bug. Aconteceu de
  // verdade e custou meia hora de investigação. Avisa uma vez por grupo por
  // sessão, e só quando havia mesmo um link de loja: nada de encher o log com
  // conversa normal.
  private avisarMensagemPropriaIgnorada(msg: proto.IWebMessageInfo): void {
    const jid = msg.key.remoteJid
    if (!jid || this.avisouMensagemPropria.has(jid)) return
    if (!this.dbManager.getMonitoredGroups('whatsapp').some((g) => g.group_id === jid)) return

    const content = this.unwrapMessage(msg.message)
    const texto = content?.conversation || content?.extendedTextMessage?.text ||
                  content?.imageMessage?.caption || content?.videoMessage?.caption ||
                  content?.documentMessage?.caption || ''
    const urls = texto.match(/(https?:\/\/[^\s]+)/g)
    if (!urls?.some((u) => this.scraperManager.affiliateManager?.detectStore(u))) return

    this.avisouMensagemPropria.add(jid)
    this.dbManager.addLog({
      type: 'warning',
      platform: 'whatsapp',
      message: 'Mensagem sua ignorada — o app não captura o que você mesmo posta',
      details: 'Você mandou um link de loja num grupo monitorado usando o próprio número conectado ao app. ' +
        'Isso é ignorado de propósito: sem esse filtro o app capturaria os anúncios que ele mesmo publica e entraria em laço. ' +
        'Para testar, peça a outra pessoa para mandar o link, ou use outro número.',
    })
  }

  private unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | null | undefined {
    const inner = message?.ephemeralMessage?.message ||
                  message?.viewOnceMessage?.message ||
                  message?.viewOnceMessageV2?.message ||
                  message?.documentWithCaptionMessage?.message
    return inner ? this.unwrapMessage(inner) : message
  }

  /**
   * Pede ao WhatsApp que reenvie uma mensagem que chegou ilegivel.
   *
   * ATENCAO ao mexer aqui: o Baileys JA chama `requestPlaceholderResend`
   * sozinho em dois caminhos - dentro de `sendRetryRequest` quando e a primeira
   * retentativa, e quando o no chega marcado como `unavailable` sem bloco de
   * criptografia. Ele ainda dedupa por id num `placeholderResendCache` interno,
   * entao nos casos que ele cobre esta chamada retorna de imediato sem fazer
   * nada. Ou seja: isto e RESERVA, nao o conserto principal.
   *
   * Existe porque nao esta claro se mensagem de canal (@newsletter) passa por
   * algum desses dois caminhos - a documentacao do Baileys nao cobre canais, e
   * o caso do testador e justamente um canal que entrega 100% das mensagens
   * sem decifrar. Se passar, esta chamada e inofensiva; se nao passar, e a
   * unica que pede o reenvio.
   *
   * Nao e garantia de nada: o pedido vai para o aparelho principal e a propria
   * implementacao registra "Phone possibly offline" quando nao ha resposta em
   * 15 segundos. O contador `reenvios_pedidos` do relatorio mede se adiantou.
   *
   * Com teto por janela: um canal que entrega 26 mensagens ilegiveis a cada 30
   * minutos viraria 26 pedidos, e martelar o servidor e o tipo de coisa que
   * derruba sessao.
   */
  private async pedirReenvio(msg: proto.IWebMessageInfo): Promise<void> {
    const jid = msg.key.remoteJid
    if (!jid || !msg.key.id) return
    if (this.recepcao.reenviosPedidos >= this.MAX_REENVIOS_POR_JANELA) return
    if (!this.dbManager.getMonitoredGroups('whatsapp').some((g) => g.group_id === jid)) return

    const pedir = (this.sock as unknown as {
      requestPlaceholderResend?: (key: proto.IMessageKey) => Promise<string | undefined>
    })?.requestPlaceholderResend
    if (typeof pedir !== 'function') return

    this.recepcao.reenviosPedidos++
    try {
      await pedir.call(this.sock, msg.key)
    } catch (err) {
      log.warn('Falha ao pedir reenvio de mensagem ilegivel:', (err as Error).message)
    }
  }

  /**
   * Busca o conteudo das mensagens de um canal cujo corpo nao veio.
   *
   * ESTE E o conserto do canal do testador, e nao adivinhacao: o log da 1.8.4
   * fechou a questao. Toda mensagem daquele canal chega com
   * `motivo=["Message absent from node"]` e um `server_id` - ou seja, o
   * `<message>` vem SEM bloco `enc` e SEM bloco `plaintext`. Nao ha falha de
   * criptografia nenhuma; conteudo de canal nem viaja cifrado, viaja em
   * `plaintext`. O que chega e so o aviso de que existe mensagem nova, com o
   * numero dela. O corpo tem que ser pedido.
   *
   * Por isso pedir redecifrar (`requestPlaceholderResend`) nunca ia resolver:
   * responde a pergunta errada.
   *
   * Junta os canais numa janela curta antes de pedir, porque um canal entrega
   * dezenas de avisos em rajada e cada aviso viraria um pedido.
   */
  private agendarBuscaDeCanal(jid: string): void {
    if (!jid.endsWith('@newsletter')) return
    if (!this.dbManager.getMonitoredGroups('whatsapp').some((g) => g.group_id === jid)) return
    this.canaisParaBuscar.add(jid)
    if (this.buscaCanalTimer) return
    this.buscaCanalTimer = setTimeout(() => {
      this.buscaCanalTimer = null
      void this.buscarConteudoDeCanais()
    }, this.BUSCA_CANAL_DEBOUNCE_MS)
  }

  private async buscarConteudoDeCanais(): Promise<void> {
    const canais = [...this.canaisParaBuscar]
    this.canaisParaBuscar.clear()
    const sock = this.sock
    const buscar = (sock as unknown as {
      newsletterFetchMessages?: (jid: string, count: number, since?: number, after?: number) => Promise<unknown>
    })?.newsletterFetchMessages
    if (!sock || typeof buscar !== 'function' || canais.length === 0) return

    for (const jid of canais) {
      // Conexao trocou no meio: o resto seria pedido no socket errado.
      if (this.sock !== sock) return
      try {
        const resposta = await buscar.call(sock, jid, this.BUSCA_CANAL_QUANTIDADE)
        const mensagens = this.extrairMensagensDeCanal(jid, resposta)

        // Se nao veio nada, o formato da resposta e diferente do que este
        // parser espera - e sem registrar a forma dela a proxima tentativa
        // seria chute de novo, que e exatamente o que custou caro neste caso.
        if (mensagens.length === 0 && !this.jaLogueiFormatoDoCanal) {
          this.jaLogueiFormatoDoCanal = true
          this.dbManager.addLog({
            type: 'warning',
            platform: 'whatsapp',
            message: 'Busquei o conteudo do canal mas nao reconheci a resposta',
            details: ('canal=' + jid + ' | forma=' + this.descreverNo(resposta)).substring(0, 900),
          })
          continue
        }

        let aproveitadas = 0
        for (const msg of mensagens) {
          const id = msg.key?.id
          if (id && this.processedHistoryIds.has(id)) continue
          aproveitadas++
          await this.handleIncomingMessage(msg)
        }
        if (aproveitadas > 0) {
          this.dbManager.addLog({
            type: 'info',
            platform: 'whatsapp',
            message: `Conteúdo buscado do canal: ${aproveitadas} mensagem(ns) recuperada(s)`,
            details: 'canal=' + jid + ' | encontradas=' + String(mensagens.length),
          })
        }
      } catch (err) {
        this.dbManager.addLog({
          type: 'warning',
          platform: 'whatsapp',
          message: 'Não consegui buscar o conteúdo de um canal monitorado',
          details: ('canal=' + jid + ' | erro=' + (err as Error).message).substring(0, 400),
        })
      }
    }
  }

  /**
   * Monta mensagens a partir da resposta crua do `newsletterFetchMessages`.
   *
   * A resposta e um no binario e o Baileys nao a interpreta. A forma exata nao
   * esta documentada, entao em vez de assumir um caminho fixo o parser desce a
   * arvore inteira e aceita qualquer no que carregue um filho `plaintext` -
   * conteudo de canal e plaintext, entao esse e o sinal confiavel, venha ele
   * dentro de `message_updates`, de `messages` ou de outro invólucro.
   */
  private extrairMensagensDeCanal(jid: string, node: unknown): proto.IWebMessageInfo[] {
    const encontradas: proto.IWebMessageInfo[] = []

    const desce = (atual: unknown, paiAttrs: Record<string, string>): void => {
      if (!atual || typeof atual !== 'object') return
      const no = atual as { tag?: string; attrs?: Record<string, string>; content?: unknown }
      const attrs = { ...paiAttrs, ...(no.attrs ?? {}) }

      if (no.tag === 'plaintext' && no.content instanceof Uint8Array) {
        try {
          const corpo = proto.Message.decode(no.content)
          const serverId = attrs.server_id ?? attrs.id
          encontradas.push({
            key: {
              remoteJid: jid,
              fromMe: false,
              id: attrs.id ?? ('SRV' + String(serverId)),
              ...(serverId ? { server_id: serverId } : {}),
            },
            messageTimestamp: Number(attrs.t) || Math.floor(Date.now() / 1000),
            message: corpo,
            broadcast: true,
          } as proto.IWebMessageInfo)
        } catch (err) {
          log.warn('Conteúdo de canal não decodificou:', (err as Error).message)
        }
        return
      }

      for (const filho of getAllBinaryNodeChildren(no as never)) desce(filho, attrs)
    }

    desce(node, {})
    return encontradas
  }

  /** Resumo da forma de um no binario, para quando o parser nao reconhece. */
  private descreverNo(node: unknown, profundidade = 0): string {
    if (!node || typeof node !== 'object' || profundidade > 3) return '?'
    const no = node as { tag?: string; attrs?: Record<string, string>; content?: unknown }
    const filhos = getAllBinaryNodeChildren(no as never)
    const dentro = filhos.length > 0
      ? '(' + filhos.slice(0, 6).map((f) => this.descreverNo(f, profundidade + 1)).join(',') + ')'
      : no.content instanceof Uint8Array ? '<bytes>' : ''
    return String(no.tag ?? '?') + dentro
  }

  /**
   * Registra a forma crua de uma mensagem que chegou ilegivel, para descobrir
   * o que ela realmente e.
   *
   * Um canal de um testador entrega 100% das mensagens assim - 9/9, 16/16,
   * 22/22, 26/26, 30/30 em todas as janelas medidas - enquanto os outros canais
   * dele decifram normalmente, e no mesmo relatorio status e grupos comuns
   * chegam inteiros. Nao e sessao corrompida: e aquele canal.
   *
   * O campo que decide esta em `messageStubParameters`. A fonte do Baileys
   * 6.7.24 (Utils/decode-wa-message.js) marca CIPHERTEXT por DOIS caminhos
   * diferentes, e o parametro diz qual foi:
   *
   *   - a mensagem do erro real, quando decifrar falhou de verdade;
   *   - "Message absent from node", quando o `<message>` chegou SEM nenhum
   *     bloco `enc` nem `plaintext` - ou seja, nao houve o que decifrar.
   *
   * Vale lembrar que conteudo de canal viaja em `plaintext`, nao cifrado. Entao
   * o segundo caso e o esperado aqui, e ele nao e problema de criptografia: e
   * mensagem chegando sem corpo, que se resolve BUSCANDO o conteudo
   * (`newsletterFetchMessages`), nao pedindo redecifrar. Sao consertos opostos,
   * e por isso este log grava o parametro em vez de so contar quantos sao.
   *
   * Tres amostras por chat por sessao: o suficiente para ver o padrao, sem
   * transformar o log em despejo.
   */
  private diagnosticarMensagemIlegivel(msg: proto.IWebMessageInfo): void {
    const jid = msg.key.remoteJid
    if (!jid) return
    if (!this.dbManager.getMonitoredGroups('whatsapp').some((g) => g.group_id === jid)) return

    const vistas = this.amostrasIlegiveis.get(jid) ?? 0
    if (vistas >= 3) return
    this.amostrasIlegiveis.set(jid, vistas + 1)

    const semValorNulo = (o: unknown): string[] =>
      o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).filter(([, v]) => v != null).map(([k]) => k) : []

    this.dbManager.addLog({
      type: 'info',
      platform: 'whatsapp',
      message: 'Diagnostico: mensagem ilegivel de canal monitorado',
      details: [
        'chat=' + jid,
        'stubType=' + String(msg.messageStubType ?? '-'),
        // Este campo e o que separa os dois casos do Baileys - ver o comentario do metodo.
        'motivo=' + JSON.stringify(msg.messageStubParameters ?? []).substring(0, 200),
        'server_id=' + String((msg.key as { server_id?: unknown }).server_id ?? '-'),
        'campos_da_mensagem=[' + semValorNulo(msg).join(',') + ']',
        'campos_da_chave=[' + semValorNulo(msg.key).join(',') + ']',
        'status=' + String(msg.status ?? '-'),
        'temParticipant=' + String(!!msg.key.participant),
        'amostra=' + String(vistas + 1) + '/3',
      ].join(' | '),
    })
  }

  private async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    // Mensagem própria saía por um return mudo e ficava indistinguível de
    // "chegou e o texto estava vazio" no relatório — foi o que aconteceu no log
    // do testador: 8 mensagens passando o filtro e com_texto=0 E sem_texto=0
    // ao mesmo tempo, que só é possível se todas saíram aqui.
    if (msg.key.fromMe) {
      this.recepcao.proprias++
      this.avisarMensagemPropriaIgnorada(msg)
      return
    }

    // A cada reconexão o WhatsApp reentrega o acumulado, e o buffer liberado
    // pelo watchdog traz o MESMO lote de novo. No log do testador, os mesmos
    // três links reapareceram em seis reconexões seguidas (07:38, 08:28, 09:18,
    // 09:46, 10:37, 11:27) — cada uma disparando raspagem e geração de link
    // outra vez. A deduplicação por URL impedia produto repetido, mas só DEPOIS
    // de todo o trabalho: dezenas de chamadas de rede desperdiçadas e um log
    // ilegível. Aqui a mensagem já vista é descartada logo na entrada.
    const idDaMensagem = msg.key.id
    if (idDaMensagem && this.processedHistoryIds.has(idDaMensagem)) {
      this.recepcao.jaVistas++
      return
    }
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
      this.diagnosticarMensagemIlegivel(msg)
      // Canal: o corpo nao veio e precisa ser buscado (o caminho que resolve).
      // Grupo comum: ai sim e decifração, e o reenvio e o que cabe.
      if (msg.key.remoteJid?.endsWith('@newsletter')) {
        this.agendarBuscaDeCanal(msg.key.remoteJid)
      } else {
        void this.pedirReenvio(msg)
      }
      return
    }
    // Grupo grande de ofertas costuma ter mensagens temporárias ativadas —
    // nesse caso o Baileys embrulha a mensagem de verdade um nível mais
    // fundo (ephemeralMessage.message), e o mesmo vale pra "ver uma vez"
    // (viewOnceMessage/V2) e documento-com-legenda. Sem desembrulhar, os 3
    // campos abaixo ficam todos undefined e a mensagem passa batida com
    // texto vazio — sem log nenhum, porque essa função retorna cedo demais.
    // Só agora o id entra no set. Marcá-lo antes do teste acima faria a
    // mensagem que chegou como CIPHERTEXT queimar o id — e o Baileys, ao pedir
    // reenvio ao remetente, reemite a MESMA mensagem já decifrada com o mesmo
    // `key.id`. Ela seria descartada aqui, anulando justamente o mecanismo que
    // a 1.8.0 ajustou (retryRequestDelayMs de 3s, 8 tentativas).
    if (idDaMensagem) {
      this.processedHistoryIds.add(idDaMensagem)
      trimProcessedIds(this.processedHistoryIds, this.PROCESSED_IDS_CAP)
    }

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

  private async processDetectedUrl(url: string, viaAgregador = false): Promise<void> {
    const store = this.scraperManager.affiliateManager?.detectStore(url)
    if (!store) {
      // Antes o link morria aqui. Só que grupo agregador manda o encurtador
      // DELE, não o link da loja: medido num caso real, 38 links numa única
      // janela, todos descartados. A página do agregador tem um botão que
      // aponta para a loja (no caso, o `meli.la` de afiliado deles), e daí o
      // resolvedor que já existe chega ao produto canônico — de onde o app
      // gera o link de afiliado DO USUÁRIO. O produto é o mesmo; a comissão
      // passa a ser dele.
      //
      // `viaAgregador` corta a recursão: a página resolvida é seguida uma vez
      // só, senão um agregador que aponta para outro entraria em laço.
      if (!viaAgregador) {
        const daLoja = await this.scraperManager.resolverLinkDeAgregador(url)
        if (daLoja) {
          this.dbManager.addLog({
            type: 'info',
            platform: 'whatsapp',
            message: 'Link de agregador resolvido para a loja',
            details: `${url.substring(0, 70)} -> ${daLoja.substring(0, 90)}`,
          })
          await this.processDetectedUrl(daLoja, true)
          return
        }
      }
      log.warn(`Link de grupo monitorado ignorado - loja nao reconhecida: ${url}`)
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

      // Produto já conhecido. Isso NÃO significa que ele já foi anunciado:
      // relato real do testador — o app passou a tarde capturando sem
      // conseguir enviar (envios falhando), e quando o link voltou a aparecer
      // no grupo ele foi descartado como "duplicado", mesmo nunca tendo saído.
      // O produto ficava preso: existe no banco, então toda recaptura pula, e
      // nada o reenfileirava.
      //
      // Agora a pergunta certa é "já foi ENVIADO?", não "já é conhecido?". Se
      // ainda não saiu para algum grupo de destino, entra na fila. A barreira
      // do `send_history` dentro do auto-repost continua impedindo repetição de
      // verdade, então isso não reabre a porta para anúncio repetido.
      if (this.dbManager.productExistsByUrl(url)) {
        const existente = this.dbManager.getProductByUrl(url)
        if (existente?.id) {
          await autoRepostProduct(existente, 'whatsapp', this.dbManager, this.queueManager)
          return
        }
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
