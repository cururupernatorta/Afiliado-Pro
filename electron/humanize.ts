// Gera uma descrição "humanizada" para o anúncio, 100% local (sem IA/API externa).
// Antes, o app usava a meta description da própria página do produto como
// descrição do anúncio — um texto de marketing do site, não algo escrito para
// o grupo. Aqui construímos uma frase curta a partir dos dados que já temos
// (título, loja, desconto real), variando a abertura para não soar robótico.

export interface HumanizeInput {
  title: string
  store: string
  price: number
  original_price?: number
}

const STORE_LABELS: Record<string, string> = {
  shopee: 'Shopee',
  mercado_livre: 'Mercado Livre',
  amazon: 'Amazon',
  aliexpress: 'AliExpress',
}

const OPENERS = [
  (store: string) => `Garimpei esse achado na ${store}`,
  (store: string) => `Oferta encontrada agora na ${store}`,
  (store: string) => `Separei esse aqui pra você, direto da ${store}`,
  (store: string) => `Achado do dia na ${store}`,
  (store: string) => `Deu bom na ${store} hoje`,
]

const CLOSERS_WITH_DISCOUNT = [
  (pct: number) => `com ${pct}% de desconto sobre o preço original. Vale conferir antes que acabe.`,
  (pct: number) => `${pct}% mais barato que o preço original — corre que costuma acabar rápido.`,
  (pct: number) => `saiu com ${pct}% off. Bom pra quem tava de olho.`,
]

const CLOSERS_NO_DISCOUNT = [
  'preço bom pra quem tava esperando a hora certa de comprar.',
  'vale a pena dar uma conferida antes que o estoque acabe.',
  'ótima opção pelo preço atual.',
]

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export function humanizeDescription({ title, store, price, original_price }: HumanizeInput): string {
  const storeLabel = STORE_LABELS[store] || store
  const opener = pick(OPENERS)(storeLabel)
  const hasRealDiscount = typeof original_price === 'number' && original_price > price
  const closer = hasRealDiscount
    ? pick(CLOSERS_WITH_DISCOUNT)(Math.round((1 - price / original_price!) * 100))
    : pick(CLOSERS_NO_DISCOUNT)

  return `${opener}: *${title}*, ${closer}`
}
