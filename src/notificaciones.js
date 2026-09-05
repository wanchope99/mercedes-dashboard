// ─── Notificaciones: la campanita ───────────────────────────────────────────
//
// Un solo lugar donde se ve todo lo que reclama atención, visible desde
// cualquier sección. Antes había un botón 🔔 con badge rojo, pero vivía adentro
// de Pagos y sólo contaba facturas del bot: si no entrabas ahí, no te enterabas.
//
// ─── La distinción que ordena todo el archivo ───────────────────────────────
//
// Hay DOS cosas que se parecen y no son lo mismo, y tratarlas igual es como se
// arruina una campanita:
//
//   · ESTADO — "5 pagos están vencidos". Sigue siendo verdad hasta que los
//     pagues. Mirarlo no lo cambia. Se calcula cada vez y no se guarda nada.
//   · EVENTO — "Charly anotó que se rompió el extractor". Pasó una vez, en un
//     momento. Una vez que lo viste, ya lo viste.
//
// Casi todo acá se DERIVA: se leen los pagos, los pedidos y la checklist, y se
// saca la conclusión cada vez. La excepción son los AVISOS (src/avisos.js), que
// son hechos de un momento que la planilla no vuelve a guardar —"pagó $14.700
// más de lo que decía la compra"— y que por eso hay que anotar cuando pasan.
// Son la única fuente que llega escrita en vez de calculada, y la única que va
// dirigida a personas concretas y no a un rol.
//
// De ahí la regla: **abrir la campanita apaga los eventos y no toca los
// estados**. Si todo se apagara al abrir, un pago vencido dejaría de gritar
// apenas mirás una vez; si nada se apagara, el número nunca bajaría y en dos
// semanas nadie lo mira. Las dos formas de que esto termine siendo ruido.
//
// ─── Por qué el "ya lo vi" va a la planilla ─────────────────────────────────
//
// Una sola marca por persona: hasta cuándo vio. No una fila por notificación —
// eso crece para siempre y no hace falta, porque un evento es nuevo si pasó
// después de tu última visita y listo.
//
// Va a la planilla y no al navegador por la misma razón por la que el aviso de
// informes usa la columna `Leidos`: esto se mira en el teléfono durante el
// servicio y en la computadora al día siguiente, y lo que viste en uno tiene
// que contar en el otro.
//
// Lo que este módulo NO hace: no manda push, no manda mail, no manda Telegram.
// Es un panel dentro de la app. Y no inventa datos: todo sale de módulos que ya
// existen, así que una fuente caída se salta y las demás siguen.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.NOTIFICACIONES_SHEET || 'Notificaciones Vistas';
// D y E son el "limpiar todas": qué estados silenció esta persona y qué día lo
// hizo. Ver silenciarTodas — el día es lo que hace que caduque solo.
const HEADER = ['Usuario', 'Visto Hasta', 'Actualizado', 'Silenciadas', 'Silenciado Dia'];

const cache = new NodeCache({ stdTTL: 60 });

// Cuántos ítems sueltos como máximo por fuente. Una campanita con 40 líneas es
// una lista, y una lista no se lee: se cierra.
const MAX_POR_FUENTE = 8;

const TZ = 'America/Argentina/Buenos_Aires';
const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

// ─── Puras ──────────────────────────────────────────────────────────────────
const txt = v => (v == null ? '' : String(v)).trim();

// Las notificaciones de PLATA sólo las ven los admin, igual que la sección
// Pagos. La campanita no puede ser la puerta de atrás a algo que la app no
// muestra: si el encargado no ve Pagos, tampoco ve cuánto se debe.
const VISIBLE_PARA = {
  pagos: rol => rol === 'admin',
  mantenimiento: () => true,
  pedidos: () => true,
  // Los avisos ya vienen filtrados por DESTINATARIO, que es más fino que el rol:
  // los tres logins de admin tienen los mismos permisos y un aviso va a personas,
  // no a un rol. Ver src/avisos.js. Volver a filtrar por rol acá sería aplicar
  // dos reglas distintas a la misma pregunta.
  avisos: () => true,
};

const nota = (o) => ({ clase: 'estado', severidad: 'media', cuando: null, ir: null, ...o });

// ─── "Limpiar todas", y por qué no borra ───────────────────────────────────
//
// Abrir la campanita ya apaga los EVENTOS. Lo que queda después son los ESTADOS,
// que no son avisos sino hechos: "5 pagos vencidos" sigue siendo verdad la mires
// o no. Un botón que los borrara de verdad convertiría la campanita en algo que
// miente, y una campanita que miente deja de mirarse a la semana.
//
// Entonces silencia, no borra: guarda QUÉ ids estaban prendidos y DE QUÉ DÍA es
// ese silencio. Mañana, si el pago sigue vencido, vuelve a aparecer. Caduca solo
// —no hay cron ni limpieza— porque lo que se guarda es un día, no un plazo.
//
// Se silencian ids puntuales y no "todo": si mañana... perdón, si en un rato
// aparece un estado NUEVO (un pago que recién vence, un pedido que nadie recibió),
// su id no está en la lista y suena igual. Silenciar "todo lo que venga hasta
// medianoche" taparía justamente lo que uno quiere que le griten.
function silenciados({ silenciadas, silenciadoDia }, hoy) {
  if (!silenciadoDia || silenciadoDia !== hoy) return new Set();
  return new Set((silenciadas || '').split('|').map(x => x.trim()).filter(Boolean));
}

// ── Pagos: estado puro ──────────────────────────────────────────────────────
// Se agrupan por urgencia en vez de emitir una por pago. Con 30 vencidos, 30
// notificaciones no dicen más que una que diga "30": el número del badge tiene
// que seguir queriendo decir algo. El detalle lista a quién se le debe.
function dePagos(pagos, { rol }) {
  if (!VISIBLE_PARA.pagos(rol)) return [];
  const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-AR');
  const grupos = [
    ['vencido', ['vencido', 'vencidos'], 'alta', p => p.urgencia === 'vencido'],
    ['hoy', ['vence hoy', 'vencen hoy'], 'alta', p => p.urgencia === 'hoy'],
    ['pronto', ['vence en los próximos días', 'vencen en los próximos días'], 'media', p => p.urgencia === 'urgente'],
  ];
  const out = [];
  for (const [id, [uno, varios], severidad, filtro] of grupos) {
    const items = (pagos || []).filter(filtro);
    if (!items.length) continue;
    const total = items.reduce((s, p) => s + (p.salidaTotal || 0), 0);
    const quienes = [...new Set(items.map(p => p.proveedor).filter(Boolean))];
    out.push(nota({
      id: `pagos-${id}`,
      fuente: 'pagos',
      severidad,
      titulo: items.length === 1 ? `1 pago ${uno}` : `${items.length} pagos ${varios}`,
      detalle: `${fmt(total)} · ${quienes.slice(0, 4).join(', ')}${quienes.length > 4 ? ` y ${quienes.length - 4} más` : ''}`,
      ir: { tab: 'pagos' },
    }));
  }
  return out;
}

// ── Mantenimiento: eventos ──────────────────────────────────────────────────
// Uno por ítem, porque cada cosa rota es una cosa distinta y el texto ES el
// dato: "se rompió la bisagra de la puerta" no se puede agrupar en un número.
//
// El reloj es la columna `Actualizado`, que es ISO y por eso se puede comparar
// con la marca de visto. Ojo: cambia también cuando alguien EDITA un ítem, no
// sólo cuando lo crea. Es a propósito — que alguien pase algo a urgente o le
// agregue una nota también es algo que pasó y que uno querría ver.
function deMantenimiento(items, { vistoHasta }) {
  return (items || [])
    .filter(i => i.estado !== 'resuelto' && i.actualizado && (!vistoHasta || i.actualizado > vistoHasta))
    .sort((a, b) => (b.actualizado || '').localeCompare(a.actualizado || ''))
    .slice(0, MAX_POR_FUENTE)
    .map(i => nota({
      id: `mant-${i.id}`,
      fuente: 'mantenimiento',
      clase: 'evento',
      severidad: i.prioridad === 'urgente' ? 'alta' : 'media',
      titulo: i.titulo || 'Algo para arreglar',
      detalle: [
        i.prioridad === 'urgente' ? 'Urgente' : null,
        i.sector,
        i.reportadoPor ? `lo anotó ${i.reportadoPor}` : null,
      ].filter(Boolean).join(' · '),
      cuando: i.actualizado,
      ir: { tab: 'mantenimiento' },
    }));
}

// ── Pedidos del día sin recibir: estado ─────────────────────────────────────
// Sólo los de HOY y los atrasados. Un pedido que llega mañana no es una
// notificación, es una agenda.
//
// "Abierto" es exactamente lo que entiende la pantalla de Pedidos: NO RECIBIDO.
// Nada más. Es la misma pregunta que hace `estaAbierto` en src/pedidos.js y
// tiene que seguir siéndolo — duplicar la regla acá con otro criterio haría que
// la campanita y la sección se contradigan, que es la forma más rápida de que
// nadie crea en ninguna de las dos.
//
// Un pedido recibido nunca está abierto, ni siquiera con el pago sin definir:
// eso es otra cosa y tiene su propia notificación abajo (`pedidos-sin-pago`).
const pedidoAbierto = p => p.estado !== 'cancelado' && p.estado !== 'recibido';

// El aviso diario por lo que llegó y nunca se registró en Movimientos.
//
// Es EVENTO y no estado, y el reloj es la medianoche de hoy: mientras la fila
// siga sin pago, cada día vuelve a nacer una notificación con `cuando` nuevo,
// así que aparece una vez, se apaga cuando abrís la campanita, y reaparece al
// día siguiente. Como estado nunca se apagaría y el badge quedaría clavado en
// un número que nadie mira; como evento común se apagaría para siempre la
// primera vez y la fila quedaría enterrada. Una vez por día es el único ritmo
// que sigue molestando sin volverse ruido.
//
// Se apaga solo: en cuanto alguien le registra el pago (efectivo, a cuenta o
// pago aparte), `pago` deja de ser 'no' y el server deja de emitirla.
function dePedidosSinPago(sinPago, { hoy, vistoHasta }) {
  const items = sinPago || [];
  if (!items.length) return [];
  // Medianoche de hoy en Buenos Aires, en ISO UTC para poder compararla como
  // string contra la marca de visto (que se guarda con toISOString()).
  const cuando = new Date(`${hoy}T00:00:00-03:00`).toISOString();
  if (vistoHasta && cuando <= vistoHasta) return [];
  const quienes = [...new Set(items.map(p => p.proveedor).filter(Boolean))];
  return [nota({
    id: 'pedidos-sin-pago',
    fuente: 'pedidos',
    clase: 'evento',
    severidad: 'media',
    cuando,
    titulo: items.length === 1
      ? '1 pedido recibido sin registrar el pago'
      : `${items.length} pedidos recibidos sin registrar el pago`,
    detalle: `Llegaron pero no tienen fila en Movimientos: ${quienes.slice(0, 4).join(', ')}`
      + (quienes.length > 4 ? ` y ${quienes.length - 4} más` : ''),
    ir: { tab: 'pedidos' },
  })];
}

function dePedidos({ dias, sinPago } = {}, { hoy, vistoHasta } = {}) {
  const abiertos = [];
  for (const d of (dias || [])) {
    if (!d || !d.fecha || d.fecha > hoy) continue;
    for (const p of (d.pedidos || [])) {
      if (!pedidoAbierto(p)) continue;
      abiertos.push({ ...p, fecha: d.fecha });
    }
  }
  if (!abiertos.length) return [];
  const atrasados = abiertos.filter(p => p.fecha < hoy);
  const deHoy = abiertos.filter(p => p.fecha === hoy);
  const out = [];
  if (atrasados.length) {
    out.push(nota({
      id: 'pedidos-atrasados', fuente: 'pedidos', severidad: 'alta',
      titulo: atrasados.length === 1 ? '1 pedido de días pasados sin recibir' : `${atrasados.length} pedidos de días pasados sin recibir`,
      detalle: [...new Set(atrasados.map(p => p.proveedor).filter(Boolean))].slice(0, 4).join(', '),
      ir: { tab: 'pedidos' },
    }));
  }
  if (deHoy.length) {
    out.push(nota({
      id: 'pedidos-hoy', fuente: 'pedidos', severidad: 'media',
      titulo: deHoy.length === 1 ? '1 pedido de hoy sin recibir' : `${deHoy.length} pedidos de hoy sin recibir`,
      detalle: [...new Set(deHoy.map(p => p.proveedor).filter(Boolean))].slice(0, 4).join(', '),
      ir: { tab: 'pedidos' },
    }));
  }
  out.push(...dePedidosSinPago(sinPago, { hoy, vistoHasta }));
  return out;
}

// ── Avisos dirigidos: eventos ───────────────────────────────────────────────
//
// La única fuente que no se DERIVA de nada: son hechos que alguien anotó en el
// momento en que pasaron, porque después la planilla ya no los guarda (ver el
// encabezado de src/avisos.js). Acá sólo se traducen a notificación.
//
// El filtro de quién los ve ya lo hizo `paraUsuario`, contra el destinatario
// escrito en la fila. Uno por aviso y sin agrupar, por lo mismo que
// Mantenimiento: el texto ES el dato — "se pagó $14.700 de más" no se puede
// resumir en un número.
function deAvisos(avisos, { usuario, vistoHasta, ahora } = {}) {
  const { paraUsuario } = require('./avisos');
  return paraUsuario(avisos, { usuario, vistoHasta, ahora }).map(a => nota({
    id: `aviso-${a.id}`,
    fuente: 'avisos',
    clase: 'evento',
    severidad: a.severidad || 'alta',
    titulo: a.titulo,
    detalle: a.detalle,
    cuando: a.cuando,
    ir: a.ir ? { tab: a.ir } : null,
  }));
}

// ── "Falta cargar el cierre de cocina": SE FUE (05/09/2026) ─────────────────
//
// Decisión de Gonzalo. Era un ESTADO, o sea que no se apagaba al abrir el panel:
// mientras el cierre de anoche no estuviera cargado seguía ahí, y volvía cada
// mañana en la que la cocina no lo hubiera cargado todavía.
//
// Es el mismo problema que este repo ya documentó al sacar el control semanal de
// facturación de los informes: **una alarma que suena todas las veces deja de
// escucharse**, y peor, se lleva puesta la atención de las que sí importan. La
// campanita queda para lo que es un hecho puntual —un pago vencido, algo que se
// rompió, un aviso dirigido— y no para recordar una rutina diaria que la cocina
// ya sabe que tiene.
//
// Se sacó ENTERO y no se dejó apagado: la fuente, su entrada en `VISIBLE_PARA` y
// —lo que de verdad se gana— la lectura de la planilla de cierres que hacía
// `getNotificaciones` en cada consulta de la campanita, que ahora no compra nada.
// Con ella se fue también `servicioAnteriorA`, que existía sólo para esto.
//
// La pantalla no cambió: Operación › Cierre sigue estando y el resumen posterior
// al arqueo sigue apuntando ahí. Lo que se dejó de hacer es reclamarlo.

// El armado, puro: entra lo que ya leyeron otros módulos, sale la lista.
function armar({ pagos, mantenimiento, pedidos, avisos },
               { rol, usuario, vistoHasta, hoy, callados = new Set() } = {}) {
  const todas = [
    ...dePagos(pagos, { rol }),
    ...deMantenimiento(mantenimiento, { vistoHasta }),
    ...dePedidos(pedidos, { hoy, vistoHasta }),
    ...deAvisos(avisos, { usuario, vistoHasta }),
  ].filter(n => VISIBLE_PARA[n.fuente] ? VISIBLE_PARA[n.fuente](rol) : true)
   // Sólo se silencian ESTADOS. Un evento ya se apaga solo al abrir el panel, y
   // silenciarlo además sería apagar dos veces lo mismo.
   .filter(n => !(n.clase === 'estado' && callados.has(n.id)));

  const orden = { alta: 0, media: 1, baja: 2 };
  todas.sort((a, b) => (orden[a.severidad] ?? 9) - (orden[b.severidad] ?? 9)
    || (b.cuando || '').localeCompare(a.cuando || ''));

  // El número del badge: los estados cuentan siempre —siguen pasando— y los
  // eventos sólo mientras sean nuevos.
  const cuenta = todas.filter(n => n.clase === 'estado' || n.nuevo !== false).length;
  return { notificaciones: todas, cuenta };
}

// ─── I/O ────────────────────────────────────────────────────────────────────
function _sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }),
  });
}

async function _ensureHoja(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOJA } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A1:C1`,
      valueInputOption: 'RAW', requestBody: { values: [HEADER] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

async function _leerVistos(api) {
  try {
    const r = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:E` });
    const filas = r.data.values || [];
    const out = [];
    for (let i = 1; i < filas.length; i++) {
      const f = filas[i] || [];
      if (!txt(f[0])) continue;
      out.push({
        usuario: txt(f[0]), vistoHasta: txt(f[1]),
        silenciadas: txt(f[3]), silenciadoDia: txt(f[4]),
        rowIndex: i + 1,
      });
    }
    return out;
  } catch (e) {
    if (/unable to parse range/i.test(e.message || '')) return [];
    throw e;
  }
}

// No poder leer la marca NO puede dejar sin campanita: se degrada a "no vio
// nada, no silenció nada", que muestra de más y nunca de menos.
const _MARCA_VACIA = { vistoHasta: '', silenciadas: '', silenciadoDia: '' };

async function marcaDe(usuario) {
  if (!SPREADSHEET_ID || !usuario) return _MARCA_VACIA;
  const hit = cache.get(`visto:${usuario}`);
  if (hit !== undefined) return hit;
  try {
    const fila = (await _leerVistos(_sheets())).find(v => v.usuario === usuario);
    const val = fila
      ? { vistoHasta: fila.vistoHasta, silenciadas: fila.silenciadas, silenciadoDia: fila.silenciadoDia }
      : _MARCA_VACIA;
    cache.set(`visto:${usuario}`, val);
    return val;
  } catch (e) {
    console.error(`Notificaciones: no se pudo leer la marca (${e.message})`);
    return _MARCA_VACIA;
  }
}

async function vistoDe(usuario) { return (await marcaDe(usuario)).vistoHasta; }

// Una sola función escribe la fila, y por eso 'visto' y 'silenciar' no pueden
// pisarse: quien no manda un campo conserva el que ya estaba.
async function _guardarMarca(usuario, cambios) {
  if (!usuario) throw new Error('Falta el usuario');
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  await _ensureHoja(api);
  const ahora = new Date().toISOString();
  const filas = await _leerVistos(api);
  const fila = filas.find(v => v.usuario === usuario);
  const previo = fila || _MARCA_VACIA;
  const marca = {
    vistoHasta: cambios.vistoHasta !== undefined ? cambios.vistoHasta : (previo.vistoHasta || ''),
    silenciadas: cambios.silenciadas !== undefined ? cambios.silenciadas : (previo.silenciadas || ''),
    silenciadoDia: cambios.silenciadoDia !== undefined ? cambios.silenciadoDia : (previo.silenciadoDia || ''),
  };
  const valores = [marca.vistoHasta, ahora, marca.silenciadas, marca.silenciadoDia];

  if (fila) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!B${fila.rowIndex}:E${fila.rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [valores] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:E`,
      valueInputOption: 'RAW', requestBody: { values: [[usuario, ...valores]] },
    });
  }
  // Las hojas creadas antes de que existieran D y E tienen el encabezado corto:
  // se completa al pasar, así la planilla se sigue explicando sola.
  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!D1:E1`,
    valueInputOption: 'RAW', requestBody: { values: [[HEADER[3], HEADER[4]]] },
  }).catch(() => {});

  cache.set(`visto:${usuario}`, marca);
  return marca;
}

async function marcarVisto(usuario) {
  const m = await _guardarMarca(usuario, { vistoHasta: new Date().toISOString() });
  return { usuario, vistoHasta: m.vistoHasta };
}

/**
 * "Limpiar todas": deja la campanita en cero por hoy.
 *
 * Apaga los eventos (marca visto) y SILENCIA los estados que están prendidos en
 * este momento, guardando sus ids y el día. No los borra — ver el comentario de
 * `silenciados`: un pago vencido sigue vencido, y mañana vuelve a sonar.
 *
 * Los ids los calcula el server, no los manda el navegador: si los mandara,
 * bastaría con inventarse uno para apagar algo que nunca se vio.
 */
async function limpiarTodas({ usuario, rol } = {}) {
  const hoy = hoyAR();
  // Los que ya estaban callados HOY se conservan. Sin esto, el segundo toque
  // desilenciaba todo: getNotificaciones ya devuelve la lista filtrada, así que
  // la segunda vez vendría vacía y se guardaría vacía. Se acumula, y el día es
  // lo que lo vacía solo.
  const previos = silenciados(await marcaDe(usuario), hoy);
  const actuales = await getNotificaciones({ usuario, rol });
  for (const n of actuales.notificaciones) {
    if (n.clase === 'estado') previos.add(n.id);
  }
  const ids = [...previos];
  const m = await _guardarMarca(usuario, {
    vistoHasta: new Date().toISOString(),
    silenciadas: ids.join('|'),
    silenciadoDia: hoy,
  });
  return { usuario, silenciadas: ids.length, vistoHasta: m.vistoHasta };
}

// Cada fuente va envuelta: una caída no puede dejar sin campanita a las otras.
// Es la misma regla que las notas en los informes — un panel incompleto es peor
// que uno completo y muchísimo mejor que ninguno.
const seguro = async (etiqueta, fn, porDefecto) => {
  try { return await fn(); }
  catch (e) { console.error(`Notificaciones: falló ${etiqueta} (${e.message})`); return porDefecto; }
};

async function getNotificaciones({ usuario, rol } = {}) {
  const esAdmin = rol === 'admin';
  const hoy = hoyAR();

  const [marca, pagos, mantenimiento, pedidos, avisos] = await Promise.all([
    marcaDe(usuario),
    esAdmin ? seguro('pagos', async () => {
      const { getMovimientos, getComprasEnCuotas } = require('./sheets');
      const { calcUrgencia } = require('./urgencia');
      const todos = await getMovimientos();
      return todos
        .filter(m => m.tipo === 'Gasto' && !m.pagado && !m.esCambio && !m.esFondeo && !m.esCompraEnCuotas)
        .map(p => ({ ...p, ...calcUrgencia(p.vencimiento) }));
    }, []) : Promise.resolve([]),
    seguro('mantenimiento', async () => (await require('./mantenimiento').listMantenimiento()).items, []),
    // El objeto entero y no sólo `.dias`: `sinPago` vive al lado y no está
    // adentro de ningún día — justamente porque no traba ninguno.
    seguro('pedidos', async () => require('./pedidos').listPedidos({ dias: 1 }), {}),
    // Acá había una quinta lectura, la de la planilla de cierres de cocina, que
    // se hacía en CADA consulta de la campanita para poder decir "falta cargar
    // el cierre". Con ese aviso fuera (05/09/2026) no compra nada, así que se
    // fue con él: la campanita hace una lectura menos.
    seguro('avisos', async () => require('./avisos').listar(), []),
  ]);

  return armar(
    { pagos, mantenimiento, pedidos, avisos },
    {
      rol, usuario, hoy,
      vistoHasta: marca.vistoHasta,
      callados: silenciados(marca, hoy),
    },
  );
}

function clearCache() { cache.flushAll(); }

module.exports = {
  getNotificaciones, marcarVisto, limpiarTodas, vistoDe, marcaDe, clearCache,
  // Puras
  armar, dePagos, deMantenimiento, dePedidos, dePedidosSinPago, deAvisos,
  silenciados,
  HOJA, MAX_POR_FUENTE,
};
