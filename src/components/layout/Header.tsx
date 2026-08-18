import { Bell, Search, Menu } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'


export default function Header() {
  const { sidebarOpen, setSidebarOpen, currentPage } = useAppStore()

  const pageTitles: Record<string, string> = {
    '/': 'Dashboard',
    '/produtos': 'Painel de Produtos',
    '/conexoes': 'Conexões',
    '/grupos': 'Grupos Monitorados',
    '/fila': 'Fila de Envio',
    '/configuracoes': 'Configurações',
    '/logs': 'Logs do Sistema',
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

        <button className="relative p-2 rounded-lg hover:bg-secondary transition-colors">
          <Bell className="w-5 h-5 text-muted-foreground" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full" />
        </button>

        <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
          <span className="text-xs font-semibold text-primary-foreground">AP</span>
        </div>
      </div>
    </header>
  )
}
