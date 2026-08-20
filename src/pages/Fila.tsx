import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  ListOrdered,
  Play,
  Pause,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { formatDate } from '../lib/utils'

export default function Fila() {
  const { queueJobs, setQueueJobs } = useAppStore()
  const [isPaused, setIsPaused] = useState(false)
  const [loading, setLoading] = useState(false)

  const loadJobs = async () => {
    setLoading(true)
    try {
      const jobs = await window.electronAPI.queueGetJobs()
      setQueueJobs(jobs)
    } catch (error) {
      console.error('Erro ao carregar jobs:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadJobs()
    const unsub = window.electronAPI.onQueueUpdate((jobs) => {
      setQueueJobs(jobs)
    })
    return () => unsub()
  }, [])

  const handlePause = async () => {
    await window.electronAPI.queuePause()
    setIsPaused(true)
  }

  const handleResume = async () => {
    await window.electronAPI.queueResume()
    setIsPaused(false)
  }

  const handleClear = async () => {
    if (!confirm('Tem certeza que deseja limpar toda a fila?')) return
    await window.electronAPI.queueClear()
    setQueueJobs([])
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'waiting':
        return <Clock className="w-4 h-4 text-amber-400" />
      case 'active':
        return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-400" />
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-400" />
      case 'rescheduled':
        return <RefreshCw className="w-4 h-4 text-amber-400" />
      default:
        return <AlertCircle className="w-4 h-4 text-muted-foreground" />
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'waiting': return 'Aguardando'
      case 'active': return 'Enviando'
      case 'completed': return 'Enviado'
      case 'failed': return 'Falhou'
      // Modo stealth adiou pra mais tarde (fora do horário, limite por hora,
      // cooldown) — virou um job novo, esse aqui não foi enviado.
      case 'rescheduled': return 'Reagendado'
      default: return status
    }
  }

  const waitingCount = queueJobs.filter((j) => j.status === 'waiting').length
  const activeCount = queueJobs.filter((j) => j.status === 'active').length
  const completedCount = queueJobs.filter((j) => j.status === 'completed').length
  const failedCount = queueJobs.filter((j) => j.status === 'failed').length

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Aguardando', value: waitingCount, color: 'text-amber-400', bg: 'bg-amber-400/10' },
          { label: 'Enviando', value: activeCount, color: 'text-blue-400', bg: 'bg-blue-400/10' },
          { label: 'Enviados', value: completedCount, color: 'text-green-400', bg: 'bg-green-400/10' },
          { label: 'Falhas', value: failedCount, color: 'text-red-400', bg: 'bg-red-400/10' },
        ].map((stat) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="ticket-card p-4"
          >
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className={`text-2xl font-mono-num font-semibold ${stat.color} mt-1`}>{stat.value}</p>
          </motion.div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        {isPaused ? (
          <button
            onClick={handleResume}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Play className="w-4 h-4" />
            Retomar Fila
          </button>
        ) : (
          <button
            onClick={handlePause}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
          >
            <Pause className="w-4 h-4" />
            Pausar Fila
          </button>
        )}
        <button
          onClick={handleClear}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-destructive/30 text-destructive text-sm font-medium hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          Limpar Fila
        </button>
        <button
          onClick={loadJobs}
          disabled={loading}
          className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* Jobs List */}
      <div className="ticket-card overflow-hidden">
        {queueJobs.length === 0 ? (
          <div className="text-center py-16">
            <ListOrdered className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">Nenhum item na fila</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Plataforma</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Produto</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Grupo</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Criado</th>
                </tr>
              </thead>
              <tbody>
                {queueJobs.map((job, index) => (
                  <motion.tr
                    key={job.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: index * 0.03 }}
                    className="border-b border-border/50 hover:bg-secondary/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(job.status)}
                        <span className="text-xs text-muted-foreground">{getStatusText(job.status)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        job.platform === 'whatsapp'
                          ? 'bg-green-400/10 text-green-400'
                          : 'bg-blue-400/10 text-blue-400'
                      }`}>
                        {job.platform}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{job.productTitle}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{job.groupId}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {job.created_at ? formatDate(job.created_at) : '-'}
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
