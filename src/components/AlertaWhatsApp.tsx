import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { WifiOff, MonitorX, Users, RefreshCw } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

type Alerta = 'sessao_invalidada' | 'substituida' | 'fora_do_ar' | 'nao_conectado'

// Cada situação diz o problema e a saída. O texto é para quem não é técnico:
// nada de "sessão", "401" ou "socket" — isso fica na aba Logs.
const CONTEUDO: Record<Alerta, { titulo: string; texto: string; acao: string; grave: boolean; Icone: typeof WifiOff }> = {
  sessao_invalidada: {
    titulo: 'O WhatsApp desconectou este computador',
    texto: 'Nada está sendo capturado dos seus grupos e canais. Leia o QR Code de novo para voltar a funcionar.',
    acao: 'Ler QR Code',
    grave: true,
    Icone: WifiOff,
  },
  substituida: {
    titulo: 'Outra conexão assumiu o seu WhatsApp',
    texto: 'O app parou para não derrubar a outra. Feche o WhatsApp Web e outras cópias do Afiliado Pro, depois reconecte.',
    acao: 'Reconectar',
    grave: true,
    Icone: MonitorX,
  },
  nao_conectado: {
    titulo: 'O WhatsApp não está conectado',
    texto: 'Você tem grupos e canais monitorados, mas nada está sendo lido. Conecte para voltar a capturar ofertas.',
    acao: 'Conectar',
    grave: true,
    Icone: Users,
  },
  fora_do_ar: {
    titulo: 'WhatsApp fora do ar há alguns minutos',
    texto: 'O app continua tentando reconectar sozinho. Se não voltar, confira a internet deste computador.',
    acao: 'Ver conexão',
    grave: false,
    Icone: RefreshCw,
  },
}

/**
 * Aviso no topo do app quando o WhatsApp precisa de ação do usuário.
 *
 * Existe por um relato real: o WhatsApp de um testador foi desconectado, e o
 * app só mostrava isso numa bolinha da barra lateral e na aba Logs. Ele não
 * viu, e só percebeu que "parou de pegar". Fica fora da tela de Conexões, onde
 * a própria tela já é o aviso.
 */
export default function AlertaWhatsApp() {
  const { whatsappAlerta, whatsappStatus } = useAppStore()
  const location = useLocation()
  const navigate = useNavigate()
  const reduzirMovimento = useReducedMotion()

  const visivel = !!whatsappAlerta && whatsappStatus !== 'connected' && location.pathname !== '/conexoes'
  const c = whatsappAlerta ? CONTEUDO[whatsappAlerta] : null

  return (
    <AnimatePresence initial={false}>
      {visivel && c && (
        <motion.div
          key={whatsappAlerta}
          initial={reduzirMovimento ? { opacity: 0 } : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="px-6 pt-5"
        >
          <div
            role={c.grave ? 'alert' : 'status'}
            className={`flex items-center gap-4 rounded-lg border px-4 py-3 ${
              c.grave ? 'border-destructive/40 bg-destructive/[0.08]' : 'border-amber-500/35 bg-amber-500/[0.07]'
            }`}
          >
            <div
              className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md ${
                c.grave ? 'bg-destructive/15 text-destructive' : 'bg-amber-500/15 text-amber-400'
              }`}
            >
              <c.Icone className="h-[18px] w-[18px]" aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{c.titulo}</p>
              <p className={`mt-0.5 text-[13px] leading-snug ${c.grave ? 'text-red-200/75' : 'text-amber-100/70'}`}>
                {c.texto}
              </p>
            </div>

            <button
              type="button"
              onClick={() => navigate('/conexoes')}
              className={`flex-shrink-0 rounded-md px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                c.grave
                  ? // red-700, e não o --destructive: texto claro sobre #e5484d dá
                    // ~3,6:1, abaixo dos 4,5:1 de texto normal. Sobre red-700, ~6,5:1.
                    'bg-red-700 text-white hover:bg-red-800 focus-visible:ring-red-500'
                  : 'border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 focus-visible:ring-amber-400'
              }`}
            >
              {c.acao}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
