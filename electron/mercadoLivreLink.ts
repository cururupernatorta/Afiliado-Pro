import { app, BrowserWindow, safeStorage, session } from 'electron'
import fs from 'fs'
import path from 'path'
import log from 'electron-log'
import { DatabaseManager } from './database'
import { sendToRenderer } from './utils'

// Geração do link de afiliado "vitrine" do Mercado Livre pelo mesmo endpoint
// que a Central de Afiliados usa quando o usuário clica em "Gerar".
//
// Capturado ao vivo no painel real (2026-08-28), com a sessão logada:
//   POST /affiliate-program/api/v2/affiliates/createLink
//   { "urls": ["<url do produto>"], "tag": "<etiqueta>" }
//   -> { total_success, total_error, urls: [{ short_url, long_url, ... }] }
//
// Duas coisas importantes que o teste ao vivo mostrou:
//  - Basta o cookie de sessão. Não exige reCAPTCHA, header assinado nem
//    token: um fetch simples da própria página devolveu 200.
//  - `urls` é lista, então dá pra gerar vários links numa chamada só.
//
// Por que isto NÃO repete o problema que causou o bloqueio antes: a versão
// anterior carregava a *página do produto* num navegador embutido a cada
// captura, de hora em hora — tráfego pesado e com cara de robô, que o
// anti-bot do Mercado Livre pegou. Aqui é um único POST numa API, que é
// exatamente o que o painel deles faz nativamente. Página de produto não é
// mais carregada em lugar nenhum: os dados vêm da API oficial de catálogo.
export const ML_LINK_PARTITION = 'persist:mercadolivre-afiliados'
const CREATE_LINK_URL = 'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink'
const HUB_URL = 'https://www.mercadolivre.com.br/afiliados/hub'
const LINKBUILDER_URL = 'https://www.mercadolivre.com.br/afiliados/linkbuilder'

export interface CreatedAffiliateLink {
  shortUrl?: string
  longUrl?: string
}

/**
 * Lê a resposta do createLink. Separado da chamada de rede pra poder ser
 * testado sem Electron nem sessão logada.
 */
export function parseCreateLinkResponse(data: any): CreatedAffiliateLink | null {
  const entry = Array.isArray(data?.urls) ? data.urls[0] : null
  if (!entry) return null
  const shortUrl = typeof entry.short_url === 'string' && entry.short_url ? entry.short_url : undefined
  const longUrl = typeof entry.long_url === 'string' && entry.long_url ? entry.long_url : undefined
  if (!shortUrl && !longUrl) return null
  return { shortUrl, longUrl }
}

/** Monta o corpo do POST. Isolado pra ficar testável. */
export function buildCreateLinkPayload(productUrl: string, tag?: string): string {
  const body: { urls: string[]; tag?: string } = { urls: [productUrl] }
  if (tag) body.tag = tag
  return JSON.stringify(body)
}

export class MercadoLivreLinkGenerator {
  private dbManager: DatabaseManager
  private loginWindow: BrowserWindow | null = null
  private lastNotifiedReason: string | null = null
  // Sem isto, um lote da busca automática tentaria gerar link pra cada
  // produto mesmo com a sessão caída, e cada um falharia igual.
  private pausedUntil = 0
  private readonly PAUSE_MS = 30 * 60 * 1000

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
  }

  private getSession() {
    return session.fromPartition(ML_LINK_PARTITION)
  }

  private get sessionFile(): string {
    return path.join(app.getPath('userData'), 'mercadolivre-sessao.bin')
  }

  /**
   * Os cookies de login do Mercado Livre são cookies de SESSÃO (sem data de
   * expiração), e o Chromium por definição nunca grava esses em disco — ao
   * fechar o app o login se perdia e era preciso reconectar toda vez.
   *
   * Aqui eles são salvos à parte, cifrados pelo cofre do sistema operacional
   * (DPAPI no Windows, via safeStorage), num arquivo dentro da pasta de dados
   * do app. Se a criptografia não estiver disponível, não grava nada: melhor
   * pedir login de novo do que deixar cookie de sessão em texto puro.
   */
  private async saveSession(): Promise<void> {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('Cofre do sistema indisponível — a sessão do Mercado Livre não será lembrada entre reinícios')
        return
      }
      const cookies = await this.getSession().cookies.get({ domain: '.mercadolivre.com.br' })
      if (cookies.length === 0) return
      const payload = JSON.stringify(cookies)
      fs.writeFileSync(this.sessionFile, safeStorage.encryptString(payload))
      log.info(`Sessão do Mercado Livre guardada (${cookies.length} cookies)`)
    } catch (err) {
      log.warn('Não consegui guardar a sessão do Mercado Livre:', (err as Error).message)
    }
  }

  /** Devolve os cookies guardados pra dentro da sessão do app. */
  async restoreSession(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.sessionFile) || !safeStorage.isEncryptionAvailable()) return false
      const cookies = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.sessionFile)))
      if (!Array.isArray(cookies) || cookies.length === 0) return false

      const ses = this.getSession()
      let restaurados = 0
      for (const c of cookies) {
        try {
          await ses.cookies.set({
            url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
          })
          restaurados++
        } catch {
          // um cookie inválido não deve impedir os outros
        }
      }
      log.info(`Sessão do Mercado Livre restaurada (${restaurados}/${cookies.length} cookies)`)
      return restaurados > 0
    } catch (err) {
      log.warn('Não consegui restaurar a sessão do Mercado Livre:', (err as Error).message)
      return false
    }
  }

  private clearSavedSession(): void {
    try {
      if (fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile)
    } catch (err) {
      log.warn('Erro ao apagar a sessão guardada do Mercado Livre:', (err as Error).message)
    }
  }

  private notifyOnce(reason: string, message: string, details: string): void {
    log.warn(`Mercado Livre (link de afiliado): ${message} — ${details}`)
    if (this.lastNotifiedReason === reason) return
    this.lastNotifiedReason = reason
    this.dbManager.addLog({ type: 'warning', platform: 'system', message, details })
  }

  /**
   * Considera logado quando o hub de afiliados responde sem jogar pra tela de
   * login. Usa a própria sessão persistida, sem abrir janela.
   */
  async isLoggedIn(): Promise<boolean> {
    try {
      // Primeiro o jar de cookies: é determinístico e não depende de rede.
      // Sem cookie nenhum do domínio, com certeza não está logado.
      const cookies = await this.getSession().cookies.get({ domain: '.mercadolivre.com.br' })
      if (cookies.length === 0) return false

      const response = await this.getSession().fetch(HUB_URL, {
        method: 'GET',
        redirect: 'follow',
        // ESSENCIAL: session.fetch segue a semântica do fetch da web, onde
        // `credentials` é 'same-origin' por padrão. Como a chamada parte do
        // processo principal (sem origem), sem isto NENHUM cookie é enviado —
        // e a sessão parecia sempre deslogada por mais que o usuário logasse.
        credentials: 'include',
      })
      return response.ok && response.url.includes('/afiliados')
    } catch (err) {
      log.warn('Erro ao checar sessão do Mercado Livre:', (err as Error).message)
      return false
    }
  }

  async getStatus(): Promise<'connected' | 'disconnected'> {
    return (await this.isLoggedIn()) ? 'connected' : 'disconnected'
  }

  /**
   * Abre a página de login real do Mercado Livre numa janela separada. O app
   * nunca vê a senha — só reaproveita o cookie de sessão depois.
   */
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
        webPreferences: { partition: ML_LINK_PARTITION },
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

      const markConnected = async () => {
        this.pausedUntil = 0
        this.lastNotifiedReason = null
        await this.saveSession()
        sendToRenderer('mercadolivre:status', 'connected')
        this.dbManager.addLog({
          type: 'success',
          platform: 'system',
          message: 'Mercado Livre conectado — os links de afiliado passarão a sair no formato com vitrine',
        })
      }

      // Compara o caminho da URL, não a string inteira: a tela de login do
      // Mercado Livre carrega a URL de destino codificada dentro dela, então
      // procurar "login" no texto todo dava falso positivo e a detecção nunca
      // disparava.
      const check = () => {
        if (settled) return
        try {
          const { pathname } = new URL(win.webContents.getURL())
          if (pathname.startsWith('/afiliados')) {
            markConnected()
            finish('connected')
          }
        } catch {
          // janela pode ter sido destruída, ou a URL ainda não é válida
        }
      }

      win.webContents.on('did-navigate', check)
      win.webContents.on('did-navigate-in-page', check)

      // Rede de segurança: se o usuário logou e fechou a janela na mão antes
      // de o app navegar de volta pro hub, o cookie já está salvo — vale
      // conferir em vez de assumir que foi cancelado.
      win.on('closed', () => {
        if (settled) return
        this.isLoggedIn()
          .then((logged) => {
            if (logged) markConnected()
            finish(logged ? 'connected' : 'cancelled')
          })
          .catch(() => finish('cancelled'))
      })

      win.loadURL(HUB_URL)
    })
  }

  async logout(): Promise<void> {
    await this.getSession().clearStorageData()
    this.clearSavedSession()
    this.pausedUntil = 0
    this.lastNotifiedReason = null
    sendToRenderer('mercadolivre:status', 'disconnected')
    this.dbManager.addLog({
      type: 'info',
      platform: 'system',
      message: 'Mercado Livre desconectado — os links voltam ao formato simples (matt_tool/matt_word)',
    })
  }

  /**
   * Roda a chamada de dentro de uma página do próprio Mercado Livre, numa
   * janela invisível com a sessão do usuário. É o mesmo que o painel deles faz
   * — testado ao vivo no navegador, onde funcionou de primeira. Serve de
   * reserva pro caminho direto, que não tem origem nem referer.
   */
  private async generateInPage(productUrl: string, tag?: string): Promise<CreatedAffiliateLink | null> {
    let win: BrowserWindow | null = null
    try {
      win = new BrowserWindow({
        show: false,
        webPreferences: { partition: ML_LINK_PARTITION, images: false },
      })
      await win.loadURL(LINKBUILDER_URL)

      const raw = (await win.webContents.executeJavaScript(`
        (async () => {
          const r = await fetch(${JSON.stringify(CREATE_LINK_URL)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: ${JSON.stringify(buildCreateLinkPayload(productUrl, tag))}
          });
          if (!r.ok) return JSON.stringify({ erro: r.status });
          return JSON.stringify(await r.json());
        })()
      `)) as string

      const data = JSON.parse(raw)
      if (data?.erro) {
        log.warn(`Página do Mercado Livre também recusou a geração do link (HTTP ${data.erro})`)
        return null
      }
      return parseCreateLinkResponse(data)
    } catch (err) {
      log.warn('Falha ao gerar link pela página do Mercado Livre:', (err as Error).message)
      return null
    } finally {
      if (win && !win.isDestroyed()) win.destroy()
    }
  }

  /**
   * Gera o link de afiliado com vitrine. Devolve null (sem lançar) quando não
   * dá — quem chama cai no formato simples, que continua sendo afiliado
   * válido.
   */
  async generate(productUrl: string, tag?: string): Promise<CreatedAffiliateLink | null> {
    if (Date.now() < this.pausedUntil) return null

    try {
      // Diagnóstico: quantos cookies a sessão tem no momento da chamada.
      // Distingue "usuário não conectou" de "conectou mas o cookie não está
      // sendo usado" — dois problemas com o mesmo sintoma.
      const cookieCount = (await this.getSession().cookies.get({ domain: '.mercadolivre.com.br' })).length
      log.info(`Gerando link de afiliado do Mercado Livre (${cookieCount} cookie(s) na sessão)`)

      const response = await this.getSession().fetch(CREATE_LINK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // O navegador manda Origin e Referer sozinho; a partir do processo
          // principal eles não existem, e o Mercado Livre trata a requisição
          // como vinda de fora e recusa.
          Origin: 'https://www.mercadolivre.com.br',
          Referer: LINKBUILDER_URL,
          'X-Requested-With': 'XMLHttpRequest',
        },
        // Ver isLoggedIn: sem credentials:'include' o Electron não manda os
        // cookies da partição, e o Mercado Livre responde como se ninguém
        // estivesse logado.
        credentials: 'include',
        body: buildCreateLinkPayload(productUrl, tag),
      })

      // Se ainda assim vier recusado, tenta de dentro de uma página do próprio
      // domínio: aí a requisição tem origem, referer e cookies exatamente como
      // no navegador, que é o cenário em que sabemos que funciona. É mais caro
      // (carrega uma página), então só entra quando o caminho leve falha.
      if (response.status === 401 || response.status === 403) {
        const viaPagina = await this.generateInPage(productUrl, tag)
        if (viaPagina) {
          log.info('Link de afiliado gerado pela página do Mercado Livre (o caminho direto foi recusado)')
          return viaPagina
        }
      }

      if (response.status === 401 || response.status === 403) {
        this.pausedUntil = Date.now() + this.PAUSE_MS
        sendToRenderer('mercadolivre:status', 'disconnected')
        this.notifyOnce(
          'sessao-expirada',
          'Sessão do Mercado Livre expirou — os links estão saindo no formato simples',
          'Reconecte em Conexões para voltar a gerar o link com vitrine.'
        )
        return null
      }

      if (!response.ok) {
        this.notifyOnce(
          'http-erro',
          `O Mercado Livre recusou a geração do link (HTTP ${response.status})`,
          `Produto: ${productUrl}`
        )
        return null
      }

      const parsed = parseCreateLinkResponse(await response.json())
      if (!parsed) {
        this.notifyOnce(
          'resposta-vazia',
          'O Mercado Livre não devolveu link de afiliado para este produto',
          `Produto: ${productUrl}`
        )
        return null
      }

      this.lastNotifiedReason = null
      return parsed
    } catch (error) {
      this.notifyOnce('falha-rede', 'Falha ao gerar o link de afiliado do Mercado Livre', (error as Error).message)
      return null
    }
  }
}
