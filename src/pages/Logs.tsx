import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  FileText,
  RefreshCw,
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Filter,
  Download,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { formatDate } from '../lib/utils'

export default function Logs() {
  const { logs, setLogs, addLog } = useAppStore()
  const [loading, setLoading] = useState(false)
  const [filterType, setFilterType] = useState<string>('all')
  const [filterPlatform, setFilterPlatform] = useState<string>('all')

  const loadLogs = async () => {
    setLoading(true)
    try {
      const data = await window.electronAPI.logsGet(100, 0)
      setLogs(data)
    } catch (error) {
      console.error('Erro ao carregar logs:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadLogs()
    const unsub = window.electronAPI.onLogEntry((log) => {
      addLog(log)
    })
    return () => unsub()
  }, [])

  const filteredLogs = logs.filter((log) => {
    const matchesType = filterType === 'all' || log.type === filterType
    const matchesPlatform = filterPlatform === 'all' || log.platform === filterPlatform
    return matchesType && matchesPlatform
  })

  const getIcon = (type: string) => {
    switch (type) {
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-green-400" />
      case 'error':
        return <XCircle className="w-4 h-4 text-red-400" />
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-400" />
      default:
        return <Info className="w-4 h-4 text-blue-400" />
    }
  }

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'success': return 'Sucesso'
      case 'error': return 'Erro'
      case 'warning': return 'Aviso'
      default: return 'Info'
    }
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'success': return 'bg-green-400/10 text-green-400'
      case 'error': return 'bg-red-400/10 text-red-400'
      case 'warning': return 'bg-amber-400/10 text-amber-400'
      default: return 'bg-blue-400/10 text-blue-400'
    }
  }

  const handleExport = () => {
    const csv = [
      ['Data', 'Tipo', 'Plataforma', 'Mensagem', 'Detalhes'].join(','),
      ...filteredLogs.map((log) => [
        log.created_at,
        log.type,
        log.platform || 'system',
        `"${log.message.replace(/"/g, '""')}"`,
        `"${(log.details || '').replace(/"/g, '""')}"`,
      ].join(',')),
    ].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `afiliado-pro-logs-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="h-10 pl-10 pr-8 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none cursor-pointer"
            >
              <option value="all">Todos os tipos</option>
              <option value="info">Info</option>
              <option value="success">Sucesso</option>
              <option value="warning">Aviso</option>
              <option value="error">Erro</option>
            </select>
          </div>

          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <select
              value={filterPlatform}
              onChange={(e) => setFilterPlatform(e.target.value)}
              className="h-10 pl-10 pr-8 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none cursor-pointer"
            >
              <option value="all">Todas as plataformas</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
              <option value="system">Sistema</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <Download className="w-4 h-4" />
            Exportar CSV
          </button>
          <button
            onClick={loadLogs}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </div>

      {/* Logs List */}
      <div className="glass-card rounded-xl overflow-hidden">
        {filteredLogs.length === 0 ? (
          <div className="text-center py-16">
            <FileText className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">Nenhum log encontrado</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Tipo</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Plataforma</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Mensagem</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Detalhes</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Data</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log, index) => (
                  <motion.tr
                    key={log.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: index * 0.02 }}
                    className="border-b border-border/50 hover:bg-secondary/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {getIcon(log.type)}
                        <span className={`text-xs px-2 py-1 rounded-full ${getTypeColor(log.type)}`}>
                          {getTypeLabel(log.type)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        log.platform === 'whatsapp'
                          ? 'bg-green-400/10 text-green-400'
                          : log.platform === 'telegram'
                          ? 'bg-blue-400/10 text-blue-400'
                          : 'bg-gray-400/10 text-gray-400'
                      }`}>
                        {log.platform || 'system'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground max-w-xs truncate">{log.message}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground max-w-xs truncate">{log.details || '-'}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(log.created_at)}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
