import { BrowserWindow } from 'electron'

export let mainWindow: BrowserWindow | null = null

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
}

export function sendToRenderer(channel: string, ...args: any[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

/**
 * Falha por conexão indisponível no momento — WhatsApp ou Telegram fora do ar.
 * É diferente de um erro de verdade: o envio não deu errado, ele só não pôde
 * acontecer AGORA. A fila usa isso pra reagendar em vez de descartar; com as
 * quedas de 30-90 min que os testadores enfrentam, descartar significava perder
 * a oferta em silêncio (ela era encontrada, virava anúncio, e sumia).
 */
export class ErroDeConexao extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ErroDeConexao'
  }
}
