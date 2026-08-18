import { create } from 'zustand'

export interface Product {
  id: number
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
  created_at: string
  updated_at: string
}

export interface Group {
  id: string
  name: string
  platform: 'whatsapp' | 'telegram'
  participants?: number
  monitored: boolean
}

export interface AutoSendTarget {
  id?: number
  platform: 'whatsapp' | 'telegram'
  group_id: string
  group_name: string
  enabled: boolean
}

export interface AdTemplate {
  id?: number
  platform: 'whatsapp' | 'telegram'
  group_id: string
  template_text: string
}

export interface Config {
  shopee_app_id?: string
  shopee_app_secret?: string
  mercado_livre_affiliate_id?: string
  amazon_tag?: string
  aliexpress_app_key?: string
  aliexpress_app_secret?: string
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

export interface QueueJob {
  id: string
  platform: 'whatsapp' | 'telegram'
  groupId: string
  productId: number
  productTitle: string
  status: 'waiting' | 'active' | 'completed' | 'failed'
  created_at: string
}

export interface LogEntry {
  id: number
  type: 'info' | 'warning' | 'error' | 'success'
  platform?: 'whatsapp' | 'telegram' | 'system'
  message: string
  details?: string
  created_at: string
}

interface AppState {
  products: Product[]
  setProducts: (products: Product[]) => void
  addProduct: (product: Product) => void
  updateProduct: (id: number, product: Partial<Product>) => void
  removeProduct: (id: number) => void

  groups: Group[]
  setGroups: (groups: Group[]) => void
  updateGroup: (id: string, updates: Partial<Group>) => void

  autoSendTargets: AutoSendTarget[]
  setAutoSendTargets: (targets: AutoSendTarget[]) => void
  addAutoSendTarget: (target: AutoSendTarget) => void
  removeAutoSendTarget: (platform: string, groupId: string) => void
  updateAutoSendTarget: (platform: string, groupId: string, updates: Partial<AutoSendTarget>) => void

  adTemplates: Record<string, AdTemplate>
  setAdTemplate: (key: string, template: AdTemplate) => void

  config: Config | null
  setConfig: (config: Config) => void

  whatsappStatus: 'disconnected' | 'connecting' | 'connected' | 'code_required' | 'error'
  setWhatsappStatus: (status: AppState['whatsappStatus']) => void
  whatsappQrCode: string | null
  setWhatsappQrCode: (qr: string | null) => void

  telegramStatus: 'disconnected' | 'connecting' | 'connected' | 'code_required' | 'error'
  setTelegramStatus: (status: AppState['telegramStatus']) => void

  queueJobs: QueueJob[]
  setQueueJobs: (jobs: QueueJob[]) => void

  logs: LogEntry[]
  setLogs: (logs: LogEntry[]) => void
  addLog: (log: LogEntry) => void

  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  currentPage: string
  setCurrentPage: (page: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  products: [],
  setProducts: (products) => set({ products }),
  addProduct: (product) => set((state) => ({ products: [product, ...state.products] })),
  updateProduct: (id, product) =>
    set((state) => ({
      products: state.products.map((p) => (p.id === id ? { ...p, ...product } : p)),
    })),
  removeProduct: (id) =>
    set((state) => ({
      products: state.products.filter((p) => p.id !== id),
    })),

  groups: [],
  setGroups: (groups) => set({ groups }),
  updateGroup: (id, updates) =>
    set((state) => ({
      groups: state.groups.map((g) => (g.id === id ? { ...g, ...updates } : g)),
    })),

  autoSendTargets: [],
  setAutoSendTargets: (targets) => set({ autoSendTargets: targets }),
  addAutoSendTarget: (target) =>
    set((state) => ({
      autoSendTargets: [...state.autoSendTargets, target],
    })),
  removeAutoSendTarget: (platform, groupId) =>
    set((state) => ({
      autoSendTargets: state.autoSendTargets.filter(
        (t) => !(t.platform === platform && t.group_id === groupId)
      ),
    })),
  updateAutoSendTarget: (platform, groupId, updates) =>
    set((state) => ({
      autoSendTargets: state.autoSendTargets.map((t) =>
        t.platform === platform && t.group_id === groupId ? { ...t, ...updates } : t
      ),
    })),

  adTemplates: {},
  setAdTemplate: (key, template) =>
    set((state) => ({
      adTemplates: { ...state.adTemplates, [key]: template },
    })),

  config: null,
  setConfig: (config) => set({ config }),

  whatsappStatus: 'disconnected',
  setWhatsappStatus: (status) => set({ whatsappStatus: status }),
  whatsappQrCode: null,
  setWhatsappQrCode: (qr) => set({ whatsappQrCode: qr }),

  telegramStatus: 'disconnected',
  setTelegramStatus: (status) => set({ telegramStatus: status }),

  queueJobs: [],
  setQueueJobs: (jobs) => set({ queueJobs: jobs }),

  logs: [],
  setLogs: (logs) => set({ logs }),
  addLog: (log) => set((state) => ({ logs: [log, ...state.logs].slice(0, 500) })),

  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  currentPage: 'dashboard',
  setCurrentPage: (page) => set({ currentPage: page }),
}))
