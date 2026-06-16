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
let provCfg = null; try { provCfg = require('./proveedores-config'); } catch (e) {}

const cache = new NodeCache({ stdTTL: 120 });

// La planilla de comparación de proveedores es DISTINTA a la de gestión (Movimientos).
// Si no se define PROVEEDORES_SHEET_ID, se cae al SPREADSHEET_ID principal (no ideal).
const PROV_SHEET_ID = process.env.PROVEEDORES_SHEET_ID || process.env.SPREADSHEET_ID;
const COMPRAS_SHEET = process.env.PROVEEDORES_COMPRAS_SHEET || 'Compras';

// Columnas de la hoja Compras (A:P):
// A Fecha · B Proveedor · C Categoría · D Producto · E Cantidad · F Unidad
// G Precio Unit. ($) · H Subtotal (=E*G) · I Descuento (%) · J Total ($) (=H*(1-I/100))
// K % IVA · L Total con IVA (=J*(1+K/100)) · M Forma de Pago · N Días de Crédito
// O Entrega OK? · P Notas
const COL = { fecha:0, proveedor:1, categoria:2, producto:3, cantidad:4, unidad:5,
  precioUnit:6, subtotal:7, descuento:8, total:9, ivaPct:10, totalConIva:11,
  formaPago:12, diasCredito:13, entregaOk:14, notas:15 };
const RANGE_COMPRAS = 'A:P';

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
    range: `${COMPRAS_SHEET}!A:P`,
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
    const descuento = parseNum(r[COL.descuento]);   // % de descuento
    let subtotal = parseNum(r[COL.subtotal]);
    if (subtotal === null && cantidad !== null && precioUnit !== null) subtotal = cantidad * precioUnit;
    let total = parseNum(r[COL.total]);
    if (total === null && subtotal !== null) {
      total = descuento ? subtotal * (1 - descuento / 100) : subtotal;
    }
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
      subtotal,
      descuento,
      total,
      ivaPct: parseNum(r[COL.ivaPct]),
      totalConIva: parseNum(r[COL.totalConIva]),
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

  // Averiguar la primera fila libre para poder escribir la fórmula =E*G con el
  // número de fila real (Sheets necesita la fila concreta en la fórmula).
  const existentes = await getComprasRaw();
  let nextRow = existentes.length + 1; // append va después de la última fila con datos

  const values = items.map((it) => {
    const fila = nextRow++;
    const cant = it.cantidad ?? '';
    const pu = it.precioUnit ?? '';
    // Descuento en % (0 si no hay).
    const descuento = (it.descuento != null && it.descuento !== '') ? it.descuento : '';
    // H Subtotal = E*G (cantidad * precio unitario).
    const subtotal = (cant !== '' && pu !== '') ? `=E${fila}*G${fila}` : '';
    // J Total ($) = Subtotal con descuento aplicado: =H*(1-I/100). Si Subtotal vacío, vacío.
    const total = subtotal ? `=H${fila}*(1-N(I${fila})/100)` : '';
    // K % IVA: lo que leyó el extractor (21, 10.5, 0) o vacío.
    const ivaPct = (it.ivaPct != null && it.ivaPct !== '') ? it.ivaPct : '';
    // L Total con IVA = Total * (1 + IVA%/100). Si no hay IVA, igual al Total.
    const totalConIva = total ? `=J${fila}*(1+N(K${fila})/100)` : '';
    return [
      it.fecha || new Date().toISOString().slice(0, 10),  // A Fecha
      it.proveedor || '',                                  // B Proveedor
      it.categoria || '',                                  // C Categoría
      it.producto || '',                                   // D Producto
      cant,                                                // E Cantidad
      it.unidad || '',                                     // F Unidad
      pu,                                                  // G Precio Unit.
      subtotal,                                            // H Subtotal (=E*G)
      descuento,                                           // I Descuento (%)
      total,                                               // J Total (=H*(1-I/100))
      ivaPct,                                              // K % IVA
      totalConIva,                                         // L Total con IVA (=J*(1+K/100))
      cats.normalizarMedioPago(it.formaPago) || it.formaPago || '', // M Forma de Pago
      it.diasCredito ?? 0,                                 // N Días de Crédito
      it.entregaOk || 'Sí',                                // O Entrega OK?
      it.notas || '',                                      // P Notas
    ];
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: PROV_SHEET_ID,
    range: `${COMPRAS_SHEET}!A:P`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  cache.del('compras_raw');
  return values.length;
}

// Control de consistencia: compara E*G calculado vs el total que leyó el extractor
// de la factura. Devuelve { ok, diff, pct } por item. Si difiere > 1%, ok=false.
function chequearTotalLinea(it) {
  const cant = Number(it.cantidad), pu = Number(it.precioUnit);
  const totalLeido = Number(it.total_linea ?? it.totalLinea);
  if (!Number.isFinite(cant) || !Number.isFinite(pu) || !Number.isFinite(totalLeido) || totalLeido === 0) {
    return { ok: true, diff: null, pct: null }; // sin datos para comparar: no flaggear
  }
  // Aplicar el descuento (si hay) antes de comparar: el total leído de la factura
  // ya viene con el descuento aplicado, mientras que E*G es el subtotal sin descuento.
  const desc = Number(it.descuento) || 0;
  const calc = cant * pu * (1 - desc / 100);
  const diff = calc - totalLeido;
  const pct = Math.abs(diff) / Math.abs(totalLeido);
  return { ok: pct <= 0.01, diff: Math.round(diff * 100) / 100, pct };
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
    // Agrupar productos equivalentes bajo su nombre canónico (sin sufijos de IVA/remito).
    const canon = cats.nombreCanonico(c.producto);
    const key = cats.norm(canon);
    if (!productos.has(key)) {
      productos.set(key, { nombre: canon, categoria: cat, proveedores: new Set(), compras: 0 });
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
  // El producto que llega del selector es el NOMBRE CANÓNICO; matcheamos contra
  // el canónico de cada compra para juntar variantes (+IVA, en Remito, etc.).
  const pn = cats.norm(cats.nombreCanonico(producto));

  // Config de IVA por proveedor: para "con IVA" comparamos el precio CON IVA;
  // para "sin IVA" o desconocido, el precio tal cual figura.
  let cfg = { byNombre: {} };
  if (provCfg) { try { cfg = await provCfg.leerConfig(); } catch (e) {} }
  const ivaDe = (proveedor) => {
    const c = cfg.byNombre && cfg.byNombre[cats.norm(proveedor)];
    return c && c.iva ? c.iva : null; // 'con' | 'sin' | null
  };
  // Precio de comparación de una compra según el criterio de su proveedor.
  const precioComparacion = (c) => {
    if (c.precioUnit == null) return null;
    const iva = ivaDe(c.proveedor);
    if (iva === 'con') {
      // Preferir el precio con IVA real (Total con IVA / cantidad); si no, aplicar %.
      if (c.totalConIva != null && c.cantidad) return c.totalConIva / c.cantidad;
      if (c.ivaPct != null) return c.precioUnit * (1 + c.ivaPct / 100);
    }
    return c.precioUnit;
  };

  const filtradas = compras.filter(c => {
    if (!c.producto || cats.norm(cats.nombreCanonico(c.producto)) !== pn) return false;
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
      fecha: c.fecha,
      precioUnit: precioComparacion(c),   // ajustado por IVA del proveedor
      precioFactura: c.precioUnit,        // el que figura tal cual (referencia)
      iva: ivaDe(pv),
      cantidad: c.cantidad, total: c.total,
    });
  }

  const series = [], resumen = [];
  for (const [pv, puntos] of Object.entries(porProveedor)) {
    puntos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    series.push({ proveedor: pv, iva: ivaDe(pv), puntos });
    const precios = puntos.map(p => p.precioUnit).filter(x => x != null);
    const sum = precios.reduce((s, x) => s + x, 0);
    resumen.push({
      proveedor: pv,
      iva: ivaDe(pv),
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
let _pendHidratado = false;

// ── Persistencia de pendientes en una hoja "Pendientes" de la planilla ──────────
// Columnas: A ID · B Estado · C Creado · D JSON. Sobreviven a los redeploys.
const PEND_SHEET = process.env.PROVEEDORES_PEND_SHEET || 'Pendientes';

async function _ensurePendSheet(sheets) {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: PROV_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: PEND_SHEET, hidden: true } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: PROV_SHEET_ID, range: `${PEND_SHEET}!A1:D1`, valueInputOption: 'RAW',
      requestBody: { values: [['ID', 'Estado', 'Creado', 'JSON']] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

// Guarda (upsert) un pendiente en la hoja. Best-effort: no rompe el flujo si falla.
async function _persistPendiente(reg) {
  if (!PROV_SHEET_ID) return;
  try {
    const sheets = sheetsClient();
    await _ensurePendSheet(sheets);
    // Buscar si ya existe la fila de este ID
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: PROV_SHEET_ID, range: `${PEND_SHEET}!A:A` });
    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) { if ((rows[i][0] || '') === reg.id) { rowIndex = i + 1; break; } }
    const fila = [reg.id, reg.estado, reg.creado, JSON.stringify(reg)];
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: PROV_SHEET_ID, range: `${PEND_SHEET}!A${rowIndex}:D${rowIndex}`,
        valueInputOption: 'RAW', requestBody: { values: [fila] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: PROV_SHEET_ID, range: `${PEND_SHEET}!A:D`,
        valueInputOption: 'RAW', requestBody: { values: [fila] },
      });
    }
  } catch (e) { console.warn('Pendientes: no se pudo persistir', reg.id, e.message); }
}

// Rehidrata el Map en memoria desde la hoja (una sola vez por arranque).
async function cargarPendientesPersistidos() {
  if (_pendHidratado || !PROV_SHEET_ID) return;
  _pendHidratado = true;
  try {
    const sheets = sheetsClient();
    let rows = [];
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: PROV_SHEET_ID, range: `${PEND_SHEET}!A:D` });
      rows = res.data.values || [];
    } catch (e) { await _ensurePendSheet(sheets); return; }
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0] || !r[3]) continue;
      if (pendientes.has(r[0])) continue; // ya en memoria
      try { pendientes.set(r[0], JSON.parse(r[3])); } catch (e) { /* json corrupto: ignorar */ }
    }
  } catch (e) { console.warn('Pendientes: no se pudo cargar de la hoja', e.message); }
}

function crearPendiente({ origen = {}, imagenInfo = {}, items, factura = {} }) {
  const id = `p${Date.now()}_${_pendSeq++}`;
  const reg = {
    id, creado: new Date().toISOString(), origen, imagenInfo,
    factura: {
      proveedor: factura.proveedor || (items[0] && items[0].proveedor) || '',
      medioPago: factura.medioPago || '',
      iva: factura.iva || null,
      dudas: factura.dudas || [],
    },
    items: items.map((it, i) => ({ idx: i, ...it })),
    estado: 'pendiente',
  };
  pendientes.set(id, reg);
  _persistPendiente(reg);   // best-effort, no bloquea
  return reg;
}

function getPendiente(id) { return pendientes.get(id) || null; }
function listPendientes() {
  return [...pendientes.values()]
    .filter(p => p.estado === 'pendiente')
    .sort((a, b) => b.creado.localeCompare(a.creado));
}
function countPendientes() { return listPendientes().length; }

function aplicarResoluciones(id, resoluciones = {}) {
  const reg = pendientes.get(id);
  if (!reg) return null;

  const rf = resoluciones.factura || resoluciones.__factura__;
  if (rf) {
    if (rf.medioPago) reg.factura.medioPago = rf.medioPago;
    if (rf.iva) reg.factura.iva = rf.iva;
    reg.factura.dudas = (reg.factura.dudas || []).filter(d => {
      if (d.campo === 'medioPago') return !reg.factura.medioPago || !cats.MEDIOS_PAGO.includes(cats.normalizarMedioPago(reg.factura.medioPago));
      if (d.campo === 'iva') return !reg.factura.iva;
      return false;
    });
  }
  if (reg.factura.medioPago) {
    for (const it of reg.items) it.formaPago = reg.factura.medioPago;
  }

  for (const it of reg.items) {
    const r = resoluciones[it.idx];
    if (!r) continue;
    if (r.descartar) { it.descartado = true; continue; }
    if (r.categoria) it.categoria = r.categoria;
    if (r.medioPago) it.formaPago = r.medioPago;
    if (r.producto) it.producto = r.producto;
    if (r.precioUnit != null && r.precioUnit !== '') it.precioUnit = Number(r.precioUnit);
    it.dudas = (it.dudas || []).filter(d => {
      if (d.campo === 'categoria') return !it.categoria || !cats.CATEGORIAS_SET.has(it.categoria);
      if (d.campo === 'producto') return !it.producto || !it.producto.toString().trim();
      if (d.campo === 'precio_unitario') return !(Number(it.precioUnit) > 0);
      return false;
    });
  }
  const facturaOk = !reg.factura.dudas || reg.factura.dudas.length === 0;
  const activos = reg.items.filter(it => !it.descartado);
  const itemsLimpios = activos.filter(it => !it.dudas || it.dudas.length === 0);
  const listoParaEscribir = facturaOk ? itemsLimpios : [];
  const faltan = activos.filter(it => (it.dudas && it.dudas.length > 0));
  _persistPendiente(reg);   // guardar el estado parcial
  return { reg, listoParaEscribir, faltan, facturaOk, facturaDudas: reg.factura.dudas || [] };
}

function marcarResuelto(id) {
  const reg = pendientes.get(id);
  if (reg) { reg.estado = 'resuelto'; _persistPendiente(reg); }
}
function descartarPendiente(id) {
  const reg = pendientes.get(id);
  if (reg) { reg.estado = 'descartado'; _persistPendiente(reg); }
}

function clearProvCache() { cache.flushAll(); }

module.exports = {
  getCompras, getIndiceInferencia, appendCompras,
  normalizarHistoricoCategorias,
  getProductosYCategorias, getSerieProducto,
  crearPendiente, getPendiente, listPendientes, countPendientes,
  aplicarResoluciones, marcarResuelto, descartarPendiente,
  cargarPendientesPersistidos,
  chequearTotalLinea,
  clearProvCache,
  // re-export para server.js
  cats,
};
