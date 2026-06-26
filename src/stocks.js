// ─── Comportamiento de Stocks: ingreso (compras) vs venta (FUDO) ────────────────
//
// Cruza las COMPRAS (planilla Comparacion Proveedores → hoja Compras) con las
// VENTAS (FUDO) para entender cuánto tarda un producto desde que ingresa hasta
// que se vende, y detectar riesgo de out-of-stock (foco: bebidas/vinos).
//
// MATCH compra↔venta:
//  · Directo (bebidas/vinos): el producto que se compra es el mismo que se vende
//    (una botella). El nombre matchea bien → métricas confiables.
//  · Indirecto (insumos de cocina): el producto entra en platos, no se vende tal
//    cual. El match es débil; lo marcamos como tal para no confundir.
//
// El match automático es por similitud de nombre (tokens compartidos). Se puede
// corregir manualmente vía overrides (en memoria; persistencia futura si hace falta).

const prov = require('./proveedores');
const cats = require('./proveedores-categorias');
const fudo = require('./fudo');
let costosMod = null; try { costosMod = require('./costos'); } catch(e){}

// Categorías que se venden "tal cual" en FUDO (match directo confiable).
const CATEGORIAS_DIRECTAS = new Set(['Bebidas y Alcohol']);

// Overrides manuales de match: { productoCanonNorm: Set(nombreFudoNorm, ...) }.
// Un insumo puede mapear a VARIOS productos/platos de FUDO (ej. Matambre entra en
// varios platos). Se persiste en la hoja "Stock Match" del Google Sheets.
const { google } = require('googleapis');
// Stock Match vive en la planilla de Comparación Proveedores (junto a Compras).
const SPREADSHEET_ID = process.env.PROVEEDORES_SHEET_ID || process.env.SPREADSHEET_ID;
const STOCK_MATCH_SHEET = process.env.STOCK_MATCH_SHEET || 'Stock Match';

const overridesMatch = new Map(); // norm(producto) -> { display, fudos: [{display, norm}] }
let _overridesCargados = false;

function _sheetsClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function _ensureSheet(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: STOCK_MATCH_SHEET } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${STOCK_MATCH_SHEET}!A1:B1`, valueInputOption: 'RAW',
      requestBody: { values: [['Insumo (stock)', 'Productos FUDO (separados por ;)']] },
    });
  } catch (e) { if (!String(e.message || '').toLowerCase().includes('already exists')) throw e; }
}

// Carga los overrides desde la hoja (idempotente; cachea tras el primer load).
async function cargarMatchOverrides() {
  if (!SPREADSHEET_ID) { _overridesCargados = true; return; }
  const api = _sheetsClient();
  let rows = [];
  try {
    const r = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${STOCK_MATCH_SHEET}!A:B` });
    rows = r.data.values || [];
  } catch (e) { await _ensureSheet(api); _overridesCargados = true; return; }
  overridesMatch.clear();
  for (let i = 1; i < rows.length; i++) {
    const prodDisplay = (rows[i][0] || '').toString().trim();
    if (!prodDisplay) continue;
    const fudosRaw = (rows[i][1] || '').toString();
    const fudos = fudosRaw.split(';').map(x => x.trim()).filter(Boolean)
      .map(d => ({ display: d, norm: cats.norm(d) }));
    overridesMatch.set(cats.norm(prodDisplay), { display: prodDisplay, fudos });
  }
  _overridesCargados = true;
}

// Setea (o borra si fudos vacío) el override de un insumo a varios productos FUDO.
async function setMatchOverride(productoCanon, nombresFudo) {
  // nombresFudo: array de strings (o un string, por compat con la API vieja).
  const lista = Array.isArray(nombresFudo) ? nombresFudo : (nombresFudo ? [nombresFudo] : []);
  const fudos = lista.map(d => String(d).trim()).filter(Boolean).map(d => ({ display: d, norm: cats.norm(d) }));
  const key = cats.norm(productoCanon);
  if (fudos.length) overridesMatch.set(key, { display: String(productoCanon).trim(), fudos });
  else overridesMatch.delete(key);

  // Persistir en Sheets (upsert por insumo).
  if (!SPREADSHEET_ID) return;
  const api = _sheetsClient();
  await _ensureSheet(api);
  let rows = [];
  try {
    const r = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${STOCK_MATCH_SHEET}!A:B` });
    rows = r.data.values || [];
  } catch (e) { rows = []; }
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && cats.norm(rows[i][0] || '') === key) { rowIndex = i + 1; break; }
  }
  const fila = [String(productoCanon).trim(), fudos.map(f => f.display).join('; ')];
  if (fudos.length === 0 && rowIndex > 0) {
    // Vaciar la celda de productos (mantener la fila para no romper indices).
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${STOCK_MATCH_SHEET}!A${rowIndex}:B${rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [[String(productoCanon).trim(), '']] },
    });
  } else if (rowIndex > 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${STOCK_MATCH_SHEET}!A${rowIndex}:B${rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  } else if (fudos.length) {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${STOCK_MATCH_SHEET}!A:B`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  }
}

function getMatchOverride(productoCanon) {
  const o = overridesMatch.get(cats.norm(productoCanon));
  return o ? o.fudos.map(f => f.display) : [];
}

// Lista de nombres de productos FUDO distintos en el periodo (para el selector de la UI).
async function listarProductosFudo({ desde, hasta } = {}) {
  let detalles = [];
  try { detalles = await fudo.getDetallesFrescos({ desde, hasta }); } catch (e) { detalles = []; }
  const set = new Map(); // norm -> display
  for (const dia of detalles) {
    for (const cat of (dia.categorias || [])) {
      for (const p of (cat.productos || [])) {
        const n = cats.norm(p.nombre);
        if (n && !set.has(n)) set.set(n, p.nombre);
      }
    }
  }
  return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
}

// ─── Similitud de nombres (tokens compartidos, tipo Jaccard) ────────────────────
const STOP = new Set(['de','la','el','los','las','del','con','sin','x','por','a','al','y','en','un','una','mar','plata','bordo','congelado','remito']);
function tokens(s) {
  return cats.norm(s).split(/[^a-z0-9]+/).filter(t => t && t.length > 1 && !STOP.has(t));
}
function similitud(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size); // qué fracción del más chico está en el otro
}

// ─── Productos disponibles (de las compras) ─────────────────────────────────────
async function getProductosStock() {
  const { productos, categorias } = await prov.getProductosYCategorias();
  return { productos, categorias };
}

// ─── Ventas FUDO de un producto a lo largo del tiempo ───────────────────────────
// Devuelve { ventas: [{fecha, unidades, nombre, sim}], matchNombre, matchSim, directo }.
async function ventasDeProducto(productoCanon, { desde, hasta } = {}) {
  let detalles = [];
  try { detalles = await fudo.getDetallesFrescos({ desde, hasta }); }
  catch (e) { detalles = []; }

  const overr = overridesMatch.get(cats.norm(productoCanon)); // { display, fudos: [{display, norm}] } | undefined
  const overrSet = overr ? new Set(overr.fudos.map(f => f.norm)) : null;
  const ventas = [];
  const nombresVistos = {}; // nombreFudoNorm -> { nombre, sim }
  const UMBRAL_SIM = 0.5;

  for (const dia of detalles) {
    for (const cat of (dia.categorias || [])) {
      for (const p of (cat.productos || [])) {
        const nf = cats.norm(p.nombre);
        let match = false, sim = 0;
        if (overrSet) {
          // Override manual: matchea si el producto FUDO está en la lista mapeada.
          match = overrSet.has(nf);
          sim = match ? 1 : 0;
        } else {
          sim = similitud(productoCanon, p.nombre);
          match = sim >= UMBRAL_SIM;
        }
        if (match) {
          ventas.push({ fecha: dia.fecha, unidades: p.unidades, nombre: p.nombre, sim: Math.round(sim * 100) / 100 });
          if (!nombresVistos[nf] || sim > nombresVistos[nf].sim) nombresVistos[nf] = { nombre: p.nombre, sim };
        }
      }
    }
  }

  // El "nombre FUDO" representativo es el de mayor similitud.
  let matchNombre = '', matchSim = 0;
  for (const v of Object.values(nombresVistos)) if (v.sim > matchSim) { matchSim = v.sim; matchNombre = v.nombre; }

  ventas.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  return { ventas, matchNombre, matchSim: Math.round(matchSim * 100) / 100 };
}

// ─── Análisis completo de un producto ───────────────────────────────────────────
async function getSerieStock({ producto, categoria, desde, hasta } = {}) {
  const canon = producto; // ya es el nombre visible del selector

  // Compras (ingresos) de ese producto canónico
  const todas = await prov.getCompras();
  const pn = cats.norm(canon);
  const compras = todas
    .filter(c => c.producto && cats.norm(prov.nombreVisible(c)) === pn)
    .filter(c => !categoria || cats.normalizarCategoria(c.categoria).categoria === categoria)
    .filter(c => (!desde || !c.fecha || c.fecha >= desde) && (!hasta || !c.fecha || c.fecha <= hasta))
    .map(c => ({
      fecha: c.fecha, cantidad: c.cantidad, precioUnit: c.precioUnit,
      proveedor: c.proveedor, unidad: c.unidad,
      // Trazabilidad: lo que decía la factura antes de normalizar a unidad base.
      cantidadOriginal: c.cantidadOriginal, unidadOriginal: c.unidadOriginal, factor: c.factor,
    }))
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  // Categoría del producto (para decidir match directo/indirecto)
  const catProd = compras.length ? (cats.normalizarCategoria(
    (todas.find(c => cats.norm(prov.nombreVisible(c)) === pn) || {}).categoria).categoria) : (categoria || '');
  const directo = CATEGORIAS_DIRECTAS.has(catProd);

  // Ventas FUDO
  const { ventas, matchNombre, matchSim } = await ventasDeProducto(canon, { desde, hasta });

  // Métricas
  const unidad = compras.find(c => c.unidad)?.unidad || '';
  const ultimaCompra = compras.length ? compras[compras.length - 1] : null;
  const ultimaVenta = ventas.length ? ventas[ventas.length - 1] : null;

  // Días promedio ingreso→venta: para cada compra, días hasta la PRIMERA venta posterior.
  const lapsos = [];
  for (const c of compras) {
    if (!c.fecha) continue;
    const primeraVentaPost = ventas.find(v => v.fecha && v.fecha >= c.fecha);
    if (primeraVentaPost) {
      const dias = Math.round((new Date(primeraVentaPost.fecha) - new Date(c.fecha)) / 86400000);
      if (dias >= 0) lapsos.push(dias);
    }
  }
  const diasPromedio = lapsos.length ? Math.round(lapsos.reduce((s, x) => s + x, 0) / lapsos.length) : null;

  // Riesgo de out-of-stock: heurística simple.
  //  · Si hay ventas pero la última compra es vieja respecto a la última venta → riesgo.
  //  · Si compraste hace poco → bajo.
  let riesgo = { nivel: 'Sin datos', detalle: '' };
  if (ultimaVenta && ultimaCompra) {
    const hoy = new Date();
    const diasDesdeCompra = Math.round((hoy - new Date(ultimaCompra.fecha)) / 86400000);
    const cadencia = diasPromedio || 14;
    if (diasDesdeCompra > cadencia * 1.5) {
      riesgo = { nivel: 'Alto', detalle: `Última compra hace ${diasDesdeCompra} días` };
    } else if (diasDesdeCompra > cadencia) {
      riesgo = { nivel: 'Medio', detalle: `Última compra hace ${diasDesdeCompra} días` };
    } else {
      riesgo = { nivel: 'Bajo', detalle: `Reabastecido hace ${diasDesdeCompra} días` };
    }
  } else if (ultimaCompra && !ultimaVenta) {
    riesgo = { nivel: 'Sin ventas', detalle: 'Comprado pero sin ventas registradas en FUDO' };
  }

  const matchInfo = directo
    ? (matchNombre ? `· venta FUDO: "${matchNombre}" (match directo)` : '· sin venta FUDO encontrada')
    : (matchNombre ? `· match indirecto con "${matchNombre}" — este insumo se vende dentro de platos, el dato es aproximado` : '· insumo de cocina: no se vende tal cual, sin match directo');

  // ── Totales en la UNIDAD BASE (ej: botellas) ──
  // Como las compras se guardan ya normalizadas (Caja→Botella), ingreso y venta
  // están en la misma unidad y son comparables directamente.
  const totalIngresado = compras.reduce((s, c) => s + (Number(c.cantidad) || 0), 0);
  const totalVendido   = ventas.reduce((s, v) => s + (Number(v.unidades) || 0), 0);
  // ¿Alguna compra entró por empaque (caja/pack) y fue normalizada?
  const huboEmpaque = compras.some(c => c.factor && c.factor > 1);
  const unidadBase = unidad || (directo ? 'Botella' : '');

  return {
    producto: canon, categoria: catProd, unidad, unidadBase, directo,
    compras, ventas,
    diasPromedio, ultimaCompra, ultimaVenta, riesgo,
    matchNombre, matchSim, matchInfo,
    // Resumen comparable ingreso vs venta (misma unidad base)
    totales: {
      ingresado: Math.round(totalIngresado * 100) / 100,
      vendido: Math.round(totalVendido * 100) / 100,
      balance: Math.round((totalIngresado - totalVendido) * 100) / 100,
      unidad: unidadBase,
      huboEmpaque,
    },
  };
}

// ─── Serie agregada de TODA una categoría (compras vs ventas Fudo) ──────────────
// Para la vista de Stocks cuando el usuario elige una categoría pero no un producto:
// suma ingresos (compras de esa categoría) y ventas (productos Fudo mapeados a ella).
async function getSerieCategoria({ categoria, desde, hasta } = {}) {
  if (!categoria) return { categoria: '', compras: [], ventas: [], totalIngreso: 0, totalVendido: 0 };

  // Compras de la categoría
  const todas = await prov.getCompras();
  const compras = todas
    .filter(c => cats.normalizarCategoria(c.categoria).categoria === categoria)
    .filter(c => (!desde || !c.fecha || c.fecha >= desde) && (!hasta || !c.fecha || c.fecha <= hasta))
    .map(c => ({ fecha: c.fecha, cantidad: c.cantidad, proveedor: c.proveedor, producto: c.producto, unidad: c.unidad }))
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  // Ventas Fudo: productos cuya categoría de costo mapeada == categoria elegida
  let detalles = [];
  try { detalles = await fudo.getDetallesFrescos({ desde, hasta }); } catch (e) { detalles = []; }
  const ventas = [];
  for (const dia of detalles) {
    for (const cat of (dia.categorias || [])) {
      for (const p of (cat.productos || [])) {
        const catCosto = costosMod ? costosMod.clasificarProducto(p.nombre, cat.categoria) : null;
        if (catCosto === categoria) {
          ventas.push({ fecha: dia.fecha, unidades: p.unidades, nombre: p.nombre, monto: p.monto });
        }
      }
    }
  }
  ventas.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  const totalIngreso = compras.reduce((s, c) => s + (Number(c.cantidad) || 0), 0);
  const totalVendido = ventas.reduce((s, v) => s + (Number(v.unidades) || 0), 0);
  return {
    categoria, compras, ventas,
    totalIngreso: Math.round(totalIngreso * 100) / 100,
    totalVendido: Math.round(totalVendido * 100) / 100,
    esCategoria: true,
  };
}

module.exports = { getProductosStock, getSerieStock, getSerieCategoria, setMatchOverride, getMatchOverride, cargarMatchOverrides, listarProductosFudo, similitud };
