// ─── Qué proveedor trae cada bebida ────────────────────────────────────────────
//
// Fudo no guarda el proveedor de un producto: sabe que hay 9 botellas de El Beppe
// Criolla, no a quién se le compran. La hoja `Proveedores` tiene los 40
// proveedores pero ninguna fila dice qué producto trae cada uno. Este módulo es
// el puente que faltaba, y existe para una pregunta concreta de la barra: "de lo
// que se está por acabar, ¿qué le tengo que pedir a Aurea?".
//
// DOS CAPAS, Y LA DE ABAJO NO SE ESCRIBE (23/08/2026):
//
//   1. INFERENCIA — se cruzan los nombres de los productos de Fudo contra la hoja
//      `Compras` (planilla Comparación Proveedores), que sí tiene proveedor por
//      renglón. Se calcula al vuelo y se cachea; NO se persiste. Un nombre que
//      matchea hoy y mañana no, o al revés, no deja basura en ninguna hoja.
//
//   2. CORRECCIÓN MANUAL — lo que alguien elige a mano en la pantalla, guardado
//      en la hoja `Bebidas Proveedor`. Siempre gana sobre la inferencia, incluso
//      cuando la corrección es "ninguno": una fila con proveedor vacío es una
//      decisión ("esto no lo trae nadie de la lista"), no un hueco, y por eso
//      apaga la inferencia para ese producto en vez de dejar que vuelva sola.
//
// Cada valor viaja con su `origen` para que la pantalla pueda mostrar distinto lo
// que alguien confirmó de lo que adivinó una heurística de nombres. Un proveedor
// inferido que nadie miró NO es un dato confirmado y no debe parecerlo.
//
// Columnas de la hoja `Bebidas Proveedor` (se crea sola al primer uso):
//   A ProductoID (el de Fudo) · B Producto · C Proveedor · D Origen · E Actualizado
//
// El ID de Fudo es la clave, no el nombre: renombrar un vino en Fudo (pasa: se le
// agrega la cosecha) no tiene por qué borrar a quién se le compra. B es para poder
// leer la hoja a ojo.

const NodeCache = require('node-cache');
const { google } = require('googleapis');
const provConfig = require('./proveedores-config');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.BEBIDAS_PROVEEDOR_SHEET || 'Bebidas Proveedor';
const HEADER = ['ProductoID', 'Producto', 'Proveedor', 'Origen', 'Actualizado'];

const cache = new NodeCache({ stdTTL: 300 });

function sheetsClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── Normalización de nombres para comparar ────────────────────────────────────
// Saca acentos, cosechas (2019…2029), formatos (750 ml, x6, botella) y las
// palabras que no distinguen nada. Lo que queda es lo que hace único a un vino.
const RUIDO = new Set([
  'vino', 'vinos', 'botella', 'botellas', 'bot', 'caja', 'cajas', 'unidad',
  'unidades', 'ml', 'cc', 'lt', 'lts', 'litro', 'litros', 'uds',
]);

function limpiar(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, ' ')       // cosechas
    .replace(/\bx\s?\d+\b/g, ' ')            // x6, x12
    .replace(/\b\d+\s?(ml|cc|lt|lts|l)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')             // NFD ya bajó la ñ a n
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s) {
  return limpiar(s).split(' ').filter(t => t.length >= 3 && !RUIDO.has(t));
}

function clave(s) {
  return tokens(s).join(' ');
}

// Puntaje 0-100 de cuánto se parecen dos nombres de producto.
function parecido(nombreFudo, nombreCompra) {
  const a = clave(nombreFudo);
  const b = clave(nombreCompra);
  if (!a || !b) return 0;
  if (a === b) return 100;

  // Uno contenido en el otro. Es el caso "El Beppe Criolla" vs "El Beppe Criolla
  // 2024", y también el falso positivo conocido: "Coca-Cola" se come el renglón
  // de "Coca-Cola Zero". Se acepta igual porque el resultado NO se guarda ni se
  // presenta como confirmado — sale en itálica y con el renglón de compra en el
  // tooltip, para que quien mira decida. Si algún día molesta, acá va el corte.
  const largo = Math.min(a.length, b.length);
  if (largo >= 8 && (a.includes(b) || b.includes(a))) return 85;

  const ta = tokens(nombreFudo);
  const tb = new Set(tokens(nombreCompra));
  const comunes = ta.filter(t => tb.has(t));
  if (comunes.length < 2) return 0;
  const cobertura = comunes.length / Math.min(ta.length, tb.size);
  return Math.round(Math.min(80, 70 * cobertura));
}

const UMBRAL = 60;

// ─── Capa 1: inferencia desde la hoja Compras ──────────────────────────────────
// Devuelve { [productoId]: { proveedor, score, via } } sólo para los que superan
// el umbral. Si la hoja Compras no está disponible (falta PROVEEDORES_SHEET_ID,
// por ejemplo) devuelve {} sin romper: la pantalla funciona igual, sin proveedor.
async function inferir(productos) {
  const cached = cache.get('inferencia');
  if (cached) return cached;

  let compras = [];
  try {
    // require diferido: proveedores.js lee otra planilla y no queremos que un
    // problema suyo impida cargar el módulo entero.
    compras = await require('./proveedores').getCompras();
  } catch (e) {
    console.warn('Bebidas Proveedor: no se pudo leer Compras para inferir:', e.message);
    cache.set('inferencia', {}, 60);
    return {};
  }

  // Sólo renglones que nombran algo y tienen proveedor. Se privilegian los de
  // categoría bebida, pero no se descartan los demás: una compra de vino mal
  // categorizada sigue diciendo la verdad sobre quién la trajo.
  const candidatos = compras
    .filter(c => c.proveedor && (c.producto || c.nombreMostrar))
    .map(c => ({
      proveedor: c.proveedor,
      nombre: c.nombreMostrar || c.producto,
      fecha: c.fecha || '',
      esBebida: /bebida|alcohol/i.test(c.categoria || ''),
    }));

  const out = {};
  for (const p of productos) {
    if (p.id == null) continue;
    let mejor = null;
    for (const c of candidatos) {
      const base = parecido(p.name, c.nombre);
      if (!base) continue;
      const score = Math.min(100, base + (c.esBebida ? 8 : 0));
      if (score < UMBRAL) continue;
      // Empate: gana la compra más reciente, que es la que dice quién lo trae HOY.
      if (!mejor || score > mejor.score || (score === mejor.score && c.fecha > mejor.fecha)) {
        mejor = { proveedor: c.proveedor, score, fecha: c.fecha, nombre: c.nombre };
      }
    }
    if (mejor) {
      out[String(p.id)] = {
        proveedor: mejor.proveedor,
        score: mejor.score,
        via: 'compra a ' + mejor.proveedor + (mejor.fecha ? ' del ' + mejor.fecha : '') + ' — «' + mejor.nombre + '»',
      };
    }
  }
  cache.set('inferencia', out);
  return out;
}

// ─── Capa 2: las correcciones a mano ───────────────────────────────────────────
async function ensureHoja(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOJA } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

// { [productoId]: { productoId, producto, proveedor, rowIndex } }
// `proveedor` puede ser '' y eso es un dato: alguien dijo que no lleva ninguno.
async function getMapaManual() {
  if (!SPREADSHEET_ID) return {};
  const cached = cache.get('manual');
  if (cached) return cached;

  const api = sheetsClient();
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:E`,
    });
    rows = res.data.values || [];
  } catch (e) {
    try { await ensureHoja(api); } catch (e2) {
      console.warn('Bebidas Proveedor: no se pudo crear la hoja:', e2.message);
    }
    rows = [];
  }

  const mapa = {};
  for (let i = 1; i < rows.length; i++) {  // i=0 es el header
    const r = rows[i];
    if (!r || !r[0]) continue;
    mapa[String(r[0]).trim()] = {
      productoId: String(r[0]).trim(),
      producto: (r[1] || '').toString().trim(),
      proveedor: (r[2] || '').toString().trim(),
      rowIndex: i + 1,
    };
  }
  cache.set('manual', mapa);
  return mapa;
}

// Guarda (o pisa) el proveedor de un producto. proveedor '' = "ninguno", que es
// una respuesta y no un vacío: la fila queda y apaga la inferencia.
async function setProveedor(productoId, producto, proveedor) {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID no configurado');
  const id = String(productoId || '').trim();
  if (!id) throw new Error('Falta el producto');

  const api = sheetsClient();
  await ensureHoja(api);
  const mapa = await getMapaManual();
  const fila = [id, (producto || '').toString().trim(), (proveedor || '').toString().trim(),
    'manual', new Date().toISOString()];

  const existente = mapa[id];
  if (existente) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A${existente.rowIndex}:E${existente.rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A:E`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  }
  cache.del('manual');
  return { productoId: id, proveedor: fila[2], origen: 'manual' };
}

// ─── Las dos capas resueltas ───────────────────────────────────────────────────
// { [productoId]: { proveedor, origen: 'manual'|'inferido'|null, via } }
async function resolver(productos) {
  const [manual, inferido] = await Promise.all([
    getMapaManual().catch(() => ({})),
    inferir(productos).catch(() => ({})),
  ]);

  const out = {};
  for (const p of productos) {
    if (p.id == null) continue;
    const id = String(p.id);
    if (manual[id]) {
      out[id] = { proveedor: manual[id].proveedor, origen: 'manual', via: null };
    } else if (inferido[id]) {
      out[id] = { proveedor: inferido[id].proveedor, origen: 'inferido', via: inferido[id].via };
    } else {
      out[id] = { proveedor: '', origen: null, via: null };
    }
  }
  return out;
}

// Nombres para el desplegable: los de la hoja Proveedores (la lista real del bar)
// más cualquiera que ya esté asignado a una bebida, por si alguno quedó fuera.
async function listaProveedores(asignados = []) {
  const nombres = new Set();
  try {
    const cfg = await provConfig.leerConfig();
    for (const p of Object.values(cfg.byNombre || {})) if (p.nombre) nombres.add(p.nombre);
  } catch (e) { /* sin hoja Proveedores, la lista sale de lo ya asignado */ }
  for (const n of asignados) if (n) nombres.add(n);
  return [...nombres].sort((a, b) => a.localeCompare(b, 'es'));
}

function clearCache() { cache.flushAll(); }

module.exports = { resolver, setProveedor, getMapaManual, inferir, listaProveedores, clearCache };
