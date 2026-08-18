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
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'

export default function Grupos() {
  const { groups, setGroups, updateGroup } = useAppStore()
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'whatsapp' | 'telegram'>('whatsapp')

  const loadGroups = async () => {
    setLoading(true)
    try {
      const [waGroups, tgGroups] = await Promise.all([
        window.electronAPI.whatsappGetGroups(),
        window.electronAPI.telegramGetGroups(),
      ])

      const allGroups = [
        ...waGroups.map((g: any) => ({ ...g, platform: 'whatsapp' as const, monitored: false })),
        ...tgGroups.map((g: any) => ({ ...g, platform: 'telegram' as const, monitored: false })),
      ]

      setGroups(allGroups)
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
        await window.electronAPI.whatsappToggleMonitor(group.id, newStatus)
      } else {
        await window.electronAPI.telegramToggleMonitor(group.id, newStatus)
      }
    } catch (error) {
      updateGroup(group.id, { monitored: !newStatus })
      console.error('Erro ao toggle monitor:', error)
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
                ? 'Nenhum grupo do WhatsApp encontrado. Conecte seu WhatsApp primeiro.'
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
                    {group.platform === 'whatsapp' ? (
                      <MessageCircle className="w-5 h-5 text-green-400" />
                    ) : (
                      <Send className="w-5 h-5 text-blue-400" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{group.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {group.participants} participantes · ID: {group.id}
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
                ? 'Quando ativado, o app escuta todas as mensagens do grupo e captura automaticamente links de produtos das lojas suportadas.'
                : 'Quando ativado, o app escuta todas as mensagens do grupo/canal e captura automaticamente links de produtos das lojas suportadas.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
