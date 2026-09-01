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
  /** Preço no Pix, informado à mão — nenhuma loja expõe isso por API. */
  pix_price?: number
  /** Página de cupom da loja; vira link de afiliado na hora do envio. */
  coupon_url?: string
  store: 'shopee' | 'mercado_livre' | 'amazon' | 'aliexpress'
  source: 'manual' | 'whatsapp' | 'telegram' | 'busca'
  created_at?: string
  updated_at?: string
}

export interface Config {
  id?: number
  shopee_app_id?: string
  shopee_app_secret?: string
  /** @deprecated migrado pra mercado_livre_matt_tool — mantido só pra não quebrar leituras de bancos antigos */
  mercado_livre_affiliate_id?: string
  mercado_livre_matt_tool?: string
  mercado_livre_matt_word?: string
  /** Aplicação criada em developers.mercadolivre.com.br, usada pra ler os dados do produto pela API oficial. */
  mercado_livre_client_id?: string
  mercado_livre_client_secret?: string
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
  auto_scrape_interval_minutes: number
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
  /**
   * Palavras-chave do grupo, separadas por vírgula. Vazio significa "recebe
   * tudo" — que é como todo grupo se comportava antes deste campo existir.
   */
  niche?: string
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

/**
 * Chave de comparação de produto: a URL sem query nem âncora.
 *
 * A página de ofertas do Mercado Livre devolve o mesmo produto com um
 * `deal_print_id` diferente A CADA CARREGAMENTO — medido: duas buscas com 4
 * segundos de intervalo trouxeram os mesmos 42 produtos e ZERO URLs iguais.
 * Comparando a URL inteira, cada busca criava 42 "produtos novos" e repostava
 * todos, o que na prática enchia o grupo de anúncios repetidos.
 *
 * Só a parte antes de `?` e `#` identifica o produto: em todas as lojas que o
 * app trata, o identificador está no caminho (`/p/MLB...`, `/item/123.html`,
 * `-i.shop.item`, `/dp/ASIN`), e o resto é rastreio.
 */
export function urlBaseDoProduto(url: string): string {
  return String(url || '').split('#')[0].split('?')[0]
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
        pix_price REAL,
        coupon_url TEXT,
        store TEXT NOT NULL CHECK(store IN ('shopee', 'mercado_livre', 'amazon', 'aliexpress')),
        source TEXT NOT NULL CHECK(source IN ('manual', 'whatsapp', 'telegram', 'busca')),
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
        auto_scrape_interval_minutes INTEGER DEFAULT 360,
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
        niche TEXT,
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

    // Migração: matt_tool e matt_word do Mercado Livre são dois identificadores
    // DIFERENTES (confirmado analisando um link de afiliado real: matt_tool é
    // numérico, tipo "55658638"; matt_word é o texto do perfil, tipo
    // "rainycreates") — o campo antigo "mercado_livre_affiliate_id" colava o
    // mesmo valor nos dois, gerando um link que não bate com o formato real
    // que o Mercado Livre usa. Migra o valor antigo pra matt_tool (o mais
    // parecido em formato/uso) e deixa matt_word em branco — o usuário precisa
    // pegar esse valor de um link de afiliado real gerado pela própria conta.
    try {
      const columns = this.db.prepare("PRAGMA table_info(config)").all() as any[]
      const hasMattTool = columns.some((c) => c.name === 'mercado_livre_matt_tool')
      if (!hasMattTool) {
        this.db.exec('ALTER TABLE config ADD COLUMN mercado_livre_matt_tool TEXT')
        this.db.exec('ALTER TABLE config ADD COLUMN mercado_livre_matt_word TEXT')
        this.db.exec(`
          UPDATE config SET mercado_livre_matt_tool = mercado_livre_affiliate_id
          WHERE mercado_livre_affiliate_id IS NOT NULL AND mercado_livre_affiliate_id != ''
        `)
        log.info('Migração: colunas mercado_livre_matt_tool/matt_word adicionadas à tabela config')
      }
    } catch (err) {
      log.error('Erro na migração mercado_livre_matt_tool/matt_word:', err)
    }

    // Migração: normaliza a tabela ad_templates de bancos antigos.
    //
    // Duas heranças quebravam a associação de template a grupo, e as duas
    // apareceram só em banco de usuário (o schema novo já nasce correto):
    //  - template_text criada como NOT NULL: associar um template da
    //    biblioteca grava esse campo como NULL (o texto passa a vir do
    //    template), e o SQLite recusava com "NOT NULL constraint failed".
    //  - falta do índice único (platform, group_id), sem o qual um INSERT com
    //    ON CONFLICT nessa dupla é recusado por inteiro.
    //
    // Coluna NOT NULL não se altera no SQLite sem reconstruir a tabela, então
    // é o que se faz aqui, copiando os dados por nome de coluna (a ordem varia
    // entre bancos, já que template_id foi acrescentada depois).
    try {
      const cols = this.db.prepare('PRAGMA table_info(ad_templates)').all() as any[]
      const textCol = cols.find((c) => c.name === 'template_text')
      const idx = this.db.prepare('PRAGMA index_list(ad_templates)').all() as any[]
      const precisaReconstruir = !!textCol && textCol.notnull === 1
      const semIndiceUnico = !idx.some((i) => i.unique === 1)

      if (precisaReconstruir) {
        this.db.exec('PRAGMA foreign_keys = OFF')
        this.db.exec(`
          CREATE TABLE ad_templates_migracao (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL CHECK(platform IN ('whatsapp', 'telegram')),
            group_id TEXT NOT NULL,
            template_id INTEGER REFERENCES message_templates(id) ON DELETE SET NULL,
            template_text TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(platform, group_id)
          );
          INSERT INTO ad_templates_migracao (id, platform, group_id, template_id, template_text, created_at, updated_at)
            SELECT id, platform, group_id,
                   ${cols.some((c) => c.name === 'template_id') ? 'template_id' : 'NULL'},
                   NULLIF(template_text, ''), created_at, updated_at
              FROM ad_templates
             WHERE id IN (SELECT MAX(id) FROM ad_templates GROUP BY platform, group_id);
          DROP TABLE ad_templates;
          ALTER TABLE ad_templates_migracao RENAME TO ad_templates;
          CREATE INDEX IF NOT EXISTS idx_templates_platform ON ad_templates(platform);
        `)
        this.db.exec('PRAGMA foreign_keys = ON')
        log.info('Migração: ad_templates reconstruída (template_text deixou de ser NOT NULL)')
      } else if (semIndiceUnico) {
        this.db.exec(`
          DELETE FROM ad_templates
           WHERE id NOT IN (SELECT MAX(id) FROM ad_templates GROUP BY platform, group_id)
        `)
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_templates_group ON ad_templates(platform, group_id)')
        log.info('Migração: índice único criado em ad_templates(platform, group_id)')
      }
    } catch (err) {
      log.error('Erro na migração da tabela ad_templates:', err)
    }

    // Migração: preço no Pix e link de cupom por produto. Nenhuma das lojas
    // expõe esses dados por API (confirmado na documentação da Shopee e do
    // Mercado Livre), então são informados à mão por quem monta o anúncio.
    try {
      const columns = this.db.prepare('PRAGMA table_info(products)').all() as any[]
      if (!columns.some((c) => c.name === 'pix_price')) {
        this.db.exec('ALTER TABLE products ADD COLUMN pix_price REAL')
        this.db.exec('ALTER TABLE products ADD COLUMN coupon_url TEXT')
        log.info('Migração: colunas pix_price/coupon_url adicionadas à tabela products')
      }
    } catch (err) {
      log.error('Erro na migração de pix_price/coupon_url:', err)
    }

    // Migração: (a) a coluna `source` ganha o valor 'busca', para a oferta achada
    // pela busca automática parar de se passar por cadastro manual — o card
    // "Produtos Capturados" do Dashboard contava `source != 'manual'` e por isso
    // dava sempre zero; e (b) as URLs já gravadas são normalizadas e os
    // duplicados removidos.
    //
    // O (b) é necessário porque a página de ofertas do Mercado Livre devolve um
    // `deal_print_id` novo a cada carregamento: a mesma oferta entrava como
    // produto novo em toda busca. A correção nova evita criar mais, mas os que
    // já estão no banco continuariam lá, e o UNIQUE de `original_url` impediria
    // a normalização sem antes remover as repetições.
    //
    // Trocar um CHECK exige reconstruir a tabela — SQLite não altera restrição.
    try {
      const cols = this.db.prepare('PRAGMA table_info(products)').all() as any[]
      const jaTem = cols.length > 0 && (this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'")
        .get() as any)?.sql?.includes("'busca'")

      if (cols.length > 0 && !jaTem) {
        // Pega a base da URL do jeito que o app faz: corta no primeiro '?' ou '#'.
        const URL_BASE = `
          CASE
            WHEN instr(original_url, '?') > 0
             AND (instr(original_url, '#') = 0 OR instr(original_url, '?') < instr(original_url, '#'))
              THEN substr(original_url, 1, instr(original_url, '?') - 1)
            WHEN instr(original_url, '#') > 0
              THEN substr(original_url, 1, instr(original_url, '#') - 1)
            ELSE original_url
          END`

        const antes = (this.db.prepare('SELECT COUNT(*) c FROM products').get() as any).c
        this.db.exec('PRAGMA foreign_keys = OFF')
        this.db.exec(`
          BEGIN;

          CREATE TABLE products_migracao (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            price REAL NOT NULL,
            original_price REAL,
            image_url TEXT,
            image_path TEXT,
            description TEXT,
            original_url TEXT NOT NULL UNIQUE,
            affiliate_url TEXT,
            pix_price REAL,
            coupon_url TEXT,
            store TEXT NOT NULL CHECK(store IN ('shopee', 'mercado_livre', 'amazon', 'aliexpress')),
            source TEXT NOT NULL CHECK(source IN ('manual', 'whatsapp', 'telegram', 'busca')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          -- Mantém a linha MAIS ANTIGA de cada URL: é a que já foi enviada e a
          -- que o histórico de envios referencia por product_id.
          INSERT INTO products_migracao
            (id, title, price, original_price, image_url, image_path, description,
             original_url, affiliate_url, pix_price, coupon_url, store, source, created_at, updated_at)
          SELECT p.id, p.title, p.price, p.original_price, p.image_url, p.image_path, p.description,
                 ${URL_BASE}, p.affiliate_url, p.pix_price, p.coupon_url, p.store, p.source, p.created_at, p.updated_at
          FROM products p
          WHERE p.id = (
            SELECT MIN(p2.id) FROM products p2
            WHERE ${URL_BASE.replace(/original_url/g, 'p2.original_url')} = ${URL_BASE.replace(/original_url/g, 'p.original_url')}
          );

          DROP TABLE products;
          ALTER TABLE products_migracao RENAME TO products;

          CREATE INDEX IF NOT EXISTS idx_products_store ON products(store);
          CREATE INDEX IF NOT EXISTS idx_products_source ON products(source);
          CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);

          COMMIT;
        `)
        this.db.exec('PRAGMA foreign_keys = ON')
        const depois = (this.db.prepare('SELECT COUNT(*) c FROM products').get() as any).c
        log.info(`Migração: products reconstruída — ${antes} linha(s) viraram ${depois} (${antes - depois} duplicata(s) removida(s)), e o source agora aceita 'busca'`)
      }
    } catch (err) {
      log.error('Erro na migração de products (source/duplicatas):', err)
      try { this.db.exec('ROLLBACK') } catch { /* não havia transação aberta */ }
      try { this.db.exec('PRAGMA foreign_keys = ON') } catch { /* idem */ }
    }

    // Migração: intervalo da busca automática passa a ser em MINUTOS. Em horas
    // inteiras o mínimo possível era 1h, e para testar (ou para quem quer
    // acompanhar oferta relâmpago) isso é tempo demais. Converte o valor que já
    // estava salvo para não mudar o comportamento de quem já tinha configurado.
    try {
      const columns = this.db.prepare('PRAGMA table_info(config)').all() as any[]
      if (!columns.some((c) => c.name === 'auto_scrape_interval_minutes')) {
        this.db.exec('ALTER TABLE config ADD COLUMN auto_scrape_interval_minutes INTEGER DEFAULT 360')
        this.db.exec(`
          UPDATE config
             SET auto_scrape_interval_minutes = COALESCE(NULLIF(auto_scrape_interval_hours, 0), 6) * 60
        `)
        log.info('Migração: intervalo da busca automática convertido de horas para minutos')
      }
    } catch (err) {
      log.error('Erro na migração do intervalo em minutos:', err)
    }

    // Migração: nicho por grupo de destino. Antes existia um nicho único e
    // global, e todo produto capturado ia pra todos os grupos — quem tem
    // grupos de assuntos diferentes recebia tudo em todos.
    try {
      const columns = this.db.prepare('PRAGMA table_info(auto_send_targets)').all() as any[]
      if (!columns.some((c) => c.name === 'niche')) {
        this.db.exec('ALTER TABLE auto_send_targets ADD COLUMN niche TEXT')
        log.info('Migração: coluna niche adicionada à tabela auto_send_targets')
      }
    } catch (err) {
      log.error('Erro na migração do nicho por grupo:', err)
    }

    // Migração: credenciais da API oficial do Mercado Livre. A raspagem da
    // página do produto passou a ser barrada por uma página de verificação de
    // tráfego; a API não sofre isso.
    try {
      const columns = this.db.prepare("PRAGMA table_info(config)").all() as any[]
      if (!columns.some((c) => c.name === 'mercado_livre_client_id')) {
        this.db.exec('ALTER TABLE config ADD COLUMN mercado_livre_client_id TEXT')
        this.db.exec('ALTER TABLE config ADD COLUMN mercado_livre_client_secret TEXT')
        log.info('Migração: colunas mercado_livre_client_id/client_secret adicionadas à tabela config')
      }
    } catch (err) {
      log.error('Erro na migração das credenciais da API do Mercado Livre:', err)
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

  /**
   * Números do Dashboard, direto do banco. "Envios hoje" vem de `send_history`
   * (que já existia, com índice em `sent_at`, e ninguém consultava) e não da
   * fila em memória: a fila é esvaziada e não tem noção de data, então o card
   * mostrava qualquer coisa menos os envios do dia.
   */
  /**
   * Este produto já foi enviado para este grupo? Consulta o `send_history`, que
   * é gravado só quando o envio de fato aconteceu.
   *
   * É a última barreira contra anúncio repetido, e de propósito no ponto mais
   * baixo: a deduplicação por URL resolve o caso comum, mas não cobre o mesmo
   * produto chegando por dois caminhos (a busca automática acha, e alguém posta
   * o link no grupo monitorado), nem uma recaptura depois de o app reiniciar.
   * Aqui não importa como o produto chegou — se já foi para aquele grupo, não
   * vai de novo.
   */
  produtoJaEnviadoAoGrupo(platform: string, groupId: string, productId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM send_history WHERE platform = ? AND group_id = ? AND product_id = ? LIMIT 1')
      .get(platform, groupId, productId)
    return !!row
  }

  getDashboardStats(): {
    produtos: number
    enviosHoje: number
    gruposMonitorados: number
    capturados: number
    porLoja: { store: string; total: number }[]
  } {
    const um = (sql: string, ...p: any[]) => (this.db.prepare(sql).get(...p) as any).c as number
    return {
      produtos: um('SELECT COUNT(*) c FROM products'),
      // date('now','localtime') e não date('now'): sem isso o "hoje" seria o dia
      // em UTC, e das 21h em diante o contador zerava no meio da noite do usuário.
      enviosHoje: um("SELECT COUNT(*) c FROM send_history WHERE date(sent_at, 'localtime') = date('now', 'localtime')"),
      gruposMonitorados: um('SELECT COUNT(*) c FROM group_monitors WHERE monitored = 1'),
      capturados: um("SELECT COUNT(*) c FROM products WHERE source != 'manual'"),
      porLoja: this.db.prepare('SELECT store, COUNT(*) total FROM products GROUP BY store ORDER BY total DESC').all() as any[],
    }
  }

  productExistsByUrl(url: string): boolean {
    // Compara pela URL base, mas sem juntar produtos diferentes por engano:
    // um `LIKE base || '%'` solto casaria MLB66637233 com MLB666372339. Por
    // isso os curingas exigem o `?` ou o `#` logo depois da base.
    const base = urlBaseDoProduto(url)
    const row = this.db
      .prepare('SELECT 1 FROM products WHERE original_url = ? OR original_url LIKE ? OR original_url LIKE ?')
      .get(base, base + '?%', base + '#%')
    return !!row
  }

  createProduct(product: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Product | null {
    if (this.productExistsByUrl(product.original_url)) {
      log.warn(`Produto ignorado - URL já existe no banco: ${product.original_url}`)
      this.addLog({
        type: 'warning',
        // `source` inclui 'manual', que NÃO é um valor aceito na coluna
        // platform da tabela de logs ('whatsapp','telegram','system'). Passar
        // ele direto fazia o CHECK do SQLite derrubar a operação inteira, e o
        // usuário via um erro de banco ao tentar cadastrar um produto que já
        // existia — em vez de um aviso de duplicado.
        platform: product.source === 'whatsapp' || product.source === 'telegram' ? product.source : 'system',
        message: 'Produto duplicado ignorado',
        details: `URL já capturada anteriormente: ${product.original_url}`,
      })
      return null
    }

    const stmt = this.db.prepare(`
      INSERT INTO products (title, price, original_price, image_url, image_path, description, original_url, affiliate_url, pix_price, coupon_url, store, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      product.title,
      product.price,
      product.original_price ?? null,
      product.image_url ?? null,
      product.image_path ?? null,
      product.description ?? null,
      // Grava já sem o rastreio: o produto é o mesmo, e assim as comparações
      // futuras batem direto, sem depender dos curingas acima.
      urlBaseDoProduto(product.original_url),
      product.affiliate_url ?? null,
      product.pix_price ?? null,
      product.coupon_url ?? null,
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
        auto_scrape_interval_minutes: 360,
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
      INSERT INTO auto_send_targets (platform, group_id, group_name, enabled, niche)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, group_id) DO UPDATE SET
        group_name = excluded.group_name,
        enabled = excluded.enabled,
        niche = excluded.niche
    `)
    stmt.run(target.platform, target.group_id, target.group_name, target.enabled ? 1 : 0, target.niche ?? null)
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

  getEnabledAutoSendTargets(platform?: 'whatsapp' | 'telegram'): AutoSendTarget[] {
    if (platform) {
      return this.db.prepare('SELECT * FROM auto_send_targets WHERE platform = ? AND enabled = 1').all(platform) as AutoSendTarget[]
    }
    // Sem plataforma: usado pra juntar os nichos de todos os grupos e decidir
    // o que a busca automática deve procurar.
    return this.db.prepare('SELECT * FROM auto_send_targets WHERE enabled = 1').all() as AutoSendTarget[]
  }

  // Retorna o texto do grupo já resolvido: se o grupo aponta pra um template da
  // biblioteca (template_id), usa o texto de lá; senão cai no template_text legado
  // (grupos configurados antes da biblioteca existir).
  getAdTemplate(platform: string, groupId: string): AdTemplate | undefined {
    // NULLIF nos dois lados: texto vazio tem que valer como "sem template",
    // senão o envio formataria a mensagem com uma string vazia em vez de cair
    // no template padrão — o anúncio sairia em branco.
    return this.db.prepare(`
      SELECT at.id, at.platform, at.group_id, at.template_id,
             COALESCE(NULLIF(mt.template_text, ''), NULLIF(at.template_text, '')) as template_text
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
    if (templateId !== null && !this.getMessageTemplateById(templateId)) {
      throw new Error(`Template ${templateId} não existe mais — recarregue a lista de templates`)
    }

    // UPDATE e, só se não achou linha, INSERT. Antes isso era um único INSERT
    // com ON CONFLICT(platform, group_id), que depende de existir índice único
    // nessa dupla: em banco criado por versão antiga do app, sem esse índice, o
    // SQLite recusa a cláusula inteira e a associação nunca era gravada — o
    // dropdown da tela voltava sozinho pro valor anterior, sem explicação.
    const updated = this.db.prepare(`
      UPDATE ad_templates
         SET template_id = ?, template_text = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE platform = ? AND group_id = ?
    `).run(templateId, platform, groupId)

    if (updated.changes === 0) {
      this.db.prepare(`
        INSERT INTO ad_templates (platform, group_id, template_id, template_text)
        VALUES (?, ?, ?, NULL)
      `).run(platform, groupId, templateId)
    }
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
