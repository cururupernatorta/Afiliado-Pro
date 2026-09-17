/**
 * Montagem do texto do anúncio a partir do template.
 *
 * Este arquivo NÃO pode importar nada do Electron nem do Node: o editor de
 * templates importa daqui para montar a prévia. Antes a prévia tinha uma cópia
 * própria da substituição, e as duas divergiram — a mensagem real ganhava a
 * linha do cupom no fim e a prévia não. Relato do testador: o cupom aparecia
 * no grupo, mas "no template ele não aparece", e ele não tinha como saber onde
 * o cupom ia parar nem como mudá-lo de lugar.
 */

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
  pix_price?: number
  coupon_url?: string
  /** Código de cupom lido da mensagem que originou a captura. */
  coupon_code?: string
}

export interface FormatMessageExtra {
  groupLink?: string
  coupon?: string
  /** Link de cupom já convertido em afiliado (ver ensureCouponUrl em main.ts). */
  couponUrl?: string
}

// Usado sempre que um grupo/envio não tem nenhum template da biblioteca associado.
//
// {discount_line} e {coupon_line} somem com a linha inteira quando não há dado
// (ver VARIAVEL), então estar no padrão não deixa buraco no anúncio de
// produto sem desconto ou sem cupom.
export const DEFAULT_TEMPLATE_TEXT =
  '*{title}*\n\n{discount_line}\n💰 {price_line}\n\n{coupon_line}\n\n📝 {description}\n\n🔗 {affiliate_url}\n\n⚡ Corra antes que acabe!\n\n👥 Entre no nosso grupo de ofertas: {group_link}'

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

/**
 * Desconto em porcentagem, só quando existe preço original de verdade.
 *
 * Arredonda PARA BAIXO. É como o Mercado Livre mostra — R$ 179,84 por R$ 74,00
 * aparece como 58% OFF, não 59% —, e anunciar desconto maior que o da loja é o
 * tipo de dado que o app promete nunca inventar.
 */
export function porcentagemDeDesconto(price: number, originalPrice?: number): number | null {
  if (typeof originalPrice !== 'number' || !(price > 0) || !(originalPrice > price)) return null
  const pct = Math.floor((1 - price / originalPrice) * 100)
  return pct >= 1 ? pct : null
}

/**
 * Uma linha em que TODAS as variáveis ficam vazias some inteira, com o texto
 * fixo que estiver nela.
 *
 * A primeira versão só apagava a linha quando o token estava sozinho nela. Só
 * que quem monta template escreve "🎟️ Cupom: {coupon}", e aí, em produto sem
 * cupom, o anúncio saía com o emoji e "Cupom:" pendurados em branco — relato
 * do testador. A regra agora olha a linha inteira: sobrou alguma variável com
 * valor, a linha fica ("💰 {price_line} {discount}" continua mostrando o
 * preço); não sobrou nenhuma, a linha sai. Linha sem variável nenhuma, como
 * "⚡ Corra antes que acabe!", nunca é tocada.
 */
const VARIAVEL = /\{[a-z_]+\}/g

export function formatMessage(product: ProductLike, templateText: string, extra: FormatMessageExtra = {}): string {
  const hasRealDiscount = typeof product.original_price === 'number' && product.original_price > product.price
  // Preço no Pix só entra se for realmente menor que o normal — anunciar "no
  // Pix" um valor igual ou maior seria enganoso.
  const pix = typeof product.pix_price === 'number' && product.pix_price > 0 && product.pix_price < product.price
    ? product.pix_price
    : undefined

  // O cupom do envio manual manda; na falta dele vale o que veio junto com a
  // captura (ver extrairCupomDoTexto).
  const cupom = extra.coupon || product.coupon_code || ''
  const desconto = porcentagemDeDesconto(product.price, product.original_price)

  const valores: Record<string, string> = {
    '{title}': product.title,
    '{price}': product.price.toFixed(2),
    '{original_price}': hasRealDiscount ? product.original_price!.toFixed(2) : '',
    '{pix_price}': pix ? pix.toFixed(2) : '',
    '{pix_line}': pix ? `💸 *R$ ${pix.toFixed(2)}* no Pix` : '',
    '{coupon_line}': cupom ? `🎟️ Cupom: *${cupom}*` : '',
    '{discount_line}': desconto ? `🔥 *${desconto}% OFF*` : '',
    '{discount}': desconto ? `${desconto}% OFF` : '',
    '{coupon_url}': extra.couponUrl || product.coupon_url || '',
    '{price_line}': buildPriceLine(product.price, product.original_price),
    '{affiliate_url}': product.affiliate_url || product.original_url,
    '{original_url}': product.original_url,
    '{store}': product.store,
    '{description}': (product.description || '').substring(0, 200),
    '{coupon}': cupom,
    '{group_link}': extra.groupLink || '',
  }

  let tirouLinha = false
  const linhas: string[] = []
  for (const linha of templateText.split(/\r?\n/)) {
    const variaveis = (linha.match(VARIAVEL) ?? []).filter((v) => v in valores)
    if (variaveis.length > 0 && variaveis.every((v) => valores[v] === '')) {
      tirouLinha = true
      continue
    }
    // Substituição por função, e não por string: numa string de substituição
    // o JavaScript interpreta `$&`, `$1` e companhia, e um título ou descrição
    // com esses caracteres sairia corrompido no anúncio. Variável desconhecida
    // fica como está, igual antes.
    linhas.push(linha.replace(VARIAVEL, (v) => (v in valores ? valores[v] : v)))
  }

  let mensagem = linhas.join('\n')
  if (tirouLinha) {
    // A linha sumiu, mas as linhas em branco em volta dela ficavam dobradas.
    mensagem = mensagem.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
  }

  // Template que não diz onde vai o cupom recebe a linha no fim. Sem isto, o
  // cupom lido do anúncio seria jogado fora em silêncio justamente no anúncio
  // em que ele faz diferença. Para escolher o lugar, basta usar {coupon_line}.
  if (cupom && !templateText.includes('{coupon}') && !templateText.includes('{coupon_line}')) {
    return mensagem + '\n\n' + valores['{coupon_line}']
  }
  return mensagem
}
