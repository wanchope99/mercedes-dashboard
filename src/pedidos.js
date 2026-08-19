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
//     L MedioPagoReal | M RefMovimiento | N Origen | O Notas | P Actualizado
//
//   Hoja "Pedidos Semanal" — el cuadro de referencia por día de semana:
//     A ID | B Dia | C Orden | D Tipo | E Proveedor | F Nota | G MedioPrevisto |
//     H Activo | I Actualizado
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

const HEADER = ['ID', 'Fecha', 'Proveedor', 'Detalle', 'CostoEstimado', 'MedioPrevisto',
                'Estado', 'RecibidoPor', 'RecibidoEl', 'Pago', 'MontoPagado', 'MedioPagoReal',
                'RefMovimiento', 'Origen', 'Notas', 'Actualizado'];
const HEADER_SEMANAL = ['ID', 'Dia', 'Orden', 'Tipo', 'Proveedor', 'Nota', 'MedioPrevisto',
                        'Activo', 'Actualizado'];

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

// El estado del pago es de tres valores y no un sí/no: "todavía nada" y "llegó,
// quedó a pagar" son situaciones distintas y la segunda tiene una fila en el
// libro esperando. Sin el tercer valor, un pedido recibido sin pagar se
// confunde con uno que nadie tocó.
const PAGOS = ['no', 'pagado', 'a pagar'];
const PAGO_DEFAULT = 'no';

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
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${titulo}!A1:${ultimaCol}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

async function _leerPedidos(api) {
  let rows;
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:P` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA, HEADER, 'P');
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
          p.refMovimiento, p.origen, p.notas, p.actualizado];
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
    const delDia = (porDia[fecha] || []).filter(p => p.estado !== 'cancelado');
    const nombres = new Set(delDia.map(p => p.proveedor.toLowerCase()));
    const dia = diaSemanaDe(fecha);
    const delCuadro = activos.filter(s => s.dia === dia);

    // Un día pasado no anuncia lo que "suele traer": eso ya no va a pasar.
    // Mostrar previstos ahí sería ofrecer recibir algo de la semana pasada.
    const previstos = atrasado ? [] : delCuadro
      .filter(s => s.tipo === 'entrega' && !nombres.has(s.proveedor.toLowerCase()))
      .map(s => ({ ...s, fecha }));
    const paraPedir = atrasado ? [] : delCuadro.filter(s => s.tipo === 'pedir');

    return {
      fecha,
      diaSemana: dia,
      label: etiquetaDia(fecha),
      esHoy: fecha === hoy,
      atrasado,
      pedidos: delDia.map(_publico),
      previstos: previstos.map(_publico),
      paraPedir: paraPedir.map(_publico),
      abiertos: delDia.filter(estaAbierto).length,
      totalEstimado: delDia.reduce((s, p) => s + (p.montoPagado || p.costoEstimado || 0), 0),
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

async function listPedidos({ dias = DIAS_ADELANTE } = {}) {
  const [pedidos, semanal] = await Promise.all([_loadPedidos(), _loadSemanal()]);
  const hoy = hoyAR();
  return {
    hoy,
    dias: armarDias(pedidos, semanal, { hoy, dias }),
    // Las filas que llegaron y nunca dijeron qué pasó con la plata. Van aparte
    // de `dias` a propósito: no traban ningún día (ver estaAbierto) pero
    // alguien tiene que enterarse de que existen. Sólo las de días PASADOS —
    // un pedido recibido hace un rato todavía no es un olvido, es el rato que
    // tarda alguien en cargar el monto.
    sinPago: pedidos
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

async function crearPedido(datos = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const proveedor = _txt(datos.proveedor);
  if (!proveedor) throw new Error('Falta el proveedor');
  const fecha = normalizarFecha(datos.fecha) || hoyAR();

  const api = _sheets();
  await _ensureHoja(api, HOJA, HEADER, 'P');

  const item = {
    // El id va a la columna H de Movimientos como ID de compra cuando el pedido
    // se paga, y ésa es la clave de idempotencia del libro: tiene que ser único
    // y estable. Se le pone prefijo para reconocerlo de un vistazo en la hoja.
    id: `ped${Date.now()}${Math.floor(Math.random() * 100)}`,
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
  };

  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA}!A:P`,
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
    range: `${HOJA}!A${actual.rowIndex}:P${actual.rowIndex}`,
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
    range: `${HOJA}!A${actual.rowIndex}:P${actual.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [_aFila(nuevo)] },
  });
  cache.del(CACHE_PEDIDOS);
  return _publico(nuevo);
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

function clearCache() { cache.del(CACHE_PEDIDOS); cache.del(CACHE_SEMANAL); }

module.exports = {
  listPedidos, getPedido, crearPedido, actualizarPedido, marcarRecibido, borrarPedido,
  listSemanal, crearSemanal, actualizarSemanal, borrarSemanal,
  // Puras, exportadas para poder ejercitarlas sin tocar Google.
  armarDias, estaAbierto, pagoSinDefinir, diaSemanaDe, etiquetaDia, normalizarFecha, normalizarDia,
  normalizarEstado, normalizarPago, normalizarTipo, hoyAR,
  clearCache,
  DIAS, DIAS_CUADRO, ESTADOS, PAGOS, TIPOS, HOJA, HOJA_SEMANAL, DIAS_ADELANTE,
};
