// ─── Análisis de Costos vs Ingresos por categoría ───────────────────────────────
//
// OBJETIVO: cruzar dos mundos que NO matchean 1:1:
//   · COSTOS: vienen por INGREDIENTE (hoja Compras → Carnes, Pescados, Frutas…)
//   · INGRESOS: vienen por PRODUCTO vendido en FUDO (Ojo de Bife, Rabas, Vino…)
//
// La relación la resolvemos clasificando cada PRODUCTO de FUDO a la categoría de
// costo de su ingrediente DOMINANTE (decisión del usuario: "mejor por producto").
// Ej: "Ojo de Bife", "Marucha", "Cuadril" → Carnes y Embutidos. "Rabas",
// "Langostinos" → Pescados y Mariscos. Así se puede medir el ingreso que generan
// los platos de carne contra lo que se gastó en la categoría Carnes.
//
// La clasificación reutiliza las KEYWORDS de proveedores-categorias.js (misma
// fuente de verdad de categorías) + overrides manuales persistibles.
//
// Para el CMV desagregado del dashboard (Comida / Bebida / Insumos):
//   · El TOTAL del CMV sigue saliendo de Movimientos (dato fiel del P&L) — eso lo
//     calcula sheets.js. Acá calculamos la COMPOSICIÓN desde la hoja Compras:
//       - Bebida  = compras categoría "Bebidas y Alcohol" (vinos, cervezas, vermut,
//                   sin alcohol: agua/soda/gaseosa — todo lo de esa categoría).
//       - Insumos = compras categoría "Insumos" (papeles, químicos, pilas, hielo…).
//       - Comida  = el resto de categorías de ingrediente (carnes, pescados, etc.).

const cats = require('./proveedores-categorias');
const { google } = require('googleapis');

// ─── Persistencia de overrides de categoría en hoja Sheets ──────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const OVERRIDE_SHEET = process.env.COSTOS_OVERRIDE_SHEET || 'Producto Categorias';
function _sheetsClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}
async function _ensureOverrideSheet(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: OVERRIDE_SHEET } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${OVERRIDE_SHEET}!A1:B1`, valueInputOption: 'RAW',
      requestBody: { values: [['Producto', 'Categoria']] },
    });
  } catch (e) { if (!String(e.message||'').toLowerCase().includes('already exists')) throw e; }
}
let _overridesCargados = false;
// Carga los overrides desde la hoja al Map (una vez por arranque; refrescable).
async function cargarOverrides({ force = false } = {}) {
  if (_overridesCargados && !force) return;
  if (!SPREADSHEET_ID) { _overridesCargados = true; return; }
  try {
    const api = _sheetsClient();
    let rows = [];
    try {
      const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${OVERRIDE_SHEET}!A:B` });
      rows = res.data.values || [];
    } catch (e) { await _ensureOverrideSheet(api); rows = []; }
    overrides.clear();
    for (let i = 1; i < rows.length; i++) {
      const prod = (rows[i][0] || '').toString().trim();
      const cat = (rows[i][1] || '').toString().trim();
      if (prod && cat) overrides.set(cats.norm(prod), cat);
    }
    _overridesCargados = true;
  } catch (e) { console.warn('Overrides categoria: no se pudo cargar', e.message); _overridesCargados = true; }
}
// Persiste (upsert) un override en la hoja.
async function _persistOverride(nombreProducto, categoria) {
  if (!SPREADSHEET_ID) return;
  const api = _sheetsClient();
  await _ensureOverrideSheet(api);
  const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${OVERRIDE_SHEET}!A:B` });
  const rows = res.data.values || [];
  const nrm = cats.norm(nombreProducto);
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) { if (cats.norm(rows[i][0] || '') === nrm) { rowIndex = i + 1; break; } }
  const fila = [nombreProducto, categoria];
  if (rowIndex > 0) {
    await api.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${OVERRIDE_SHEET}!A${rowIndex}:B${rowIndex}`, valueInputOption: 'RAW', requestBody: { values: [fila] } });
  } else {
    await api.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${OVERRIDE_SHEET}!A:B`, valueInputOption: 'RAW', requestBody: { values: [fila] } });
  }
}

// ─── Composición % por plato (persistente en hoja Sheets) ───────────────────────
// Cada plato FUDO puede tener una composición de categorías de costo, ej:
//   Ojo de Bife → { 'Carnes y Embutidos': 90, 'Frutas y Verduras': 5, 'Otro': 5 }
// Si un plato NO tiene composición cargada, se asume 100% en su categoría dominante
// (clasificarProducto). Persistido en hoja 'Plato Composicion' (Plato | Categoria | Pct).
const COMPOSICION_SHEET = process.env.COSTOS_COMPOSICION_SHEET || 'Plato Composicion';
const composiciones = new Map(); // norm(plato) -> { nombre, partes: [{categoria, pct}] }
let _compCargadas = false;

async function _ensureCompSheet(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: COMPOSICION_SHEET } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: COMPOSICION_SHEET + '!A1:C1', valueInputOption: 'RAW',
      requestBody: { values: [['Plato', 'Categoria', 'Pct']] },
    });
  } catch (e) { if (!String(e.message||'').toLowerCase().includes('already exists')) throw e; }
}

async function cargarComposiciones({ force = false } = {}) {
  if (_compCargadas && !force) return;
  if (!SPREADSHEET_ID) { _compCargadas = true; return; }
  try {
    const api = _sheetsClient();
    let rows = [];
    try {
      const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: COMPOSICION_SHEET + '!A:C' });
      rows = res.data.values || [];
    } catch (e) { await _ensureCompSheet(api); rows = []; }
    composiciones.clear();
    for (let i = 1; i < rows.length; i++) {
      const plato = (rows[i][0] || '').toString().trim();
      const cat = (rows[i][1] || '').toString().trim();
      const pct = parseFloat(String(rows[i][2] || '').replace(/[^0-9.,-]/g, '').replace(',', '.'));
      if (!plato || !cat || !Number.isFinite(pct)) continue;
      const key = cats.norm(plato);
      const e = composiciones.get(key) || { nombre: plato, partes: [] };
      e.partes.push({ categoria: cat, pct });
      composiciones.set(key, e);
    }
    _compCargadas = true;
  } catch (e) { console.warn('Composiciones: no se pudo cargar', e.message); _compCargadas = true; }
}

// Devuelve el reparto de categorías para un plato: [{categoria, pct(0..1)}].
// Si tiene composición cargada (y suma > 0) usa esa; si no, 100% a la dominante.
function repartoCategorias(nombrePlato, categoriaFudo) {
  const comp = composiciones.get(cats.norm(nombrePlato));
  if (comp && comp.partes && comp.partes.length) {
    const suma = comp.partes.reduce((a, p) => a + (Number(p.pct) || 0), 0);
    if (suma > 0) return comp.partes.map(p => ({ categoria: p.categoria, pct: (Number(p.pct) || 0) / suma }));
  }
  const dom = clasificarProducto(nombrePlato, categoriaFudo);
  return dom ? [{ categoria: dom, pct: 1 }] : [];
}

function getComposicion(nombrePlato) {
  const c = composiciones.get(cats.norm(nombrePlato));
  return c ? c.partes.map(p => ({ categoria: p.categoria, pct: p.pct })) : null;
}
function listComposiciones() {
  return [...composiciones.values()].map(c => ({ plato: c.nombre, partes: c.partes }));
}

// Guarda (reemplaza) la composición de un plato. partes: [{categoria, pct}].
async function setComposicion(nombrePlato, partes) {
  if (!nombrePlato || !Array.isArray(partes)) return;
  const limpias = partes
    .filter(p => p && p.categoria && Number(p.pct) > 0)
    .map(p => ({ categoria: p.categoria, pct: Number(p.pct) }));
  composiciones.set(cats.norm(nombrePlato), { nombre: nombrePlato, partes: limpias });
  if (!SPREADSHEET_ID) return;
  try {
    const api = _sheetsClient();
    await _ensureCompSheet(api);
    // Releer y reescribir todas las filas de este plato (borrar viejas, poner nuevas).
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: COMPOSICION_SHEET + '!A:C' });
    const rows = res.data.values || [];
    const nrm = cats.norm(nombrePlato);
    const conservar = rows.filter((r, i) => i === 0 || cats.norm(r[0] || '') !== nrm); // header + otros platos
    const nuevas = limpias.map(p => [nombrePlato, p.categoria, p.pct]);
    const final = conservar.concat(nuevas);
    // Limpiar la hoja y reescribir (la tabla es chica)
    await api.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: COMPOSICION_SHEET + '!A:C' });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: COMPOSICION_SHEET + '!A1', valueInputOption: 'RAW',
      requestBody: { values: final.length ? final : [['Plato', 'Categoria', 'Pct']] },
    });
  } catch (e) { console.warn('Composiciones: no se pudo persistir', nombrePlato, e.message); }
}

// ─── Categorías de COSTO canónicas (mismas que Compras) ─────────────────────────
const CATEGORIAS_COSTO = cats.CATEGORIAS; // incluye Insumos / Otro

// Agrupación Comida / Bebida / Insumos para el CMV del dashboard.
function grupoCMV(categoriaCosto) {
  const c = (categoriaCosto || '').trim();
  if (c === 'Bebidas y Alcohol') return 'Bebida';
  if (c === 'Insumos') return 'Insumos';
  if (c === 'Otro') return 'Otros';
  return 'Comida'; // el resto de ingredientes
}

// ─── Clasificación producto FUDO → categoría de costo ───────────────────────────
// Overrides manuales (en memoria; se pueden persistir luego en una hoja).
const overrides = new Map(); // norm(nombreProducto) -> categoriaCosto
async function setOverrideProducto(nombreProducto, categoriaCosto) {
  if (!nombreProducto || !categoriaCosto) return;
  overrides.set(cats.norm(nombreProducto), categoriaCosto);
  try { await _persistOverride(nombreProducto, categoriaCosto); }
  catch (e) { console.warn('No se pudo persistir override', nombreProducto, e.message); }
}
function getOverrides() {
  return [...overrides.entries()].map(([k, v]) => ({ producto: k, categoria: v }));
}

// Pistas extra propias del menú del bar que las keywords genéricas no cubren bien.
// (Se suman a las KEYWORDS de proveedores-categorias.js)
// REGLAS ORDENADAS: se evalúan de arriba hacia abajo; la PRIMERA que matchea gana.
// Por eso las más específicas van primero (ej: "panchito tartar" antes que "tartar").
// El texto se normaliza (sin tildes, minúsculas) antes de comparar (substring).
const REGLAS_MENU = [
  // — Casos específicos primero (ganan a las reglas generales) —
  ['panchito tartar', 'Carnes y Embutidos'],     // Panchito de Tartar → Carnes
  ['panchito', 'Carnes y Embutidos'],
  ['empanada tucumana', 'Carnes y Embutidos'],   // empanada de carne
  ['empanada de carne', 'Carnes y Embutidos'],
  ['empanada de queso', 'Lacteos y Huevos'],
  ['empanada', 'Carnes y Embutidos'],            // resto de empanadas → carne (ajustable)
  ['tortilla', 'Lacteos y Huevos'],              // tortilla de papa / al corte → Lácteos
  ['tortillita', 'Lacteos y Huevos'],
  ['crudo de pez', 'Pescados y Mariscos'],
  ['crudo pez', 'Pescados y Mariscos'],

  // — Pescados y Mariscos (TartaR es pescado salvo panchito, ya filtrado arriba) —
  ['tartar', 'Pescados y Mariscos'],
  ['rabas', 'Pescados y Mariscos'], ['raba', 'Pescados y Mariscos'],
  ['langostino', 'Pescados y Mariscos'], ['calamar', 'Pescados y Mariscos'],
  ['pulpo', 'Pescados y Mariscos'], ['salmon', 'Pescados y Mariscos'],
  ['corvina', 'Pescados y Mariscos'], ['merluza', 'Pescados y Mariscos'],
  ['trucha', 'Pescados y Mariscos'], ['mejillon', 'Pescados y Mariscos'],
  ['besugo', 'Pescados y Mariscos'], ['anchoa', 'Pescados y Mariscos'],
  ['chernia', 'Pescados y Mariscos'], ['pez limon', 'Pescados y Mariscos'],
  ['ceviche', 'Pescados y Mariscos'], ['pesca', 'Pescados y Mariscos'],
  ['humita', 'Pescados y Mariscos'],  // (ajustá si humita no es pescado en tu carta)

  // — Bebidas y Alcohol (vinos por nombre + genéricos) —
  ['vino', 'Bebidas y Alcohol'], ['malbec', 'Bebidas y Alcohol'], ['cabernet', 'Bebidas y Alcohol'],
  ['sauvignon', 'Bebidas y Alcohol'], ['pinot', 'Bebidas y Alcohol'], ['chardonnay', 'Bebidas y Alcohol'],
  ['blend', 'Bebidas y Alcohol'], ['anfora', 'Bebidas y Alcohol'], ['ripasso', 'Bebidas y Alcohol'],
  ['beaujolais', 'Bebidas y Alcohol'], ['franc', 'Bebidas y Alcohol'], ['blanco de', 'Bebidas y Alcohol'],
  ['blanc de', 'Bebidas y Alcohol'], ['espumante', 'Bebidas y Alcohol'], ['champagne', 'Bebidas y Alcohol'],
  ['cerveza', 'Bebidas y Alcohol'], ['birra', 'Bebidas y Alcohol'], ['ipa', 'Bebidas y Alcohol'],
  ['lager', 'Bebidas y Alcohol'], ['imperial', 'Bebidas y Alcohol'], ['heineken', 'Bebidas y Alcohol'],
  ['porron', 'Bebidas y Alcohol'], ['vermu', 'Bebidas y Alcohol'], ['vermut', 'Bebidas y Alcohol'],
  ['vesta', 'Bebidas y Alcohol'], ['aperitivo', 'Bebidas y Alcohol'], ['fernet', 'Bebidas y Alcohol'],
  ['gin', 'Bebidas y Alcohol'], ['whisky', 'Bebidas y Alcohol'], ['negroni', 'Bebidas y Alcohol'],
  ['spritz', 'Bebidas y Alcohol'], ['campari', 'Bebidas y Alcohol'], ['copa ', 'Bebidas y Alcohol'],
  ['agua', 'Bebidas y Alcohol'], ['soda', 'Bebidas y Alcohol'], ['sifon', 'Bebidas y Alcohol'],
  ['gaseosa', 'Bebidas y Alcohol'], ['coca', 'Bebidas y Alcohol'], ['sprite', 'Bebidas y Alcohol'],
  ['tonica', 'Bebidas y Alcohol'], ['jugo', 'Bebidas y Alcohol'], ['limonada', 'Bebidas y Alcohol'],
  ['cafe', 'Bebidas y Alcohol'], ['trago', 'Bebidas y Alcohol'],

  // — Carnes —
  ['ojo de bife', 'Carnes y Embutidos'], ['bife', 'Carnes y Embutidos'], ['marucha', 'Carnes y Embutidos'],
  ['cuadril', 'Carnes y Embutidos'], ['entraña', 'Carnes y Embutidos'], ['entrana', 'Carnes y Embutidos'],
  ['vacio', 'Carnes y Embutidos'], ['asado', 'Carnes y Embutidos'], ['molleja', 'Carnes y Embutidos'],
  ['chorizo', 'Carnes y Embutidos'], ['morcilla', 'Carnes y Embutidos'], ['bondiola', 'Carnes y Embutidos'],
  ['matambre', 'Carnes y Embutidos'], ['pollo', 'Carnes y Embutidos'], ['milanesa', 'Carnes y Embutidos'],
  ['hamburguesa', 'Carnes y Embutidos'], ['lomo', 'Carnes y Embutidos'], ['cordero', 'Carnes y Embutidos'],
  ['lechon', 'Carnes y Embutidos'], ['pastrami', 'Carnes y Embutidos'],

  // — Lácteos y Huevos —
  ['provoleta', 'Lacteos y Huevos'], ['queso', 'Lacteos y Huevos'], ['huevo', 'Lacteos y Huevos'],
  ['revuelto', 'Lacteos y Huevos'], ['burrata', 'Lacteos y Huevos'], ['mozzarella', 'Lacteos y Huevos'],
  ['muzzarella', 'Lacteos y Huevos'], ['flan', 'Lacteos y Huevos'],

  // — Frutas y Verduras —
  ['ensalada', 'Frutas y Verduras'], ['papas', 'Frutas y Verduras'], ['papa', 'Frutas y Verduras'],
  ['fritas', 'Frutas y Verduras'], ['rucula', 'Frutas y Verduras'], ['repollito', 'Frutas y Verduras'],
  ['palta', 'Frutas y Verduras'], ['champignon', 'Frutas y Verduras'], ['hongos', 'Frutas y Verduras'],
  ['berenjena', 'Frutas y Verduras'], ['zucchini', 'Frutas y Verduras'], ['calabaza', 'Frutas y Verduras'],

  // — Panificados (al final: pan suelto, focaccia, etc.) —
  ['focaccia', 'Panificados y Masas'], ['bruschetta', 'Panificados y Masas'], ['pizza', 'Panificados y Masas'],
  ['prepizza', 'Panificados y Masas'], ['tostada', 'Panificados y Masas'], ['servicio de pan', 'Panificados y Masas'],
  ['extra pan', 'Panificados y Masas'], ['pan', 'Panificados y Masas'],
];

function clasificarProducto(nombreProducto, categoriaFudo) {
  const n = cats.norm(nombreProducto);
  if (!n) return null;
  if (overrides.has(n)) return overrides.get(n);

  // 1) Si FUDO ya la marca como bebida/vino/cerveza, es Bebidas y Alcohol (señal fuerte).
  const cf = cats.norm(categoriaFudo);
  if (cf.includes('vino') || cf.includes('cerveza') || cf.includes('bebida') ||
      cf.includes('alcohol') || cf.includes('sin alcohol') || cf.includes('espumos')) {
    return 'Bebidas y Alcohol';
  }

  // 2) Reglas del menú EN ORDEN: la primera que matchea gana (específicas primero).
  for (const [kw, cat] of REGLAS_MENU) {
    if (n.includes(cats.norm(kw))) return cat;
  }

  // 3) Keywords genéricas de proveedores-categorias (respaldo)
  const porKw = cats.inferirPorKeywords(nombreProducto);
  if (porKw) return porKw;

  // 4) Postres de FUDO → Lácteos (suelen ser flanes, helados, etc.)
  if (cf.includes('postre')) return 'Lacteos y Huevos';
  return null; // sin clasificar → se reporta aparte como "Sin asignar"
}

// ─── Ingresos FUDO agregados por categoría de costo ─────────────────────────────
// detalles: array de detalles diarios de FUDO (cada uno con .categorias[].productos[])
// Devuelve { porCategoriaCosto: { cat: { ingreso, unidades, productos:{nombre:{...}} } },
//            sinAsignar: { ingreso, unidades, productos } }
function ingresosPorCategoriaCosto(detalles) {
  const acc = {};
  const sinAsignar = { ingreso: 0, unidades: 0, productos: {} };

  for (const dia of (detalles || [])) {
    for (const cat of (dia.categorias || [])) {
      for (const p of (cat.productos || [])) {
        const reparto = repartoCategorias(p.nombre, cat.categoria); // [{categoria, pct}]
        const pn = p.nombre || 'Producto';
        if (!reparto.length) {
          sinAsignar.ingreso += p.monto || 0;
          sinAsignar.unidades += p.unidades || 0;
          const pp = sinAsignar.productos[pn] = sinAsignar.productos[pn] || { nombre: pn, ingreso: 0, unidades: 0, categoriaFudo: cat.categoria, precios: {} };
          pp.ingreso += p.monto || 0; pp.unidades += p.unidades || 0;
          for (const [precio, u] of Object.entries(p.precios || {})) pp.precios[precio] = (pp.precios[precio] || 0) + u;
          continue;
        }
        // Repartir el INGRESO (y unidades, proporcional) entre las categorías del plato.
        for (const part of reparto) {
          const bucket = acc[part.categoria] = acc[part.categoria] || { ingreso: 0, unidades: 0, productos: {} };
          bucket.ingreso += (p.monto || 0) * part.pct;
          bucket.unidades += (p.unidades || 0) * part.pct;
          const pp = bucket.productos[pn] = bucket.productos[pn] || { nombre: pn, ingreso: 0, unidades: 0, categoriaFudo: cat.categoria, precios: {}, pctEnCategoria: part.pct };
          pp.ingreso += (p.monto || 0) * part.pct;
          pp.unidades += (p.unidades || 0) * part.pct;
          for (const [precio, u] of Object.entries(p.precios || {})) pp.precios[precio] = (pp.precios[precio] || 0) + u * part.pct;
        }
      }
    }
  }
  // aplanar productos a arrays ordenados
  const flat = (b) => ({
    ingreso: Math.round(b.ingreso),
    unidades: b.unidades,
    productos: Object.values(b.productos)
      .map(p => ({
        ...p,
        // desglose de precios ordenado por precio desc: [{ precio, unidades, subtotal }]
        desglosePrecios: Object.entries(p.precios || {})
          .map(([precio, u]) => ({ precio: Number(precio), unidades: u, subtotal: Math.round(Number(precio) * u) }))
          .sort((a, c) => c.precio - a.precio),
        precioPromedio: p.unidades > 0 ? Math.round((p.ingreso / p.unidades) * 100) / 100 : 0,
      }))
      .sort((a, c) => c.ingreso - a.ingreso),
  });
  const porCategoriaCosto = {};
  for (const [k, v] of Object.entries(acc)) porCategoriaCosto[k] = flat(v);
  return { porCategoriaCosto, sinAsignar: flat(sinAsignar) };
}

// ─── Costos por categoría desde la hoja Compras ──────────────────────────────────
// compras: array de prov.getCompras() (cada una con .categoria normalizable, .total/.totalConIva)
// Usa el total con IVA si existe; si no, el total; si no, subtotal.
function montoCompra(c) {
  if (c.totalConIva != null && Number.isFinite(c.totalConIva)) return c.totalConIva;
  if (c.total != null && Number.isFinite(c.total)) return c.total;
  if (c.subtotal != null && Number.isFinite(c.subtotal)) return c.subtotal;
  if (c.cantidad != null && c.precioUnit != null) return c.cantidad * c.precioUnit;
  return 0;
}

function costosPorCategoria(compras, { desde, hasta } = {}) {
  const acc = {};
  for (const c of (compras || [])) {
    if (desde && c.fecha && c.fecha < desde) continue;
    if (hasta && c.fecha && c.fecha > hasta) continue;
    const norm = cats.normalizarCategoria(c.categoria);
    const cat = norm.categoria || c.categoria || 'Otro';
    const b = acc[cat] = acc[cat] || { categoria: cat, costo: 0, compras: 0, proveedores: new Set() };
    b.costo += montoCompra(c);
    b.compras++;
    if (c.proveedor) b.proveedores.add(c.proveedor);
  }
  return Object.values(acc)
    .map(b => ({ categoria: b.categoria, costo: Math.round(b.costo), compras: b.compras, proveedores: [...b.proveedores] }))
    .sort((a, b) => b.costo - a.costo);
}

// ─── CMV desagregado Comida / Bebida / Insumos (composición desde Compras) ──────
// Devuelve { Comida, Bebida, Insumos, Otros, total } en $ y la lista de categorías
// que componen cada grupo.
function cmvDesglose(compras, { desde, hasta } = {}) {
  const porCat = costosPorCategoria(compras, { desde, hasta });
  const grupos = { Comida: 0, Bebida: 0, Insumos: 0, Otros: 0 };
  const detalle = { Comida: [], Bebida: [], Insumos: [], Otros: [] };
  for (const c of porCat) {
    const g = grupoCMV(c.categoria);
    grupos[g] += c.costo;
    detalle[g].push(c);
  }
  const total = grupos.Comida + grupos.Bebida + grupos.Insumos + grupos.Otros;
  return { grupos, detalle, total };
}

// ─── Vista combinada Costos: costo vs ingreso por categoría ──────────────────────
// Junta costo (Compras) e ingreso (FUDO mapeado) por categoría de costo.
function costosVsIngresos({ compras, detallesFudo, desde, hasta } = {}) {
  const costos = costosPorCategoria(compras, { desde, hasta });
  const { porCategoriaCosto, sinAsignar } = ingresosPorCategoriaCosto(detallesFudo);

  const catSet = new Set([...costos.map(c => c.categoria), ...Object.keys(porCategoriaCosto)]);
  const filas = [];
  for (const cat of catSet) {
    const costo = (costos.find(c => c.categoria === cat) || {}).costo || 0;
    const ing = porCategoriaCosto[cat] || { ingreso: 0, unidades: 0, productos: [] };
    filas.push({
      categoria: cat,
      grupoCMV: grupoCMV(cat),
      costo,
      ingreso: ing.ingreso,
      unidades: ing.unidades,
      // ratio costo/ingreso (food cost teórico de la categoría)
      ratioCostoIngreso: ing.ingreso > 0 ? Math.round((costo / ing.ingreso) * 1000) / 10 : null,
      margen: ing.ingreso - costo,
      topProductos: (ing.productos || []).slice(0, 30),
      proveedores: (costos.find(c => c.categoria === cat) || {}).proveedores || [],
    });
  }
  filas.sort((a, b) => b.ingreso - a.ingreso || b.costo - a.costo);
  const totalCosto = filas.reduce((s, f) => s + f.costo, 0);
  const totalIngreso = filas.reduce((s, f) => s + f.ingreso, 0);
  return {
    filas,
    sinAsignar,
    totales: {
      costo: totalCosto,
      ingreso: totalIngreso + (sinAsignar.ingreso || 0),
      ingresoAsignado: totalIngreso,
      ingresoSinAsignar: sinAsignar.ingreso || 0,
    },
  };
}

// ─── Detalle por PLATO (vista inversa: categoría FUDO → platos) ─────────────────
// Agrupa por categoría de venta de FUDO (PARA PICAR, PARA COMER, Postres, etc.) y
// dentro lista cada plato con su ingreso, unidades, composición % y costo estimado.
// Costo estimado del plato = suma sobre sus categorías de (ingreso × pct × foodCost(cat)),
// donde foodCost(cat) = costoCompras(cat) / ingresoCategoria(cat).
function detallePorPlato({ detallesFudo, foodCostPorCategoria } = {}) {
  const fc = foodCostPorCategoria || {}; // { categoria: ratio 0..1 }
  const cats_ = {}; // categoriaFudo -> { categoria, grupo, ingreso, unidades, costoEstimado, platos:{} }
  for (const dia of (detallesFudo || [])) {
    for (const cat of (dia.categorias || [])) {
      const cf = cat.categoria || 'Sin categoría';
      const c = cats_[cf] = cats_[cf] || { categoria: cf, grupo: cat.grupo || 'otros', ingreso: 0, unidades: 0, costoEstimado: 0, platos: {} };
      for (const p of (cat.productos || [])) {
        const reparto = repartoCategorias(p.nombre, cf);
        // costo estimado del plato = ingreso × Σ(pct × foodCost de esa categoría de costo)
        let fcPlato = 0;
        for (const part of reparto) fcPlato += part.pct * (fc[part.categoria] || 0);
        const costoEst = (p.monto || 0) * fcPlato;
        const pn = p.nombre || 'Producto';
        const pp = c.platos[pn] = c.platos[pn] || { nombre: pn, ingreso: 0, unidades: 0, costoEstimado: 0, composicion: reparto.map(r => ({ categoria: r.categoria, pct: Math.round(r.pct * 1000) / 10 })) };
        pp.ingreso += p.monto || 0; pp.unidades += p.unidades || 0; pp.costoEstimado += costoEst;
        c.ingreso += p.monto || 0; c.unidades += p.unidades || 0; c.costoEstimado += costoEst;
      }
    }
  }
  return Object.values(cats_)
    .map(c => ({
      categoria: c.categoria, grupo: c.grupo,
      ingreso: Math.round(c.ingreso), unidades: c.unidades,
      costoEstimado: Math.round(c.costoEstimado),
      foodCost: c.ingreso > 0 ? Math.round((c.costoEstimado / c.ingreso) * 1000) / 10 : null,
      platos: Object.values(c.platos).map(p => ({
        ...p, ingreso: Math.round(p.ingreso), costoEstimado: Math.round(p.costoEstimado),
        margen: Math.round(p.ingreso - p.costoEstimado),
        foodCost: p.ingreso > 0 ? Math.round((p.costoEstimado / p.ingreso) * 1000) / 10 : null,
      })).sort((a, b) => b.ingreso - a.ingreso),
    }))
    .sort((a, b) => {
      const ord = { comida: 0, bebida: 1, otros: 2 };
      return (ord[a.grupo] - ord[b.grupo]) || (b.ingreso - a.ingreso);
    });
}

module.exports = {
  CATEGORIAS_COSTO, grupoCMV,
  clasificarProducto, setOverrideProducto, getOverrides, cargarOverrides, REGLAS_MENU,
  cargarComposiciones, getComposicion, setComposicion, listComposiciones, repartoCategorias, detallePorPlato,
  ingresosPorCategoriaCosto, costosPorCategoria, cmvDesglose, costosVsIngresos,
  montoCompra,
};
