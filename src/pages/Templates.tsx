import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, Plus, Trash2, Edit3, X, Save, Loader2 } from 'lucide-react'
import { Button } from '../components/ui/button'

interface MessageTemplate {
  id: number
  name: string
  template_text: string
  updated_at?: string
}

const PLACEHOLDERS = [
  { token: '{title}', desc: 'Nome do produto' },
  { token: '{price_line}', desc: 'Preço formatado (com desconto real, ou só o preço se não houver)' },
  { token: '{price}', desc: 'Preço atual, número puro (ex: 99.90)' },
  { token: '{original_price}', desc: 'Preço original, só se for real (senão fica vazio)' },
  { token: '{affiliate_url}', desc: 'Seu link de afiliado do produto' },
  { token: '{store}', desc: 'Nome da loja (shopee, amazon...)' },
  { token: '{description}', desc: 'Descrição do produto' },
  { token: '{coupon}', desc: 'Cupom (se preenchido no envio)' },
  { token: '{group_link}', desc: 'Link do seu grupo, configurado em Configurações' },
]

const SAMPLE = {
  title: 'Fone de Ouvido Bluetooth Sem Fio',
  price_line: 'De ~~R$ 149,90~~ por *R$ 89,90*',
  price: '89.90',
  original_price: '149.90',
  affiliate_url: 'https://exemplo.com/produto?tag=seu-id',
  store: 'shopee',
  description: 'Som com qualidade de estúdio, bateria de longa duração e cancelamento de ruído.',
  coupon: 'PROMO10',
  group_link: 'https://chat.whatsapp.com/seu-grupo',
}

function renderSample(templateText: string): string {
  return Object.entries(SAMPLE).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    templateText
  )
}

export default function Templates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<MessageTemplate | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

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
                </div>

                <div>
                  <p className="text-xs font-medium text-foreground mb-2">Preview com dados de exemplo</p>
                  <div className="p-3 rounded-lg bg-secondary/60 border border-border text-sm text-foreground whitespace-pre-wrap font-mono">
                    {renderSample(text) || 'Digite o texto acima para ver o preview'}
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
