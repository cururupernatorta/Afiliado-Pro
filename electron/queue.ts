import { Queue, Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import log from 'electron-log'
import { sendToRenderer, ErroDeConexao } from './utils'
import { DatabaseManager } from './database'

export interface SendProductsExtra {
  description?: string
  coupon?: string
  imageUrl?: string
  templateText?: string
}

interface SendJob {
  platform: 'whatsapp' | 'telegram'
  groupId: string
  productId: number
  productTitle: string
  productPrice: number
  productImagePath?: string
  affiliateUrl: string
  overrideDescription?: string
  overrideCoupon?: string
  overrideImagePath?: string
  overrideTemplateText?: string
}

interface InMemoryJob {
  id: string
  data: SendJob
  // 'rescheduled': o job original de um adiamento do modo stealth (fora do
  // horário, limite por hora, cooldown) — não foi enviado nem falhou, só virou
  // um job novo com delay maior. Sem esse status separado, ele acabava marcado
  // 'completed' e aparecia como "Enviado" na Fila mesmo sem ter saído.
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'rescheduled'
  createdAt: Date
  delayMs: number
  // Quantas vezes esse envio já esbarrou em conexão fora do ar.
  tentativasDeConexao?: number
  // Momento a partir do qual este job pode ser tentado de novo. Sem isso, o
  // job que espera reconexão era escolhido de novo a cada volta do laço (o
  // `find` devolve sempre o primeiro em espera) e segurava a fila inteira —
  // inclusive envios de uma plataforma que estava no ar.
  naoAntesDe?: number
}

export class QueueManager {
  // Intervalo fixo e curto em vez de espera exponencial: a checagem de conexão
  // é local (o envio nem chega a tocar a rede quando o socket está fora), então
  // tentar de novo não custa nada — e oferta é perecível. Com espera dobrando,
  // uma queda de 100 segundos empurrava o envio para mais de 3 minutos depois.
  private readonly RETENTATIVA_CONEXAO_MS = 20_000
  // 60 x 20s = 20 minutos de tolerância, que cobre com folga as quedas de
  // reconexão vistas nos logs reais.
  private readonly MAX_TENTATIVAS_DE_CONEXAO = 60
  private redis: IORedis | null = null
  private queue: Queue | null = null
  private worker: Worker | null = null
  private dbManager: DatabaseManager | null = null
  private sendHandler: ((job: Job<SendJob>) => Promise<void>) | null = null
  private useRedis: boolean = false
  private memoryQueue: InMemoryJob[] = []
  private memoryProcessing: boolean = false
  private memoryPaused: boolean = false

  constructor() {
    this.tryConnectRedis()
  }

  private async tryConnectRedis(): Promise<void> {
    try {
      const redis = new IORedis({
        port: 6379,
        host: '127.0.0.1',
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 5000,
      })
      await redis.ping()
      this.redis = redis
      this.useRedis = true
      this.queue = new Queue('afiliado-pro-send', {
        connection: this.redis,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      })
      log.info('Redis conectado - usando BullMQ')
    } catch (error: any) {
      log.warn('Redis nao disponivel - usando fila em memoria:', error?.message || error)
      this.useRedis = false
      this.redis = null
      this.queue = null
    }
  }

  async init(): Promise<void> {
    log.info(`QueueManager inicializado (modo: ${this.useRedis ? 'Redis' : 'Memoria'})`)
  }

  setSendHandler(handler: (job: Job<SendJob>) => Promise<void>): void {
    this.sendHandler = handler
  }

  setDatabaseManager(dbManager: DatabaseManager): void {
    this.dbManager = dbManager
  }

  startWorker(): void {
    if (this.useRedis && this.queue && this.redis) {
      this.startRedisWorker()
    } else {
      this.startMemoryWorker()
    }
  }

  private startRedisWorker(): void {
    if (this.worker || !this.redis) return
    this.worker = new Worker(
      'afiliado-pro-send',
      async (job: Job<SendJob>) => {
        // Nota: BullMQ marca esse job 'completed' assim que essa função resolve
        // sem lançar erro, mesmo quando processJob() devolve 'deferred' (modo
        // stealth só reagendou pra depois). O modo Memória (bem mais comum,
        // já que o app não roda Redis por padrão) já diferencia isso — esse
        // caso do Redis compartilha a mesma limitação de antes desse fix.
        await this.processJob(job)
      },
      {
        connection: this.redis!,
        concurrency: 1,
        limiter: { max: 1, duration: 5000 },
      }
    )
    this.worker.on('failed', async (job, err) => {
      log.error('Job falhou:', err)
      if (this.dbManager && job) {
        this.dbManager.addLog({
          type: 'error',
          platform: job.data.platform,
          message: `Falha no envio: ${job.data.productTitle.substring(0, 50)}...`,
          details: err.message,
        })
      }
      sendToRenderer('queue:update', await this.getJobs())
    })
    this.worker.on('completed', async () => {
      sendToRenderer('queue:update', await this.getJobs())
    })
  }

  private startMemoryWorker(): void {
    if (this.memoryProcessing) return
    this.memoryProcessing = true
    this.processMemoryQueue()
  }

  private async processMemoryQueue(): Promise<void> {
    while (this.memoryProcessing) {
      if (this.memoryPaused) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      const agora = Date.now()
      const job = this.memoryQueue.find(
        (j) => j.status === 'waiting' && (!j.naoAntesDe || j.naoAntesDe <= agora)
      )
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      job.status = 'active'
      sendToRenderer('queue:update', await this.getJobs())

      if (job.delayMs > 0) {
        await new Promise((r) => setTimeout(r, job.delayMs))
      }

      const mockJob = { id: job.id, data: job.data } as Job<SendJob>
      try {
        const outcome = await this.processJob(mockJob)
        // 'deferred': modo stealth adiou pra depois (fora do horário, limite
        // por hora, cooldown) — já virou um job novo com delay maior, esse
        // aqui não foi enviado. Marcar como 'completed' faria a Fila mostrar
        // "Enviado" pra um produto que ainda nem saiu.
        job.status = outcome === 'sent' ? 'completed' : 'rescheduled'
      } catch (err) {
        // Sem isso, um erro aqui (ex: WhatsApp desconectado no momento do envio)
        // matava o while inteiro pra sempre — a fila parava de processar QUALQUER
        // job daí em diante, silenciosamente, pro resto da sessão do app. Os logs
        // de "Auto-repost: ... enviado" (que na verdade só significam "enfileirado")
        // continuavam aparecendo normalmente, escondendo que nada mais saía de fato.
        // Conexão fora do ar não é envio com defeito: é envio que ainda não pôde
        // acontecer. Marcar 'failed' descartava a oferta em silêncio — ela era
        // encontrada, virava anúncio, entrava na fila e sumia, porque o WhatsApp
        // dos testadores cai a cada 30-90 minutos. Reagenda e tenta de novo.
        const tentativas = (job.tentativasDeConexao ?? 0) + 1
        if (err instanceof ErroDeConexao && tentativas <= this.MAX_TENTATIVAS_DE_CONEXAO) {
          job.tentativasDeConexao = tentativas
          job.status = 'waiting'
          // A espera vira um horário, não um sleep: assim o laço segue para o
          // próximo job em vez de dormir segurando todos os outros.
          job.naoAntesDe = Date.now() + this.RETENTATIVA_CONEXAO_MS
          job.delayMs = 0
          log.warn(`Envio adiado (${job.data.platform} fora do ar), tentativa ${tentativas}/${this.MAX_TENTATIVAS_DE_CONEXAO} em ${job.delayMs / 1000}s`)
          if (tentativas === 1 && this.dbManager) {
            // Uma linha só, na primeira vez: o objetivo é o usuário saber que a
            // oferta não se perdeu, não encher o log a cada nova tentativa.
            this.dbManager.addLog({
              type: 'warning',
              platform: job.data.platform,
              message: `Envio adiado — ${job.data.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'} fora do ar: ${job.data.productTitle.substring(0, 40)}`,
              details: 'A oferta continua na fila e será enviada assim que a conexão voltar.',
            })
          }
          sendToRenderer('queue:update', await this.getJobs())
          continue
        }

        job.status = 'failed'
        log.error('Job da fila em memória falhou:', err)
        try {
          if (this.dbManager) {
            this.dbManager.addLog({
              type: 'error',
              platform: job.data.platform,
              message: `Falha no envio: ${job.data.productTitle.substring(0, 50)}...`,
              details: err instanceof ErroDeConexao
                ? `${(err as Error).message} — desisti depois de ${this.MAX_TENTATIVAS_DE_CONEXAO} tentativas ao longo de ${Math.round(this.MAX_TENTATIVAS_DE_CONEXAO * this.RETENTATIVA_CONEXAO_MS / 60000)} minutos.`
                : (err as Error).message,
            })
          }
        } catch (logErr) {
          // Se até registrar a falha der erro (ex: banco travado), não deixa
          // isso voltar a matar o loop — é exatamente o bug que esse catch existe
          // pra evitar, só que um nível mais fundo.
          log.error('Erro ao registrar falha do job na fila:', logErr)
        }
      }

      sendToRenderer('queue:update', await this.getJobs())
    }
  }

  // Retorna 'sent' quando o job de fato saiu, ou 'deferred' quando o modo
  // stealth só reagendou ele pra mais tarde (nesse caso não lançou exceção,
  // então quem chama precisa desse valor pra não tratar adiamento como envio).
  private async processJob(job: Job<SendJob>): Promise<'sent' | 'deferred'> {
    if (!this.sendHandler) throw new Error('Send handler nao configurado')
    if (!this.dbManager) throw new Error('Database manager nao configurado')

    const config = this.dbManager.getConfig()
    const { platform, groupId, productId } = job.data

    // === STEALTH MODE CHECKS ===
    if (config.stealth_mode) {
      const now = new Date()
      const currentHour = now.getHours()

      // 1. Verificar horario permitido (suporta overnight, ex: 22h -> 9h)
      const start = config.stealth_start_hour
      const end = config.stealth_end_hour
      let isAllowedHour: boolean

      if (start === end) {
        // 24h permitido — nunca adia por horario
        isAllowedHour = true
      } else if (start < end) {
        // Periodo normal: ex 9h -> 22h
        isAllowedHour = currentHour >= start && currentHour < end
      } else {
        // Overnight: ex 22h -> 9h (passa pela meia-noite)
        isAllowedHour = currentHour >= start || currentHour < end
      }

      if (!isAllowedHour) {
        const msg = `Stealth: fora do horario permitido (${start}h-${end}h). Job adiado.`
        log.info(msg)
        this.dbManager.addLog({
          type: 'warning',
          platform,
          message: 'Envio adiado - fora do horario stealth',
          details: `Horario atual: ${currentHour}h. Permitido: ${start}h-${end}h`,
        })
        // Calcular proximo horario permitido
        let hoursToWait: number
        if (start < end) {
          // Periodo normal
          hoursToWait = currentHour >= end ? (24 - currentHour + start) : (start - currentHour)
        } else {
          // Overnight: currentHour esta entre end e start (ex: 10h quando permitido eh 22h-9h)
          hoursToWait = start - currentHour
        }
        // Garantir valor positivo
        if (hoursToWait <= 0) hoursToWait += 24
        const delayMs = hoursToWait * 60 * 60 * 1000 + Math.random() * 30 * 60 * 1000
        await this.addJob(job.data, delayMs)
        return 'deferred'
      }

      // 2. Verificar limite por hora
      const hourlyCount = this.dbManager.getHourlySendCount(platform)
      if (hourlyCount >= config.stealth_hourly_limit) {
        const msg = `Stealth: limite horário atingido (${hourlyCount}/${config.stealth_hourly_limit}). Job adiado.`
        log.info(msg)
        this.dbManager.addLog({
          type: 'warning',
          platform,
          message: 'Envio adiado - limite horário atingido',
          details: `${hourlyCount}/${config.stealth_hourly_limit} envios na última hora`,
        })
        // Reagendar para daqui a 1h + jitter
        const jitter = Math.random() * config.stealth_jitter_percent / 100 * 60 * 60 * 1000
        await this.addJob(job.data, 60 * 60 * 1000 + jitter)
        return 'deferred'
      }

      // 3. Verificar cooldown entre envios para o mesmo grupo
      const lastSend = this.dbManager.getLastSendToGroup(platform, groupId)
      if (lastSend) {
        const minutesSinceLastSend = (Date.now() - lastSend.getTime()) / (1000 * 60)
        if (minutesSinceLastSend < config.stealth_cooldown_minutes) {
          const waitMinutes = config.stealth_cooldown_minutes - minutesSinceLastSend
          const msg = `Stealth: cooldown de grupo ativo. Último envio há ${minutesSinceLastSend.toFixed(1)}min. Aguardando ${waitMinutes.toFixed(1)}min.`
          log.info(msg)
          this.dbManager.addLog({
            type: 'warning',
            platform,
            message: 'Envio adiado - cooldown de grupo',
            details: `Último envio há ${minutesSinceLastSend.toFixed(1)}min. Cooldown: ${config.stealth_cooldown_minutes}min`,
          })
          await this.addJob(job.data, waitMinutes * 60 * 1000)
          return 'deferred'
        }
      }

      // 4. Aplicar jitter no delay base
      const jitterMultiplier = 1 + (Math.random() * 2 - 1) * (config.stealth_jitter_percent / 100)
      const jitteredDelay = Math.floor((config.min_delay_seconds + Math.random() * (config.max_delay_seconds - config.min_delay_seconds)) * 1000 * jitterMultiplier)
      if (jitteredDelay > 0) {
        await new Promise((r) => setTimeout(r, jitteredDelay))
      }
    }

    // === EXECUTAR ENVIO ===
    await this.sendHandler(job)

    // Registrar no histórico
    this.dbManager.recordSend(platform, groupId, productId)

    this.dbManager.addLog({
      type: 'success',
      platform,
      message: `Produto enviado: ${job.data.productTitle.substring(0, 50)}...`,
      details: `Grupo: ${groupId}`,
    })

    sendToRenderer('queue:update', await this.getJobs())
    return 'sent'
  }

  async addJob(data: SendJob, delayMs: number = 0): Promise<any> {
    if (this.useRedis && this.queue) {
      const job = await this.queue.add('send-product', data, { delay: delayMs })
      sendToRenderer('queue:update', await this.getJobs())
      return job
    } else {
      const job: InMemoryJob = {
        id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        data,
        status: 'waiting',
        createdAt: new Date(),
        delayMs,
      }
      this.memoryQueue.push(job)
      void this.getJobs().then((jobs) => sendToRenderer('queue:update', jobs))
      return job
    }
  }

  async getJobs(): Promise<any[]> {
    if (this.useRedis && this.queue) {
      const [waiting, active, completed, failed] = await Promise.all([
        this.queue.getWaiting(),
        this.queue.getActive(),
        this.queue.getCompleted(0, 50),
        this.queue.getFailed(0, 50),
      ])
      return [
        ...waiting.map((j) => ({ ...j.toJSON(), status: 'waiting' })),
        ...active.map((j) => ({ ...j.toJSON(), status: 'active' })),
        ...completed.map((j) => ({ ...j.toJSON(), status: 'completed' })),
        ...failed.map((j) => ({ ...j.toJSON(), status: 'failed' })),
      ]
    } else {
      return this.memoryQueue.map((j) => ({
        id: j.id,
        data: j.data,
        status: j.status,
        created_at: j.createdAt.toISOString(),
      }))
    }
  }

  async pause(): Promise<void> {
    if (this.useRedis && this.queue) {
      await this.queue.pause()
    } else {
      this.memoryPaused = true
    }
  }

  async resume(): Promise<void> {
    if (this.useRedis && this.queue) {
      await this.queue.resume()
    } else {
      this.memoryPaused = false
    }
  }

  async clear(): Promise<void> {
    if (this.useRedis && this.queue) {
      await this.queue.obliterate({ force: true })
    } else {
      this.memoryQueue = []
    }
    sendToRenderer('queue:update', [])
  }

  async close(): Promise<void> {
    this.memoryProcessing = false
    if (this.worker) await this.worker.close()
    if (this.queue) await this.queue.close()
    if (this.redis) await this.redis.quit()
  }
}
