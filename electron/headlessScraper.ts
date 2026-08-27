import { BrowserWindow, session } from 'electron'
import log from 'electron-log'

// Quantas sessões descartáveis distintas ficam vivas ao mesmo tempo — ver
// comentário sobre vazamento de memória em `renderPageHtml`.
const PARTITION_POOL_SIZE = 8

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
  /**
   * Partição de sessão a usar em vez de uma descartável. Serve pra raspar com
   * uma sessão logada de verdade (ex: a do Mercado Livre), que sites com
   * anti-bot tratam muito melhor que uma sessão anônima e sem histórico.
   * IMPORTANTE: quando informada, a sessão NÃO é limpa no final — limpar
   * apagaria o login que o usuário fez à mão.
   */
  partition?: string
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
  const { waitMs = 3000, timeoutMs = 25000, userAgent, readyPattern, partition } = options

  let win: BrowserWindow | null = null
  // Partição descartável (não prefixada com "persist:") em vez da sessão padrão do
  // Electron, que é a MESMA sessão compartilhada por toda a janela principal do app.
  // Sem isso, cookies e sinais de fingerprint de raspagens anteriores se acumulam
  // numa sessão só ao longo do uso do app, e sites com detecção de bot (AliExpress)
  // podem ir degradando as respostas dessa sessão específica com o tempo, mesmo
  // quando o mesmo request funcionaria normalmente numa sessão limpa.
  // Roda num pool fixo de nomes (em vez de um UUID novo a cada chamada) porque o
  // Electron nunca libera o objeto Session de uma partição depois de criada — um
  // nome novo por chamada vazaria memória lentamente num bot que roda dias a fio.
  // clearStorageData() abaixo já limpa cookies/cache antes de cada uso do pool.
  const partitionName = partition ?? `scrape-${Math.floor(Math.random() * PARTITION_POOL_SIZE)}`
  const isPersistentSession = !!partition

  const renderPromise = (async (): Promise<string> => {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        images: false, // não carrega imagens - só queremos o HTML/DOM, isso acelera bastante
        partition: partitionName,
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
    // Só limpa sessão descartável: numa partição persistente (login real do
    // usuário) isso apagaria os cookies da conta dele.
    if (!isPersistentSession) {
      try {
        await session.fromPartition(partitionName).clearStorageData()
      } catch (err) {
        log.warn('Erro ao limpar sessão descartável do headless browser:', err)
      }
    }
  }
}
