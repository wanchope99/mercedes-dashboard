// ─── Plan de Inversiones — gastos extraordinarios (capex) planificados ──────────
//
// El dueño ya registra todos los costos/ingresos reales y tiene la sección
// Proyecciones. Lo que falta es PLANIFICAR los gastos de una sola vez
// ("extraordinarios": comprar aires, sistema de extracción, pintar, etc.): un
// backlog priorizado que se agenda mes a mes, guiado por un presupuesto sugerido
// (por defecto 2% del ingreso proyectado del mes, ajustable).
//
// Persistencia (sin base de datos, como todo el resto): dos hojas en la planilla
// maestra SPREADSHEET_ID, creadas automáticamente al primer uso.
//
//   Hoja "Plan Inversiones" — un ítem por fila:
//     A ID | B Nombre | C CostoEstimado | D Categoria | E Prioridad |
//     F MesObjetivo (ISO "YYYY-MM", vacío = backlog) | G Estado
//     (backlog|planificado|hecho) | H Notas | I Actualizado
//
//   Hoja "Plan Config" — clave/valor:
//     A Clave | B Valor
//     budgetPct (default 2) · incluirEnProyeccion (TRUE/FALSE) ·
//     override:YYYY-MM = <ARS> (presupuesto absoluto para un mes puntual)
//
// Los ítems agendados (MesObjetivo presente y estado != hecho) pueden inyectarse
// como gastos en la proyección — ver planGastosProgramados() y proyectar() en
// proyecciones.js. Los "hecho" se excluyen: ya aparecen como Movimientos reales,
// así se evita contarlos dos veces.
//
// Cache: 5 min en memoria. Se invalida tras cada write.

const { google } = require('googleapis');
const NodeCache = require('node-cache');
const { ORDEN_MESES } = require('./proyecciones');

const cache = new NodeCache({ stdTTL: 300 });
const CACHE_KEY = 'plan_inversiones';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.PLAN_SHEET || 'Plan Inversiones';
const HOJA_CONFIG = process.env.PLAN_CONFIG_SHEET || 'Plan Config';

const HEADER = ['ID', 'Nombre', 'CostoEstimado', 'Categoria', 'Prioridad', 'MesObjetivo', 'Estado', 'Notas', 'Actualizado'];
const HEADER_CONFIG = ['Clave', 'Valor'];

const DEFAULT_CONFIG = { budgetPct: 2, incluirEnProyeccion: false, overrides: {} };

function _sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function _ensureHoja(api, titulo, header, rango) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${titulo}!${rango}`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

// ─── Lectura ────────────────────────────────────────────────────────────────
function _num(v) { return Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0; }

async function _leerItems(api) {
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:I` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA, HEADER, 'A1:I1');
    return [];
  }
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    items.push({
      id: r[0].toString().trim(),
      nombre: (r[1] || '').toString().trim(),
      costoEstimado: _num(r[2]),
      categoria: (r[3] || '').toString().trim(),
      prioridad: r[4] === '' || r[4] == null ? 999 : Math.round(_num(r[4])),
      mesObjetivo: (r[5] || '').toString().trim(),   // "YYYY-MM" o ''
      estado: (r[6] || 'backlog').toString().trim(),
      notas: (r[7] || '').toString().trim(),
      actualizado: (r[8] || '').toString().trim(),
      rowIndex: i + 1,
    });
  }
  return items;
}

async function _leerConfig(api) {
  const cfg = { budgetPct: DEFAULT_CONFIG.budgetPct, incluirEnProyeccion: false, overrides: {} };
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_CONFIG}!A:B` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA_CONFIG, HEADER_CONFIG, 'A1:B1');
    return cfg;
  }
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const clave = r[0].toString().trim();
    const valor = (r[1] == null ? '' : r[1]).toString().trim();
    if (clave === 'budgetPct') cfg.budgetPct = _num(valor);
    else if (clave === 'incluirEnProyeccion') cfg.incluirEnProyeccion = valor.toUpperCase() === 'TRUE';
    else if (clave.startsWith('override:')) cfg.overrides[clave.slice('override:'.length)] = _num(valor);
  }
  return cfg;
}

// Devuelve { items, config, _rows } cacheado. _rows es el mapa clave→rowIndex de Plan Config.
async function _load() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return { items: [], config: { ...DEFAULT_CONFIG }, configRows: {} };
  const api = _sheets();
  const [items, config] = await Promise.all([_leerItems(api), _leerConfig(api)]);
  const data = { items, config };
  cache.set(CACHE_KEY, data);
  return data;
}

// API pública: { items, config }
async function listPlan() {
  const { items, config } = await _load();
  return {
    items: items.map(({ rowIndex, ...rest }) => rest),
    config,
  };
}

// ─── Escritura ──────────────────────────────────────────────────────────────
// Upsert de un ítem. Genera id si no viene. Devuelve el ítem guardado.
async function guardarItem(item) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  if (!item || !item.nombre) throw new Error('Falta nombre');
  const api = _sheets();
  await _ensureHoja(api, HOJA, HEADER, 'A1:I1');
  const items = await _leerItems(api);

  const id = item.id || `p${Date.now()}`;
  const existing = item.id ? items.find(x => x.id === item.id) : null;
  const guardado = {
    id,
    nombre: item.nombre.toString().trim(),
    costoEstimado: Math.max(0, Math.round(_num(item.costoEstimado))),
    categoria: (item.categoria || '').toString().trim(),
    prioridad: item.prioridad === '' || item.prioridad == null ? (existing ? existing.prioridad : 999) : Math.round(_num(item.prioridad)),
    mesObjetivo: (item.mesObjetivo || '').toString().trim(),
    estado: (item.estado || (existing && existing.estado) || 'backlog').toString().trim(),
    notas: (item.notas != null ? item.notas : (existing ? existing.notas : '')).toString().trim(),
  };
  const fila = [
    guardado.id, guardado.nombre, guardado.costoEstimado, guardado.categoria,
    guardado.prioridad, guardado.mesObjetivo, guardado.estado, guardado.notas,
    new Date().toISOString(),
  ];

  if (existing) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A${existing.rowIndex}:I${existing.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [fila] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A:I`,
      valueInputOption: 'RAW',
      requestBody: { values: [fila] },
    });
  }
  cache.del(CACHE_KEY);
  return guardado;
}

async function deleteItem(id) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  const items = await _leerItems(api);
  const it = items.find(x => x.id === id);
  if (!it) throw new Error('Ítem no encontrado');
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === HOJA);
  if (!sheet) throw new Error('No existe la hoja del plan');
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: 'ROWS',
      startIndex: it.rowIndex - 1, endIndex: it.rowIndex,
    } } }] },
  });
  cache.del(CACHE_KEY);
}

// Upsert de una clave de configuración (budgetPct, incluirEnProyeccion, override:YYYY-MM).
async function guardarConfig(clave, valor) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  if (!clave) throw new Error('Falta clave');
  const api = _sheets();
  await _ensureHoja(api, HOJA_CONFIG, HEADER_CONFIG, 'A1:B1');

  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_CONFIG}!A:B` });
    rows = res.data.values || [];
  } catch (e) { rows = []; }

  let rowIndex = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i][0] && rows[i][0].toString().trim() === clave) { rowIndex = i + 1; break; }
  }
  const fila = [clave, valor == null ? '' : String(valor)];
  if (rowIndex > 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA_CONFIG}!A${rowIndex}:B${rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA_CONFIG}!A:B`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  }
  cache.del(CACHE_KEY);
}

// Ítems agendados a un mes y NO hechos, listos para inyectar en la proyección.
// Devuelve [{ anio, mes (nombre español), monto, nombre }].
async function planGastosProgramados() {
  const { items } = await _load();
  const out = [];
  for (const it of items) {
    if (!it.mesObjetivo || it.estado === 'hecho') continue;
    const m = /^(\d{4})-(\d{2})$/.exec(it.mesObjetivo);
    if (!m) continue;
    const anio = Number(m[1]);
    const mesIdx = Number(m[2]) - 1;
    if (mesIdx < 0 || mesIdx > 11) continue;
    out.push({ anio, mes: ORDEN_MESES[mesIdx], monto: it.costoEstimado, nombre: it.nombre });
  }
  return out;
}

function clearCache() { cache.del(CACHE_KEY); }

module.exports = {
  listPlan, guardarItem, deleteItem, guardarConfig, planGastosProgramados,
  clearCache, HOJA, HOJA_CONFIG,
};
