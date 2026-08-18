# Correções aplicadas neste pacote

## 1. Link de afiliado da Shopee nunca funcionava

O código antigo chamava `open-api.affiliate.shopee.com.br/api/v1/affiliate-link/generate`
(API REST que não existe mais). A Shopee migrou o Affiliate Open API para
**GraphQL**, com autenticação via header `Authorization: SHA256 Credential=...`.
Reescrito em `electron/affiliate.ts` → `convertShopee()`.

## 2. Link de afiliado do AliExpress vinha "falso"

Três problemas em `convertAliExpress()`:
- Endpoint errado (`/rest` em vez de `/sync`)
- `tracking_id` usando a **App Key** — só que o Tracking ID é um valor **separado**,
  criado em portals.aliexpress.com → Promo Tools → Tracking ID
- O "fallback" antigo colava parâmetros inventados (`aff_fcid`, `sk`, `terminal_id`)
  na URL original — isso parece link de afiliado mas não rastreia nada. Removido:
  agora, se a API falhar, o app usa a URL original sem fingir que é afiliado.

**Ação necessária de sua parte:** preencha o novo campo "Tracking ID" em
Configurações → AliExpress (não é a App Key).

## 3. Preço saindo 0

- Shopee, Mercado Livre e Amazon agora usam a mesma extração em camadas que só
  o AliExpress tinha (meta tag → JSON inline → seletor CSS → texto no body).
- Todos os scrapers agora detectam página de captcha/bloqueio e lançam um erro
  claro (visível em Logs) em vez de criar produto com preço R$ 0 silenciosamente.
- Shopee e AliExpress agora têm um **fallback com browser headless**
  (`electron/headlessScraper.ts`): se o scraping estático falhar, o app abre uma
  janela invisível do próprio Chromium do Electron, deixa o JavaScript da página
  rodar de verdade, e tenta extrair o preço de novo. Sem dependência nova.

## Limitações que continuam existindo (não são bugs, são a natureza de scraping sem API oficial)

- `searchDeals()` (busca automática por nicho) usa seletores CSS "chutados" contra
  o HTML atual de cada site de busca/ofertas. Sites mudam o front-end com frequência
  — se a busca parar de trazer resultados, o seletor provavelmente precisa ser
  atualizado olhando o HTML atual da página.
- Mesmo com o fallback headless, sites podem detectar automação e bloquear de vez
  em quando. Nesses casos, use o campo "Link de Afiliado Manual" ao cadastrar o
  produto manualmente.
