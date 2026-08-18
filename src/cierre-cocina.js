// ─── Cierre de cocina: qué comprar y qué producir ───────────────────────────
//
// Al cerrar cada servicio, Pablo anota en una planilla dos cosas: qué falta
// comprar y qué hay que producir mañana. Este módulo trae esa planilla a la app
// para que el marcado se haga desde el teléfono y quede una foto por servicio.
//
// Se llama "cierre-cocina" y no "stock" a propósito: ya hay tres módulos usando
// esa palabra para tres cosas distintas —`stocks.js` es rotación teórica,
// `stock-bebidas.js` es el snapshot diario de Fudo y `vinos.js` es el stock real
// de bebidas—. Este dice cuándo pasa y de quién es.
//
// ─── El límite de propiedad, que es la regla más importante de acá ──────────
//
// La planilla es de Pablo y él la sigue editando. Dentro de ella hay dos zonas:
//
//   · SUS hojas (Mercadería, Insumos, Checklist produ, Checklist seteo): se
//     leen enteras, y sólo se escribe en la columna `Estado` y en columnas
//     propias agregadas AL FINAL. Nunca se toca una columna que ya estaba con
//     otra cosa, y nunca se escribe la fila entera: `pedidos` y `mantenimiento`
//     actualizan filas completas porque son dueños de esas filas; acá no lo
//     somos.
//   · LAS NUESTRAS (Cierre Cocina, Cierre Cocina Detalle): auto-creadas,
//     append-only, son el historial.
//
// `Checklist seteo` no recibe ninguna columna: es la referencia de qué se setea
// en cada plaza, se consulta y no se tilda.
//
// ─── Dos trampas de esta planilla en particular ─────────────────────────────
//
// 1. EN `Checklist produ` LOS HEADERS ESTÁN CORRIDOS RESPECTO DE LOS DATOS.
//    El header dice ["Plato","Stock x día","","Produ (un)","","PERSO:"] pero los
//    datos son [plato, stock, produ, componente, estado, perso] — o sea que
//    "Produ (un)" cae encima de la columna del componente. Es lo que pasa
//    cuando hay celdas combinadas. Por eso el mapeo de acá abajo manda por
//    POSICIÓN y el nombre del header se usa sólo para darse cuenta de que la
//    hoja cambió de forma. Resolver por nombre leería los componentes de la
//    columna equivocada.
//
// 2. LAS DOS CHECKLISTS ESTÁN AGRUPADAS CON FILAS EN BLANCO: el plato va en la
//    primera fila y las siguientes lo dejan vacío. Es una convención visual, no
//    una estructura, así que hay que rellenar hacia abajo al leer. Y el orden
//    de las filas lleva la intención de quien las escribió: no se reordena ni
//    se compacta nunca.
//
// La columna `Produ (un)` son fórmulas y varias están rotas con #REF!. Se leen
// como vacío y no se tocan jamás.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

// Sin fallback a SPREADSHEET_ID, igual que NOMINA_SHEET_ID: con fallback, la app
// empezaría a crear hojas y a escribir columnas dentro de Gestión Mercedes.
const SHEET_ID = process.env.STOCKS_SHEET_ID || null;

const cache = new NodeCache({ stdTTL: 300 });

// ─── Los estados ────────────────────────────────────────────────────────────
// Cuatro, y cada uno dice qué hacer. `sinTocar` no es un estado que alguien
// elija: es la ausencia de respuesta, y por eso es el default.
const ESTADOS = ['ok', 'hacer', 'pedido', 'dudoso'];
const SIN_TOCAR = 'sinTocar';

// ─── El mapeo, en un solo lugar ─────────────────────────────────────────────
// `col` es la posición y es la autoridad. `header` es lo que esperamos leer en
// la fila 1 y sirve únicamente para avisar que la hoja cambió de forma — ver la
// trampa 1 del encabezado.
const SOLAPAS = [
  {
    id: 'produ',
    label: '👨‍🍳 Producir',
    hoja: process.env.CC_HOJA_PRODU || 'Checklist produ',
    forma: 'agrupada',
    soloAdmin: false,
    escribible: true,
    cols: { grupo: 0, nombre: 3, estado: 4 },
    headers: { grupo: 'Plato' },
    etiquetaGrupo: 'Plato',
  },
  {
    id: 'comprar',
    label: '🛒 Comprar',
    hoja: process.env.CC_HOJA_MERCADERIA || 'Mercadería',
    forma: 'plana',
    soloAdmin: true,
    escribible: true,
    cols: { grupo: 0, nombre: 1, estado: 2 },
    headers: { grupo: 'Categoría', nombre: 'Ingrediente', estado: 'Estado' },
    etiquetaGrupo: 'Categoría',
  },
  {
    id: 'insumos',
    label: '🧴 Insumos',
    hoja: process.env.CC_HOJA_INSUMOS || 'Insumos',
    forma: 'plana',
    soloAdmin: true,
    escribible: true,
    // La hoja tiene sólo Categoría e Item: la columna de Estado NO existe
    // todavía y la crea la app. Hasta entonces se lee vacía, que es
    // exactamente "sin tocar".
    cols: { grupo: 0, nombre: 1, estado: 2 },
    headers: { grupo: 'Categoría', nombre: 'Item' },
    etiquetaGrupo: 'Categoría',
  },
  {
    id: 'seteo',
    label: '📋 Seteo',
    hoja: process.env.CC_HOJA_SETEO || 'Checklist seteo',
    forma: 'agrupada',
    soloAdmin: false,
    // De consulta: la app no le escribe una sola celda.
    escribible: false,
    cols: { grupo: 0, nombre: 1, extra: 2 },
    headers: { grupo: 'Plato', nombre: 'Seteo', extra: 'Plaza' },
    etiquetaGrupo: 'Plato',
    etiquetaExtra: 'Plaza',
  },
];

const solapaDe = id => SOLAPAS.find(s => s.id === id) || null;

// ─── Puras ──────────────────────────────────────────────────────────────────
const txt = v => (v == null ? '' : String(v)).trim();
const norm = s => txt(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

// Los #REF! y demás errores de fórmula se leen como vacío. Nunca son un dato.
const esError = v => /^#(REF|VALUE|DIV\/0|N\/A|NAME\?|NUM|NULL)!?/i.test(txt(v));
const celda = v => (esError(v) ? '' : txt(v));

// ─── El parser de lo que ya está escrito ────────────────────────────────────
//
// Hoy el estado y el comentario viven juntos en texto libre: "comprar 10kg",
// "entra martes 18 meli", "hacer (gri)", "ok quedan 2". Esto los separa para no
// arrancar de cero, pero NO es una migración: la planilla no se reescribe, y lo
// que no reconoce NO se descarta ni se adivina — cae en `dudoso` con el texto
// entero como comentario, que es visible y se corrige de un toque.
//
// Los prefijos salen de mirar los 29 textos distintos que hay hoy en las dos
// hojas. Un verbo que no está en esta lista es deliberadamente `dudoso`: es
// preferible que alguien mire "reducir" y lo confirme a que el sistema decida
// por su cuenta que era trabajo pendiente.
const PREFIJOS = [
  [/^ok\b/i, 'ok'],
  [/^(comprar|pedir|falta|encargar)\b/i, 'hacer'],
  [/^(entra|entro|entró|viene|llega|pedido|en camino)\b/i, 'pedido'],
  [/^hacer\b/i, 'hacer'],
];

function parsearEstado(valor) {
  const s = celda(valor);
  if (!s) return { estado: SIN_TOCAR, comentario: '' };
  if (/^\?+$/.test(s)) return { estado: 'dudoso', comentario: '' };
  for (const [re, estado] of PREFIJOS) {
    const m = s.match(re);
    if (!m) continue;
    return { estado, comentario: s.slice(m[0].length).replace(/^[\s:·,-]+/, '').trim() };
  }
  return { estado: 'dudoso', comentario: s };
}

// Rellena el grupo hacia abajo: en las checklists el plato va sólo en la primera
// fila y las siguientes lo dejan en blanco (trampa 2 del encabezado).
function leerFilas(filas, solapa) {
  const { cols, forma } = solapa;
  const out = [];
  let grupoActual = '';
  for (let i = 1; i < (filas || []).length; i++) {
    const f = filas[i] || [];
    const grupo = celda(f[cols.grupo]);
    if (grupo) grupoActual = grupo;
    const nombre = celda(f[cols.nombre]);
    if (!nombre) continue;
    const item = {
      grupo: forma === 'agrupada' ? grupoActual : (grupo || grupoActual),
      nombre,
      orden: out.length,
      rowIndex: i + 1,
    };
    if (cols.estado != null) Object.assign(item, parsearEstado(f[cols.estado]));
    else Object.assign(item, { estado: SIN_TOCAR, comentario: '' });
    if (cols.extra != null) item.extra = celda(f[cols.extra]);
    out.push(item);
  }
  return out;
}

// Filas que tienen algo escrito en la columna de estado pero ningún ítem al
// lado. Al 17/8/2026 hay dos al final de `Checklist produ` ("++ Vieiras",
// "++ Cambiar olla y grasa"): alguien anotó ahí algo que quería que se hiciera,
// sin colgarlo de un plato.
//
// No se convierten en ítems —no sabríamos de qué plato son ni cómo marcarlas—
// pero tampoco se tiran: se muestran como aviso. Que la app coma en silencio
// algo que una persona escribió a mano es exactamente cómo se pierde la
// confianza en que la pantalla dice lo mismo que la planilla.
function notasSueltas(filas, solapa) {
  const { cols } = solapa;
  if (cols.estado == null) return [];
  const out = [];
  for (let i = 1; i < (filas || []).length; i++) {
    const f = filas[i] || [];
    if (celda(f[cols.nombre])) continue;
    const suelta = celda(f[cols.estado]);
    if (suelta) out.push({ texto: suelta, rowIndex: i + 1 });
  }
  return out;
}

// La identidad de un ítem sin columna de id. Las hojas son chicas y curadas a
// mano, así que la clave natural alcanza — y cuando falla, falla a la vista.
// Un componente NO es único por nombre solo: "Filet de pesca" está bajo Crudo y
// bajo Pesca plancha, y son dos cosas que se producen por separado.
const claveDe = (solapaId, item) => `${solapaId}|${norm(item.grupo)}|${norm(item.nombre)}`;

// Claves repetidas: no se fusionan ni se descartan, se reportan. Que dos filas
// digan lo mismo es algo que un humano tiene que resolver en la planilla.
function duplicadosDe(items, solapaId) {
  const vistas = new Map();
  const dup = [];
  for (const it of items) {
    const k = claveDe(solapaId, it);
    if (vistas.has(k)) dup.push({ nombre: it.nombre, grupo: it.grupo, filas: [vistas.get(k), it.rowIndex] });
    else vistas.set(k, it.rowIndex);
  }
  return dup;
}

function resumenCierre(items) {
  const base = { total: (items || []).length, ok: 0, hacer: 0, pedido: 0, dudoso: 0, sinTocar: 0 };
  for (const it of items || []) base[it.estado] = (base[it.estado] || 0) + 1;
  return base;
}

// Los headers esperados contra los que están. No frena nada: la lectura manda
// por posición y esto sólo levanta la mano si la hoja cambió de forma.
function avisosDeHeaders(filas, solapa) {
  const cab = (filas || [])[0] || [];
  const avisos = [];
  for (const [campo, esperado] of Object.entries(solapa.headers || {})) {
    const col = solapa.cols[campo];
    if (col == null) continue;
    const real = celda(cab[col]);
    if (real && norm(real) !== norm(esperado)) {
      avisos.push(`La columna ${col + 1} de "${solapa.hoja}" dice "${real}" y se esperaba "${esperado}". Se sigue leyendo por posición.`);
    }
  }
  return avisos;
}

// ─── I/O ────────────────────────────────────────────────────────────────────
const configurada = () => Boolean(SHEET_ID);

function _sheets(soloLectura = true) {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const scopes = [soloLectura
    ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
    : 'https://www.googleapis.com/auth/spreadsheets'];
  return google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ credentials, scopes }) });
}

// Lectura cruda, SIN caché. Es la que se usa antes de escribir: nadie confía en
// un rowIndex cacheado para tocar una fila (misma regla que pedidos.js y
// mantenimiento.js).
async function _leer(solapa) {
  if (!configurada()) throw new Error('Falta STOCKS_SHEET_ID');
  const r = await _sheets().spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${solapa.hoja}!A1:Z1200`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  return r.data.values || [];
}

async function leerSolapa(solapaId) {
  const solapa = solapaDe(solapaId);
  if (!solapa) throw new Error(`Solapa desconocida: ${solapaId}`);
  const filas = await _leer(solapa);
  const items = leerFilas(filas, solapa);
  const sueltas = notasSueltas(filas, solapa);
  const avisos = [
    ...avisosDeHeaders(filas, solapa),
    ...duplicadosDe(items, solapaId).map(d => `"${d.nombre}" está repetido (filas ${d.filas.join(' y ')})`),
    ...(sueltas.length
      ? [`${sueltas.length === 1 ? 'Hay una nota suelta' : `Hay ${sueltas.length} notas sueltas`} en "${solapa.hoja}", sin ítem al lado: ${sueltas.map(s => `"${s.texto}" (fila ${s.rowIndex})`).join(' · ')}`]
      : []),
  ];
  return { items, sueltas, avisos };
}

const _cacheKey = id => `solapa:${id}`;

async function leerSolapaCacheada(solapaId) {
  const hit = cache.get(_cacheKey(solapaId));
  if (hit) return hit;
  const out = await leerSolapa(solapaId);
  cache.set(_cacheKey(solapaId), out);
  return out;
}

// ─── Lo que ve la pantalla ──────────────────────────────────────────────────
//
// Devuelve SÓLO las solapas que ese rol puede ver. El encargado no recibe
// `comprar` ni `insumos`: no es que se le escondan en el browser, es que no
// están en la respuesta. La regla de la casa es que el que decide es el server.
async function estadoActual({ rol } = {}) {
  if (!configurada()) {
    return {
      configurada: false, solapas: [], hojas: {},
      avisos: ['La planilla de cierre de cocina no está configurada en el servidor.'],
    };
  }
  const esAdmin = rol === 'admin';
  const visibles = SOLAPAS.filter(s => esAdmin || !s.soloAdmin);

  const hojas = {};
  const avisos = [];
  await Promise.all(visibles.map(async (s) => {
    try {
      const { items, avisos: av } = await leerSolapaCacheada(s.id);
      hojas[s.id] = { items, resumen: resumenCierre(items) };
      avisos.push(...av);
    } catch (e) {
      // Una hoja que no se puede leer no tira abajo las otras tres.
      hojas[s.id] = { items: [], resumen: resumenCierre([]), error: e.message };
      avisos.push(`No se pudo leer "${s.hoja}": ${e.message}`);
    }
  }));

  return {
    configurada: true,
    solapas: visibles.map(s => ({
      id: s.id, label: s.label, hoja: s.hoja, forma: s.forma,
      escribible: s.escribible,
      etiquetaGrupo: s.etiquetaGrupo, etiquetaExtra: s.etiquetaExtra || null,
      estados: s.escribible ? ESTADOS : [],
    })),
    hojas,
    avisos,
  };
}

function clearCache() { cache.flushAll(); }

module.exports = {
  // I/O
  estadoActual, leerSolapa, leerSolapaCacheada, clearCache, configurada,
  // Puras — se ejercitan sin red
  parsearEstado, leerFilas, notasSueltas, claveDe, duplicadosDe, resumenCierre, avisosDeHeaders,
  norm, celda, esError,
  // Constantes
  SOLAPAS, ESTADOS, SIN_TOCAR, solapaDe,
};
