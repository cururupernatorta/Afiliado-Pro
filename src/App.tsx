import { Routes, Route } from 'react-router-dom'
import Layout from './components/layout/Layout'
import UpdateNotification from './components/UpdateNotification'
import Dashboard from './pages/Dashboard'
import Produtos from './pages/Produtos'
import Conexoes from './pages/Conexoes'
import Grupos from './pages/Grupos'
import Fila from './pages/Fila'
import Configuracoes from './pages/Configuracoes'
import Logs from './pages/Logs'

function App() {
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
          <Route path="/logs" element={<Logs />} />
        </Routes>
      </Layout>
    </>
  )
}

export default App
