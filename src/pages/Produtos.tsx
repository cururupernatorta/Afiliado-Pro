import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Package,
  Plus,
  Search,
  Trash2,
  Edit3,
  ExternalLink,
  Link2,
  Filter,
  CheckSquare,
  Square,
  Send,
  Loader2,
  X,
  Image as ImageIcon,
  Tag,
  FileText,
  Eye,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { formatCurrency, truncate } from '../lib/utils'

// ── tipos locais ─────────────────────────────────────────────────────────────
interface ScrapedData {
  title: string
  price: number
  original_price?: number
  image_url?: string
  description?: string
  store: 'shopee' | 'mercado_livre' | 'amazon' | 'aliexpress'
  affiliate_url?: string
  original_url: string
}

interface SendConfig {
  description: string
  coupon: string
  imageUrl: string
  imageFile: File | null
}

export default function Produtos() {
  const { products, addProduct, removeProduct, updateProduct, groups } = useAppStore()

  // listagem
  const [searchTerm, setSearchTerm]       = useState('')
  const [selectedStore, setSelectedStore] = useState<string>('all')
  const [selectedProducts, setSelectedProducts] = useState<number[]>([])

  // modal adicionar
  const [showAddModal, setShowAddModal]   = useState(false)
  const [newUrl, setNewUrl]               = useState('')
  const [isScraping, setIsScraping]       = useState(false)
  const [scraped, setScraped]             = useState<ScrapedData | null>(null)
  const [editTitle, setEditTitle]         = useState('')
  const [editPrice, setEditPrice]         = useState('')
  const [editOriginalPrice, setEditOriginalPrice] = useState('')
  const [editDesc, setEditDesc]           = useState('')
  const [editCoupon, setEditCoupon]       = useState('')
  const [editImageUrl, setEditImageUrl]   = useState('')
  const [imageFile, setImageFile]         = useState<File | null>(null)
  const [imagePreview, setImagePreview]   = useState<string>('')
  const imageInputRef                     = useRef<HTMLInputElement>(null)

  // modal enviar
  const [showSendModal, setShowSendModal]   = useState(false)
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [sendConfig, setSendConfig]         = useState<SendConfig | null>(null)
  const [showPreview, setShowPreview]       = useState(false)
  const [isSending, setIsSending]           = useState(false)

  // modal editar produto existente
  const [editingProduct, setEditingProduct] = useState<typeof products[0] | null>(null)

  // ── filtros ────────────────────────────────────────────────────────────────
  const filteredProducts = products.filter((p) => {
    const matchesSearch = p.title.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesStore  = selectedStore === 'all' || p.store === selectedStore
    return matchesSearch && matchesStore
  })

  // ── scraping ───────────────────────────────────────────────────────────────
  const handleScrape = async () => {
    if (!newUrl.trim()) return
    setIsScraping(true)
    setScraped(null)
    try {
      const data: ScrapedData = await window.electronAPI.productScrape(newUrl)
      setScraped(data)
      setEditTitle(data.title)
      setEditPrice(String(data.price))
      setEditOriginalPrice(String(data.original_price ?? ''))
      setEditDesc(data.description ?? '')
      setEditCoupon('')
      setEditImageUrl(data.image_url ?? '')
      setImageFile(null)
      setImagePreview(data.image_url ?? '')
    } catch (error) {
      alert('Erro ao extrair produto: ' + (error as Error).message)
    } finally {
      setIsScraping(false)
    }
  }

  const handleImageFile = (file: File) => {
    setImageFile(file)
    const reader = new FileReader()
    reader.onload = (e) => setImagePreview(e.target?.result as string)
    reader.readAsDataURL(file)
    setEditImageUrl('')
  }

  const handleAddProduct = async () => {
    if (!scraped) return
    setIsScraping(true)
    try {
      const created = await window.electronAPI.productCreate({
        ...scraped,
        title:          editTitle,
        price:          parseFloat(editPrice),
        original_price: editOriginalPrice ? parseFloat(editOriginalPrice) : undefined,
        description:    editDesc,
        image_url:      imageFile ? imagePreview : editImageUrl,
        source:         'manual',
      })
      addProduct(created)
      resetAddModal()
    } catch (error) {
      alert('Erro ao salvar produto: ' + (error as Error).message)
    } finally {
      setIsScraping(false)
    }
  }

  const resetAddModal = () => {
    setShowAddModal(false)
    setNewUrl('')
    setScraped(null)
    setEditTitle('')
    setEditPrice('')
    setEditOriginalPrice('')
    setEditDesc('')
    setEditCoupon('')
    setEditImageUrl('')
    setImageFile(null)
    setImagePreview('')
  }

  // ── deletar ────────────────────────────────────────────────────────────────
  const handleDelete = async (id: number) => {
    if (!confirm('Tem certeza que deseja excluir este produto?')) return
    await window.electronAPI.productDelete(id)
    removeProduct(id)
  }

  // ── seleção ────────────────────────────────────────────────────────────────
  const toggleSelection = (id: number) => {
    setSelectedProducts((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )
  }

  // ── abrir modal de envio ───────────────────────────────────────────────────
  const openSendModal = () => {
    // pega o primeiro produto selecionado para pré-preencher
    const first = products.find((p) => p.id === selectedProducts[0])
    setSendConfig({
      description: first?.description ?? '',
      coupon:      '',
      imageUrl:    first?.image_url ?? '',
      imageFile:   null,
    })
    setSelectedGroups([])
    setShowPreview(false)
    setShowSendModal(true)
  }

  // ── enviar ────────────────────────────────────────────────────────────────
  const handleSendProducts = async () => {
    if (selectedProducts.length === 0 || selectedGroups.length === 0) return
    setIsSending(true)
    try {
      const waGroups = selectedGroups.filter((g) => g.startsWith('wa-'))
      const tgGroups = selectedGroups.filter((g) => g.startsWith('tg-'))

      const extra = {
        description: sendConfig?.description,
        coupon:      sendConfig?.coupon,
        imageUrl:    sendConfig?.imageUrl,
      }

      if (waGroups.length > 0) {
        await window.electronAPI.whatsappSendProducts(
          waGroups.map((g) => g.replace('wa-', '')),
          selectedProducts,
          extra
        )
      }
      if (tgGroups.length > 0) {
        await window.electronAPI.telegramSendProducts(
          tgGroups.map((g) => g.replace('tg-', '')),
          selectedProducts,
          extra
        )
      }

      setShowSendModal(false)
      setSelectedProducts([])
      setSelectedGroups([])
      setSendConfig(null)
    } catch (err) {
      alert('Erro ao enviar: ' + (err as Error).message)
    } finally {
      setIsSending(false)
    }
  }

  // ── preview do anúncio ────────────────────────────────────────────────────
  const buildPreviewText = () => {
    const p = products.find((pr) => pr.id === selectedProducts[0])
    if (!p || !sendConfig) return ''
    const lines: string[] = []
    lines.push(`*${p.title}*`)
    if (p.original_price) lines.push(`\n💰 De ~R$ ${p.original_price.toFixed(2)}~ por *R$ ${p.price.toFixed(2)}*`)
    else lines.push(`\n💰 *R$ ${p.price.toFixed(2)}*`)
    if (sendConfig.coupon) lines.push(`\n🏷️ Cupom: *${sendConfig.coupon}*`)
    if (sendConfig.description) lines.push(`\n📝 ${sendConfig.description}`)
    lines.push(`\n🔗 ${p.affiliate_url ?? p.original_url}`)
    lines.push(`\n⚡ Corra antes que acabe!`)
    return lines.join('\n')
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Buscar produtos..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <select
              value={selectedStore}
              onChange={(e) => setSelectedStore(e.target.value)}
              className="h-10 pl-10 pr-8 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none cursor-pointer"
            >
              <option value="all">Todas as lojas</option>
              <option value="shopee">Shopee</option>
              <option value="mercado_livre">Mercado Livre</option>
              <option value="amazon">Amazon</option>
              <option value="aliexpress">AliExpress</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {selectedProducts.length > 0 && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={openSendModal}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Send className="w-4 h-4" />
              Enviar ({selectedProducts.length})
            </motion.button>
          )}
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Adicionar Produto
          </button>
        </div>
      </div>

      {/* Products Table */}
      <div className="glass-card rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left">
                  <button
                    onClick={() => {
                      if (selectedProducts.length === filteredProducts.length) {
                        setSelectedProducts([])
                      } else {
                        setSelectedProducts(filteredProducts.map((p) => p.id))
                      }
                    }}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {selectedProducts.length === filteredProducts.length && filteredProducts.length > 0
                      ? <CheckSquare className="w-5 h-5" />
                      : <Square className="w-5 h-5" />}
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Produto</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Preço</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Loja</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Fonte</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Link</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    <Package className="w-10 h-10 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Nenhum produto encontrado</p>
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
                  <motion.tr
                    key={product.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="border-b border-border/50 hover:bg-secondary/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <button onClick={() => toggleSelection(product.id)} className="text-muted-foreground hover:text-foreground transition-colors">
                        {selectedProducts.includes(product.id)
                          ? <CheckSquare className="w-5 h-5 text-primary" />
                          : <Square className="w-5 h-5" />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
                          {product.image_url
                            ? <img src={product.image_url} alt="" className="w-full h-full object-cover" />
                            : <Package className="w-4 h-4 text-muted-foreground" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate max-w-[200px]">
                            {truncate(product.title, 40)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(product.created_at).toLocaleDateString('pt-BR')}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">
                      <div>
                        <span className="font-medium">{formatCurrency(product.price)}</span>
                        {product.original_price && (
                          <span className="ml-1 text-xs text-muted-foreground line-through">
                            {formatCurrency(product.original_price)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-1 rounded-full bg-secondary text-foreground capitalize">
                        {product.store.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        product.source === 'manual'
                          ? 'bg-blue-400/10 text-blue-400'
                          : product.source === 'whatsapp'
                          ? 'bg-green-400/10 text-green-400'
                          : 'bg-purple-400/10 text-purple-400'
                      }`}>
                        {product.source}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {product.affiliate_url && (
                          <span className="text-xs text-primary">Afiliado</span>
                        )}
                        <a
                          href={product.affiliate_url || product.original_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setEditingProduct(product)}
                          className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(product.id)}
                          className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Modal: Adicionar Produto ───────────────────────────────────────── */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="glass-card rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-foreground">Adicionar Produto</h3>
                <button onClick={resetAddModal} className="text-muted-foreground hover:text-foreground">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* URL + botão scrape */}
              <div className="space-y-3">
                <label className="text-sm text-muted-foreground block">URL do Produto</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="url"
                      placeholder="https://shopee.com.br/..."
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
                      className="w-full h-10 pl-10 pr-4 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <button
                    onClick={handleScrape}
                    disabled={isScraping || !newUrl.trim()}
                    className="h-10 px-4 rounded-lg bg-secondary border border-border text-sm text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 flex items-center gap-2 whitespace-nowrap"
                  >
                    {isScraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    {isScraping ? 'Buscando...' : 'Buscar'}
                  </button>
                </div>
              </div>

              {/* Campos editáveis após scraping */}
              <AnimatePresence>
                {scraped && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-5 space-y-4"
                  >
                    <div className="h-px bg-border" />
                    <p className="text-xs text-primary font-medium uppercase tracking-wider">Dados extraídos — edite se necessário</p>

                    {/* Foto */}
                    <div>
                      <label className="text-sm text-muted-foreground mb-2 block flex items-center gap-1">
                        <ImageIcon className="w-3.5 h-3.5" /> Foto do Produto
                      </label>
                      <div className="flex gap-3 items-start">
                        {/* Preview */}
                        <div
                          className="w-20 h-20 rounded-lg bg-secondary border-2 border-dashed border-border flex items-center justify-center overflow-hidden flex-shrink-0 cursor-pointer hover:border-primary/50 transition-colors"
                          onClick={() => imageInputRef.current?.click()}
                        >
                          {imagePreview
                            ? <img src={imagePreview} alt="" className="w-full h-full object-cover" />
                            : <ImageIcon className="w-6 h-6 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 space-y-2">
                          <input
                            type="text"
                            placeholder="URL da imagem (preenchida automaticamente)"
                            value={editImageUrl}
                            onChange={(e) => {
                              setEditImageUrl(e.target.value)
                              setImagePreview(e.target.value)
                              setImageFile(null)
                            }}
                            className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                          />
                          <button
                            onClick={() => imageInputRef.current?.click()}
                            className="w-full h-9 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors flex items-center justify-center gap-1"
                          >
                            <ImageIcon className="w-3.5 h-3.5" />
                            {imageFile ? imageFile.name : 'Ou clique para fazer upload'}
                          </button>
                          <input
                            ref={imageInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => e.target.files?.[0] && handleImageFile(e.target.files[0])}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Título */}
                    <div>
                      <label className="text-sm text-muted-foreground mb-1 block">Título</label>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </div>

                    {/* Preços */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm text-muted-foreground mb-1 block">Preço atual (R$)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={editPrice}
                          onChange={(e) => setEditPrice(e.target.value)}
                          className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>
                      <div>
                        <label className="text-sm text-muted-foreground mb-1 block">Preço original (R$)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={editOriginalPrice}
                          onChange={(e) => setEditOriginalPrice(e.target.value)}
                          placeholder="Opcional"
                          className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>
                    </div>

                    {/* Cupom */}
                    <div>
                      <label className="text-sm text-muted-foreground mb-1 block flex items-center gap-1">
                        <Tag className="w-3.5 h-3.5" /> Cupom de desconto
                      </label>
                      <input
                        type="text"
                        value={editCoupon}
                        onChange={(e) => setEditCoupon(e.target.value)}
                        placeholder="Ex: PROMO10 (opcional)"
                        className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </div>

                    {/* Descrição */}
                    <div>
                      <label className="text-sm text-muted-foreground mb-1 block flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5" /> Descrição / chamada
                      </label>
                      <textarea
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        rows={3}
                        placeholder="Texto que aparecerá na mensagem (opcional)"
                        className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                      />
                    </div>

                    <button
                      onClick={handleAddProduct}
                      disabled={isScraping}
                      className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {isScraping
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</>
                        : <><Plus className="w-4 h-4" /> Salvar Produto</>}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Modal: Enviar Produtos ────────────────────────────────────────── */}
      <AnimatePresence>
        {showSendModal && sendConfig && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="glass-card rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-foreground">Enviar Produtos</h3>
                <button onClick={() => setShowSendModal(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <p className="text-sm text-muted-foreground mb-4">
                {selectedProducts.length} produto(s) selecionado(s). Edite o anúncio antes de enviar.
              </p>

              {/* Foto */}
              <div className="mb-4">
                <label className="text-sm text-muted-foreground mb-2 block flex items-center gap-1">
                  <ImageIcon className="w-3.5 h-3.5" /> Foto do anúncio
                </label>
                <div className="flex gap-3 items-center">
                  <div className="w-16 h-16 rounded-lg bg-secondary border border-border overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {sendConfig.imageUrl
                      ? <img src={sendConfig.imageUrl} alt="" className="w-full h-full object-cover" />
                      : <ImageIcon className="w-6 h-6 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 space-y-2">
                    <input
                      type="text"
                      placeholder="URL da imagem"
                      value={sendConfig.imageUrl}
                      onChange={(e) => setSendConfig({ ...sendConfig, imageUrl: e.target.value })}
                      className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <label className="w-full h-9 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors flex items-center justify-center gap-1 cursor-pointer">
                      <ImageIcon className="w-3.5 h-3.5" />
                      {sendConfig.imageFile ? (sendConfig.imageFile as File).name : 'Upload manual'}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = (ev) => setSendConfig({ ...sendConfig, imageUrl: ev.target?.result as string, imageFile: file })
                          reader.readAsDataURL(file)
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* Cupom */}
              <div className="mb-4">
                <label className="text-sm text-muted-foreground mb-1 block flex items-center gap-1">
                  <Tag className="w-3.5 h-3.5" /> Cupom
                </label>
                <input
                  type="text"
                  placeholder="Ex: PROMO10 (opcional)"
                  value={sendConfig.coupon}
                  onChange={(e) => setSendConfig({ ...sendConfig, coupon: e.target.value })}
                  className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              {/* Descrição */}
              <div className="mb-4">
                <label className="text-sm text-muted-foreground mb-1 block flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5" /> Descrição / chamada
                </label>
                <textarea
                  value={sendConfig.description}
                  onChange={(e) => setSendConfig({ ...sendConfig, description: e.target.value })}
                  rows={3}
                  placeholder="Texto personalizado da mensagem"
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                />
              </div>

              {/* Preview */}
              <div className="mb-4">
                <button
                  onClick={() => setShowPreview(!showPreview)}
                  className="flex items-center gap-2 text-sm text-primary hover:text-primary/80 transition-colors"
                >
                  <Eye className="w-4 h-4" />
                  {showPreview ? 'Ocultar preview' : 'Ver preview da mensagem'}
                  {showPreview ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                <AnimatePresence>
                  {showPreview && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-2 p-3 rounded-lg bg-secondary/60 border border-border text-sm text-foreground whitespace-pre-wrap font-mono"
                    >
                      {buildPreviewText()}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Grupos */}
              <div className="mb-4">
                <label className="text-sm text-muted-foreground mb-2 block">Selecionar grupos</label>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {groups.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      Nenhum grupo conectado. Vá em "Conexões" para conectar.
                    </p>
                  ) : (
                    groups.map((group) => {
                      const key = `${group.platform === 'whatsapp' ? 'wa' : 'tg'}-${group.id}`
                      return (
                        <label
                          key={key}
                          className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50 hover:bg-secondary cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedGroups.includes(key)}
                            onChange={(e) =>
                              setSelectedGroups((prev) =>
                                e.target.checked ? [...prev, key] : prev.filter((g) => g !== key)
                              )
                            }
                            className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                          />
                          <div className="flex-1">
                            <p className="text-sm text-foreground">{group.name}</p>
                            <p className="text-xs text-muted-foreground capitalize">{group.platform}</p>
                          </div>
                        </label>
                      )
                    })
                  )}
                </div>
              </div>

              <button
                onClick={handleSendProducts}
                disabled={selectedGroups.length === 0 || isSending}
                className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isSending
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Enviando...</>
                  : <><Send className="w-4 h-4" /> Enviar para {selectedGroups.length} grupo(s)</>}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Modal: Editar Produto Existente ───────────────────────────────── */}
      <AnimatePresence>
        {editingProduct && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="glass-card rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-foreground">Editar Produto</h3>
                <button onClick={() => setEditingProduct(null)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="space-y-4">
                {/* Imagem */}
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">URL da Imagem</label>
                  <div className="flex gap-3 items-center">
                    <div className="w-14 h-14 rounded-lg bg-secondary border border-border overflow-hidden flex-shrink-0 flex items-center justify-center">
                      {editingProduct.image_url
                        ? <img src={editingProduct.image_url} alt="" className="w-full h-full object-cover" />
                        : <ImageIcon className="w-5 h-5 text-muted-foreground" />}
                    </div>
                    <input
                      type="text"
                      value={editingProduct.image_url ?? ''}
                      onChange={(e) => setEditingProduct({ ...editingProduct, image_url: e.target.value })}
                      placeholder="URL da imagem"
                      className="flex-1 h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                </div>
                {/* Título */}
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Título</label>
                  <input
                    type="text"
                    value={editingProduct.title}
                    onChange={(e) => setEditingProduct({ ...editingProduct, title: e.target.value })}
                    className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                {/* Preços */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-muted-foreground mb-1 block">Preço (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={editingProduct.price}
                      onChange={(e) => setEditingProduct({ ...editingProduct, price: parseFloat(e.target.value) })}
                      className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-muted-foreground mb-1 block">Original (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={editingProduct.original_price ?? ''}
                      onChange={(e) => setEditingProduct({ ...editingProduct, original_price: parseFloat(e.target.value) })}
                      placeholder="Opcional"
                      className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                </div>
                {/* Descrição */}
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Descrição</label>
                  <textarea
                    value={editingProduct.description ?? ''}
                    onChange={(e) => setEditingProduct({ ...editingProduct, description: e.target.value })}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                  />
                </div>
                <button
                  onClick={async () => {
                    await window.electronAPI.productUpdate(editingProduct.id, editingProduct)
                    updateProduct(editingProduct.id, editingProduct)
                    setEditingProduct(null)
                  }}
                  className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
                >
                  <Edit3 className="w-4 h-4" />
                  Salvar alterações
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
