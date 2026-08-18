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

function esDiaDeServicio(fecha) {
  const d = _aDate(fecha);
  return d ? DIAS_SERVICIO.includes(d.getDay()) : false;
}

// El último día que el bar efectivamente abrió ANTES de la fecha dada. Un lunes
// devuelve el sábado, no el domingo. Es lo que contesta "¿falta cargar el
// cierre de anoche?" sin reclamar por una noche que no existió.
function ultimoDiaDeServicio(fecha, { incluirElMismo = false } = {}) {
  let d = _aDate(fecha);
  if (!d) return null;
  if (!incluirElMismo) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  for (let i = 0; i < 14; i++) {
    if (DIAS_SERVICIO.includes(d.getDay())) return iso(d);
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
    if (DIAS_SERVICIO.includes(d.getDay())) n++;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return n;
}

module.exports = {
  DIAS_SERVICIO, DIAS_SERVICIO_NOMBRES, DIAS_SERVICIO_POR_SEMANA, NOMBRES,
  esDiaDeServicio, ultimoDiaDeServicio, diasDeServicioEntre, comoSeDice,
};
