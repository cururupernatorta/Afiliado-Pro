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
    whatsappGetStatus: async () => ({ status: 'disconnected', qrCode: null }),
    whatsappGetGroups: async () => [],
    whatsappToggleMonitor: async () => {},
    whatsappSendProducts: async () => {},
    whatsappGetQrCode: async () => null,
    whatsappAddChannel: async () => ({ id: 'mock@newsletter', name: 'Canal de teste' }),

    groupGetSaved: async () => [],

    telegramConnect: async () => {},
    telegramDisconnect: async () => {},
    telegramGetStatus: async () => ({ status: 'disconnected' }),
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
    mercadoLivreTestCredentials: async () => ({
      ok: false,
      title: 'Teste indisponível fora do Electron',
      detail: 'Rode o app pelo Electron para testar as credenciais de verdade.',
    }),
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener')
    },

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
    adTemplateAssign: async () => {},

    messageTemplateList: async () => [],
    messageTemplateCreate: async (template: any) => ({ id: Date.now(), created_at: new Date().toISOString(), ...template }),
    messageTemplateUpdate: async () => {},
    messageTemplateDelete: async () => {},
    messageTemplateGetDefault: async () => '*{title}*\n\n💰 {price_line}\n\n📝 {description}\n\n🔗 {affiliate_url}\n\n⚡ Corra antes que acabe!\n\n👥 Entre no nosso grupo de ofertas: {group_link}',
    previewMessage: async () => '',

    updateCheck: async () => {},
    updateInstall: async () => {},
    getAppVersion: async () => '0.0.0-dev',
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
