import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, Search, Menu, CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react'
import { useAppStore, LogEntry } from '../../stores/appStore'

const AppLogo = () => (
  <svg viewBox="0 0 256 256" className="w-8 h-8" aria-label="Afiliado Pro">
    <rect x="0" y="0" width="256" height="256" rx="56" fill="#f0a020" />
    <path
      fill="#1a1204"
      fillRule="evenodd"
      d="M 96 52 L 152 52 L 208 128 L 152 204 L 96 204 A 26 26 0 0 1 70 178 L 70 78 A 26 26 0 0 1 96 52 Z
         M 100 84 m -15 0 a 15 15 0 1 0 30 0 a 15 15 0 1 0 -30 0"
    />
  </svg>
)

function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes} min atrás`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h atrás`
  const days = Math.floor(hours / 24)
  return `${days}d atrás`
}

function notifIcon(type: LogEntry['type']) {
  switch (type) {
    case 'success': return <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
    case 'error': return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
    case 'warning': return <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
    default: return <Info className="w-4 h-4 text-blue-400 flex-shrink-0" />
  }
}

export default function Header() {
  const { sidebarOpen, setSidebarOpen, currentPage, logs, setLogs, addLog } = useAppStore()
  const navigate = useNavigate()
  const [notifOpen, setNotifOpen] = useState(false)
  const [lastSeenId, setLastSeenId] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  const pageTitles: Record<string, string> = {
    '/': 'Dashboard',
    '/produtos': 'Painel de Produtos',
    '/conexoes': 'Conexões',
    '/grupos': 'Grupos Monitorados',
    '/fila': 'Fila de Envio',
    '/templates': 'Templates',
    '/configuracoes': 'Configurações',
    '/logs': 'Logs do Sistema',
  }

  useEffect(() => {
    window.electronAPI.logsGet(30, 0).then((data) => {
      setLogs(data)
      setLastSeenId(data[0]?.id ?? 0)
    }).catch(() => {})

    const unsub = window.electronAPI.onLogEntry((entry) => addLog(entry))
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!notifOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setNotifOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [notifOpen])

  const unreadCount = logs.filter((l) => l.id > lastSeenId).length

  const toggleNotifications = () => {
    setNotifOpen((open) => {
      if (!open) setLastSeenId(logs[0]?.id ?? lastSeenId)
      return !open
    })
  }

  return (
    <header className="h-16 border-b border-border bg-background fixed top-0 right-0 z-40 flex items-center justify-between px-6"
      style={{ left: sidebarOpen ? 260 : 72, transition: 'left 0.3s ease' }}
    >
      <div className="flex items-center gap-4">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="lg:hidden p-2 rounded-lg hover:bg-secondary transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <h2 className="text-xl font-semibold text-foreground">
          {pageTitles[currentPage] || 'Afiliado Pro'}
        </h2>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative hidden sm:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Buscar..."
            className="w-64 h-9 pl-9 pr-4 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
          />
        </div>

        <div className="relative" ref={panelRef}>
          <button
            onClick={toggleNotifications}
            className="relative p-2 rounded-lg hover:bg-secondary transition-colors"
          >
            <Bell className="w-5 h-5 text-muted-foreground" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center bg-primary rounded-full text-[10px] font-semibold text-primary-foreground">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          <AnimatePresence>
            {notifOpen && (
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.15 }}
                className="absolute right-0 top-full mt-2 w-80 max-h-[28rem] flex flex-col ticket-card overflow-hidden z-50"
              >
                <div className="px-4 py-3 border-b border-border">
                  <p className="text-sm font-semibold text-foreground">Notificações</p>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {logs.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                      Nenhuma notificação ainda
                    </p>
                  ) : (
                    logs.slice(0, 20).map((entry) => (
                      <div
                        key={entry.id}
                        className="px-4 py-3 border-b border-border last:border-b-0 flex items-start gap-2.5 hover:bg-secondary/50 transition-colors"
                      >
                        {notifIcon(entry.type)}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground leading-snug">{entry.message}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{timeAgo(entry.created_at)}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <button
                  onClick={() => { setNotifOpen(false); navigate('/logs') }}
                  className="px-4 py-2.5 text-xs font-medium text-primary hover:bg-secondary transition-colors border-t border-border"
                >
                  Ver todos os logs
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0" title="Afiliado Pro">
          <AppLogo />
        </div>
      </div>
    </header>
  )
}
