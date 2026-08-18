import { NavLink, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard,
  Package,
  Link2,
  Users,
  ListOrdered,
  Settings,
  FileText,
  ChevronLeft,
  ChevronRight,
  Zap,
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { cn } from '../../lib/utils'

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/produtos', label: 'Produtos', icon: Package },
  { path: '/conexoes', label: 'Conexões', icon: Link2 },
  { path: '/grupos', label: 'Grupos', icon: Users },
  { path: '/fila', label: 'Fila de Envio', icon: ListOrdered },
  { path: '/configuracoes', label: 'Configurações', icon: Settings },
  { path: '/logs', label: 'Logs', icon: FileText },
]

export default function Sidebar() {
  const { sidebarOpen, setSidebarOpen, whatsappStatus, telegramStatus } = useAppStore()
  const location = useLocation()

  return (
    <motion.aside
      initial={false}
      animate={{ width: sidebarOpen ? 260 : 72 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="fixed left-0 top-0 h-full bg-sidebar-background border-r border-sidebar-border z-50 flex flex-col"
    >
      {/* Logo */}
      <div className="h-16 flex items-center px-4 border-b border-sidebar-border">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="w-9 h-9 rounded-xl bg-primary/20 flex items-center justify-center flex-shrink-0">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <AnimatePresence>
            {sidebarOpen && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
              >
                <h1 className="text-lg font-bold text-sidebar-foreground whitespace-nowrap">
                  Afiliado <span className="text-primary">Pro</span>
                </h1>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Status das conexões */}
      <div className="px-3 py-3 border-b border-sidebar-border">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full flex-shrink-0',
              whatsappStatus === 'connected' ? 'bg-green-500 status-online' : 'bg-red-500'
            )} />
            {sidebarOpen && (
              <span className="text-xs text-sidebar-foreground/70 truncate">
                WhatsApp {whatsappStatus === 'connected' ? 'Conectado' : 'Desconectado'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full flex-shrink-0',
              telegramStatus === 'connected' ? 'bg-blue-500 status-online' : 'bg-red-500'
            )} />
            {sidebarOpen && (
              <span className="text-xs text-sidebar-foreground/70 truncate">
                Telegram {telegramStatus === 'connected' ? 'Conectado' : 'Desconectado'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path
          const Icon = item.icon

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group relative',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent'
              )}
            >
              <Icon className={cn('w-5 h-5 flex-shrink-0', isActive && 'text-primary')} />
              <AnimatePresence>
                {sidebarOpen && (
                  <motion.span
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.2 }}
                    className="text-sm font-medium whitespace-nowrap"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
              {isActive && (
                <motion.div
                  layoutId="activeNav"
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-primary rounded-r-full"
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Toggle button */}
      <div className="p-3 border-t border-sidebar-border">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="w-full flex items-center justify-center p-2 rounded-lg hover:bg-sidebar-accent transition-colors"
        >
          {sidebarOpen ? (
            <ChevronLeft className="w-5 h-5 text-sidebar-foreground/70" />
          ) : (
            <ChevronRight className="w-5 h-5 text-sidebar-foreground/70" />
          )}
        </button>
      </div>
    </motion.aside>
  )
}
