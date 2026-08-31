// ─── Qué días abre el bar ───────────────────────────────────────────────────
//
// **Mercedes abre de MARTES a SÁBADO.** Domingo y lunes está cerrado.
//
// Vive en un solo archivo porque es un hecho del negocio que atraviesa medio
// sistema, y hasta el 18/8/2026 cada lugar lo sabía a medias: `pedidos.js` ya
// tenía el cuadro semanal de martes a sábado, pero el analista del salón sólo
// salteaba los lunes —así que marcaba cada domingo como "un día que suele abrir
// y no abrió"—, el prompt de los tres agentes decía "cierra los lunes" a secas,
// y la campanita pedía el cierre de cocina del lunes.
//
// Si algún día cambian los días de apertura, se cambia acá y no en seis lados.
// Por eso además es configurable por variable de entorno: un cambio de horario
// no debería necesitar un deploy.

// Domingo = 0, igual que Date#getDay(). Martes a sábado = 2,3,4,5,6.
const DIAS_SERVICIO = (process.env.DIAS_SERVICIO || '2,3,4,5,6')
  .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);

const NOMBRES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const DIAS_SERVICIO_NOMBRES = DIAS_SERVICIO.map(d => NOMBRES[d]);
const DIAS_SERVICIO_POR_SEMANA = DIAS_SERVICIO.length;

// Frase lista para meter en un prompt o en un texto de pantalla, derivada de la
// lista y no escrita a mano — que fue justamente el problema.
function comoSeDice() {
  if (!DIAS_SERVICIO_NOMBRES.length) return 'no abre ningún día';
  if (DIAS_SERVICIO_NOMBRES.length === 1) return `abre sólo los ${DIAS_SERVICIO_NOMBRES[0]}`;
  const cerrados = NOMBRES.filter((_, i) => !DIAS_SERVICIO.includes(i));
  const lista = ns => ns.length === 1 ? ns[0] : `${ns.slice(0, -1).join(', ')} y ${ns[ns.length - 1]}`;
  // Contiguos: se dice "de X a Y". Si no, se enumeran.
  const ordenados = [...DIAS_SERVICIO].sort((a, b) => a - b);
  const contiguos = ordenados.every((d, i) => i === 0 || d === ordenados[i - 1] + 1);
  const abre = contiguos
    ? `abre de ${NOMBRES[ordenados[0]]} a ${NOMBRES[ordenados[ordenados.length - 1]]}`
    : `abre los ${lista(DIAS_SERVICIO_NOMBRES)}`;
  return cerrados.length ? `${abre}: ${lista(cerrados)} ${cerrados.length === 1 ? 'está cerrado' : 'están cerrados'}` : abre;
}

// Acepta 'AAAA-MM-DD' o un Date. Se construye en hora local a propósito: un
// `new Date('2026-08-17')` se interpreta como UTC y en Argentina cae un día
// antes, que es exactamente el tipo de error que este archivo viene a evitar.
function _aDate(fecha) {
  if (fecha instanceof Date) return fecha;
  const [y, m, d] = String(fecha || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ─── Excepciones: el día suelto que rompe el cuadro ─────────────────────────
//
// El cuadro semanal dice qué pasa SIEMPRE, y siempre hay un día que no. Un
// evento un lunes —ya pasó, el 25/5/2026— es un día de servicio aunque el bar
// esos días esté cerrado; un martes que no se abrió no lo es aunque el cuadro
// diga que sí. Sin esto, las dos cosas se arreglan a mano en cada pantalla que
// las mire, o no se arreglan.
//
// Van por variable de entorno, como los días de apertura: son hechos del
// negocio, cambian solos y no deberían necesitar un deploy.
//
//   DIAS_ABIERTO_EXTRA="2026-08-17:Evento"           abrió un día que cierra
//   DIAS_CERRADO_EXTRA="2026-09-08:Corte de luz"     no abrió un día que abre
//
// El motivo es opcional y viaja: una cantidad de feriados distinta a la del
// almanaque tiene que poder explicarse sola en la pantalla.
//
// Esto vale para TODO lo que pregunte por días de servicio —los servicios del
// mes que prorratean un sueldo, los feriados que se pagan, el promedio por día
// abierto— y por eso vive acá y no en la nómina.
function _fechasConMotivo(txt) {
  const m = new Map();
  for (const item of String(txt || '').split(',')) {
    const s = item.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    const fecha = (i === -1 ? s : s.slice(0, i)).trim();
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fecha)) continue;
    m.set(fecha, (i === -1 ? '' : s.slice(i + 1).trim()));
  }
  return m;
}

const ABIERTO_EXTRA = _fechasConMotivo(process.env.DIAS_ABIERTO_EXTRA);
const CERRADO_EXTRA = _fechasConMotivo(process.env.DIAS_CERRADO_EXTRA);

// La única función que contesta "¿el bar abrió/abre este día?". Todo lo demás
// pasa por acá: la excepción le gana al cuadro semanal, que es el punto.
function _abre(d) {
  const f = iso(d);
  if (ABIERTO_EXTRA.has(f)) return true;
  if (CERRADO_EXTRA.has(f)) return false;
  return DIAS_SERVICIO.includes(d.getDay());
}

// Qué se dijo de un día suelto, o null. `abre` es lo que pasó y `motivo` por qué.
function excepcionDe(fecha) {
  const d = _aDate(fecha);
  if (!d) return null;
  const f = iso(d);
  if (ABIERTO_EXTRA.has(f)) return { fecha: f, abre: true, motivo: ABIERTO_EXTRA.get(f) || 'abrió fuera de lo habitual' };
  if (CERRADO_EXTRA.has(f)) return { fecha: f, abre: false, motivo: CERRADO_EXTRA.get(f) || 'no abrió' };
  return null;
}

function esDiaDeServicio(fecha) {
  const d = _aDate(fecha);
  return d ? _abre(d) : false;
}

// El último día que el bar efectivamente abrió ANTES de la fecha dada. Un lunes
// devuelve el sábado, no el domingo. Es lo que contesta "¿falta cargar el
// cierre de anoche?" sin reclamar por una noche que no existió.
function ultimoDiaDeServicio(fecha, { incluirElMismo = false } = {}) {
  let d = _aDate(fecha);
  if (!d) return null;
  if (!incluirElMismo) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  for (let i = 0; i < 14; i++) {
    if (_abre(d)) return iso(d);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  }
  return null;   // no debería pasar salvo que no abra ningún día
}

// Cuántos días de servicio hay entre dos fechas, inclusive. Sirve para promediar
// por día abierto en vez de por día calendario.
function diasDeServicioEntre(desde, hasta) {
  let d = _aDate(desde);
  const fin = _aDate(hasta);
  if (!d || !fin) return 0;
  let n = 0;
  while (d <= fin) {
    if (_abre(d)) n++;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return n;
}

// ─── Feriados nacionales ────────────────────────────────────────────────────
//
// Un feriado sólo cuesta plata si CAE EN UN DÍA DE SERVICIO. El 17 de agosto de
// 2026 fue lunes: el bar estaba cerrado, nadie lo trabajó y no corresponde el
// adicional. Hasta el 31/8/2026 la nómina no sabía nada de esto —la cantidad de
// feriados del mes se tipeaba a mano— y así agosto quedó con un feriado cobrado
// que nunca se trabajó. Por eso los feriados viven acá, al lado de los días de
// apertura: son la misma pregunta mirada dos veces.
//
// **Las fechas se DERIVAN, no se copian de una lista.** Una tabla escrita a mano
// se queda vieja el 1 de enero sin que nada avise, y el error se ve como plata
// de menos —o de más— en un sueldo. Las reglas son las de la ley 27.399:
//
//   · Inamovibles: caen siempre en la misma fecha.
//   · De Pascua: carnaval (lunes y martes anteriores al miércoles de ceniza) y
//     Viernes Santo, que se calculan desde el domingo de Pascua.
//   · Trasladables (17/6, 17/8, 12/10 y 20/11): si caen martes o miércoles se
//     corren al lunes ANTERIOR; si caen jueves o viernes, al lunes SIGUIENTE.
//     Sábado, domingo y lunes quedan donde están. Es la regla que en 2026 se
//     lleva el feriado de Güemes del miércoles 17 de junio al lunes 15 —o sea,
//     de un día de servicio a uno con el bar cerrado— y el del 20 de noviembre
//     del viernes al lunes 23.
//
// Lo que NO entra: los "días no laborables con fines turísticos" (los puentes),
// que los fija un decreto año por año y no son feriados: no pagan adicional. Si
// algún año hay que sumar una fecha que la ley no deriva, va por la variable de
// entorno FERIADOS_EXTRA (`2026-12-24:Nochebuena,2026-12-31:Fin de año`), que no
// necesita deploy.
const FERIADOS_INAMOVIBLES = [
  [1, 1, 'Año Nuevo'],
  [3, 24, 'Día de la Memoria'],
  [4, 2, 'Día del Veterano y de los Caídos en Malvinas'],
  [5, 1, 'Día del Trabajador'],
  [5, 25, 'Día de la Revolución de Mayo'],
  [6, 20, 'Paso a la Inmortalidad del General Belgrano'],
  [7, 9, 'Día de la Independencia'],
  [12, 8, 'Inmaculada Concepción de María'],
  [12, 25, 'Navidad'],
];

const FERIADOS_TRASLADABLES = [
  [6, 17, 'Paso a la Inmortalidad del General Güemes'],
  [8, 17, 'Paso a la Inmortalidad del General San Martín'],
  [10, 12, 'Día del Respeto a la Diversidad Cultural'],
  [11, 20, 'Día de la Soberanía Nacional'],
];

// Domingo de Pascua (Meeus/Butcher, calendario gregoriano). De acá salen el
// Viernes Santo y los dos días de carnaval, que son los únicos feriados que se
// mueven por algo que no es el día de la semana.
function _pascua(anio) {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(anio, mes - 1, dia);
}

const _masDias = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// La regla de traslado de la ley 27.399. Devuelve la fecha donde el feriado se
// termina festejando, que es la única que importa para saber si se trabajó.
function _trasladar(d) {
  const dia = d.getDay();
  if (dia === 2 || dia === 3) return _masDias(d, dia === 2 ? -1 : -2);   // martes/miércoles → lunes anterior
  if (dia === 4 || dia === 5) return _masDias(d, dia === 4 ? 4 : 3);     // jueves/viernes → lunes siguiente
  return d;                                                             // sábado, domingo y lunes quedan
}

// Fechas sueltas que la ley no deriva, por variable de entorno. Formato
// `AAAA-MM-DD:Nombre`, separadas por coma. Sin nombre se llaman "Feriado".
const FERIADOS_EXTRA = (process.env.FERIADOS_EXTRA || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => {
    const i = s.indexOf(':');
    return {
      fecha: (i === -1 ? s : s.slice(0, i)).trim(),
      nombre: (i === -1 ? '' : s.slice(i + 1).trim()) || 'Feriado',
    };
  })
  .filter(f => _aDate(f.fecha));

const _cacheFeriados = new Map();

// Todos los feriados de un año, ordenados por fecha. Cada uno dice qué día de la
// semana cae y si ese día el bar abre: `servicio` es lo único que decide si hay
// adicional que pagar.
function feriadosDelAnio(anio) {
  if (_cacheFeriados.has(anio)) return _cacheFeriados.get(anio);
  const pascua = _pascua(anio);
  const crudos = [
    ...FERIADOS_INAMOVIBLES.map(([m, d, nombre]) => ({ d: new Date(anio, m - 1, d), nombre })),
    { d: _masDias(pascua, -48), nombre: 'Carnaval' },
    { d: _masDias(pascua, -47), nombre: 'Carnaval' },
    { d: _masDias(pascua, -2), nombre: 'Viernes Santo' },
    ...FERIADOS_TRASLADABLES.map(([m, d, nombre]) => ({ d: _trasladar(new Date(anio, m - 1, d)), nombre })),
    ...FERIADOS_EXTRA.map(f => ({ d: _aDate(f.fecha), nombre: f.nombre })).filter(f => f.d.getFullYear() === anio),
  ];
  const out = crudos
    .map(({ d, nombre }) => ({
      fecha: iso(d),
      nombre,
      dia: NOMBRES[d.getDay()],
      // Por `_abre` y no por el cuadro semanal: si ese lunes se abrió por un
      // evento, el feriado se trabajó y se paga. El motivo viaja para que la
      // pantalla pueda decir por qué un lunes cuenta.
      servicio: _abre(d),
      excepcion: excepcionDe(iso(d)),
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  _cacheFeriados.set(anio, out);
  return out;
}

// Los feriados de un mes (1-12). Vienen TODOS, también los que caen con el bar
// cerrado: la pantalla los muestra para poder decir "el 17 cayó lunes" en vez de
// dejar un cero sin explicación.
function feriadosDelMes(anio, mes) {
  const pref = `${anio}-${String(mes).padStart(2, '0')}-`;
  return feriadosDelAnio(anio).filter(f => f.fecha.startsWith(pref));
}

// Los del mes que caen en un día que el bar abre: los únicos que se pagan.
const feriadosDeServicioDelMes = (anio, mes) => feriadosDelMes(anio, mes).filter(f => f.servicio);

// El feriado de una fecha, o null. Acepta 'AAAA-MM-DD' o Date, como el resto.
function feriadoDe(fecha) {
  const d = _aDate(fecha);
  if (!d) return null;
  return feriadosDelAnio(d.getFullYear()).find(f => f.fecha === iso(d)) || null;
}

const esFeriado = fecha => Boolean(feriadoDe(fecha));

module.exports = {
  DIAS_SERVICIO, DIAS_SERVICIO_NOMBRES, DIAS_SERVICIO_POR_SEMANA, NOMBRES,
  esDiaDeServicio, ultimoDiaDeServicio, diasDeServicioEntre, comoSeDice,
  feriadosDelAnio, feriadosDelMes, feriadosDeServicioDelMes, feriadoDe, esFeriado,
  excepcionDe,
};
