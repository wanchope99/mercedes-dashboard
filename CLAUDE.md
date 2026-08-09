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

**Column A (Fecha) and column B (Mes) answer different questions, and installments are where they split.** Fecha is when the money moves — which day it leaves a caja. Mes is when the expense *belongs* to the business. For a purchase in `cuotas` those diverge on purpose: every row of the compra, the parent and all N children, carries the **month of the purchase** in column B, while each child's Fecha/Vencimiento carries the day its own installment is due. A locker bought on 03/08/2026 in three installments is an August expense of ARS 482,000 that happens to be paid out across September, October and November. Writing `mesDeFecha(vencimiento)` into the children — which is what the code did until 2026-08-05 — split one purchase across three months' P&L and invented future months in the app's month filter. Rows 1055–1057 were corrected in place. There is no double-counting risk from all four rows sharing a month: every aggregation (`getResumenMensual`, CMV, proyecciones) skips `esCuota` rows because the parent already carries the full amount.

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

`src/finanzas.js` models where the money set aside each month for investment recovery (`roi.js`) actually goes. Since 2026-07-24 the strategy is a single destination: 100% into `Mercado Pago Pablo`, a remunerated account at `tnaMercadoPago` (17.5% TNA), seeded with ARS 15M moved over from Galicia. It replaced a two-bucket UVA+CER ladder; movements recorded under the old `uva`/`cer` buckets are still read and shown, never migrated or dropped.

**What the pot is worth is read from the `Cajas` sheet, never summed from the registry.** `_pozoReal()` resolves the `Mercado Pago Pablo` caja *by name* (the row moves — see the `Cajas` section above) and takes its Saldo Calculado, which the spreadsheet already derives from `Movimientos`. Deriving it by summing `Finanzas Movimientos` is what the code used to do and it silently went stale: on 2026-08-03 the registry said ARS 15,092,924 against a real ARS 20,570,325, missing a 6M placement and 522,599 of withdrawals nobody had entered. A hand-kept registry cannot be the source of a number that must be right.

**That account is not a pure recovery pot, and by decision it never will be.** Pablo also pays bar expenses out of it (meat, vegetables, a wage — ARS 956,573 across 15 rows as of 2026-08-08, up from 522,599 five days earlier). On 2026-08-08 the owner settled this deliberately: `Mercado Pago Pablo` **stays a daily working account** — the rate is low but the money is instantly available, and both partners will keep drawing bar expenses from it. Do not write code that assumes the balance is recovery capital, and do not propose "keep the pot clean" as a habit change; it was considered and rejected. Telling recovery capital apart from daily traffic is the *software's* job, inside that one account. The UI shows those withdrawals on their own line instead of letting them hide inside the balance.

**Capital transfers into the pot ARE registered; the "cambios don't get duplicated" rule does not cover them.** Decided 2026-08-08. Every transfer from Galicia into `Mercado Pago Pablo` is a `colocacion` row in `Finanzas Movimientos` with an empty `MesRecupero` (own capital, not money from a close). Until then only the initial 15M had been registered while three identical later transfers had not — the same kind of movement treated two ways. The rule that cambios aren't duplicated is about **not booking a transfer as an expense in `Movimientos`**; it never meant capital placements go unrecorded. Registered rows as of that date: 15,000,000 (24/07), 6,000,000 (27/07), 1,000,000 (06/08), 1,300,000 (07/08), plus the 92,924 `interes` of 03/08 — 23,392,924, which matches the ledger's entradas into that caja exactly.

### Accrued interest is calculated, never posted

`calcularIntereses()` in `finanzas.js` answers "how much should be in Mercado Pago Pablo?" without anyone opening the account or sharing access — that is the whole point of it, and the reason it exists rather than just reading the balance.

Convention: daily rate `TNA/365` applied to the running balance, accrued every calendar day, **capitalized on business days** — what accrues Saturday and Sunday is credited Monday, so a Monday credit covers three days. That reproduces the full TNA over a year (17.5% TNA → 19.12% effective, which the tests pin). Money earns from the day it arrives. Holidays are ignored on purpose: they shift one credit by a day and do not change the period total.

**The computed accrual is never written to a sheet.** The rendimientos Mercado Pago actually pays already enter `Movimientos` as ordinary rows (matched by `RE_INTERES` against description + proveedor), and the caja balance already contains them. Posting the calculated figure as well would count the same money twice. It exists to be *compared*: `esperadosARS` vs `acreditadosARS`. A positive difference beyond `sinAcreditarARS` (interest accrued on days that have not reached a business day yet) means rendimientos are sitting in the real account and nobody has loaded them. The second comparison, `saldoEsperadoARS` vs the `Saldo Real` column, is what catches money leaving the account without a row in the ledger.

The registry (`Finanzas Movimientos`) stays, but for a different question: *which close did each peso come from*. `conciliar()` splits placements by whether they carry a `MesRecupero` (money from a month's close) or not (own capital placed alongside, like the initial 15M), and reports `valorRegistroARS` — deliberately named so nobody mistakes it for the pot's value.

**The registry is expected to read lower than the caja, and that is not a shortfall.** Transfers between cajas are recorded in `Movimientos` as type `Cambio` — the ARS 6M moved from Galicia into `Mercado Pago Pablo` on 2026-07-27 is one — and they belong there, not duplicated into the registry; copying them would track the same money twice. An earlier version of the UI showed the difference as "what still needs entering" and that was wrong. The check that does carry weight is `asignado` (from the closes) vs `deRecupero` (registered), i.e. `sinColocarARS`, which cambios never touch.

Movement types: `colocacion`, `rescate`, `renovacion`, `ajuste`, `interes`. **`interes` is excluded from `colocado`** — every other type carries a +1 sign, so counting interest as placed money would invent capital nobody contributed and drive `sinColocar` negative, firing the very false alarm that splitting out capital propio exists to prevent.

The third plane is the **projection** (`calcularProyeccion`, pure, derives everything from parameters) — it estimates interest from the TNA, while the caja balance shows what the account actually paid.

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

### The phone opens on a curated home screen, the desktop does not

On a phone (≤640px) both roles land on `tab-inicio`: four big buttons for what actually gets done daily, plus the bottom bar. On desktop that screen does not exist — the top bar already shows all ten sections, so a screen that leads to four of them would be a step backwards. The `soloPhone` flag on a `TAB_GROUPS` entry is what keeps `inicio` out of the top bar while `gruposVisibles(true)` puts it in the bottom one; that flag is the only place the two bars differ.

The four buttons come from `HOME_TELEFONO`, a hand-written per-role list, **deliberately not derived from `TAB_GROUPS`**. The whole point is that they are few and the right ones, which is a judgment call, not something computable from the menu. A button's `tab` may name a group (`dashboard`) or a submenu (`arqueo`) — `switchTab` resolves both — or carry an `accion` that opens something without navigating.

Two consequences worth knowing before touching this:

- `phonePrio` is now `?? 99`, not `|| 99`. `inicio` has priority `0`, and under `||` that fell through to 99 and put the home button last.
- Adding `inicio` costs a slot in the bottom bar's three fixed positions. `cajas` carries `phonePrio: 4` purely so the nightly arqueo stays in the `encargado`'s bar instead of being pushed into "Más"; it never reaches the admin's bar, whose 0-1-2 slots are already taken.

The "Anotar" button opens a bottom sheet that POSTs to the same `/api/mantenimiento` as the section, asking only for text and urgency — the sector is filled in later from the section, because having to pick one now is exactly what stops anything being logged mid-service. The sheet stays open if the save fails; closing it would leave the impression the item was recorded.

`MQ_PHONE`'s change listener moves off `inicio` when the viewport grows, otherwise the active panel would be one the desktop CSS hides — a blank screen.

### Mantenimiento: the fix-it list, also outside the ledger

`src/mantenimiento.js` is a notebook for things that break during service (a bulb, a leaking tap). Like Propinas it writes nothing to `Movimientos` and never reads `Cajas` — noting "the extractor needs replacing" is not having spent the money. If an item turns out to be a real investment it gets loaded into Plan de Inversiones by hand; there is deliberately no automatic link, because two lists describing the same spend is how it gets counted twice.

Three things that differ from the rest of the app:

1. **The `encargado` can use it.** He is the one on the floor when something breaks, and a flow that requires telling the admin so *they* can write it down is a flow where nothing gets written down. He can read, add, and move an item's state; he cannot delete or rewrite what someone else logged. That is enforced by `CAMPOS_ENCARGADO` in `server.js` (a whitelist passed as `actualizarItem`'s third argument), not by hiding buttons — the browser hides them too, but the server is what decides.
2. **The Telegram bot is a second entry point.** `/arreglo <texto>` → `POST /api/mantenimiento/ingest`, `/pendientes` → `GET /api/mantenimiento/pendientes`. The item is saved immediately at priority `normal` and the bot then offers buttons to change it; asking for sector and priority *before* saving is what stops it being used mid-service. Ingest auth is the same shared-secret pattern as `/api/proveedores/ingest` and reuses `PROVEEDORES_INGEST_TOKEN` (same bot, same trust boundary) unless `MANTENIMIENTO_INGEST_TOKEN` is set.
3. **Weeks are ISO weeks (Mon–Sun)**, via the pure `semanaDe()`. It is the same week Propinas splits tips over, so the two screens never disagree about which week something belongs to. The week is written into the sheet rather than derived on read, so the sheet is readable on its own in Google Sheets.

Persistence: one auto-created sheet in `SPREADSHEET_ID`, `Mantenimiento`, columns A–L. Filtering and grouping happen entirely in the browser off a single `GET /api/mantenimiento` — the list is short by nature and a round-trip per click would buy nothing.

### Informes automáticos: el código calcula, el modelo interpreta

`src/informes.js` is the core; `informe-movimientos.js`, `informe-servicios.js` and `informe-mensual.js` are the three analysts, registered in `ANALISTAS`. Adding a fourth agent is adding a file and one line — nothing in the core changes. Shared math/date helpers live in `informes-util.js` **specifically to avoid a circular require**: the core loads the analysts, so an analyst importing helpers back from the core would receive a half-built module.

**The split is the whole design.** The analyst (pure, testable, no network beyond its one read) computes every number — medians, deviations, duplicates, gaps — and emits signals carrying their exact figures and source row. The model receives only those signals and is told, in the shared system prompt, that it may not calculate anything. It never sees the raw ledger or the raw Fudo days. A model summing a thousand rows gets it wrong, and a fabricated number in a money report is worse than no report.

**Comparisons are always against a trailing median, never a mean and never year-over-year.** Two reasons, both load-bearing here: at ~1.9% monthly inflation a rising peso figure is the normal state, not a finding, and a trailing median drifts with it; and a mean is dragged by exactly the outlier you're trying to detect. `informe-servicios` additionally compares **every day against the same weekday** — in a bar the same cover count is a record on a Tuesday and a disaster on a Saturday.

**An empty report is a correct answer, and the prompts say so explicitly.** Most weeks nothing anomalous happens. An agent obliged to find something invents findings, and two weeks later nobody reads it — which is the worst failure mode, because the week something real happens it goes unread too. The UI renders the empty case as a green confirmation, not as an error. The monthly balance is the deliberate exception: it always has content.

**Month totals group by the `Mes` column, never by date** — same as `getResumenMensual` and every screen. This is not a stylistic choice: grouping July 2026 by date gives a result of ARS 9,596,477 and June 11,671,035 ("July was worse"), while grouping by `Mes` gives 12,826,657 and 6,327,289 ("July more than doubled June"). The conclusion inverts. Income happens to be identical either way; only expenses move, because instalments and deferred payments deliberately carry a `Mes` different from their `Fecha` (see the Fecha/Mes section above). A regression test pins the monthly analyst's figures to `getResumenMensual`'s. The salón side still aggregates by date because Fudo has no `Mes` column — that is correct and is why the two are computed separately.

`informe-servicios` analyses **up to the previous day**, never the day it runs (`corteEfectivo`). It fires Sunday 10:00 but Sunday's service happens Sunday night — counting it added a zero-revenue day to the week's average and flagged "didn't open" against a service that hadn't started.

Schedules (all `America/Argentina/Buenos_Aires`): movimientos Sun 10:00, servicios Sun 10:15, mensual the 1st at 10:30. Deliberately staggered — each reads a different source and makes its own model call, so overlapping them only buys contention. Each cadence is declared **once**, as data in `CADENCIAS` (`src/cron.js`), and both the cron expression and the catch-up are derived from it; written separately, changing an hour would leave the catch-up silently recovering the wrong period.

**There is a startup catch-up, since 2026-08-09.** Originally there wasn't, on the grounds that a week without a report is just a week without a report. That held while the report was a passive thing you went and looked at; once it started popping up on entry (see below), a missed run became a Sunday where the popup doesn't appear and nobody learns why. Railway restarts the container on every deploy, so a deploy landing near 10:00 on a Sunday lost that week's report permanently. `ultimaCorrida()` computes the instant the cadence last fired and passes it as `hasta`, so the recovered report gets **exactly** the period and analysis window the missed run would have produced — not today's. It costs no extra model calls: `generarInforme` is idempotent on `(tipo, periodo)` and reads the sheet first, so a normal restart is three sheet reads. Setting `INFORME_*_CRON` still overrides the schedule but **disables that report's catch-up**, because the last fire time can't be derived from an arbitrary expression and recovering the wrong period is worse than recovering nothing.

That idempotency is only as good as the read behind it, which is why `listarInformes` takes `estricto`. It normally swallows read errors and returns `[]` (the sheet not existing yet is the normal pre-first-report state). `generarInforme` passes `estricto: true` so that a Google outage raises instead of masquerading as "no report this week" — otherwise every restart during an outage would append a duplicate row and burn a model call. Only the specific "sheet doesn't exist" error (`Unable to parse range`) still reads as empty.

**The report announces itself; it doesn't wait to be found.** `pendientesPara(usuario)` returns the latest report of each type the user hasn't marked read, and the browser opens it as a modal (`informe-aviso-overlay`). The unread state lives in the sheet's `Leidos` column, **not localStorage**, because the report gets read on both the phone and the desktop and dismissing it on one has to count on the other. Only the *latest* of each type is ever pending: an unread report stops nagging by itself when the next week's replaces it, so the popup never becomes a pile that gets closed without reading. The check runs on entry, on `visibilitychange`, and every 30 minutes — the middle one matters because someone who left the tab open since Saturday neither logs in nor reloads. Both the popup and the section render through the same `informeCuerpoHTML()`, so they cannot disagree.

Model: `claude-opus-5` with structured outputs (one schema for all three, so one screen renders all three) and server-side refusal fallbacks, wrapped so a beta-flag change degrades to a plain call instead of no report. **No prompt caching** — the cache lives 5 minutes and these run weekly, so it would only ever pay the write premium.

**Visibility is per-user, not per-role** — the only such permission in the app. `INFORMES_DESTINATARIO` (default `tincho`) gates `soloDestinatarioInformes` on the server and `soloUsuario` in the browser; the three admin logins are otherwise identical, so `soloAdmin` could not distinguish them. Note this means the `admin` account does **not** see the reports, nor get the popup.

The section lives **inside Reportes** as a third submenu (`reportes` → `informes`), not as a top-level tab — it is one more report, just written by an agent instead of a query. That makes it the only `soloUsuario` at *submenu* level, applied by the sub filter in `switchGroup`; the group-level filter in `gruposVisibles` is kept in step but currently has no group using it. The panel id stays `tab-informes`, which is what the submenu resolves to.

All three analysts are **read-only**: no informe ever writes to `Movimientos`.

### Other independent modules

- `src/vinos.js` / `src/stocks.js` — wine/beverage inventory, stock rotation, and days-of-coverage analysis, cross-referencing Fudo stock+cost+price against recent sales velocity.
- `src/proyecciones.js` — forward projections (N months) built from trailing 28-day real `Movimientos` data plus user-defined one-off variables (`Proyeccion Variables` sheet); explicitly excludes one-time equipment/investment spend.
- `src/consumo.js` — manual consumption rules for non-Fudo-sold supplies (napkins, chemicals, etc.), used to estimate days-of-coverage from purchase history alone.

### Auth model

JWT-based (`JWT_SECRET`), two hardcoded roles read from env vars (`ADMIN_PASSWORD`, `CHARLY_PASSWORD`) — not a user table. Most `/api/*` routes require `adminOnly`; a small subset (cash-register open/close, quick expenses) is available to the `encargado` (manager-on-duty) role too. Cash-register state (`estadoCaja`) is held in-memory in the Node process, not persisted — a server restart loses an open, unclosed register session.

### Timezone

The entire app treats "today" as Argentina local time (`America/Argentina/Buenos_Aires`), including the Fudo "service day" cutoff (16:00 AR) used to decide which calendar day a late-night close belongs to — see `fechaServicioDe`/`fechaServicioHoy` in `src/fudo.js`. Don't use naive `Date`/UTC-based day boundaries when touching service-day or cash-register logic.
