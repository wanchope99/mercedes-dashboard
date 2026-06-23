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
  let idxIva = header.findIndex(h => h === 'iva' || (h.includes('iva') && !h.includes('deducible') && !h.includes('incluido')));
  // Columnas fiscales nuevas (memoria por proveedor)
  const idxDeducible = header.findIndex(h => h.includes('deducible'));
  const idxDescIncl = header.findIndex(h => h.includes('descuento') && h.includes('incluido'));
  const idxIvaIncl  = header.findIndex(h => h.includes('iva') && h.includes('incluido'));

  const ivaColLetter = idxIva >= 0 ? colLetter(idxIva) : null;
  const boolSN = v => { const x = norm(v); if (!x) return null; return (x.startsWith('s')||x==='si'||x==='sí'||x==='true') ? true : (x.startsWith('n')||x==='false' ? false : null); };

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
      ivaDeducible: idxDeducible >= 0 ? boolSN(r[idxDeducible]) : null,
      descuentoIncluido: idxDescIncl >= 0 ? boolSN(r[idxDescIncl]) : null,
      ivaIncluido: idxIvaIncl >= 0 ? boolSN(r[idxIvaIncl]) : null,
      rowIndex: i + 1,
    };
  }

  const out = { byNombre, ivaColLetter, idxIva, idxDeducible, idxDescIncl, idxIvaIncl, headerRow: hIdx + 1, headerLen: header.length };
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

// Setea un atributo arbitrario de un proveedor por NOMBRE DE COLUMNA (header).
// Si la columna no existe, la crea al final del header. Si el proveedor no existe
// como fila, agrega una nueva. Devuelve sin romper si no hay GESTION_SHEET_ID.
async function setAtributoProveedor(nombre, headerNombre, valor) {
  if (!GESTION_SHEET_ID) return;
  const api = sheets();
  let cfg = await leerConfig();
  // Buscar la columna por header (case/acentos-insensible)
  const res0 = await api.spreadsheets.values.get({ spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z` });
  const rows0 = res0.data.values || [];
  let hIdx = rows0.findIndex(r => norm(r && r[0]) === 'proveedor'); if (hIdx === -1) hIdx = 0;
  const header = (rows0[hIdx] || []).map(norm);
  let colIdx = header.findIndex(h => h === norm(headerNombre));
  if (colIdx === -1) {
    colIdx = (rows0[hIdx] || []).length;  // primera columna libre del header
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${colLetter(colIdx)}${hIdx + 1}`,
      valueInputOption: 'RAW', requestBody: { values: [[headerNombre]] },
    });
  }
  const colL = colLetter(colIdx);
  const existente = cfg.byNombre[norm(nombre)];
  if (existente) {
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${colL}${existente.rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [[valor]] },
    });
  } else {
    const row = []; row[0] = nombre; row[colIdx] = valor;
    for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = '';
    await api.spreadsheets.values.append({
      spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z`,
      valueInputOption: 'RAW', requestBody: { values: [row] },
    });
  }
  cache.del('prov_config');
}

// Helpers fiscales: guardan S/N por proveedor.
const _sn = b => b ? 'S' : 'N';
async function setIvaDeducible(nombre, b)       { return setAtributoProveedor(nombre, 'IVA Deducible', _sn(b)); }
async function setDescuentoIncluido(nombre, b)  { return setAtributoProveedor(nombre, 'Descuento Incluido', _sn(b)); }
async function setIvaIncluido(nombre, b)        { return setAtributoProveedor(nombre, 'IVA Incluido', _sn(b)); }

// Guarda el MEDIO DE PAGO habitual de un proveedor para no volver a preguntarlo.
// Escribe en la columna de medio existente (header con "medio" o "forma"); si no
// existe, crea "Medio de Pago". Reutiliza setAtributoProveedor para crear/actualizar.
async function setMedioProveedor(nombre, medio) {
  if (!GESTION_SHEET_ID || !nombre || !medio) return;
  // Detectar el header real del medio para que leerConfig() lo lea despues.
  let headerMedio = 'Medio de Pago';
  try {
    const api = sheets();
    const res0 = await api.spreadsheets.values.get({ spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z` });
    const rows0 = res0.data.values || [];
    let hIdx = rows0.findIndex(r => norm(r && r[0]) === 'proveedor'); if (hIdx === -1) hIdx = 0;
    const headerRaw = rows0[hIdx] || [];
    const idx = headerRaw.findIndex(h => { const n = norm(h); return n.includes('medio') || n.includes('forma'); });
    if (idx >= 0) headerMedio = headerRaw[idx];  // usar el header existente tal cual
  } catch (e) { /* si falla la deteccion, usar el default */ }
  return setAtributoProveedor(nombre, headerMedio, medio);
}

function clearConfigCache() { cache.flushAll(); }

module.exports = { leerConfig, getProveedor, setIvaProveedor, setMedioProveedor, setAtributoProveedor, setIvaDeducible, setDescuentoIncluido, setIvaIncluido, clearConfigCache, norm };
