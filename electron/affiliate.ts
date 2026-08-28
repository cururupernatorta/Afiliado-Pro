import { DatabaseManager } from './database'
import { MercadoLivreLinkGenerator } from './mercadoLivreLink'
import axios from 'axios'
import log from 'electron-log'
import crypto from 'crypto'

export class AffiliateManager {
  private dbManager: DatabaseManager
  readonly mercadoLivreLink: MercadoLivreLinkGenerator

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
    this.mercadoLivreLink = new MercadoLivreLinkGenerator(dbManager)
  }

  async convertLink(originalUrl: string, store: string): Promise<string | null> {
    const config = this.dbManager.getConfig()
    try {
      switch (store) {
        case 'shopee': return await this.convertShopee(originalUrl, config)
        case 'mercado_livre': return await this.convertMercadoLivre(originalUrl, config)
        case 'amazon': return await this.convertAmazon(originalUrl, config)
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
  // matt_tool e matt_word são dois identificadores DIFERENTES, não o mesmo
  // valor duplicado — confirmado analisando um link de afiliado real gerado
  // pela Central de Afiliados: matt_tool é numérico (ex: "55658638"), matt_word
  // é o texto do perfil social do afiliado (ex: "rainycreates"). O Mercado
  // Livre não documenta uma API pública de "URL → link de afiliado"; o próprio
  // Gerador de Links/Central de Afiliados é quem gera esses links — por isso
  // aqui só remonta a URL do produto com os dois parâmetros da conta do
  // usuário, do mesmo jeito que os links gerados pela própria central ficam.
  private async convertMercadoLivre(url: string, config: any): Promise<string | null> {
    if (!config.mercado_livre_matt_tool) {
      log.warn('matt_tool do Mercado Livre não configurado')
      return null
    }

    // Primeiro o link com vitrine, gerado pelo mesmo endpoint que a Central de
    // Afiliados usa (ver mercadoLivreLink.ts). Só sai se o usuário conectou a
    // conta em Conexões; sem isso, ou se a geração falhar, cai no formato
    // simples com matt_tool/matt_word, que continua sendo afiliado válido.
    const vitrine = await this.mercadoLivreLink.generate(url, config.mercado_livre_matt_word)
    if (vitrine?.shortUrl || vitrine?.longUrl) {
      const link = vitrine.shortUrl || vitrine.longUrl!
      log.info(`Link de afiliado do Mercado Livre gerado com vitrine: ${link}`)
      return link
    }

    try {
      const urlObj = new URL(url)
      urlObj.searchParams.set('matt_tool', config.mercado_livre_matt_tool)
      if (config.mercado_livre_matt_word) {
        urlObj.searchParams.set('matt_word', config.mercado_livre_matt_word)
      }
      return urlObj.toString()
    } catch (error) {
      log.error('URL inválida para Mercado Livre:', url, error)
      return null
    }
  }

  // ==================== AMAZON ====================
  // Links curtos de afiliado da Amazon (amzn.to, a.co, link.amazon...) já pertencem a quem
  // os criou: o redirecionamento é resolvido pela Amazon a partir do código curto, e um
  // "?tag=" colado em cima do link curto é ignorado nesse processo — o destino final continua
  // com a tag de quem gerou o link original. Por isso, em vez de só colar a tag na URL
  // recebida, resolvemos o produto real (ASIN) primeiro e montamos um link limpo do zero,
  // só com a tag do usuário. Isso também limpa outros parâmetros de rastreamento de terceiros
  // (linkCode, ascsubtag, linkId...) que um link longo capturado de outro afiliado carrega.
  private readonly AMAZON_ASIN_PATTERN = /\/(?:dp|gp\/product|product)\/([A-Za-z0-9]{10})(?:[/?]|$)/i

  private extractAmazonAsin(url: string): string | null {
    const match = url.match(this.AMAZON_ASIN_PATTERN)
    return match ? match[1].toUpperCase() : null
  }

  // Segue a cadeia de redirecionamento HTTP (sem executar JS) até o destino final,
  // usado tanto pra resolver links curtos da Amazon quanto do AliExpress antes de
  // gerar o link de afiliado — link curto de outra pessoa aponta pra tag/tracking
  // ID dela, então precisamos do produto real por trás do redirecionamento.
  private async followRedirects(url: string, maxHops = 5): Promise<string> {
    let current = url
    for (let hop = 0; hop < maxHops; hop++) {
      try {
        const response = await axios.get(current, {
          maxRedirects: 0,
          validateStatus: () => true,
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
          },
        })
        const location = response.headers?.location
        if (response.status >= 300 && response.status < 400 && location) {
          current = new URL(location, current).toString()
          continue
        }
        break
      } catch (err) {
        log.warn('Falha ao resolver redirecionamento:', (err as Error).message)
        break
      }
    }
    return current
  }

  private async resolveAmazonRedirect(url: string): Promise<string> {
    return this.followRedirects(url)
  }

  private async convertAmazon(url: string, config: any): Promise<string | null> {
    if (!config.amazon_tag) {
      log.warn('Amazon Tag não configurada')
      return null
    }
    try {
      let resolvedUrl = url
      let asin = this.extractAmazonAsin(url)

      if (!asin) {
        resolvedUrl = await this.resolveAmazonRedirect(url)
        asin = this.extractAmazonAsin(resolvedUrl)
      }

      if (asin) {
        const domain = new URL(resolvedUrl).hostname
        return `https://${domain}/dp/${asin}?tag=${encodeURIComponent(config.amazon_tag)}`
      }

      // Não achei o ASIN nem depois de resolver o redirecionamento. Último recurso: cola a
      // tag na URL final mesmo assim — mas isso NÃO garante sobrescrever a tag de outro
      // afiliado se a URL de origem já era um link de afiliado alheio.
      log.warn('Não consegui extrair o ASIN do link da Amazon; usando fallback (pode não sobrescrever tag de outro afiliado):', url)
      const urlObj = new URL(resolvedUrl)
      urlObj.searchParams.set('tag', config.amazon_tag)
      return urlObj.toString()
    } catch (error) {
      log.error('URL inválida para Amazon:', url, error)
      return null
    }
  }

  // Links de canais de promoção costumam já vir num link curto de afiliado de
  // outra pessoa (s.click.aliexpress.com, a.aliexpress.com) ou num deep-link de
  // app. Passar isso direto pro "aliexpress.affiliate.link.generate" produz um
  // link genérico que não aponta pro produto — resolve pro link canônico
  // /item/NNNN.html primeiro, igual já fazemos com o link curto da Amazon.
  private readonly ALIEXPRESS_CANONICAL_PATTERN = /aliexpress\.[a-z.]+\/item\/\d+\.html/i

  // Público: o ScraperManager também usa isso antes de raspar, pra não tentar
  // renderizar um link curto direto (ver uso em scraper.ts).
  async resolveAliExpressUrl(url: string): Promise<string> {
    if (this.ALIEXPRESS_CANONICAL_PATTERN.test(url)) return url
    const resolved = await this.followRedirects(url)
    if (this.ALIEXPRESS_CANONICAL_PATTERN.test(resolved)) return resolved

    // Link curto do tipo "compartilhar" do app (a.aliexpress.com/_c...,
    // costuma vir de quem compartilha direto do app AliExpress em canal/grupo
    // de promoção) não redireciona pro produto — cai numa página de
    // "coin-index" (recompensa/gamificação da AliExpress), sem preço nenhum
    // pra raspar. Confirmado em produção (Logs) que essa página sempre falha
    // na extração. O ID do produto real continua ali, só que como parâmetro
    // "productIds" na URL da página errada — monta o link canônico a partir
    // dele em vez de tentar raspar a página de coin-index.
    try {
      const productId = new URL(resolved).searchParams.get('productIds')
      if (productId && /^\d+$/.test(productId)) {
        return `https://www.aliexpress.com/item/${productId}.html`
      }
    } catch {
      // URL de destino inválida — segue com o que já temos
    }
    return resolved
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
      const resolvedUrl = await this.resolveAliExpressUrl(url)
      const timestamp = Date.now() // milissegundos, não segundos
      const params: Record<string, any> = {
        app_key: config.aliexpress_app_key,
        method: 'aliexpress.affiliate.link.generate',
        timestamp,
        v: '2.0',
        sign_method: 'sha256',
        tracking_id: config.aliexpress_tracking_id,
        promotion_link_type: 0,
        source_values: resolvedUrl,
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

  // Busca de ofertas via API oficial de afiliado (aliexpress.affiliate.product.query)
  // em vez de raspar a página de busca do site. A busca raspada (/wholesale?SearchText=...)
  // é fragilíssima — bloqueia com captcha com frequência e nunca trouxe preço original pra
  // comparar, então qualquer produto que batesse a palavra-chave virava "oferta" mesmo sem
  // desconto nenhum. A API usa as MESMAS credenciais já configuradas pra gerar link de
  // afiliado (App Key/Secret + Tracking ID), devolve preço/título/foto estruturados direto
  // da AliExpress (sem parsing de HTML) e nunca é bloqueada por anti-bot.
  //
  // Usa "product.query", não "hotproduct.query": confirmado em produção (Logs) que
  // hotproduct.query devolve erro InsufficientPermission — é um método com aprovação
  // separada que a maioria das contas de afiliado não tem por padrão. product.query é
  // o método padrão de busca, com acesso mais amplo.
  async queryAliExpressDeals(keywords: string[]): Promise<{
    title: string
    price: number
    original_price?: number
    image_url?: string
    original_url: string
  }[]> {
    const config = this.dbManager.getConfig()
    if (!config.aliexpress_app_key || !config.aliexpress_app_secret) {
      log.warn('Credenciais AliExpress não configuradas — busca de ofertas pulada')
      return []
    }
    if (!config.aliexpress_tracking_id) {
      log.warn('Tracking ID do AliExpress não configurado — busca de ofertas pulada')
      return []
    }

    const allDeals: { title: string; price: number; original_price?: number; image_url?: string; original_url: string; discountPercent: number }[] = []

    for (const keyword of keywords.slice(0, 2)) {
      try {
        const timestamp = Date.now()
        const params: Record<string, any> = {
          app_key: config.aliexpress_app_key,
          method: 'aliexpress.affiliate.product.query',
          timestamp,
          v: '2.0',
          sign_method: 'sha256',
          tracking_id: config.aliexpress_tracking_id,
          keywords: keyword,
          page_no: 1,
          page_size: 20,
          target_currency: 'BRL',
          target_language: 'PT',
          ship_to_country: 'BR',
        }
        const sortedKeys = Object.keys(params).sort()
        const signString = sortedKeys.map((k) => `${k}${params[k]}`).join('')
        params.sign = crypto.createHmac('sha256', config.aliexpress_app_secret).update(signString).digest('hex').toUpperCase()

        const response = await axios.get('https://api-sg.aliexpress.com/sync', { params, timeout: 15000 })
        const result = response.data
        const products =
          result?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product
        if (!Array.isArray(products) || products.length === 0) {
          const rawTrail = JSON.stringify(result).substring(0, 500)
          log.warn(`AliExpress: sem produtos pra "${keyword}". Resposta: ${rawTrail}`)
          // Diagnóstico visível em Logs — sem poder testar essa chamada com
          // credenciais reais antes de publicar, se o formato da resposta for
          // diferente do esperado é assim que dá pra saber, em vez de só ficar
          // sem resultado nenhum e sem pista de por quê.
          this.dbManager.addLog({
            type: 'warning',
            platform: 'system',
            message: `AliExpress: busca de ofertas não retornou produtos pra "${keyword}"`,
            details: rawTrail,
          })
          continue
        }

        let matchedAny = false
        for (const p of products) {
          const title = p.product_title
          const price = parseFloat(p.target_sale_price ?? p.sale_price ?? '0')
          const originalPrice = parseFloat(p.target_original_price ?? p.original_price ?? '0')
          const url = p.product_detail_url || p.productDetailUrl
          const imageUrl = p.product_main_image_url || p.productMainImageUrl
          // Só é "oferta" de verdade se o preço original for maior que o atual —
          // mesmo critério já aplicado pra Amazon/Mercado Livre.
          if (!title || !url || !(price > 0)) continue
          matchedAny = true
          if (!(originalPrice > price)) continue
          allDeals.push({
            title,
            price,
            original_price: originalPrice,
            image_url: imageUrl,
            original_url: url,
            discountPercent: (1 - price / originalPrice) * 100,
          })
        }
        if (!matchedAny) {
          const rawTrail = JSON.stringify(products[0]).substring(0, 500)
          log.warn(`AliExpress: produtos vieram pra "${keyword}" mas nenhum campo bateu. Exemplo: ${rawTrail}`)
          this.dbManager.addLog({
            type: 'warning',
            platform: 'system',
            message: `AliExpress: resposta da busca teve produtos, mas os campos esperados (título/preço/link) não bateram para "${keyword}"`,
            details: rawTrail,
          })
        }
      } catch (error: any) {
        log.error(`Erro ao buscar ofertas AliExpress para "${keyword}":`, error?.response?.data || error.message)
        this.dbManager.addLog({
          type: 'error',
          platform: 'system',
          message: `Erro ao buscar ofertas AliExpress para "${keyword}"`,
          details: JSON.stringify(error?.response?.data || error.message).substring(0, 500),
        })
      }
    }

    // Maior desconto primeiro — é isso que "melhores ofertas" quer dizer aqui.
    allDeals.sort((a, b) => b.discountPercent - a.discountPercent)
    return allDeals.slice(0, 5).map(({ discountPercent, ...deal }) => deal)
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
