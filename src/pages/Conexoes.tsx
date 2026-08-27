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
  ShoppingBag,
  LogIn,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'

export default function Conexoes() {
  const {
    whatsappStatus,
    whatsappQrCode,
    setWhatsappQrCode,
    telegramStatus,
    mercadoLivreStatus,
  } = useAppStore()

  const [phoneNumber, setPhoneNumber] = useState('')
  const [telegramCode, setTelegramCode] = useState('')
  const [mlLoggingIn, setMlLoggingIn] = useState(false)
  // Os listeners de status/QR agora vivem em App.tsx (sempre montado); aqui
  // só resta refletir localmente quando o backend pede o código, pra poder
  // esconder o campo de novo assim que o usuário envia (mostra um spinner
  // enquanto o backend valida, em vez de deixar o campo preenchido parado).
  const [showTelegramCode, setShowTelegramCode] = useState(false)

  useEffect(() => {
    if (telegramStatus === 'code_required') setShowTelegramCode(true)
    if (telegramStatus === 'disconnected' || telegramStatus === 'connected') setShowTelegramCode(false)
  }, [telegramStatus])

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

  const handleMercadoLivreLogin = async () => {
    setMlLoggingIn(true)
    try {
      await window.electronAPI.mercadoLivreLogin()
    } finally {
      setMlLoggingIn(false)
    }
  }

  const handleMercadoLivreLogout = async () => {
    await window.electronAPI.mercadoLivreLogout()
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* WhatsApp Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="ticket-card p-6"
        >
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-green-500/10 flex items-center justify-center">
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
          className="ticket-card p-6"
        >
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-blue-500/10 flex items-center justify-center">
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

        {/* Mercado Livre Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="ticket-card p-6"
        >
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-amber-500/10 flex items-center justify-center">
                <ShoppingBag className="w-6 h-6 text-amber-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Mercado Livre</h3>
                <p className="text-sm text-muted-foreground">Geração do link de afiliado "vitrine"</p>
              </div>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
              mercadoLivreStatus === 'connected' ? 'bg-amber-500/10 text-amber-400' : 'bg-red-500/10 text-red-400'
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                mercadoLivreStatus === 'connected' ? 'bg-amber-500 status-online' : 'bg-red-500'
              }`} />
              <span className="text-xs font-medium capitalize">{mercadoLivreStatus}</span>
            </div>
          </div>

          {mercadoLivreStatus === 'disconnected' && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-secondary/50">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-foreground font-medium">Como funciona?</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Faça login com a conta do Mercado Livre do afiliado numa janela separada — o app não vê nem guarda sua senha,
                      só reaproveita a sessão pra gerar o link de afiliado completo (com a vitrine) ao capturar produtos. Se a
                      sessão cair ou o Mercado Livre mudar algo, um aviso aparece nos Logs.
                    </p>
                  </div>
                </div>
              </div>
              <button
                onClick={handleMercadoLivreLogin}
                disabled={mlLoggingIn}
                className="w-full h-11 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {mlLoggingIn ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                Fazer login no Mercado Livre
              </button>
            </div>
          )}

          {mercadoLivreStatus === 'connected' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <CheckCircle2 className="w-5 h-5 text-amber-400" />
                <div>
                  <p className="text-sm text-foreground font-medium">Sessão conectada</p>
                  <p className="text-xs text-muted-foreground">Links de afiliado do Mercado Livre serão gerados com a vitrine completa</p>
                </div>
              </div>
              <button
                onClick={handleMercadoLivreLogout}
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
