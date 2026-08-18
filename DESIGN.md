# Design

<!-- impeccable:design-schema 1 -->

## Direction

**Thesis:** a "ficha de oferta" (deal-ticket) system, not a glowing SaaS dashboard. The product's real unit of work is a priced, verifiable deal (price, photo, affiliate link), so every surface is built like a flat ticket/price-tag: real 1px borders, no blur, no glow, monospace numerals wherever a number must be trusted.

**Replaced:** the incumbent implementation used the AI-generic cluster — near-black/purple background, neon green primary, translucent `glass-card` with `backdrop-filter: blur`, gradient-text headings, glowing pulse animations, and at least one fabricated data point (a hardcoded "+12% vs ontem" trend on the dashboard, which violates the product's own "never fabricate data" principle — removed). This was a redesign, not a polish of that look.

**Own-world:**
- Neutral warm-dark ground (`#121214`), not the purple-tinted near-black slop default.
- Accent is warm amber/orange (`#f0a020`) — reads as "oferta/price sticker," and stays distinct from WhatsApp's own green and Telegram's own blue, which are reserved as literal brand/status colors (connection dots, platform badges), not decoration.
- Flat cards (`.ticket-card` in `src/index.css`): solid background, solid 1px border, no backdrop blur, no drop shadow glow.
- Monospace (`.font-mono-num`, `var(--font-mono)`) on every price and count that has to look like real, checkable data — dashboard stats, product prices, queue counts.
- Typography stays a workhorse system sans (Inter) — this is an Operate-mode tool (task completion, not persuasion), where the skill's own guidance favors system stacks over display faces.

**Explicitly avoided after a mechanical detector pass:** a colored left-edge accent bar on cards ("side-tab" antipattern — one of the most recognizable AI-UI tells) and `animate-bounce` on the update-notification icon. Both were tried and removed; see `src/index.css` and `src/components/UpdateNotification.tsx`.

## Tokens

Defined in `src/index.css` (`:root` / `.dark`, both currently identical — the app is dark-only):
- `--background #121214`, `--foreground #f2f1ea`, `--card #1a1a1d`, `--border #2c2c30`
- `--primary #f0a020` (amber accent), `--primary-foreground #1a1204`
- `--destructive #e5484d`
- `--radius 0.5rem` (flatter than the previous 0.75rem)
- `--font-mono` stack for numeric data

## Components

- `.ticket-card` — the one card primitive used everywhere (`src/components/ui/card.tsx` and all pages). Flat, bordered, no blur.
- Semantic colors (WhatsApp green, Telegram blue, success/warning/error) are kept as-is in `src/components/ui/badge.tsx` — they encode real platform/status meaning, not brand decoration.

## Known compression of process

This redesign was executed without the full Impeccable decision-page / image-generation / concept-seed ceremony (no confirmed image-generation tool in this environment, and the scope — a 7-page Electron app — made the full multi-round ritual impractical in one pass). The direction above was chosen and committed directly, checked against `node scripts/detect.mjs`, and verified structurally (all 7 routes load without console errors) via a browser preview with a dev-only `window.electronAPI` mock (`src/lib/electronMock.ts`, only installs when `window.electronAPI` is absent — never runs inside the real Electron build). Pixel screenshots could not be captured in this sandbox (browser pane did not composite frames); the user should sanity-check the actual look with `npm run dev` before relying on this document as ground truth for a future `/impeccable polish` or `document` pass.
