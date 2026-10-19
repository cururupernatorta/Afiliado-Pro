import { BrowserWindow, Notification } from 'electron'

export let mainWindow: BrowserWindow | null = null

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
}

export function sendToRenderer(channel: string, ...args: any[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

// main.ts registra aqui como trazer a janela de volta (ela pode estar
// escondida na bandeja). Fica num registro, e não num import de main.ts, para
// não criar dependência circular.
let mostrarJanela: (() => void) | null = null

export function definirMostrarJanela(fn: () => void): void {
  mostrarJanela = fn
}

// Notificação sem referência viva é recolhida pela memória, e o clique nela
// passa a não fazer nada. Fica aqui até ser fechada ou clicada.
const notificacoesVivas = new Set<Notification>()

/**
 * Notificação do Windows, para o que exige ação e não pode esperar o usuário
 * abrir o app por acaso.
 *
 * Existe por um relato real: o WhatsApp de um testador foi desconectado e o app
 * só registrou isso na aba Logs e numa bolinha da barra lateral. Com o app
 * minimizado na bandeja o dia todo, ninguém viu — o testador só percebeu que
 * "parou de pegar". Clicar na notificação abre o app já na tela certa.
 */
export function notificarUsuario(titulo: string, corpo: string, rota?: string): void {
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: titulo, body: corpo })
    notificacoesVivas.add(n)
    n.on('click', () => {
      notificacoesVivas.delete(n)
      mostrarJanela?.()
      if (!rota) return
      // Se a janela teve de ser recriada, a interface ainda está carregando e
      // perderia a ordem de navegação: espera carregar e dá um instante para a
      // interface registrar quem escuta.
      const janela = mainWindow
      if (janela && !janela.isDestroyed() && janela.webContents.isLoading()) {
        janela.webContents.once('did-finish-load', () => {
          setTimeout(() => sendToRenderer('app:navegar', rota), 800)
        })
      } else {
        sendToRenderer('app:navegar', rota)
      }
    })
    n.on('close', () => notificacoesVivas.delete(n))
    n.show()
  } catch {
    // Notificação é um extra: falhar aqui não pode derrubar quem chamou.
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
