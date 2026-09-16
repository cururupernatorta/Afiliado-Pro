import { DatabaseManager } from './database'
import { QueueManager } from './queue'
import log from 'electron-log'
import { formatMessage, DEFAULT_TEMPLATE_TEXT } from './messageFormat'
import type { ProductLike } from './messageFormat'

// A montagem do texto mora em messageFormat.ts, que não depende do Electron:
// o editor de templates usa a mesma função para a prévia. Reexportado daqui
// para quem já importava deste arquivo.
export { formatMessage, DEFAULT_TEMPLATE_TEXT, porcentagemDeDesconto } from './messageFormat'
export type { ProductLike, FormatMessageExtra } from './messageFormat'

/**
 * Decide se um produto combina com o nicho de um grupo de destino.
 *
 * Grupo sem nicho definido recebe tudo — é como o app se comportava antes
 * deste campo existir, e continua sendo o padrão pra quem tem um grupo só.
 * Com nicho preenchido, o produto precisa casar com alguma das palavras.
 */
export function matchesGroupNiche(title: string, niche?: string | null): boolean {
  const keywords = (niche ?? '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
  if (keywords.length === 0) return true
  const lower = title.toLowerCase()
  return keywords.some((k) => lower.includes(k))
}

/**
 * Palavras que costumam vir logo depois de "cupom" e NÃO são o código.
 *
 * Sem esta lista, "cupom de desconto na página" virava o cupom "DESCONTO", e o
 * anúncio sairia mandando o cliente digitar uma palavra que não existe.
 */
const PALAVRAS_QUE_NAO_SAO_CUPOM = new Set([
  'DE', 'DO', 'DA', 'NO', 'NA', 'EM', 'COM', 'PARA', 'POR', 'ATE', 'MAIS', 'AQUI', 'LINK', 'ABAIXO',
  'ACIMA', 'DENTRO', 'DESCONTO', 'DESCONTOS', 'EXCLUSIVO', 'EXCLUSIVA', 'PROMOCAO', 'PRIMEIRA',
  'COMPRA', 'VALIDO', 'LIMITADO', 'PAGINA', 'PRODUTO', 'LOJA', 'APENAS', 'GRATIS', 'FRETE', 'HOJE',
  'SIM', 'NAO', 'DISPONIVEL', 'APLICADO', 'APLICAR', 'SELECIONE', 'CLIQUE', 'OFERTA', 'RESGATE',
  'EXTRA', 'SOME', 'TODOS', 'ESSE', 'ESTE', 'SEU', 'SUA', 'USE', 'USAR', 'VAI', 'CAI',
])

/**
 * Procura um código de cupom no texto da mensagem capturada.
 *
 * Os canais concorrentes escrevem o cupom no próprio anúncio ("use o cupom
 * TECH20"), e esse texto é o mesmo de onde o app já tira a URL — então o cupom
 * está à mão, sem depender de API de loja nenhuma.
 *
 * Conservador de propósito: um cupom inventado é pior que nenhum, porque o
 * cliente tenta, não funciona, e a culpa fica no anúncio. Só aceita o que tem
 * cara de código (maiúsculas ou com número), rejeita palavra comum e desiste
 * assim que o texto deixa de parecer código.
 */
export function extrairCupomDoTexto(texto: string): string | null {
  const t = String(texto || '')
  const marcador = /cupom|cupon|coupon/gi
  let achado: RegExpExecArray | null
  while ((achado = marcador.exec(t))) {
    const depois = t.slice(achado.index + achado[0].length, achado.index + achado[0].length + 60)
    const tokens = depois.split(/[\s:;,|>\-–—]+/).filter(Boolean).slice(0, 4)
    for (const bruto of tokens) {
      // Tira emoji e pontuação grudada ("👉TECH15", "PROMO10!").
      const token = bruto.replace(/[^\p{L}\p{N}._-]/gu, '')
      if (!token) continue
      const alto = token.toUpperCase()
      if (PALAVRAS_QUE_NAO_SAO_CUPOM.has(alto)) continue
      // Deixou de parecer código: para nesta ocorrência em vez de sair catando
      // palavra solta no meio da frase.
      if (!/^[A-Z0-9][A-Z0-9._-]{2,19}$/.test(alto)) break
      // Só número é valor ("cupom de 20"), não código.
      if (!/[A-Z]/.test(alto)) break
      // Texto em minúsculas no meio da frase quase nunca é cupom; com número
      // ("promo10") é.
      if (token !== alto && !/\d/.test(token)) break
      return alto
    }
  }
  return null
}

export async function autoRepostProduct(
  product: ProductLike,
  sourcePlatform: 'whatsapp' | 'telegram',
  dbManager: DatabaseManager,
  queueManager: QueueManager,
  /**
   * Produto recorrente: repetir E o objetivo, entao a barreira de anuncio
   * repetido tem que sair do caminho. So esta chamada a ignora — a captura
   * normal continua protegida, senao voltariamos a inundar o grupo com a
   * mesma oferta a cada reentrega de lote.
   */
  opcoes?: { ignorarRepetido?: boolean }
): Promise<void> {
  try {
    const config = dbManager.getConfig()
    if (!config.auto_repost_enabled) return

    const todosOsGrupos = dbManager.getEnabledAutoSendTargets(sourcePlatform)
    if (todosOsGrupos.length === 0) return

    // Cada grupo de destino pode ter nicho próprio. Antes, todo produto ia
    // para todos os grupos — quem tinha grupos de assuntos diferentes recebia
    // tudo em todos. Grupo sem nicho continua recebendo tudo.
    const targets = todosOsGrupos.filter((t) => matchesGroupNiche(product.title, t.niche))
    if (targets.length === 0) {
      log.info(`Auto-repost: "${product.title}" não combina com o nicho de nenhum grupo de destino`)
      return
    }

    const ignorados = todosOsGrupos.length - targets.length
    log.info(
      `Auto-repost: enviando produto "${product.title}" para ${targets.length} grupo(s) ${sourcePlatform}` +
        (ignorados > 0 ? ` (${ignorados} fora do nicho)` : '')
    )

    let delay = 0
    let jaEnviados = 0
    for (const target of targets) {
      // Barreira contra anúncio repetido. Só vale para o repost automático —
      // o envio manual continua livre, porque ali a repetição é escolha do
      // usuário, não acidente.
      if (!opcoes?.ignorarRepetido && product.id) {
        if (dbManager.produtoJaEnviadoAoGrupo(sourcePlatform, target.group_id, product.id)) {
          jaEnviados++
          continue
        }

        // Mesmo produto já esperando na fila para este grupo. O histórico só é
        // gravado depois que a mensagem sai, então ele não enxerga isto.
        if (queueManager.temEnvioPendente(sourcePlatform, target.group_id, product.id)) {
          jaEnviados++
          continue
        }

        // Produto diferente no banco, mesmo anúncio na prática: outro grupo
        // monitorado postou o mesmo aparelho por um anúncio que a loja trata
        // como outro produto.
        const parecido = dbManager.anuncioParecidoEnviado(sourcePlatform, target.group_id, product.title, product.price)
        if (parecido) {
          jaEnviados++
          dbManager.addLog({
            type: 'info',
            platform: sourcePlatform,
            message: `Anúncio repetido evitado: ${product.title}`,
            details:
              `Este grupo já recebeu o mesmo produto em ${parecido.sent_at} por R$ ${Number(parecido.price).toFixed(2)}. ` +
              `Agora está R$ ${product.price.toFixed(2)} — só sai de novo se o preço cair mais de 10%.`,
          })
          continue
        }
      }

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
    const enfileirados = targets.length - jaEnviados
    if (enfileirados === 0) {
      // Silêncio aqui seria pior que a repetição que estamos evitando: sem
      // essa linha, o usuário vê a oferta ser encontrada e nada acontecer.
      dbManager.addLog({
        type: 'info',
        platform: sourcePlatform,
        message: `Anúncio repetido evitado: ${product.title}`,
        details: `Este produto já tinha sido enviado para ${jaEnviados === 1 ? 'o grupo de destino' : `os ${jaEnviados} grupos de destino`}.`,
      })
      return
    }

    dbManager.addLog({
      type: 'info',
      platform: sourcePlatform,
      message: `Auto-repost: ${product.title} adicionado à fila para ${enfileirados} grupo(s)`,
      details: jaEnviados > 0
        ? `Plataforma: ${sourcePlatform}. ${jaEnviados} grupo(s) pulado(s) por já ter recebido este produto.`
        : `Plataforma: ${sourcePlatform}`,
    })
  } catch (error) {
    log.error('Erro no auto-repost:', error)
  }
}
