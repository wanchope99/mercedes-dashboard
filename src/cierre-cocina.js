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
    // Desde el 24/08/2026 la cocina ve UNA sola lista: Producir, que es la que
    // Pablo deja escrita a la noche y ellos leen a la mañana. Seteo es
    // referencia de qué va en cada plaza y volverá el día que se pida; hoy
    // sumaba una solapa a una pantalla que tiene que abrirse en la lista del día.
    soloAdmin: true,
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

// La columna "Comentario" que la app agregó en una corrida anterior, si ya existe.
// Se busca SÓLO por nombre y no se reclama nada: acá se lee.
//
// Hasta el 23/08/2026 esta columna era de escritura y nadie la leía: guardarCierre
// mandaba el estado a la columna de Pablo y el comentario acá, y leerFilas seguía
// sacando las dos cosas de la columna de Pablo. El comentario que alguien escribía
// desaparecía de la pantalla en la siguiente recarga — estaba en la planilla, pero
// la app no volvía a mirarlo nunca.
function colComentarioApp(filas) {
  const cab = (filas || [])[0] || [];
  return cab.findIndex(c => norm(c) === norm(COLS_APP.comentario));
}

// Rellena el grupo hacia abajo: en las checklists el plato va sólo en la primera
// fila y las siguientes lo dejan en blanco (trampa 2 del encabezado).
//
// `colComentario` es la columna propia de la app (ver colComentarioApp). Cuando
// tiene algo, manda: es lo último que se escribió desde la pantalla. Cuando está
// vacía se cae al comentario que parsearEstado saca del texto libre de Pablo, que
// es lo único que hay en las filas que todavía nadie tocó desde la app.
function leerFilas(filas, solapa, colComentario = -1) {
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
    if (colComentario >= 0) item.comentario = celda(f[colComentario]) || item.comentario;
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
  const items = leerFilas(filas, solapa, colComentarioApp(filas));
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
// Devuelve SÓLO las solapas que ese rol puede ver. La cocina (rol encargado)
// recibe únicamente `produ`: no es que las otras se le escondan en el browser,
// es que no están en la respuesta. La regla de la casa es que el que decide es
// el server.
//
// Y ADEMÁS dice quién puede MARCAR, que desde el 24/08/2026 no es lo mismo que
// quién puede ver. Antes las dos cosas eran una sola —si la solapa te llegaba y
// la hoja aceptaba escritura, podías marcarla— y eso le daba a Juan y a Ezequiel
// la pantalla de cierre entera sobre la checklist de producción. Ellos leen lo
// que dejó Pablo y tildan lo que van haciendo en la lista de la mañana; escribir
// en la planilla de él es de Pablo, Tincho y admin.
//
// `escribible` sigue siendo una propiedad de LA HOJA (¿la app le escribe alguna
// celda?) y `puedeMarcar` una de ESTA PERSONA sobre esa hoja. Separadas porque
// contestan preguntas distintas: la pantalla de lectura se dibuja igual para las
// dos hojas de consulta y para las tres de marcar cuando quien mira no marca.
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
      puedeMarcar: esAdmin && s.escribible,
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

// ─── La lista de la mañana ──────────────────────────────────────────────────
//
// Tercera hoja propia, y es la única de las tres que se EDITA después de creada.
// Existe separada de `Cierre Cocina Detalle` a propósito: el detalle es la foto de
// cómo estaba la cocina cuando Pablo cerró, se escribe una vez y no se toca nunca
// más; esto es el trabajo del día siguiente, que por definición cambia mientras
// alguien lo hace. Meter las dos cosas en la misma hoja habría convertido la foto
// en algo mutable, que es justo lo que la hace servir para reconstruir una noche.
//
// Se siembra al guardar el cierre con lo que quedó en "Hacer" o "Ver" de la
// checklist de producción —lo que está en OK no es trabajo y no viaja— y crece
// durante la mañana con los extras que agrega la cocina.
//
// Que los extras de ayer no aparezcan hoy no necesita ninguna limpieza: todo se
// lee filtrando por el ID del cierre vigente, así que al guardarse el cierre
// siguiente el día anterior entero deja de existir para la pantalla, sin borrar
// una sola fila del historial.
const HOJA_PRODUCCION = process.env.CC_HOJA_PRODUCCION || 'Cierre Cocina Produccion';
const HEADER_PRODUCCION = [
  'ID', 'CierreID', 'Fecha Servicio', 'Origen', 'Plato', 'Item', 'Estado',
  'Comentario', 'Hecho', 'Hecho Por', 'Hecho En', 'Creado Por', 'Creado',
];
const RANGO_PRODUCCION = 'A:M';

// Los estados de la checklist que significan trabajo pendiente. `ok` no es trabajo
// y no llega a la mañana: la lista del cocinero tiene que ser lo que falta hacer,
// no la checklist entera con la mayoría tachada.
const ESTADOS_A_PRODUCIR = ['hacer', 'dudoso'];

const _esSi = v => /^(si|sí|true|1)$/i.test(celda(v));

// El id de una fila de producción. Lleva contador además del reloj porque el
// sembrado escribe treinta filas dentro del mismo milisegundo, y dos filas con el
// mismo id significan que tildar una tilda la otra.
let _seqProduccion = 0;
const _idProduccion = () =>
  `pr${Date.now().toString(36)}${(_seqProduccion++).toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

function parsearProduccion(filas) {
  const out = [];
  for (let i = 1; i < (filas || []).length; i++) {
    const f = filas[i] || [];
    if (!celda(f[0])) continue;
    out.push({
      id: celda(f[0]),
      cierreId: celda(f[1]),
      fechaServicio: celda(f[2]),
      origen: celda(f[3]) || 'checklist',
      grupo: celda(f[4]),
      nombre: celda(f[5]),
      estado: celda(f[6]) || 'hacer',
      comentario: celda(f[7]),
      hecho: _esSi(f[8]),
      hechoPor: celda(f[9]),
      hechoEn: celda(f[10]),
      creadoPor: celda(f[11]),
      creado: celda(f[12]),
      rowIndex: i + 1,
    });
  }
  return out;
}

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

async function _leerHojaPropia(api, titulo, rango = 'A:H') {
  try {
    const r = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${titulo}!${rango}` });
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

// ─── La producción del día ──────────────────────────────────────────────────
//
// El cierre que manda NO es el de la fecha de servicio en curso: es el ÚLTIMO
// guardado. A las diez de la mañana `fechaServicioHoy()` ya devuelve el día de
// hoy, mientras que lo que Pablo escribió anoche quedó firmado con el día de
// ayer; buscar por fecha le habría mostrado a la cocina una lista vacía todas las
// mañanas. La pregunta que contesta esta pantalla es "qué dejó dicho el último
// cierre", y esa se contesta por orden de guardado.
function cierreVigenteMasReciente(cierres) {
  return (cierres || [])
    .filter(c => c.estado !== 'reemplazado')
    .sort((a, b) => (b.guardado || '').localeCompare(a.guardado || ''))[0] || null;
}

// Sembrar la lista de un cierre a partir de su propia foto.
//
// Existe por dos razones. La primera es de estreno: los cierres guardados ANTES
// de que existiera esta pantalla no sembraron nada, así que sin esto la cocina
// habría abierto la pantalla y visto una lista vacía teniendo veintisiete cosas
// para producir escritas en la planilla, hasta el cierre siguiente. La segunda
// es que la deja auto-repararse — si un cierre se guarda a medias, la primera
// lectura de la mañana lo completa en vez de mostrar una lista que falta.
//
// Sale de `Cierre Cocina Detalle` y no de la planilla de Pablo a propósito: lo que
// hay que producir hoy es lo que estaba escrito CUANDO SE CERRÓ, no lo que la
// planilla diga ahora — Pablo la sigue editando durante el día.
async function _sembrarDesdeCierre(cierre) {
  const hojaProdu = solapaDe('produ').hoja;
  const filas = await _leerHojaPropia(_sheets(), HOJA_DETALLE);
  const ahora = new Date().toISOString();
  const rows = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] || [];
    if (celda(f[0]) !== cierre.id || celda(f[1]) !== hojaProdu) continue;
    const estado = celda(f[4]);
    if (!ESTADOS_A_PRODUCIR.includes(estado)) continue;
    rows.push([
      _idProduccion(), cierre.id, cierre.fechaServicio, 'checklist',
      celda(f[2]), celda(f[3]), estado, celda(f[5]),
      '', '', '', cierre.firmadoPor || '', ahora,
    ]);
  }
  if (!rows.length) return 0;
  const api = _sheets(false);
  await _ensureHojaPropia(api, HOJA_PRODUCCION, HEADER_PRODUCCION);
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${HOJA_PRODUCCION}!${RANGO_PRODUCCION}`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  return rows.length;
}

// Dos personas abriendo la pantalla en el mismo segundo pueden sembrar las dos.
// La ventana es de un parpadeo y no vale un lock, pero sí vale que la lista no
// muestre todo dos veces: los ítems que vienen de la checklist son únicos por
// plato + nombre, así que se queda el primero — y si alguno de los repetidos ya
// está tildado, ese gana, porque alguien lo hizo de verdad.
//
// Los extras NO se deduplican: dos personas pueden agregar "caldo" con toda
// intención, y decidir por ellas que es lo mismo sería inventar.
function _dedupProduccion(items) {
  const porClave = new Map();
  const out = [];
  for (const it of items) {
    if (it.origen !== 'checklist') { out.push(it); continue; }
    const k = `${norm(it.grupo)}|${norm(it.nombre)}`;
    const previo = porClave.get(k);
    if (!previo) { porClave.set(k, it); out.push(it); continue; }
    // Sólo se hereda el tilde, no el nombre: la fila que se ve tiene que seguir
    // siendo la primera, con la grafía con la que se sembró.
    if (it.hecho && !previo.hecho) {
      previo.hecho = true;
      previo.hechoPor = it.hechoPor;
      previo.hechoEn = it.hechoEn;
    }
  }
  return out;
}

async function produccionDelDia() {
  const vacio = { configurada: configurada(), cierre: null, items: [], resumen: { total: 0, hechos: 0 } };
  if (!configurada()) return vacio;
  const api = _sheets();
  const cierre = cierreVigenteMasReciente(parsearCierres(await _leerHojaPropia(api, HOJA_CIERRES)));
  if (!cierre) return vacio;

  // El filtro por cierre es lo que hace que ayer desaparezca solo: las filas del
  // día anterior siguen en la hoja, pero no son de este cierre y no se miran.
  const delCierre = async () => parsearProduccion(await _leerHojaPropia(api, HOJA_PRODUCCION, RANGO_PRODUCCION))
    .filter(p => p.cierreId === cierre.id);

  let filas = await delCierre();
  // Sin una sola fila para este cierre, se siembra y se vuelve a leer. Un GET que
  // escribe es raro y acá está a propósito: la alternativa era que la cocina
  // abriera la pantalla en blanco y no tuviera forma de arreglarlo desde el
  // teléfono. Sólo toca la hoja propia de la app, nunca la planilla de Pablo.
  if (!filas.length && await _sembrarDesdeCierre(cierre)) filas = await delCierre();

  const items = _dedupProduccion(filas)
    .map(({ rowIndex, cierreId, fechaServicio, ...resto }) => resto);
  const { rowIndex, ...cab } = cierre;
  return {
    configurada: true,
    cierre: cab,
    items,
    resumen: { total: items.length, hechos: items.filter(i => i.hecho).length },
  };
}

// Tildar (o destildar) un ítem. Se releen las filas y se busca por id: un
// rowIndex traído del navegador no se usa para escribir, misma regla que el resto
// del módulo. Destildar borra también la firma — dejar "hecho por Eze" en algo que
// se volvió a marcar como pendiente es peor que no tener firma.
async function marcarHecho({ id, hecho = true } = {}, { usuario } = {}) {
  if (!configurada()) throw new Error('Falta STOCKS_SHEET_ID');
  if (!usuario) throw new Error('Falta el usuario');
  if (!txt(id)) throw new Error('Falta el ítem');
  const api = _sheets(false);
  const fila = parsearProduccion(await _leerHojaPropia(api, HOJA_PRODUCCION, RANGO_PRODUCCION))
    .find(p => p.id === txt(id));
  if (!fila) throw new Error('Ese ítem ya no está en la lista de hoy');
  const ahora = new Date().toISOString();
  const marca = hecho ? ['si', usuario, ahora] : ['', '', ''];
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${HOJA_PRODUCCION}!I${fila.rowIndex}`, values: [[marca[0]]] },
        { range: `${HOJA_PRODUCCION}!J${fila.rowIndex}`, values: [[marca[1]]] },
        { range: `${HOJA_PRODUCCION}!K${fila.rowIndex}`, values: [[marca[2]]] },
      ],
    },
  });
  return { id: fila.id, hecho: !!hecho, hechoPor: marca[1], hechoEn: marca[2] };
}

// Algo para producir que no estaba en la lista. Vive acá y NO en la planilla de
// Pablo: es trabajo de este turno, no un ítem que la checklist tendría que tener
// siempre. Si resulta que sí tiene que estar siempre, lo agrega él a su planilla,
// que es de donde salen las listas.
async function agregarExtra({ grupo = '', nombre = '', comentario = '' } = {}, { usuario } = {}) {
  if (!configurada()) throw new Error('Falta STOCKS_SHEET_ID');
  if (!usuario) throw new Error('Falta el usuario');
  if (!txt(nombre)) throw new Error('Escribí qué hay que producir');
  const api = _sheets(false);
  await _ensureHojaPropia(api, HOJA_PRODUCCION, HEADER_PRODUCCION);
  const cierre = cierreVigenteMasReciente(parsearCierres(await _leerHojaPropia(api, HOJA_CIERRES)));
  // Sin cierre no hay a qué colgarlo, y un extra sin cierre sería una fila que no
  // aparece en ninguna pantalla. Se dice por qué en vez de guardar en el vacío.
  if (!cierre) throw new Error('Todavía no hay ningún cierre de cocina cargado, así que no sé a qué día agregarlo.');
  const ahora = new Date().toISOString();
  const fila = [
    _idProduccion(), cierre.id, cierre.fechaServicio, 'extra',
    txt(grupo) || 'Agregado en el turno', txt(nombre), 'hacer', txt(comentario),
    '', '', '', usuario, ahora,
  ];
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${HOJA_PRODUCCION}!${RANGO_PRODUCCION}`,
    valueInputOption: 'RAW',
    requestBody: { values: [fila] },
  });
  return {
    id: fila[0], origen: 'extra', grupo: fila[4], nombre: fila[5],
    estado: 'hacer', comentario: fila[7], hecho: false,
    creadoPor: usuario, creado: ahora,
  };
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

  // Cerrar es de Pablo, Tincho y admin. La regla se repite en la ruta con
  // adminOnly y vive TAMBIÉN acá a propósito: la pantalla decide qué botones
  // dibuja, pero lo que puede escribir en la planilla de Pablo lo decide el
  // lugar donde se escribe. Un modo lectura que se saltea tocando la API no
  // sería un modo lectura.
  if (rol !== 'admin') {
    throw new Error('El cierre de cocina lo firman Pablo, Tincho o admin. '
      + 'Lo que se hizo se tilda en la lista de producción del día.');
  }

  const fecha = fechaServicio || fechaServicioActual();
  const permitidas = SOLAPAS.filter(s => s.escribible);
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
  await _ensureHojaPropia(api, HOJA_PRODUCCION, HEADER_PRODUCCION);

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
  let itemsProdu = [];

  for (const solapa of permitidas) {
    // Relectura fresca: es lo que hace que la clave natural sea suficiente.
    const filas = await _leer(solapa);
    const colCom = colComentarioApp(filas);
    const items = leerFilas(filas, solapa, colCom);
    const porClave = new Map(items.map(it => [claveDe(solapa.id, it), it]));

    const misCambios = cambiosPorSolapa.get(solapa.id) || [];

    // ─── El comentario de anoche no vale hoy ───
    //
    // "Hacer masa de empanadas" tiene sentido la noche que se escribe y ninguno
    // la noche siguiente: o ya se hizo, o el número cambió. Al arrancar un cierre
    // nuevo la columna de comentarios de la checklist de producción se limpia, y
    // arriba de esa hoja en blanco se escribe lo de hoy. El ESTADO sobrevive: lo
    // que se vuelve viejo es el texto, no el hecho de que algo esté marcado.
    //
    // Sólo en `produ`. En Comprar un comentario es "entra martes 26", que el lunes
    // a la noche sigue siendo el dato más importante de la fila.
    //
    // Y sólo cuando este cierre ABRE una fecha de servicio. Si se está
    // reemplazando el cierre de esta misma noche, lo que hay escrito es de hoy y
    // borrarlo sería tirar lo que se acaba de cargar por corregir un solo ítem.
    const limpiarComentarios = solapa.id === 'produ' && !vigente;

    let cols = null;
    if (misCambios.length || limpiarComentarios) {
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

    if (limpiarComentarios) {
      // Se excluyen las filas que este cierre está escribiendo, en vez de confiar
      // en que el borrado se aplique antes que la escritura: las dos cosas van en
      // el mismo batchUpdate y depender del orden para no pisarse es frágil.
      const escritas = new Set(misCambios
        .map(c => (porClave.get(claveDe(solapa.id, c)) || {}).rowIndex)
        .filter(Boolean));
      for (const it of items) {
        if (escritas.has(it.rowIndex)) continue;
        // Se borra la columna de la app y NADA MÁS. El comentario viejo que vive
        // metido dentro del texto libre de Pablo —"comprar 3kg", donde "3kg" es el
        // comentario y sale de parsearlo— no se toca: limpiarlo sería reescribirle
        // una celda suya, que es la línea que este módulo no cruza. Esas filas se
        // normalizan solas la primera vez que alguien las marca desde la pantalla.
        const enLaApp = colCom >= 0 ? celda((filas[it.rowIndex - 1] || [])[colCom]) : '';
        if (!enLaApp) continue;
        celdas.push({ range: `${solapa.hoja}!${colLetra(cols.comentario)}${it.rowIndex}`, values: [['']] });
        // También en memoria: la foto tiene que salir con lo de esta noche, y el
        // comentario de anoche ya no es parte de esta noche.
        it.comentario = '';
      }
    }

    // La foto guarda TODO lo que no está en el default, lo hayan tocado ahora o
    // ya estuviera escrito. Los `sinTocar` no se escriben: una noche entera en
    // orden son cero filas de detalle, y el total vive en el resumen.
    for (const it of items) {
      if (it.estado === SIN_TOCAR) continue;
      detalle.push([solapa.hoja, it.grupo, it.nombre, it.estado, it.comentario || '', '', ahora]);
    }
    resumenPorSolapa[solapa.id] = resumenCierre(items);
    if (solapa.id === 'produ') itemsProdu = items;
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

  // La lista que la cocina va a ver mañana a la mañana: sólo lo que quedó para
  // hacer o para ver. Se siembra acá y no se calcula al leer para que sea un
  // documento con estado propio — lo que se tilda a las nueve de la mañana tiene
  // dónde guardarse sin tocar la foto del cierre ni la planilla de Pablo.
  const produccion = itemsProdu
    .filter(it => ESTADOS_A_PRODUCIR.includes(it.estado))
    .map(it => [
      _idProduccion(), id, fecha, 'checklist',
      it.grupo, it.nombre, it.estado, it.comentario || '',
      '', '', '', usuario, ahora,
    ]);
  if (produccion.length) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${HOJA_PRODUCCION}!${RANGO_PRODUCCION}`,
      valueInputOption: 'RAW',
      requestBody: { values: produccion },
    });
  }

  clearCache();
  return {
    id, fechaServicio: fecha, firmadoPor: usuario, resumen, conflictos,
    itemsEnLaFoto: detalle.length,
    paraProducir: produccion.length,
  };
}

function clearCache() { cache.flushAll(); }

module.exports = {
  // I/O
  estadoActual, leerSolapa, leerSolapaCacheada, clearCache, configurada,
  guardarCierre, listarCierres, detalleCierre, fechaServicioActual,
  // I/O — la lista de la mañana
  produccionDelDia, marcarHecho, agregarExtra,
  // Puras — se ejercitan sin red
  parsearEstado, leerFilas, notasSueltas, claveDe, duplicadosDe, resumenCierre, avisosDeHeaders,
  resolverColumnas, colLetra, parsearCierres, norm, celda, esError,
  colComentarioApp, parsearProduccion, cierreVigenteMasReciente, _dedupProduccion,
  // Constantes
  SOLAPAS, ESTADOS, SIN_TOCAR, solapaDe, HOJA_CIERRES, HOJA_DETALLE, ESTADOS_CON_COMENTARIO_OBLIGATORIO,
  HOJA_PRODUCCION, HEADER_PRODUCCION, ESTADOS_A_PRODUCIR,
};
