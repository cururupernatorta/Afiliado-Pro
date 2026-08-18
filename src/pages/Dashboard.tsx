import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Package,
  Send,
  Users,
  Activity,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { formatCurrency, formatDate } from '../lib/utils'

const stats = [
  { label: 'Total de Produtos', icon: Package, key: 'products' },
  { label: 'Envios Hoje', icon: Send, key: 'sends' },
  { label: 'Grupos Ativos', icon: Users, key: 'groups' },
  { label: 'Produtos Capturados', icon: Activity, key: 'captured' },
]

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
}

export default function Dashboard() {
  const { products, groups, queueJobs, logs, whatsappStatus, telegramStatus } = useAppStore()
  const [recentProducts, setRecentProducts] = useState(products.slice(0, 5))

  useEffect(() => {
    setRecentProducts(products.slice(0, 5))
  }, [products])

  const statsData = {
    products: products.length,
    sends: queueJobs.filter((j) => j.status === 'completed').length,
    groups: groups.filter((g) => g.monitored).length,
    captured: products.filter((p) => p.source !== 'manual').length,
  }

  const recentLogs = logs.slice(0, 10)

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        {stats.map((stat) => {
          const Icon = stat.icon
          const value = statsData[stat.key as keyof typeof statsData] || 0

          return (
            <motion.div
              key={stat.key}
              variants={itemVariants}
              className="ticket-card p-5"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p className="text-3xl font-mono-num font-semibold text-foreground mt-1">{value}</p>
                </div>
                <div className="p-2.5 rounded-md bg-secondary">
                  <Icon className="w-5 h-5 text-muted-foreground" />
                </div>
              </div>
            </motion.div>
          )
        })}
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Produtos Recentes */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="lg:col-span-2 ticket-card p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Produtos Recentes</h3>
            <span className="text-xs text-muted-foreground">Últimos 5 cadastrados</span>
          </div>

          <div className="space-y-3">
            {recentProducts.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Package className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Nenhum produto cadastrado ainda</p>
              </div>
            ) : (
              recentProducts.map((product, index) => (
                <motion.div
                  key={product.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.1 * index }}
                  className="flex items-center gap-4 p-3 rounded-md bg-secondary/50 hover:bg-secondary transition-colors"
                >
                  <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center overflow-hidden">
                    {product.image_url ? (
                      <img src={product.image_url} alt={product.title} className="w-full h-full object-cover" />
                    ) : (
                      <Package className="w-5 h-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{product.title}</p>
                    <p className="text-xs text-muted-foreground font-mono-num">
                      {formatCurrency(product.price)} · {product.store}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className={`text-xs px-2 py-1 rounded-full ${
                      product.source === 'manual'
                        ? 'bg-blue-400/10 text-blue-400'
                        : product.source === 'whatsapp'
                        ? 'bg-green-400/10 text-green-400'
                        : 'bg-purple-400/10 text-purple-400'
                    }`}>
                      {product.source}
                    </span>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </motion.div>

        {/* Status + Logs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="space-y-6"
        >
          {/* Status das Conexões */}
          <div className="ticket-card p-5">
            <h3 className="text-lg font-semibold text-foreground mb-4">Status das Conexões</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-md bg-secondary/50">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${whatsappStatus === 'connected' ? 'bg-green-500 status-online' : 'bg-red-500'}`} />
                  <span className="text-sm text-foreground">WhatsApp</span>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  whatsappStatus === 'connected'
                    ? 'bg-green-400/10 text-green-400'
                    : 'bg-red-400/10 text-red-400'
                }`}>
                  {whatsappStatus === 'connected' ? 'Online' : 'Offline'}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-md bg-secondary/50">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${telegramStatus === 'connected' ? 'bg-blue-500 status-online' : 'bg-red-500'}`} />
                  <span className="text-sm text-foreground">Telegram</span>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  telegramStatus === 'connected'
                    ? 'bg-blue-400/10 text-blue-400'
                    : 'bg-red-400/10 text-red-400'
                }`}>
                  {telegramStatus === 'connected' ? 'Online' : 'Offline'}
                </span>
              </div>
            </div>
          </div>

          {/* Logs Recentes */}
          <div className="ticket-card p-5">
            <h3 className="text-lg font-semibold text-foreground mb-4">Logs Recentes</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {recentLogs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">Nenhum log ainda</p>
              ) : (
                recentLogs.map((log) => (
                  <div key={log.id} className="flex items-start gap-2 p-2 rounded-md bg-secondary/30">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                      log.type === 'success' ? 'bg-green-400' :
                      log.type === 'error' ? 'bg-red-400' :
                      log.type === 'warning' ? 'bg-amber-400' :
                      'bg-blue-400'
                    }`} />
                    <div className="min-w-0">
                      <p className="text-xs text-foreground truncate">{log.message}</p>
                      <p className="text-[10px] text-muted-foreground">{formatDate(log.created_at)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
