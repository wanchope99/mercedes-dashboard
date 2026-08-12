// ─── Tipo de cambio ARS/USD en vivo (dólar blue) ────────────────────────────────
//
// El ARS/USD se mueve rápido, así que NUNCA asumimos un valor fijo: se consulta en
// vivo contra dolarapi.com (dólar blue). Se usa para (a) prellenar el TC al cerrar
// un mes y (b) valuar hoy la brecha de recupero de inversión (ver roi.js).
//
// Si la consulta online falla, se cae con gracia al TC_DEFAULT de cierres.js y se
// marca { stale: true } para que la UI avise, pero nunca bloquea.
//
// Cache: 10 min en memoria (el blue no cambia intradía tanto como para consultarlo
// en cada request).

const NodeCache = require('node-cache');
const { TC_DEFAULT } = require('./cierres');

const cache = new NodeCache({ stdTTL: 600 });
const CACHE_KEY = 'dolar_blue';
const URL = 'https://dolarapi.com/v1/dolares/blue';

// Devuelve { compra, venta, promedio, fecha, fuente, stale }.
// `tc` (helper) = venta, el valor de trabajo para conversiones.
async function getDolarBlue() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const compra = Number(j.compra) || 0;
    const venta = Number(j.venta) || 0;
    const promedio = compra && venta ? Math.round((compra + venta) / 2) : (venta || compra);
    const out = {
      compra,
      venta,
      promedio,
      tc: venta || promedio || TC_DEFAULT,
      fecha: j.fechaActualizacion || new Date().toISOString(),
      fuente: 'dolarapi/blue',
      stale: false,
    };
    cache.set(CACHE_KEY, out);
    return out;
  } catch (e) {
    // Fallback: no rompemos el flujo, marcamos stale para que la UI avise.
    return {
      compra: 0,
      venta: TC_DEFAULT,
      promedio: TC_DEFAULT,
      tc: TC_DEFAULT,
      fecha: new Date().toISOString(),
      fuente: 'fallback/TC_DEFAULT',
      stale: true,
      error: e.message,
    };
  }
}

// ─── Serie histórica del blue ───────────────────────────────────────────────────
//
// getDolarBlue() sólo sabe el valor de HOY, y para valuar en dólares hace falta el
// de CADA día: una fila de mayo se convierte al blue de mayo, no al de hoy. Sumar
// esas conversiones da plata a valor constante, que es el único total comparable
// entre meses con esta inflación.
//
// Fuente: api.argentinadatos.com, la hermana de dolarapi (misma familia). Devuelve
// la serie COMPLETA en una sola llamada — unos 5.700 días desde 2011, ~500 KB — así
// que se pide una vez y se indexa en memoria, en vez de una request por fecha.
//
// Se usa `venta` para todo, igual que el `tc` de getDolarBlue. Una sola regla, y
// dicha: mezclar compra para ingresos y venta para gastos daría un resultado que
// nadie puede reproducir a mano.
const URL_HISTORICO = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/blue';
const CACHE_KEY_HIST = 'blue_historico';
const HIST_TTL = 6 * 3600;   // 6 h: la serie sólo crece de a un día

async function getSerieBlue() {
  const cached = cache.get(CACHE_KEY_HIST);
  if (cached) return cached;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(URL_HISTORICO, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`Serie histórica del blue: HTTP ${res.status}`);

  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('Serie histórica del blue vacía');

  // { 'AAAA-MM-DD': venta } + las fechas ordenadas, para resolver los días sin
  // cotización con la última anterior.
  const porFecha = new Map();
  for (const d of arr) {
    const v = Number(d.venta) || Number(d.compra) || 0;
    if (d.fecha && v > 0) porFecha.set(d.fecha, v);
  }
  const fechas = [...porFecha.keys()].sort();
  const serie = { porFecha, fechas, desde: fechas[0], hasta: fechas[fechas.length - 1] };
  cache.set(CACHE_KEY_HIST, serie, HIST_TTL);
  return serie;
}

// Búsqueda binaria de la última fecha <= objetivo.
function ultimaFechaHasta(fechas, objetivo) {
  let lo = 0, hi = fechas.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fechas[mid] <= objetivo) { r = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return r >= 0 ? fechas[r] : null;
}

// Cotización de una fecha 'AAAA-MM-DD'.
//
// El blue no cotiza sábados, domingos ni feriados. La regla es EXPLÍCITA y viaja
// en la respuesta: se usa la última cotización anterior disponible, y se informa
// de qué día salió. Un sábado vale lo del viernes; inventarle un valor propio, o
// dejarlo en cero, serían las dos formas de mentir acá.
//
// Devuelve { tc, fecha, fechaCotizacion, exacta } o null si la fecha es anterior
// al inicio de la serie.
async function getBlueDeFecha(fechaISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO || '')) return null;
  const serie = await getSerieBlue();

  const exacto = serie.porFecha.get(fechaISO);
  if (exacto) return { tc: exacto, fecha: fechaISO, fechaCotizacion: fechaISO, exacta: true };

  const previa = ultimaFechaHasta(serie.fechas, fechaISO);
  if (!previa) return null;
  return { tc: serie.porFecha.get(previa), fecha: fechaISO, fechaCotizacion: previa, exacta: false };
}

// Varias fechas de una sola vez, con UNA sola descarga de la serie.
async function getBlueDeFechas(fechasISO) {
  const out = new Map();
  for (const f of new Set(fechasISO)) {
    const r = await getBlueDeFecha(f);
    if (r) out.set(f, r);
  }
  return out;
}

function clearCache() { cache.del(CACHE_KEY); cache.del(CACHE_KEY_HIST); }

module.exports = { getDolarBlue, getSerieBlue, getBlueDeFecha, getBlueDeFechas, clearCache };
