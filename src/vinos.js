// ─── Gestión de Vinos / Bebidas con alcohol ─────────────────────────────────────
// Cruza el INVENTARIO de Fudo (stock, costo, precio por producto) con las VENTAS
// recientes para responder: cuánto stock tengo, cuánta plata hay inmovilizada,
// a qué velocidad se vende cada vino, cuántos días de cobertura quedan, y qué
// conviene reponer o frenar.
//
// El stock, costo y precio salen directo de Fudo (Charly los carga ahí). No hay
// conteo manual ni hoja extra.
//
// Etapa 1: stock + valor + rotación. (La demanda por hora viene en la etapa 2.)

const fudo = require('./fudo');

const DIA_MS = 86_400_000;

// Categorías de Fudo que son "bebida con alcohol" (incluye toda la familia vino,
// cervezas y otros con alcohol). Se excluye "Sin Alcohol".
function esAlcohol(categoria) {
  const n = (categoria || '').toLowerCase();
  if (n.includes('sin alcohol')) return false;
  return n.includes('vino') || n.includes('cerveza') || n.includes('alcohol') ||
         n.includes('trago') || n.includes('espumante') || n.includes('champan') ||
         n.includes('champagne') || n.includes('aperitivo') || n.includes('vermut') ||
         n.includes('vermú');
}

// ¿Es específicamente vino? (para el foco principal)
function esVino(categoria) {
  return (categoria || '').toLowerCase().includes('vino');
}

// Análisis de inventario + rotación de bebidas con alcohol.
//   { desde, hasta }  → ventana para calcular la velocidad de venta (default 28 días).
// Devuelve:
//   { ventanaDias, generado, totales, items: [...], porCategoria: [...] }
async function analizarVinos({ desde, hasta, soloVino = false } = {}) {
  // 1) Inventario actual desde Fudo
  const productos = await fudo.getProductosConStock();
  const candidatos = productos.filter(p =>
    p.active && esAlcohol(p.categoria) && (!soloVino || esVino(p.categoria)));

  // 2) Ventana de ventas para velocidad de venta
  const hoy = new Date();
  const hastaD = hasta || isoDia(hoy);
  const desdeD = desde || isoDia(new Date(hoy.getTime() - 27 * DIA_MS));
  const ventanaDias = Math.max(1, Math.round((new Date(hastaD + 'T00:00:00') - new Date(desdeD + 'T00:00:00')) / DIA_MS) + 1);

  const ventas = await fudo.getVentasItems({ desde: desdeD, hasta: hastaD });
  // Agrupar unidades vendidas por productoId (y por nombre como fallback).
  const vendidoPorId = {};
  const vendidoPorNombre = {};
  for (const v of ventas) {
    if (!esAlcohol(v.categoria)) continue;
    if (v.productoId != null) vendidoPorId[v.productoId] = (vendidoPorId[v.productoId] || 0) + v.unidades;
    vendidoPorNombre[norm(v.nombre)] = (vendidoPorNombre[norm(v.nombre)] || 0) + v.unidades;
  }

  // 3) Armar el detalle por producto
  const items = candidatos.map(p => {
    const vendidas = (p.id != null && vendidoPorId[p.id] != null)
      ? vendidoPorId[p.id]
      : (vendidoPorNombre[norm(p.name)] || 0);
    const porDia = ventanaDias > 0 ? vendidas / ventanaDias : 0;
    const porSemana = porDia * 7;

    const stock = (typeof p.stock === 'number') ? p.stock : null;
    const cost = (typeof p.cost === 'number') ? p.cost : null;
    const price = (typeof p.price === 'number') ? p.price : null;

    const valorCosto = (stock != null && cost != null) ? stock * cost : null;   // plata inmovilizada
    const valorVenta = (stock != null && price != null) ? stock * price : null; // valor a precio de venta
    const margenUnit = (cost != null && price != null) ? price - cost : null;
    const margenPct = (cost != null && price != null && price > 0) ? Math.round(((price - cost) / price) * 1000) / 10 : null;

    // Días de cobertura: cuánto dura el stock al ritmo actual de venta.
    const diasCobertura = (stock != null && porDia > 0) ? Math.round((stock / porDia) * 10) / 10 : null;

    // Alerta de reposición:
    //   · quiebre: stock 0 o por debajo del mínimo de Fudo (si está seteado).
    //   · pronto: se agota en <= 7 días.
    //   · sobrestock: cobertura > 60 días (plata parada).
    //   · ok: el resto.
    let alerta = 'ok';
    if (stock != null && stock <= 0) alerta = 'quiebre';
    else if (p.minStock != null && stock != null && stock <= p.minStock) alerta = 'quiebre';
    else if (diasCobertura != null && diasCobertura <= 7) alerta = 'pronto';
    else if (diasCobertura != null && diasCobertura > 60) alerta = 'sobrestock';
    else if (stock != null && porDia === 0 && stock > 0) alerta = 'sin-ventas';

    return {
      id: p.id, nombre: p.name, categoria: p.categoria,
      esVino: esVino(p.categoria),
      stock, cost, price, minStock: p.minStock,
      vendidasVentana: Math.round(vendidas * 100) / 100,
      porSemana: Math.round(porSemana * 100) / 100,
      diasCobertura,
      valorCosto, valorVenta,
      margenUnit, margenPct,
      alerta,
    };
  });

  // Ordenar: primero lo más urgente (quiebre, pronto), luego por plata inmovilizada.
  const ordenAlerta = { quiebre: 0, pronto: 1, 'sin-ventas': 2, ok: 3, sobrestock: 4 };
  items.sort((a, b) =>
    (ordenAlerta[a.alerta] - ordenAlerta[b.alerta]) ||
    ((b.valorCosto || 0) - (a.valorCosto || 0)));

  // 4) Totales
  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const totales = {
    items: items.length,
    stockTotal: sum(items, x => x.stock),
    plataInmovilizada: Math.round(sum(items, x => x.valorCosto)),
    valorVentaStock: Math.round(sum(items, x => x.valorVenta)),
    enQuiebre: items.filter(x => x.alerta === 'quiebre').length,
    porAgotarse: items.filter(x => x.alerta === 'pronto').length,
    sobrestock: items.filter(x => x.alerta === 'sobrestock').length,
    // Margen potencial si se vendiera todo el stock al precio actual.
    margenPotencial: Math.round(sum(items, x => (x.valorVenta || 0) - (x.valorCosto || 0))),
  };

  // 5) Resumen por categoría
  const catMap = {};
  for (const it of items) {
    const c = catMap[it.categoria] = catMap[it.categoria] || {
      categoria: it.categoria, items: 0, stock: 0, plataInmovilizada: 0, valorVenta: 0,
    };
    c.items++;
    c.stock += it.stock || 0;
    c.plataInmovilizada += it.valorCosto || 0;
    c.valorVenta += it.valorVenta || 0;
  }
  const porCategoria = Object.values(catMap)
    .map(c => ({ ...c, plataInmovilizada: Math.round(c.plataInmovilizada), valorVenta: Math.round(c.valorVenta) }))
    .sort((a, b) => b.plataInmovilizada - a.plataInmovilizada);

  return {
    ventanaDias, desde: desdeD, hasta: hastaD,
    generado: new Date().toISOString(),
    totales, items, porCategoria,
  };
}

function isoDia(d) { return d.toISOString().slice(0, 10); }
function norm(s) { return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' '); }

module.exports = { analizarVinos, esAlcohol, esVino };
