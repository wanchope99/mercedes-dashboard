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

// `dudoso` se muestra como "Ver", y "ver" sin decir QUÉ hay que ver no dice
// nada: al día siguiente alguien encuentra el ítem marcado y tiene que salir a
// preguntar. Así que en ese estado el comentario es obligatorio, y se exige acá
// además de en la pantalla — el navegador es una comodidad, la regla vive donde
// se escribe. En los otros tres es opcional: ahí la palabra ya alcanza, y pedir
// un texto para poder marcar cuarenta ítems en orden es garantizar que nadie
// los marque.
const ESTADOS_CON_COMENTARIO_OBLIGATORIO = ['dudoso'];

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
    // Una produccion no se 'pide': o se hace o no. Sin 'pedido'.
    estados: ['ok', 'hacer', 'dudoso'],
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
    estados: ['ok', 'hacer', 'pedido', 'dudoso'],
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
    estados: ['ok', 'hacer', 'pedido', 'dudoso'],
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
      estados: s.escribible ? (s.estados || ESTADOS) : [],
    })),
    hojas,
    avisos,
  };
}

// ─── Escritura ──────────────────────────────────────────────────────────────
//
// Dos destinos y son de naturaleza distinta:
//
//   · LAS HOJAS DE PABLO reciben el estado y el comentario de los ítems que
//     alguien tocó en este cierre. SÓLO ESOS. No se recorre la lista entera
//     normalizando todo: si lo hiciéramos, "comprar semana 17/8 (barcos?)" se
//     convertiría en un estado y un comentario prolijos en las 109 filas de una,
//     y eso es reescribir el documento de otro. Lo que no se tocó queda tal cual
//     está escrito.
//   · LAS HOJAS PROPIAS reciben la foto: append-only, inmutable, firmada.
//
// Y se escribe CELDA POR CELDA. `pedidos` y `mantenimiento` actualizan la fila
// completa porque son dueños de esas filas; acá cualquier columna que no sea
// nuestra puede tener una fórmula o algo que no leímos.
const HOJA_CIERRES = process.env.CC_HOJA_CIERRES || 'Cierre Cocina';
const HOJA_DETALLE = process.env.CC_HOJA_DETALLE || 'Cierre Cocina Detalle';
const HEADER_CIERRES = ['ID', 'Fecha Servicio', 'Firmado Por', 'Estado', 'Nota', 'Resumen', 'Guardado'];
const HEADER_DETALLE = ['CierreID', 'Hoja', 'Grupo', 'Item', 'Estado', 'Comentario', 'Hecho', 'Actualizado'];

// Los nombres de las columnas que la app agrega al final de las hojas de Pablo.
const COLS_APP = { estado: 'Estado', comentario: 'Comentario', actualizado: 'Actualizado' };

function colLetra(i) {
  let s = '', n = i;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

// Qué columna usa cada cosa, y cuáles hay que crear.
//
// `libre` es la primera columna que no tiene NADA, ni header ni un dato en
// ninguna fila. Reclamar sólo a partir de ahí es la única garantía de que no le
// pisamos una columna a nadie — es la lección de las columnas Q/R/S/T de la hoja
// Movimientos, donde dar por libre una columna ocupada costó caro.
function resolverColumnas(filas, solapa) {
  const cab = (filas || [])[0] || [];
  const porNombre = n => cab.findIndex(c => norm(c) === norm(n));

  let libre = 0;
  for (const f of (filas || [])) {
    for (let i = 0; i < (f || []).length; i++) if (celda(f[i])) libre = Math.max(libre, i + 1);
  }

  const nuevas = [];
  const asignar = (etiqueta, colDeclarada) => {
    // ¿La columna que declara el mapeo ya existe de verdad (tiene header o datos)?
    if (colDeclarada != null && colDeclarada < libre) return colDeclarada;
    // ¿Existe una columna con ese nombre puesta por la app en una corrida anterior?
    const porN = porNombre(etiqueta);
    if (porN >= 0) return porN;
    // Si no, se reclama la primera vacía de verdad.
    const col = libre++;
    nuevas.push({ col, nombre: etiqueta });
    return col;
  };

  return {
    estado: asignar(COLS_APP.estado, solapa.cols.estado),
    comentario: asignar(COLS_APP.comentario, null),
    actualizado: asignar(COLS_APP.actualizado, null),
    nuevas,
  };
}

// Una hoja de Google tiene un ancho de grilla, y no es infinito: `Checklist
// produ` viene con 6 columnas, así que escribir en la G falla con "exceeds grid
// limits" antes de tocar un solo dato. Hay que ensanchar la hoja primero.
//
// Es la única operación estructural que la app hace sobre una hoja de Pablo, y
// sólo agrega columnas vacías a la derecha: no mueve, no borra y no reordena
// nada de lo que ya está.
async function _asegurarAncho(api, hoja, colNecesaria) {
  const meta = await api.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
  const props = (meta.data.sheets || []).map(s => s.properties).find(p => p.title === hoja);
  if (!props) throw new Error(`No existe la hoja "${hoja}"`);
  const ancho = (props.gridProperties || {}).columnCount || 0;
  if (colNecesaria < ancho) return;
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        appendDimension: { sheetId: props.sheetId, dimension: 'COLUMNS', length: colNecesaria - ancho + 1 },
      }],
    },
  });
}

async function _ensureHojaPropia(api, titulo, header) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${titulo}!A1:${colLetra(header.length - 1)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

async function _leerHojaPropia(api, titulo) {
  try {
    const r = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${titulo}!A:H` });
    return r.data.values || [];
  } catch (e) {
    // Todavía no existe: es el estado normal antes del primer cierre.
    if (/unable to parse range/i.test(e.message || '')) return [];
    throw e;
  }
}

function parsearCierres(filas) {
  const out = [];
  for (let i = 1; i < (filas || []).length; i++) {
    const f = filas[i] || [];
    if (!celda(f[0])) continue;
    let resumen = {};
    try { resumen = JSON.parse(f[5] || '{}'); } catch (e) { resumen = {}; }
    out.push({
      id: celda(f[0]), fechaServicio: celda(f[1]), firmadoPor: celda(f[2]),
      estado: celda(f[3]) || 'vigente', nota: celda(f[4]), resumen,
      guardado: celda(f[6]), rowIndex: i + 1,
    });
  }
  return out;
}

const fechaServicioActual = () => require('./fudo').fechaServicioHoy();

async function listarCierres({ limite = 20 } = {}) {
  if (!configurada()) return [];
  const cierres = parsearCierres(await _leerHojaPropia(_sheets(), HOJA_CIERRES));
  return cierres
    .sort((a, b) => (b.guardado || '').localeCompare(a.guardado || ''))
    .slice(0, limite)
    .map(({ rowIndex, ...resto }) => resto);
}

async function detalleCierre(cierreId) {
  if (!configurada()) throw new Error('Falta STOCKS_SHEET_ID');
  const api = _sheets();
  const cierre = parsearCierres(await _leerHojaPropia(api, HOJA_CIERRES)).find(c => c.id === cierreId);
  if (!cierre) throw new Error('No existe ese cierre');
  const filas = await _leerHojaPropia(api, HOJA_DETALLE);
  const items = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] || [];
    if (celda(f[0]) !== cierreId) continue;
    items.push({
      hoja: celda(f[1]), grupo: celda(f[2]), nombre: celda(f[3]),
      estado: celda(f[4]), comentario: celda(f[5]),
      hecho: /^(si|sí|true|1)$/i.test(celda(f[6])), actualizado: celda(f[7]),
    });
  }
  const { rowIndex, ...cab } = cierre;
  return { cierre: cab, items };
}

// ─── Guardar la foto del servicio ───────────────────────────────────────────
//
// `cambios` son SÓLO los ítems que alguien tocó: [{ solapa, grupo, nombre,
// estado, comentario }]. La firma sale de `usuario`, que el server saca del
// token — nunca del body.
//
// No hay riesgo de escribir en la fila equivocada porque no se confía en ningún
// rowIndex traído del navegador: se relee la hoja fresca y se busca por la clave
// natural (solapa + grupo + nombre). Si un ítem ya no está —Pablo lo borró
// mientras alguien tenía la pantalla abierta— no se escribe nada en su lugar: se
// reporta y el cierre se guarda igual. La foto es lo que dijo la persona, y un
// desacuerdo con la planilla no puede hacer que se pierda.
async function guardarCierre({ fechaServicio, cambios = [], nota = '', reemplazar = false } = {}, { usuario, rol } = {}) {
  if (!configurada()) throw new Error('Falta STOCKS_SHEET_ID');
  if (!usuario) throw new Error('Falta el usuario');

  const fecha = fechaServicio || fechaServicioActual();
  const esAdmin = rol === 'admin';
  const permitidas = SOLAPAS.filter(s => s.escribible && (esAdmin || !s.soloAdmin));
  const idsPermitidos = new Set(permitidas.map(s => s.id));

  for (const c of cambios) {
    if (!idsPermitidos.has(c.solapa)) throw new Error(`No podés marcar ítems de "${c.solapa}"`);
    // Cada lista declara qué estados le aplican: "pedido" no existe en una
    // producción. Se valida contra los de esa lista, no contra los cuatro.
    const validos = (solapaDe(c.solapa).estados || ESTADOS);
    if (c.estado && c.estado !== SIN_TOCAR && !validos.includes(c.estado)) {
      throw new Error(`Estado inválido para "${c.solapa}": ${c.estado}`);
    }
  }

  // Sólo se exige sobre lo que se está marcando AHORA. Lo que ya estaba escrito
  // así en la planilla no es responsabilidad de quien cierra hoy, y bloquearle
  // el cierre por eso lo dejaría sin poder guardar nada.
  const sinComentario = cambios.filter(c =>
    ESTADOS_CON_COMENTARIO_OBLIGATORIO.includes(c.estado) && !txt(c.comentario));
  if (sinComentario.length) {
    throw new Error(
      `Hay ${sinComentario.length} ${sinComentario.length === 1 ? 'ítem marcado' : 'ítems marcados'} `
      + `para ver sin decir qué hay que ver: ${sinComentario.slice(0, 5).map(c => c.nombre).join(', ')}`
      + `${sinComentario.length > 5 ? ` y ${sinComentario.length - 5} más` : ''}. No se guardó nada.`);
  }

  const api = _sheets(false);
  await _ensureHojaPropia(api, HOJA_CIERRES, HEADER_CIERRES);
  await _ensureHojaPropia(api, HOJA_DETALLE, HEADER_DETALLE);

  // Idempotencia por servicio: dos personas cerrando la misma noche no se pisan
  // en silencio. Reemplazar es explícito y conserva el anterior.
  const previos = parsearCierres(await _leerHojaPropia(api, HOJA_CIERRES));
  const vigente = previos.find(c => c.fechaServicio === fecha && c.estado !== 'reemplazado');
  if (vigente && !reemplazar) {
    const e = new Error(`Ya hay un cierre cargado para el servicio del ${fecha}, firmado por ${vigente.firmadoPor}.`);
    e.code = 'YA_EXISTE';
    e.cierre = { id: vigente.id, firmadoPor: vigente.firmadoPor, guardado: vigente.guardado };
    throw e;
  }

  const ahora = new Date().toISOString();
  const cambiosPorSolapa = new Map();
  for (const c of cambios) {
    if (!cambiosPorSolapa.has(c.solapa)) cambiosPorSolapa.set(c.solapa, []);
    cambiosPorSolapa.get(c.solapa).push(c);
  }

  const celdas = [];
  const conflictos = [];
  const detalle = [];
  const resumenPorSolapa = {};

  for (const solapa of permitidas) {
    // Relectura fresca: es lo que hace que la clave natural sea suficiente.
    const filas = await _leer(solapa);
    const items = leerFilas(filas, solapa);
    const porClave = new Map(items.map(it => [claveDe(solapa.id, it), it]));

    const misCambios = cambiosPorSolapa.get(solapa.id) || [];
    let cols = null;
    if (misCambios.length) {
      cols = resolverColumnas(filas, solapa);
      if (cols.nuevas.length) {
        // Las columnas nuevas se reclaman sólo entre las que están vacías de
        // punta a punta (ver resolverColumnas), y la hoja tiene que ser lo
        // bastante ancha para que existan.
        await _asegurarAncho(api, solapa.hoja, Math.max(...cols.nuevas.map(n => n.col)));
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: cols.nuevas.map(n => ({ range: `${solapa.hoja}!${colLetra(n.col)}1`, values: [[n.nombre]] })),
          },
        });
      }
    }

    for (const c of misCambios) {
      const clave = claveDe(solapa.id, c);
      const item = porClave.get(clave);
      if (!item) {
        conflictos.push({ solapa: solapa.id, grupo: c.grupo, nombre: c.nombre, motivo: 'ya no está en la planilla' });
        continue;
      }
      const fila = item.rowIndex;
      const estadoTexto = c.estado === SIN_TOCAR ? '' : (c.estado || '');
      celdas.push({ range: `${solapa.hoja}!${colLetra(cols.estado)}${fila}`, values: [[estadoTexto]] });
      celdas.push({ range: `${solapa.hoja}!${colLetra(cols.comentario)}${fila}`, values: [[c.comentario || '']] });
      celdas.push({ range: `${solapa.hoja}!${colLetra(cols.actualizado)}${fila}`, values: [[`${usuario} · ${ahora.slice(0, 16).replace('T', ' ')}`]] });
      // El estado nuevo pisa al leído para que la foto salga con lo de ahora.
      item.estado = c.estado || SIN_TOCAR;
      item.comentario = c.comentario || '';
    }

    // La foto guarda TODO lo que no está en el default, lo hayan tocado ahora o
    // ya estuviera escrito. Los `sinTocar` no se escriben: una noche entera en
    // orden son cero filas de detalle, y el total vive en el resumen.
    for (const it of items) {
      if (it.estado === SIN_TOCAR) continue;
      detalle.push([solapa.hoja, it.grupo, it.nombre, it.estado, it.comentario || '', '', ahora]);
    }
    resumenPorSolapa[solapa.id] = resumenCierre(items);
  }

  if (celdas.length) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: celdas },
    });
  }

  // Si se reemplaza, el anterior se marca — no se borra. Una celda, en una fila
  // que es nuestra.
  if (vigente && reemplazar) {
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${HOJA_CIERRES}!D${vigente.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['reemplazado']] },
    });
  }

  const id = `cc${Date.now()}`;
  const resumen = {
    solapas: permitidas.map(s => s.id),
    porSolapa: resumenPorSolapa,
    cambios: cambios.length,
    conflictos: conflictos.length,
  };
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${HOJA_CIERRES}!A:G`,
    valueInputOption: 'RAW',
    requestBody: { values: [[id, fecha, usuario, 'vigente', nota || '', JSON.stringify(resumen), ahora]] },
  });
  if (detalle.length) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${HOJA_DETALLE}!A:H`,
      valueInputOption: 'RAW',
      requestBody: { values: detalle.map(d => [id, ...d]) },
    });
  }

  clearCache();
  return { id, fechaServicio: fecha, firmadoPor: usuario, resumen, conflictos, itemsEnLaFoto: detalle.length };
}

function clearCache() { cache.flushAll(); }

module.exports = {
  // I/O
  estadoActual, leerSolapa, leerSolapaCacheada, clearCache, configurada,
  guardarCierre, listarCierres, detalleCierre, fechaServicioActual,
  // Puras — se ejercitan sin red
  parsearEstado, leerFilas, notasSueltas, claveDe, duplicadosDe, resumenCierre, avisosDeHeaders,
  resolverColumnas, colLetra, parsearCierres, norm, celda, esError,
  // Constantes
  SOLAPAS, ESTADOS, SIN_TOCAR, solapaDe, HOJA_CIERRES, HOJA_DETALLE, ESTADOS_CON_COMENTARIO_OBLIGATORIO,
};
