import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  MessageCircle,
  Send,
  QrCode,
  Smartphone,
  CheckCircle2,
  Loader2,
  LogOut,
  AlertCircle,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'

export default function Conexoes() {
  const {
    whatsappStatus,
    setWhatsappStatus,
    whatsappQrCode,
    setWhatsappQrCode,
    telegramStatus,
    setTelegramStatus,
  } = useAppStore()

  const [phoneNumber, setPhoneNumber] = useState('')
  const [telegramCode, setTelegramCode] = useState('')
  const [showTelegramCode, setShowTelegramCode] = useState(false)

  useEffect(() => {
    const unsubQr = window.electronAPI.onWhatsAppQrCode((qr) => {
      setWhatsappQrCode(qr)
    })
    const unsubStatus = window.electronAPI.onWhatsAppStatus((status) => {
      setWhatsappStatus(status as any)
    })
    const unsubTelegramStatus = window.electronAPI.onTelegramStatus((status) => {
      setTelegramStatus(status as any)
      if (status === 'code_required') {
        setShowTelegramCode(true)
      }
    })
    const unsubTelegramCode = window.electronAPI.onTelegramCode(() => {
      setShowTelegramCode(true)
    })

    return () => {
      unsubQr()
      unsubStatus()
      unsubTelegramStatus()
      unsubTelegramCode()
    }
  }, [setWhatsappStatus, setWhatsappQrCode, setTelegramStatus])

  const handleWhatsAppConnect = async () => {
    await window.electronAPI.whatsappConnect()
  }

  const handleWhatsAppDisconnect = async () => {
    await window.electronAPI.whatsappDisconnect()
    setWhatsappQrCode(null)
  }

  const handleTelegramConnect = async () => {
    if (!phoneNumber.trim()) return
    await window.electronAPI.telegramConnect(phoneNumber)
  }

  const handleTelegramSendCode = async () => {
    if (!telegramCode.trim()) return
    await window.electronAPI.telegramSendCode(telegramCode)
    setShowTelegramCode(false)
    setTelegramCode('')
  }

  const handleTelegramDisconnect = async () => {
    await window.electronAPI.telegramDisconnect()
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* WhatsApp Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card rounded-xl p-6"
        >
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center">
                <MessageCircle className="w-6 h-6 text-green-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">WhatsApp</h3>
                <p className="text-sm text-muted-foreground">Envio e monitoramento de grupos</p>
              </div>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
              whatsappStatus === 'connected'
                ? 'bg-green-500/10 text-green-400'
                : whatsappStatus === 'connecting'
                ? 'bg-amber-500/10 text-amber-400'
                : 'bg-red-500/10 text-red-400'
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                whatsappStatus === 'connected' ? 'bg-green-500 status-online' :
                whatsappStatus === 'connecting' ? 'bg-amber-500 animate-pulse' :
                'bg-red-500'
              }`} />
              <span className="text-xs font-medium capitalize">{whatsappStatus}</span>
            </div>
          </div>

          {whatsappStatus === 'disconnected' && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-secondary/50">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-foreground font-medium">Como funciona?</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Escaneie o QR Code com seu WhatsApp para conectar. O app monitorará os grupos selecionados e poderá enviar produtos automaticamente.
                    </p>
                  </div>
                </div>
              </div>
              <button
                onClick={handleWhatsAppConnect}
                className="w-full h-11 rounded-lg bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors flex items-center justify-center gap-2"
              >
                <QrCode className="w-4 h-4" />
                Conectar WhatsApp
              </button>
            </div>
          )}

          {whatsappStatus === 'connecting' && (
            <div className="flex flex-col items-center py-8">
              {whatsappQrCode ? (
                <div className="space-y-4 text-center">
                  <img src={whatsappQrCode} alt="QR Code WhatsApp" className="w-64 h-64 mx-auto rounded-xl" />
                  <p className="text-sm text-muted-foreground">Escaneie o QR Code com seu WhatsApp</p>
                </div>
              ) : (
                <div className="text-center">
                  <Loader2 className="w-10 h-10 text-green-500 animate-spin mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">Gerando QR Code...</p>
                </div>
              )}
            </div>
          )}

          {whatsappStatus === 'connected' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 rounded-lg bg-green-500/5 border border-green-500/20">
                <CheckCircle2 className="w-5 h-5 text-green-400" />
                <div>
                  <p className="text-sm text-foreground font-medium">Conectado com sucesso</p>
                  <p className="text-xs text-muted-foreground">Seu WhatsApp está pronto para envios</p>
                </div>
              </div>
              <button
                onClick={handleWhatsAppDisconnect}
                className="w-full h-10 rounded-lg border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/10 transition-colors flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Desconectar
              </button>
            </div>
          )}
        </motion.div>

        {/* Telegram Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="glass-card rounded-xl p-6"
        >
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Send className="w-6 h-6 text-blue-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Telegram</h3>
                <p className="text-sm text-muted-foreground">Envio e monitoramento de grupos/canais</p>
              </div>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
              telegramStatus === 'connected'
                ? 'bg-blue-500/10 text-blue-400'
                : telegramStatus === 'connecting' || telegramStatus === 'code_required'
                ? 'bg-amber-500/10 text-amber-400'
                : 'bg-red-500/10 text-red-400'
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                telegramStatus === 'connected' ? 'bg-blue-500 status-online' :
                telegramStatus === 'connecting' || telegramStatus === 'code_required' ? 'bg-amber-500 animate-pulse' :
                'bg-red-500'
              }`} />
              <span className="text-xs font-medium capitalize">{telegramStatus}</span>
            </div>
          </div>

          {telegramStatus === 'disconnected' && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-secondary/50">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-foreground font-medium">Como funciona?</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Digite seu número de telefone com código do país. Você receberá um código SMS para confirmar.
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="relative">
                  <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="tel"
                    placeholder="+55 11 99999-9999"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="w-full h-10 pl-10 pr-4 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <button
                  onClick={handleTelegramConnect}
                  disabled={!phoneNumber.trim()}
                  className="w-full h-11 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <Send className="w-4 h-4" />
                  Conectar Telegram
                </button>
              </div>
            </div>
          )}

          {(telegramStatus === 'connecting' || telegramStatus === 'code_required') && (
            <div className="flex flex-col items-center py-4">
              {!showTelegramCode ? (
                <div className="text-center">
                  <Loader2 className="w-10 h-10 text-blue-500 animate-spin mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">Enviando código...</p>
                </div>
              ) : (
                <div className="w-full space-y-4">
                  <div className="p-4 rounded-lg bg-blue-500/5 border border-blue-500/20">
                    <p className="text-sm text-foreground text-center">
                      Digite o código recebido no Telegram
                    </p>
                  </div>
                  <input
                    type="text"
                    placeholder="Código de 5 dígitos"
                    value={telegramCode}
                    onChange={(e) => setTelegramCode(e.target.value)}
                    maxLength={5}
                    className="w-full h-10 px-4 rounded-lg bg-secondary border border-border text-sm text-foreground text-center tracking-[0.5em] font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <button
                    onClick={handleTelegramSendCode}
                    disabled={telegramCode.length < 5}
                    className="w-full h-10 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50"
                  >
                    Confirmar Código
                  </button>
                </div>
              )}
            </div>
          )}

          {telegramStatus === 'connected' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 rounded-lg bg-blue-500/5 border border-blue-500/20">
                <CheckCircle2 className="w-5 h-5 text-blue-400" />
                <div>
                  <p className="text-sm text-foreground font-medium">Conectado com sucesso</p>
                  <p className="text-xs text-muted-foreground">Seu Telegram está pronto para envios</p>
                </div>
              </div>
              <button
                onClick={handleTelegramDisconnect}
                className="w-full h-10 rounded-lg border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/10 transition-colors flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Desconectar
              </button>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}
