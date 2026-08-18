# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Affiliate marketers who run WhatsApp/Telegram groups and channels selling products via affiliate links (Shopee, Mercado Livre, Amazon, AliExpress). The app is being turned into a distributable product: the author will package and distribute it to other affiliates, not just run it themselves. So there are two audiences to design for:
- The end affiliate user: often not a developer, needs a first run / setup flow (connecting WhatsApp/Telegram, entering affiliate credentials) that doesn't assume technical background.
- The author (current user): also uses it daily as their own tool.

## Product Purpose

Afiliado Pro automates the grunt work of affiliate marketing in messaging groups: it watches WhatsApp/Telegram groups and channels for product links, scrapes current price/photo, converts the link into the user's own affiliate link, generates a humanized ad, and sends it to the user's own groups on a randomized delay schedule (to avoid spam bans). Success = the user can go from "saw a product in a group" to "posted a compliant, correctly-linked ad in my own groups" with minimal manual work, and can trust the numbers (price, link) are real.

## Positioning

Unlike a manual copy-paste workflow (or a public bot with a shared/generic affiliate link), Afiliado Pro converts links to the *user's own* affiliate ID/tracking ID automatically, scrapes real current prices instead of relying on stale text, and runs 100% locally/offline (SQLite, no cloud backend) — the user's group data and credentials never leave their machine.

## Operating Context

- Desktop Electron app, Windows-first, installed and run locally by the affiliate.
- Core workflow loop: Conexões (connect WhatsApp via QR / Telegram via phone number) → app monitors groups/channels → Produtos (products captured, scraped, edited, affiliate-link generated) → Fila (queued sends with randomized delay) → Grupos (destination groups to send to) → Logs (visibility into scraping/send failures, captcha blocks, etc.) → Configuracoes (marketplace affiliate credentials: Shopee GraphQL creds, AliExpress App Key + separate Tracking ID, etc.).
- Distribution: packaged via electron-builder, updates delivered via electron-updater from GitHub Releases — so end users are not developers and won't manually reinstall; the app must self-update and must not silently break for them.
- Reliability caveat that's a durable product fact, not a bug to hide: some scraping/search features depend on live site HTML and can break or get blocked by anti-bot measures; the product's honest fallback is manual affiliate link entry and clear error surfacing (Logs), not fake data.

## Capabilities and Constraints

- WhatsApp integration via Baileys, Telegram via its client library — both require the user's own account/session (QR / phone verification), not a shared bot account.
- Marketplaces supported: Shopee, Mercado Livre, Amazon, AliExpress. Each has its own affiliate credential setup, documented in Configurações and in CORRECOES.md/README.md.
- Generated ads must include: original price, offer/discounted price, product photo, the user's own affiliate link (never a placeholder/shared link), a humanized (generated, not scraped-copy) description, and a link to join the sending group (for when the message gets forwarded by third parties).
- Manual ad editing must be a fully working path — this is currently broken/incomplete and is on the active backlog.
- 100% offline / local SQLite storage (better-sqlite3) — no user data leaves the machine except direct calls to marketplace/affiliate APIs.
- Auto-update: electron-updater + GitHub Releases already wired in package.json; needs a real release/versioning process so shipped updates actually reach installed users.

## Brand Commitments

- Product name "Afiliado Pro" is fixed.
- No existing color palette, logo, or style guide beyond the current placeholder icon at `assets/icon.ico` — visual direction is delegated to design work (not yet decided).

## Evidence on Hand

- No screenshots, testimonials, or marketing assets on hand. Current UI (src/pages/*, src/components/*) is the only existing visual evidence, and is being treated as a redesign candidate, not a locked reference.

## Product Principles

1. Never fabricate data in the product surface: real prices, real affiliate links tied to the user's own credentials, real errors surfaced in Logs — no silent zeros or fake-looking placeholder links.
2. Design for a non-technical end user setting this up for the first time, even though the current daily user is technical — onboarding and error states matter as much as the power-user screens.
3. Respect the offline/local-first constraint: no design decision should imply or require a cloud dependency that doesn't exist.
4. Operate mode throughout: this is a task tool (connect → capture → review/edit → send), not a marketing surface — scanability and trustworthy status/error feedback outrank decoration.
