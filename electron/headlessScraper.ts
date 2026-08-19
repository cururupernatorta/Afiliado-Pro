import { BrowserWindow } from 'electron'
import log from 'electron-log'

interface RenderOptions {
  /**
   * Tempo de espera (ms) após o carregamento inicial. Default: 3000.
   * Sem `readyPattern`, é uma espera fixa. Com `readyPattern`, vira o teto
   * máximo de um polling que sai assim que o padrão aparecer no HTML —
   * útil pra páginas 100% client-side-rendered (como o AliExpress passou
   * a ser), que às vezes terminam de buscar os dados do produto bem depois
   * do "carregamento" inicial da página.
   */
  waitMs?: number
  /** Timeout total da operação (ms), incluindo carregamento + espera. Default: 25000 */
  timeoutMs?: number
  /** User-Agent customizado (ex: mobile) */
  userAgent?: string
  /** Se informado, faz polling do HTML até esse padrão aparecer (ou até `waitMs` esgotar) */
  readyPattern?: RegExp
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
  const { waitMs = 3000, timeoutMs = 25000, userAgent, readyPattern } = options

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

    let html = ''
    if (readyPattern) {
      // Faz polling em vez de esperar um tempo fixo: sai assim que o padrão aparecer,
      // ou quando o teto de waitMs for atingido (o que vier primeiro).
      const deadline = Date.now() + waitMs
      while (true) {
        html = (await win.webContents.executeJavaScript('document.documentElement.outerHTML')) as string
        if (readyPattern.test(html) || Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } else {
      // Dá um tempo pro JS da SPA terminar de buscar e renderizar os dados do produto
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      html = (await win.webContents.executeJavaScript('document.documentElement.outerHTML')) as string
    }

    return html
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
