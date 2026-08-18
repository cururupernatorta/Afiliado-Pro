import { useEffect, useState } from 'react'
import { Download, RotateCcw, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

interface UpdateInfo {
  version: string
  releaseDate?: string
  ready?: boolean
  percent?: number
}

export default function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const unsubAvailable = window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo(info)
    })
    const unsubDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
      setUpdateInfo({ ...info, ready: true })
    })
    const unsubError = window.electronAPI.onUpdateError((message) => {
      console.error('Erro no auto-update:', message)
    })
    return () => {
      unsubAvailable()
      unsubDownloaded()
      unsubError()
    }
  }, [])

  if (!updateInfo || dismissed) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -50, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -50, scale: 0.95 }}
        className={`fixed top-4 right-4 z-[9999] max-w-sm ticket-card ${
          updateInfo.ready ? 'border-emerald-500/40' : 'border-primary/40'
        }`}
      >
        <div className='p-4'>
          <div className='flex items-start gap-3'>
            <div className='mt-0.5'>
              {updateInfo.ready ? (
                <RotateCcw className='w-5 h-5 text-emerald-400' />
              ) : (
                <Download className='w-5 h-5 text-primary' />
              )}
            </div>
            <div className='flex-1 min-w-0'>
              {updateInfo.ready ? (
                <>
                  <p className='text-sm font-semibold text-emerald-400'>
                    Atualização pronta!
                  </p>
                  <p className='text-xs text-emerald-300/80 mt-1'>
                    Versão {updateInfo.version} foi baixada. Reinicie para instalar.
                  </p>
                  <div className='flex gap-2 mt-3'>
                    <button
                      onClick={() => window.electronAPI.updateInstall()}
                      className='px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-medium rounded-lg transition-colors'
                    >
                      Reiniciar Agora
                    </button>
                    <button
                      onClick={() => setDismissed(true)}
                      className='px-3 py-1.5 text-emerald-300 hover:text-emerald-200 text-xs font-medium rounded-lg transition-colors'
                    >
                      Depois
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className='text-sm font-semibold text-primary'>
                    Nova versão disponível
                  </p>
                  <p className='text-xs text-primary/70 mt-1'>
                    Versão {updateInfo.version} está sendo baixada...
                  </p>
                  {updateInfo.percent !== undefined && updateInfo.percent > 0 && (
                    <div className='mt-2'>
                      <div className='h-1.5 bg-secondary rounded-full overflow-hidden'>
                        <div
                          className='h-full bg-primary rounded-full transition-all duration-300'
                          style={{ width: `${updateInfo.percent}%` }}
                        />
                      </div>
                      <p className='text-[10px] text-primary/50 mt-1'>
                        {updateInfo.percent.toFixed(0)}%
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
            <button
              onClick={() => setDismissed(true)}
              className='text-muted-foreground hover:text-foreground transition-colors'
            >
              <X className='w-4 h-4' />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}