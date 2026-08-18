import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  whatsappConnect: () => Promise<void>
  whatsappDisconnect: () => Promise<void>
  whatsappGetStatus: () => Promise<any>
  whatsappGetGroups: () => Promise<any[]>
  whatsappToggleMonitor: (groupId: string, enabled: boolean) => Promise<void>
  whatsappSendProducts: (groupIds: string[], productIds: number[]) => Promise<void>
  whatsappGetQrCode: () => Promise<string | null>

  telegramConnect: (phoneNumber: string) => Promise<void>
  telegramDisconnect: () => Promise<void>
  telegramGetStatus: () => Promise<any>
  telegramGetGroups: () => Promise<any[]>
  telegramToggleMonitor: (groupId: string, enabled: boolean) => Promise<void>
  telegramSendProducts: (groupIds: string[], productIds: number[]) => Promise<void>
  telegramSendCode: (code: string) => Promise<void>

  productGetAll: () => Promise<any[]>
  productGetById: (id: number) => Promise<any>
  productCreate: (data: any) => Promise<any>
  productUpdate: (id: number, data: any) => Promise<void>
  productDelete: (id: number) => Promise<void>
  productScrape: (url: string) => Promise<any>

  configGet: () => Promise<any>
  configSave: (config: any) => Promise<void>

  queueGetJobs: () => Promise<any[]>
  queuePause: () => Promise<void>
  queueResume: () => Promise<void>
  queueClear: () => Promise<void>

  logsGet: (limit: number, offset: number) => Promise<any[]>

  autoSendGetTargets: (platform?: string) => Promise<any[]>
  autoSendSaveTarget: (target: any) => Promise<void>
  autoSendRemoveTarget: (platform: string, groupId: string) => Promise<void>
  autoSendToggleTarget: (platform: string, groupId: string, enabled: boolean) => Promise<void>

  adTemplateGet: (platform: string, groupId: string) => Promise<any>
  adTemplateSave: (template: any) => Promise<void>

  // Auto Update
  updateCheck: () => Promise<void>
  updateInstall: () => Promise<void>
  onUpdateChecking: (callback: () => void) => () => void
  onUpdateAvailable: (callback: (info: any) => void) => () => void
  onUpdateNotAvailable: (callback: () => void) => () => void
  onUpdateProgress: (callback: (progress: any) => void) => () => void
  onUpdateDownloaded: (callback: (info: any) => void) => () => void
  onUpdateError: (callback: (message: string) => void) => () => void

  onWhatsAppQrCode: (callback: (qr: string) => void) => () => void
  onWhatsAppStatus: (callback: (status: string) => void) => () => void
  onTelegramCode: (callback: () => void) => () => void
  onTelegramStatus: (callback: (status: string) => void) => () => void
  onQueueUpdate: (callback: (jobs: any[]) => void) => () => void
  onLogEntry: (callback: (log: any) => void) => () => void
}

const api: ElectronAPI = {
  whatsappConnect: () => ipcRenderer.invoke('whatsapp:connect'),
  whatsappDisconnect: () => ipcRenderer.invoke('whatsapp:disconnect'),
  whatsappGetStatus: () => ipcRenderer.invoke('whatsapp:getStatus'),
  whatsappGetGroups: () => ipcRenderer.invoke('whatsapp:getGroups'),
  whatsappToggleMonitor: (groupId, enabled) => ipcRenderer.invoke('whatsapp:toggleMonitor', groupId, enabled),
  whatsappSendProducts: (groupIds, productIds) => ipcRenderer.invoke('whatsapp:sendProducts', groupIds, productIds),
  whatsappGetQrCode: () => ipcRenderer.invoke('whatsapp:getQrCode'),

  telegramConnect: (phoneNumber) => ipcRenderer.invoke('telegram:connect', phoneNumber),
  telegramDisconnect: () => ipcRenderer.invoke('telegram:disconnect'),
  telegramGetStatus: () => ipcRenderer.invoke('telegram:getStatus'),
  telegramGetGroups: () => ipcRenderer.invoke('telegram:getGroups'),
  telegramToggleMonitor: (groupId, enabled) => ipcRenderer.invoke('telegram:toggleMonitor', groupId, enabled),
  telegramSendProducts: (groupIds, productIds) => ipcRenderer.invoke('telegram:sendProducts', groupIds, productIds),
  telegramSendCode: (code) => ipcRenderer.invoke('telegram:sendCode', code),

  productGetAll: () => ipcRenderer.invoke('product:getAll'),
  productGetById: (id) => ipcRenderer.invoke('product:getById', id),
  productCreate: (data) => ipcRenderer.invoke('product:create', data),
  productUpdate: (id, data) => ipcRenderer.invoke('product:update', id, data),
  productDelete: (id) => ipcRenderer.invoke('product:delete', id),
  productScrape: (url) => ipcRenderer.invoke('product:scrape', url),

  configGet: () => ipcRenderer.invoke('config:get'),
  configSave: (config) => ipcRenderer.invoke('config:save', config),

  queueGetJobs: () => ipcRenderer.invoke('queue:getJobs'),
  queuePause: () => ipcRenderer.invoke('queue:pause'),
  queueResume: () => ipcRenderer.invoke('queue:resume'),
  queueClear: () => ipcRenderer.invoke('queue:clear'),

  logsGet: (limit, offset) => ipcRenderer.invoke('logs:get', limit, offset),

  autoSendGetTargets: (platform) => ipcRenderer.invoke('autoSend:getTargets', platform),
  autoSendSaveTarget: (target) => ipcRenderer.invoke('autoSend:saveTarget', target),
  autoSendRemoveTarget: (platform, groupId) => ipcRenderer.invoke('autoSend:removeTarget', platform, groupId),
  autoSendToggleTarget: (platform, groupId, enabled) => ipcRenderer.invoke('autoSend:toggleTarget', platform, groupId, enabled),

  adTemplateGet: (platform, groupId) => ipcRenderer.invoke('adTemplate:get', platform, groupId),
  adTemplateSave: (template) => ipcRenderer.invoke('adTemplate:save', template),

  // Auto Update
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateChecking: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('update:checking', handler)
    return () => ipcRenderer.removeListener('update:checking', handler)
  },
  onUpdateAvailable: (callback) => {
    const handler = (_: any, info: any) => callback(info)
    ipcRenderer.on('update:available', handler)
    return () => ipcRenderer.removeListener('update:available', handler)
  },
  onUpdateNotAvailable: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('update:not-available', handler)
    return () => ipcRenderer.removeListener('update:not-available', handler)
  },
  onUpdateProgress: (callback) => {
    const handler = (_: any, progress: any) => callback(progress)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_: any, info: any) => callback(info)
    ipcRenderer.on('update:downloaded', handler)
    return () => ipcRenderer.removeListener('update:downloaded', handler)
  },
  onUpdateError: (callback) => {
    const handler = (_: any, message: string) => callback(message)
    ipcRenderer.on('update:error', handler)
    return () => ipcRenderer.removeListener('update:error', handler)
  },

  onWhatsAppQrCode: (callback) => {
    const handler = (_: any, qr: string) => callback(qr)
    ipcRenderer.on('whatsapp:qr-code', handler)
    return () => ipcRenderer.removeListener('whatsapp:qr-code', handler)
  },
  onWhatsAppStatus: (callback) => {
    const handler = (_: any, status: string) => callback(status)
    ipcRenderer.on('whatsapp:status', handler)
    return () => ipcRenderer.removeListener('whatsapp:status', handler)
  },
  onTelegramCode: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('telegram:code-required', handler)
    return () => ipcRenderer.removeListener('telegram:code-required', handler)
  },
  onTelegramStatus: (callback) => {
    const handler = (_: any, status: string) => callback(status)
    ipcRenderer.on('telegram:status', handler)
    return () => ipcRenderer.removeListener('telegram:status', handler)
  },
  onQueueUpdate: (callback) => {
    const handler = (_: any, jobs: any[]) => callback(jobs)
    ipcRenderer.on('queue:update', handler)
    return () => ipcRenderer.removeListener('queue:update', handler)
  },
  onLogEntry: (callback) => {
    const handler = (_: any, log: any) => callback(log)
    ipcRenderer.on('log:entry', handler)
    return () => ipcRenderer.removeListener('log:entry', handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
