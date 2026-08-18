import { Queue, Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import log from 'electron-log'
import { sendToRenderer } from './utils'
import { DatabaseManager } from './database'

interface SendJob {
  platform: 'whatsapp' | 'telegram'
  groupId: string
  productId: number
  productTitle: string
  productPrice: number
  productImagePath?: string
  affiliateUrl: string
}

interface InMemoryJob {
  id: string
  data: SendJob
  status: 'waiting' | 'active' | 'completed' | 'failed'
  createdAt: Date
  delayMs: number
}

export class QueueManager {
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
        await this.processJob(job)
      },
      {
        connection: this.redis!,
        concurrency: 1,
        limiter: { max: 1, duration: 5000 },
      }
    )
    this.worker.on('failed', (job, err) => {
      log.error('Job falhou:', err)
      if (this.dbManager && job) {
        this.dbManager.addLog({
          type: 'error',
          platform: job.data.platform,
          message: `Falha no envio: ${job.data.productTitle.substring(0, 50)}...`,
          details: err.message,
        })
      }
      sendToRenderer('queue:update', this.getJobs())
    })
    this.worker.on('completed', () => {
      sendToRenderer('queue:update', this.getJobs())
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
      const job = this.memoryQueue.find((j) => j.status === 'waiting')
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      job.status = 'active'
      sendToRenderer('queue:update', this.getJobs())

      if (job.delayMs > 0) {
        await new Promise((r) => setTimeout(r, job.delayMs))
      }

      const mockJob = { id: job.id, data: job.data } as Job<SendJob>
      await this.processJob(mockJob)

      sendToRenderer('queue:update', this.getJobs())
    }
  }

  private async processJob(job: Job<SendJob>): Promise<void> {
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
        return
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
        return
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
          return
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
      sendToRenderer('queue:update', this.getJobs())
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
