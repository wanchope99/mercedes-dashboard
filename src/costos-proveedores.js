// ─── Configuración de proveedores para Costos (Comida / Bebida) ─────────────────
//
// Los movimientos de Mercadería en Gestión Mercedes tienen un PROVEEDOR. Para saber
// si ese gasto es de Comida, Bebida o ambos, mantenemos una tabla de configuración
// persistida en la hoja "Costos Proveedores" de la planilla Gestión Mercedes.
//
// Hoja: SPREADSHEET_ID → "Costos Proveedores"
// Columnas: A Proveedor | B Comida% | C Bebida% | D Notas | E Actualizado
//
// Invariante: Comida% + Bebida% = 100 (o ambas 0 = sin configurar aún).
// Un proveedor con 100/0 es puro Comida; 0/100 puro Bebida; 60/40 split.
//
// Flujo en la UI:
//   1. Se pide el resumen de costos para un período.
//   2. El backend detecta proveedores con movimientos en ese período sin config.
//   3. Los devuelve en `sinConfigurar` junto con el resumen (con sus montos).
//   4. El usuario completa los % en la UI y los guarda con POST /api/costos/proveedores.
//   5. La próxima llamada ya los incluye en los totales.
//
// Cache: 5 min en memoria. Se invalida tras cada write.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 300 });
const CACHE_KEY = 'costos_proveedores';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.COSTOS_PROVEEDORES_HOJA || 'Costos Proveedores';

const HEADER = ['Proveedor', 'Comida%', 'Bebida%', 'Notas', 'Actualizado'];

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

function norm(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

async function _ensureHoja(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOJA } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

// Lee la hoja y devuelve un Map: norm(proveedor) → { proveedor, comidaPct, bebidaPct, notas, rowIndex }
async function _leerHoja(api) {
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A:E`,
    });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api);
    return new Map();
  }
  const mapa = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const proveedor = r[0].toString().trim();
    const comidaPct = Math.max(0, Math.min(100, parseFloat(r[1]) || 0));
    const bebidaPct = Math.max(0, Math.min(100, parseFloat(r[2]) || 0));
    mapa.set(norm(proveedor), {
      proveedor,
      comidaPct,
      bebidaPct,
      notas: (r[3] || '').toString().trim(),
      rowIndex: i + 1,
    });
  }
  return mapa;
}

// Devuelve la config completa: [{ proveedor, comidaPct, bebidaPct, notas }]
async function listarConfig() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return [...cached.values()];
  if (!SPREADSHEET_ID) return [];
  const api = _sheets();
  const mapa = await _leerHoja(api);
  cache.set(CACHE_KEY, mapa);
  return [...mapa.values()];
}

// Devuelve el Map interno (norm → config). Caching igual que listarConfig.
async function _getMap() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return new Map();
  const api = _sheets();
  const mapa = await _leerHoja(api);
  cache.set(CACHE_KEY, mapa);
  return mapa;
}

// Guarda (upsert) la configuración de un proveedor.
// comidaPct + bebidaPct deben sumar 100 (o 0/0 para "sin configurar aún").
async function guardarConfig(proveedor, comidaPct, bebidaPct, notas = '') {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  if (!proveedor) throw new Error('Falta proveedor');
  const cp = Math.max(0, Math.min(100, Math.round(Number(comidaPct) || 0)));
  const bp = Math.max(0, Math.min(100, Math.round(Number(bebidaPct) || 0)));

  const api = _sheets();
  await _ensureHoja(api);
  const mapa = await _leerHoja(api);

  const fila = [proveedor.trim(), cp, bp, notas || '', new Date().toISOString()];
  const existing = mapa.get(norm(proveedor));

  if (existing) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A${existing.rowIndex}:E${existing.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [fila] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A:E`,
      valueInputOption: 'RAW',
      requestBody: { values: [fila] },
    });
  }
  cache.del(CACHE_KEY);
}

// Guarda múltiples configuraciones en batch (para el formulario de la UI).
// items: [{ proveedor, comidaPct, bebidaPct, notas? }]
async function guardarConfigBatch(items) {
  for (const it of (items || [])) {
    await guardarConfig(it.proveedor, it.comidaPct, it.bebidaPct, it.notas || '');
  }
}

// Clasifica un movimiento dado su proveedor y monto.
// Devuelve { comida, bebida, sinConfig }
//   sinConfig = true → el proveedor no tiene configuración → el monto queda sin asignar.
async function clasificarMonto(proveedor, monto) {
  const mapa = await _getMap();
  const cfg = mapa.get(norm(proveedor));
  if (!cfg || (cfg.comidaPct === 0 && cfg.bebidaPct === 0)) {
    return { comida: 0, bebida: 0, sinConfig: true };
  }
  // Normalizar para que sumen 100 (tolerancia a errores de carga)
  const total = cfg.comidaPct + cfg.bebidaPct || 100;
  return {
    comida: Math.round((monto * cfg.comidaPct / total) * 100) / 100,
    bebida: Math.round((monto * cfg.bebidaPct / total) * 100) / 100,
    sinConfig: false,
  };
}

// Dado un array de movimientos (ya filtrados a Mercadería del período),
// devuelve:
// {
//   gastoComida,  gastoBeibda,
//   sinConfigurar: [{ proveedor, monto }],   ← proveedores sin config del período
//   configurados:  [{ proveedor, monto, comida, bebida }]
// }
async function clasificarMovimientos(movimientos) {
  const mapa = await _getMap();

  // Agrupar montos por proveedor primero
  const porProv = new Map(); // norm → { proveedor, monto }
  for (const m of (movimientos || [])) {
    const k = norm(m.proveedor || '(sin proveedor)');
    const label = m.proveedor || '(sin proveedor)';
    const entry = porProv.get(k) || { proveedor: label, monto: 0 };
    entry.monto += m.salidaTotal || 0;
    porProv.set(k, entry);
  }

  let gastoComida = 0, gastoBebida = 0;
  const sinConfigurar = [];
  const configurados = [];

  for (const [k, { proveedor, monto }] of porProv) {
    const cfg = mapa.get(k);
    if (!cfg || (cfg.comidaPct === 0 && cfg.bebidaPct === 0)) {
      sinConfigurar.push({ proveedor, monto: Math.round(monto) });
      continue;
    }
    const total = cfg.comidaPct + cfg.bebidaPct || 100;
    const comida = monto * cfg.comidaPct / total;
    const bebida = monto * cfg.bebidaPct / total;
    gastoComida += comida;
    gastoBebida += bebida;
    configurados.push({
      proveedor, monto: Math.round(monto),
      comidaPct: cfg.comidaPct, bebidaPct: cfg.bebidaPct,
      comida: Math.round(comida), bebida: Math.round(bebida),
    });
  }

  return {
    gastoComida: Math.round(gastoComida),
    gastoBebida: Math.round(gastoBebida),
    sinConfigurar: sinConfigurar.sort((a, b) => b.monto - a.monto),
    configurados: configurados.sort((a, b) => b.monto - a.monto),
  };
}

function clearCache() { cache.del(CACHE_KEY); }

module.exports = {
  listarConfig, guardarConfig, guardarConfigBatch,
  clasificarMonto, clasificarMovimientos,
  norm, clearCache, HOJA,
};
