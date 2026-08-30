import axios from 'axios'
import log from 'electron-log'
import { DatabaseManager, Product } from './database'

// API oficial do Mercado Livre, usada no lugar da raspagem da página do
// produto — que o Mercado Livre vem barrando com uma página de verificação de
// tráfego (HTTP 200, sem dado nenhum).
//
// O que foi confirmado testando com credenciais reais (2026-08-27):
//  - Exige a permissão "Publicação e sincronização" (Somente leitura) na
//    aplicação do DevCenter. Sem ela, tudo responde 403 PolicyAgent — foi o
//    que aconteceu na primeira tentativa, com a aplicação criada sem nenhuma
//    permissão marcada.
//  - GET /products/{id}        -> 200: nome, imagens (produto de catálogo)
//  - GET /products/{id}/items  -> 200: preço e original_price de cada vendedor
//  - GET /items/{id}           -> 403 para anúncio de outro vendedor; só dá
//    pra ler os anúncios da própria conta. Por isso só URL de catálogo (/p/)
//    é atendida aqui; anúncio individual cai na raspagem.
//  - GET /sites/MLB/search     -> 403, então a busca de ofertas continua sendo
//    raspada.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
const OAUTH_URL = 'https://api.mercadolibre.com/oauth/token'
const API_BASE = 'https://api.mercadolibre.com'

/** Só produto de catálogo: /p/MLB123... (com ou sem slug antes). */
export function extractCatalogProductId(url: string): string | null {
  const match = url.match(/\/p\/(ML[A-Z]?\d+)/i)
  return match ? match[1].toUpperCase() : null
}

/**
 * Link encurtado do Mercado Livre — é o formato que mais aparece em grupo de
 * ofertas, e nele o ID do produto não está visível, só no destino.
 */
export function isMercadoLivreShortLink(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname.endsWith('meli.la') || /\/sec\//.test(u.pathname)
  } catch {
    return false
  }
}

/** Página de vitrine de um afiliado (o destino de um link meli.la). */
export function isAffiliateStorefrontUrl(url: string): boolean {
  return /mercadolivre\.com(\.br)?\/social\//i.test(url)
}

/**
 * Descobre qual produto está sendo divulgado numa vitrine de afiliado.
 *
 * Isso importa porque o que circula nos grupos é o link de afiliado de OUTRA
 * pessoa (meli.la/...), que aponta pra vitrine dela, não pra uma página de
 * produto. Sem resolver isso, o app não conseguia nem ler os dados nem trocar
 * pelo link de afiliado do próprio usuário — ele acabaria divulgando o link do
 * concorrente.
 *
 * A vitrine lista vários produtos, mas o que veio no link é marcado com
 * `card-featured` na URL do cartão (os demais são recomendações). Confirmado
 * comparando dois links gerados por nós com o produto que os originou.
 */
export function extractFeaturedProductId(html: string): string | null {
  const featured = html.match(/\/(?:p|up)\/(ML[A-Z]*\d+)[^"']*?card-featured/i)
  if (featured) return featured[1].toUpperCase()
  return null
}

/**
 * Monta a URL do produto a partir do ID, escolhendo o caminho certo.
 *
 * Produto de catálogo (MLB123...) mora em /p/; "user product" (MLBU123...,
 * com U depois da sigla do site) mora em /up/. Trocar os dois não é detalhe
 * cosmético: testado ao vivo, o gerador de link de afiliado ACEITA
 * /up/MLBU... e REJEITA /p/MLBU... com HTTP 400 — era por isso que alguns
 * anúncios saíam com o link no formato simples em vez do meli.la.
 */
export function buildProductUrl(productId: string): string {
  const id = productId.toUpperCase()
  const prefixo = id.match(/^(ML[A-Z]*)\d/)?.[1] ?? ''
  const caminho = prefixo.endsWith('U') ? 'up' : 'p'
  return `https://www.mercadolivre.com.br/${caminho}/${id}`
}

/**
 * Segue encurtador e, caindo numa vitrine de afiliado, descobre o produto
 * divulgado — devolvendo a URL canônica. Função solta (não precisa de token
 * nem de banco) porque tanto a leitura de dados quanto a geração do link de
 * afiliado precisam disso: usar a URL crua fazia o app republicar o link do
 * concorrente. Devolve a URL de entrada quando não consegue resolver.
 */
export async function resolveMercadoLivreProductUrl(url: string): Promise<string> {
  let atual = url
  try {
    if (isMercadoLivreShortLink(atual)) {
      const response = await axios.get(atual, {
        maxRedirects: 10,
        timeout: 15000,
        validateStatus: () => true,
        headers: { 'User-Agent': DESKTOP_UA },
      })
      const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL
      if (typeof finalUrl === 'string' && finalUrl) atual = finalUrl
    }

    if (!isAffiliateStorefrontUrl(atual)) return atual

    const { data } = await axios.get(atual, {
      timeout: 20000,
      validateStatus: () => true,
      headers: { 'User-Agent': DESKTOP_UA },
    })
    const productId = extractFeaturedProductId(String(data))
    if (!productId) {
      log.warn(`Vitrine de afiliado sem produto identificável: ${atual.substring(0, 100)}`)
      return atual
    }
    log.info(`Link de afiliado de terceiro resolvido para o produto ${productId}`)
    return buildProductUrl(productId)
  } catch (err) {
    log.warn('Não consegui resolver o link do Mercado Livre:', (err as Error).message)
    return atual
  }
}

export class MercadoLivreApi {
  private dbManager: DatabaseManager
  private token: { value: string; expiresAt: number } | null = null
  // Um lote da busca automática viraria dezenas de avisos idênticos no sino
  // se cada produto reclamasse da mesma coisa.
  private lastNotifiedReason: string | null = null
  // Categoria de uma palavra-chave não muda; sem cache seria uma chamada extra
  // a cada busca automática, de hora em hora, pro mesmo resultado.
  private categoryCache = new Map<string, string | null>()

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
  }

  private notifyOnce(reason: string, message: string, details: string): void {
    log.warn(`Mercado Livre API: ${message} — ${details}`)
    if (this.lastNotifiedReason === reason) return
    this.lastNotifiedReason = reason
    this.dbManager.addLog({ type: 'warning', platform: 'system', message, details })
  }

  private async getToken(): Promise<string | null> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value

    const cfg = this.dbManager.getConfig()
    if (!cfg.mercado_livre_client_id || !cfg.mercado_livre_client_secret) {
      this.notifyOnce(
        'sem-credenciais',
        'Credenciais da API do Mercado Livre não configuradas',
        'Crie uma aplicação em developers.mercadolivre.com.br com a permissão "Publicação e sincronização" ' +
          'em Somente leitura, e preencha o App ID e o Secret em Configurações.'
      )
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

      // Renova antes de expirar, pra não usar token vencido por diferença de
      // relógio ou latência.
      const ttlMs = Math.max((Number(data.expires_in) || 3600) - 300, 60) * 1000
      this.token = { value: data.access_token, expiresAt: Date.now() + ttlMs }
      this.lastNotifiedReason = null
      return this.token.value
    } catch (error: any) {
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data).substring(0, 300)
        : error.message
      this.notifyOnce(
        'falha-auth',
        'Falha ao autenticar na API do Mercado Livre — confira o App ID e o Secret em Configurações',
        detail
      )
      return null
    }
  }

  /**
   * Descobre a categoria do Mercado Livre correspondente a uma palavra-chave,
   * usando o preditor de categorias deles. Serve pra pedir a página de ofertas
   * filtrada por categoria (`/ofertas?category=...`), que traz produtos do
   * nicho em vez da vitrine genérica — na prática a diferença entre 4 e 25
   * ofertas relevantes por busca.
   *
   * O preditor erra às vezes ("teclado mecânico" devolveu Águas Minerais nos
   * testes), então quem usa isso deve continuar filtrando pelos títulos.
   */
  async resolveCategoryId(keyword: string): Promise<string | null> {
    const key = keyword.trim().toLowerCase()
    if (!key) return null
    if (this.categoryCache.has(key)) return this.categoryCache.get(key)!

    const token = await this.getToken()
    if (!token) return null

    try {
      const { data } = await axios.get(`${API_BASE}/sites/MLB/domain_discovery/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 1, q: keyword },
        timeout: 15000,
      })
      const categoryId: string | null = Array.isArray(data) && data[0]?.category_id ? data[0].category_id : null
      this.categoryCache.set(key, categoryId)
      if (categoryId) log.info(`Mercado Livre: "${keyword}" -> categoria ${categoryId} (${data[0].category_name})`)
      return categoryId
    } catch (error: any) {
      log.warn(`Não consegui descobrir a categoria do Mercado Livre para "${keyword}":`, error?.response?.status || error.message)
      this.categoryCache.set(key, null)
      return null
    }
  }

  /**
   * Busca os dados do produto na API oficial. Devolve null (sem lançar) quando
   * não dá — quem chama cai de volta na raspagem.
   */
  async fetchProduct(url: string): Promise<Partial<Product> | null> {
    const resolvedUrl = await resolveMercadoLivreProductUrl(url)
    const productId = extractCatalogProductId(resolvedUrl)
    // Anúncio individual (/MLB-...-_JM) não é atendido pela API com token de
    // aplicação; sai calado pra não poluir o log, já que a raspagem assume.
    if (!productId) return null

    const token = await this.getToken()
    if (!token) return null

    try {
      const headers = { Authorization: `Bearer ${token}` }

      const [productRes, itemsRes] = await Promise.all([
        axios.get(`${API_BASE}/products/${productId}`, { headers, timeout: 15000 }),
        axios.get(`${API_BASE}/products/${productId}/items`, { headers, timeout: 15000 }),
      ])

      const product = productRes.data
      const offers: any[] = itemsRes.data?.results ?? []

      // Melhor oferta = menor preço entre os vendedores, que é o que faz
      // sentido divulgar. O preço "de" vem do mesmo anúncio, nunca de outro —
      // misturar daria um desconto que não existe (esse app já teve esse bug).
      const valid = offers.filter((o) => Number.isFinite(Number(o?.price)) && Number(o.price) > 0)
      if (valid.length === 0) {
        this.notifyOnce(
          'sem-oferta',
          'A API do Mercado Livre não retornou nenhuma oferta com preço para este produto',
          `Produto: ${productId}`
        )
        return null
      }

      const best = valid.reduce((a, b) => (Number(a.price) <= Number(b.price) ? a : b))
      const price = Number(best.price)
      const originalPrice = Number(best.original_price)
      const hasRealDiscount = Number.isFinite(originalPrice) && originalPrice > price

      const imageUrl =
        product?.pictures?.[0]?.secure_url || product?.pictures?.[0]?.url || undefined

      return {
        title: product?.name || 'Produto Mercado Livre',
        price,
        original_price: hasRealDiscount ? originalPrice : undefined,
        image_url: imageUrl,
        description: '',
        // A URL canônica do produto, NÃO a que chegou. Quando a captura vem de
        // um grupo, `url` é o link de afiliado de outra pessoa (meli.la/...);
        // devolver ele aqui fazia o produto ser salvo apontando pro
        // concorrente, e a geração do link de afiliado receber esse mesmo
        // endereço de volta — o app colava matt_tool/matt_word no link alheio,
        // o que não muda a atribuição em nada.
        original_url: resolvedUrl,
        store: 'mercado_livre',
        source: 'manual',
      } as Partial<Product>
    } catch (error: any) {
      const status = error?.response?.status
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data).substring(0, 300)
        : error.message

      // Token vencido ou permissão retirada — zera pra próxima tentativa pedir
      // um novo em vez de repetir o mesmo.
      if (status === 401 || status === 403) this.token = null

      if (status === 403) {
        this.notifyOnce(
          'sem-permissao',
          'A API do Mercado Livre recusou o acesso (403) — falta permissão na aplicação',
          'No DevCenter, edite a aplicação e coloque "Publicação e sincronização" em Somente leitura. ' +
            `Detalhe: ${detail}`
        )
      } else if (status === 404) {
        log.warn(`Produto ${productId} não encontrado na API do Mercado Livre`)
      } else {
        this.notifyOnce(
          'falha-api',
          `API do Mercado Livre não retornou o produto (HTTP ${status ?? '?'})`,
          `${detail} | Produto: ${productId}`
        )
      }
      return null
    }
  }
}
