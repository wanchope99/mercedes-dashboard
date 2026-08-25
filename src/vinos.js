// ─── Gestión de Bebidas ─────────────────────────────────────────────────────────
// Cruza el INVENTARIO de Fudo (stock, costo, precio por producto) con las VENTAS
// recientes para responder: cuánto stock tengo, cuánta plata hay inmovilizada,
// a qué velocidad se vende cada bebida, cuántos días de cobertura quedan, y qué
// conviene reponer o frenar.
//
// El stock, costo y precio salen directo de Fudo (Charly los carga ahí). No hay
// conteo manual ni hoja extra.
//
// Etapa 1: stock + valor + rotación. (La demanda por hora viene en la etapa 2.)

const NodeCache = require('node-cache');
const fudo = require('./fudo');
const bebidasProveedor = require('./bebidas-proveedor');

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

// ─── Las que no llevan alcohol y también hay que reponer (20/08/2026) ──────────
//
// Gaseosas, aguas y los sifones de soda. Hoy son ocho productos de la categoría
// "Sin Alcohol" de Fudo, todos con stock, costo y precio cargados — o sea que
// tienen exactamente los mismos datos que un vino y responden las mismas
// preguntas: cuánto queda, a qué velocidad sale, cuándo se va a acabar.
//
// Quedaban afuera porque esta pantalla nació como "gestión de vinos" y el filtro
// era el alcohol. Pero quedarse sin Coca un sábado es el mismo problema que
// quedarse sin Malbec, y era justamente lo único de la barra que la pantalla no
// avisaba. La categoría se sigue mostrando en cada fila, así que en la lista se
// distinguen igual, y el switch "Solo vinos" sigue estando para achicarla.
//
// Se listan también los nombres sueltos (gaseosa, agua, soda, jugo) por si algún
// día "Sin Alcohol" se parte en categorías propias: el criterio es lo que la
// bebida ES, no cómo se llama hoy la categoría en Fudo.
function esSinAlcohol(categoria) {
  const n = (categoria || '').toLowerCase();
  return n.includes('sin alcohol') || n.includes('gaseosa') || n.includes('agua') ||
         n.includes('soda') || n.includes('jugo') || n.includes('refresco');
}

// Lo que entra en esta pantalla. NO alcanza con "que sea una bebida": la
// categoría `Bebidas` de Fudo son los descorches y las copas sueltas, que no
// tienen stock ni costo porque se sirven de una botella que ya está contada.
// Meterlas acá serían siete filas con todo en "—" arriba de las que sí importan.
function esBebidaDeStock(categoria) {
  return esAlcohol(categoria) || esSinAlcohol(categoria);
}

// ¿Es específicamente vino? (para el foco principal)
function esVino(categoria) {
  return (categoria || '').toLowerCase().includes('vino');
}

// Análisis de inventario + rotación de las bebidas que se reponen por unidad
// (con y sin alcohol).
//   { desde, hasta }   → ventana para calcular la velocidad de venta (default 28 días).
//   { proveedor, categoria } → filtros de la pantalla. Filtran los ITEMS, y por lo
//   tanto también los KPIs: si mirás sólo Aurea, la plata inmovilizada que ves es
//   la de Aurea. Un KPI que ignorara el filtro diría otra cosa que la tabla que
//   tiene debajo. `proveedor` acepta el centinela '(sin asignar)'.
// Devuelve:
//   { ventanaDias, generado, totales, items: [...], porCategoria: [...],
//     proveedores: [...], categorias: [...] }
const SIN_PROVEEDOR = '(sin asignar)';

// ─── Lo caro se calcula una vez ────────────────────────────────────────────────
//
// Armar el detalle es leer Fudo, recorrer las ventas de la ventana y cruzar cada
// bebida contra la hoja Compras para deducir el proveedor. Los FILTROS de la
// pantalla no cambian nada de eso: se aplican al final, sobre la lista ya armada.
// Recalcularlo entero cada vez que alguien elige un proveedor era pagar el
// análisis completo para tirar filas.
//
// El TTL acompaña al del caché crudo de Fudo (5 min): más largo mostraría stock
// viejo, más corto no ahorraría nada porque abajo se recalcula igual.
const baseCache = new NodeCache({ stdTTL: 300 });

async function baseAnalisis({ desde, hasta } = {}) {
  const hoy = new Date();
  const hastaD = hasta || isoDia(hoy);
  const desdeD = desde || isoDia(new Date(hoy.getTime() - 27 * DIA_MS));
  const key = 'base|' + desdeD + '|' + hastaD;
  const cached = baseCache.get(key);
  if (cached) return cached;
  const base = await calcularBase({ desdeD, hastaD });
  baseCache.set(key, base);
  return base;
}

function clearCache() { baseCache.flushAll(); }

async function calcularBase({ desdeD, hastaD }) {
  // 1) Inventario actual desde Fudo. Se arma con TODAS las bebidas de stock: el
  // switch "Solo vinos" es un filtro de la pantalla y se aplica más abajo, como
  // el proveedor y la categoría.
  const productos = await fudo.getProductosConStock();
  const candidatos = productos.filter(p => p.active && esBebidaDeStock(p.categoria));

  // 2) Ventana de ventas para velocidad de venta
  const ventanaDias = Math.max(1, Math.round((new Date(hastaD + 'T00:00:00') - new Date(desdeD + 'T00:00:00')) / DIA_MS) + 1);

  // `incluirDescargas: true` — las botellas que se abren para vender por copa se
  // cargan en Fudo en una mesa aparte A $0, y esa venta queda descartada entera
  // por valer $0. Para la PLATA está bien (la plata entra por las copas), pero
  // para el STOCK es una botella que salió de la góndola igual: sin esto El Beppe
  // Criolla figuraba con 7 salidas en 28 días cuando el stock bajó 21.
  // Ver el comentario largo en getVentasItems (src/fudo.js).
  const ventas = await fudo.getVentasItems({ desde: desdeD, hasta: hastaD, incluirDescargas: true });

  // Unidades por productoId (y por nombre como fallback), separando las cobradas
  // de las descargadas por copa. Se cuentan juntas para la rotación y se informan
  // separadas para que el número se pueda explicar.
  const cobradoPorId = {}, cobradoPorNombre = {};
  const descargaPorId = {}, descargaPorNombre = {};
  for (const v of ventas) {
    // El MISMO criterio que el inventario, a propósito: si acá quedara el filtro
    // viejo, las gaseosas aparecerían con stock pero con cero ventas, o sea sin
    // rotación y sin días de cobertura — el dato que las hace útiles.
    if (!esBebidaDeStock(v.categoria)) continue;
    const porId = v.descarga ? descargaPorId : cobradoPorId;
    const porNombre = v.descarga ? descargaPorNombre : cobradoPorNombre;
    if (v.productoId != null) porId[v.productoId] = (porId[v.productoId] || 0) + v.unidades;
    porNombre[norm(v.nombre)] = (porNombre[norm(v.nombre)] || 0) + v.unidades;
  }

  // Quién trae cada bebida. Nunca puede tumbar la pantalla: si la hoja Compras o
  // la de correcciones no están disponibles, se sigue sin proveedor.
  const provPorId = await bebidasProveedor.resolver(candidatos).catch(e => {
    console.warn('Gestión de bebidas: sin proveedores (' + e.message + ')');
    return {};
  });

  // 3) Armar el detalle por producto
  const todos = candidatos.map(p => {
    const unidadesDe = (porId, porNombre) => (p.id != null && porId[p.id] != null)
      ? porId[p.id]
      : (porNombre[norm(p.name)] || 0);
    const cobradas = unidadesDe(cobradoPorId, cobradoPorNombre);
    const descargadas = unidadesDe(descargaPorId, descargaPorNombre);
    const vendidas = cobradas + descargadas;   // lo que salió del stock
    const porDia = ventanaDias > 0 ? vendidas / ventanaDias : 0;
    const porSemana = porDia * 7;
    const prov = provPorId[String(p.id)] || { proveedor: '', origen: null, via: null };

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
      proveedor: prov.proveedor || '',
      // 'manual' = alguien lo eligió · 'inferido' = lo dedujo el cruce de nombres
      // contra Compras · null = no se sabe. La pantalla los muestra distinto: un
      // proveedor adivinado no puede parecer un dato confirmado.
      proveedorOrigen: prov.origen || null,
      proveedorVia: prov.via || null,
      stock, cost, price, minStock: p.minStock,
      // vendidasVentana es TODO lo que salió del stock, que es lo que manda para
      // reponer. descargadasVentana es la parte que se fue en botellas abiertas
      // para servir por copa (tickets en $0), y cobradasVentana el resto.
      vendidasVentana: Math.round(vendidas * 100) / 100,
      cobradasVentana: Math.round(cobradas * 100) / 100,
      descargadasVentana: Math.round(descargadas * 100) / 100,
      porSemana: Math.round(porSemana * 100) / 100,
      diasCobertura,
      valorCosto, valorVenta,
      margenUnit, margenPct,
      alerta,
    };
  });

  // La lista del desplegable de proveedores sale de TODAS las bebidas, no de las
  // que sobrevivieron al filtro: si se armara después de filtrar, elegir un
  // proveedor dejaría el desplegable con un solo nombre y sin forma de volver.
  // Y son los proveedores DE BEBIDAS, no los 40 del bar (ver listaProveedores).
  const proveedores = await bebidasProveedor
    .listaProveedores(todos.map(it => it.proveedor))
    .catch(() => [...new Set(todos.map(it => it.proveedor).filter(Boolean))].sort());

  return { ventanaDias, desde: desdeD, hasta: hastaD, todos, proveedores };
}

// ─── Lo barato se aplica en cada pedido ────────────────────────────────────────
async function analizarVinos({ desde, hasta, soloVino = false, proveedor = '', categoria = '' } = {}) {
  const base = await baseAnalisis({ desde, hasta });
  const { ventanaDias, todos, proveedores } = base;
  const desdeD = base.desde, hastaD = base.hasta;

  // El switch "Solo vinos" achica el universo, así que la lista de categorías
  // sale de ahí: ofrecer "Sin Alcohol" con el switch prendido sería ofrecer un
  // filtro que no deja nada.
  const universo = soloVino ? todos.filter(it => it.esVino) : todos;
  const categorias = [...new Set(universo.map(it => it.categoria))].sort((a, b) => a.localeCompare(b, 'es'));

  // Filtros de la pantalla (se aplican DESPUÉS de armar las listas y ANTES de los
  // totales, para que los KPIs hablen de lo mismo que la tabla).
  const items = universo.filter(it =>
    (!categoria || it.categoria === categoria) &&
    (!proveedor || (proveedor === SIN_PROVEEDOR ? !it.proveedor : it.proveedor === proveedor)));

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
    // Cuántas de las salidas de la ventana fueron botellas abiertas para servir
    // por copa. Es el número que justifica la línea de aviso de la pantalla.
    descargadas: Math.round(sum(items, x => x.descargadasVentana) * 100) / 100,
    productosConDescarga: items.filter(x => x.descargadasVentana > 0).length,
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
    // Para los desplegables. `filtro` devuelve lo que efectivamente se aplicó, así
    // la pantalla puede repintar la selección sin adivinarla.
    proveedores, categorias,
    filtro: { proveedor: proveedor || '', categoria: categoria || '' },
    sinProveedorLabel: SIN_PROVEEDOR,
  };
}

function isoDia(d) { return d.toISOString().slice(0, 10); }
function norm(s) { return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' '); }

module.exports = { analizarVinos, clearCache, esAlcohol, esSinAlcohol, esBebidaDeStock, esVino, SIN_PROVEEDOR };
