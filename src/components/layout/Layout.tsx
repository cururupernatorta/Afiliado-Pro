import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import Sidebar from './Sidebar'
import Header from './Header'
import { useAppStore } from '../../stores/appStore'

export default function Layout({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setCurrentPage } = useAppStore()
  const location = useLocation()

  useEffect(() => {
    setCurrentPage(location.pathname)
  }, [location, setCurrentPage])

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <Header />
      <main
        className="pt-16 min-h-screen transition-all duration-300"
        style={{ marginLeft: sidebarOpen ? 260 : 72 }}
      >
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="p-6"
        >
          {children}
        </motion.div>
      </main>
    </div>
  )
}
