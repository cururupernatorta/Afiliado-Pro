export interface ElectronAPI {
  // WhatsApp
  whatsappConnect: () => Promise<void>
  whatsappDisconnect: () => Promise<void>
  whatsappGetStatus: () => Promise<any>
  whatsappGetGroups: () => Promise<any[]>
  whatsappToggleMonitor: (groupId: string, enabled: boolean) => Promise<void>
  whatsappSendProducts: (groupIds: string[], productIds: number[], extra?: { description?: string; coupon?: string; imageUrl?: string; templateText?: string }) => Promise<void>
  whatsappGetQrCode: () => Promise<string | null>

  // Telegram
  telegramConnect: (phoneNumber: string) => Promise<void>
  telegramDisconnect: () => Promise<void>
  telegramGetStatus: () => Promise<any>
  telegramGetGroups: () => Promise<any[]>
  telegramToggleMonitor: (groupId: string, enabled: boolean) => Promise<void>
  telegramSendProducts: (groupIds: string[], productIds: number[], extra?: { description?: string; coupon?: string; imageUrl?: string; templateText?: string }) => Promise<void>
  telegramSendCode: (code: string) => Promise<void>

  // Produtos
  productGetAll: () => Promise<any[]>
  productGetById: (id: number) => Promise<any>
  productCreate: (data: any) => Promise<any>
  productUpdate: (id: number, data: any) => Promise<void>
  productDelete: (id: number) => Promise<void>
  productScrape: (url: string) => Promise<any>

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
