import { BrowserWindow } from 'electron'
import log from 'electron-log'

interface RenderOptions {
  /** Tempo de espera (ms) após o carregamento inicial, pra dar tempo do JS da página rodar. Default: 3000 */
  waitMs?: number
  /** Timeout total da operação (ms), incluindo carregamento + espera. Default: 25000 */
  timeoutMs?: number
  /** User-Agent customizado (ex: mobile) */
  userAgent?: string
}

/**
 * Renderiza uma URL usando o Chromium embutido do Electron (janela invisível) e devolve o
 * HTML já processado pelo JavaScript da página — diferente do axios+cheerio, que só vê o
 * HTML estático que o servidor manda antes de qualquer script rodar.
 *
 * Usar com moderação: cada chamada abre um processo de renderização completo (mais lento e
 * mais pesado que uma request HTTP simples). Prefira usar isso só como fallback, quando o
 * scraping estático falhar.
 */
export async function renderPageHtml(url: string, options: RenderOptions = {}): Promise<string> {
  const { waitMs = 3000, timeoutMs = 25000, userAgent } = options

  let win: BrowserWindow | null = null

  const renderPromise = (async (): Promise<string> => {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        images: false, // não carrega imagens - só queremos o HTML/DOM, isso acelera bastante
      },
    })

    // Bloqueia popups/novas janelas que o site tente abrir (ex: banners, redirecionamentos de app)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    if (userAgent) {
      win.webContents.setUserAgent(userAgent)
    }

    await win.loadURL(url, userAgent ? { userAgent } : undefined)

    // Dá um tempo pro JS da SPA terminar de buscar e renderizar os dados do produto
    await new Promise((resolve) => setTimeout(resolve, waitMs))

    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
    return html as string
  })()

  const timeoutPromise = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error('Timeout ao renderizar página com browser headless')), timeoutMs)
  })

  try {
    return await Promise.race([renderPromise, timeoutPromise])
  } catch (error) {
    log.warn(`Falha ao renderizar ${url} com headless browser:`, (error as Error).message)
    throw error
  } finally {
    if (win && !(win as BrowserWindow).isDestroyed()) {
      ;(win as BrowserWindow).destroy()
    }
  }
}
