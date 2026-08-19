import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import log from 'electron-log'
import { EventEmitter } from 'events'

export interface Product {
  id?: number
  title: string
  price: number
  original_price?: number
  image_url?: string
  image_path?: string
  description?: string
  original_url: string
  affiliate_url?: string
  store: 'shopee' | 'mercado_livre' | 'amazon' | 'aliexpress'
  source: 'manual' | 'whatsapp' | 'telegram'
  created_at?: string
  updated_at?: string
}

export interface Config {
  id?: number
  shopee_app_id?: string
  shopee_app_secret?: string
  mercado_livre_affiliate_id?: string
  amazon_tag?: string
  aliexpress_app_key?: string
  aliexpress_app_secret?: string
  aliexpress_tracking_id?: string
  whatsapp_daily_limit: number
  telegram_daily_limit: number
  min_delay_seconds: number
  max_delay_seconds: number
  auto_convert_links: boolean
  auto_repost_enabled: boolean
  stealth_mode: boolean
  stealth_start_hour: number
  stealth_end_hour: number
  stealth_hourly_limit: number
  stealth_jitter_percent: number
  stealth_cooldown_minutes: number
  niche?: string
  auto_scrape_enabled: boolean
  auto_scrape_interval_hours: number
  group_link?: string
}

export interface GroupMonitor {
  id?: number
  platform: 'whatsapp' | 'telegram'
  group_id: string
  group_name: string
  monitored: boolean
  created_at?: string
}

export interface AutoSendTarget {
  id?: number
  platform: 'whatsapp' | 'telegram'
  group_id: string
  group_name: string
  enabled: boolean
  created_at?: string
}

export interface MessageTemplate {
  id?: number
  name: string
  template_text: string
  created_at?: string
  updated_at?: string
}

export interface AdTemplate {
  id?: number
  platform: 'whatsapp' | 'telegram'
  group_id: string
  template_id: number | null
  template_text: string | null
}

export interface LogEntry {
  id?: number
  type: 'info' | 'warning' | 'error' | 'success'
  platform?: 'whatsapp' | 'telegram' | 'system'
  message: string
  details?: string
  created_at?: string
}

export class DatabaseManager extends EventEmitter {
  private db: Database.Database

  constructor(dbPath: string) {
    super()
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initTables()
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        price REAL NOT NULL,
        original_price REAL,
        image_url TEXT,
        image_path TEXT,
        description TEXT,
        original_url TEXT NOT NULL UNIQUE,
        affiliate_url TEXT,
        store TEXT NOT NULL CHECK(store IN ('shopee', 'mercado_livre', 'amazon', 'aliexpress')),
        source TEXT NOT NULL CHECK(source IN ('manual', 'whatsapp', 'telegram')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_products_store ON products(store);
      CREATE INDEX IF NOT EXISTS idx_products_source ON products(source);
      CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);

      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        shopee_app_id TEXT,
        shopee_app_secret TEXT,
        mercado_livre_affiliate_id TEXT,
        amazon_tag TEXT,
        aliexpress_app_key TEXT,
        aliexpress_app_secret TEXT,
        aliexpress_tracking_id TEXT,
        whatsapp_daily_limit INTEGER DEFAULT 50,
        telegram_daily_limit INTEGER DEFAULT 50,
        min_delay_seconds INTEGER DEFAULT 3,
        max_delay_seconds INTEGER DEFAULT 15,
        auto_convert_links INTEGER DEFAULT 1,
        auto_repost_enabled INTEGER DEFAULT 0,
        stealth_mode INTEGER DEFAULT 0,
        stealth_start_hour INTEGER DEFAULT 9,
        stealth_end_hour INTEGER DEFAULT 22,
        stealth_hourly_limit INTEGER DEFAULT 5,
        stealth_jitter_percent INTEGER DEFAULT 30,
        stealth_cooldown_minutes INTEGER DEFAULT 10,
        niche TEXT,
        auto_scrape_enabled INTEGER DEFAULT 0,
        auto_scrape_interval_hours INTEGER DEFAULT 6,
        group_link TEXT
      );

      INSERT OR IGNORE INTO config (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS group_monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('whatsapp', 'telegram')),
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        monitored INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, group_id)
      );

      CREATE INDEX IF NOT EXISTS idx_groups_platform ON group_monitors(platform);
      CREATE INDEX IF NOT EXISTS idx_groups_monitored ON group_monitors(monitored);

      CREATE TABLE IF NOT EXISTS auto_send_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('whatsapp', 'telegram')),
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, group_id)
      );

      CREATE INDEX IF NOT EXISTS idx_auto_send_platform ON auto_send_targets(platform);
      CREATE INDEX IF NOT EXISTS idx_auto_send_enabled ON auto_send_targets(enabled);

      CREATE TABLE IF NOT EXISTS message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        template_text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ad_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('whatsapp', 'telegram')),
        group_id TEXT NOT NULL,
        template_id INTEGER REFERENCES message_templates(id) ON DELETE SET NULL,
        template_text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, group_id)
      );

      CREATE INDEX IF NOT EXISTS idx_templates_platform ON ad_templates(platform);

      CREATE TABLE IF NOT EXISTS send_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('whatsapp', 'telegram')),
        group_id TEXT NOT NULL,
        product_id INTEGER,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_send_history_platform ON send_history(platform);
      CREATE INDEX IF NOT EXISTS idx_send_history_group ON send_history(group_id);
      CREATE INDEX IF NOT EXISTS idx_send_history_time ON send_history(sent_at);

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('info', 'warning', 'error', 'success')),
        platform TEXT CHECK(platform IN ('whatsapp', 'telegram', 'system')),
        message TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
      CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
    `)

    // Migração: adiciona aliexpress_tracking_id em bancos já existentes
    // (CREATE TABLE IF NOT EXISTS não altera tabelas que já foram criadas antes)
    try {
      const columns = this.db.prepare("PRAGMA table_info(config)").all() as any[]
      const hasTrackingId = columns.some((c) => c.name === 'aliexpress_tracking_id')
      if (!hasTrackingId) {
        this.db.exec('ALTER TABLE config ADD COLUMN aliexpress_tracking_id TEXT')
        log.info('Migração: coluna aliexpress_tracking_id adicionada à tabela config')
      }
    } catch (err) {
      log.error('Erro na migração aliexpress_tracking_id:', err)
    }

    // Migração: adiciona template_id em ad_templates (biblioteca de templates
    // nomeados/reutilizáveis, substitui o texto solto por grupo)
    try {
      const columns = this.db.prepare("PRAGMA table_info(ad_templates)").all() as any[]
      const hasTemplateId = columns.some((c) => c.name === 'template_id')
      if (!hasTemplateId) {
        this.db.exec('ALTER TABLE ad_templates ADD COLUMN template_id INTEGER REFERENCES message_templates(id) ON DELETE SET NULL')
        log.info('Migração: coluna template_id adicionada à tabela ad_templates')

        // Grupos configurados antes dessa migração guardavam o próprio texto solto
        // em ad_templates.template_text. Sem isso, esse texto continuaria valendo
        // pra sempre (via COALESCE em getAdTemplate) mesmo com a tela nova mostrando
        // "Padrão do sistema" pro grupo — migra cada um pra um template nomeado na
        // biblioteca nova, e associa o grupo a ele, preservando o texto E deixando
        // visível/editável.
        const legacyRows = this.db.prepare(
          "SELECT id, platform, group_id, template_text FROM ad_templates WHERE template_text IS NOT NULL AND template_text != ''"
        ).all() as { id: number; platform: string; group_id: string; template_text: string }[]

        for (const row of legacyRows) {
          const name = `Migrado — ${row.platform} — ${row.group_id}`.substring(0, 100)
          const created = this.db.prepare(
            'INSERT INTO message_templates (name, template_text) VALUES (?, ?)'
          ).run(name, row.template_text)
          this.db.prepare('UPDATE ad_templates SET template_id = ? WHERE id = ?').run(created.lastInsertRowid, row.id)
        }
        if (legacyRows.length > 0) {
          log.info(`Migração: ${legacyRows.length} template(s) de grupo migrado(s) para a biblioteca`)
        }
      }
    } catch (err) {
      log.error('Erro na migração template_id:', err)
    }
  }

  getAllProducts(): Product[] {
    return this.db.prepare('SELECT * FROM products ORDER BY created_at DESC').all() as Product[]
  }

  getProductById(id: number): Product | undefined {
    return this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Product | undefined
  }

  getProductByUrl(url: string): Product | undefined {
    return this.db.prepare('SELECT * FROM products WHERE original_url = ?').get(url) as Product | undefined
  }

  productExistsByUrl(url: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM products WHERE original_url = ?').get(url)
    return !!row
  }

  createProduct(product: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Product | null {
    if (this.productExistsByUrl(product.original_url)) {
      log.warn(`Produto ignorado - URL já existe no banco: ${product.original_url}`)
      this.addLog({
        type: 'warning',
        platform: product.source as any,
        message: 'Produto duplicado ignorado',
        details: `URL já capturada anteriormente: ${product.original_url}`,
      })
      return null
    }

    const stmt = this.db.prepare(`
      INSERT INTO products (title, price, original_price, image_url, image_path, description, original_url, affiliate_url, store, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      product.title,
      product.price,
      product.original_price ?? null,
      product.image_url ?? null,
      product.image_path ?? null,
      product.description ?? null,
      product.original_url,
      product.affiliate_url ?? null,
      product.store,
      product.source
    )
    return this.getProductById(result.lastInsertRowid as number)!
  }

  updateProduct(id: number, product: Partial<Product>): void {
    const fields: string[] = []
    const values: any[] = []

    Object.entries(product).forEach(([key, value]) => {
      if (value !== undefined && key !== 'id' && key !== 'created_at') {
        fields.push(`${key} = ?`)
        values.push(value)
      }
    })

    if (fields.length === 0) return

    fields.push('updated_at = CURRENT_TIMESTAMP')
    values.push(id)

    this.db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteProduct(id: number): void {
    this.db.prepare('DELETE FROM products WHERE id = ?').run(id)
  }

  getConfig(): Config {
    const row = this.db.prepare('SELECT * FROM config WHERE id = 1').get() as any
    if (!row) {
      return {
        whatsapp_daily_limit: 50,
        telegram_daily_limit: 50,
        min_delay_seconds: 3,
        max_delay_seconds: 15,
        auto_convert_links: true,
        auto_repost_enabled: false,
        stealth_mode: false,
        stealth_start_hour: 9,
        stealth_end_hour: 22,
        stealth_hourly_limit: 5,
        stealth_jitter_percent: 30,
        stealth_cooldown_minutes: 10,
        niche: '',
        auto_scrape_enabled: false,
        auto_scrape_interval_hours: 6,
        group_link: '',
      }
    }
    return {
      ...row,
      auto_convert_links: row.auto_convert_links === 1,
      auto_repost_enabled: row.auto_repost_enabled === 1,
      stealth_mode: row.stealth_mode === 1,
    }
  }

  saveConfig(config: Partial<Config>): void {
    const fields: string[] = []
    const values: any[] = []

    Object.entries(config).forEach(([key, value]) => {
      if (value !== undefined && key !== 'id') {
        fields.push(`${key} = ?`)
        // SQLite nao tem tipo booleano — converte para 0/1
        if (typeof value === 'boolean') {
          values.push(value ? 1 : 0)
        } else {
          values.push(value)
        }
      }
    })

    if (fields.length === 0) return

    values.push(1)
    this.db.prepare(`UPDATE config SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  getGroups(platform?: 'whatsapp' | 'telegram'): GroupMonitor[] {
    if (platform) {
      return this.db.prepare('SELECT * FROM group_monitors WHERE platform = ? ORDER BY group_name').all(platform) as GroupMonitor[]
    }
    return this.db.prepare('SELECT * FROM group_monitors ORDER BY platform, group_name').all() as GroupMonitor[]
  }

  saveGroup(group: Omit<GroupMonitor, 'id' | 'created_at'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO group_monitors (platform, group_id, group_name, monitored)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, group_id) DO UPDATE SET
        group_name = excluded.group_name,
        monitored = excluded.monitored
    `)
    stmt.run(group.platform, group.group_id, group.group_name, group.monitored ? 1 : 0)
  }

  toggleGroupMonitor(platform: string, groupId: string, monitored: boolean): void {
    this.db.prepare(
      'UPDATE group_monitors SET monitored = ? WHERE platform = ? AND group_id = ?'
    ).run(monitored ? 1 : 0, platform, groupId)
  }

  getMonitoredGroups(platform: 'whatsapp' | 'telegram'): GroupMonitor[] {
    return this.db.prepare('SELECT * FROM group_monitors WHERE platform = ? AND monitored = 1').all(platform) as GroupMonitor[]
  }

  getAutoSendTargets(platform?: 'whatsapp' | 'telegram'): AutoSendTarget[] {
    if (platform) {
      return this.db.prepare('SELECT * FROM auto_send_targets WHERE platform = ? ORDER BY group_name').all(platform) as AutoSendTarget[]
    }
    return this.db.prepare('SELECT * FROM auto_send_targets ORDER BY platform, group_name').all() as AutoSendTarget[]
  }

  saveAutoSendTarget(target: Omit<AutoSendTarget, 'id' | 'created_at'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO auto_send_targets (platform, group_id, group_name, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, group_id) DO UPDATE SET
        group_name = excluded.group_name,
        enabled = excluded.enabled
    `)
    stmt.run(target.platform, target.group_id, target.group_name, target.enabled ? 1 : 0)
  }

  removeAutoSendTarget(platform: string, groupId: string): void {
    this.db.prepare('DELETE FROM auto_send_targets WHERE platform = ? AND group_id = ?').run(platform, groupId)
    this.db.prepare('DELETE FROM ad_templates WHERE platform = ? AND group_id = ?').run(platform, groupId)
  }

  toggleAutoSendTarget(platform: string, groupId: string, enabled: boolean): void {
    this.db.prepare(
      'UPDATE auto_send_targets SET enabled = ? WHERE platform = ? AND group_id = ?'
    ).run(enabled ? 1 : 0, platform, groupId)
  }

  getEnabledAutoSendTargets(platform: 'whatsapp' | 'telegram'): AutoSendTarget[] {
    return this.db.prepare('SELECT * FROM auto_send_targets WHERE platform = ? AND enabled = 1').all(platform) as AutoSendTarget[]
  }

  // Retorna o texto do grupo já resolvido: se o grupo aponta pra um template da
  // biblioteca (template_id), usa o texto de lá; senão cai no template_text legado
  // (grupos configurados antes da biblioteca existir).
  getAdTemplate(platform: string, groupId: string): AdTemplate | undefined {
    return this.db.prepare(`
      SELECT at.id, at.platform, at.group_id, at.template_id,
             COALESCE(mt.template_text, at.template_text) as template_text
      FROM ad_templates at
      LEFT JOIN message_templates mt ON mt.id = at.template_id
      WHERE at.platform = ? AND at.group_id = ?
    `).get(platform, groupId) as AdTemplate | undefined
  }

  // Associa um grupo a um template da biblioteca. templateId = null desassocia
  // (o grupo volta a usar o template padrão do sistema).
  assignAdTemplate(platform: string, groupId: string, templateId: number | null): void {
    // Se o id apontar pra um template que não existe mais (apagado em outra janela,
    // ou id obsoleto no front), trata como "nenhum" em vez de deixar a constraint de
    // chave estrangeira derrubar a operação com um erro.
    const resolvedId = templateId !== null && this.getMessageTemplateById(templateId) ? templateId : null
    const stmt = this.db.prepare(`
      INSERT INTO ad_templates (platform, group_id, template_id, template_text)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(platform, group_id) DO UPDATE SET
        template_id = excluded.template_id,
        template_text = NULL,
        updated_at = CURRENT_TIMESTAMP
    `)
    stmt.run(platform, groupId, resolvedId)
  }

  deleteAdTemplate(platform: string, groupId: string): void {
    this.db.prepare('DELETE FROM ad_templates WHERE platform = ? AND group_id = ?').run(platform, groupId)
  }

  // ==================== Biblioteca de Templates ====================

  getMessageTemplates(): MessageTemplate[] {
    return this.db.prepare('SELECT * FROM message_templates ORDER BY name').all() as MessageTemplate[]
  }

  getMessageTemplateById(id: number): MessageTemplate | undefined {
    return this.db.prepare('SELECT * FROM message_templates WHERE id = ?').get(id) as MessageTemplate | undefined
  }

  createMessageTemplate(template: { name: string; template_text: string }): MessageTemplate {
    const result = this.db.prepare(
      'INSERT INTO message_templates (name, template_text) VALUES (?, ?)'
    ).run(template.name, template.template_text)
    return this.getMessageTemplateById(result.lastInsertRowid as number)!
  }

  updateMessageTemplate(id: number, template: { name?: string; template_text?: string }): void {
    const fields: string[] = []
    const values: any[] = []
    if (template.name !== undefined) { fields.push('name = ?'); values.push(template.name) }
    if (template.template_text !== undefined) { fields.push('template_text = ?'); values.push(template.template_text) }
    if (fields.length === 0) return
    fields.push('updated_at = CURRENT_TIMESTAMP')
    values.push(id)
    this.db.prepare(`UPDATE message_templates SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteMessageTemplate(id: number): void {
    // ON DELETE SET NULL cuida de desassociar os grupos que usavam esse template
    // (voltam a usar o padrão do sistema em vez de quebrar).
    this.db.prepare('DELETE FROM message_templates WHERE id = ?').run(id)
  }

  // Send History (para stealth mode)
  recordSend(platform: string, groupId: string, productId?: number): void {
    this.db.prepare('INSERT INTO send_history (platform, group_id, product_id) VALUES (?, ?, ?)').run(platform, groupId, productId ?? null)
  }

  getHourlySendCount(platform: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM send_history 
      WHERE platform = ? AND sent_at >= datetime('now', '-1 hour')
    `).get(platform) as any
    return row?.count || 0
  }

  getDailySendCount(platform: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM send_history 
      WHERE platform = ? AND sent_at >= datetime('now', '-24 hours')
    `).get(platform) as any
    return row?.count || 0
  }

  getLastSendToGroup(platform: string, groupId: string): Date | null {
    const row = this.db.prepare(`
      SELECT sent_at FROM send_history 
      WHERE platform = ? AND group_id = ? 
      ORDER BY sent_at DESC LIMIT 1
    `).get(platform, groupId) as any
    return row ? new Date(row.sent_at) : null
  }

  addLog(entry: Omit<LogEntry, 'id' | 'created_at'>): void {
    const result = this.db.prepare('INSERT INTO logs (type, platform, message, details) VALUES (?, ?, ?, ?)').run(
      entry.type,
      entry.platform ?? null,
      entry.message,
      entry.details ?? null
    )
    const created = this.db.prepare('SELECT * FROM logs WHERE id = ?').get(result.lastInsertRowid) as LogEntry
    this.emit('log', created)
  }

  getLogs(limit: number = 100, offset: number = 0): LogEntry[] {
    return this.db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as LogEntry[]
  }

  close(): void {
    this.db.close()
  }
}
