import axios from 'axios'
import crypto from 'crypto'
import log from 'electron-log'
import { DatabaseManager, Product } from './database'

// API oficial de afiliado da Shopee (GraphQL) usada pra ler os dados do
// produto, no lugar da raspagem — a página da Shopee é 100% renderizada por
// JavaScript e responde a requisição automatizada com uma casca sem dado
// nenhum e marcador de captcha (confirmado ao vivo), tanto no fetch estático
// quanto no browser headless.
//
// É a mesma API (e as mesmas credenciais) que o app já usa pra gerar o link
// curto de afiliado; aqui só mudamos a consulta.
const GRAPHQL_URL = 'https://open-api.affiliate.shopee.com.br/graphql'
const SHORT_LINK_HOSTS = ['s.shopee.com.br', 'shp.ee']

/** Extrai shopId e itemId do padrão "-i.{shopId}.{itemId}" das URLs da Shopee. */
export function extractShopeeIds(url: string): { shopId: number; itemId: number } | null {
  const match = url.match(/-i\.(\d+)\.(\d+)/)
  if (!match) return null
  const shopId = Number(match[1])
  const itemId = Number(match[2])
  if (!Number.isFinite(shopId) || !Number.isFinite(itemId)) return null
  return { shopId, itemId }
}

export function isShopeeShortLink(url: string): boolean {
  try {
    return SHORT_LINK_HOSTS.some((h) => new URL(url).hostname.endsWith(h))
  } catch {
    return false
  }
}

export class ShopeeApi {
  private dbManager: DatabaseManager
  private lastNotifiedReason: string | null = null

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
  }

  private notifyOnce(reason: string, message: string, details: string): void {
    log.warn(`Shopee API: ${message} — ${details}`)
    if (this.lastNotifiedReason === reason) return
    this.lastNotifiedReason = reason
    this.dbManager.addLog({ type: 'warning', platform: 'system', message, details })
  }

  /**
   * Link curto (s.shopee.com.br/...) não carrega shopId/itemId — só o destino
   * tem. Resolver isso é um HEAD/GET seguindo redirecionamento, que a Shopee
   * responde normalmente (é a página em si que vem vazia, não o redirect).
   */
  private async resolveShortLink(url: string): Promise<string> {
    if (!isShopeeShortLink(url)) return url
    try {
      const response = await axios.get(url, {
        maxRedirects: 10,
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        },
      })
      const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || url
      return typeof finalUrl === 'string' ? finalUrl : url
    } catch (err) {
      log.warn('Não consegui resolver o link curto da Shopee:', (err as Error).message)
      return url
    }
  }

  private async query(payload: string): Promise<any | null> {
    const cfg = this.dbManager.getConfig()
    if (!cfg.shopee_app_id || !cfg.shopee_app_secret) {
      this.notifyOnce(
        'sem-credenciais',
        'Credenciais da Shopee não configuradas',
        'Sem elas os dados do produto dependem de raspagem, que a Shopee bloqueia. ' +
          'Preencha App ID e App Secret em Configurações (open-api.affiliate.shopee.com.br).'
      )
      return null
    }

    const appId = String(cfg.shopee_app_id)
    const secret = String(cfg.shopee_app_secret)
    const timestamp = Math.floor(Date.now() / 1000)
    // Assinatura da Shopee: SHA256 simples (não HMAC) de appId+timestamp+payload+secret.
    const signature = crypto
      .createHash('sha256')
      .update(`${appId}${timestamp}${payload}${secret}`)
      .digest('hex')

    const { data } = await axios.post(GRAPHQL_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
      },
      timeout: 15000,
    })

    if (data?.errors?.length) {
      this.notifyOnce(
        'graphql-erro',
        'A API da Shopee retornou erro ao buscar o produto',
        JSON.stringify(data.errors).substring(0, 400)
      )
      return null
    }
    return data?.data ?? null
  }

  /**
   * Busca os dados do produto na API oficial. Devolve null (sem lançar) quando
   * não dá — quem chama cai de volta na raspagem.
   *
   * Também devolve `affiliate_url` quando a Shopee informa o offerLink, que já
   * é o link de afiliado pronto: dados e link numa chamada só.
   */
  async fetchProduct(url: string): Promise<(Partial<Product> & { affiliate_url?: string }) | null> {
    const resolvedUrl = await this.resolveShortLink(url)
    const ids = extractShopeeIds(resolvedUrl)
    if (!ids) {
      log.warn(`Não consegui extrair shopId/itemId da URL da Shopee: ${resolvedUrl}`)
      return null
    }

    const payload = JSON.stringify({
      query: `{productOfferV2(shopId:${ids.shopId},itemId:${ids.itemId}){nodes{itemId shopId productName imageUrl priceMin priceMax priceDiscountRate offerLink productLink}}}`,
    })

    try {
      const data = await this.query(payload)
      const node = data?.productOfferV2?.nodes?.[0]
      if (!node) {
        this.notifyOnce(
          'sem-resultado',
          'A API da Shopee não retornou este produto',
          `shopId=${ids.shopId} itemId=${ids.itemId} — pode estar fora do programa de afiliados ou indisponível.`
        )
        return null
      }

      const price = Number(node.priceMin)
      if (!Number.isFinite(price) || price <= 0) {
        log.warn(`Shopee devolveu o produto ${ids.itemId} sem preço utilizável`)
        return null
      }

      // priceDiscountRate vem em porcentagem (ex: 20 = 20% off). Só monta o
      // "de/por" quando existe desconto real — nunca inventar preço cheio.
      const discountRate = Number(node.priceDiscountRate)
      const hasRealDiscount = Number.isFinite(discountRate) && discountRate > 0 && discountRate < 100
      const originalPrice = hasRealDiscount
        ? Math.round((price / (1 - discountRate / 100)) * 100) / 100
        : undefined

      this.lastNotifiedReason = null

      return {
        title: node.productName || 'Produto Shopee',
        price,
        original_price: originalPrice,
        image_url: node.imageUrl || undefined,
        description: '',
        original_url: node.productLink || resolvedUrl,
        store: 'shopee',
        source: 'manual',
        affiliate_url: node.offerLink || undefined,
      } as Partial<Product> & { affiliate_url?: string }
    } catch (error: any) {
      const detail = error?.response?.data
        ? JSON.stringify(error.response.data).substring(0, 300)
        : error.message
      this.notifyOnce('falha-api', 'Falha ao consultar a API da Shopee', detail)
      return null
    }
  }
}
