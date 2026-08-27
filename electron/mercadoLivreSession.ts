import { BrowserWindow, clipboard, session } from 'electron'
import log from 'electron-log'
import { DatabaseManager } from './database'
import { sendToRenderer } from './utils'

// "persist:" faz o Electron gravar cookies dessa partição em disco, dentro de
// userData/Partitions — o mesmo diretório raiz onde a sessão do WhatsApp
// (electron/whatsapp.ts, authPath) já fica salva e comprovadamente sobrevive
// a reinício da máquina e a update do app (o instalador NSIS não apaga
// userData). Não usar "persist:" (como o headlessScraper.ts faz de propósito,
// pra sessões descartáveis) faria login cair a cada reinício do app.
const PARTITION = 'persist:mercadolivre-afiliados'
const AFFILIATE_HOME_URL = 'https://www.mercadolivre.com.br/afiliados'

// UA de navegador normal: sem isso o Electron anuncia "Electron/3x" numa
// sessão logada de afiliado, o que é o sinal mais barato de automação que dá
// pra evitar. Mesmo motivo do userAgent no headlessScraper.ts.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const NAV_TIMEOUT_MS = 25000
const LINK_POLL_MS = 8000

// Link de afiliado de verdade (confirmado seguindo um link real do Alan) é ou
// um encurtador meli.la, ou uma página /social/ COM token de atribuição. Um
// /social/<perfil> pelado é só a vitrine pública do vendedor — não paga
// comissão nenhuma, então não serve como resultado de sucesso.
const SHORT_LINK_PATTERN = /https?:\/\/meli\.la\/\w+/gi
const SOCIAL_LINK_PATTERN =
  /https?:\/\/(?:www\.)?mercadolivre\.com(?:\.br)?\/social\/[^\s"'<>]*[?&](?:ref|matt_tool|matt_word)=[^\s"'<>]+/gi

function findAffiliateLinks(text: string): string[] {
  return [
    ...(text.match(SHORT_LINK_PATTERN) ?? []),
    ...(text.match(SOCIAL_LINK_PATTERN) ?? []),
  ]
}

export class MercadoLivreSessionManager {
  private dbManager: DatabaseManager
  private loginWindow: BrowserWindow | null = null
  // A busca automática de ofertas roda de hora em hora e pode gerar vários
  // produtos do Mercado Livre de uma vez (visto no log real do Alan) — sem
  // cache, cada um desses produtos abriria uma janela headless só pra
  // confirmar login antes mesmo de tentar gerar o link.
  private cachedLoggedIn: { value: boolean; checkedAt: number } | null = null
  private readonly LOGIN_CACHE_MS = 3 * 60 * 1000

  // Fila de uma posição só: as capturas de link do WhatsApp e do Telegram
  // rodam em Promise.all (uma mensagem com vários links dispara várias
  // conversões juntas), e sem serializar isso abriria N janelas ao mesmo
  // tempo em cima da MESMA sessão logada — além de embaralhar a leitura da
  // área de transferência entre produtos diferentes.
  private queue: Promise<unknown> = Promise.resolve()

  // Disjuntor: enquanto os seletores não estiverem certos (estado esperado
  // até o primeiro teste real), cada produto custaria um carregamento de
  // página autenticado + 8s de polling à toa. Depois de algumas falhas
  // seguidas, para de tentar por um tempo em vez de martelar o site de hora
  // em hora — reduz tanto o desperdício quanto o risco de parecer robô.
  private consecutiveFailures = 0
  private pausedUntil = 0
  private readonly FAILURES_BEFORE_PAUSE = 3
  private readonly PAUSE_MS = 30 * 60 * 1000

  // Evita encher o sino de notificação com o mesmo aviso repetido uma vez por
  // produto (um lote de 20 ofertas viraria 20 avisos idênticos por hora).
  private lastNotifiedReason: string | null = null

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
  }

  private getSession() {
    return session.fromPartition(PARTITION)
  }

  private invalidateLoginCache(): void {
    this.cachedLoggedIn = null
  }

  private notifyProblem(reason: string, message: string, details: string): void {
    log.warn(`Mercado Livre: ${message} — ${details}`)
    if (this.lastNotifiedReason === reason) return
    this.lastNotifiedReason = reason
    this.dbManager.addLog({ type: 'warning', platform: 'system', message, details })
  }

  private createHiddenWindow(): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: PARTITION,
        images: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    // Sem isso, clicar num botão de compartilhar que abre popup criaria uma
    // janela solta que o finally não fecha — e ela apareceria na tela do
    // usuário no meio de uma raspagem que deveria ser invisível.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.setUserAgent(BROWSER_USER_AGENT)
    return win
  }

  // loadURL sem teto de tempo pode ficar pendurado pra sempre; nesse caso o
  // finally nunca roda e a janela vaza pelo resto da vida do processo (e a
  // fila trava atrás dela). Mesmo padrão do headlessScraper.ts.
  private async loadWithTimeout(win: BrowserWindow, url: string): Promise<void> {
    await Promise.race([
      win.loadURL(url, { userAgent: BROWSER_USER_AGENT }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout de ${NAV_TIMEOUT_MS}ms ao carregar ${url}`)), NAV_TIMEOUT_MS)
      ),
    ])
  }

  // Verifica login navegando pra uma página que exige sessão (/afiliados) e
  // olhando se o Mercado Livre redirecionou pra tela de login — sem sessão
  // ele manda pra /jms/mlb/lgz/login?...&go=<destino url-encoded>. O destino
  // vem percent-encoded, então checar "/afiliados" cru já não bate ali, mas o
  // guard de "login" deixa isso explícito em vez de depender da codificação.
  async isLoggedIn(): Promise<boolean> {
    if (this.cachedLoggedIn && Date.now() - this.cachedLoggedIn.checkedAt < this.LOGIN_CACHE_MS) {
      return this.cachedLoggedIn.value
    }
    let win: BrowserWindow | null = null
    try {
      win = this.createHiddenWindow()
      await this.loadWithTimeout(win, AFFILIATE_HOME_URL)
      const finalUrl = win.webContents.getURL()
      const loggedIn = finalUrl.includes('/afiliados') && !finalUrl.includes('login')
      this.cachedLoggedIn = { value: loggedIn, checkedAt: Date.now() }
      return loggedIn
    } catch (error) {
      log.warn('Erro ao checar sessão do Mercado Livre:', error)
      return false
    } finally {
      if (win && !win.isDestroyed()) win.destroy()
    }
  }

  async getStatus(): Promise<'connected' | 'disconnected'> {
    return (await this.isLoggedIn()) ? 'connected' : 'disconnected'
  }

  // Abre uma janela de verdade (visível) pro usuário logar manualmente com
  // usuário/senha dele direto no site do Mercado Livre — o app nunca vê a
  // senha, só reaproveita o cookie de sessão resultante depois. Fecha sozinha
  // assim que detectar login bem-sucedido; se o usuário fechar antes de
  // logar, só resolve sem erro (pode tentar de novo quando quiser).
  async openLoginWindow(): Promise<'connected' | 'cancelled'> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return 'cancelled'
    }

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 480,
        height: 720,
        title: 'Login — Mercado Livre (Central de Afiliados)',
        webPreferences: { partition: PARTITION },
      })
      this.loginWindow = win

      let settled = false
      const finish = (result: 'connected' | 'cancelled') => {
        if (settled) return
        settled = true
        if (!win.isDestroyed()) win.destroy()
        this.loginWindow = null
        resolve(result)
      }

      const checkLoggedIn = () => {
        if (settled) return
        try {
          const url = win.webContents.getURL()
          if (url.includes('/afiliados') && !url.includes('login')) {
            this.invalidateLoginCache()
            // Login novo zera o disjuntor e o dedupe: o motivo antigo das
            // falhas (sessão morta) pode ter acabado de ser resolvido.
            this.consecutiveFailures = 0
            this.pausedUntil = 0
            this.lastNotifiedReason = null
            sendToRenderer('mercadolivre:status', 'connected')
            this.dbManager.addLog({
              type: 'success',
              platform: 'system',
              message: 'Login no Mercado Livre (Central de Afiliados) concluído',
            })
            finish('connected')
          }
        } catch {
          // janela pode já ter sido destruída entre o evento disparar e rodar isso
        }
      }

      win.webContents.on('did-navigate', checkLoggedIn)
      win.webContents.on('did-navigate-in-page', checkLoggedIn)
      win.on('closed', () => finish('cancelled'))

      win.loadURL(AFFILIATE_HOME_URL)
    })
  }

  async logout(): Promise<void> {
    await this.getSession().clearStorageData()
    this.invalidateLoginCache()
    this.lastNotifiedReason = null
    sendToRenderer('mercadolivre:status', 'disconnected')
    this.dbManager.addLog({
      type: 'info',
      platform: 'system',
      message: 'Sessão do Mercado Livre desconectada',
    })
  }

  // Serializado: ver comentário do campo `queue`.
  async generateAffiliateLink(productUrl: string): Promise<string | null> {
    const run = this.queue.then(() => this.generateAffiliateLinkUnqueued(productUrl))
    // A fila não pode morrer se uma conversão rejeitar — encadeia sempre num
    // ramo que absorve o erro (o valor de verdade vai pra quem chamou).
    this.queue = run.catch(() => undefined)
    return run
  }

  // Tenta gerar o link "bonito" (mercadolivre.com/social/...) usando a sessão
  // logada de verdade, imitando o que o Alan faria manualmente. Os seletores
  // abaixo são um melhor-esforço sem confirmação ao vivo (o Mercado Livre não
  // documenta essa página, e não temos como logar como o Alan pra
  // inspecionar) — cada etapa avisa exatamente onde travou, pra dar pra
  // ajustar com base num log real em vez de adivinhar de novo.
  private async generateAffiliateLinkUnqueued(productUrl: string): Promise<string | null> {
    if (Date.now() < this.pausedUntil) return null

    if (!(await this.isLoggedIn())) {
      // O status precisa refletir isso na tela também: sem esse aviso a pílula
      // em Conexões ficava verde "conectado" pra sempre enquanto todo link
      // silenciosamente caía no formato simples.
      sendToRenderer('mercadolivre:status', 'disconnected')
      this.notifyProblem(
        'sessao-expirada',
        'Sessão do Mercado Livre expirou ou nunca foi conectada — faça login em Conexões',
        `Produto: ${productUrl}`
      )
      return null
    }

    let win: BrowserWindow | null = null
    // A área de transferência é global e persistente: sem guardar o valor de
    // antes, a primeira volta do laço (que roda antes de qualquer cópia ter
    // acontecido) leria um link de afiliado que já estava lá — do produto
    // ANTERIOR, ou copiado à mão pelo usuário — e devolveria como sucesso,
    // publicando o link errado no grupo. Guardar também deixa restaurar o que
    // o usuário tinha copiado, já que isso roda em segundo plano.
    const clipboardBefore = clipboard.readText()
    let clipboardTouched = false

    try {
      win = this.createHiddenWindow()
      await this.loadWithTimeout(win, productUrl)

      const loadedUrl = win.webContents.getURL()
      const html = (await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML'
      )) as string

      // O Mercado Livre serve uma página de "tráfego suspeito" com HTTP 200
      // no lugar do produto quando desconfia de automação — a URL continua
      // sendo mercadolivre.com, então sem checar o conteúdo isso viraria um
      // "não achei o botão" enganoso.
      if (loadedUrl.includes('suspicious-traffic') || html.includes('suspicious-traffic')) {
        this.registerFailure()
        this.notifyProblem(
          'trafego-suspeito',
          'O Mercado Livre bloqueou o acesso automático com uma verificação de tráfego suspeito',
          `Abra o Mercado Livre em Conexões e confirme a verificação. Produto: ${productUrl}`
        )
        return null
      }

      const linksBefore = new Set(findAffiliateLinks(html))

      // Clica em qualquer botão/link cujo texto pareça o de compartilhar/gerar
      // link de afiliado — só existe quando a conta logada está aprovada no
      // programa de afiliados.
      const clicked = (await win.webContents.executeJavaScript(`
        (function() {
          const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const match = candidates.find((el) => /compartilhar|gerar link|copiar link|link de afiliado/i.test(el.textContent || el.getAttribute('aria-label') || ''));
          if (match) { match.click(); return true; }
          return false;
        })()
      `)) as boolean

      if (!clicked) {
        // Botão sumido é o sintoma mais provável de sessão morta (a página do
        // produto é pública, então o Mercado Livre nunca redireciona pra fora
        // dela — não dá pra detectar a queda pela URL). Invalida o cache pra
        // próxima tentativa reconferir o login de verdade.
        this.invalidateLoginCache()
        this.registerFailure()
        this.notifyProblem(
          'botao-nao-encontrado',
          'Não achei o botão de compartilhar/gerar link na página do Mercado Livre',
          `Pode ser sessão expirada, conta ainda não aprovada como afiliada, ou mudança de layout do site. Produto: ${productUrl}`
        )
        return null
      }

      // Espera o link aparecer no DOM ou na área de transferência, aceitando
      // só o que NÃO existia antes do clique.
      const deadline = Date.now() + LINK_POLL_MS
      while (Date.now() < deadline) {
        const currentHtml = (await win.webContents.executeJavaScript(
          'document.documentElement.outerHTML'
        )) as string
        const fresh = findAffiliateLinks(currentHtml).find((link) => !linksBefore.has(link))
        if (fresh) {
          this.registerSuccess()
          return fresh
        }

        const clipboardNow = clipboard.readText()
        if (clipboardNow !== clipboardBefore) {
          clipboardTouched = true
          const fromClipboard = findAffiliateLinks(clipboardNow)[0]
          if (fromClipboard) {
            this.registerSuccess()
            return fromClipboard
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      this.registerFailure()
      this.notifyProblem(
        'link-nao-apareceu',
        'Cliquei em compartilhar no Mercado Livre, mas nenhum link de afiliado novo apareceu',
        `Sem resposta em ${LINK_POLL_MS / 1000}s. Produto: ${productUrl}`
      )
      return null
    } catch (error) {
      this.registerFailure()
      this.notifyProblem(
        'falha-geracao',
        'Falha ao gerar o link de afiliado do Mercado Livre — usando o link simples como alternativa',
        `${(error as Error).message} | Produto: ${productUrl}`
      )
      return null
    } finally {
      if (win && !win.isDestroyed()) win.destroy()
      // Devolve o que o usuário tinha copiado: isso roda em segundo plano, e
      // apagar a área de transferência dele sem motivo visível seria um efeito
      // colateral bem confuso.
      if (clipboardTouched) clipboard.writeText(clipboardBefore)
    }
  }

  private registerSuccess(): void {
    this.consecutiveFailures = 0
    this.pausedUntil = 0
    this.lastNotifiedReason = null
  }

  private registerFailure(): void {
    this.consecutiveFailures++
    if (this.consecutiveFailures < this.FAILURES_BEFORE_PAUSE) return
    this.pausedUntil = Date.now() + this.PAUSE_MS
    this.consecutiveFailures = 0
    this.dbManager.addLog({
      type: 'warning',
      platform: 'system',
      message: `Geração do link "vitrine" do Mercado Livre pausada por ${this.PAUSE_MS / 60000} minutos após falhas seguidas`,
      details: 'Os links continuam sendo gerados no formato simples (com matt_tool/matt_word) enquanto isso.',
    })
  }
}
