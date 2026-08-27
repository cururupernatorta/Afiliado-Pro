import axios from 'axios'
import * as cheerio from 'cheerio'
import log from 'electron-log'
import { AffiliateManager } from './affiliate'
import { DatabaseManager, Product } from './database'
import { renderPageHtml } from './headlessScraper'
import { ML_PARTITION } from './mercadoLivreSession'
import { MercadoLivreApi } from './mercadoLivreApi'
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
  private dbManager: DatabaseManager
  private mercadoLivreApi: MercadoLivreApi

  constructor(affiliateManager: AffiliateManager, dbManager: DatabaseManager) {
    this.affiliateManager = affiliateManager
    this.dbManager = dbManager
    this.mercadoLivreApi = new MercadoLivreApi(dbManager)
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
    options: { waitMs?: number; readyPattern?: RegExp; partition?: string } = {}
  ): Promise<{ $: cheerio.CheerioAPI; html: string }> {
    log.info(`Scraping estático falhou/insuficiente — tentando renderizar com browser headless: ${url}`)
    const html = await renderPageHtml(url, {
      userAgent: useMobileUA ? MOBILE_UA : DESKTOP_UA,
      waitMs: options.waitMs ?? 3500,
      timeoutMs: 25000,
      readyPattern: options.readyPattern,
      partition: options.partition,
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
      // Mercado Livre: em vez de captcha, ele redireciona pra uma página de
      // "verificação de conta" com HTTP 200 e nenhum dado do produto —
      // confirmado ao vivo. Sem esses sinais, o scraper seguia em frente,
      // achava preço 0 e culpava o layout da página ("não consegui extrair o
      // preço"), escondendo que o acesso é que foi barrado.
      'suspicious-traffic',
      'account-verification',
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

  private extractMercadoLivreFields($: cheerio.CheerioAPI) {
    const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim()
    const price = this.extractPrice($, {
      metaSelectors: ['meta[property="product:price:amount"]'],
      jsonPatterns: [/"price":\s*"?([0-9.,]+)"?/i],
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
    return { title, price, imageUrl, description }
  }

  private async scrapeMercadoLivre(url: string): Promise<Partial<Product>> {
    // API oficial primeiro: a raspagem da página do produto vem sendo barrada
    // por uma página de verificação de tráfego (confirmado ao vivo, inclusive
    // com sessão logada e navegador real), enquanto a API não sofre isso.
    // Só cai pra raspagem se a API não estiver configurada ou falhar.
    const fromApi = await this.mercadoLivreApi.fetchProduct(url)
    if (fromApi) {
      log.info(`Produto do Mercado Livre obtido pela API oficial: ${fromApi.title}`)
      return fromApi
    }

    let title = '', price = 0, imageUrl: string | undefined, description = ''
    let blocked = false

    try {
      const { $, html } = await this.fetchPage(url)
      blocked = this.looksBlocked(html)
      if (!blocked) {
        const extracted = this.extractMercadoLivreFields($)
        title = extracted.title
        price = extracted.price
        imageUrl = extracted.imageUrl
        description = extracted.description
      }
    } catch (err) {
      log.warn('Scraping estático do Mercado Livre falhou:', (err as Error).message)
    }

    // 2ª tentativa com browser de verdade, reusando a sessão logada do
    // Mercado Livre (Conexões). Confirmado ao vivo que o ML responde a
    // requisição simples com uma página de "tráfego suspeito" em vez do
    // produto; um navegador com a sessão real do usuário é bem menos provável
    // de ser barrado assim. Se o usuário não tiver logado, a partição só está
    // vazia — continua funcionando como um headless comum.
    if (price === 0) {
      try {
        const { $, html } = await this.fetchPageHeadless(url, false, { partition: ML_PARTITION })
        if (!this.looksBlocked(html)) {
          const extracted = this.extractMercadoLivreFields($)
          if (extracted.price > 0) {
            title = extracted.title || title
            price = extracted.price
            imageUrl = extracted.imageUrl || imageUrl
            description = extracted.description || description
            blocked = false
          }
        } else {
          blocked = true
        }
      } catch (err) {
        log.warn('Fallback headless do Mercado Livre também falhou:', (err as Error).message)
      }
    }

    if (price === 0 && blocked) {
      throw new Error(
        'O Mercado Livre bloqueou o acesso automático (página de verificação de conta / tráfego suspeito). ' +
        'Faça login do Mercado Livre em Conexões — isso costuma resolver — ou informe o preço manualmente.'
      )
    }

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
    // O bloco <script type="application/ld+json"> (dados estruturados Product,
    // schema.org — mantido pela AliExpress pra SEO/rich snippets) é bem mais
    // confiável que og:title/og:image ou classes CSS: confirmado ao vivo que
    // og:image na verdade aponta pra uma imagem placeholder genérica
    // (".../HTB18eCBQXXXXXXfXXXX760XFXXXa.png" — o "XXXX" é literal, é o
    // placeholder padrão deles) e as classes antigas (magnifier/gallery/
    // main-image) não existem mais na página atual.
    // schema.org permite @type como array (não só string) e image como
    // ImageObject ({url: "..."}) além de string — sem tratar essas duas
    // variações, JSON-LD "meio-falha" calado em algumas páginas e cai pro
    // fallback mais fraco sem nenhum aviso.
    const hasProductType = (type: unknown): boolean =>
      Array.isArray(type) ? type.includes('Product') : type === 'Product'
    const imageFieldToUrl = (img: unknown): string | undefined => {
      if (typeof img === 'string') return img
      if (Array.isArray(img)) return imageFieldToUrl(img[0])
      if (img && typeof img === 'object' && typeof (img as any).url === 'string') return (img as any).url
      return undefined
    }

    let jsonLdTitle: string | undefined
    let jsonLdImage: string | undefined
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdTitle && jsonLdImage) return
      try {
        const parsed = JSON.parse($(el).html() || '')
        // Alguns sites embrulham os nós tipados num "@graph" em vez de um
        // array solto ou objeto único — sem isso, um Product lá dentro nunca
        // era encontrado.
        const items = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.['@graph'])
            ? parsed['@graph']
            : [parsed]
        for (const item of items) {
          if (!hasProductType(item?.['@type'])) continue
          if (!jsonLdTitle && typeof item.name === 'string') jsonLdTitle = item.name
          if (!jsonLdImage) jsonLdImage = imageFieldToUrl(item.image)
        }
      } catch {
        // dados estruturados malformados nessa página — segue pros fallbacks abaixo
      }
    })

    // Placeholder da AliExpress sempre tem uma sequência longa de "X" literal no
    // nome do arquivo — filtra isso de QUALQUER candidato (JSON-LD incluído: já
    // confirmamos que og:image pode ser placeholder, não custa desconfiar dos
    // outros também em vez de confiar cegamente só porque veio de outro lugar).
    const isPlaceholderImage = (src?: string) => !src || /X{5,}/.test(src)

    const title =
      jsonLdTitle ||
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
      // Sem bodyFallback aqui de propósito: numa página bloqueada/redirecionada
      // (que não é o produto real), o body inteiro pode ter QUALQUER "R$ X" —
      // banner de frete grátis, carrossel de recomendados, conversor de moeda —
      // e isso já causou captura de produto fantasma (título genérico + preço de
      // outra coisa). Melhor falhar alto e pedir cadastro manual do que inventar.
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

    const imageCandidates = [
      jsonLdImage,
      $('meta[property="og:image"]').attr('content'),
      $('img[class*="magnifier"]').first().attr('src'),
      $('img[class*="gallery"]').first().attr('src'),
      $('img[class*="main-image"]').first().attr('src'),
      html.match(/"imageUrl":"(https?:[^"]+)"/)?.[1],
    ]
    const imageUrl = imageCandidates.find((c) => c && !isPlaceholderImage(c))

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      ''

    return { title, price, originalPrice, imageUrl, description }
  }

  private async scrapeAliExpress(rawUrl: string): Promise<Partial<Product>> {
    let title = '', price = 0, originalPrice = 0, imageUrl: string | undefined, description = ''
    // Trilha de diagnóstico: quando isso falha em produção não tem como reproduzir
    // localmente (rede/IP/sessão diferentes do usuário) — sem isso, cada falha só
    // dá o alerta genérico e nenhuma pista de qual etapa realmente travou. Registrado
    // como log de erro no app (visível em Logs) só quando o resultado final falha.
    const trail: string[] = []

    // Link curto (s.click.aliexpress.com, a.aliexpress.com) renderizado direto com
    // user-agent mobile costuma cair numa página genérica de "melhores ofertas" em
    // vez do produto — resolve pro link canônico do produto primeiro, com o mesmo
    // resolvedor já usado na geração do link de afiliado (que usa UA desktop e
    // também revela quando o link já está morto/expirado).
    let url = rawUrl
    try {
      url = await this.affiliateManager.resolveAliExpressUrl(rawUrl)
      if (url !== rawUrl) trail.push(`resolvido: ${rawUrl} -> ${url}`)
    } catch (err) {
      trail.push(`resolução de link falhou, usando original: ${(err as Error).message}`)
    }

    // O AliExpress renderiza a página do produto 100% no cliente (renderMode:
    // "CSR" — confirmado ao vivo repetidas vezes que o HTML estático nunca
    // tem preço/título nenhum, só um shell vazio). Tentar o fetch estático
    // primeiro era só uma requisição inteira jogada fora em toda captura —
    // pula direto pro headless, que é o único caminho que já funcionava.
    trail.push('estático: pulado (AliExpress é 100% CSR, sempre falha)')

    // O headless precisa de um teto de espera, com polling até os dados de
    // preço aparecerem no DOM, em vez de uma pausa fixa.
    try {
      // Os campos JSON antigos (salePrice, skuPrice...) já não aparecem mais em
      // várias páginas de produto — o React app atual só desenha "R$X,XX" direto
      // num span com classe gerada. Sem esse padrão como alternativa, o polling
      // nunca detectava "pronto" e sempre esperava o teto inteiro, cortando a
      // renderização antes da hora em conexões mais lentas.
      const readyPattern = /salePrice|skuPrice|actSkuCalPrice|minActivityAmount|discountPrice|promotionPrice|R\$\s?\d/
      const { $, html } = await this.fetchPageHeadless(url, true, { waitMs: 12000, readyPattern })
      const matched = readyPattern.test(html)
      const extracted = this.extractAliExpressFields($, html)
      trail.push(`headless: sinal de "pronto" encontrado=${matched}, preço extraído=${extracted.price}, ${html.length} bytes`)
      if (extracted.price > 0) {
        title = extracted.title || title
        price = extracted.price
        originalPrice = extracted.originalPrice
        imageUrl = extracted.imageUrl || imageUrl
        description = extracted.description || description
      }
    } catch (err) {
      trail.push(`headless: erro — ${(err as Error).message}`)
      log.warn('Fallback headless do AliExpress também falhou:', (err as Error).message)
    }

    log.info(`Scrape AliExpress: title="${title?.substring(0, 50)}...", price=${price}, orig=${originalPrice}`)

    if (price === 0) {
      try {
        this.dbManager.addLog({
          type: 'error',
          platform: 'system',
          message: 'Falha ao extrair produto do AliExpress',
          details: trail.join(' | '),
        })
      } catch (err) {
        log.warn('Erro ao registrar log de diagnóstico do AliExpress:', err)
      }
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
        // Seletores conferidos ao vivo contra o HTML atual do site (2026-08-19).
        // Amazon mudou de data-testid="deal-card" pra classes dcl-* (Deals Carousel).
        case 'amazon': {
          const amazonUrl = `https://www.amazon.com.br/deals`
          const { $: $amazon } = await this.fetchPage(amazonUrl)
          $amazon('.a-carousel-card').each((_, el) => {
            const title = $amazon(el).find('.dcl-product-label').first().text().trim()
            const price = this.parsePrice($amazon(el).find('.dcl-product-price-new .a-offscreen').first().text())
            const originalPrice = this.parsePrice($amazon(el).find('.dcl-product-price-old .a-offscreen').first().text())
            const imageUrl = $amazon(el).find('.dcl-dynamic-image').first().attr('src')
            const link = $amazon(el).find('.dcl-product-link').first().attr('href')
            // A página "deals" da Amazon lista o carrossel inteiro, não só o que tem
            // desconto de verdade — sem exigir originalPrice > price aqui (e não só na
            // hora de formatar o texto), qualquer produto do carrossel virava "oferta"
            // pro usuário, inclusive coisa com preço normal ou mais caro que o normal.
            if (title && link && price > 0 && originalPrice > price) {
              const fullUrl = link.startsWith('http') ? link : `https://www.amazon.com.br${link}`
              const matchesNiche = keywords.some((k) => title.toLowerCase().includes(k.toLowerCase()))
              if (matchesNiche) {
                results.push({
                  title,
                  price,
                  original_price: originalPrice,
                  image_url: imageUrl,
                  description: humanizeDescription({ title, store: 'amazon', price, original_price: originalPrice }),
                  original_url: fullUrl,
                  store: 'amazon',
                  source: 'manual',
                })
              }
            }
          })
          break
        }

        // Mercado Livre migrou os cards de oferta pro componente "poly-card".
        case 'mercado_livre': {
          const mlUrl = `https://www.mercadolivre.com.br/ofertas`
          const { $: $ml } = await this.fetchPage(mlUrl)
          $ml('.poly-card').each((_, el) => {
            const titleEl = $ml(el).find('a.poly-component__title').first()
            const title = titleEl.text().trim()
            const link = titleEl.attr('href')
            const price = this.parsePrice($ml(el).find('.poly-price__current .andes-money-amount__fraction').first().text())
            const originalPrice = this.parsePrice($ml(el).find('.poly-price__labels .andes-money-amount__fraction').first().text())
            const imageUrl = $ml(el).find('.poly-component__picture').first().attr('src')
            // Mesma lógica da Amazon: a página "ofertas" lista muita coisa sem desconto
            // real — só captura se o preço riscado for de fato maior que o atual.
            if (title && link && price > 0 && originalPrice > price) {
              const matchesNiche = keywords.some((k) => title.toLowerCase().includes(k.toLowerCase()))
              if (matchesNiche) {
                results.push({
                  title,
                  price,
                  original_price: originalPrice,
                  image_url: imageUrl,
                  description: humanizeDescription({ title, store: 'mercado_livre', price, original_price: originalPrice }),
                  original_url: link,
                  store: 'mercado_livre',
                  source: 'manual',
                })
              }
            }
          })
          break
        }

        // A busca da Shopee bloqueia (captcha) requisição estática direta — precisa
        // do fallback headless (mesma técnica usada no scraping de produto único).
        case 'shopee': {
          for (const keyword of keywords.slice(0, 2)) {
            const shopeeUrl = `https://shopee.com.br/search?keyword=${encodeURIComponent(keyword)}&sortBy=sales`
            try {
              const { $: $shopee, html } = await this.fetchPageHeadless(shopeeUrl, true, {
                waitMs: 7000,
                readyPattern: /data-sqe="item"/,
              })
              const items = $shopee('[data-sqe="item"]')
              let found = 0
              items.slice(0, 5).each((_, el) => {
                const title = $shopee(el).find('[data-sqe="name"]').text().trim()
                const priceText = $shopee(el).find('[data-sqe="price"]').text()
                const price = this.parsePrice(priceText || '')
                const imageUrl = $shopee(el).find('img').first().attr('src')
                const link = $shopee(el).find('a').first().attr('href')
                if (title && link && price > 0) {
                  found++
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
              // A página pode carregar sem exceção nenhuma (bloqueio/captcha não
              // sempre joga erro) e o seletor simplesmente não achar nada — antes
              // isso ficava mudo, sem log nenhum visível em Logs, diferente do
              // AliExpress que já tem essa instrumentação.
              if (found === 0) {
                const blocked = this.looksBlocked(html)
                const trail = `bloqueado=${blocked}, itens no seletor=${items.length}, ${html.length} bytes`
                log.warn(`Shopee: sem ofertas pra "${keyword}" — ${trail}`)
                this.dbManager.addLog({
                  type: 'warning',
                  platform: 'system',
                  message: `Shopee: busca de ofertas não retornou produtos pra "${keyword}"`,
                  details: trail,
                })
              }
            } catch (e) {
              log.warn(`Erro ao buscar Shopee para "${keyword}":`, e)
              this.dbManager.addLog({
                type: 'error',
                platform: 'system',
                message: `Erro ao buscar ofertas Shopee para "${keyword}"`,
                details: (e as Error).message,
              })
            }
          }
          break
        }

        // Busca via API oficial de afiliado, não raspagem — ver comentário em
        // affiliate.ts's queryAliExpressDeals pro porquê (busca raspada é
        // fragilíssima, bloqueia com captcha, e nunca filtrava desconto real).
        case 'aliexpress': {
          const deals = await this.affiliateManager.queryAliExpressDeals(keywords)
          for (const deal of deals) {
            results.push({
              title: deal.title,
              price: deal.price,
              original_price: deal.original_price,
              image_url: deal.image_url,
              description: humanizeDescription({
                title: deal.title,
                store: 'aliexpress',
                price: deal.price,
                original_price: deal.original_price,
              }),
              original_url: deal.original_url,
              store: 'aliexpress',
              source: 'manual',
            })
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
      // Sem vírgula nenhuma e o ponto separa grupos de exatos 3 dígitos (ex: "2.209",
      // "1.234.567") — é separador de milhar do formato BR, não decimal. Confirmado
      // testando ao vivo contra o Mercado Livre: preço "2.209" virava 2,209 sem isso.
      const afterLastDot = cleaned.substring(cleaned.lastIndexOf('.') + 1)
      const looksLikeThousands = commaIndex === -1 && afterLastDot.length === 3 && /^\d{1,3}(\.\d{3})+$/.test(cleaned)
      cleaned = looksLikeThousands ? cleaned.replace(/\./g, '') : cleaned.replace(/,/g, '')
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
