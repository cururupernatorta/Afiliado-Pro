export interface ElectronAPI {
  // WhatsApp
  whatsappConnect: () => Promise<void>
  whatsappDisconnect: () => Promise<void>
  whatsappGetStatus: () => Promise<any>
  whatsappGetGroups: () => Promise<any[]>
  whatsappToggleMonitor: (groupId: string, groupName: string, enabled: boolean) => Promise<void>
  whatsappSendProducts: (groupIds: string[], productIds: number[], extra?: { description?: string; coupon?: string; imageUrl?: string; templateText?: string }) => Promise<void>
  whatsappGetQrCode: () => Promise<string | null>
  whatsappAddChannel: (inviteLinkOrCode: string) => Promise<{ id: string; name: string }>

  groupGetSaved: (platform: 'whatsapp' | 'telegram') => Promise<any[]>

  // Telegram
  telegramConnect: (phoneNumber: string) => Promise<void>
  telegramDisconnect: () => Promise<void>
  telegramGetStatus: () => Promise<any>
  telegramGetGroups: () => Promise<any[]>
  telegramToggleMonitor: (groupId: string, groupName: string, enabled: boolean) => Promise<void>
  telegramSendProducts: (groupIds: string[], productIds: number[], extra?: { description?: string; coupon?: string; imageUrl?: string; templateText?: string }) => Promise<void>
  telegramSendCode: (code: string) => Promise<void>

  // Mercado Livre (sessao para gerar o link com vitrine)
  mercadoLivreGetStatus: () => Promise<'connected' | 'disconnected'>
  mercadoLivreLogin: () => Promise<'connected' | 'cancelled'>
  mercadoLivreLogout: () => Promise<void>
  onMercadoLivreStatus: (callback: (status: string) => void) => () => void

  // Produtos
  productGetAll: () => Promise<any[]>
  statsGet: () => Promise<{
    produtos: number
    enviosHoje: number
    gruposMonitorados: number
    capturados: number
    porLoja: { store: string; total: number }[]
  }>
  productGetById: (id: number) => Promise<any>
  productCreate: (data: any) => Promise<any>
  productUpdate: (id: number, data: any) => Promise<void>
  productDelete: (id: number) => Promise<void>
  productsDeleteMany: (ids: number[]) => Promise<number>
  productScrape: (url: string) => Promise<any>
  scrapeRunNow: () => Promise<{ ok: boolean; novas?: number; erro?: string }>
  whatsappReceptionNow: () => Promise<{ mensagens: number; deGrupoMonitorado: number; proprias: number; jaVistas: number; naoDecifradas: number; comTexto: number; comLink: number; flushesForcados: number; monitorados: number; porChat: { jid: string; n: number }[] }>
  whatsappSweepHistory: (horas: number) => Promise<{ ok: boolean; erro?: string; processadas: number; pedidos: number; grupos: number; semAncora?: boolean }>

  // Config
  configGet: () => Promise<any>
  configSave: (config: any) => Promise<void>

  // Queue
  queueGetJobs: () => Promise<any[]>
  queuePause: () => Promise<void>
  queueResume: () => Promise<void>
  queueClear: () => Promise<void>

  // Logs
  logsGet: (limit: number, offset: number) => Promise<any[]>

  // Auto Send
  autoSendGetTargets: (platform?: string) => Promise<any[]>
  autoSendSaveTarget: (target: any) => Promise<void>
  autoSendRemoveTarget: (platform: string, groupId: string) => Promise<void>
  autoSendToggleTarget: (platform: string, groupId: string, enabled: boolean) => Promise<void>

  // Ad Templates
  adTemplateGet: (platform: string, groupId: string) => Promise<any>
  adTemplateAssign: (platform: string, groupId: string, templateId: number | null) => Promise<void>

  messageTemplateList: () => Promise<any[]>
  messageTemplateCreate: (template: { name: string; template_text: string }) => Promise<any>
  messageTemplateUpdate: (id: number, template: { name?: string; template_text?: string }) => Promise<void>
  messageTemplateDelete: (id: number) => Promise<void>
  messageTemplateGetDefault: () => Promise<string>
  previewMessage: (productId: number, templateText: string, extra?: { coupon?: string; description?: string }) => Promise<string>

  // Auto Update
  updateCheck: () => Promise<void>
  updateInstall: () => Promise<void>
  getAppVersion: () => Promise<string>
  onUpdateChecking: (callback: () => void) => () => void
  onUpdateAvailable: (callback: (info: any) => void) => () => void
  onUpdateNotAvailable: (callback: () => void) => () => void
  onUpdateProgress: (callback: (progress: any) => void) => () => void
  onUpdateDownloaded: (callback: (info: any) => void) => () => void
  onUpdateError: (callback: (message: string) => void) => () => void

  // Eventos
  onWhatsAppQrCode: (callback: (qr: string) => void) => () => void
  onWhatsAppStatus: (callback: (status: string) => void) => () => void
  onTelegramCode: (callback: () => void) => () => void
  onTelegramStatus: (callback: (status: string) => void) => () => void
  onQueueUpdate: (callback: (jobs: any[]) => void) => () => void
  onLogEntry: (callback: (log: any) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
