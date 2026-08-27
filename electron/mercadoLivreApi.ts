import axios from 'axios'
import log from 'electron-log'
import { DatabaseManager, Product } from './database'

// API oficial do Mercado Livre. Substitui a raspagem da página do produto, que
// passou a ser barrada por uma página de verificação de tráfego
// (/gz/account-verification, HTTP 200 sem dado nenhum) — confirmado ao vivo em
// máquinas diferentes, inclusive com sessão logada e navegador de verdade.
const OAUTH_URL = 'https://api.mercadolibre.com/oauth/token'
const ITEMS_URL = 'https://api.mercadolibre.com/items'

// Aceita as duas formas de id que aparecem nas URLs do Mercado Livre:
// /p/MLB58587883 (catálogo) e /MLB-1234567890-nome-do-produto-_JM (anúncio).
const ID_PATTERNS = [
  /\/p\/(ML[A-Z]?\d+)/i,
  /\/(ML[A-Z]?)-?(\d{6,})/i,
  /\b(ML[A-Z]?\d{6,})\b/i,
]

export function extractItemId(url: string): string | null {
  for (const pattern of ID_PATTERNS) {
    const match = url.match(pattern)
    if (!match) continue
    // O 2º padrão separa prefixo e números (MLB-1234 -> "MLB" + "1234"),
    // os outros já vêm juntos.
    const id = match[2] ? `${match[1]}${match[2]}` : match[1]
    return id.toUpperCase()
  }
  return null
}

export class MercadoLivreApi {
  private dbManager: DatabaseManager
  private token: { value: string; expiresAt: number } | null = null
  // Não fica avisando a cada produto que as credenciais faltam — um lote da
  // busca automática viraria dezenas de avisos idênticos no sino.
  private warnedMissingCredentials = false

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
  }

  isConfigured(): boolean {
    const cfg = this.dbManager.getConfig()
    return !!(cfg.mercado_livre_client_id && cfg.mercado_livre_client_secret)
  }

  private async getToken(): Promise<string | null> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value

    const cfg = this.dbManager.getConfig()
    if (!cfg.mercado_livre_client_id || !cfg.mercado_livre_client_secret) {
      if (!this.warnedMissingCredentials) {
        this.warnedMissingCredentials = true
        this.dbManager.addLog({
          type: 'warning',
          platform: 'system',
          message: 'Credenciais da API do Mercado Livre não configuradas',
          details:
            'Sem elas os dados do produto dependem de raspagem, que o Mercado Livre vem bloqueando. ' +
            'Crie uma aplicação em developers.mercadolivre.com.br e preencha o App ID e o Secret em Configurações.',
        })
      }
      return null
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.mercado_livre_client_id,
        client_secret: cfg.mercado_livre_client_secret,
      })
      const { data } = await axios.post(OAUTH_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      })
      if (!data?.access_token) throw new Error('Resposta do OAuth sem access_token')

      // Renova um pouco antes de expirar, pra não usar token vencido por
      // diferença de relógio ou latência.
      const ttlMs = Math.max((Number(data.expires_in) || 3600) - 300, 60) * 1000
      this.token = { value: data.access_token, expiresAt: Date.now() + ttlMs }
      this.warnedMissingCredentials = false
      log.info('Token da API do Mercado Livre obtido com sucesso')
      return this.token.value
    } catch (error: any) {
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data).substring(0, 300)
        : error.message
      log.error('Falha ao obter token da API do Mercado Livre:', detail)
      this.dbManager.addLog({
        type: 'error',
        platform: 'system',
        message: 'Falha ao autenticar na API do Mercado Livre — confira o App ID e o Secret em Configurações',
        details: detail,
      })
      return null
    }
  }

  /**
   * Busca os dados do produto na API oficial. Devolve null (sem lançar) quando
   * não dá — quem chama cai de volta na raspagem, que ainda funciona em
   * algumas máquinas/IPs.
   */
  async fetchProduct(url: string): Promise<Partial<Product> | null> {
    const itemId = extractItemId(url)
    if (!itemId) {
      log.warn(`Não consegui extrair o ID do item do Mercado Livre da URL: ${url}`)
      return null
    }

    const token = await this.getToken()
    if (!token) return null

    try {
      const { data } = await axios.get(`${ITEMS_URL}/${itemId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      })

      const price = Number(data?.price)
      if (!Number.isFinite(price) || price <= 0) {
        log.warn(`API do Mercado Livre devolveu item ${itemId} sem preço utilizável`)
        return null
      }

      // original_price só existe quando há desconto real — nunca inventar um
      // "de/por" quando os dois valores são iguais (o app já teve esse bug).
      const originalPrice = Number(data?.original_price)
      const hasRealDiscount = Number.isFinite(originalPrice) && originalPrice > price

      return {
        title: data?.title || 'Produto Mercado Livre',
        price,
        original_price: hasRealDiscount ? originalPrice : undefined,
        image_url: data?.pictures?.[0]?.secure_url || data?.thumbnail || undefined,
        description: '',
        original_url: data?.permalink || url,
        store: 'mercado_livre',
        source: 'manual',
      } as Partial<Product>
    } catch (error: any) {
      const status = error?.response?.status
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data).substring(0, 300)
        : error.message

      // 401/403 costuma ser token vencido ou aplicação sem permissão — zera o
      // token pra próxima tentativa pedir um novo em vez de repetir o vencido.
      if (status === 401 || status === 403) this.token = null

      log.warn(`API do Mercado Livre falhou para ${itemId} (HTTP ${status}):`, detail)
      this.dbManager.addLog({
        type: 'warning',
        platform: 'system',
        message: `API do Mercado Livre não retornou o produto (HTTP ${status ?? '?'})`,
        details: `${detail} | Item: ${itemId}`,
      })
      return null
    }
  }
}
