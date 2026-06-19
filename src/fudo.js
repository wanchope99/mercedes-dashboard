// ─── Integración con la API de Fudo (POS gastronómico) ─────────────────────────
// API JSON:API · base https://api.fu.do/v1alpha1 · auth https://auth.fu.do/api
//
// Credenciales por variable de entorno (NUNCA hardcodear):
//   FUDO_API_KEY     -> apiKey
//   FUDO_API_SECRET  -> apiSecret
//
// El token se renueva SOLO: getToken() pide uno nuevo a auth.fu.do cuando el
// cacheado está por vencer (24 h). No hay que rotar nada en Railway salvo que
// cambie el apiSecret.
//
// PERSISTENCIA: los días de servicio ya finalizados se guardan como snapshot en
// la hoja "Fudo Historico" del spreadsheet. El histórico se sirve SIEMPRE desde
// ahí; a Fudo solo se le piden los días posteriores al último guardado. Si la
// API de Fudo se cae o limita, el histórico sigue disponible.
//
// Expone:
//   getServicios({ desde, hasta })  -> resumen por día (pax, total, propinas, comida/bebida)
//   getServicioDetalle(fecha)       -> detalle de un día: productos por categoría + pagos
//   getServicioDebug(fecha)         -> venta por venta: total vs pagos (diagnóstico)
//   resnapshotDia(fecha)            -> rehace el snapshot guardado de un día
//   clearFudoCache()

const NodeCache = require('node-cache');
const { google } = require('googleapis');

const AUTH_URL = process.env.FUDO_AUTH_URL || 'https://auth.fu.do/api';
const API_BASE = process.env.FUDO_API_BASE || 'https://api.fu.do/v1alpha1';
const API_KEY = process.env.FUDO_API_KEY;
const API_SECRET = process.env.FUDO_API_SECRET;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HIST_SHEET = process.env.FUDO_HIST_SHEET || 'Fudo Historico';

// Caché de datos crudos (5 min) + histórico (10 min) + token (24 h).
const cache = new NodeCache({ stdTTL: 300 });

// fetch nativo (Node 18+). Fallback a node-fetch si hiciera falta.
const _fetch = (typeof fetch !== 'undefined')
  ? fetch
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── Clasificación de categorías de Fudo ───────────────────────────────────────
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

// ─── Corte por turno de servicio ────────────────────────────────────────────────
// El turno va de 16:00 a 16:00 del día siguiente (hora AR). La madrugada
// pertenece al servicio del día anterior.
const TZ_OFFSET_H = parseFloat(process.env.FUDO_TZ_OFFSET || '-3');
const TURNO_INICIO_H = parseFloat(process.env.FUDO_TURNO_INICIO_H || '16');

function fechaServicio(isoUtc) {
  const shifted = new Date(isoUtc).getTime() + (TZ_OFFSET_H - TURNO_INICIO_H) * 3600 * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

// Fecha de servicio "en curso" ahora mismo. Todo día anterior a esta fecha se
// considera FINALIZADO y es candidato a snapshot.
function fechaServicioHoy() {
  return fechaServicio(new Date().toISOString());
}

// ─── Helpers de red ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : baseDelay * Math.pow(2, i);
      lastErr = new Error(`${label || 'Fudo'} (${res.status})`);
      if (i < tries - 1) { await sleep(Math.min(wait, 15_000)); continue; }
    }
    return res;
  }
  throw lastErr || new Error(`${label || 'Fudo'}: sin respuesta tras reintentos`);
}

// ─── Auth (token auto-renovable) ────────────────────────────────────────────────
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
    if (cached && cached.token) return cached.token;
    throw new Error(`Auth Fudo sin conexión: ${e.message}`);
  }
  if (!res.ok) {
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
    // Tope de seguridad MUY alto. Antes era 50 (25.000 registros), lo que truncaba
    // los items/payments más nuevos cuando el histórico crecía y hacía que faltaran
    // productos de ventas recientes en el desglose. 4000 páginas = 2M registros.
    if (page > 4000) { console.warn(`Fudo ${resource}: alcanzado el tope de paginación (${all.length} registros). Puede faltar data.`); break; }
  }
  return all;
}

// ─── Carga y cruce de todos los datos crudos ───────────────────────────────────
async function loadRaw() {
  const cached = cache.get('fudo_raw');
  if (cached) return cached;

  let sales, items, products, categories, payments, paymentMethods;
  try {
    sales          = await fetchAll('sales');           await sleep(150);
    items          = await fetchAll('items');           await sleep(150);
    products       = await fetchAll('products');        await sleep(150);
    categories     = await fetchAll('product-categories'); await sleep(150);
    payments       = await fetchAll('payments');        await sleep(150);
    paymentMethods = await fetchAll('payment-methods');
  } catch (e) {
    const backup = cache.get('fudo_raw_backup');
    if (backup) return backup;
    throw e;
  }

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

  const itemsBySale = {};
  items.forEach(it => {
    const saleRel = it.relationships && it.relationships.sale && it.relationships.sale.data;
    if (!saleRel) return;
    (itemsBySale[saleRel.id] = itemsBySale[saleRel.id] || []).push(it);
  });

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
  cache.set('fudo_raw_backup', raw, 86_400);
  return raw;
}

// ─── Monto de un ítem ───────────────────────────────────────────────────────────
function montoItem(item, producto) {
  // IMPORTANTE: en la API de Fudo, item.price es el TOTAL de la línea (ya
  // multiplicado por la cantidad), NO el precio unitario. Por eso el monto de la
  // línea es item.price tal cual. Solo si la línea no trae price caemos al precio
  // de lista del producto × cantidad como estimación.
  const q = (item.attributes && item.attributes.quantity) || 0;
  const ip = item.attributes ? item.attributes.price : null;
  if (typeof ip === 'number' && ip >= 0) return ip;          // total de la línea
  return (producto ? producto.price : 0) * q;                // fallback estimado
}

// ─── Ventas computables ─────────────────────────────────────────────────────────
// Igual que Fudo: una venta cuenta si está CERRADA y tiene total > 0.
// Las mesas cerradas en $0 (aperturas por error) NO suman ventas ni pax.
function ventaComputable(a) {
  return a.saleState === 'CLOSED' && a.closedAt && (a.total || 0) > 0;
}

// ─── Construcción de detalles por día (a partir de datos crudos de Fudo) ───────
// Devuelve { 'YYYY-MM-DD': detalle } con el MISMO shape que getServicioDetalle.
function buildDetalles(raw) {
  const { sales, prod, itemsBySale, paymentsBySale } = raw;
  const dias = {};

  for (const s of sales) {
    const a = s.attributes || {};
    if (!ventaComputable(a)) continue;
    const fecha = fechaServicio(a.closedAt);

    if (!dias[fecha]) {
      dias[fecha] = {
        fecha, encontrado: true,
        ventas: 0, pax: 0, total: 0, propinas: 0,
        comida: 0, bebida: 0, otros: 0,
        apertura: null, cierre: null,
        porCategoria: {}, mediosPago: {},
      };
    }
    const dia = dias[fecha];
    dia.ventas++;
    dia.pax += a.people || 0;
    dia.total += a.total || 0;
    if (!dia.apertura || (a.createdAt && a.createdAt < dia.apertura)) dia.apertura = a.createdAt || a.closedAt;
    if (!dia.cierre || a.closedAt > dia.cierre) dia.cierre = a.closedAt;

    // Ítems → categorías y productos
    const items = itemsBySale[s.id] || [];
    for (const it of items) {
      if (it.attributes && it.attributes.canceled) continue;
      const pRel = it.relationships && it.relationships.product && it.relationships.product.data;
      const producto = pRel ? prod[pRel.id] : null;
      const cat = producto ? producto.categoria : 'Sin categoría';
      const grupo = producto ? grupoDeCategoria(cat) : 'otros';
      const q = (it.attributes && it.attributes.quantity) || 0;
      const monto = montoItem(it, producto);

      dia[grupo] += monto;
      if (!dia.porCategoria[cat]) dia.porCategoria[cat] = { categoria: cat, grupo, monto: 0, unidades: 0, productos: {} };
      dia.porCategoria[cat].monto += monto;
      dia.porCategoria[cat].unidades += q;
      const pname = producto ? producto.name : 'Producto';
      if (!dia.porCategoria[cat].productos[pname]) dia.porCategoria[cat].productos[pname] = { nombre: pname, unidades: 0, monto: 0, precios: {} };
      // Desglose por precio unitario real: { precioUnit: unidades }. Permite ver a qué
      // precio se vendió cada unidad (descuentos, cortesías, cambios de precio).
      const unit = q > 0 ? Math.round((monto / q) * 100) / 100 : 0;
      const pp0 = dia.porCategoria[cat].productos[pname];
      pp0.precios[unit] = (pp0.precios[unit] || 0) + q;
      dia.porCategoria[cat].productos[pname].unidades += q;
      dia.porCategoria[cat].productos[pname].monto += monto;
    }

    // Pagos → medios de pago + propina (lo cobrado por encima del total de la venta)
    const pays = paymentsBySale[s.id] || [];
    let pagado = 0;
    for (const p of pays) {
      dia.mediosPago[p.metodo] = (dia.mediosPago[p.metodo] || 0) + p.amount;
      pagado += p.amount;
    }
    const propina = pagado - (a.total || 0);
    if (propina > 0.005) dia.propinas += Math.round(propina * 100) / 100;
  }

  // Finalizar: aplanar categorías, calcular ratios
  const out = {};
  for (const [fecha, d] of Object.entries(dias)) {
    const categorias = Object.values(d.porCategoria)
      .map(c => ({
        categoria: c.categoria, grupo: c.grupo, monto: c.monto, unidades: c.unidades,
        productos: Object.values(c.productos).sort((a, b) => b.unidades - a.unidades),
      }))
      .sort((a, b) => {
        const ord = { comida: 0, bebida: 1, otros: 2 };
        return (ord[a.grupo] - ord[b.grupo]) || (b.unidades - a.unidades);
      });
    const baseCB = d.comida + d.bebida;
    delete d.porCategoria;
    out[fecha] = {
      ...d,
      categorias,
      ticketPromedio: d.pax > 0 ? d.total / d.pax : 0,
      pctComida: baseCB > 0 ? (d.comida / baseCB) * 100 : 0,
      pctBebida: baseCB > 0 ? (d.bebida / baseCB) * 100 : 0,
    };
  }
  return out;
}

// Resumen liviano (para la lista de servicios) a partir de un detalle
function resumenDeDetalle(d) {
  return {
    fecha: d.fecha, ventas: d.ventas, pax: d.pax, total: d.total,
    propinas: d.propinas || 0,
    comida: d.comida, bebida: d.bebida, otros: d.otros,
    mediosPago: d.mediosPago || {},
    ticketPromedio: d.ticketPromedio, pctComida: d.pctComida, pctBebida: d.pctBebida,
  };
}

// ─── Persistencia en Google Sheets (hoja "Fudo Historico") ─────────────────────
// Columnas: A Fecha · B Guardado El · C Ventas · D Pax · E Total · F Propinas · G JSON
function getSheetsClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const persistenciaActiva = () => Boolean(SPREADSHEET_ID);

async function ensureHistSheet(sheetsApi) {
  try {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HIST_SHEET, hidden: false } } }] },
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HIST_SHEET}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Fecha', 'Guardado El', 'Ventas', 'Pax', 'Total', 'Propinas', 'JSON']] },
    });
  } catch (e) {
    // "already exists" → ok
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

// Lee todo el histórico. Devuelve { 'YYYY-MM-DD': { rowIndex, detalle } }
async function loadHistorico() {
  if (!persistenciaActiva()) return {};
  const cached = cache.get('fudo_hist');
  if (cached) return cached;

  const sheetsApi = getSheetsClient();
  let rows = [];
  try {
    const res = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HIST_SHEET}!A:G`,
    });
    rows = res.data.values || [];
  } catch (e) {
    // La hoja no existe todavía: crearla y seguir con histórico vacío
    try { await ensureHistSheet(sheetsApi); } catch (e2) { console.warn('Fudo Historico: no se pudo crear la hoja:', e2.message); }
    rows = [];
  }

  const hist = {};
  for (let i = 1; i < rows.length; i++) {  // i=0 es el header
    const row = rows[i];
    if (!row || !row[0] || !row[6]) continue;
    try {
      hist[row[0]] = { rowIndex: i + 1, detalle: JSON.parse(row[6]) };
    } catch { /* JSON corrupto: ignorar esa fila */ }
  }
  cache.set('fudo_hist', hist, 600);
  return hist;
}

// Guarda (append) los días nuevos finalizados. No falla la request si Sheets falla.
async function persistDias(detalles) {
  if (!persistenciaActiva() || !detalles.length) return;
  try {
    const sheetsApi = getSheetsClient();
    await ensureHistSheet(sheetsApi);
    const values = detalles.map(d => [
      d.fecha, new Date().toISOString(), d.ventas, d.pax, d.total, d.propinas || 0,
      JSON.stringify(d),
    ]);
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HIST_SHEET}!A:G`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    cache.del('fudo_hist');
    console.log(`Fudo Historico: guardados ${detalles.length} día(s): ${detalles.map(d => d.fecha).join(', ')}`);
  } catch (e) {
    console.warn('Fudo Historico: error guardando snapshot:', e.message);
  }
}

// Rehace el snapshot de un día (pisa la fila si existe, agrega si no)
async function resnapshotDia(fecha) {
  if (!persistenciaActiva()) throw new Error('Persistencia desactivada (falta SPREADSHEET_ID)');
  cache.del('fudo_raw'); // forzar datos frescos de Fudo
  const raw = await loadRaw();
  const detalles = buildDetalles(raw);
  const detalle = detalles[fecha];
  if (!detalle) throw new Error(`Fudo no tiene ventas para el día de servicio ${fecha}`);

  const hist = await loadHistorico();
  const sheetsApi = getSheetsClient();
  await ensureHistSheet(sheetsApi);
  const row = [fecha, new Date().toISOString(), detalle.ventas, detalle.pax, detalle.total, detalle.propinas || 0, JSON.stringify(detalle)];
  if (hist[fecha]) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HIST_SHEET}!A${hist[fecha].rowIndex}:G${hist[fecha].rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  } else {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HIST_SHEET}!A:G`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  }
  cache.del('fudo_hist');
  return detalle;
}

// Rehace TODOS los snapshots guardados con el cálculo actual (útil tras corregir
// la fórmula de montos). Devuelve cuántos días se regeneraron.
async function resnapshotTodos() {
  if (!persistenciaActiva()) throw new Error('Persistencia desactivada (falta SPREADSHEET_ID)');
  cache.del('fudo_raw');
  const raw = await loadRaw();
  const detalles = buildDetalles(raw);
  const hist = await loadHistorico();
  const sheetsApi = getSheetsClient();
  await ensureHistSheet(sheetsApi);

  const fechas = Object.keys(hist).sort();
  const data = [];
  const regenerados = [], faltantes = [];
  for (const fecha of fechas) {
    const d = detalles[fecha];
    if (!d) { faltantes.push(fecha); continue; } // Fudo ya no tiene ese día (no lo tocamos)
    const row = [fecha, new Date().toISOString(), d.ventas, d.pax, d.total, d.propinas || 0, JSON.stringify(d)];
    data.push({ range: `${HIST_SHEET}!A${hist[fecha].rowIndex}:G${hist[fecha].rowIndex}`, values: [row] });
    regenerados.push(fecha);
  }
  // batchUpdate en lotes de 100 rangos
  for (let i = 0; i < data.length; i += 100) {
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: data.slice(i, i + 100) },
    });
  }
  cache.del('fudo_hist');
  return { regenerados: regenerados.length, faltantes, fechas: regenerados };
}

// ─── Resumen de servicios por día ──────────────────────────────────────────────
// Histórico desde la hoja; Fudo solo para días posteriores al último snapshot.
async function getServicios({ desde, hasta } = {}) {
  const dDesde = desde || null;
  const dHasta = hasta || null;
  const hoyServ = fechaServicioHoy();

  const hist = await loadHistorico();
  const fechasHist = Object.keys(hist).sort();
  const maxHist = fechasHist[fechasHist.length - 1] || null;

  // ¿Hace falta Fudo? Solo si el rango pedido puede incluir días sin snapshot
  // (posteriores al último guardado). Sin histórico, siempre.
  const necesitaFudo = !maxHist || !dHasta || dHasta > maxHist;

  let frescos = {};
  if (necesitaFudo) {
    try {
      const raw = await loadRaw();
      frescos = buildDetalles(raw);
      // Snapshot de días finalizados que aún no están guardados
      const nuevos = Object.values(frescos)
        .filter(d => d.fecha < hoyServ && !hist[d.fecha])
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
      if (nuevos.length) await persistDias(nuevos);
    } catch (e) {
      // Fudo caído/limitado: servir solo histórico si existe
      if (!fechasHist.length) throw e;
      console.warn('Fudo no disponible, sirviendo solo histórico:', e.message);
    }
  }

  // Merge: el snapshot guardado MANDA para sus fechas; lo fresco cubre el resto.
  const dias = {};
  for (const [fecha, d] of Object.entries(frescos)) {
    if (!hist[fecha]) dias[fecha] = d;
  }
  for (const [fecha, h] of Object.entries(hist)) {
    dias[fecha] = h.detalle;
  }

  return Object.values(dias)
    .filter(d => (!dDesde || d.fecha >= dDesde) && (!dHasta || d.fecha <= dHasta))
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
    .map(resumenDeDetalle);
}

// ─── Detalles completos de todos los días (para análisis de stock) ─────────────
// Igual que getServicios pero devuelve el detalle COMPLETO (productos por categoría)
// de cada día, no el resumen. Lo usa el módulo de stocks para rastrear ventas de un
// producto a lo largo del tiempo.
// Detalles FRESCOS directo de Fudo (sin snapshots históricos). Para análisis de
// Costos donde necesitamos el cálculo actual aplicado a todo el rango, ignorando
// snapshots viejos que puedan tener montos de una fórmula anterior.
async function getDetallesFrescos({ desde, hasta } = {}) {
  let frescos = {};
  try {
    const raw = await loadRaw();
    frescos = buildDetalles(raw);
  } catch (e) {
    // Si Fudo no responde, como último recurso usar histórico (mejor algo que nada)
    const hist = await loadHistorico();
    for (const [fecha, h] of Object.entries(hist)) frescos[fecha] = h.detalle;
  }
  return Object.values(frescos)
    .filter(d => (!desde || d.fecha >= desde) && (!hasta || d.fecha <= hasta))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

async function getDetallesTodos({ desde, hasta } = {}) {
  const dDesde = desde || null;
  const dHasta = hasta || null;
  const hoyServ = fechaServicioHoy();

  const hist = await loadHistorico();
  const fechasHist = Object.keys(hist).sort();
  const maxHist = fechasHist[fechasHist.length - 1] || null;
  const necesitaFudo = !maxHist || !dHasta || dHasta > maxHist;

  let frescos = {};
  if (necesitaFudo) {
    try {
      const raw = await loadRaw();
      frescos = buildDetalles(raw);
    } catch (e) {
      if (!fechasHist.length) throw e;
      console.warn('Fudo no disponible (stocks), uso histórico:', e.message);
    }
  }

  const dias = {};
  for (const [fecha, d] of Object.entries(frescos)) if (!hist[fecha]) dias[fecha] = d;
  for (const [fecha, h] of Object.entries(hist)) dias[fecha] = h.detalle;

  return Object.values(dias)
    .filter(d => (!dDesde || d.fecha >= dDesde) && (!dHasta || d.fecha <= dHasta))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ─── Detalle de un servicio (un día) ───────────────────────────────────────────
async function getServicioDetalle(fecha) {
  const hist = await loadHistorico();
  if (hist[fecha]) {
    return { ...hist[fecha].detalle, origen: 'historico' };
  }

  const raw = await loadRaw();
  const detalles = buildDetalles(raw);
  const detalle = detalles[fecha];
  if (!detalle) return { fecha, encontrado: false };

  // Si el día ya terminó, dejarlo guardado para no volver a depender de Fudo
  if (fecha < fechaServicioHoy()) await persistDias([detalle]);
  return { ...detalle, origen: 'fudo' };
}

// ─── Diagnóstico: venta por venta de un día ────────────────────────────────────
// Compara el total de cada venta contra la suma de sus pagos para encontrar
// diferencias (propinas, ajustes). Incluye también las ventas excluidas ($0).
async function getServicioDebug(fecha) {
  cache.del('fudo_raw'); // diagnóstico siempre con datos frescos
  const raw = await loadRaw();
  const { sales, paymentsBySale } = raw;

  const ventas = [];
  for (const s of sales) {
    const a = s.attributes || {};
    if (a.saleState !== 'CLOSED' || !a.closedAt) continue;
    if (fechaServicio(a.closedAt) !== fecha) continue;
    const pays = paymentsBySale[s.id] || [];
    const pagado = pays.reduce((sum, p) => sum + p.amount, 0);
    ventas.push({
      id: s.id,
      createdAt: a.createdAt || null,
      closedAt: a.closedAt,
      personas: a.people || 0,
      total: a.total || 0,
      pagado,
      diferencia: Math.round((pagado - (a.total || 0)) * 100) / 100,
      pagos: pays,
      excluida: !ventaComputable(a),
      motivoExclusion: !ventaComputable(a) ? 'total $0' : null,
    });
  }
  ventas.sort((a, b) => (a.closedAt || '').localeCompare(b.closedAt || ''));

  const computables = ventas.filter(v => !v.excluida);
  return {
    fecha,
    ventasListadas: ventas.length,
    ventasComputables: computables.length,
    ventasExcluidas: ventas.length - computables.length,
    pax: computables.reduce((s, v) => s + v.personas, 0),
    totalVentas: computables.reduce((s, v) => s + v.total, 0),
    totalPagado: computables.reduce((s, v) => s + v.pagado, 0),
    propinas: computables.reduce((s, v) => s + (v.diferencia > 0 ? v.diferencia : 0), 0),
    ventas,
  };
}

// ─── Agregado de productos/categorías sobre un rango (multi-día) ─────────────────
// Suma todas las ventas por categoría y por producto en el período, para responder
// "¿se vendió más PARA COMER o PARA PICAR en general?" sin entrar día por día.
async function getAgregadoProductos({ desde, hasta } = {}) {
  const detalles = await getDetallesTodos({ desde, hasta });

  const categorias = {}; // nombre -> { categoria, grupo, monto, unidades, productos:{} }
  let totalMonto = 0, totalUnidades = 0;
  let comida = 0, bebida = 0, otros = 0;
  const dias = new Set();

  for (const dia of detalles) {
    if (dia && dia.fecha) dias.add(dia.fecha);
    for (const cat of (dia.categorias || [])) {
      const c = categorias[cat.categoria] = categorias[cat.categoria] || {
        categoria: cat.categoria, grupo: cat.grupo || grupoDeCategoria(cat.categoria),
        monto: 0, unidades: 0, productos: {},
      };
      c.monto += cat.monto || 0;
      c.unidades += cat.unidades || 0;
      totalMonto += cat.monto || 0;
      totalUnidades += cat.unidades || 0;
      if (c.grupo === 'comida') comida += cat.monto || 0;
      else if (c.grupo === 'bebida') bebida += cat.monto || 0;
      else otros += cat.monto || 0;
      for (const p of (cat.productos || [])) {
        const pp = c.productos[p.nombre] = c.productos[p.nombre] || { nombre: p.nombre, monto: 0, unidades: 0 };
        pp.monto += p.monto || 0;
        pp.unidades += p.unidades || 0;
      }
    }
  }

  const categoriasArr = Object.values(categorias)
    .map(c => ({
      categoria: c.categoria, grupo: c.grupo,
      monto: Math.round(c.monto), unidades: c.unidades,
      productos: Object.values(c.productos).sort((a, b) => b.unidades - a.unidades),
    }))
    .sort((a, b) => {
      const ord = { comida: 0, bebida: 1, otros: 2 };
      return (ord[a.grupo] - ord[b.grupo]) || (b.unidades - a.unidades);
    });

  // Top productos global (todas las categorías)
  const topProductos = [];
  for (const c of categoriasArr) for (const p of c.productos) topProductos.push({ ...p, categoria: c.categoria, grupo: c.grupo });
  topProductos.sort((a, b) => b.unidades - a.unidades);

  const baseCB = comida + bebida;
  return {
    desde: desde || null, hasta: hasta || null,
    diasConVentas: dias.size,
    totalMonto: Math.round(totalMonto), totalUnidades,
    comida: Math.round(comida), bebida: Math.round(bebida), otros: Math.round(otros),
    pctComida: baseCB > 0 ? Math.round((comida / baseCB) * 1000) / 10 : 0,
    pctBebida: baseCB > 0 ? Math.round((bebida / baseCB) * 1000) / 10 : 0,
    categorias: categoriasArr,
    topProductos: topProductos.slice(0, 50),
  };
}

// ─── Diagnóstico por producto: cada línea de venta con quantity y price crudos ──
// Para auditar de dónde sale el ingreso de un producto. nombre = substring (case-insensitive).
async function getProductoDebug(nombre, { desde, hasta } = {}) {
  const raw = await loadRaw();
  const { sales, prod, itemsBySale } = raw;
  const needle = (nombre || '').toLowerCase();
  const lineas = [];
  let totalUnidades = 0, totalMonto = 0;
  for (const s of sales) {
    const a = s.attributes || {};
    if (!ventaComputable(a)) continue;
    const fecha = fechaServicio(a.closedAt);
    if (desde && fecha < desde) continue;
    if (hasta && fecha > hasta) continue;
    for (const it of (itemsBySale[s.id] || [])) {
      if (it.attributes && it.attributes.canceled) continue;
      const pRel = it.relationships && it.relationships.product && it.relationships.product.data;
      const producto = pRel ? prod[pRel.id] : null;
      const pname = producto ? producto.name : 'Producto';
      if (needle && !pname.toLowerCase().includes(needle)) continue;
      const q = (it.attributes && it.attributes.quantity) || 0;
      const priceLinea = it.attributes ? it.attributes.price : null;
      const monto = montoItem(it, producto);
      totalUnidades += q; totalMonto += monto;
      lineas.push({
        fecha, ventaId: s.id, producto: pname,
        precioListaProducto: producto ? producto.price : null,
        quantity: q,
        priceLineaFudo: priceLinea,            // lo que trae Fudo en item.price
        montoComputado: monto,                 // lo que usamos como ingreso
        unitarioImplicito: q > 0 ? Math.round((monto / q) * 100) / 100 : null,
      });
    }
  }
  lineas.sort((a, b) => (a.fecha||'').localeCompare(b.fecha||''));
  return { nombre, desde: desde||null, hasta: hasta||null, totalUnidades, totalMonto: Math.round(totalMonto), lineas };
}

// Diagnóstico CRUDO: para una venta, devuelve sus items tal como vienen de Fudo,
// y cuántos items totales se trajeron. Para detectar items faltantes/no agrupados.
async function getVentaDebugCrudo(ventaId) {
  cache.del('fudo_raw');
  const raw = await loadRaw();
  const { sales, prod, itemsBySale } = raw;
  const totalItems = Object.values(itemsBySale).reduce((s, arr) => s + arr.length, 0);
  const totalVentas = sales.length;
  const items = (itemsBySale[ventaId] || []).map(it => {
    const a = it.attributes || {};
    const pRel = it.relationships && it.relationships.product && it.relationships.product.data;
    const producto = pRel ? prod[pRel.id] : null;
    return {
      itemId: it.id,
      productId: pRel ? pRel.id : null,
      productoNombre: producto ? producto.name : '(sin product)',
      quantity: a.quantity,
      price: a.price,
      canceled: a.canceled || false,
    };
  });
  const venta = sales.find(s => s.id === ventaId);
  return {
    ventaId,
    ventaExiste: !!venta,
    ventaTotal: venta ? (venta.attributes && venta.attributes.total) : null,
    ventaState: venta ? (venta.attributes && venta.attributes.saleState) : null,
    itemsDeEstaVenta: items.length,
    items,
    _meta: { totalVentasTraidas: totalVentas, totalItemsTraidos: totalItems },
  };
}

function clearFudoCache() {
  cache.del('fudo_raw');
  cache.del('fudo_hist');
}

module.exports = {
  getServicios, getServicioDetalle, getServicioDebug, resnapshotDia, resnapshotTodos,
  getDetallesTodos, getDetallesFrescos, getAgregadoProductos, getProductoDebug, getVentaDebugCrudo,
  clearFudoCache, grupoDeCategoria, fechaServicio, fechaServicioHoy,
};
