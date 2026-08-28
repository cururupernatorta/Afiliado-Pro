import { DatabaseManager } from './database'
import { QueueManager } from './queue'
import log from 'electron-log'

export interface ProductLike {
  id?: number
  title: string
  price: number
  original_price?: number
  affiliate_url?: string
  original_url: string
  store: string
  description?: string
  image_path?: string
}

export interface FormatMessageExtra {
  groupLink?: string
  coupon?: string
}

// Usado sempre que um grupo/envio não tem nenhum template da biblioteca associado.
export const DEFAULT_TEMPLATE_TEXT =
  '*{title}*\n\n💰 {price_line}\n\n📝 {description}\n\n🔗 {affiliate_url}\n\n⚡ Corra antes que acabe!\n\n👥 Entre no nosso grupo de ofertas: {group_link}'

// Só mostra "De X por Y" quando existe um preço original real e maior que o
// atual. Nunca inventa um preço original (ex.: preço x 1.3) — anúncio com
// desconto fake é o tipo de dado que o produto promete nunca fabricar.
function buildPriceLine(price: number, originalPrice?: number): string {
  const hasRealDiscount = typeof originalPrice === 'number' && originalPrice > price
  // Tachado no WhatsApp é ~assim~, com UM til. Com dois (~~assim~~, que é a
  // sintaxe do Markdown) o WhatsApp usa o primeiro e o último como
  // delimitadores e mostra os tis restantes no meio do texto — o preço saía
  // riscado mas com um "~" grudado de cada lado.
  return hasRealDiscount
    ? `De ~R$ ${originalPrice!.toFixed(2)}~ por *R$ ${price.toFixed(2)}*`
    : `*R$ ${price.toFixed(2)}*`
}

export function formatMessage(product: ProductLike, templateText: string, extra: FormatMessageExtra = {}): string {
  const hasRealDiscount = typeof product.original_price === 'number' && product.original_price > product.price

  return templateText
    .replace(/{title}/g, product.title)
    .replace(/{price}/g, product.price.toFixed(2))
    .replace(/{original_price}/g, hasRealDiscount ? product.original_price!.toFixed(2) : '')
    .replace(/{price_line}/g, buildPriceLine(product.price, product.original_price))
    .replace(/{affiliate_url}/g, product.affiliate_url || product.original_url)
    .replace(/{original_url}/g, product.original_url)
    .replace(/{store}/g, product.store)
    .replace(/{description}/g, (product.description || '').substring(0, 200))
    .replace(/{coupon}/g, extra.coupon || '')
    .replace(/{group_link}/g, extra.groupLink || '')
}

export async function autoRepostProduct(
  product: ProductLike,
  sourcePlatform: 'whatsapp' | 'telegram',
  dbManager: DatabaseManager,
  queueManager: QueueManager
): Promise<void> {
  try {
    const config = dbManager.getConfig()
    if (!config.auto_repost_enabled) return

    const targets = dbManager.getEnabledAutoSendTargets(sourcePlatform)
    if (targets.length === 0) return

    log.info(`Auto-repost: enviando produto "${product.title}" para ${targets.length} grupo(s) ${sourcePlatform}`)

    let delay = 0
    for (const target of targets) {
      const template = dbManager.getAdTemplate(sourcePlatform, target.group_id)
      const templateText = template?.template_text ?? DEFAULT_TEMPLATE_TEXT

      const formattedMessage = formatMessage(product, templateText, { groupLink: config.group_link })
      const delayMs = delay * 1000 * (config.min_delay_seconds + Math.random() * (config.max_delay_seconds - config.min_delay_seconds))
      delay++

      await queueManager.addJob({
        platform: sourcePlatform,
        groupId: target.group_id,
        productId: product.id!,
        productTitle: formattedMessage,
        productPrice: product.price,
        productImagePath: product.image_path,
        affiliateUrl: product.affiliate_url || product.original_url,
      }, delayMs)
    }

    // "Adicionado à fila", não "enviado": o envio de verdade só é confirmado
    // pelo log "Produto enviado" que a fila registra depois de cada job
    // processado com sucesso — essa entrada aqui só significa que os jobs
    // foram criados, não que já chegaram no grupo.
    dbManager.addLog({
      type: 'info',
      platform: sourcePlatform,
      message: `Auto-repost: ${product.title} adicionado à fila para ${targets.length} grupo(s)`,
      details: `Plataforma: ${sourcePlatform}`,
    })
  } catch (error) {
    log.error('Erro no auto-repost:', error)
  }
}
