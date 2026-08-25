// ─── Pedidos por día — qué llega mañana, si hay que pagarlo y cuánto ───────────
//
// Reemplaza el Google Doc "PEDIDOS X DIA". Ese doc tenía dos partes que son dos
// cosas distintas, y acá siguen separadas a propósito:
//
//   1. El CUADRO SEMANAL ("los jueves entrega Barracas, Coca y Bendito"): la
//      rutina fija del bar. Cambia dos veces al año. Hoja `Pedidos Semanal`.
//   2. Los PEDIDOS DE CADA FECHA ("el 18/8 llega el pedido de Mercado Libre"):
//      lo concreto de esta semana. Hoja `Pedidos`.
//
// LA REGLA QUE ORDENA TODO: el cuadro semanal NO crea filas. Sus ítems se
// muestran dentro del día como "previstos" y recién existen como fila cuando
// alguien los marca recibidos. Materializarlos por adelantado — con un cron o
// con un botón "traer la semana" — obliga a inventar una respuesta para el día
// que nadie tocó (¿se borran? ¿quedan como no recibidos para siempre?) y a
// resolver duplicados cada vez que se edita el cuadro. Así el cuadro se edita y
// el efecto se ve en el acto, y lo único que queda escrito es lo que realmente
// pasó.
//
// Lo que este módulo NO hace: escribir en Movimientos. Un pedido esperado no es
// un gasto — la mercadería todavía no llegó. El asiento lo hace server.js
// cuando se marca recibido y pagado, con las mismas funciones que usa el botón
// "Pagar" de la sección Pagos (`marcarFilaPagada` / `registrarGastoEnLibro`).
// Ver el comentario de la ruta POST /api/pedidos/:id/recibir.
//
// Persistencia: dos hojas en SPREADSHEET_ID, creadas automáticamente al primer
// uso, igual que Mantenimiento y Propinas.
//
//   Hoja "Pedidos" — un pedido esperado para una fecha concreta:
//     A ID | B Fecha | C Proveedor | D Detalle | E CostoEstimado | F MedioPrevisto |
//     G Estado | H RecibidoPor | I RecibidoEl | J Pago | K MontoPagado |
//     L MedioPagoReal | M RefMovimiento | N Origen | O Notas | P Actualizado |
//     Q PagoPrevisto | R Vence
//
// Q y R (20/08/2026) son la INTENCION de pago, decidida al comprar. J/K/L son el
// HECHO, escrito al recibir. No se derivan una de la otra y no se pisan: un
// pedido puede nacer "se paga al recibir" y terminar "a pagar" porque el
// proveedor no trajo el remito, y las dos cosas tienen que quedar escritas.
//
//   Hoja "Pedidos Semanal" — el cuadro de referencia por día de semana:
//     A ID | B Dia | C Orden | D Tipo | E Proveedor | F Nota | G MedioPrevisto |
//     H Activo | I Actualizado
//
//   Hoja "Pedidos Items" (21/08/2026) — qué trae un pedido, renglón por renglón:
//     A ID | B PedidoID | C Producto | D Cantidad | E Unidad | F Estado |
//     G Nota | H Origen | I Actualizado
//
// LOS ITEMS SON DATOS, NUNCA UNA IMAGEN. Se pega un recorte del remito, Claude
// Vision lo lee, y lo que queda son estos renglones — la imagen se descarta y no
// se guarda en ningún lado. Decisión del dueño (21/08/2026), y es lo que hace
// que esto sirva en un teléfono: una lista se adapta a cualquier pantalla, una
// foto de un remito hay que abrirla, agrandarla y moverla con dos dedos.
//
// Existen para UNA cosa: tildar lo que llegó contra lo que se pidió, con el
// proveedor todavía en la puerta. Por eso el estado de un item es de tres
// valores y no un sí/no — "todavía no lo miré" y "lo miré y no vino" son
// distintos, y confundirlos es firmar que faltaba algo que nadie contó.
//
// `RefMovimiento` es informativo y NUNCA se usa para volver a buscar la fila:
// las filas de Movimientos se mueven cuando alguien edita la planilla a mano
// (ver la sección `Cajas` del CLAUDE.md). Lo que un pedido está o no pagado lo
// dicen sus propias columnas J/K/L.
//
// Cache: 5 min en memoria, invalidado tras cada write.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 300 });
const CACHE_PEDIDOS = 'pedidos';
const CACHE_SEMANAL = 'pedidos_semanal';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.PEDIDOS_SHEET || 'Pedidos';
const HOJA_SEMANAL = process.env.PEDIDOS_SEMANAL_SHEET || 'Pedidos Semanal';
const TZ = 'America/Argentina/Buenos_Aires';

// Categoria y Mes entraron el 25/08/2026 con el cambio de cuándo se escribe la
// fila del libro. Antes la compra escribía la fila en el acto y los dos datos
// iban directo a Movimientos; ahora la fila la escribe la RECEPCIÓN, y entre la
// compra y la entrega pueden pasar días — si no viajan con el pedido, se
// pierden y el gasto termina como "Mercaderia" del mes en que llegó.
//
// El Mes es una decisión de quien compra, no una consecuencia de la fecha de
// entrega: es la misma regla por la que mover un pedido a otro día NO le cambia
// el mes a su cuenta (ver POST /api/pedidos/:id/mover).
const HEADER = ['ID', 'Fecha', 'Proveedor', 'Detalle', 'CostoEstimado', 'MedioPrevisto',
                'Estado', 'RecibidoPor', 'RecibidoEl', 'Pago', 'MontoPagado', 'MedioPagoReal',
                'RefMovimiento', 'Origen', 'Notas', 'Actualizado',
                'PagoPrevisto', 'Vence', 'Categoria', 'Mes'];
const ULTIMA_COL = 'T';
const HEADER_SEMANAL = ['ID', 'Dia', 'Orden', 'Tipo', 'Proveedor', 'Nota', 'MedioPrevisto',
                        'Activo', 'Actualizado'];
const HOJA_ITEMS = process.env.PEDIDOS_ITEMS_SHEET || 'Pedidos Items';
const HEADER_ITEMS = ['ID', 'PedidoID', 'Producto', 'Cantidad', 'Unidad', 'Estado',
                      'Nota', 'Origen', 'Actualizado'];
const ULTIMA_COL_ITEMS = 'I';
const CACHE_ITEMS = 'pedidos_items';

// Qué pasó con este renglón cuando llegó la entrega.
//
// Tres valores y no un sí/no: 'pendiente' es "todavía no lo miré" y 'falta' es
// "lo miré y no vino". Confundirlos sería firmar que faltaba algo que nadie
// contó — el mismo motivo por el que el cierre de cocina arranca en 'sinTocar'
// y no en 'ok'.
const ESTADOS_ITEM = ['pendiente', 'ok', 'falta'];
const ESTADO_ITEM_DEFAULT = 'pendiente';

const PRODUCTO_MAX = 200;
const UNIDAD_MAX = 40;

// La semana entera. Lunes primero: el índice dentro del array es el día de la
// semana ISO menos uno, así que este array NO se toca — es lo que traduce una
// fecha a su día de la semana.
const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

// Los días que el CUADRO ofrece. Domingo y lunes quedan afuera (15/08/2026):
// ningún proveedor entrega esos días, así que dos columnas de siete estaban
// siempre vacías y le sacaban ancho a las que sí se usan.
//
// Son dos listas distintas a propósito. Un pedido concreto sí puede caer un
// lunes — alguien manda algo fuera de la rutina, o llega un Mercado Libre — y
// esos días siguen apareciendo en la lista de arriba con normalidad. Lo que se
// achica es la rutina fija, no el calendario.
const DIAS_CUADRO = ['martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const ESTADOS = ['esperado', 'recibido', 'cancelado'];
const ESTADO_DEFAULT = 'esperado';

// "Sacar a CCU del jueves 20": una fila CANCELADA cuyo único trabajo es tapar el
// previsto que el cuadro semanal genera para esa fecha.
//
// No se guarda POR QUÉ, y no es un olvido. Puede ser que no haga falta esta
// semana, que no haya que pedirlo, que se prefiera esperar — ninguna de esas
// cosas cambia nada en esta pantalla, cuya única pregunta es qué pedidos esperar
// ese día. Un campo "motivo" sería uno más que llenar con el proveedor en la
// puerta y que después nadie lee.
//
// No hay estructura nueva y es a propósito. Un previsto YA se esconde cuando
// existe un pedido real de ese proveedor ese día — la omisión es ese mismo
// mecanismo con el pedido en cero: llegó a existir como fila, y esa fila dice
// que no va a pasar. La alternativa era una hoja de excepciones aparte, que
// obliga a mantener dos listas que hablan del mismo día y a decidir cuál gana.
//
// Se distingue por `origen` y no por el estado: 'cancelado' a secas puede querer
// decir "el pedido existía y se cayó", que es otra cosa y no debería poder
// deshacerse desde el botón de un previsto.
const ORIGEN_OMITIDO = 'omitido';
const esOmision = p => p.estado === 'cancelado' && p.origen === ORIGEN_OMITIDO;

// El estado del pago es de tres valores y no un sí/no: "todavía nada" y "llegó,
// quedó a pagar" son situaciones distintas y la segunda tiene una fila en el
// libro esperando. Sin el tercer valor, un pedido recibido sin pagar se
// confunde con uno que nadie tocó.
const PAGOS = ['no', 'pagado', 'a pagar'];
const PAGO_DEFAULT = 'no';

// Como se VA a pagar, decidido al cargar la compra. Es la contracara de PAGOS:
// aquel dice que paso, este dice que se planeo. Son los mismos tres casos que
// los tres botones de recibir, movidos al momento en que los sabe quien compra
// en vez del momento en que los adivina quien recibe.
//
//   'pagado'     ya salio la plata (transferencia, MP, debito)
//   'al-recibir' hay que pagarlo en la puerta        → el unico que pide accion
//   'a-pagar'    queda a cuenta, con vencimiento
//
// El default es VACIO y no un valor. Un pedido cargado antes de que esto
// existiera, o un previsto del cuadro semanal, no dijeron nada sobre la plata:
// inventarles una respuesta es la misma falla que ya esta documentada para
// 'sinTocar' vs 'ok' en el cierre de cocina. Vacio se muestra como nada.
const PAGOS_PREVISTOS = ['pagado', 'al-recibir', 'a-pagar'];
const PAGO_PREVISTO_DEFAULT = '';

// Ojo con el vocabulario, porque se cruzan dos cosas. El que recibe PAGA — el
// que cobra es el proveedor. Y "a pagar" en la pantalla del cocinero significa
// lo que pagas en la puerta, mientras que 'a-pagar' aca significa exactamente
// lo contrario: queda a cuenta y NO se paga ahi. Por eso lo que se cuenta para
// mostrar se llama "enPuerta" y no "aPagar": dos nombres parecidos para estados
// opuestos es como se rompe esto dentro de tres meses.
const sePagaEnPuerta = p => p.pagoPrevisto === 'al-recibir' && p.pago === 'no';

// "Entrega El Jumillano, pagarle en efectivo" y "Pedir a Acequia para el jueves"
// son las dos clases de línea del doc y no significan lo mismo: la primera es
// algo que llega y se paga, la segunda es una tarea. Sólo las `entrega` se
// ofrecen como previstos para recibir.
const TIPOS = ['entrega', 'pedir'];
const TIPO_DEFAULT = 'entrega';

const DETALLE_MAX = 500;
const NOTAS_MAX = 1000;

// Cuántos días para adelante se arma la lista. Una semana justa: hoy y los 7
// siguientes, así el último día que aparece es el mismo día de la semana que
// hoy (sábado 15 → sábado 22) y no queda medio calendario abierto.
//
// Eran 14 y se bajó a 7 el 2026-08-15: con dos semanas la pantalla mostraba
// pedidos de dentro de trece días mezclados con los de mañana, y lo que se
// mira todos los días es la semana entrante. El corte vale también para los
// previstos del cuadro semanal — se generan por fecha dentro de este mismo
// horizonte (ver armarDias), así que el cuadro tampoco proyecta más lejos.
const DIAS_ADELANTE = 7;

// ═══════════════════════════════════════════════════════════════════════════
// Fechas — puras, sin I/O.
// ═══════════════════════════════════════════════════════════════════════════

function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// Una fecha 'YYYY-MM-DD' se parsea a mediodía UTC para que ningún corrimiento
// de zona horaria la tire al día anterior — que acá significaría mostrar un
// pedido en el día equivocado.
function _aDate(fecha) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function _iso(d) { return d.toISOString().slice(0, 10); }

function _sumarDias(fecha, n) {
  const d = _aDate(fecha);
  if (!d) return '';
  d.setUTCDate(d.getUTCDate() + n);
  return _iso(d);
}

/** El día de semana de una fecha, en minúsculas y sin abreviar ('jueves'). */
function diaSemanaDe(fecha) {
  const d = _aDate(fecha);
  if (!d) return '';
  return DIAS[(d.getUTCDay() || 7) - 1];
}

/** 'Jueves 21 de agosto' — lo que se lee en el renglón del día. */
function etiquetaDia(fecha) {
  const d = _aDate(fecha);
  if (!d) return 'Sin fecha';
  // Sin la coma que mete el locale ("Jueves, 20 de agosto"): es un título, no
  // una oración.
  const s = d.toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
    .replace(',', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalización
// ═══════════════════════════════════════════════════════════════════════════

function _txt(v) { return (v == null ? '' : v).toString().trim(); }

// Los acentos combinantes U+0300–U+036F, para comparar "miercoles" con
// "miércoles": el día se tipea a mano en la planilla y viene de las dos formas.
function _sinTilde(x) { return x.normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function _deLista(valor, lista, porDefecto) {
  const s = _txt(valor).toLowerCase();
  return lista.find(x => x.toLowerCase() === s) || porDefecto;
}

function normalizarEstado(v) { return _deLista(v, ESTADOS, ESTADO_DEFAULT); }
function normalizarPago(v) { return _deLista(v, PAGOS, PAGO_DEFAULT); }
function normalizarPagoPrevisto(v) { return _deLista(v, PAGOS_PREVISTOS, PAGO_PREVISTO_DEFAULT); }
function normalizarEstadoItem(v) { return _deLista(v, ESTADOS_ITEM, ESTADO_ITEM_DEFAULT); }
function normalizarTipo(v) { return _deLista(v, TIPOS, TIPO_DEFAULT); }

// El día se acepta con o sin tilde ("miercoles" tipeado a mano en la planilla
// es el mismo miércoles) y por número de día ISO.
function normalizarDia(v) {
  const s = _txt(v).toLowerCase();
  if (!s) return '';
  const exacto = DIAS.find(d => _sinTilde(d) === _sinTilde(s));
  if (exacto) return exacto;
  const n = parseInt(s, 10);
  if (n >= 1 && n <= 7) return DIAS[n - 1];
  return '';
}

// Una fecha puede llegar como 'YYYY-MM-DD' (del input date del navegador) o
// como 'D/M/AAAA' (si alguien la tipeó en la planilla). Adentro siempre es ISO.
function normalizarFecha(v) {
  const s = _txt(v);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }
  const d = _aDate(s);
  return d ? _iso(d) : '';
}

function _numero(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.,-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Persistencia
// ═══════════════════════════════════════════════════════════════════════════

function _sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function _ensureHoja(api, titulo, header, ultimaCol) {
  let creada = false;
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] },
    });
    creada = true;
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${titulo}!A1:${ultimaCol}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
  if (!creada) await _ensureEncabezado(api, titulo, header, ultimaCol);
}

/**
 * La hoja ya existe pero le faltan columnas.
 *
 * `_ensureHoja` solo escribe el encabezado cuando CREA la hoja, asi que al
 * agregarle columnas al modelo la hoja de produccion se queda con el encabezado
 * viejo: las celdas nuevas se leen y se escriben igual, pero la planilla queda
 * ilegible por su cuenta — una columna de datos sin titulo.
 *
 * Solo se escribe la FILA 1 y solo si es mas corta que el encabezado esperado.
 * Ninguna fila de datos se toca. Se puede correr todas las veces.
 *
 * Estas hojas son de la app (a diferencia de las de Pablo en cierre-cocina.js,
 * donde hay que ensanchar la grilla antes de escribir): nacen con 26 columnas,
 * asi que escribir hasta R nunca se pasa del ancho.
 */
async function _ensureEncabezado(api, titulo, header, ultimaCol) {
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${titulo}!A1:${ultimaCol}1`,
    });
    const fila = (res.data.values && res.data.values[0]) || [];
    if (fila.length >= header.length) return;
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${titulo}!A1:${ultimaCol}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  } catch (e) {
    // Que el encabezado no se pueda arreglar no puede tumbar la pantalla: los
    // datos se leen igual por posicion. Queda el titulo viejo, nada mas.
  }
}

async function _leerPedidos(api) {
  let rows;
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:${ULTIMA_COL}` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA, HEADER, ULTIMA_COL);
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !_txt(r[0])) continue;
    const fecha = normalizarFecha(r[1]);
    out.push({
      id: _txt(r[0]),
      fecha,
      proveedor: _txt(r[2]),
      detalle: _txt(r[3]),
      costoEstimado: _numero(r[4]),
      medioPrevisto: _txt(r[5]),
      estado: normalizarEstado(r[6]),
      recibidoPor: _txt(r[7]),
      recibidoEl: _txt(r[8]),
      pago: normalizarPago(r[9]),
      montoPagado: _numero(r[10]),
      medioPagoReal: _txt(r[11]),
      refMovimiento: _txt(r[12]),
      origen: _txt(r[13]) || 'manual',
      notas: _txt(r[14]),
      actualizado: _txt(r[15]),
      pagoPrevisto: normalizarPagoPrevisto(r[16]),
      vence: normalizarFecha(r[17]),
      // Lo que decidió la compra y va a escribir la recepción.
      categoria: _txt(r[18]),
      mes: _txt(r[19]),
      rowIndex: i + 1,
    });
  }
  return out;
}

async function _leerSemanal(api) {
  let rows;
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_SEMANAL}!A:I` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA_SEMANAL, HEADER_SEMANAL, 'I');
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !_txt(r[0])) continue;
    const dia = normalizarDia(r[1]);
    if (!dia) continue;   // una fila sin día no se puede ubicar en el cuadro
    out.push({
      id: _txt(r[0]),
      dia,
      orden: _numero(r[2]),
      tipo: normalizarTipo(r[3]),
      proveedor: _txt(r[4]),
      nota: _txt(r[5]),
      medioPrevisto: _txt(r[6]),
      // Sólo un "no" explícito desactiva: una celda vacía es una fila cargada a
      // mano en la planilla y esconderla sería hacerla desaparecer sin aviso.
      activo: _txt(r[7]).toLowerCase() !== 'no',
      actualizado: _txt(r[8]),
      rowIndex: i + 1,
    });
  }
  return out.sort((a, b) => DIAS.indexOf(a.dia) - DIAS.indexOf(b.dia) || a.orden - b.orden);
}

// ═══════════════════════════════════════════════════════════════════════════
// Los items de un pedido
// ═══════════════════════════════════════════════════════════════════════════

async function _leerItems(api) {
  let rows;
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA_ITEMS}!A:${ULTIMA_COL_ITEMS}`,
    });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA_ITEMS, HEADER_ITEMS, ULTIMA_COL_ITEMS);
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !_txt(r[0]) || !_txt(r[1])) continue;   // sin id o sin pedido no se puede ubicar
    out.push({
      id: _txt(r[0]),
      pedidoId: _txt(r[1]),
      producto: _txt(r[2]),
      cantidad: _numero(r[3]) || 1,
      unidad: _txt(r[4]) || 'Unidad',
      estado: normalizarEstadoItem(r[5]),
      nota: _txt(r[6]),
      origen: _txt(r[7]) || 'manual',
      actualizado: _txt(r[8]),
      rowIndex: i + 1,
    });
  }
  return out;
}

async function _loadItems() {
  const cached = cache.get(CACHE_ITEMS);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return [];
  const items = await _leerItems(_sheets());
  cache.set(CACHE_ITEMS, items);
  return items;
}

function _aFilaItem(it) {
  return [it.id, it.pedidoId, it.producto, it.cantidad, it.unidad,
          it.estado, it.nota, it.origen, it.actualizado];
}

/** Los items de un pedido, en el orden en que se cargaron. */
async function itemsDe(pedidoId) {
  const id = _txt(pedidoId);
  if (!id) return [];
  return (await _loadItems()).filter(i => i.pedidoId === id).map(_publico);
}

/**
 * Agrega renglones a un pedido. Devuelve los creados.
 *
 * Se escriben TODOS de una sola llamada: pegar un remito de quince productos no
 * puede ser quince `append` seguidos contra Sheets.
 *
 * NO reemplaza lo que ya había. Pegar un segundo remito suma renglones, no pisa
 * los primeros: un pedido puede llegar en dos remitos, y borrar lo anterior
 * porque llegó algo nuevo es destruir lo que alguien ya tildó.
 */
async function agregarItems(pedidoId, items = [], { origen = 'manual' } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const pid = _txt(pedidoId);
  if (!pid) throw new Error('Falta el pedido');
  const limpios = (Array.isArray(items) ? items : [])
    .map(x => ({
      producto: _txt(x && x.producto).slice(0, PRODUCTO_MAX),
      cantidad: _numero(x && x.cantidad) || 1,
      unidad: (_txt(x && x.unidad) || 'Unidad').slice(0, UNIDAD_MAX),
      nota: _txt(x && x.nota).slice(0, NOTAS_MAX),
    }))
    .filter(x => x.producto);
  if (!limpios.length) return [];

  const api = _sheets();
  await _ensureHoja(api, HOJA_ITEMS, HEADER_ITEMS, ULTIMA_COL_ITEMS);
  const ahora = new Date().toISOString();
  const nuevos = limpios.map((x, n) => ({
    id: `it${Date.now()}${n}${Math.floor(Math.random() * 100)}`,
    pedidoId: pid,
    ...x,
    estado: ESTADO_ITEM_DEFAULT,
    origen: _txt(origen) || 'manual',
    actualizado: ahora,
  }));
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA_ITEMS}!A:${ULTIMA_COL_ITEMS}`,
    valueInputOption: 'RAW',
    requestBody: { values: nuevos.map(_aFilaItem) },
  });
  cache.del(CACHE_ITEMS);
  return nuevos.map(_publico);
}

/**
 * Tildar renglones. `cambios` es [{ id, estado?, nota? }].
 *
 * Por lote y no de a uno: tildar doce productos con el proveedor esperando no
 * puede ser doce viajes al servidor. Se escribe con un `batchUpdate` sobre las
 * filas que cambian, celda por celda — el resto de la fila no se toca.
 *
 * Se relee la hoja antes de escribir: las filas se mueven si alguien edita la
 * planilla a mano, así que el rowIndex que tenía el navegador es una pista, no
 * una identidad. Un item que ya no existe se informa y se saltea, y los demás
 * se guardan igual — perder el tilde de once porque uno se borró sería peor.
 */
async function marcarItems(cambios = []) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const lista = (Array.isArray(cambios) ? cambios : []).filter(c => c && _txt(c.id));
  if (!lista.length) return { guardados: 0, faltantes: [] };

  const api = _sheets();
  const actuales = await _leerItems(api);      // fresco, sin caché
  const porId = new Map(actuales.map(i => [i.id, i]));
  const ahora = new Date().toISOString();
  const data = [], faltantes = [];

  for (const c of lista) {
    const it = porId.get(_txt(c.id));
    if (!it) { faltantes.push(_txt(c.id)); continue; }
    const fila = it.rowIndex;
    if (Object.prototype.hasOwnProperty.call(c, 'estado')) {
      data.push({ range: `${HOJA_ITEMS}!F${fila}`, values: [[normalizarEstadoItem(c.estado)]] });
    }
    if (Object.prototype.hasOwnProperty.call(c, 'nota')) {
      data.push({ range: `${HOJA_ITEMS}!G${fila}`, values: [[_txt(c.nota).slice(0, NOTAS_MAX)]] });
    }
    data.push({ range: `${HOJA_ITEMS}!I${fila}`, values: [[ahora]] });
  }
  if (data.length) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });
    cache.del(CACHE_ITEMS);
  }
  return { guardados: lista.length - faltantes.length, faltantes };
}

/** Un renglón cargado mal se borra. La fila desaparece de la hoja. */
async function borrarItem(id) {
  const it = (await _loadItems()).find(x => x.id === _txt(id));
  if (!it) throw new Error('No se encontró ese renglón');
  await _borrarFila(HOJA_ITEMS, it.rowIndex);
  cache.del(CACHE_ITEMS);
  return { id: it.id, pedidoId: it.pedidoId };
}

async function _loadPedidos() {
  const cached = cache.get(CACHE_PEDIDOS);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return [];
  const items = await _leerPedidos(_sheets());
  cache.set(CACHE_PEDIDOS, items);
  return items;
}

async function _loadSemanal() {
  const cached = cache.get(CACHE_SEMANAL);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return [];
  const items = await _leerSemanal(_sheets());
  cache.set(CACHE_SEMANAL, items);
  return items;
}

function _aFila(p) {
  return [p.id, p.fecha, p.proveedor, p.detalle, p.costoEstimado || '', p.medioPrevisto,
          p.estado, p.recibidoPor, p.recibidoEl, p.pago, p.montoPagado || '', p.medioPagoReal,
          p.refMovimiento, p.origen, p.notas, p.actualizado,
          p.pagoPrevisto || '', p.vence || '', p.categoria || '', p.mes || ''];
}

function _aFilaSemanal(s) {
  return [s.id, s.dia, s.orden, s.tipo, s.proveedor, s.nota, s.medioPrevisto,
          s.activo ? 'si' : 'no', s.actualizado];
}

function _publico({ rowIndex, ...rest }) { return rest; }

// ═══════════════════════════════════════════════════════════════════════════
// La lista de días
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ¿Este pedido todavía pide algo de alguien?
 *
 * Es lo que decide si un día que ya pasó sigue a la vista, y desde el
 * 2026-08-19 pregunta UNA sola cosa: ¿llegó la mercadería? Un pedido recibido
 * no vuelve a trabar un día pasado, aunque su pago haya quedado sin definir.
 *
 * Antes el pago sin definir también contaba, y era la causa de un día que se
 * quedaba en rojo con "sin resolver" sin que hubiera nada que resolver: el
 * botón "✓ Recibido" guardaba `pago: 'no'` — que quiere decir "la plata se ve
 * después" — y ningún botón sacaba de ese estado, así que el día no se iba
 * nunca. Con los tres botones de recepción (efectivo / a cuenta / pago aparte)
 * el pago SIEMPRE queda decidido al recibir, así que `pago: 'no'` sólo puede
 * quedar en filas viejas.
 *
 * Esas filas viejas no se pierden: no traban la pantalla, pero `pagoSinDefinir`
 * las junta y la campanita avisa por ellas una vez por día hasta que alguien
 * les registre el pago. Ver `sinPago` en listPedidos y dePedidos en
 * src/notificaciones.js.
 */
function estaAbierto(p) {
  if (p.estado === 'cancelado') return false;
  return p.estado !== 'recibido';
}

/**
 * Llegó, pero nunca se dijo qué pasó con la plata.
 *
 * No es lo mismo que "abierto": no reclama nada en la pantalla del día, porque
 * la mercadería ya está adentro y el día se cumplió. Lo que falta es el asiento
 * en Movimientos, y eso se persigue por la campanita, no manteniendo un día en
 * rojo. "a pagar" NO cuenta acá — ya tiene su fila en el libro y lo persigue la
 * sección Pagos, que es su lugar.
 */
function pagoSinDefinir(p) {
  return p.estado === 'recibido' && p.pago === 'no';
}

/**
 * Arma los días a mostrar.
 *
 * PURA a propósito (recibe las filas ya leídas): es la única regla de negocio
 * de la pantalla y así se puede ejercitar sin tocar Google.
 *
 * Los días son: hoy y los `dias` siguientes, más cualquier fecha PASADA que
 * todavía tenga algo abierto. Esas van marcadas `atrasado` y primero — un día
 * que pasó con un pedido sin resolver es lo más urgente que hay en la pantalla,
 * y ocultarlo con el resto del pasado es cómo se pierde.
 *
 * Los "previstos" salen del cuadro semanal y NO son filas: son lo que ese día
 * de la semana suele traer. Se oculta el previsto cuyo proveedor ya tiene un
 * pedido real ese día — si no, cargar a mano lo que el cuadro ya anunciaba lo
 * mostraría dos veces.
 */
function armarDias(pedidos, semanal, { hoy, dias = DIAS_ADELANTE } = {}) {
  const activos = semanal.filter(s => s.activo);
  const porDia = {};
  for (const p of pedidos) {
    if (!p.fecha) continue;
    (porDia[p.fecha] = porDia[p.fecha] || []).push(p);
  }

  const fechas = [];
  for (let i = 0; i <= dias; i++) fechas.push(_sumarDias(hoy, i));
  const atrasadas = Object.keys(porDia)
    .filter(f => f < hoy && porDia[f].some(estaAbierto))
    .sort();

  const armar = (fecha, atrasado) => {
    const todos = porDia[fecha] || [];
    const delDia = todos.filter(p => p.estado !== 'cancelado');
    const omitidos = todos.filter(esOmision);

    // Los CANCELADOS también cuentan para tapar el previsto, no sólo los vivos.
    // Un pedido que se cayó tampoco va a llegar, así que seguir ofreciendo
    // recibirlo sería ofrecer marcar algo que ya sabemos que no pasa.
    const nombres = new Set(todos.map(p => p.proveedor.toLowerCase()));
    const omitidosNombres = new Set(omitidos.map(p => p.proveedor.toLowerCase()));
    const dia = diaSemanaDe(fecha);
    const delCuadro = activos.filter(s => s.dia === dia);

    // Un día pasado no anuncia lo que "suele traer": eso ya no va a pasar.
    // Mostrar previstos ahí sería ofrecer recibir algo de la semana pasada.
    const previstos = atrasado ? [] : delCuadro
      .filter(s => s.tipo === 'entrega' && !nombres.has(s.proveedor.toLowerCase()))
      .map(s => ({ ...s, fecha }));
    // "Para pedir" se filtra SÓLO por las omisiones, no por los pedidos reales:
    // que ya haya llegado algo de ese proveedor no quiere decir que no haya que
    // encargarle lo de la semana que viene. Que alguien haya dicho "este día no"
    // sí lo quiere decir.
    const paraPedir = atrasado ? [] : delCuadro
      .filter(s => s.tipo === 'pedir' && !omitidosNombres.has(s.proveedor.toLowerCase()));

    return {
      fecha,
      diaSemana: dia,
      label: etiquetaDia(fecha),
      esHoy: fecha === hoy,
      atrasado,
      pedidos: delDia.map(_publico),
      previstos: previstos.map(_publico),
      paraPedir: paraPedir.map(_publico),
      // Lo que alguien dijo que este día NO viene. Se devuelve para poder
      // mostrarlo y deshacerlo: una omisión invisible es indistinguible de un
      // previsto que nunca existió, y al día siguiente nadie sabe por qué falta.
      omitidos: omitidos.map(_publico),
      abiertos: delDia.filter(estaAbierto).length,
      totalEstimado: delDia.reduce((s, p) => s + (p.montoPagado || p.costoEstimado || 0), 0),
      // Lo que hay que pagar EN LA PUERTA ese dia. Es lo unico del dia que pide
      // una accion de quien recibe, y es lo que se muestra con el dia plegado:
      // sin esto habria que abrir cada dia para saber si hace falta plata.
      // Ver sePagaEnPuerta — no se llama "aPagar" porque 'a-pagar' significa
      // justamente lo contrario.
      cantEnPuerta: delDia.filter(sePagaEnPuerta).length,
      totalEnPuerta: delDia.filter(sePagaEnPuerta).reduce((s, p) => s + (p.costoEstimado || 0), 0),
    };
  };

  return [
    ...atrasadas.map(f => armar(f, true)),
    ...fechas.map(f => armar(f, false)),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// API pública
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Le cuelga a cada pedido sus renglones, y el resumen de cómo viene el chequeo.
 *
 * Van adentro del pedido y no en una lista aparte porque la pantalla los usa
 * siempre juntos: el modal de un día muestra cada pedido con lo que trae. Una
 * llamada por pedido para pedirle los items sería una por renglón de la lista.
 *
 * `itemsResumen` existe para el renglón plegado: "12 productos · 3 sin tildar"
 * se tiene que poder mostrar sin recorrer la lista en el navegador, y sobre todo
 * sin abrir el pedido.
 */
function _conItems(pedidos, items) {
  const porPedido = new Map();
  for (const it of items) {
    if (!porPedido.has(it.pedidoId)) porPedido.set(it.pedidoId, []);
    porPedido.get(it.pedidoId).push(it);
  }
  return pedidos.map(p => {
    const propios = porPedido.get(p.id) || [];
    if (!propios.length) return p;
    return {
      ...p,
      items: propios.map(_publico),
      itemsResumen: {
        total: propios.length,
        ok: propios.filter(i => i.estado === 'ok').length,
        falta: propios.filter(i => i.estado === 'falta').length,
        pendientes: propios.filter(i => i.estado === 'pendiente').length,
      },
    };
  });
}

async function listPedidos({ dias = DIAS_ADELANTE } = {}) {
  const [pedidos, semanal, items] = await Promise.all([_loadPedidos(), _loadSemanal(), _loadItems()]);
  const hoy = hoyAR();
  const conItems = _conItems(pedidos, items);
  return {
    hoy,
    dias: armarDias(conItems, semanal, { hoy, dias }),
    // Las filas que llegaron y nunca dijeron qué pasó con la plata. Van aparte
    // de `dias` a propósito: no traban ningún día (ver estaAbierto) pero
    // alguien tiene que enterarse de que existen. Sólo las de días PASADOS —
    // un pedido recibido hace un rato todavía no es un olvido, es el rato que
    // tarda alguien en cargar el monto.
    sinPago: conItems
      .filter(p => pagoSinDefinir(p) && p.fecha && p.fecha < hoy)
      .sort((a, b) => a.fecha.localeCompare(b.fecha))
      .map(_publico),
    semanal: semanal.map(_publico),
    diasSemana: DIAS,
    // Las columnas del cuadro. El navegador dibuja éstas y no las siete: ver
    // DIAS_CUADRO arriba.
    diasCuadro: DIAS_CUADRO,
    tipos: TIPOS,
  };
}

/** Un pedido por id, con su rowIndex. Uso interno de las rutas. */
async function getPedido(id) {
  const items = await _loadPedidos();
  return items.find(p => p.id === _txt(id)) || null;
}

/**
 * El id de un pedido.
 *
 * Va a la columna H de Movimientos (ID Compra) cuando el pedido tiene una fila
 * en el libro, y esa columna es la clave de idempotencia: tiene que ser unico y
 * estable. El prefijo 'ped' esta para reconocerlo de un vistazo en la planilla
 * y, sobre todo, para que _esDeOtroPedido en server.js pueda distinguir una
 * fila de otro pedido de una cargada a mano o por el bot.
 *
 * Se exporta porque "Nueva compra" lo necesita ANTES de escribir el libro: la
 * fila tiene que nacer con el id del pedido adentro, o el vinculo entre los dos
 * vuelve a depender de adivinar cual fila era.
 */
const nuevoId = () => `ped${Date.now()}${Math.floor(Math.random() * 100)}`;

async function crearPedido(datos = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const proveedor = _txt(datos.proveedor);
  if (!proveedor) throw new Error('Falta el proveedor');
  const fecha = normalizarFecha(datos.fecha) || hoyAR();

  const api = _sheets();
  await _ensureHoja(api, HOJA, HEADER, ULTIMA_COL);

  const item = {
    // El id puede venir de afuera: "Nueva compra" lo acuña antes de escribir la
    // fila del libro, para poder ponerlo en la columna H. Ver nuevoId().
    id: _txt(datos.id) || nuevoId(),
    fecha,
    proveedor,
    detalle: _txt(datos.detalle).slice(0, DETALLE_MAX),
    costoEstimado: _numero(datos.costoEstimado),
    medioPrevisto: _txt(datos.medioPrevisto),
    estado: normalizarEstado(datos.estado),
    recibidoPor: '',
    recibidoEl: '',
    pago: PAGO_DEFAULT,
    montoPagado: 0,
    medioPagoReal: '',
    refMovimiento: '',
    origen: _txt(datos.origen) || 'manual',
    notas: _txt(datos.notas).slice(0, NOTAS_MAX),
    actualizado: new Date().toISOString(),
    // Como se VA a pagar. Ver PAGOS_PREVISTOS: el default es vacio a proposito.
    pagoPrevisto: normalizarPagoPrevisto(datos.pagoPrevisto),
    vence: normalizarFecha(datos.vence),
    // Con qué categoría y a qué mes va a entrar el gasto cuando se reciba. Los
    // elige quien compra; sin esto, la recepción tendría que adivinarlos.
    categoria: _txt(datos.categoria),
    mes: _txt(datos.mes),
  };

  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA}!A:${ULTIMA_COL}`,
    valueInputOption: 'RAW',
    requestBody: { values: [_aFila(item)] },
  });
  cache.del(CACHE_PEDIDOS);
  return item;
}

/**
 * Edita un pedido. Sólo se tocan los campos que vienen en `cambios`.
 *
 * Los campos del pago (pago, montoPagado, medioPagoReal, refMovimiento) NO se
 * editan por acá: los escribe `marcarRecibido` después de que el asiento salió
 * bien. Dejar que se toquen sueltos permitiría un pedido marcado pagado sin
 * fila en el libro, que es el agujero que esta pantalla viene a tapar.
 */
async function actualizarPedido(id, cambios = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  const items = await _leerPedidos(api);
  const actual = items.find(p => p.id === _txt(id));
  if (!actual) throw new Error('No se encontró ese pedido');

  const tiene = c => Object.prototype.hasOwnProperty.call(cambios, c);
  const nuevo = { ...actual };

  if (tiene('fecha')) {
    const f = normalizarFecha(cambios.fecha);
    if (!f) throw new Error('Fecha inválida');
    nuevo.fecha = f;
  }
  if (tiene('proveedor')) {
    const p = _txt(cambios.proveedor);
    if (!p) throw new Error('El proveedor no puede quedar vacío');
    nuevo.proveedor = p;
  }
  if (tiene('detalle')) nuevo.detalle = _txt(cambios.detalle).slice(0, DETALLE_MAX);
  if (tiene('costoEstimado')) nuevo.costoEstimado = _numero(cambios.costoEstimado);
  if (tiene('medioPrevisto')) nuevo.medioPrevisto = _txt(cambios.medioPrevisto);
  // La intencion de pago SI se puede corregir (a diferencia de J/K/L, que son
  // el hecho y solo los escribe marcarRecibido): decir "esto en realidad ya
  // estaba pago" antes de que llegue no toca ninguna fila del libro.
  if (tiene('pagoPrevisto')) nuevo.pagoPrevisto = normalizarPagoPrevisto(cambios.pagoPrevisto);
  if (tiene('vence')) nuevo.vence = normalizarFecha(cambios.vence);
  if (tiene('notas')) nuevo.notas = _txt(cambios.notas).slice(0, NOTAS_MAX);
  if (tiene('estado')) {
    const e = normalizarEstado(cambios.estado);
    // Volver un pedido a "esperado" después de haberlo pagado dejaría la fila
    // del libro huérfana: el gasto sigue escrito y acá diría que no llegó.
    if (actual.pago !== 'no' && e !== actual.estado) {
      throw new Error('Este pedido ya tiene el pago registrado en el libro; no se puede cambiar su estado desde acá.');
    }
    nuevo.estado = e;
    if (e === 'recibido' && !nuevo.recibidoEl) nuevo.recibidoEl = hoyAR();
    if (e === 'esperado') { nuevo.recibidoEl = ''; nuevo.recibidoPor = ''; }
  }
  nuevo.actualizado = new Date().toISOString();

  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA}!A${actual.rowIndex}:${ULTIMA_COL}${actual.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [_aFila(nuevo)] },
  });
  cache.del(CACHE_PEDIDOS);
  return _publico(nuevo);
}

/**
 * Marca un pedido como recibido y deja anotado qué pasó con la plata.
 *
 * NO escribe en Movimientos: eso ya lo hizo la ruta antes de llamar acá, y por
 * eso `ref` viene de afuera. El orden importa — primero el libro, después esta
 * hoja. Al revés, un fallo de Sheets en el medio dejaría un pedido que dice
 * "pagado" sin ninguna fila que lo respalde.
 */
async function marcarRecibido(id, { pago = 'no', monto = 0, medioPago = '', ref = '', usuario = '' } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  const items = await _leerPedidos(api);
  const actual = items.find(p => p.id === _txt(id));
  if (!actual) throw new Error('No se encontró ese pedido');

  const nuevo = {
    ...actual,
    estado: 'recibido',
    recibidoPor: _txt(usuario) || actual.recibidoPor,
    recibidoEl: actual.recibidoEl || hoyAR(),
    pago: normalizarPago(pago),
    montoPagado: _numero(monto) || actual.montoPagado,
    medioPagoReal: _txt(medioPago) || actual.medioPagoReal,
    refMovimiento: _txt(ref) || actual.refMovimiento,
    actualizado: new Date().toISOString(),
  };

  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA}!A${actual.rowIndex}:${ULTIMA_COL}${actual.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [_aFila(nuevo)] },
  });
  cache.del(CACHE_PEDIDOS);
  return _publico(nuevo);
}

/**
 * Sacar a ese proveedor de ese día.
 *
 * Escribe la fila cancelada que tapa el previsto. Es idempotente por
 * (fecha, proveedor): tocar dos veces el botón no deja dos filas muertas en la
 * hoja, y si ya hay un pedido REAL de ese proveedor ese día no hace nada —
 * el previsto ya estaba tapado y lo que hay que hacer con el pedido real es
 * borrarlo, no esconderlo detrás de una omisión.
 */
async function omitirPrevisto({ fecha, proveedor, nota = '', usuario = '' } = {}) {
  const f = normalizarFecha(fecha);
  if (!f) throw new Error('Falta la fecha');
  const nombre = _txt(proveedor);
  if (!nombre) throw new Error('Falta el proveedor');

  const existentes = (await _loadPedidos()).filter(p =>
    p.fecha === f && p.proveedor.toLowerCase() === nombre.toLowerCase());
  const yaOmitido = existentes.find(esOmision);
  if (yaOmitido) return _publico(yaOmitido);
  const real = existentes.find(p => p.estado !== 'cancelado');
  if (real) {
    throw new Error(`Ya hay un pedido cargado de ${nombre} para ese día. Borralo desde el día en vez de omitirlo.`);
  }

  return crearPedido({
    fecha: f,
    proveedor: nombre,
    estado: 'cancelado',
    origen: ORIGEN_OMITIDO,
    notas: _txt(nota) || (usuario ? `Eliminado de este día — lo marcó ${usuario}` : 'Eliminado de este día'),
  });
}

/**
 * Deshacer: el previsto vuelve a aparecer en ese día.
 *
 * Sólo borra filas que SON una omisión. Con el id de un pedido de verdad no
 * hace nada — este camino lo puede usar el encargado, y un botón que dice
 * "deshacer" no puede terminar borrando una entrega cargada.
 */
async function restaurarOmitido(id) {
  const item = (await _loadPedidos()).find(p => p.id === _txt(id));
  if (!item) throw new Error('No se encontró esa omisión');
  if (!esOmision(item)) throw new Error('Eso no es una omisión del cuadro semanal');
  await borrarPedido(item.id);
  return { id: item.id, fecha: item.fecha, proveedor: item.proveedor };
}

async function borrarPedido(id) {
  await _borrarFila(HOJA, await _buscarFila(_leerPedidos, id));
  cache.del(CACHE_PEDIDOS);
}

// ─── Cuadro semanal ─────────────────────────────────────────────────────────

async function listSemanal() {
  return (await _loadSemanal()).map(_publico);
}

// El cuadro no ofrece domingo ni lunes, así que tampoco los acepta: si el
// navegador mandara uno, la fila quedaría escrita en una columna que la pantalla
// no dibuja — invisible e ineditable, pero generando previstos igual.
function _diaDelCuadro(valor) {
  const dia = normalizarDia(valor);
  if (!dia) throw new Error('Elegí un día de la semana');
  if (!DIAS_CUADRO.includes(dia)) {
    throw new Error(`El cuadro semanal va de martes a sábado: los ${dia} no hay entregas. `
      + 'Si igual esperás algo ese día, cargalo como un pedido suelto arriba.');
  }
  return dia;
}

async function crearSemanal(datos = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const dia = _diaDelCuadro(datos.dia);
  const proveedor = _txt(datos.proveedor);
  if (!proveedor) throw new Error('Falta el proveedor');

  const api = _sheets();
  await _ensureHoja(api, HOJA_SEMANAL, HEADER_SEMANAL, 'I');
  const actuales = await _leerSemanal(api);

  const item = {
    id: `sem${Date.now()}${Math.floor(Math.random() * 100)}`,
    dia,
    // Al final del día que le toca. El orden sólo importa dentro de un día.
    orden: actuales.filter(s => s.dia === dia).length + 1,
    tipo: normalizarTipo(datos.tipo),
    proveedor,
    nota: _txt(datos.nota).slice(0, NOTAS_MAX),
    medioPrevisto: _txt(datos.medioPrevisto),
    activo: true,
    actualizado: new Date().toISOString(),
  };

  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA_SEMANAL}!A:I`,
    valueInputOption: 'RAW',
    requestBody: { values: [_aFilaSemanal(item)] },
  });
  cache.del(CACHE_SEMANAL);
  return item;
}

/**
 * Edita un ítem del cuadro. Mandar `{ dia, orden }` es lo que hace el drag &
 * drop: arrastrar un proveedor de martes a miércoles es exactamente esto.
 *
 * Al cambiar de día se reordena el día de destino insertando en la posición
 * pedida, y se reenumera el de origen. Sin eso, dos ítems terminan con el mismo
 * orden y el cuadro los muestra en un orden que cambia entre recargas.
 */
async function actualizarSemanal(id, cambios = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  const items = await _leerSemanal(api);
  const actual = items.find(s => s.id === _txt(id));
  if (!actual) throw new Error('No se encontró ese ítem del cuadro semanal');

  const tiene = c => Object.prototype.hasOwnProperty.call(cambios, c);
  const nuevo = { ...actual };
  if (tiene('dia')) {
    // Sólo se valida contra el cuadro si el día CAMBIA. Una fila que quedó en un
    // domingo (escrita a mano en la planilla) se sigue pudiendo editar: si no,
    // corregirle la nota fallaría por un día que quien edita no eligió, y la
    // única salida sería moverla — que es justo lo que hay que poder hacer.
    const d = normalizarDia(cambios.dia);
    if (!d) throw new Error('Elegí un día de la semana');
    nuevo.dia = d === actual.dia ? d : _diaDelCuadro(d);
  }
  if (tiene('tipo')) nuevo.tipo = normalizarTipo(cambios.tipo);
  if (tiene('proveedor')) {
    const p = _txt(cambios.proveedor);
    if (!p) throw new Error('El proveedor no puede quedar vacío');
    nuevo.proveedor = p;
  }
  if (tiene('nota')) nuevo.nota = _txt(cambios.nota).slice(0, NOTAS_MAX);
  if (tiene('medioPrevisto')) nuevo.medioPrevisto = _txt(cambios.medioPrevisto);
  if (tiene('activo')) nuevo.activo = cambios.activo !== false && cambios.activo !== 'no';
  nuevo.actualizado = new Date().toISOString();

  // Posición dentro del día de destino: la que vino, o al final.
  const destino = items.filter(s => s.dia === nuevo.dia && s.id !== nuevo.id);
  const pos = tiene('orden') ? Math.max(0, Math.min(destino.length, Math.trunc(_numero(cambios.orden)))) : destino.length;
  destino.splice(pos, 0, nuevo);

  const reenumerar = [...destino];
  if (actual.dia !== nuevo.dia) reenumerar.push(...items.filter(s => s.dia === actual.dia && s.id !== nuevo.id));

  // Una sola llamada para todas las filas que se movieron.
  const data = [];
  const porDia = {};
  for (const s of reenumerar) (porDia[s.dia] = porDia[s.dia] || []).push(s);
  for (const [, lista] of Object.entries(porDia)) {
    lista.forEach((s, i) => {
      const fila = { ...s, orden: i + 1 };
      data.push({ range: `${HOJA_SEMANAL}!A${s.rowIndex}:I${s.rowIndex}`, values: [_aFilaSemanal(fila)] });
    });
  }
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  cache.del(CACHE_SEMANAL);
  return _publico(nuevo);
}

async function borrarSemanal(id) {
  await _borrarFila(HOJA_SEMANAL, await _buscarFila(_leerSemanal, id));
  cache.del(CACHE_SEMANAL);
}

// ─── Borrado (compartido por las dos hojas) ─────────────────────────────────

async function _buscarFila(lector, id) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const items = await lector(_sheets());
  const item = items.find(x => x.id === _txt(id));
  if (!item) throw new Error('No se encontró');
  return item.rowIndex;
}

async function _borrarFila(titulo, rowIndex) {
  const api = _sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === titulo);
  if (!sheet) throw new Error(`No existe la hoja "${titulo}"`);
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: 'ROWS',
      startIndex: rowIndex - 1, endIndex: rowIndex,
    } } }] },
  });
}

function clearCache() { cache.del(CACHE_PEDIDOS); cache.del(CACHE_SEMANAL); cache.del(CACHE_ITEMS); }

module.exports = {
  listPedidos, getPedido, crearPedido, actualizarPedido, marcarRecibido, borrarPedido,
  omitirPrevisto, restaurarOmitido,
  listSemanal, crearSemanal, actualizarSemanal, borrarSemanal,
  // Los renglones de un pedido: qué y cuánto llega, para tildarlo en la puerta.
  itemsDe, agregarItems, marcarItems, borrarItem,
  // Puras, exportadas para poder ejercitarlas sin tocar Google.
  armarDias, estaAbierto, pagoSinDefinir, esOmision, diaSemanaDe, etiquetaDia, normalizarFecha, normalizarDia,
  normalizarEstado, normalizarPago, normalizarTipo, normalizarPagoPrevisto, normalizarEstadoItem, sePagaEnPuerta, hoyAR,
  nuevoId, clearCache,
  DIAS, DIAS_CUADRO, ESTADOS, PAGOS, PAGOS_PREVISTOS, ESTADOS_ITEM, TIPOS,
  HOJA, HOJA_SEMANAL, HOJA_ITEMS, DIAS_ADELANTE, ORIGEN_OMITIDO,
};
