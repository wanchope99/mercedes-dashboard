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

// Categorías que se venden "tal cual" en FUDO (match directo confiable).
const CATEGORIAS_DIRECTAS = new Set(['Bebidas y Alcohol']);

// Overrides manuales de match: { productoCanonNorm: nombreFudoNorm }. En memoria.
const overridesMatch = new Map();
function setMatchOverride(productoCanon, nombreFudo) {
  overridesMatch.set(cats.norm(productoCanon), cats.norm(nombreFudo));
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
  try { detalles = await fudo.getDetallesTodos({ desde, hasta }); }
  catch (e) { detalles = []; }

  const overr = overridesMatch.get(cats.norm(productoCanon));
  const ventas = [];
  const nombresVistos = {}; // nombreFudoNorm -> { nombre, sim }
  const UMBRAL_SIM = 0.5;

  for (const dia of detalles) {
    for (const cat of (dia.categorias || [])) {
      for (const p of (cat.productos || [])) {
        const nf = cats.norm(p.nombre);
        let match = false, sim = 0;
        if (overr) {
          match = (nf === overr);
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
  const canon = cats.nombreCanonico(producto);

  // Compras (ingresos) de ese producto canónico
  const todas = await prov.getCompras();
  const pn = cats.norm(canon);
  const compras = todas
    .filter(c => c.producto && cats.norm(cats.nombreCanonico(c.producto)) === pn)
    .filter(c => !categoria || cats.normalizarCategoria(c.categoria).categoria === categoria)
    .filter(c => (!desde || !c.fecha || c.fecha >= desde) && (!hasta || !c.fecha || c.fecha <= hasta))
    .map(c => ({ fecha: c.fecha, cantidad: c.cantidad, precioUnit: c.precioUnit, proveedor: c.proveedor, unidad: c.unidad }))
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  // Categoría del producto (para decidir match directo/indirecto)
  const catProd = compras.length ? (cats.normalizarCategoria(
    (todas.find(c => cats.norm(cats.nombreCanonico(c.producto)) === pn) || {}).categoria).categoria) : (categoria || '');
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

  return {
    producto: canon, categoria: catProd, unidad, directo,
    compras, ventas,
    diasPromedio, ultimaCompra, ultimaVenta, riesgo,
    matchNombre, matchSim, matchInfo,
  };
}

module.exports = { getProductosStock, getSerieStock, setMatchOverride, similitud };
