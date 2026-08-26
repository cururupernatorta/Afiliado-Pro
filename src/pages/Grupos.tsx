import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  Users,
  MessageCircle,
  Send,
  RefreshCw,
  ToggleRight,
  ToggleLeft,
  Eye,
  EyeOff,
  Loader2,
  Radio,
  Plus,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'

const isChannel = (groupId: string) => groupId.endsWith('@newsletter')

export default function Grupos() {
  const { groups, setGroups, updateGroup } = useAppStore()
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'whatsapp' | 'telegram'>('whatsapp')
  const [channelInput, setChannelInput] = useState('')
  const [addingChannel, setAddingChannel] = useState(false)

  const loadGroups = async () => {
    setLoading(true)
    try {
      const [waGroups, tgGroups, waSaved, tgSaved] = await Promise.all([
        window.electronAPI.whatsappGetGroups(),
        window.electronAPI.telegramGetGroups(),
        window.electronAPI.groupGetSaved('whatsapp'),
        window.electronAPI.groupGetSaved('telegram'),
      ])

      // Cruza a lista ao vivo (Baileys/gramjs) com o estado salvo no banco —
      // sem isso a tela sempre mostrava "Não monitorado" pra tudo ao carregar,
      // mesmo pro que já tinha sido ativado antes. Também inclui linhas salvas
      // que não vêm na lista ao vivo: canais de transmissão do WhatsApp não têm
      // API pra listagem em massa, só ficam visíveis a partir do que já foi
      // adicionado e salvo no banco.
      const merge = (live: any[], saved: any[], platform: 'whatsapp' | 'telegram') => {
        const savedMap = new Map(saved.map((s) => [s.group_id, s]))
        const merged = live.map((g) => ({
          ...g,
          platform,
          monitored: !!savedMap.get(g.id)?.monitored,
        }))
        const liveIds = new Set(live.map((g) => g.id))
        const savedOnly = saved
          .filter((s) => !liveIds.has(s.group_id))
          .map((s) => ({
            id: s.group_id,
            name: s.group_name,
            participants: 0,
            platform,
            monitored: !!s.monitored,
          }))
        return [...merged, ...savedOnly]
      }

      setGroups([
        ...merge(waGroups, waSaved, 'whatsapp'),
        ...merge(tgGroups, tgSaved, 'telegram'),
      ])
    } catch (error) {
      console.error('Erro ao carregar grupos:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadGroups()
  }, [])

  const handleToggleMonitor = async (group: any) => {
    const newStatus = !group.monitored
    updateGroup(group.id, { monitored: newStatus })

    try {
      if (group.platform === 'whatsapp') {
        await window.electronAPI.whatsappToggleMonitor(group.id, group.name, newStatus)
      } else {
        await window.electronAPI.telegramToggleMonitor(group.id, group.name, newStatus)
      }
    } catch (error) {
      updateGroup(group.id, { monitored: !newStatus })
      console.error('Erro ao toggle monitor:', error)
    }
  }

  const handleAddChannel = async () => {
    if (!channelInput.trim()) return
    setAddingChannel(true)
    try {
      await window.electronAPI.whatsappAddChannel(channelInput.trim())
      setChannelInput('')
      await loadGroups()
    } catch (error) {
      alert('Erro ao adicionar canal: ' + (error as Error).message)
    } finally {
      setAddingChannel(false)
    }
  }

  const filteredGroups = groups.filter((g) => g.platform === activeTab)

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setActiveTab('whatsapp')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'whatsapp'
              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
        >
          <MessageCircle className="w-4 h-4" />
          WhatsApp
        </button>
        <button
          onClick={() => setActiveTab('telegram')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'telegram'
              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
        >
          <Send className="w-4 h-4" />
          Telegram
        </button>
        <button
          onClick={loadGroups}
          disabled={loading}
          className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* Adicionar canal de transmissão (só WhatsApp — Telegram já lista canais junto com os grupos) */}
      {activeTab === 'whatsapp' && (
        <div className="ticket-card p-4">
          <p className="text-sm font-medium text-foreground mb-1 flex items-center gap-2">
            <Radio className="w-4 h-4 text-green-400" />
            Adicionar canal de transmissão
          </p>
          <p className="text-xs text-muted-foreground mb-3">
            Cole o link de convite do canal (ex: whatsapp.com/channel/...). O WhatsApp não permite listar
            canais automaticamente, então eles são adicionados um a um por aqui.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={channelInput}
              onChange={(e) => setChannelInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddChannel()}
              placeholder="https://whatsapp.com/channel/..."
              className="flex-1 h-10 px-3 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <button
              onClick={handleAddChannel}
              disabled={addingChannel || !channelInput.trim()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {addingChannel ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Adicionar
            </button>
          </div>
        </div>
      )}

      {/* Groups List */}
      <div className="ticket-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="text-center py-16">
            <Users className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">
              {activeTab === 'whatsapp'
                ? 'Nenhum grupo ou canal do WhatsApp encontrado. Conecte seu WhatsApp primeiro, ou adicione um canal pelo link acima.'
                : 'Nenhum grupo do Telegram encontrado. Conecte seu Telegram primeiro.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {filteredGroups.map((group, index) => (
              <motion.div
                key={`${group.platform}-${group.id}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="flex items-center justify-between p-4 hover:bg-secondary/30 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    group.platform === 'whatsapp'
                      ? 'bg-green-500/10'
                      : 'bg-blue-500/10'
                  }`}>
                    {group.platform === 'whatsapp' && isChannel(group.id) ? (
                      <Radio className="w-5 h-5 text-green-400" />
                    ) : group.platform === 'whatsapp' ? (
                      <MessageCircle className="w-5 h-5 text-green-400" />
                    ) : (
                      <Send className="w-5 h-5 text-blue-400" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground flex items-center gap-2">
                      {group.name}
                      {group.platform === 'whatsapp' && isChannel(group.id) && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                          Canal
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {group.platform === 'whatsapp' && isChannel(group.id)
                        ? `ID: ${group.id}`
                        : `${group.participants} participantes · ID: ${group.id}`}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    {group.monitored ? (
                      <Eye className="w-4 h-4 text-green-400" />
                    ) : (
                      <EyeOff className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span className="text-xs text-muted-foreground">
                      {group.monitored ? 'Monitorando' : 'Não monitorado'}
                    </span>
                  </div>

                  <button
                    onClick={() => handleToggleMonitor(group)}
                    className="p-2 rounded-lg hover:bg-secondary transition-colors"
                  >
                    {group.monitored ? (
                      <ToggleRight className="w-6 h-6 text-green-400" />
                    ) : (
                      <ToggleLeft className="w-6 h-6 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="ticket-card p-4">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg ${
            activeTab === 'whatsapp' ? 'bg-green-500/10' : 'bg-blue-500/10'
          }`}>
            {activeTab === 'whatsapp' ? (
              <MessageCircle className="w-4 h-4 text-green-400" />
            ) : (
              <Send className="w-4 h-4 text-blue-400" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {activeTab === 'whatsapp' ? 'Monitoramento WhatsApp' : 'Monitoramento Telegram'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {activeTab === 'whatsapp'
                ? 'Quando ativado, o app escuta todas as mensagens do grupo/canal e captura automaticamente links de produtos das lojas suportadas.'
                : 'Quando ativado, o app escuta todas as mensagens do grupo/canal e captura automaticamente links de produtos das lojas suportadas.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
