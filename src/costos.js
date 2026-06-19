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
        const catCosto = clasificarProducto(p.nombre, cat.categoria);
        const bucket = catCosto
          ? (acc[catCosto] = acc[catCosto] || { ingreso: 0, unidades: 0, productos: {} })
          : sinAsignar;
        bucket.ingreso += p.monto || 0;
        bucket.unidades += p.unidades || 0;
        const pn = p.nombre || 'Producto';
        const pp = bucket.productos[pn] = bucket.productos[pn] || { nombre: pn, ingreso: 0, unidades: 0, categoriaFudo: cat.categoria, precios: {} };
        pp.ingreso += p.monto || 0;
        pp.unidades += p.unidades || 0;
        // Merge del desglose de precios { precioUnit: unidades } a lo largo de los días
        for (const [precio, u] of Object.entries(p.precios || {})) {
          pp.precios[precio] = (pp.precios[precio] || 0) + u;
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

module.exports = {
  CATEGORIAS_COSTO, grupoCMV,
  clasificarProducto, setOverrideProducto, getOverrides, REGLAS_MENU,
  ingresosPorCategoriaCosto, costosPorCategoria, cmvDesglose, costosVsIngresos,
  montoCompra,
};
