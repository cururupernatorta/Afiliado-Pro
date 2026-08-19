import axios from 'axios'
import * as cheerio from 'cheerio'
import log from 'electron-log'
import { AffiliateManager } from './affiliate'
import { Product } from './database'
import { renderPageHtml } from './headlessScraper'
import { humanizeDescription } from './humanize'

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

interface PriceExtractionOptions {
  metaSelectors?: string[]
  jsonPatterns?: RegExp[]
  cssSelectors?: string[]
  bodyFallback?: boolean
}

export class ScraperManager {
  public affiliateManager: AffiliateManager

  constructor(affiliateManager: AffiliateManager) {
    this.affiliateManager = affiliateManager
  }

  async scrapeProduct(url: string): Promise<Partial<Product>> {
    const store = this.affiliateManager.detectStore(url)
    if (!store) {
      throw new Error('Loja não suportada. URLs suportadas: Shopee, Mercado Livre, Amazon, AliExpress')
    }
    try {
      let result: Partial<Product>
      switch (store) {
        case 'shopee': result = await this.scrapeShopee(url); break
        case 'mercado_livre': result = await this.scrapeMercadoLivre(url); break
        case 'amazon': result = await this.scrapeAmazon(url); break
        case 'aliexpress': result = await this.scrapeAliExpress(url); break
        default: throw new Error('Loja não suportada')
      }

      // A descrição raspada da página é texto de marketing do próprio site, não
      // algo escrito para o anúncio do grupo — troca por uma versão humanizada
      // local (sem IA), gerada a partir dos dados reais já extraídos.
      if (result.title && typeof result.price === 'number') {
        result.description = humanizeDescription({
          title: result.title,
          store,
          price: result.price,
          original_price: result.original_price,
        })
      }

      return result
    } catch (error) {
      log.error('Erro no scraping:', error)
      throw new Error(`Não foi possível extrair dados do produto. Erro: ${(error as Error).message}`)
    }
  }

  private async fetchPage(url: string, useMobileUA = false): Promise<{ $: cheerio.CheerioAPI; html: string }> {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': useMobileUA ? MOBILE_UA : DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0',
      },
      timeout: 20000,
      maxRedirects: 5,
      // Não deixa o axios jogar exceção em 403/503 — queremos ler o corpo
      // dessas respostas pra detectar página de captcha/bloqueio e dar um erro claro.
      validateStatus: () => true,
    })
    const html = typeof response.data === 'string' ? response.data : String(response.data)
    return { $: cheerio.load(html), html }
  }

  // Fallback pra sites que renderizam o preço via JavaScript (SPA). Mais lento e mais pesado
  // que fetchPage, então só deve ser chamado quando o scraping estático falhar ou vier bloqueado.
  private async fetchPageHeadless(
    url: string,
    useMobileUA = false,
    options: { waitMs?: number; readyPattern?: RegExp } = {}
  ): Promise<{ $: cheerio.CheerioAPI; html: string }> {
    log.info(`Scraping estático falhou/insuficiente — tentando renderizar com browser headless: ${url}`)
    const html = await renderPageHtml(url, {
      userAgent: useMobileUA ? MOBILE_UA : DESKTOP_UA,
      waitMs: options.waitMs ?? 3500,
      timeoutMs: 25000,
      readyPattern: options.readyPattern,
    })
    return { $: cheerio.load(html), html }
  }

  // Heurística simples pra detectar página de captcha/anti-bot/bloqueio,
  // em vez de deixar o scraper seguir em frente e devolver preço 0 calado.
  private looksBlocked(html: string): boolean {
    if (!html || html.length < 400) return true
    const lower = html.toLowerCase()
    const signals = [
      'captcha',
      'access denied',
      'unusual traffic',
      'verifique que você é humano',
      'are you a robot',
      'just a moment',
      'checking your browser',
      'robot check',
      'validate your request',
      'request blocked',
    ]
    return signals.some((s) => lower.includes(s))
  }

  // Extração de preço em camadas: meta tag -> JSON inline em <script> -> seletor CSS -> texto solto no body.
  // Para de tentar assim que uma camada encontra um valor > 0.
  private extractPrice($: cheerio.CheerioAPI, opts: PriceExtractionOptions): number {
    if (opts.metaSelectors) {
      for (const sel of opts.metaSelectors) {
        const val = $(sel).attr('content')
        if (val) {
          const parsed = this.parsePrice(val)
          if (parsed > 0) return parsed
        }
      }
    }

    if (opts.jsonPatterns && opts.jsonPatterns.length) {
      let found = 0
      $('script').each((_, el) => {
        if (found > 0) return
        const text = $(el).text()
        if (!text || text.length < 30) return
        for (const pattern of opts.jsonPatterns!) {
          const match = text.match(pattern)
          if (match && match[1]) {
            const parsed = this.parsePrice(match[1])
            if (parsed > 0) {
              found = parsed
              break
            }
          }
        }
      })
      if (found > 0) return found
    }

    if (opts.cssSelectors) {
      for (const sel of opts.cssSelectors) {
        const text = $(sel).first().text().trim()
        if (text) {
          const parsed = this.parsePrice(text)
          if (parsed > 0) return parsed
        }
      }
    }

    if (opts.bodyFallback) {
      const bodyText = $('body').text()
      const matches =
        bodyText.match(/R\$\s*[0-9.,]+/g) ||
        bodyText.match(/US\s*\$\s*[0-9.,]+/g) ||
        bodyText.match(/\$\s*[0-9.,]+/g)
      if (matches && matches.length > 0) {
        const parsed = this.parsePrice(matches[0])
        if (parsed > 0) return parsed
      }
    }

    return 0
  }

  private extractShopeeFields($: cheerio.CheerioAPI) {
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').text().trim()

    const price = this.extractPrice($, {
      metaSelectors: ['meta[property="product:price:amount"]'],
      jsonPatterns: [
        /"price":\s*"?([0-9.,]+)"?/i,
        /"priceMin":\s*([0-9.,]+)/,
        /"priceMax":\s*([0-9.,]+)/,
        /"priceBeforeDiscount":\s*([0-9.,]+)/,
      ],
      cssSelectors: ['div[class*="price"]', 'span[class*="price"]', '[class*="Price"]'],
      bodyFallback: true,
    })

    const imageUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('img[class*="product"]').first().attr('src')

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      ''

    return { title, price, imageUrl, description }
  }

  private async scrapeShopee(url: string): Promise<Partial<Product>> {
    // 1ª tentativa: scraping estático (rápido, leve). Shopee é um SPA, então isso
    // costuma falhar, mas é barato demais pra não tentar primeiro.
    let title = '', price = 0, imageUrl: string | undefined, description = ''
    let blocked = false

    try {
      const { $, html } = await this.fetchPage(url, true)
      blocked = this.looksBlocked(html)
      if (!blocked) {
        const extracted = this.extractShopeeFields($)
        title = extracted.title
        price = extracted.price
        imageUrl = extracted.imageUrl
        description = extracted.description
      }
    } catch (err) {
      log.warn('Scraping estático da Shopee falhou:', (err as Error).message)
    }

    // 2ª tentativa: se não veio preço (ou veio bloqueado), renderiza com browser headless
    // (Chromium embutido do Electron) pra deixar o JS da página rodar de verdade.
    if (price === 0) {
      try {
        const { $ } = await this.fetchPageHeadless(url, true)
        const extracted = this.extractShopeeFields($)
        if (extracted.price > 0) {
          title = extracted.title || title
          price = extracted.price
          imageUrl = extracted.imageUrl || imageUrl
          description = extracted.description || description
        }
      } catch (err) {
        log.warn('Fallback headless da Shopee também falhou:', (err as Error).message)
      }
    }

    if (price === 0) {
      throw new Error(
        'Não consegui extrair o preço da Shopee, mesmo com o browser headless (a Shopee pode ' +
        'ter detectado automação, mudado o layout, ou o produto está indisponível). Use o campo ' +
        '"Link de Afiliado Manual" e informe o preço manualmente ao cadastrar o produto.'
      )
    }

    return {
      title: title || 'Produto Shopee',
      price,
      image_url: imageUrl,
      description: description.substring(0, 500),
      original_url: url,
      store: 'shopee',
      source: 'manual',
    }
  }

  private async scrapeMercadoLivre(url: string): Promise<Partial<Product>> {
    const { $, html } = await this.fetchPage(url)

    if (this.looksBlocked(html)) {
      throw new Error('O Mercado Livre bloqueou o acesso (captcha/anti-bot). Tente novamente mais tarde ou insira o produto manualmente.')
    }

    const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim()

    const price = this.extractPrice($, {
      metaSelectors: ['meta[property="product:price:amount"]'],
      cssSelectors: [
        '.andes-money-amount__fraction',
        'span[class*="price"]',
        'div[class*="price"]',
      ],
      bodyFallback: true,
    })

    const imageUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('img[class*="gallery"]').first().attr('src') ||
      $('img').first().attr('src')

    const description = $('meta[property="og:description"]').attr('content') || ''

    if (price === 0) {
      throw new Error(
        'Não consegui extrair o preço do Mercado Livre. Use o campo "Link de Afiliado Manual" ' +
        'e informe o preço manualmente ao cadastrar o produto.'
      )
    }

    return {
      title: title || 'Produto Mercado Livre',
      price,
      image_url: imageUrl,
      description: description.substring(0, 500),
      original_url: url,
      store: 'mercado_livre',
      source: 'manual',
    }
  }

  private async scrapeAmazon(url: string): Promise<Partial<Product>> {
    const { $, html } = await this.fetchPage(url)

    if (this.looksBlocked(html)) {
      throw new Error('A Amazon bloqueou o acesso (captcha/anti-bot). Tente novamente mais tarde ou insira o produto manualmente.')
    }

    const title = $('#productTitle').text().trim() || $('meta[property="og:title"]').attr('content') || ''

    const price = this.extractPrice($, {
      metaSelectors: ['meta[property="product:price:amount"]'],
      cssSelectors: [
        '.a-price .a-offscreen',
        '#corePrice_feature_div .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-offscreen',
        '.a-price-whole',
      ],
      bodyFallback: false,
    })

    const imageUrl = $('#landingImage').attr('src') || $('meta[property="og:image"]').attr('content')
    const description =
      $('#feature-bullets ul').text().trim() || $('meta[name="description"]').attr('content') || ''

    if (price === 0) {
      throw new Error(
        'Não consegui extrair o preço da Amazon. A página pode ter mudado de layout ou você foi ' +
        'bloqueado temporariamente. Use o campo "Link de Afiliado Manual" e informe o preço manualmente.'
      )
    }

    return {
      title: title || 'Produto Amazon',
      price,
      image_url: imageUrl,
      description: description.substring(0, 500),
      original_url: url,
      store: 'amazon',
      source: 'manual',
    }
  }

  private extractAliExpressFields($: cheerio.CheerioAPI, html: string) {
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('h1[data-pl="product-title"]').text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[name="title"]').attr('content') ||
      'Produto AliExpress'

    const price = this.extractPrice($, {
      metaSelectors: ['meta[property="product:price:amount"]'],
      jsonPatterns: [
        /"salePrice":\s*\{\s*"value":\s*([0-9.,]+)/,
        /"skuPrice":\s*"?([0-9.,]+)"?/,
        /"actSkuCalPrice":\s*"?([0-9.,]+)"?/,
        /"minActivityAmount":\s*\{\s*"value":\s*([0-9.,]+)/,
        /"minPrice":\s*"?([0-9.,]+)"?/,
        /"formattedPrice":\s*"([^"]+)"/,
        /"price":\s*"?([0-9.,]+)"?/i,
        /"amount":\s*"?([0-9.,]+)"?/i,
        /"discountPrice":\s*"?([0-9.,]+)"?/i,
        /"promotionPrice":\s*"?([0-9.,]+)"?/i,
      ],
      cssSelectors: [
        '[data-pl="product-price"] .product-price-value',
        '.product-price-current span',
        '.uniform-banner-box-price span',
        '[class*="Price"] [class*="value"]',
        '[class*="price"] [class*="current"]',
        '.es--wrap--erdmPRe span',
        '[class*="price--"]',
        '[class*="ProductPrice"]',
      ],
      bodyFallback: true,
    })

    // Preço original: só usa se achar explicitamente nos scripts da página. Nunca
    // estima/inventa um valor — sem preço original real, o anúncio mostra só o
    // preço atual, sem fingir um desconto que não existe.
    let originalPrice = 0
    $('script').each((_, el) => {
      if (originalPrice > 0) return
      const text = $(el).text()
      if (!text || text.length < 50) return
      const origPatterns = [
        /"minAmount":\s*\{\s*"value":\s*([0-9.,]+)/,
        /"skuOriginalPrice":\s*"?([0-9.,]+)"?/,
        /"originalPrice":\s*"?([0-9.,]+)"?/,
        /"maxPrice":\s*"?([0-9.,]+)"?/,
      ]
      for (const pattern of origPatterns) {
        const match = text.match(pattern)
        if (match && match[1]) {
          const parsed = this.parsePrice(match[1])
          if (parsed > 0) {
            originalPrice = parsed
            break
          }
        }
      }
    })

    const imageUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('img[class*="magnifier"]').first().attr('src') ||
      $('img[class*="gallery"]').first().attr('src') ||
      $('img[class*="main-image"]').first().attr('src') ||
      html.match(/"imageUrl":"(https?:[^"]+)"/)?.[1]

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      ''

    return { title, price, originalPrice, imageUrl, description }
  }

  private async scrapeAliExpress(url: string): Promise<Partial<Product>> {
    let title = '', price = 0, originalPrice = 0, imageUrl: string | undefined, description = ''

    try {
      const { $, html } = await this.fetchPage(url, true)
      if (!this.looksBlocked(html)) {
        const extracted = this.extractAliExpressFields($, html)
        title = extracted.title
        price = extracted.price
        originalPrice = extracted.originalPrice
        imageUrl = extracted.imageUrl
        description = extracted.description
      }
    } catch (err) {
      log.warn('Scraping estático do AliExpress falhou:', (err as Error).message)
    }

    // O AliExpress passou a renderizar a página do produto 100% no cliente
    // (renderMode: "CSR" no HTML — o servidor não manda mais preço nenhum
    // embutido), então o scraping estático quase sempre falha e cai aqui.
    // O headless precisa de um teto de espera maior, com polling até os
    // dados de preço aparecerem no DOM, em vez de uma pausa fixa curta.
    if (price === 0) {
      try {
        const { $, html } = await this.fetchPageHeadless(url, true, {
          waitMs: 9000,
          readyPattern: /salePrice|skuPrice|actSkuCalPrice|minActivityAmount|discountPrice|promotionPrice/,
        })
        const extracted = this.extractAliExpressFields($, html)
        if (extracted.price > 0) {
          title = extracted.title || title
          price = extracted.price
          originalPrice = extracted.originalPrice
          imageUrl = extracted.imageUrl || imageUrl
          description = extracted.description || description
        }
      } catch (err) {
        log.warn('Fallback headless do AliExpress também falhou:', (err as Error).message)
      }
    }

    log.info(`Scrape AliExpress: title="${title?.substring(0, 50)}...", price=${price}, orig=${originalPrice}`)

    if (price === 0) {
      throw new Error(
        'Não consegui extrair o preço do AliExpress, mesmo com o browser headless. Use o campo ' +
        '"Link de Afiliado Manual" e informe o preço manualmente ao cadastrar o produto.'
      )
    }

    return {
      title: title || 'Produto AliExpress',
      price,
      original_price: originalPrice,
      image_url: imageUrl,
      description: description.substring(0, 500),
      original_url: url,
      store: 'aliexpress',
      source: 'manual',
    }
  }

  // NOTA IMPORTANTE sobre searchDeals (busca automática por nicho):
  // os seletores CSS abaixo (.promotion-item, [data-sqe="item"], .multi--titleText--, etc.)
  // são "chutes" contra o HTML atual de cada site. Sites de e-commerce mudam o front-end com
  // frequência, então é normal essa função parar de achar resultados de tempos em tempos —
  // isso NÃO é um bug de lógica, é a natureza frágil de scraping sem API oficial de busca.
  // Se a busca automática parar de trazer resultados, o primeiro passo é inspecionar o HTML
  // atual da página de busca/ofertas da loja e atualizar os seletores correspondentes.
  async searchDeals(niche: string, store: string): Promise<Partial<Product>[]> {
    const keywords = niche.split(',').map((k) => k.trim()).filter(Boolean)
    if (keywords.length === 0) return []

    const results: Partial<Product>[] = []

    try {
      switch (store) {
        case 'amazon': {
          const amazonUrl = `https://www.amazon.com.br/deals`
          const { $: $amazon } = await this.fetchPage(amazonUrl)
          $amazon('[data-testid="deal-card"]').each((_, el) => {
            const title = $amazon(el).find('[data-testid="product-title"]').text().trim()
            const priceText = $amazon(el).find('.a-price .a-offscreen').first().text()
            const price = this.parsePrice(priceText || '')
            const imageUrl = $amazon(el).find('img').first().attr('src')
            const link = $amazon(el).find('a').first().attr('href')
            if (title && link) {
              const fullUrl = link.startsWith('http') ? link : `https://www.amazon.com.br${link}`
              const matchesNiche = keywords.some((k) => title.toLowerCase().includes(k.toLowerCase()))
              if (matchesNiche) {
                results.push({
                  title,
                  price,
                  image_url: imageUrl,
                  description: humanizeDescription({ title, store: 'amazon', price }),
                  original_url: fullUrl,
                  store: 'amazon',
                  source: 'manual',
                })
              }
            }
          })
          break
        }

        case 'mercado_livre': {
          const mlUrl = `https://www.mercadolivre.com.br/ofertas`
          const { $: $ml } = await this.fetchPage(mlUrl)
          $ml('.promotion-item').each((_, el) => {
            const title = $ml(el).find('.promotion-item__title').text().trim()
            const priceText = $ml(el).find('.promotion-item__price').text()
            const price = this.parsePrice(priceText || '')
            const imageUrl = $ml(el).find('img').first().attr('data-src') || $ml(el).find('img').first().attr('src')
            const link = $ml(el).find('a').first().attr('href')
            if (title && link) {
              const matchesNiche = keywords.some((k) => title.toLowerCase().includes(k.toLowerCase()))
              if (matchesNiche) {
                results.push({
                  title,
                  price,
                  image_url: imageUrl,
                  description: humanizeDescription({ title, store: 'mercado_livre', price }),
                  original_url: link,
                  store: 'mercado_livre',
                  source: 'manual',
                })
              }
            }
          })
          break
        }

        case 'shopee': {
          for (const keyword of keywords.slice(0, 2)) {
            const shopeeUrl = `https://shopee.com.br/search?keyword=${encodeURIComponent(keyword)}&sortBy=sales`
            try {
              const { $: $shopee } = await this.fetchPage(shopeeUrl, true)
              $shopee('[data-sqe="item"]').slice(0, 5).each((_, el) => {
                const title = $shopee(el).find('[data-sqe="name"]').text().trim()
                const priceText = $shopee(el).find('[data-sqe="price"]').text()
                const price = this.parsePrice(priceText || '')
                const imageUrl = $shopee(el).find('img').first().attr('src')
                const link = $shopee(el).find('a').first().attr('href')
                if (title && link) {
                  const fullUrl = link.startsWith('http') ? link : `https://shopee.com.br${link}`
                  results.push({
                    title,
                    price,
                    image_url: imageUrl,
                    description: humanizeDescription({ title, store: 'shopee', price }),
                    original_url: fullUrl,
                    store: 'shopee',
                    source: 'manual',
                  })
                }
              })
            } catch (e) {
              log.warn(`Erro ao buscar Shopee para "${keyword}":`, e)
            }
          }
          break
        }

        case 'aliexpress': {
          for (const keyword of keywords.slice(0, 2)) {
            const aliUrl = `https://pt.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keyword)}&sortType=total_tranpro_desc`
            try {
              const { $: $ali } = await this.fetchPage(aliUrl, true)
              $ali('[data-product-id]').slice(0, 5).each((_, el) => {
                const title = $ali(el).find('.multi--titleText--').text().trim()
                const priceText = $ali(el).find('.multi--price--').text()
                const price = this.parsePrice(priceText || '')
                const imageUrl = $ali(el).find('img').first().attr('src')
                const link = $ali(el).find('a').first().attr('href')
                if (title && link) {
                  const fullUrl = link.startsWith('http') ? link : `https:${link}`
                  results.push({
                    title,
                    price,
                    image_url: imageUrl,
                    description: humanizeDescription({ title, store: 'aliexpress', price }),
                    original_url: fullUrl,
                    store: 'aliexpress',
                    source: 'manual',
                  })
                }
              })
            } catch (e) {
              log.warn(`Erro ao buscar AliExpress para "${keyword}":`, e)
            }
          }
          break
        }
      }
    } catch (error) {
      log.error(`Erro ao buscar ofertas ${store}:`, error)
    }

    const seen = new Set<string>()
    return results.filter((p) => {
      if (seen.has(p.original_url!)) return false
      seen.add(p.original_url!)
      return true
    })
  }

  private parsePrice(priceText: string): number {
    if (!priceText) return 0
    let cleaned = priceText.replace(/R\$|\$|EUR|USD|BRL|€|£|¥/gi, '').replace(/\s/g, '')

    const commaIndex = cleaned.lastIndexOf(',')
    const dotIndex = cleaned.lastIndexOf('.')

    if (commaIndex > dotIndex) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.')
    } else if (dotIndex > commaIndex) {
      cleaned = cleaned.replace(/,/g, '')
    } else if (commaIndex !== -1 && dotIndex === -1) {
      const afterComma = cleaned.substring(commaIndex + 1)
      if (afterComma.length <= 2) {
        cleaned = cleaned.replace(',', '.')
      } else {
        cleaned = cleaned.replace(/,/g, '')
      }
    }

    cleaned = cleaned.replace(/[^0-9.]/g, '')
    const price = parseFloat(cleaned)
    return isNaN(price) || price <= 0 ? 0 : price
  }
}
