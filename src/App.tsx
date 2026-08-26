import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import Layout from './components/layout/Layout'
import UpdateNotification from './components/UpdateNotification'
import Dashboard from './pages/Dashboard'
import Produtos from './pages/Produtos'
import Conexoes from './pages/Conexoes'
import Grupos from './pages/Grupos'
import Fila from './pages/Fila'
import Configuracoes from './pages/Configuracoes'
import Templates from './pages/Templates'
import Logs from './pages/Logs'
import { useAppStore } from './stores/appStore'

function App() {
  const { setWhatsappStatus, setWhatsappQrCode, setTelegramStatus } = useAppStore()

  // Esses listeners viviam dentro de Conexoes.tsx, então só captavam eventos
  // enquanto o usuário estava naquela aba — o React Router desmonta a página
  // ao navegar, o listener é removido junto, e o status ficava travado no
  // último valor visto (às vezes "desconectado" de antes de conectar de
  // verdade) até o usuário voltar pra Conexões por acaso durante uma mudança
  // real de estado. Aqui em App.tsx eles ficam ativos o tempo todo, e a busca
  // inicial (getStatus) sincroniza com o estado real assim que o app abre, em
  // vez de depender só de eventos futuros.
  useEffect(() => {
    window.electronAPI.whatsappGetStatus().then((s) => {
      setWhatsappStatus(s.status)
      if (s.qrCode) setWhatsappQrCode(s.qrCode)
    })
    window.electronAPI.telegramGetStatus().then((s) => setTelegramStatus(s.status))

    const unsubQr = window.electronAPI.onWhatsAppQrCode((qr) => setWhatsappQrCode(qr))
    const unsubStatus = window.electronAPI.onWhatsAppStatus((status) => setWhatsappStatus(status as any))
    const unsubTelegramStatus = window.electronAPI.onTelegramStatus((status) => setTelegramStatus(status as any))

    return () => {
      unsubQr()
      unsubStatus()
      unsubTelegramStatus()
    }
  }, [setWhatsappStatus, setWhatsappQrCode, setTelegramStatus])

  return (
    <>
      <UpdateNotification />
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/produtos" element={<Produtos />} />
          <Route path="/conexoes" element={<Conexoes />} />
          <Route path="/grupos" element={<Grupos />} />
          <Route path="/fila" element={<Fila />} />
          <Route path="/configuracoes" element={<Configuracoes />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/logs" element={<Logs />} />
        </Routes>
      </Layout>
    </>
  )
}

export default App
