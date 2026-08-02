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

### Propinas: deliberately outside the ledger

`src/propinas.js` splits the week's **digital** tips among the staff. Cash tips are handed out at the bar and never enter the app. The digital ones land in two accounts, `Galicia` and `Brubank`, so the module's real job is not the division (it's equal shares) but deciding **which account each transfer comes out of**.

Two things make it different from every other module here:

1. **It writes nothing to `Movimientos` and never reads `Cajas`.** Tips are third-party money passing through; putting them in the ledger would move the bar's balance by money that isn't the bar's. Known and accepted consequence: while unpaid tips sit in the Galicia bank account, the real bank balance runs above that caja's "Saldo Calculado" by exactly that amount. `Brubank` is not a caja at all and exists nowhere else in the app.
2. **`calcularReparto()` is pure and is the only place that divides anything** — the browser never computes a share, it renders what `POST /api/propinas/calcular` returns, so what you see is what gets saved and transferred.

The assignment algorithm relies on all shares being equal: order the people, then drain Galicia before Brubank. That leaves at most **one** person paid with two transfers (the one straddling the boundary), which is the minimum possible. Preferences are honored purely by that ordering — Galicia-preferrers first, no-preference next, Brubank-preferrers last. Rounding is always **down** to the chosen unit (default $100); rounding up would make the shares exceed the money in the accounts and the last transfer would bounce. The leftover is reported as `sobrante` and stays in the account.

Persistence: three sheets in `SPREADSHEET_ID`, auto-created on first use — `Propinas Personas` (the roster + each person's preferred account), `Propinas Repartos` (one row per weekly split) and `Propinas Detalle` (one row per person per split). Admin-only; the whole tab is hidden from the `encargado` and every `/api/propinas/*` route is `adminOnly`.

The roster is the same people every week, so `Propinas Personas` is seeded with `PERSONAS_DEFAULT` — but only at the moment the sheet is **created**, never when it merely reads back empty, so removing someone doesn't resurrect them next load. The UI reflects that: the normal weekly action is just unticking whoever didn't work, and add/edit/delete are hidden behind an "Editar equipo" toggle. Unticking is in-memory only and resets on reload; the `Activo` column is the persistent version of the same idea.

### Mantenimiento: the fix-it list, also outside the ledger

`src/mantenimiento.js` is a notebook for things that break during service (a bulb, a leaking tap). Like Propinas it writes nothing to `Movimientos` and never reads `Cajas` — noting "the extractor needs replacing" is not having spent the money. If an item turns out to be a real investment it gets loaded into Plan de Inversiones by hand; there is deliberately no automatic link, because two lists describing the same spend is how it gets counted twice.

Three things that differ from the rest of the app:

1. **The `encargado` can use it.** He is the one on the floor when something breaks, and a flow that requires telling the admin so *they* can write it down is a flow where nothing gets written down. He can read, add, and move an item's state; he cannot delete or rewrite what someone else logged. That is enforced by `CAMPOS_ENCARGADO` in `server.js` (a whitelist passed as `actualizarItem`'s third argument), not by hiding buttons — the browser hides them too, but the server is what decides.
2. **The Telegram bot is a second entry point.** `/arreglo <texto>` → `POST /api/mantenimiento/ingest`, `/pendientes` → `GET /api/mantenimiento/pendientes`. The item is saved immediately at priority `normal` and the bot then offers buttons to change it; asking for sector and priority *before* saving is what stops it being used mid-service. Ingest auth is the same shared-secret pattern as `/api/proveedores/ingest` and reuses `PROVEEDORES_INGEST_TOKEN` (same bot, same trust boundary) unless `MANTENIMIENTO_INGEST_TOKEN` is set.
3. **Weeks are ISO weeks (Mon–Sun)**, via the pure `semanaDe()`. It is the same week Propinas splits tips over, so the two screens never disagree about which week something belongs to. The week is written into the sheet rather than derived on read, so the sheet is readable on its own in Google Sheets.

Persistence: one auto-created sheet in `SPREADSHEET_ID`, `Mantenimiento`, columns A–L. Filtering and grouping happen entirely in the browser off a single `GET /api/mantenimiento` — the list is short by nature and a round-trip per click would buy nothing.

### Other independent modules

- `src/vinos.js` / `src/stocks.js` — wine/beverage inventory, stock rotation, and days-of-coverage analysis, cross-referencing Fudo stock+cost+price against recent sales velocity.
- `src/proyecciones.js` — forward projections (N months) built from trailing 28-day real `Movimientos` data plus user-defined one-off variables (`Proyeccion Variables` sheet); explicitly excludes one-time equipment/investment spend.
- `src/consumo.js` — manual consumption rules for non-Fudo-sold supplies (napkins, chemicals, etc.), used to estimate days-of-coverage from purchase history alone.

### Auth model

JWT-based (`JWT_SECRET`), two hardcoded roles read from env vars (`ADMIN_PASSWORD`, `CHARLY_PASSWORD`) — not a user table. Most `/api/*` routes require `adminOnly`; a small subset (cash-register open/close, quick expenses) is available to the `encargado` (manager-on-duty) role too. Cash-register state (`estadoCaja`) is held in-memory in the Node process, not persisted — a server restart loses an open, unclosed register session.

### Timezone

The entire app treats "today" as Argentina local time (`America/Argentina/Buenos_Aires`), including the Fudo "service day" cutoff (16:00 AR) used to decide which calendar day a late-night close belongs to — see `fechaServicioDe`/`fechaServicioHoy` in `src/fudo.js`. Don't use naive `Date`/UTC-based day boundaries when touching service-day or cash-register logic.
