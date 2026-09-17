import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, Plus, Trash2, Edit3, X, Save, Loader2 } from 'lucide-react'
import { Button } from '../components/ui/button'
import { formatMessage } from '../../electron/messageFormat'
import type { ProductLike } from '../../electron/messageFormat'

interface MessageTemplate {
  id: number
  name: string
  template_text: string
  updated_at?: string
}

const PLACEHOLDERS = [
  { token: '{title}', desc: 'Nome do produto' },
  { token: '{discount_line}', desc: 'Linha "🔥 58% OFF", quando a loja informa o preço original' },
  { token: '{price_line}', desc: 'Preço formatado (com desconto real, ou só o preço se não houver)' },
  { token: '{coupon_line}', desc: 'Linha "🎟️ Cupom: X" com o cupom lido do anúncio original' },
  { token: '{pix_line}', desc: 'Linha do preço no Pix, quando for menor' },
  { token: '{price}', desc: 'Preço atual, número puro (ex: 99.90)' },
  { token: '{original_price}', desc: 'Preço original, só se for real (senão fica vazio)' },
  { token: '{discount}', desc: 'Só o desconto, ex: 58% OFF (vazio se não houver)' },
  { token: '{coupon}', desc: 'Só o código do cupom (lido do anúncio ou digitado no envio)' },
  { token: '{affiliate_url}', desc: 'Seu link de afiliado do produto' },
  { token: '{store}', desc: 'Nome da loja (shopee, amazon...)' },
  { token: '{description}', desc: 'Descrição do produto' },
  { token: '{coupon_url}', desc: 'Página de cupom cadastrada no produto, com seu link de afiliado' },
  { token: '{group_link}', desc: 'Link do seu grupo, configurado em Configurações' },
]

// A prévia usa a MESMA função que monta a mensagem de verdade. Antes ela tinha
// uma substituição própria e divergiu: o cupom saía no grupo e não aparecia
// aqui, e o testador não tinha como ver onde ele ia parar. O produto de exemplo
// tem cupom e desconto justamente para mostrar onde essas linhas caem.
const PRODUTO_DE_EXEMPLO: ProductLike = {
  title: 'Whey Protein 1kg Whey Pro Max Titanium Sabor Morango',
  price: 74,
  original_price: 179.84,
  affiliate_url: 'https://meli.la/seu-link',
  original_url: 'https://www.mercadolivre.com.br/p/MLB123456',
  store: 'mercado_livre',
  description: 'Alto teor de proteínas, 15g por porção.',
  coupon_code: 'LEVOUBARATO',
}

// O mesmo produto sem cupom e sem desconto: é o caso em que as linhas somem, e
// foi nele que apareceu o "🎟️ Cupom:" em branco relatado pelo testador.
const PRODUTO_SEM_CUPOM: ProductLike = { ...PRODUTO_DE_EXEMPLO, coupon_code: undefined, original_price: undefined }

function renderSample(templateText: string, semCupom: boolean): string {
  if (!templateText) return ''
  return formatMessage(semCupom ? PRODUTO_SEM_CUPOM : PRODUTO_DE_EXEMPLO, templateText, {
    groupLink: 'https://chat.whatsapp.com/seu-grupo',
  })
}

export default function Templates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<MessageTemplate | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [previaSemCupom, setPreviaSemCupom] = useState(false)

  useEffect(() => {
    loadTemplates()
  }, [])

  const loadTemplates = async () => {
    setLoading(true)
    try {
      const list = await window.electronAPI.messageTemplateList()
      setTemplates(list)
    } catch (error) {
      console.error('Erro ao carregar templates:', error)
    } finally {
      setLoading(false)
    }
  }

  const openNew = async () => {
    const defaultText = await window.electronAPI.messageTemplateGetDefault()
    setEditing(null)
    setIsNew(true)
    setName('')
    setText(defaultText)
  }

  const openEdit = (template: MessageTemplate) => {
    setEditing(template)
    setIsNew(false)
    setName(template.name)
    setText(template.template_text)
  }

  const closeEditor = () => {
    setEditing(null)
    setIsNew(false)
    setName('')
    setText('')
  }

  const handleSave = async () => {
    if (!name.trim() || !text.trim()) return
    setSaving(true)
    try {
      if (isNew) {
        await window.electronAPI.messageTemplateCreate({ name: name.trim(), template_text: text })
      } else if (editing) {
        await window.electronAPI.messageTemplateUpdate(editing.id, { name: name.trim(), template_text: text })
      }
      await loadTemplates()
      closeEditor()
    } catch (error) {
      alert('Erro ao salvar template: ' + (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (template: MessageTemplate) => {
    if (!confirm(`Apagar o template "${template.name}"? Grupos que usam ele voltam a usar o template padrão do sistema.`)) return
    try {
      await window.electronAPI.messageTemplateDelete(template.id)
      await loadTemplates()
    } catch (error) {
      alert('Erro ao apagar template: ' + (error as Error).message)
    }
  }

  const isEditorOpen = isNew || editing !== null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Templates</h3>
          <p className="text-sm text-muted-foreground">Crie modelos de anúncio reutilizáveis e escolha qual grupo usa qual</p>
        </div>
        <Button onClick={openNew} className="flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Novo Template
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <div className="ticket-card p-12 text-center">
          <FileText className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground mb-4">Nenhum template criado ainda</p>
          <Button onClick={openNew} className="mx-auto flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Criar meu primeiro template
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((template) => (
            <motion.div
              key={template.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="ticket-card p-5 flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground truncate">{template.name}</h4>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => openEdit(template)} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(template)} className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4 font-mono">
                {template.template_text}
              </p>
            </motion.div>
          ))}
        </div>
      )}

      {/* Editor */}
      <AnimatePresence>
        {isEditorOpen && (
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
              className="ticket-card p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-foreground">
                  {isNew ? 'Novo Template' : 'Editar Template'}
                </h3>
                <button onClick={closeEditor} className="text-muted-foreground hover:text-foreground">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Nome do template</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: Padrão, Promoção Relâmpago, Minimalista..."
                    className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Texto da mensagem</label>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
                  />
                </div>

                <div>
                  <p className="text-xs font-medium text-foreground mb-2">Placeholders disponíveis</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {PLACEHOLDERS.map((p) => (
                      <div key={p.token} className="text-xs">
                        <span className="font-mono text-primary">{p.token}</span>
                        <span className="text-muted-foreground"> — {p.desc}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Uma linha em que todas as variáveis ficam vazias some da mensagem, com o texto que estiver nela. Ex.:{' '}
                    <span className="font-mono text-primary">{'🎟️ Cupom: {coupon}'}</span> não aparece em produto sem cupom.
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Se o template não tiver <span className="font-mono text-primary">{'{coupon_line}'}</span> nem{' '}
                    <span className="font-mono text-primary">{'{coupon}'}</span>, o cupom é colocado no fim da mensagem.
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-xs font-medium text-foreground">Preview com dados de exemplo</p>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={previaSemCupom}
                        onChange={(e) => setPreviaSemCupom(e.target.checked)}
                        className="accent-primary"
                      />
                      Ver produto sem cupom e sem desconto
                    </label>
                  </div>
                  <div className="p-3 rounded-lg bg-secondary/60 border border-border text-sm text-foreground whitespace-pre-wrap font-mono">
                    {renderSample(text, previaSemCupom) || 'Digite o texto acima para ver o preview'}
                  </div>
                </div>

                <button
                  onClick={handleSave}
                  disabled={saving || !name.trim() || !text.trim()}
                  className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {saving ? 'Salvando...' : 'Salvar Template'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
