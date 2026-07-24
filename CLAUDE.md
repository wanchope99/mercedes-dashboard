# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Management dashboard for Bar Mercedes (Argentina). Two independently deployed services in one repo:

- **App** (`src/`, root) — Node/Express server + a single-page vanilla-JS dashboard (`public/index.html`, ~5300 lines, no build step, no framework). All business logic and Google Sheets/Fudo integration lives here.
- **Bot** (`bot/`) — Python Telegram bot (`bot/bot.py`). A thin client: receives invoice/receipt photos from staff and POSTs them to the App's `/api/proveedores/ingest`. It never touches Google Sheets, Fudo, or the Claude API directly — all intelligence lives in the App.

Both deploy to Railway as separate services from this same repo (see `railway.toml` header comment — do not add a root-level `startCommand`/`healthcheck`, since that would leak into the bot's service config; the bot's own start command lives in `bot/railway.json`).

## Commands

```bash
npm install
npm run dev      # nodemon src/server.js — local dev, http://localhost:3000
npm start        # node src/server.js — production
```

No test suite, linter, or build step exists. There is no `.env.example` in the repo; required env vars are documented inline in `SETUP.md` and at the top of each `src/*.js` file that reads them.

The bot (`bot/`) is a separate Python app: `pip install -r bot/requirements.txt`, run with `python bot/bot.py`. Requires `TELEGRAM_TOKEN`, `APP_BASE_URL` (pointing at the App), and `PROVEEDORES_INGEST_TOKEN` (shared secret validated by the App via the `X-Ingest-Token` header).

## Architecture

### Data sources — everything is Google Sheets + Fudo, no database

There is no database. All persistent state lives in Google Sheets, read/written directly via the `googleapis` package, and cached in-process with `node-cache` (`clearCache()` / `clearFudoCache()` invalidate on writes). Two spreadsheets are in play:

- `SPREADSHEET_ID` — "Gestión Mercedes": the core ledger. Key sheets: `Movimientos` (every income/expense row, columns A–P — see the `buildFilasCierreServicio` comment block in `server.js` for the exact column layout), `Cajas`, `Arqueo de Cajas`, `Proveedores`, `Cierres`, `Proyeccion Variables`, `Costos Proveedores`, `Consumo Insumos`, `Stock Bebidas`.
- `PROVEEDORES_SHEET_ID` ("Comparación Proveedores", defaults to `SPREADSHEET_ID` if unset) — the `Compras` sheet (ingredient-level purchase history used for cost analysis) plus its own config sheets.

Auth: a Google service account, credentials via `GOOGLE_CREDENTIALS_JSON` env var (production) or a local `credentials.json` file (dev, gitignored, never commit).

**Fudo** (the restaurant's POS) is the other external source, wrapped entirely in `src/fudo.js`: JSON:API at `api.fu.do/v1alpha1`, token auth via `auth.fu.do`, credentials `FUDO_API_KEY`/`FUDO_API_SECRET`. Fudo has no history API for stock movements or historical sales beyond a limited window — finished service-days are snapshotted permanently into the `Fudo Historico` sheet, and only days after the last snapshot are re-fetched live. `src/stock-bebidas.js` similarly snapshots daily stock levels for the Bebida (drinks) category via a cron job (`src/cron.js`, 09:00 America/Argentina/Buenos_Aires) because Fudo only exposes *current* stock, not a movement log — daily deltas are the only way to derive real consumption.

### Money flows through `Movimientos` via one write path

Every write to the ledger (cash-register close/open, quick expenses, supplier payments, invoice ingestion) ultimately appends or edits rows in the `Movimientos` sheet using the same A–P column contract. Read the header comment above `buildFilasCierreServicio` in `src/server.js` before touching any endpoint that writes rows — it documents the accounting rules (gross vs. net card settlement, delta-vs-Fudo reconciliation for cash/Mercado Pago, how installment purchases (`cuotas`) are split into a parent row + N child rows, etc). All money amounts are ARS; a fixed USD exchange rate is applied only at month-close time (`src/cierres.js`) so historical closes don't shift when old data is edited later.

### The `Cajas` sheet: never hardcode a row, always resolve by name

`Cajas` is one row per account (column A = the caja's name, F = "Saldo Calculado", G = "Saldo Real"). The F column is a `SUMIFS` over `Movimientos` column L that matches the caja name as **exact text**. Two consequences that have each caused a real bug:

1. **Any medio de pago written to `Movimientos` must be the exact name of a caja**, or that money is invisible to the sheet's balance forever. `normalizarMedio` in `server.js` and `normalizarMedioPago` in `proveedores-categorias.js` are the two funnels that enforce this — every write path goes through one of them.
2. **Row numbers shift.** On 2026-07-24 a new caja was inserted at row 3 and everything below moved down; code that hardcoded `Cajas!F8` silently started reading a different person's account. Use `filaCaja(sheets, nombre)` in `server.js`, which looks the row up by name and throws a named error rather than falling back to a default.

The accounts, and which are operational:

| Caja | Role |
|---|---|
| `Efectivo Local` | bar's cash drawer — **counted every night** |
| `Mercado Pago Tincho` | bar's operating MP account — **counted every night** |
| `Mercado Pago Pablo` | investment-recovery capital (see Finanzas) — not part of the arqueo |
| `Galicia` | bank account / card settlement |
| `Efectivo Pablo`, `Efectivo Tincho`, `USD Pablo`, `USD Tincho` | partners' own accounts |

The two arqueo cajas are `CAJA_EFECTIVO` / `CAJA_MP` in `server.js`, overridable via env vars of the same name. Bucketing a movement into the open register's session (`gastosSesion`) matches these **exactly** — a substring match on `"mercado pago"` would wrongly pull Pablo's account into the nightly count.

### Finanzas: the recovery capital sits in one account

`src/finanzas.js` models where the money set aside each month for investment recovery (`roi.js`) actually goes. Since 2026-07-24 the strategy is a single destination: 100% into `Mercado Pago Pablo`, a remunerated account at `tnaMercadoPago` (17% TNA), seeded with ARS 15M moved over from Galicia. It replaced a two-bucket UVA+CER ladder; movements recorded under the old `uva`/`cer` buckets are still read and shown, never migrated or dropped.

Two deliberately separate planes: the **projection** (`calcularProyeccion`, pure, derives everything from parameters) and the **real registry** (`Finanzas Movimientos` sheet — the audit trail proving recovery capital never mixed with the bar's operating cash). `conciliar()` compares them, splitting placements by whether they carry a `MesRecupero` (money from a month's close) or not (own capital placed alongside, like the initial 15M).

Note this strategy's nominal rate is **below** the assumed inflation, so real value declines. That is intentional — liquidity over inflation protection — and the UI surfaces the negative real rate rather than burying it.

### Cost analysis reconciles two mismatched data sources

`src/costos.js` is the core of the cost/margin reporting: it cross-references purchases (`Compras`, itemized by *ingredient*, e.g. "Carnes y Embutidos") against sales (Fudo, itemized by *product*, e.g. "Ojo de Bife"). Each Fudo product is mapped to the cost category of its dominant ingredient (a deliberate simplification, not a recipe-level BOM — see file header). `src/costos-proveedores.js` and `costos.js`'s "Proveedor Grupo CMV" mechanism provide a fallback cascade for spend that `Compras` doesn't itemize: Compras-detailed amount first, then a per-supplier Comida/Bebida/Insumos rule, then "Otros" if neither applies. `/api/cmv-desglose` and `/api/cmv-otros-detalle` expose this cascade for debugging discrepancies.

### Supplier invoice ingestion pipeline (bot → extractor → categorization → sheet)

1. Bot receives a photo, POSTs to `POST /api/proveedores/ingest` (`src/proveedores-routes.js`) with a shared-secret token.
2. `src/extractor.js` sends the image to Claude Vision (model via `EXTRACTOR_MODEL` env, default `claude-opus-4-6`) and gets back a raw list of line items. It does not normalize or categorize anything.
3. `src/proveedores-categorias.js` classifies each item into the canonical ingredient categories (same taxonomy Fudo uses), inferring from previously-seen supplier/product history rather than a static mapping table.
4. `src/unidades.js` normalizes purchase units to a base unit (e.g. "Caja x6" → 6 bottles) so purchased-vs-sold quantities are comparable.
5. Anything the pipeline can't resolve confidently (category, payment method, product match, unit factor) is queued as "pendiente" for a human to confirm via Telegram reply or the app's panel — never silently guessed.

### Other independent modules

- `src/vinos.js` / `src/stocks.js` — wine/beverage inventory, stock rotation, and days-of-coverage analysis, cross-referencing Fudo stock+cost+price against recent sales velocity.
- `src/proyecciones.js` — forward projections (N months) built from trailing 28-day real `Movimientos` data plus user-defined one-off variables (`Proyeccion Variables` sheet); explicitly excludes one-time equipment/investment spend.
- `src/consumo.js` — manual consumption rules for non-Fudo-sold supplies (napkins, chemicals, etc.), used to estimate days-of-coverage from purchase history alone.

### Auth model

JWT-based (`JWT_SECRET`), two hardcoded roles read from env vars (`ADMIN_PASSWORD`, `CHARLY_PASSWORD`) — not a user table. Most `/api/*` routes require `adminOnly`; a small subset (cash-register open/close, quick expenses) is available to the `encargado` (manager-on-duty) role too. Cash-register state (`estadoCaja`) is held in-memory in the Node process, not persisted — a server restart loses an open, unclosed register session.

### Timezone

The entire app treats "today" as Argentina local time (`America/Argentina/Buenos_Aires`), including the Fudo "service day" cutoff (16:00 AR) used to decide which calendar day a late-night close belongs to — see `fechaServicioDe`/`fechaServicioHoy` in `src/fudo.js`. Don't use naive `Date`/UTC-based day boundaries when touching service-day or cash-register logic.
