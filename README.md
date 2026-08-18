# Afiliado Pro

## Correções aplicadas neste pacote (ver CORRECOES.md para detalhes completos)

- `electron/affiliate.ts`: API da Shopee corrigida (era REST antiga/inexistente,
  agora é GraphQL correto). AliExpress corrigido (endpoint, tracking_id separado
  da App Key, removido fallback de link falso).
- `electron/scraper.ts`: extração de preço em múltiplas camadas para todas as
  lojas, detecção de página bloqueada/captcha, erro explícito em vez de preço
  0 silencioso.
- `electron/headlessScraper.ts` (novo): fallback com browser headless (Chromium
  embutido do Electron) para Shopee/AliExpress quando o scraping estático falha.
- `electron/database.ts` + `src/pages/Configuracoes.tsx`: novo campo
  "Tracking ID" do AliExpress (obrigatório e diferente da App Key).



Bot desktop de automação para afiliados. Capture produtos automaticamente de grupos do WhatsApp e Telegram, converta links em links de afiliado e envie para seus grupos com um clique.

## Funcionalidades

- **WhatsApp**: Conecte seu WhatsApp via QR Code, monitore grupos e envie produtos automaticamente
- **Telegram**: Conecte seu Telegram via número de telefone, monitore grupos/canais e envie produtos
- **Scraping automático**: Detecta links de Shopee, Mercado Livre, Amazon e AliExpress em mensagens
- **Links de afiliado**: Converte automaticamente URLs em links de afiliado (requer credenciais configuradas)
- **Painel de produtos**: CRUD completo com busca, filtros e envio em lote
- **Fila inteligente**: Envios com delays aleatórios para evitar banimentos
- **100% offline**: Dados armazenados localmente em SQLite, sem servidor na nuvem

## Requisitos

- Node.js 20+
- npm ou yarn
- Contas aprovadas nos programas de afiliado (Shopee, Mercado Livre, Amazon, AliExpress)

## Instalação

