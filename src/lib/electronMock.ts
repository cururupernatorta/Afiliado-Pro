// Mock de window.electronAPI usado apenas quando o app roda fora do Electron
// (ex.: `vite` no navegador, para inspecionar visualmente o redesign). O build
// real do Electron sempre expõe window.electronAPI via preload, então este
// mock nunca roda em produção.
function noop() {
  return () => {}
}

export function installElectronMockIfNeeded() {
  if (typeof window === 'undefined' || (window as any).electronAPI) return

  ;(window as any).electronAPI = {
    whatsappConnect: async () => {},
    whatsappDisconnect: async () => {},
    whatsappGetStatus: async () => 'disconnected',
    whatsappGetGroups: async () => [],
    whatsappToggleMonitor: async () => {},
    whatsappSendProducts: async () => {},
    whatsappGetQrCode: async () => null,

    telegramConnect: async () => {},
    telegramDisconnect: async () => {},
    telegramGetStatus: async () => 'disconnected',
    telegramGetGroups: async () => [],
    telegramToggleMonitor: async () => {},
    telegramSendProducts: async () => {},
    telegramSendCode: async () => {},

    productGetAll: async () => [],
    productGetById: async () => null,
    productCreate: async (data: any) => ({ id: Date.now(), created_at: new Date().toISOString(), ...data }),
    productUpdate: async () => {},
    productDelete: async () => {},
    productScrape: async () => ({ title: 'Produto de exemplo', price: 99.9, store: 'shopee', original_url: '' }),

    configGet: async () => ({}),
    configSave: async () => {},

    queueGetJobs: async () => [],
    queuePause: async () => {},
    queueResume: async () => {},
    queueClear: async () => {},

    logsGet: async () => [],

    autoSendGetTargets: async () => [],
    autoSendSaveTarget: async () => {},
    autoSendRemoveTarget: async () => {},
    autoSendToggleTarget: async () => {},

    adTemplateGet: async () => null,
    adTemplateSave: async () => {},

    updateCheck: async () => {},
    updateInstall: async () => {},
    onUpdateChecking: noop,
    onUpdateAvailable: noop,
    onUpdateNotAvailable: noop,
    onUpdateProgress: noop,
    onUpdateDownloaded: noop,
    onUpdateError: noop,

    onWhatsAppQrCode: noop,
    onWhatsAppStatus: noop,
    onTelegramCode: noop,
    onTelegramStatus: noop,
    onQueueUpdate: noop,
    onLogEntry: noop,
  }
}
