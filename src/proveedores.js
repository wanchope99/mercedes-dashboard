// ─── Módulo de Proveedores / Comparación de costos ──────────────────────────────
//
// Lee y escribe la hoja "Compras" de la planilla Comparacion Proveedores
// (PROVEEDORES_SHEET_ID), y produce las agregaciones para el tab "Proveedores":
//   · serie temporal de precio unitario por producto (una línea por proveedor)
//   · listado de productos y categorías
//   · índice de inferencia (para clasificar compras nuevas)
//
// También mantiene en memoria una cola de "pendientes de confirmación": facturas
// donde algún dato (categoría, medio de pago, producto, precio) no quedó claro y
// requiere que un humano confirme antes de escribirse en la planilla.

const { google } = require('googleapis');
const NodeCache = require('node-cache');
const cats = require('./proveedores-categorias');

const cache = new NodeCache({ stdTTL: 120 });

// La planilla de comparación de proveedores es DISTINTA a la de gestión (Movimientos).
// Si no se define PROVEEDORES_SHEET_ID, se cae al SPREADSHEET_ID principal (no ideal).
const PROV_SHEET_ID = process.env.PROVEEDORES_SHEET_ID || process.env.SPREADSHEET_ID;
const COMPRAS_SHEET = process.env.PROVEEDORES_COMPRAS_SHEET || 'Compras';

// Columnas de la hoja Compras (A:L):
// A Fecha · B Proveedor · C Categoría · D Producto · E Cantidad · F Unidad
// G Precio Unit. ($) · H Total ($) · I Forma de Pago · J Días de Crédito
// K Entrega OK? · L Notas
const COL = { fecha:0, proveedor:1, categoria:2, producto:3, cantidad:4, unidad:5,
  precioUnit:6, total:7, formaPago:8, diasCredito:9, entregaOk:10, notas:11 };

function getAuthRW() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function sheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthRW() });
}

// ─── Parse de montos y fechas ───────────────────────────────────────────────────
function parseNum(val) {
  if (val === null || val === undefined || val === '' || val === '-') return null;
  const str = String(val).trim().replace(/[$\s]/g, '');
  if (!str) return null;
  // Argentino: "1.234,56" o "1234.56" o "1234"
  const commaIdx = str.lastIndexOf(','), dotIdx = str.lastIndexOf('.');
  let cleaned;
  if (commaIdx !== -1 && dotIdx !== -1) {
    cleaned = commaIdx > dotIdx ? str.replace(/\./g, '').replace(',', '.') : str.replace(/,/g, '');
  } else if (commaIdx !== -1) {
    const dec = str.slice(commaIdx + 1);
    cleaned = dec.length === 3 ? str.replace(/,/g, '') : str.replace(',', '.');
  } else if (dotIdx !== -1) {
    const dec = str.slice(dotIdx + 1);
    cleaned = dec.length === 3 ? str.replace(/\./g, '') : str;
  } else cleaned = str;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Fecha → 'YYYY-MM-DD'. Acepta ya-ISO o dd/mm/yyyy.
function parseFechaISO(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parts = s.split('/');
  if (parts.length === 3) {
    let [d, m, y] = parts.map(x => parseInt(x, 10));
    if (y < 100) y += 2000;
    if (d > 31) { const t = d; d = y % 100; y = t; } // por si viene yyyy/mm/dd
    if (Number.isFinite(d) && Number.isFinite(m) && Number.isFinite(y)) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

// ─── Lectura de la hoja Compras ─────────────────────────────────────────────────
async function getComprasRaw() {
  const cached = cache.get('compras_raw');
  if (cached) return cached;
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PROV_SHEET_ID,
    range: `${COMPRAS_SHEET}!A:L`,
  });
  const rows = res.data.values || [];
  cache.set('compras_raw', rows);
  return rows;
}

// Encuentra el índice (0-based) de la fila de encabezado "Fecha | Proveedor | ..."
function findHeaderIdx(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const a = (r[0] || '').toString().trim().toLowerCase();
    const b = (r[1] || '').toString().trim().toLowerCase();
    if (a === 'fecha' && b === 'proveedor') return i;
  }
  return -1;
}

// Devuelve array de compras parseadas. Cada una incluye rowIndex (1-based en hoja).
async function getCompras() {
  const rows = await getComprasRaw();
  const h = findHeaderIdx(rows);
  if (h === -1) return [];
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const proveedor = (r[COL.proveedor] || '').toString().trim();
    const producto = (r[COL.producto] || '').toString().trim();
    // Saltar filas vacías de plantilla (sin proveedor ni producto)
    if (!proveedor && !producto) continue;
    const cantidad = parseNum(r[COL.cantidad]);
    const precioUnit = parseNum(r[COL.precioUnit]);
    let total = parseNum(r[COL.total]);
    if (total === null && cantidad !== null && precioUnit !== null) total = cantidad * precioUnit;
    out.push({
      rowIndex: i + 1,
      fecha: parseFechaISO(r[COL.fecha]),
      fechaRaw: (r[COL.fecha] || '').toString(),
      proveedor,
      categoria: (r[COL.categoria] || '').toString().trim(),
      producto,
      cantidad,
      unidad: (r[COL.unidad] || '').toString().trim(),
      precioUnit,
      total,
      formaPago: (r[COL.formaPago] || '').toString().trim(),
      diasCredito: parseNum(r[COL.diasCredito]),
      entregaOk: (r[COL.entregaOk] || '').toString().trim(),
      notas: (r[COL.notas] || '').toString().trim(),
    });
  }
  return out;
}

// ─── Índice de inferencia (memoria del sistema) ─────────────────────────────────
async function getIndiceInferencia() {
  const compras = await getCompras();
  // Solo filas con categoría ya canónica alimentan la inferencia.
  const historial = compras
    .map(c => ({ proveedor: c.proveedor, producto: c.producto,
      categoria: cats.normalizarCategoria(c.categoria).categoria }))
    .filter(c => cats.CATEGORIAS_SET.has(c.categoria));
  return cats.construirIndiceInferencia(historial);
}

// ─── Escritura: append de filas confirmadas ─────────────────────────────────────
// items: [{ fecha, proveedor, categoria, producto, cantidad, unidad,
//           precioUnit, formaPago, diasCredito, entregaOk, notas }]
// El Total se deja a la fórmula de la planilla (cantidad * precioUnit) escribiendo
// la fórmula, salvo que venga total explícito.
async function appendCompras(items) {
  if (!items || !items.length) return 0;
  const sheets = sheetsClient();
  const values = items.map(it => {
    const cant = it.cantidad ?? '';
    const pu = it.precioUnit ?? '';
    // Total como fórmula si tenemos ambos; si no, total explícito o vacío.
    let total = '';
    if (it.total != null && it.total !== '') total = it.total;
    else if (cant !== '' && pu !== '') total = `=E{ROW}*G{ROW}`; // placeholder, ver abajo
    return [
      it.fecha || new Date().toISOString().slice(0, 10),
      it.proveedor || '',
      it.categoria || '',
      it.producto || '',
      cant,
      it.unidad || '',
      pu,
      total,
      cats.normalizarMedioPago(it.formaPago) || it.formaPago || '',
      it.diasCredito ?? 0,
      it.entregaOk || 'Sí',
      it.notas || '',
    ];
  });

  // Resolver la fórmula =E*G con el número de fila real. Para eso necesitamos
  // saber dónde se van a insertar. append no nos lo dice de antemano de forma
  // fiable, así que en vez de fórmula escribimos el total ya calculado.
  for (const row of values) {
    if (row[COL.total] === '=E{ROW}*G{ROW}') {
      const cant = Number(row[COL.cantidad]); const pu = Number(row[COL.precioUnit]);
      row[COL.total] = Number.isFinite(cant) && Number.isFinite(pu) ? Math.round(cant * pu * 100) / 100 : '';
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: PROV_SHEET_ID,
    range: `${COMPRAS_SHEET}!A:L`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  cache.del('compras_raw');
  return values.length;
}

// ─── Normalización de filas históricas (categorías viejas → canónicas) ──────────
// dryRun=true solo reporta qué cambiaría. Devuelve { revisadas, aCambiar, cambios:[...] }
async function normalizarHistoricoCategorias({ dryRun = true } = {}) {
  const compras = await getCompras();
  const cambios = [];
  for (const c of compras) {
    if (!c.categoria) continue;
    const norm = cats.normalizarCategoria(c.categoria);
    if (norm.ok && norm.categoria !== c.categoria) {
      cambios.push({ rowIndex: c.rowIndex, de: c.categoria, a: norm.categoria, producto: c.producto });
    }
  }
  if (!dryRun && cambios.length) {
    const sheets = sheetsClient();
    const data = cambios.map(ch => ({
      range: `${COMPRAS_SHEET}!C${ch.rowIndex}`,
      values: [[ch.a]],
    }));
    // batchUpdate en lotes de 100 para no exceder límites
    for (let i = 0; i < data.length; i += 100) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: PROV_SHEET_ID,
        requestBody: { valueInputOption: 'USER_ENTERED', data: data.slice(i, i + 100) },
      });
    }
    cache.del('compras_raw');
  }
  return { revisadas: compras.length, aCambiar: cambios.length, cambios, aplicado: !dryRun };
}

// ─── Dashboard: lista de productos y categorías ─────────────────────────────────
async function getProductosYCategorias() {
  const compras = await getCompras();
  const productos = new Map(); // nombreNorm -> { nombre, categoria, proveedores:Set, compras }
  const categorias = new Set();
  for (const c of compras) {
    if (!c.producto) continue;
    const cat = cats.normalizarCategoria(c.categoria).categoria || c.categoria;
    if (cat) categorias.add(cat);
    const key = cats.norm(c.producto);
    if (!productos.has(key)) {
      productos.set(key, { nombre: c.producto, categoria: cat, proveedores: new Set(), compras: 0 });
    }
    const p = productos.get(key);
    p.compras++;
    if (c.proveedor) p.proveedores.add(c.proveedor);
    if (!p.categoria && cat) p.categoria = cat;
  }
  return {
    productos: [...productos.values()]
      .map(p => ({ nombre: p.nombre, categoria: p.categoria, proveedores: [...p.proveedores], compras: p.compras }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    categorias: [...categorias].sort(),
  };
}

// ─── Dashboard: serie temporal de precio unitario por producto ──────────────────
// Filtros: producto (nombre, requerido), categoria (opcional), desde/hasta (ISO).
// Devuelve { producto, unidad, series: [{ proveedor, puntos:[{fecha, precioUnit, cantidad, total}] }],
//            resumen: [{ proveedor, ultimoPrecio, precioPromedio, minPrecio, maxPrecio, compras }] }
async function getSerieProducto({ producto, categoria, desde, hasta } = {}) {
  const compras = await getCompras();
  const pn = cats.norm(producto);
  const filtradas = compras.filter(c => {
    if (!c.producto || cats.norm(c.producto) !== pn) return false;
    if (c.precioUnit == null) return false;
    if (categoria && cats.normalizarCategoria(c.categoria).categoria !== categoria) return false;
    if (desde && c.fecha && c.fecha < desde) return false;
    if (hasta && c.fecha && c.fecha > hasta) return false;
    return true;
  });

  const porProveedor = {};
  let unidad = '';
  for (const c of filtradas) {
    if (!unidad && c.unidad) unidad = c.unidad;
    const pv = c.proveedor || 'Sin proveedor';
    (porProveedor[pv] = porProveedor[pv] || []).push({
      fecha: c.fecha, precioUnit: c.precioUnit, cantidad: c.cantidad, total: c.total,
    });
  }

  const series = [], resumen = [];
  for (const [pv, puntos] of Object.entries(porProveedor)) {
    puntos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    series.push({ proveedor: pv, puntos });
    const precios = puntos.map(p => p.precioUnit).filter(x => x != null);
    const sum = precios.reduce((s, x) => s + x, 0);
    resumen.push({
      proveedor: pv,
      ultimoPrecio: puntos.length ? puntos[puntos.length - 1].precioUnit : null,
      precioPromedio: precios.length ? sum / precios.length : null,
      minPrecio: precios.length ? Math.min(...precios) : null,
      maxPrecio: precios.length ? Math.max(...precios) : null,
      compras: puntos.length,
    });
  }
  resumen.sort((a, b) => (a.ultimoPrecio ?? Infinity) - (b.ultimoPrecio ?? Infinity));
  return { producto, unidad, series, resumen };
}

// ─── Pendientes de confirmación (en memoria) ────────────────────────────────────
// Cada pendiente: { id, creado, origen, imagenInfo, items: [{...item, dudas, resuelto}] }
// origen: { tipo:'telegram', chatId, usuario } para poder responder por el bot.
const pendientes = new Map();
let _pendSeq = 1;

function crearPendiente({ origen = {}, imagenInfo = {}, items }) {
  const id = `p${Date.now()}_${_pendSeq++}`;
  const reg = {
    id, creado: new Date().toISOString(), origen, imagenInfo,
    items: items.map((it, i) => ({ idx: i, ...it })),
    estado: 'pendiente',
  };
  pendientes.set(id, reg);
  return reg;
}

function getPendiente(id) { return pendientes.get(id) || null; }
function listPendientes() {
  return [...pendientes.values()]
    .filter(p => p.estado === 'pendiente')
    .sort((a, b) => b.creado.localeCompare(a.creado));
}
function countPendientes() { return listPendientes().length; }

// Aplica las resoluciones del usuario a un pendiente. resoluciones es un objeto
// { [itemIdx]: { categoria?, medioPago?, producto?, precioUnit?, descartar? } }.
// Devuelve { listoParaEscribir: [items], faltan: [items con dudas restantes] }.
function aplicarResoluciones(id, resoluciones = {}) {
  const reg = pendientes.get(id);
  if (!reg) return null;
  for (const it of reg.items) {
    const r = resoluciones[it.idx];
    if (!r) continue;
    if (r.descartar) { it.descartado = true; continue; }
    if (r.categoria) it.categoria = r.categoria;
    if (r.medioPago) it.formaPago = r.medioPago;
    if (r.producto) it.producto = r.producto;
    if (r.precioUnit != null && r.precioUnit !== '') it.precioUnit = Number(r.precioUnit);
    // Re-evaluar dudas restantes tras la resolución
    it.dudas = (it.dudas || []).filter(d => {
      if (d.campo === 'categoria') return !it.categoria || !cats.CATEGORIAS_SET.has(it.categoria);
      if (d.campo === 'medioPago') return !it.formaPago || !cats.MEDIOS_PAGO.includes(cats.normalizarMedioPago(it.formaPago));
      if (d.campo === 'producto') return !it.producto || !it.producto.toString().trim();
      if (d.campo === 'precio_unitario') return !(Number(it.precioUnit) > 0);
      return false;
    });
  }
  const activos = reg.items.filter(it => !it.descartado);
  const listoParaEscribir = activos.filter(it => !it.dudas || it.dudas.length === 0);
  const faltan = activos.filter(it => it.dudas && it.dudas.length > 0);
  return { reg, listoParaEscribir, faltan };
}

function marcarResuelto(id) {
  const reg = pendientes.get(id);
  if (reg) reg.estado = 'resuelto';
}
function descartarPendiente(id) {
  const reg = pendientes.get(id);
  if (reg) reg.estado = 'descartado';
}

function clearProvCache() { cache.flushAll(); }

module.exports = {
  getCompras, getIndiceInferencia, appendCompras,
  normalizarHistoricoCategorias,
  getProductosYCategorias, getSerieProducto,
  crearPendiente, getPendiente, listPendientes, countPendientes,
  aplicarResoluciones, marcarResuelto, descartarPendiente,
  clearProvCache,
  // re-export para server.js
  cats,
};
