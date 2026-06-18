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
function setOverrideProducto(nombreProducto, categoriaCosto) {
  if (!nombreProducto || !categoriaCosto) return;
  overrides.set(cats.norm(nombreProducto), categoriaCosto);
}
function getOverrides() {
  return [...overrides.entries()].map(([k, v]) => ({ producto: k, categoria: v }));
}

// Pistas extra propias del menú del bar que las keywords genéricas no cubren bien.
// (Se suman a las KEYWORDS de proveedores-categorias.js)
const KEYWORDS_MENU = {
  'Carnes y Embutidos': ['ojo de bife', 'bife', 'marucha', 'cuadril', 'entraña', 'entrana', 'vacio', 'vacío', 'asado', 'molleja', 'chorizo', 'morcilla', 'bondiola', 'matambre', 'pollo', 'milanesa', 'hamburguesa', 'lomo', 'cordero', 'lechon', 'lechón', 'pastrami', 'tapa de asado'],
  'Pescados y Mariscos': ['rabas', 'raba', 'langostino', 'calamar', 'pulpo', 'salmon', 'salmón', 'corvina', 'merluza', 'trucha', 'mejillon', 'mejillón', 'pesca', 'ceviche', 'tartar de atun', 'atun', 'atún', 'mar'],
  'Frutas y Verduras': ['ensalada', 'papas', 'papa', 'fritas', 'rucula', 'rúcula', 'tomate', 'palta', 'verdura', 'champignon', 'hongos', 'berenjena', 'zucchini', 'calabaza'],
  'Lacteos y Huevos': ['provoleta', 'queso', 'huevo', 'revuelto', 'burrata', 'mozzarella', 'muzzarella'],
  'Panificados y Masas': ['pan', 'focaccia', 'bruschetta', 'pizza', 'empanada', 'tarta', 'sandwich', 'sándwich', 'tostada'],
  'Bebidas y Alcohol': ['vino', 'malbec', 'cabernet', 'blend', 'espumante', 'champagne', 'cerveza', 'birra', 'ipa', 'lager', 'vermut', 'vermú', 'aperitivo', 'fernet', 'gin', 'whisky', 'agua', 'soda', 'gaseosa', 'coca', 'sprite', 'tonica', 'tónica', 'jugo', 'limonada', 'cafe', 'café', 'trago', 'negroni', 'spritz', 'campari'],
};

function clasificarProducto(nombreProducto, categoriaFudo) {
  const n = cats.norm(nombreProducto);
  if (!n) return null;
  if (overrides.has(n)) return overrides.get(n);

  // 1) Keywords del menú (más específicas)
  let mejor = null, mejorLargo = 0;
  for (const [cat, kws] of Object.entries(KEYWORDS_MENU)) {
    for (const kw of kws) {
      if (n.includes(cats.norm(kw)) && kw.length > mejorLargo) { mejor = cat; mejorLargo = kw.length; }
    }
  }
  if (mejor) return mejor;

  // 2) Keywords genéricas de proveedores-categorias
  const porKw = cats.inferirPorKeywords(nombreProducto);
  if (porKw) return porKw;

  // 3) Heurística por categoría FUDO de venta (último recurso, grueso)
  const cf = cats.norm(categoriaFudo);
  if (cf.includes('vino') || cf.includes('cerveza') || cf.includes('bebida') || cf.includes('alcohol') || cf.includes('sin alcohol')) {
    return 'Bebidas y Alcohol';
  }
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
        const catCosto = clasificarProducto(p.nombre, cat.categoria);
        const bucket = catCosto
          ? (acc[catCosto] = acc[catCosto] || { ingreso: 0, unidades: 0, productos: {} })
          : sinAsignar;
        bucket.ingreso += p.monto || 0;
        bucket.unidades += p.unidades || 0;
        const pn = p.nombre || 'Producto';
        const pp = bucket.productos[pn] = bucket.productos[pn] || { nombre: pn, ingreso: 0, unidades: 0, categoriaFudo: cat.categoria };
        pp.ingreso += p.monto || 0;
        pp.unidades += p.unidades || 0;
      }
    }
  }
  // aplanar productos a arrays ordenados
  const flat = (b) => ({
    ingreso: Math.round(b.ingreso),
    unidades: b.unidades,
    productos: Object.values(b.productos).sort((a, c) => c.ingreso - a.ingreso),
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
      topProductos: (ing.productos || []).slice(0, 8),
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

module.exports = {
  CATEGORIAS_COSTO, grupoCMV,
  clasificarProducto, setOverrideProducto, getOverrides, KEYWORDS_MENU,
  ingresosPorCategoriaCosto, costosPorCategoria, cmvDesglose, costosVsIngresos,
  montoCompra,
};
