// ─── Config por proveedor (medio de pago habitual + criterio de IVA) ────────────
//
// El medio de pago y el criterio "con/sin IVA" son atributos del PROVEEDOR, no de
// cada producto. Se guardan en la hoja "Proveedores" de la planilla Gestion
// Mercedes (SPREADSHEET_ID), que ya tiene: A Proveedor · B Plazo · C Medio de Pago
// · D Datos para pagar · E Comentarios. Le sumamos una columna para el IVA.
//
// IVA del proveedor: "con" (le pagamos con IVA / nos discrimina IVA) o "sin".
// Se usa para decidir qué precio compara el gráfico a lo largo del tiempo.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 120 });

// La hoja Proveedores vive en la planilla de GESTIÓN (no en la de comparación).
const GESTION_SHEET_ID = process.env.SPREADSHEET_ID;
const PROVEEDORES_HOJA = process.env.PROVEEDORES_HOJA_CONFIG || 'Proveedores';
// Columna donde guardamos el criterio de IVA (header "IVA"). Si no existe, se crea.
const IVA_HEADER = 'IVA';

function sheets() {
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
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Lee la hoja Proveedores → { nombreLower: { nombre, plazoDias, medioPago, iva, rowIndex } }
// iva: 'con' | 'sin' | null
async function leerConfig() {
  const cached = cache.get('prov_config');
  if (cached) return cached;
  if (!GESTION_SHEET_ID) return { byNombre: {}, ivaColLetter: null, headerRow: 1 };

  const api = sheets();
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z`,
    });
    rows = res.data.values || [];
  } catch (e) { return { byNombre: {}, ivaColLetter: null, headerRow: 1 }; }

  // Encontrar fila de encabezado (la que tiene "Proveedor" en A)
  let hIdx = rows.findIndex(r => norm(r && r[0]) === 'proveedor');
  if (hIdx === -1) hIdx = 0;
  const header = (rows[hIdx] || []).map(norm);
  const idxNombre = 0;
  const idxPlazo = header.findIndex(h => h.includes('plazo'));
  const idxMedio = header.findIndex(h => h.includes('medio') || h.includes('forma'));
  let idxIva = header.findIndex(h => h === 'iva' || h.includes('iva'));

  const ivaColLetter = idxIva >= 0 ? colLetter(idxIva) : null;

  const byNombre = {};
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[idxNombre]) continue;
    const nombre = r[idxNombre].toString().trim();
    if (!nombre) continue;
    const plazoRaw = idxPlazo >= 0 ? parseInt(String(r[idxPlazo] || '').replace(/[^0-9]/g, '')) : NaN;
    const ivaRaw = idxIva >= 0 ? norm(r[idxIva]) : '';
    let iva = null;
    if (ivaRaw.startsWith('con') || ivaRaw === 'si' || ivaRaw === 'sí' || ivaRaw.includes('c/iva')) iva = 'con';
    else if (ivaRaw.startsWith('sin') || ivaRaw === 'no' || ivaRaw.includes('s/iva')) iva = 'sin';
    byNombre[norm(nombre)] = {
      nombre,
      plazoDias: Number.isFinite(plazoRaw) ? plazoRaw : null,
      medioPago: idxMedio >= 0 ? (r[idxMedio] || '').toString().trim() : '',
      iva,
      rowIndex: i + 1,
    };
  }

  const out = { byNombre, ivaColLetter, idxIva, headerRow: hIdx + 1, headerLen: header.length };
  cache.set('prov_config', out);
  return out;
}

function colLetter(idx0) {
  // 0 → A, 1 → B, ...
  let n = idx0, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Devuelve la config de un proveedor (o null si no está cargado).
async function getProveedor(nombre) {
  const cfg = await leerConfig();
  return cfg.byNombre[norm(nombre)] || null;
}

// Setea el criterio de IVA de un proveedor ('con'|'sin'). Si el proveedor no
// existe como fila, lo agrega. Si no existe la columna IVA, la crea en el header.
async function setIvaProveedor(nombre, iva) {
  if (!GESTION_SHEET_ID) return;
  const api = sheets();
  let cfg = await leerConfig();

  // Asegurar columna IVA
  let ivaCol = cfg.ivaColLetter;
  if (!ivaCol) {
    const newIdx = cfg.headerLen || 5;
    ivaCol = colLetter(newIdx);
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${ivaCol}${cfg.headerRow}`,
      valueInputOption: 'RAW', requestBody: { values: [[IVA_HEADER]] },
    });
    cache.del('prov_config');
    cfg = await leerConfig();
    ivaCol = cfg.ivaColLetter || ivaCol;
  }

  const valor = iva === 'con' ? 'Con IVA' : 'Sin IVA';
  const existente = cfg.byNombre[norm(nombre)];
  if (existente) {
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${ivaCol}${existente.rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [[valor]] },
    });
  } else {
    // Agregar fila nueva con nombre + IVA (en su columna)
    const row = [];
    row[0] = nombre;
    const ivaIdx = ivaCol.charCodeAt(0) - 65;
    row[ivaIdx] = valor;
    while (row.length <= ivaIdx) if (row.length < ivaIdx) row.push('');
    await api.spreadsheets.values.append({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!A:Z`,
      valueInputOption: 'RAW', requestBody: { values: [row] },
    });
  }
  cache.del('prov_config');
}

function clearConfigCache() { cache.flushAll(); }

module.exports = { leerConfig, getProveedor, setIvaProveedor, clearConfigCache, norm };
