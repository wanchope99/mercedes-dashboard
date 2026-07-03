// ─── Consumo real de Bebidas vía snapshots diarios de stock de Fudo ────────────
// Fudo no expone historial de movimientos de stock (solo el nivel actual). Para
// conocer el consumo mensual real (inicio + comprado − fin) tomamos una foto
// diaria del stock de cada producto de Bebida y la persistimos en la hoja
// "Stock Bebidas". El disparo diario vive en src/cron.js.
//
// Mismo criterio de "Bebida" que usa el CMV existente (fudo.grupoDeCategoria),
// no el más amplio esAlcohol() de vinos.js — así el número es comparable con
// las tiles "Costo (Fudo)" / "Ingreso bebida" que ya existen en el Costos tab.

const NodeCache = require('node-cache');
const { google } = require('googleapis');
const fudo = require('./fudo');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const STOCK_SHEET = process.env.STOCK_BEBIDAS_SHEET || 'Stock Bebidas';
const TZ_OFFSET_H = parseFloat(process.env.FUDO_TZ_OFFSET || '-3');

const cache = new NodeCache({ stdTTL: 600 });

function hoyISO() {
  const shifted = new Date(Date.now() + TZ_OFFSET_H * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function getSheetsClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const persistenciaActiva = () => Boolean(SPREADSHEET_ID);

// Columnas: A Fecha (YYYY-MM-DD) · B Guardado El · C Cantidad Productos · D JSON
async function ensureSheet(sheetsApi) {
  try {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: STOCK_SHEET, hidden: false } } }] },
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${STOCK_SHEET}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Fecha', 'Guardado El', 'Cantidad Productos', 'JSON']] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

// Lee todos los snapshots guardados. Devuelve { 'YYYY-MM-DD': { rowIndex, productos } }
async function loadSnapshots() {
  if (!persistenciaActiva()) return {};
  const cached = cache.get('stock_bebidas_hist');
  if (cached) return cached;

  const sheetsApi = getSheetsClient();
  let rows = [];
  try {
    const res = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${STOCK_SHEET}!A:D`,
    });
    rows = res.data.values || [];
  } catch (e) {
    try { await ensureSheet(sheetsApi); } catch (e2) { console.warn('Stock Bebidas: no se pudo crear la hoja:', e2.message); }
    rows = [];
  }

  const hist = {};
  for (let i = 1; i < rows.length; i++) {  // i=0 es el header
    const row = rows[i];
    if (!row || !row[0] || !row[3]) continue;
    try { hist[row[0]] = { rowIndex: i + 1, productos: JSON.parse(row[3]) }; } catch { /* JSON corrupto: ignorar */ }
  }
  cache.set('stock_bebidas_hist', hist, 600);
  return hist;
}

function clearCache() { cache.del('stock_bebidas_hist'); }

// Fecha del snapshot más reciente guardado (para el catch-up del arranque).
async function ultimaFechaSnapshot() {
  const hist = await loadSnapshots();
  const fechas = Object.keys(hist).sort();
  return fechas.length ? fechas[fechas.length - 1] : null;
}

// Productos de Bebida actualmente trackeados (activos + stockControl) que no
// tienen NINGÚN snapshot dentro de un conjunto de ids dado — para avisar en la UI.
async function productosSinSnapshotEntre(idsConSnapshot) {
  try {
    const productos = await fudo.getProductosConStock();
    return productos
      .filter(p => p.active !== false && p.stockControl === true && fudo.grupoDeCategoria(p.categoria) === 'bebida')
      .filter(p => !idsConSnapshot.has(String(p.id)))
      .map(p => ({ id: p.id, name: p.name }));
  } catch { return []; }
}

// Toma la foto de HOY (idempotente: si ya existe un snapshot de hoy, no hace nada).
async function tomarSnapshot() {
  if (!persistenciaActiva()) { console.warn('Stock Bebidas: SPREADSHEET_ID no configurado, snapshot omitido'); return null; }

  const hoy = hoyISO();
  const existentes = await loadSnapshots();
  if (existentes[hoy]) return { fecha: hoy, productos: existentes[hoy].productos, yaExistia: true };

  const productos = await fudo.getProductosConStock();
  const bebidas = productos
    .filter(p => p.active !== false && p.stockControl === true && fudo.grupoDeCategoria(p.categoria) === 'bebida')
    .map(p => ({ id: p.id, name: p.name, categoria: p.categoria, stock: p.stock, cost: p.cost }));

  const sheetsApi = getSheetsClient();
  await ensureSheet(sheetsApi);
  const row = [hoy, new Date().toISOString(), bebidas.length, JSON.stringify(bebidas)];
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${STOCK_SHEET}!A:D`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
  clearCache();
  console.log(`Stock Bebidas: snapshot guardado ${hoy} (${bebidas.length} productos)`);
  return { fecha: hoy, productos: bebidas, yaExistia: false };
}

// Consumo mensual (o de cualquier rango) por producto:
//   consumo = stock_inicio - stock_fin + Σ(incrementos día a día = comprado)
// rangoReal informa el rango de fechas REALMENTE cubierto por snapshots (puede
// ser más angosto que { desde, hasta } pedido, p.ej. el primer mes parcial).
async function getConsumoMensualBebidas({ desde, hasta } = {}) {
  const hist = await loadSnapshots();
  const fechas = Object.keys(hist).sort();
  const enRango = fechas.filter(f => (!desde || f >= desde) && (!hasta || f <= hasta));

  if (!enRango.length) {
    return {
      total: 0,
      detalle: [],
      rangoReal: { desde: null, hasta: null },
      productosSinSnapshot: await productosSinSnapshotEntre(new Set()),
    };
  }

  // Serie temporal por producto (por id de Fudo)
  const porProducto = {};
  for (const f of enRango) {
    for (const p of hist[f].productos) {
      if (p.id == null) continue;
      (porProducto[p.id] = porProducto[p.id] || []).push({ fecha: f, ...p });
    }
  }

  const detalle = [];
  let total = 0;
  for (const [id, serieSinOrdenar] of Object.entries(porProducto)) {
    const serie = serieSinOrdenar.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
    const start = serie[0].stock ?? 0;
    const end = serie[serie.length - 1].stock ?? 0;
    let acquired = 0;
    for (let i = 1; i < serie.length; i++) {
      const delta = (serie[i].stock ?? 0) - (serie[i - 1].stock ?? 0);
      if (delta > 0) acquired += delta;
    }
    const consumoCrudo = start - end + acquired;
    const anomalia = consumoCrudo < 0;
    const consumo = Math.max(0, consumoCrudo);
    const cost = serie[serie.length - 1].cost || 0;
    const costoItem = Math.round(consumo * cost * 100) / 100;
    total += costoItem;
    detalle.push({
      id,
      name: serie[serie.length - 1].name,
      categoria: serie[serie.length - 1].categoria,
      start, end, acquired, consumo, cost, costoItem, anomalia,
      snapshots: serie.length,
    });
  }
  detalle.sort((a, b) => b.costoItem - a.costoItem);

  const idsConSnapshot = new Set(Object.keys(porProducto));
  const productosSinSnapshot = await productosSinSnapshotEntre(idsConSnapshot);

  return {
    total: Math.round(total),
    detalle,
    rangoReal: { desde: enRango[0], hasta: enRango[enRango.length - 1] },
    productosSinSnapshot,
  };
}

module.exports = {
  tomarSnapshot, getConsumoMensualBebidas, ultimaFechaSnapshot, hoyISO, clearCache,
};
