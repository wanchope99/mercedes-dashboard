// ─── Días que no cuentan: eventos puntuales ─────────────────────────────────
//
// Un día que no fue un servicio normal hace daño DOS veces, y la segunda es la
// grave:
//
//   1. Aparece como hallazgo ("un lunes con 90 cubiertos", "abrió al mediodía").
//   2. Entra en la REFERENCIA contra la que se compara todo lo demás. Un evento
//      de 200 cubiertos un lunes deja "el lunes suele abrir" instalado en la
//      serie durante meses, y a partir de ahí cada lunes cerrado —que es lo
//      normal— se marca como día sin servicio.
//
// Sacarlo del análisis no es esconder un dato: es no comparar contra algo que no
// se va a repetir. El evento sigue estando en Fudo, en la caja y en el balance
// del mes; lo único que cambia es que ningún agente lo usa como vara.
//
// CÓMO AGREGAR UNO: una línea en DIAS_EXCLUIDOS con la fecha y por qué. También
// se puede sin deploy, con la variable de entorno INFORMES_DIAS_EXCLUIDOS
// ("2026-05-25,2026-12-24"), que se suma a esta lista.
//
// Qué NO va acá: un día flojo, una noche récord, un feriado en el que se trabajó
// normal. Eso es el negocio pasando, y es justo lo que los informes tienen que
// ver. Acá va sólo lo que no fue un servicio del bar.

const DIAS_EXCLUIDOS = [
  {
    fecha: '2026-05-25',
    motivo: 'Turno puntual armado para el evento del 25 de mayo. Cayó lunes —el día '
      + 'que el bar no abre— y se generó sólo para ese evento. No es un servicio del bar '
      + 'y no vuelve a pasar: no se compara nada contra él ni se lo menciona como hallazgo.',
  },
];

const extraDelEntorno = () => (process.env.INFORMES_DIAS_EXCLUIDOS || '')
  .split(',')
  .map(s => s.trim())
  .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
  .map(fecha => ({ fecha, motivo: 'Marcado como día no comparable en la configuración.' }));

// Se arma en cada llamada y no una sola vez al cargar el módulo: así cambiar la
// variable de entorno tiene efecto en el próximo informe y no en el próximo
// deploy.
const listaExcluidos = () => {
  const m = new Map();
  for (const d of [...DIAS_EXCLUIDOS, ...extraDelEntorno()]) if (!m.has(d.fecha)) m.set(d.fecha, d);
  return [...m.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
};

const esDiaExcluido = fecha => listaExcluidos().some(d => d.fecha === fecha);

const motivoDe = fecha => (listaExcluidos().find(d => d.fecha === fecha) || {}).motivo || null;

// Devuelve los días utilizables y, aparte, los que se sacaron. Los excluidos se
// devuelven a propósito en vez de desaparecer: el informe los nombra en una
// línea del contexto para que nadie tenga que adivinar por qué falta un día.
function separarExcepciones(dias) {
  const excluidos = [];
  const utiles = [];
  for (const d of (dias || [])) {
    if (d && d.fecha && esDiaExcluido(d.fecha)) excluidos.push({ fecha: d.fecha, motivo: motivoDe(d.fecha) });
    else utiles.push(d);
  }
  return { dias: utiles, excluidos };
}

module.exports = { DIAS_EXCLUIDOS, listaExcluidos, esDiaExcluido, motivoDe, separarExcepciones };
