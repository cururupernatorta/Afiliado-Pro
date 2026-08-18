import { DatabaseManager } from './database'
import axios from 'axios'
import log from 'electron-log'
import crypto from 'crypto'

export class AffiliateManager {
  private dbManager: DatabaseManager

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
  }

  async convertLink(originalUrl: string, store: string): Promise<string | null> {
    const config = this.dbManager.getConfig()
    try {
      switch (store) {
        case 'shopee': return await this.convertShopee(originalUrl, config)
        case 'mercado_livre': return this.convertMercadoLivre(originalUrl, config)
        case 'amazon': return this.convertAmazon(originalUrl, config)
        case 'aliexpress': return await this.convertAliExpress(originalUrl, config)
        default: return null
      }
    } catch (error) {
      log.error('Erro ao converter link de afiliado:', error)
      return null
    }
  }

  // ==================== SHOPEE ====================
  // A Shopee migrou o Affiliate Open API para GraphQL. A antiga API REST
  // (open-api.affiliate.shopee.com.br/api/v1/affiliate-link/generate) não existe mais.
  // Doc de referência (login necessário): https://open-api.affiliate.shopee.com.br
  private async convertShopee(url: string, config: any): Promise<string | null> {
    if (!config.shopee_app_id || !config.shopee_app_secret) {
      log.warn('Credenciais Shopee não configuradas — pulei geração de link de afiliado')
      return null
    }
    try {
      const appId = String(config.shopee_app_id)
      const secret = String(config.shopee_app_secret)
      const timestamp = Math.floor(Date.now() / 1000)

      // Escapa aspas/backslashes pra não quebrar a string do GraphQL
      const safeUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const payload = JSON.stringify({
        query: `mutation{generateShortLink(input:{originUrl:"${safeUrl}"}){shortLink}}`,
      })

      // Assinatura Shopee = SHA256 simples (não é HMAC) de appId+timestamp+payload+secret
      const factor = `${appId}${timestamp}${payload}${secret}`
      const signature = crypto.createHash('sha256').update(factor).digest('hex')

      const response = await axios.post(
        'https://open-api.affiliate.shopee.com.br/graphql',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
          },
          timeout: 10000,
        }
      )

      if (response.data?.errors?.length) {
        log.warn('Shopee GraphQL retornou erro:', JSON.stringify(response.data.errors).substring(0, 500))
        return null
      }

      const shortLink = response.data?.data?.generateShortLink?.shortLink
      if (shortLink) return shortLink

      log.warn('Shopee GraphQL não retornou shortLink:', JSON.stringify(response.data).substring(0, 300))
      return null
    } catch (error: any) {
      log.error('Erro na API Shopee (GraphQL):', error?.response?.data || error.message)
      return null
    }
  }

  // ==================== MERCADO LIVRE ====================
  // Simples adição de parâmetro na URL, sem chamada de API — não é fonte comum de falha,
  // mas adicionei matt_word junto do matt_tool (o programa de afiliados do ML costuma
  // pedir os dois para atribuição correta da comissão).
  private convertMercadoLivre(url: string, config: any): string | null {
    if (!config.mercado_livre_affiliate_id) {
      log.warn('Affiliate ID Mercado Livre não configurado')
      return null
    }
    try {
      const urlObj = new URL(url)
      urlObj.searchParams.set('matt_tool', config.mercado_livre_affiliate_id)
      urlObj.searchParams.set('matt_word', config.mercado_livre_affiliate_id)
      return urlObj.toString()
    } catch (error) {
      log.error('URL inválida para Mercado Livre:', url, error)
      return null
    }
  }

  // ==================== AMAZON ====================
  private convertAmazon(url: string, config: any): string | null {
    if (!config.amazon_tag) {
      log.warn('Amazon Tag não configurada')
      return null
    }
    try {
      const urlObj = new URL(url)
      urlObj.searchParams.set('tag', config.amazon_tag)
      return urlObj.toString()
    } catch (error) {
      log.error('URL inválida para Amazon:', url, error)
      return null
    }
  }

  // ==================== ALIEXPRESS ====================
  // 1) Endpoint correto é /sync, não /rest.
  // 2) tracking_id É DIFERENTE da App Key. Precisa ser criado em:
  //    portals.aliexpress.com -> Promo Tools -> Link Generator / Tracking ID.
  //    Usar a App Key como tracking_id faz a API rejeitar silenciosamente.
  // 3) Removido o "fallback" antigo que colava parâmetros inventados na URL
  //    (aff_fcid, sk, terminal_id...) — isso NÃO gera rastreamento real, só
  //    parece um link de afiliado. Sem API funcionando, é melhor devolver null
  //    (o app já usa a URL original nesse caso) do que fingir que é afiliado.
  private async convertAliExpress(url: string, config: any): Promise<string | null> {
    if (!config.aliexpress_app_key || !config.aliexpress_app_secret) {
      log.warn('Credenciais AliExpress (App Key/Secret) não configuradas — pulei geração de link de afiliado')
      return null
    }
    if (!config.aliexpress_tracking_id) {
      log.warn('Tracking ID do AliExpress não configurado (é diferente da App Key!) — pulei geração de link de afiliado')
      return null
    }
    try {
      const timestamp = Date.now() // milissegundos, não segundos
      const params: Record<string, any> = {
        app_key: config.aliexpress_app_key,
        method: 'aliexpress.affiliate.link.generate',
        timestamp,
        v: '2.0',
        sign_method: 'sha256',
        tracking_id: config.aliexpress_tracking_id,
        promotion_link_type: 0,
        source_values: url,
      }

      const sortedKeys = Object.keys(params).sort()
      const signString = sortedKeys.map((k) => `${k}${params[k]}`).join('')
      params.sign = crypto
        .createHmac('sha256', config.aliexpress_app_secret)
        .update(signString)
        .digest('hex')
        .toUpperCase()

      const response = await axios.get('https://api-sg.aliexpress.com/sync', {
        params,
        timeout: 15000,
      })

      const result = response.data
      const link =
        result?.aliexpress_affiliate_link_generate_response?.resp_result?.result
          ?.promotion_links?.promotion_link?.[0]?.promotion_link

      if (link) return link

      log.warn('AliExpress API não retornou link de afiliado:', JSON.stringify(result).substring(0, 400))
      return null
    } catch (error: any) {
      log.error('Erro na API AliExpress:', error?.response?.data || error.message)
      return null
    }
  }

  detectStore(url: string): 'shopee' | 'mercado_livre' | 'amazon' | 'aliexpress' | null {
    const lowerUrl = url.toLowerCase()
    if (lowerUrl.includes('shopee')) return 'shopee'
    if (lowerUrl.includes('mercadolivre') || lowerUrl.includes('mercado-livre')) return 'mercado_livre'
    if (lowerUrl.includes('amazon')) return 'amazon'
    if (lowerUrl.includes('aliexpress')) return 'aliexpress'
    return null
  }
}
