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

export function formatMessage(product: ProductLike, templateText: string): string {
  const originalPrice = product.original_price && product.original_price > product.price
    ? product.original_price.toFixed(2)
    : (product.price * 1.3).toFixed(2)

  return templateText
    .replace(/{title}/g, product.title)
    .replace(/{price}/g, product.price.toFixed(2))
    .replace(/{original_price}/g, originalPrice)
    .replace(/{affiliate_url}/g, product.affiliate_url || product.original_url)
    .replace(/{original_url}/g, product.original_url)
    .replace(/{store}/g, product.store)
    .replace(/{description}/g, product.description || '')
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
      const templateText = template?.template_text ||
        '*{title}*\n\n💰 De ~~R$ {original_price}~~ por *R$ {price}*\n\n🔗 {affiliate_url}\n\n⚡ Corra antes que acabe!'

      const formattedMessage = formatMessage(product, templateText)
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

    dbManager.addLog({
      type: 'info',
      platform: sourcePlatform,
      message: `Auto-repost: ${product.title} enviado para ${targets.length} grupo(s)`,
      details: `Plataforma: ${sourcePlatform}`,
    })
  } catch (error) {
    log.error('Erro no auto-repost:', error)
  }
}
