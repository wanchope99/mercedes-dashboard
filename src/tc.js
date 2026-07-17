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

function clearCache() { cache.del(CACHE_KEY); }

module.exports = { getDolarBlue, clearCache };
