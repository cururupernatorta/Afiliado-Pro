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
  const { setWhatsappStatus, setWhatsappQrCode, setTelegramStatus, setMercadoLivreStatus, setProducts, setGroups, setLogs } = useAppStore()

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

    // Carrega o que já está no banco assim que o app abre. Sem isto, o único
    // caminho para um produto aparecer na tela era o cadastro manual daquela
    // sessão (`addProduct`): tudo que foi capturado de grupo ou achado pela
    // busca automática era gravado pelo processo principal e nunca chegava
    // aqui, e ao fechar o app a lista voltava vazia. O IPC já existia.
    window.electronAPI.productGetAll()
      .then((p) => setProducts(p as any))
      .catch(() => { /* banco ainda abrindo — o app não deve quebrar por isso */ })
    Promise.all([
      window.electronAPI.groupGetSaved('whatsapp'),
      window.electronAPI.groupGetSaved('telegram'),
    ])
      .then(([wpp, tg]) => setGroups([...(wpp as any[]), ...(tg as any[])].map((g: any) => ({
        ...g, id: g.group_id, name: g.group_name, monitored: !!g.monitored,
      })) as any))
      .catch(() => { /* idem */ })
    window.electronAPI.logsGet(100, 0)
      .then((l) => setLogs(l as any))
      .catch(() => { /* idem */ })
    window.electronAPI.mercadoLivreGetStatus().then((status) => setMercadoLivreStatus(status))

    const unsubQr = window.electronAPI.onWhatsAppQrCode((qr) => setWhatsappQrCode(qr))
    const unsubStatus = window.electronAPI.onWhatsAppStatus((status) => setWhatsappStatus(status as any))
    const unsubTelegramStatus = window.electronAPI.onTelegramStatus((status) => setTelegramStatus(status as any))
    const unsubMercadoLivre = window.electronAPI.onMercadoLivreStatus((status) => setMercadoLivreStatus(status as any))

    return () => {
      unsubQr()
      unsubStatus()
      unsubTelegramStatus()
      unsubMercadoLivre()
    }
  }, [setWhatsappStatus, setWhatsappQrCode, setTelegramStatus, setMercadoLivreStatus])

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
