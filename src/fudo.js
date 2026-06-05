// ─── Integración con la API de Fudo (POS gastronómico) ─────────────────────────
// API JSON:API · base https://api.fu.do/v1alpha1 · auth https://auth.fu.do/api
//
// Credenciales por variable de entorno (NUNCA hardcodear):
//   FUDO_API_KEY     -> apiKey
//   FUDO_API_SECRET  -> apiSecret
//
// Expone:
//   getServicios({ desde, hasta })  -> resumen por día (pax, total, comida/bebida/otros)
//   getServicioDetalle(fecha)       -> detalle de un día: productos por categoría + pagos
//   clearFudoCache()

const NodeCache = require('node-cache');

const AUTH_URL = process.env.FUDO_AUTH_URL || 'https://auth.fu.do/api';
const API_BASE = process.env.FUDO_API_BASE || 'https://api.fu.do/v1alpha1';
const API_KEY = process.env.FUDO_API_KEY;
const API_SECRET = process.env.FUDO_API_SECRET;

// Caché de datos crudos (5 min). Los productos/categorías cambian poco; las ventas
// se refrescan seguido pero el volumen es chico, así que cacheamos todo junto.
const cache = new NodeCache({ stdTTL: 300 });

// fetch nativo (Node 18+). Fallback a node-fetch si hiciera falta.
const _fetch = (typeof fetch !== 'undefined')
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── Clasificación de categorías de Fudo ───────────────────────────────────────
// Mapeo de cada categoría de productos de Fudo a un grupo de negocio.
// "Otros" agrupa combos/menús especiales (ej. "25 de mayo") que no son
// comida ni bebida pura y distorsionarían la proporción.
const GRUPO_CATEGORIA = {
  // Comida
  'PARA PICAR': 'comida',
  'PARA COMER': 'comida',
  'Postres': 'comida',
  // Bebida
  'Bebidas': 'bebida',
  'Vinos Espumosos': 'bebida',
  'Vinos Blancos': 'bebida',
  'Vinos Rosados': 'bebida',
  'Vinos Tintos': 'bebida',
  'Vinos Dulces': 'bebida',
  'Cervezas': 'bebida',
  'Sin Alcohol': 'bebida',
  'Otros con Alcohol': 'bebida',
};

// Fallback heurístico para categorías nuevas que no estén en el mapa explícito.
function grupoDeCategoria(nombre) {
  if (GRUPO_CATEGORIA[nombre]) return GRUPO_CATEGORIA[nombre];
  const n = (nombre || '').toLowerCase();
  if (n.includes('vino') || n.includes('cerveza') || n.includes('bebida') ||
      n.includes('alcohol') || n.includes('trago') || n.includes('café') ||
      n.includes('cafe') || n.includes('jugo') || n.includes('agua') || n.includes('gaseosa')) {
    return 'bebida';
  }
  if (n.includes('picar') || n.includes('comer') || n.includes('postre') ||
      n.includes('plato') || n.includes('entrada') || n.includes('principal')) {
    return 'comida';
  }
  return 'otros';
}

// ─── Helpers de red ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch con reintento ante 429 (Too Many Requests) y errores 5xx transitorios.
// Backoff exponencial respetando el header Retry-After si Fudo lo envía.
async function fetchRetry(url, opts = {}, { tries = 4, baseDelay = 1500, label = '' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await _fetch(url, opts);
    } catch (e) {
      lastErr = e;
      await sleep(baseDelay * Math.pow(2, i));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      // rate limit o error de servidor → esperar y reintentar
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : baseDelay * Math.pow(2, i);
      lastErr = new Error(`${label || 'Fudo'} (${res.status})`);
      if (i < tries - 1) { await sleep(Math.min(wait, 15_000)); continue; }
    }
    return res;
  }
  throw lastErr || new Error(`${label || 'Fudo'}: sin respuesta tras reintentos`);
}

// ─── Auth ───────────────────────────────────────────────────────────────────────
async function getToken() {
  if (!API_KEY || !API_SECRET) {
    throw new Error('Faltan credenciales de Fudo (FUDO_API_KEY / FUDO_API_SECRET)');
  }
  const cached = cache.get('fudo_token');
  if (cached && cached.exp * 1000 > Date.now() + 60_000) return cached.token;

  let res;
  try {
    res = await fetchRetry(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY, apiSecret: API_SECRET }),
    }, { label: 'Auth Fudo' });
  } catch (e) {
    // Si la red falla pero hay token cacheado (aunque casi vencido), usarlo
    if (cached && cached.token) return cached.token;
    throw new Error(`Auth Fudo sin conexión: ${e.message}`);
  }
  if (!res.ok) {
    // Rate limit persistente: reutilizar token viejo si existe
    if (res.status === 429 && cached && cached.token) return cached.token;
    const t = await res.text().catch(() => '');
    const msg = res.status === 429
      ? 'Fudo limitó las solicitudes (429). Esperá un momento y reintentá.'
      : `Auth Fudo falló (${res.status}): ${t.slice(0, 150)}`;
    throw new Error(msg);
  }
  const json = await res.json();
  if (!json.token) throw new Error('Auth Fudo no devolvió token');
  cache.set('fudo_token', { token: json.token, exp: json.exp || 0 }, 86_400);
  return json.token;
}

// ─── Fetch paginado de un recurso JSON:API ─────────────────────────────────────
async function fetchAll(resource) {
  const token = await getToken();
  const size = 500;
  let page = 1;
  let all = [];
  while (true) {
    const url = `${API_BASE}/${resource}?page[size]=${size}&page[number]=${page}`;
    const res = await fetchRetry(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    }, { label: `Fudo ${resource}` });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const msg = res.status === 429
        ? `Fudo limitó las solicitudes al pedir ${resource} (429). Reintentá en unos minutos.`
        : `Fudo ${resource} (${res.status}): ${t.slice(0, 150)}`;
      throw new Error(msg);
    }
    const json = await res.json();
    const data = json.data || [];
    all = all.concat(data);
    if (data.length < size) break;
    page++;
    if (page > 50) break; // tope de seguridad
  }
  return all;
}

// ─── Carga y cruce de todos los datos crudos ───────────────────────────────────
async function loadRaw() {
  const cached = cache.get('fudo_raw');
  if (cached) return cached;

  // Llamadas SECUENCIALES (con micro-pausa) para no gatillar el rate limit de Fudo.
  let sales, items, products, categories, payments, paymentMethods;
  try {
    sales          = await fetchAll('sales');           await sleep(150);
    items          = await fetchAll('items');           await sleep(150);
    products       = await fetchAll('products');        await sleep(150);
    categories     = await fetchAll('product-categories'); await sleep(150);
    payments       = await fetchAll('payments');        await sleep(150);
    paymentMethods = await fetchAll('payment-methods');
  } catch (e) {
    // Si Fudo limita o falla, servir el último dato bueno conocido (si existe)
    const backup = cache.get('fudo_raw_backup');
    if (backup) return backup;
    throw e;
  }

  // Mapas de lookup
  const catName = {};
  categories.forEach(c => { catName[c.id] = (c.attributes && c.attributes.name) || 'Sin categoría'; });

  const prod = {};
  products.forEach(p => {
    const catRel = p.relationships && p.relationships.productCategory && p.relationships.productCategory.data;
    prod[p.id] = {
      name: (p.attributes && p.attributes.name) || 'Producto',
      price: (p.attributes && p.attributes.price) || 0,
      categoriaId: catRel ? catRel.id : null,
      categoria: catRel ? (catName[catRel.id] || 'Sin categoría') : 'Sin categoría',
    };
  });

  const pmName = {};
  paymentMethods.forEach(m => { pmName[m.id] = (m.attributes && m.attributes.name) || 'Otro'; });

  // Items agrupados por venta
  const itemsBySale = {};
  items.forEach(it => {
    const saleRel = it.relationships && it.relationships.sale && it.relationships.sale.data;
    if (!saleRel) return;
    (itemsBySale[saleRel.id] = itemsBySale[saleRel.id] || []).push(it);
  });

  // Pagos agrupados por venta
  const paymentsBySale = {};
  payments.forEach(pay => {
    if (pay.attributes && pay.attributes.canceled) return;
    const saleRel = pay.relationships && pay.relationships.sale && pay.relationships.sale.data;
    if (!saleRel) return;
    const mRel = pay.relationships && pay.relationships.paymentMethod && pay.relationships.paymentMethod.data;
    (paymentsBySale[saleRel.id] = paymentsBySale[saleRel.id] || []).push({
      amount: (pay.attributes && pay.attributes.amount) || 0,
      metodo: mRel ? (pmName[mRel.id] || 'Otro') : 'Otro',
    });
  });

  const raw = { sales, prod, catName, itemsBySale, paymentsBySale };
  cache.set('fudo_raw', raw);
  cache.set('fudo_raw_backup', raw, 86_400); // respaldo 24h por si Fudo limita luego
  return raw;
}

// ─── Monto de un ítem ───────────────────────────────────────────────────────────
// Regla acordada: se usa el precio de lista del producto × cantidad, PERO
// respetando invitaciones/descuentos: si en esa venta el ítem quedó en $0
// explícito (invitación), se cuenta como $0. Si el ítem trae un precio > 0
// propio (descuento puntual), se usa ese. Si viene null, se usa el de lista.
function montoItem(item, producto) {
  const q = (item.attributes && item.attributes.quantity) || 0;
  const ip = item.attributes ? item.attributes.price : null;
  let unit;
  if (ip === 0) unit = 0;                       // invitación / cortesía
  else if (typeof ip === 'number' && ip > 0) unit = ip; // precio puntual de la venta
  else unit = producto ? producto.price : 0;    // precio de lista
  return unit * q;
}

// ─── Resumen de servicios por día ──────────────────────────────────────────────
async function getServicios({ desde, hasta } = {}) {
  const { sales, prod, itemsBySale, paymentsBySale } = await loadRaw();

  const dDesde = desde ? new Date(desde + 'T00:00:00Z') : null;
  const dHasta = hasta ? new Date(hasta + 'T23:59:59Z') : null;

  const dias = {};
  for (const s of sales) {
    const a = s.attributes || {};
    if (a.saleState !== 'CLOSED') continue;      // solo ventas cerradas
    const closed = a.closedAt;
    if (!closed) continue;
    const fechaISO = closed.slice(0, 10);
    const d = new Date(closed);
    if (dDesde && d < dDesde) continue;
    if (dHasta && d > dHasta) continue;

    if (!dias[fechaISO]) {
      dias[fechaISO] = {
        fecha: fechaISO,
        ventas: 0, pax: 0, total: 0,
        comida: 0, bebida: 0, otros: 0,
        mediosPago: {},
      };
    }
    const dia = dias[fechaISO];
    dia.ventas++;
    dia.pax += a.people || 0;
    dia.total += a.total || 0;   // facturación real de la venta (fuente de verdad)

    // Desglose por categoría (estimado, precio lista × cantidad)
    const items = itemsBySale[s.id] || [];
    for (const it of items) {
      if (it.attributes && it.attributes.canceled) continue;
      const pRel = it.relationships && it.relationships.product && it.relationships.product.data;
      const producto = pRel ? prod[pRel.id] : null;
      const monto = montoItem(it, producto);
      const grupo = producto ? grupoDeCategoria(producto.categoria) : 'otros';
      dia[grupo] += monto;
    }

    // Medios de pago
    const pays = paymentsBySale[s.id] || [];
    for (const p of pays) {
      dia.mediosPago[p.metodo] = (dia.mediosPago[p.metodo] || 0) + p.amount;
    }
  }

  // Proporción comida/bebida calculada SOLO sobre comida+bebida (excluye combos),
  // para que los menús especiales no rompan el ratio.
  return Object.values(dias)
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
    .map(d => {
      const baseCB = d.comida + d.bebida;
      return {
        ...d,
        ticketPromedio: d.pax > 0 ? d.total / d.pax : 0,
        pctComida: baseCB > 0 ? (d.comida / baseCB) * 100 : 0,
        pctBebida: baseCB > 0 ? (d.bebida / baseCB) * 100 : 0,
      };
    });
}

// ─── Detalle de un servicio (un día) ───────────────────────────────────────────
async function getServicioDetalle(fecha) {
  const { sales, prod, itemsBySale, paymentsBySale } = await loadRaw();

  const daySales = sales.filter(s => {
    const a = s.attributes || {};
    return a.saleState === 'CLOSED' && a.closedAt && a.closedAt.slice(0, 10) === fecha;
  });

  if (!daySales.length) {
    return { fecha, encontrado: false };
  }

  let pax = 0, total = 0;
  const porCategoria = {};   // categoria -> { categoria, grupo, monto, unidades, productos:{} }
  const mediosPago = {};
  let primera = null, ultima = null;

  for (const s of daySales) {
    const a = s.attributes || {};
    pax += a.people || 0;
    total += a.total || 0;
    if (a.closedAt) {
      if (!primera || a.createdAt < primera) primera = a.createdAt || a.closedAt;
      if (!ultima || a.closedAt > ultima) ultima = a.closedAt;
    }

    const items = itemsBySale[s.id] || [];
    for (const it of items) {
      if (it.attributes && it.attributes.canceled) continue;
      const pRel = it.relationships && it.relationships.product && it.relationships.product.data;
      const producto = pRel ? prod[pRel.id] : null;
      const cat = producto ? producto.categoria : 'Sin categoría';
      const grupo = producto ? grupoDeCategoria(cat) : 'otros';
      const q = (it.attributes && it.attributes.quantity) || 0;
      const monto = montoItem(it, producto);

      if (!porCategoria[cat]) porCategoria[cat] = { categoria: cat, grupo, monto: 0, unidades: 0, productos: {} };
      porCategoria[cat].monto += monto;
      porCategoria[cat].unidades += q;

      const pname = producto ? producto.name : 'Producto';
      if (!porCategoria[cat].productos[pname]) porCategoria[cat].productos[pname] = { nombre: pname, unidades: 0, monto: 0 };
      porCategoria[cat].productos[pname].unidades += q;
      porCategoria[cat].productos[pname].monto += monto;
    }

    const pays = paymentsBySale[s.id] || [];
    for (const p of pays) mediosPago[p.metodo] = (mediosPago[p.metodo] || 0) + p.amount;
  }

  // Aplanar categorías y ordenar productos
  const categorias = Object.values(porCategoria)
    .map(c => ({
      categoria: c.categoria,
      grupo: c.grupo,
      monto: c.monto,
      unidades: c.unidades,
      productos: Object.values(c.productos).sort((a, b) => b.unidades - a.unidades),
    }))
    .sort((a, b) => {
      // ordenar por grupo (comida, bebida, otros) y dentro por unidades
      const ord = { comida: 0, bebida: 1, otros: 2 };
      return (ord[a.grupo] - ord[b.grupo]) || (b.unidades - a.unidades);
    });

  const comida = categorias.filter(c => c.grupo === 'comida').reduce((s, c) => s + c.monto, 0);
  const bebida = categorias.filter(c => c.grupo === 'bebida').reduce((s, c) => s + c.monto, 0);
  const otros  = categorias.filter(c => c.grupo === 'otros').reduce((s, c) => s + c.monto, 0);
  const baseCB = comida + bebida;

  return {
    fecha,
    encontrado: true,
    ventas: daySales.length,
    pax,
    total,
    ticketPromedio: pax > 0 ? total / pax : 0,
    apertura: primera,
    cierre: ultima,
    comida, bebida, otros,
    pctComida: baseCB > 0 ? (comida / baseCB) * 100 : 0,
    pctBebida: baseCB > 0 ? (bebida / baseCB) * 100 : 0,
    categorias,
    mediosPago,
  };
}

function clearFudoCache() {
  cache.del('fudo_raw');
}

module.exports = { getServicios, getServicioDetalle, clearFudoCache, grupoDeCategoria };
