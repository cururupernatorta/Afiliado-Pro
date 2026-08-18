import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Settings,
  Save,
  Key,
  Clock,
  ToggleLeft,
  ToggleRight,
  CheckCircle2,
  Store,
  Link2,
  Shield,
  Zap,
  MessageCircle,
  Send,
  Trash2,
  Plus,
  FileText,
  Eye,
  EyeOff,
  Moon,
  Tag,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'

const DEFAULT_TEMPLATE = '*{title}*\n\n💰 {price_line}\n\n🔗 {affiliate_url}\n\n⚡ Corra antes que acabe!\n\n👥 Entre no nosso grupo de ofertas: {group_link}'

export default function Configuracoes() {
  const { setConfig, autoSendTargets, setAutoSendTargets, adTemplates, setAdTemplate } = useAppStore()
  const [formData, setFormData] = useState({
    shopee_app_id: '',
    shopee_app_secret: '',
    mercado_livre_affiliate_id: '',
    amazon_tag: '',
    aliexpress_app_key: '',
    aliexpress_app_secret: '',
    aliexpress_tracking_id: '',
    whatsapp_daily_limit: 50,
    telegram_daily_limit: 50,
    min_delay_seconds: 3,
    max_delay_seconds: 15,
    auto_convert_links: true,
    auto_repost_enabled: false,
    stealth_mode: false,
    stealth_start_hour: 9,
    stealth_end_hour: 22,
    stealth_hourly_limit: 5,
    stealth_jitter_percent: 30,
    stealth_cooldown_minutes: 10,
    niche: '',
    auto_scrape_enabled: false,
    auto_scrape_interval_hours: 6,
    group_link: '',
  })
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [whatsappGroups, setWhatsappGroups] = useState<any[]>([])
  const [telegramGroups, setTelegramGroups] = useState<any[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null)
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  useEffect(() => {
    loadConfig()
    loadAutoSendTargets()
  }, [])

  const loadConfig = async () => {
    try {
      const cfg = await window.electronAPI.configGet()
      if (cfg) {
        setFormData({
          shopee_app_id: cfg.shopee_app_id || '',
          shopee_app_secret: cfg.shopee_app_secret || '',
          mercado_livre_affiliate_id: cfg.mercado_livre_affiliate_id || '',
          amazon_tag: cfg.amazon_tag || '',
          aliexpress_app_key: cfg.aliexpress_app_key || '',
          aliexpress_app_secret: cfg.aliexpress_app_secret || '',
          aliexpress_tracking_id: cfg.aliexpress_tracking_id || '',
          whatsapp_daily_limit: cfg.whatsapp_daily_limit || 50,
          telegram_daily_limit: cfg.telegram_daily_limit || 50,
          min_delay_seconds: cfg.min_delay_seconds || 3,
          max_delay_seconds: cfg.max_delay_seconds || 15,
          auto_convert_links: cfg.auto_convert_links !== false,
          auto_repost_enabled: cfg.auto_repost_enabled === true,
          stealth_mode: cfg.stealth_mode === true,
          stealth_start_hour: cfg.stealth_start_hour || 9,
          stealth_end_hour: cfg.stealth_end_hour || 22,
          stealth_hourly_limit: cfg.stealth_hourly_limit || 5,
          stealth_jitter_percent: cfg.stealth_jitter_percent || 30,
          stealth_cooldown_minutes: cfg.stealth_cooldown_minutes || 10,
          niche: cfg.niche || '',
          auto_scrape_enabled: cfg.auto_scrape_enabled === true,
          auto_scrape_interval_hours: cfg.auto_scrape_interval_hours || 6,
          group_link: cfg.group_link || '',
        })
        setConfig(cfg)
      }
    } catch (error) {
      console.error('Erro ao carregar config:', error)
    }
  }

  const loadAutoSendTargets = async () => {
    try {
      const targets = await window.electronAPI.autoSendGetTargets()
      setAutoSendTargets(targets)
    } catch (error) {
      console.error('Erro ao carregar auto-send targets:', error)
    }
  }

  const loadAvailableGroups = async () => {
    setLoadingGroups(true)
    try {
      const [wa, tg] = await Promise.all([
        window.electronAPI.whatsappGetGroups(),
        window.electronAPI.telegramGetGroups(),
      ])
      setWhatsappGroups(wa)
      setTelegramGroups(tg)
    } catch (error) {
      console.error('Erro ao carregar grupos:', error)
    } finally {
      setLoadingGroups(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.electronAPI.configSave({
        shopee_app_id: formData.shopee_app_id || null,
        shopee_app_secret: formData.shopee_app_secret || null,
        mercado_livre_affiliate_id: formData.mercado_livre_affiliate_id || null,
        amazon_tag: formData.amazon_tag || null,
        aliexpress_app_key: formData.aliexpress_app_key || null,
        aliexpress_app_secret: formData.aliexpress_app_secret || null,
        aliexpress_tracking_id: formData.aliexpress_tracking_id || null,
        whatsapp_daily_limit: formData.whatsapp_daily_limit,
        telegram_daily_limit: formData.telegram_daily_limit,
        min_delay_seconds: formData.min_delay_seconds,
        max_delay_seconds: formData.max_delay_seconds,
        auto_convert_links: formData.auto_convert_links ? 1 : 0,
        auto_repost_enabled: formData.auto_repost_enabled ? 1 : 0,
        stealth_mode: formData.stealth_mode ? 1 : 0,
        stealth_start_hour: formData.stealth_start_hour,
        stealth_end_hour: formData.stealth_end_hour,
        stealth_hourly_limit: formData.stealth_hourly_limit,
        stealth_jitter_percent: formData.stealth_jitter_percent,
        stealth_cooldown_minutes: formData.stealth_cooldown_minutes,
        niche: formData.niche || null,
        auto_scrape_enabled: formData.auto_scrape_enabled ? 1 : 0,
        auto_scrape_interval_hours: formData.auto_scrape_interval_hours,
        group_link: formData.group_link || null,
      })
      const cfg = await window.electronAPI.configGet()
      setConfig(cfg)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (error) {
      console.error('Erro ao salvar config:', error)
    } finally {
      setSaving(false)
    }
  }

  const updateField = (field: string, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  const addAutoSendTarget = async (platform: 'whatsapp' | 'telegram', group: any) => {
    try {
      const target = {
        platform,
        group_id: group.id,
        group_name: group.name,
        enabled: true,
      }
      await window.electronAPI.autoSendSaveTarget(target)
      await window.electronAPI.adTemplateSave({
        platform,
        group_id: group.id,
        template_text: DEFAULT_TEMPLATE,
      })
      await loadAutoSendTargets()
      const tpl = await window.electronAPI.adTemplateGet(platform, group.id)
      if (tpl) setAdTemplate(`${platform}:${group.id}`, tpl)
    } catch (error) {
      console.error('Erro ao adicionar target:', error)
    }
  }

  const removeAutoSendTarget = async (platform: string, groupId: string) => {
    try {
      await window.electronAPI.autoSendRemoveTarget(platform, groupId)
      await loadAutoSendTargets()
    } catch (error) {
      console.error('Erro ao remover target:', error)
    }
  }

  const toggleAutoSendTarget = async (platform: string, groupId: string, enabled: boolean) => {
    try {
      await window.electronAPI.autoSendToggleTarget(platform, groupId, enabled)
      await loadAutoSendTargets()
    } catch (error) {
      console.error('Erro ao toggle target:', error)
    }
  }

  const saveTemplate = async (platform: string, groupId: string, text: string) => {
    try {
      await window.electronAPI.adTemplateSave({
        platform,
        group_id: groupId,
        template_text: text,
      })
      setAdTemplate(`${platform}:${groupId}`, {
        platform: platform as any,
        group_id: groupId,
        template_text: text,
      })
    } catch (error) {
      console.error('Erro ao salvar template:', error)
    }
  }

  const isTargetAdded = (platform: string, groupId: string) => {
    return autoSendTargets.some((t) => t.platform === platform && t.group_id === groupId)
  }

  const affiliateStores = [
    {
      name: 'Shopee',
      icon: Store,
      color: 'text-orange-400',
      bg: 'bg-orange-400/10',
      fields: [
        { key: 'shopee_app_id', label: 'App ID', placeholder: 'Seu App ID da Shopee' },
        { key: 'shopee_app_secret', label: 'App Secret', placeholder: 'Seu App Secret da Shopee', type: 'password' },
      ],
      help: 'Obtenha em: open-api.affiliate.shopee.com.br',
    },
    {
      name: 'Mercado Livre',
      icon: Store,
      color: 'text-yellow-400',
      bg: 'bg-yellow-400/10',
      fields: [
        { key: 'mercado_livre_affiliate_id', label: 'Affiliate ID', placeholder: 'Seu Affiliate ID' },
      ],
      help: 'Obtenha em: mercadolivre.com.br/afiliados',
    },
    {
      name: 'Amazon',
      icon: Store,
      color: 'text-blue-400',
      bg: 'bg-blue-400/10',
      fields: [
        { key: 'amazon_tag', label: 'Associate Tag', placeholder: 'seu-tag-20' },
      ],
      help: 'Obtenha em: associates.amazon.com.br',
    },
    {
      name: 'AliExpress',
      icon: Store,
      color: 'text-red-400',
      bg: 'bg-red-400/10',
      fields: [
        { key: 'aliexpress_app_key', label: 'App Key', placeholder: 'Sua App Key' },
        { key: 'aliexpress_app_secret', label: 'App Secret', placeholder: 'Sua App Secret', type: 'password' },
        { key: 'aliexpress_tracking_id', label: 'Tracking ID', placeholder: 'Ex: default (criado em Promo Tools)' },
      ],
      help: 'App Key/Secret em open.aliexpress.com. Tracking ID em portals.aliexpress.com → Promo Tools → Tracking ID (NÃO é a App Key).',
    },
  ]

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Configurações</h3>
          <p className="text-sm text-muted-foreground">Gerencie credenciais, automação, templates e stealth mode</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? (
            <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
              <Settings className="w-4 h-4" />
            </motion.div>
          ) : saved ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saved ? 'Salvo!' : saving ? 'Salvando...' : 'Salvar Alterações'}
        </button>
      </div>

      {/* Credenciais */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-primary" />
          <h4 className="text-base font-semibold text-foreground">Credenciais de Afiliado</h4>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {affiliateStores.map((store) => {
            const Icon = store.icon
            return (
              <motion.div key={store.name} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="ticket-card p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg ${store.bg} flex items-center justify-center`}>
                    <Icon className={`w-5 h-5 ${store.color}`} />
                  </div>
                  <div>
                    <h5 className="text-sm font-semibold text-foreground">{store.name}</h5>
                    <p className="text-xs text-muted-foreground">{store.help}</p>
                  </div>
                </div>
                {store.fields.map((field) => (
                  <div key={field.key}>
                    <label className="text-xs text-muted-foreground mb-1 block">{field.label}</label>
                    <div className="relative">
                      <input
                        type={field.type === 'password' && !showSecrets[field.key] ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={formData[field.key as keyof typeof formData] as string}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        className="w-full h-9 px-3 pr-10 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                      {field.type === 'password' && (
                        <button
                          type="button"
                          onClick={() => setShowSecrets((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showSecrets[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </motion.div>
            )
          })}
        </div>
      </div>

      {/* Nicho e Busca Automática */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Tag className="w-5 h-5 text-primary" />
          <h4 className="text-base font-semibold text-foreground">Nicho e Busca Automática</h4>
        </div>
        <div className="ticket-card p-5 space-y-5">
          <div className="space-y-2">
            <label className="text-sm text-foreground mb-2 block">Link do Grupo de Ofertas (WhatsApp/Telegram)</label>
            <input
              type="url"
              value={formData.group_link}
              onChange={(e) => updateField('group_link', e.target.value)}
              placeholder="https://chat.whatsapp.com/... ou https://t.me/..."
              className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-muted-foreground">Este link será usado no final dos anúncios para convidar novos membros</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-foreground mb-2 block">Nicho (palavras-chave separadas por vírgula)</label>
            <input
              type="text"
              value={formData.niche}
              onChange={(e) => updateField('niche', e.target.value)}
              placeholder="eletrônicos, moda, casa, esportes..."
              className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-muted-foreground">Ex: fone bluetooth, smartwatch, tênis masculino, celular</p>
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Buscar ofertas automaticamente</p>
                <p className="text-xs text-muted-foreground">O app busca produtos em oferta nas plataformas configuradas periodicamente</p>
              </div>
            </div>
            <button onClick={() => updateField('auto_scrape_enabled', !formData.auto_scrape_enabled)} className="p-1 rounded-lg hover:bg-secondary transition-colors">
              {formData.auto_scrape_enabled ? <ToggleRight className="w-7 h-7 text-primary" /> : <ToggleLeft className="w-7 h-7 text-muted-foreground" />}
            </button>
          </div>

          {formData.auto_scrape_enabled && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-4">
              <div>
                <label className="text-sm text-foreground mb-2 block">Intervalo de busca (horas)</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="1"
                    max="24"
                    value={formData.auto_scrape_interval_hours}
                    onChange={(e) => updateField('auto_scrape_interval_hours', parseInt(e.target.value))}
                    className="flex-1 h-2 rounded-lg bg-secondary appearance-none cursor-pointer accent-primary"
                  />
                  <span className="text-sm font-mono text-foreground w-12 text-right">{formData.auto_scrape_interval_hours}h</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">A cada quantas horas o app busca novas ofertas</p>
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* Automação */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          <h4 className="text-base font-semibold text-foreground">Automação</h4>
        </div>
        <div className="ticket-card p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-foreground mb-2 block">Limite Diário WhatsApp</label>
              <div className="flex items-center gap-3">
                <input type="range" min="10" max="200" value={formData.whatsapp_daily_limit} onChange={(e) => updateField('whatsapp_daily_limit', parseInt(e.target.value))} className="flex-1 h-2 rounded-lg bg-secondary appearance-none cursor-pointer accent-primary" />
                <span className="text-sm font-mono text-foreground w-12 text-right">{formData.whatsapp_daily_limit}</span>
              </div>
            </div>
            <div>
              <label className="text-sm text-foreground mb-2 block">Limite Diário Telegram</label>
              <div className="flex items-center gap-3">
                <input type="range" min="10" max="200" value={formData.telegram_daily_limit} onChange={(e) => updateField('telegram_daily_limit', parseInt(e.target.value))} className="flex-1 h-2 rounded-lg bg-secondary appearance-none cursor-pointer accent-primary" />
                <span className="text-sm font-mono text-foreground w-12 text-right">{formData.telegram_daily_limit}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-foreground mb-2 block">Delay Mínimo (segundos)</label>
              <input type="number" min="1" max="60" value={formData.min_delay_seconds} onChange={(e) => updateField('min_delay_seconds', parseInt(e.target.value))} className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="text-sm text-foreground mb-2 block">Delay Máximo (segundos)</label>
              <input type="number" min="1" max="120" value={formData.max_delay_seconds} onChange={(e) => updateField('max_delay_seconds', parseInt(e.target.value))} className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
            <div className="flex items-center gap-3">
              <Link2 className="w-5 h-5 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Conversão Automática de Links</p>
                <p className="text-xs text-muted-foreground">Converte automaticamente links capturados em links de afiliado</p>
              </div>
            </div>
            <button onClick={() => updateField('auto_convert_links', !formData.auto_convert_links)} className="p-1 rounded-lg hover:bg-secondary transition-colors">
              {formData.auto_convert_links ? <ToggleRight className="w-7 h-7 text-primary" /> : <ToggleLeft className="w-7 h-7 text-muted-foreground" />}
            </button>
          </div>
        </div>
      </div>

      {/* Modo Stealth */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Moon className="w-5 h-5 text-primary" />
          <h4 className="text-base font-semibold text-foreground">Modo Stealth (Anti-Ban)</h4>
        </div>
        <div className="ticket-card p-5 space-y-5">
          <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
            <div className="flex items-center gap-3">
              <Eye className="w-5 h-5 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Ativar Modo Stealth</p>
                <p className="text-xs text-muted-foreground">Distribui envios ao longo do dia, respeita horários, limites por hora e cooldown entre grupos</p>
              </div>
            </div>
            <button onClick={() => updateField('stealth_mode', !formData.stealth_mode)} className="p-1 rounded-lg hover:bg-secondary transition-colors">
              {formData.stealth_mode ? <ToggleRight className="w-7 h-7 text-primary" /> : <ToggleLeft className="w-7 h-7 text-muted-foreground" />}
            </button>
          </div>

          {formData.stealth_mode && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-foreground mb-2 block">Horário Início</label>
                  <input type="number" min="0" max="23" value={formData.stealth_start_hour} onChange={(e) => updateField('stealth_start_hour', parseInt(e.target.value))} className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  <p className="text-xs text-muted-foreground mt-1">Só envia a partir desta hora</p>
                </div>
                <div>
                  <label className="text-sm text-foreground mb-2 block">Horário Fim</label>
                  <input type="number" min="0" max="23" value={formData.stealth_end_hour} onChange={(e) => updateField('stealth_end_hour', parseInt(e.target.value))} className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  <p className="text-xs text-muted-foreground mt-1">Para de enviar nesta hora</p>
                </div>
              </div>

              <div>
                <label className="text-sm text-foreground mb-2 block">Limite por Hora</label>
                <div className="flex items-center gap-3">
                  <input type="range" min="1" max="20" value={formData.stealth_hourly_limit} onChange={(e) => updateField('stealth_hourly_limit', parseInt(e.target.value))} className="flex-1 h-2 rounded-lg bg-secondary appearance-none cursor-pointer accent-primary" />
                  <span className="text-sm font-mono text-foreground w-12 text-right">{formData.stealth_hourly_limit}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Máximo de envios por hora por plataforma</p>
              </div>

              <div>
                <label className="text-sm text-foreground mb-2 block">Cooldown entre Grupos (minutos)</label>
                <div className="flex items-center gap-3">
                  <input type="range" min="1" max="60" value={formData.stealth_cooldown_minutes} onChange={(e) => updateField('stealth_cooldown_minutes', parseInt(e.target.value))} className="flex-1 h-2 rounded-lg bg-secondary appearance-none cursor-pointer accent-primary" />
                  <span className="text-sm font-mono text-foreground w-12 text-right">{formData.stealth_cooldown_minutes}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Tempo mínimo entre envios para o mesmo grupo</p>
              </div>

              <div>
                <label className="text-sm text-foreground mb-2 block">Jitter Aleatório (%)</label>
                <div className="flex items-center gap-3">
                  <input type="range" min="0" max="100" value={formData.stealth_jitter_percent} onChange={(e) => updateField('stealth_jitter_percent', parseInt(e.target.value))} className="flex-1 h-2 rounded-lg bg-secondary appearance-none cursor-pointer accent-primary" />
                  <span className="text-sm font-mono text-foreground w-12 text-right">{formData.stealth_jitter_percent}%</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Variação aleatória no delay para parecer mais humano</p>
              </div>

              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-xs text-amber-400">
                  <strong>Como funciona:</strong> O app só envia entre {formData.stealth_start_hour}h e {formData.stealth_end_hour}h,
                  máximo {formData.stealth_hourly_limit} envios/hora, espera {formData.stealth_cooldown_minutes}min entre envios no mesmo grupo,
                  e aplica {formData.stealth_jitter_percent}% de variação aleatória no tempo. Envios fora do horário são automaticamente adiados.
                </p>
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* Auto-Repost */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          <h4 className="text-base font-semibold text-foreground">Auto-Repost com Template Personalizado</h4>
        </div>
        <div className="ticket-card p-5 space-y-5">
          <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">Ativar Auto-Repost</p>
                <p className="text-xs text-muted-foreground">Captura produtos e reposta automaticamente nos grupos destino com anúncio personalizado</p>
              </div>
            </div>
            <button onClick={() => updateField('auto_repost_enabled', !formData.auto_repost_enabled)} className="p-1 rounded-lg hover:bg-secondary transition-colors">
              {formData.auto_repost_enabled ? <ToggleRight className="w-7 h-7 text-primary" /> : <ToggleLeft className="w-7 h-7 text-muted-foreground" />}
            </button>
          </div>

          {formData.auto_repost_enabled && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">Selecione os grupos destino e personalize o anúncio para cada um</p>
                <button onClick={loadAvailableGroups} disabled={loadingGroups} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50">
                  <Plus className="w-3.5 h-3.5" />
                  {loadingGroups ? 'Carregando...' : 'Carregar Grupos'}
                </button>
              </div>

              {/* WhatsApp Targets */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <MessageCircle className="w-4 h-4 text-green-400" />
                  WhatsApp
                </div>
                {autoSendTargets.filter((t) => t.platform === 'whatsapp').length === 0 ? (
                  <p className="text-xs text-muted-foreground pl-6">Nenhum grupo de destino configurado</p>
                ) : (
                  <div className="space-y-2 pl-6">
                    {autoSendTargets.filter((t) => t.platform === 'whatsapp').map((target) => {
                      const key = `${target.platform}:${target.group_id}`
                      const template = adTemplates[key]
                      const isExpanded = expandedTemplate === key
                      return (
                        <div key={target.group_id} className="rounded-lg bg-secondary/30 overflow-hidden">
                          <div className="flex items-center justify-between p-3">
                            <span className="text-sm text-foreground font-medium">{target.group_name}</span>
                            <div className="flex items-center gap-2">
                              <button onClick={() => setExpandedTemplate(isExpanded ? null : key)} className="p-1.5 rounded hover:bg-secondary transition-colors">
                                <FileText className="w-4 h-4 text-primary" />
                              </button>
                              <button onClick={() => toggleAutoSendTarget(target.platform, target.group_id, !target.enabled)} className="p-1 rounded hover:bg-secondary transition-colors">
                                {target.enabled ? <ToggleRight className="w-5 h-5 text-green-400" /> : <ToggleLeft className="w-5 h-5 text-muted-foreground" />}
                              </button>
                              <button onClick={() => removeAutoSendTarget(target.platform, target.group_id)} className="p-1 rounded hover:bg-red-500/10 transition-colors">
                                <Trash2 className="w-4 h-4 text-red-400" />
                              </button>
                            </div>
                          </div>
                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                                <div className="px-3 pb-3 space-y-2">
                                  <label className="text-xs text-muted-foreground">Template (use {'{title}'}, {'{price_line}'} — preço com desconto real, sem desconto fake —, {'{price}'}, {'{original_price}'}, {'{affiliate_url}'}, {'{store}'}, {'{description}'}, {'{group_link}'})</label>
                                  <textarea
                                    rows={4}
                                    value={template?.template_text || DEFAULT_TEMPLATE}
                                    onChange={(e) => saveTemplate(target.platform, target.group_id, e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none font-mono"
                                  />
                                  <p className="text-xs text-muted-foreground">Preview: {(template?.template_text || DEFAULT_TEMPLATE).replace(/{title}/g, 'Produto Exemplo').replace(/{price}/g, '99.90').replace(/{affiliate_url}/g, 'https://...')}</p>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )
                    })}
                  </div>
                )}
                {whatsappGroups.length > 0 && (
                  <div className="pl-6 space-y-1">
                    <p className="text-xs text-muted-foreground">Grupos disponíveis:</p>
                    {whatsappGroups.filter((g) => !isTargetAdded('whatsapp', g.id)).map((group) => (
                      <div key={group.id} className="flex items-center justify-between p-2 rounded-lg bg-secondary/20">
                        <span className="text-sm text-foreground">{group.name}</span>
                        <button onClick={() => addAutoSendTarget('whatsapp', group)} className="flex items-center gap-1 px-2 py-1 rounded bg-green-500/10 text-green-400 text-xs hover:bg-green-500/20 transition-colors">
                          <Plus className="w-3 h-3" /> Adicionar
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Telegram Targets */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Send className="w-4 h-4 text-blue-400" />
                  Telegram
                </div>
                {autoSendTargets.filter((t) => t.platform === 'telegram').length === 0 ? (
                  <p className="text-xs text-muted-foreground pl-6">Nenhum grupo de destino configurado</p>
                ) : (
                  <div className="space-y-2 pl-6">
                    {autoSendTargets.filter((t) => t.platform === 'telegram').map((target) => {
                      const key = `${target.platform}:${target.group_id}`
                      const template = adTemplates[key]
                      const isExpanded = expandedTemplate === key
                      return (
                        <div key={target.group_id} className="rounded-lg bg-secondary/30 overflow-hidden">
                          <div className="flex items-center justify-between p-3">
                            <span className="text-sm text-foreground font-medium">{target.group_name}</span>
                            <div className="flex items-center gap-2">
                              <button onClick={() => setExpandedTemplate(isExpanded ? null : key)} className="p-1.5 rounded hover:bg-secondary transition-colors">
                                <FileText className="w-4 h-4 text-primary" />
                              </button>
                              <button onClick={() => toggleAutoSendTarget(target.platform, target.group_id, !target.enabled)} className="p-1 rounded hover:bg-secondary transition-colors">
                                {target.enabled ? <ToggleRight className="w-5 h-5 text-green-400" /> : <ToggleLeft className="w-5 h-5 text-muted-foreground" />}
                              </button>
                              <button onClick={() => removeAutoSendTarget(target.platform, target.group_id)} className="p-1 rounded hover:bg-red-500/10 transition-colors">
                                <Trash2 className="w-4 h-4 text-red-400" />
                              </button>
                            </div>
                          </div>
                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                                <div className="px-3 pb-3 space-y-2">
                                  <label className="text-xs text-muted-foreground">Template (use {'{title}'}, {'{price_line}'} — preço com desconto real, sem desconto fake —, {'{price}'}, {'{original_price}'}, {'{affiliate_url}'}, {'{store}'}, {'{description}'}, {'{group_link}'})</label>
                                  <textarea
                                    rows={4}
                                    value={template?.template_text || DEFAULT_TEMPLATE}
                                    onChange={(e) => saveTemplate(target.platform, target.group_id, e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none font-mono"
                                  />
                                  <p className="text-xs text-muted-foreground">Preview: {(template?.template_text || DEFAULT_TEMPLATE).replace(/{title}/g, 'Produto Exemplo').replace(/{price}/g, '99.90').replace(/{affiliate_url}/g, 'https://...')}</p>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )
                    })}
                  </div>
                )}
                {telegramGroups.length > 0 && (
                  <div className="pl-6 space-y-1">
                    <p className="text-xs text-muted-foreground">Grupos disponíveis:</p>
                    {telegramGroups.filter((g) => !isTargetAdded('telegram', g.id)).map((group) => (
                      <div key={group.id} className="flex items-center justify-between p-2 rounded-lg bg-secondary/20">
                        <span className="text-sm text-foreground">{group.name}</span>
                        <button onClick={() => addAutoSendTarget('telegram', group)} className="flex items-center gap-1 px-2 py-1 rounded bg-blue-500/10 text-blue-400 text-xs hover:bg-blue-500/20 transition-colors">
                          <Plus className="w-3 h-3" /> Adicionar
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </div>
      </div>

      <div className="ticket-card p-4 border border-amber-500/20">
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Segurança</p>
            <p className="text-xs text-muted-foreground mt-1">Suas credenciais de afiliado são armazenadas localmente em seu computador e nunca são enviadas para servidores externos. O app funciona 100% offline.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
