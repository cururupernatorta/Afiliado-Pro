import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import log from 'electron-log'

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

export interface AdTemplate {
  id?: number
  platform: 'whatsapp' | 'telegram'
  group_id: string
  template_text: string
}

export interface LogEntry {
  id?: number
  type: 'info' | 'warning' | 'error' | 'success'
  platform?: 'whatsapp' | 'telegram' | 'system'
  message: string
  details?: string
  created_at?: string
}

export class DatabaseManager {
  private db: Database.Database

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
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

      CREATE TABLE IF NOT EXISTS ad_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('whatsapp', 'telegram')),
        group_id TEXT NOT NULL,
        template_text TEXT NOT NULL DEFAULT '*{title}*\n\n💰 De ~~R$ {original_price}~~ por *R$ {price}*\n\n📝 {description}\n\n🔗 {affiliate_url}\n\n⚡ Corra antes que acabe!\n\n👥 Entre no nosso grupo de ofertas: {group_link}',
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

  getAdTemplate(platform: string, groupId: string): AdTemplate | undefined {
    return this.db.prepare('SELECT * FROM ad_templates WHERE platform = ? AND group_id = ?').get(platform, groupId) as AdTemplate | undefined
  }

  saveAdTemplate(template: Omit<AdTemplate, 'id' | 'created_at' | 'updated_at'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO ad_templates (platform, group_id, template_text)
      VALUES (?, ?, ?)
      ON CONFLICT(platform, group_id) DO UPDATE SET
        template_text = excluded.template_text,
        updated_at = CURRENT_TIMESTAMP
    `)
    stmt.run(template.platform, template.group_id, template.template_text)
  }

  deleteAdTemplate(platform: string, groupId: string): void {
    this.db.prepare('DELETE FROM ad_templates WHERE platform = ? AND group_id = ?').run(platform, groupId)
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
    this.db.prepare('INSERT INTO logs (type, platform, message, details) VALUES (?, ?, ?, ?)').run(
      entry.type,
      entry.platform ?? null,
      entry.message,
      entry.details ?? null
    )
  }

  getLogs(limit: number = 100, offset: number = 0): LogEntry[] {
    return this.db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as LogEntry[]
  }

  close(): void {
    this.db.close()
  }
}
