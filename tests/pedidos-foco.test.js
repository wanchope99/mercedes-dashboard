// Cuál de los días de Pedidos se dibuja grande.
//
// Desde el 07/09/2026 la lista de días tiene UN día en foco: se dibuja como un
// bloque con su contenido a la vista, en vez de un renglón que hay que abrir.
// Es la respuesta que viene a buscar el cocinero que entra a las 10 — qué llega
// y si hay que pagarlo — sin tocar nada.
//
// La regla la pidió Gonzalo y tiene una sola vuelta: el foco es HOY, salvo que
// hoy sea domingo o lunes, los dos días en que no entrega nadie (`SIN_ENTREGA`).
// Un domingo la pregunta útil no es "¿qué llega hoy?" —nada— sino qué hay que
// esperar el martes, que es para lo que se abre la pantalla ese día.
//
// Se prueba acá y no a ojo porque es aritmética de calendario sobre `getDay()`,
// que es donde esta app ya se equivocó una vez: los atajos de fecha del modal de
// mover armaban los días con `toISOString()` y después de las 21:00 en Argentina
// cada uno quedaba corrido un día de su propia etiqueta.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

// Saca del index las dos piezas que deciden esto y las ejecuta de verdad: leer
// el texto contesta "¿está escrito?"; correrlo contesta "¿qué día devuelve?".
function cargarDiaEnFoco(index) {
  const sinEntrega = index.match(/const SIN_ENTREGA = \[[^\]]*\];/);
  const desde = index.indexOf('function diaEnFoco(dias) {');
  const hasta = index.indexOf('\n}', desde);
  if (!sinEntrega || desde === -1 || hasta === -1) {
    throw new Error('No se encontraron SIN_ENTREGA / diaEnFoco en index.html');
  }
  const src = sinEntrega[0] + '\n' + index.slice(desde, hasta + 2) + '\nreturn diaEnFoco;';
  return new Function(src)();
}

// Un día como lo arma el server: lo único que mira `diaEnFoco` es la fecha y si
// está atrasado.
const dia = (fecha, extra = {}) => ({ fecha, esHoy: false, atrasado: false, ...extra });

// Del 6 al 12 de septiembre de 2026: domingo 6, lunes 7, martes 8 … sábado 12.
const semana = (desde, cant) => {
  const out = [];
  const d = new Date(desde + 'T12:00:00');
  for (let i = 0; i < cant; i++) {
    const f = new Date(d.getTime());
    f.setDate(d.getDate() + i);
    out.push(dia(f.toISOString().slice(0, 10), { esHoy: i === 0 }));
  }
  return out;
};

function run(t) {
  const index = fs.readFileSync(INDEX, 'utf8');
  const diaEnFoco = cargarDiaEnFoco(index);

  // Que el calendario de la prueba sea el que se cree que es. Sin esto, un error
  // acá se leería como un error de la regla.
  const nombreDe = f => new Date(f + 'T12:00:00').getDay();
  t.eq(nombreDe('2026-09-06'), 0, '2026-09-06 es domingo');
  t.eq(nombreDe('2026-09-07'), 1, '2026-09-07 es lunes');
  t.eq(nombreDe('2026-09-08'), 2, '2026-09-08 es martes');
  t.eq(nombreDe('2026-09-12'), 6, '2026-09-12 es sábado');

  // ── Un día de entregas: el foco es hoy ────────────────────────────────────
  for (const [desde, nombre] of [['2026-09-08', 'martes'], ['2026-09-09', 'miércoles'],
                                 ['2026-09-10', 'jueves'], ['2026-09-11', 'viernes'],
                                 ['2026-09-12', 'sábado']]) {
    t.eq(diaEnFoco(semana(desde, 8)), desde, `un ${nombre} el foco es hoy`);
  }

  // ── Domingo y lunes: el foco se corre al primer día de entregas ───────────
  t.eq(diaEnFoco(semana('2026-09-06', 8)), '2026-09-08', 'un domingo el foco es el martes');
  t.eq(diaEnFoco(semana('2026-09-07', 8)), '2026-09-08', 'un lunes el foco es el martes');

  // Y se corre aunque el martes esté vacío: "el martes no llega nada" es la
  // respuesta que se vino a buscar, no un motivo para no contestar.
  t.eq(diaEnFoco(semana('2026-09-06', 8)), '2026-09-08',
    'el foco del domingo es el martes aunque no traiga nada');

  // ── Los atrasados nunca son el foco ───────────────────────────────────────
  // Siguen primeros en la lista, en su renglón rojo: son lo más urgente. Pero
  // el foco es para lo que VIENE — puesto en un jueves que ya pasó, la pregunta
  // de hoy se queda sin contestar.
  const conAtrasados = [
    dia('2026-09-03', { atrasado: true }),
    dia('2026-09-04', { atrasado: true }),
    ...semana('2026-09-08', 8),
  ];
  t.eq(diaEnFoco(conAtrasados), '2026-09-08', 'con días atrasados el foco sigue siendo hoy');

  const atrasadosUnDomingo = [
    dia('2026-09-03', { atrasado: true }),
    ...semana('2026-09-06', 8),
  ];
  t.eq(diaEnFoco(atrasadosUnDomingo), '2026-09-08',
    'con atrasados y siendo domingo, el foco sigue siendo el martes');

  // ── Casos borde ───────────────────────────────────────────────────────────
  t.eq(diaEnFoco([]), null, 'sin días no hay foco');
  t.eq(diaEnFoco(undefined), null, 'sin lista tampoco');
  t.eq(diaEnFoco([dia('2026-09-03', { atrasado: true })]), null,
    'una lista de puros atrasados no deja foco: no hay nada que venga');

  // Una ventana que empieza domingo y NO llega a ningún día de entregas cae en
  // hoy. Es imposible con los siete días que manda el server, y es justamente
  // por eso que se prueba: el fallback tiene que existir igual, o la pantalla se
  // quedaría sin ningún día dibujado.
  t.eq(diaEnFoco([dia('2026-09-06', { esHoy: true }), dia('2026-09-07')]), '2026-09-06',
    'sin ningún día de entregas a la vista, el foco cae en hoy');

  // ── Y que la pantalla lo esté usando ──────────────────────────────────────
  // La función sola no dibuja nada: sin estas dos líneas el foco es código
  // muerto y la lista vuelve a ser todos los renglones iguales.
  t.ok(/const foco = diaEnFoco\(dias\)/.test(index), 'renderPedidosDias calcula el día en foco');
  t.ok(/d\.fecha === foco \? bloqueFoco\(d\) : diaPedidos\(d\)/.test(index),
    'el día en foco se dibuja con bloqueFoco y el resto con diaPedidos');
  // El día en foco entra a la lista aunque esté vacío.
  t.ok(/d\.fecha === foco \|\| d\.esHoy/.test(index),
    'el día en foco no lo filtra el "un día futuro sin nada no aporta"');

  // ── Lo que llegó y nadie dijo qué pasó con la plata ───────────────────────
  // `sinPago` lo devolvía el server desde siempre y no se dibujaba en ningún
  // lado. Y sus pedidos no están en ningún día —son de fechas pasadas y ya
  // recibidas—, así que `pedBuscar` tiene que mirarlos también o sus botones
  // abren un modal vacío.
  t.ok(/function renderPedSinPago\(\)/.test(index), 'existe la tarjeta de "falta registrar el pago"');
  t.ok(/renderPedSinPago\(\);\s*\n\s*renderPedidosDias\(\)/.test(index),
    'loadPedidos la dibuja en cada carga');
  t.ok(/sinPago \|\| \[\]\)\.find\(x => x\.id === id\)/.test(index),
    'pedBuscar encuentra los pedidos de sinPago, que no viven en ningún día');
}

module.exports = { nombre: 'El día en foco de Pedidos', run };
