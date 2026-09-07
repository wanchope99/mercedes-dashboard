// Recibir: un botón en el renglón, una pregunta adentro.
//
// Reescrito la tarde del 07/09/2026, cuando Gonzalo miró la pantalla que había
// salido a la mañana y dijo que seguía siendo compleja. El rediseño:
//
//   · EL RENGLÓN TIENE UN SOLO BOTÓN, "Recibido". Lo que hace que alcance es
//     que no tocarlo también significa algo: el pedido no llegó, y de madrugada
//     pasa solo al día siguiente.
//   · TODA la pregunta pasa adentro del modal, y es UNA con dos salidas, que la
//     compra ya decide cuál. La salida simple resuelve sin un Confirmar detrás.
//   · Si un pedido ya estaba pago, en la puerta NO sale plata. Lo que puede
//     cambiar es cuánto VALIÓ lo que llegó, y esa diferencia va a saldos —
//     nunca a Movimientos, que lleva la plata que se movió.
//
// Lo que se prueba acá es lo que decide plata: qué pregunta sale, qué medio se
// escribe, para qué lado va cada saldo, y que el pase de día automático tenga
// su freno.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const PEDIDOS = path.join(__dirname, '..', 'src', 'pedidos.js');

function bloque(src, desde) {
  const i = src.indexOf(desde);
  if (i === -1) throw new Error('No se encontró: ' + desde);
  const fin = src.indexOf('\n}', i);
  return src.slice(i, fin + 2);
}

function run(t) {
  const index = fs.readFileSync(INDEX, 'utf8');
  const server = fs.readFileSync(SERVER, 'utf8');
  const pedidos = fs.readFileSync(PEDIDOS, 'utf8');

  // ══ 1. Un solo botón en el renglón ═══════════════════════════════════════
  const botones = bloque(index, 'function botonesRecibir(p) {');
  const cuantos = (botones.match(/<button/g) || []).length;
  t.eq(cuantos, 1, 'el renglón de un pedido tiene UN botón');
  t.ok(/✓ Recibido/.test(botones), 'y dice "Recibido"');
  t.ok(/openPedRecibir\(/.test(botones), 'que abre el modal, donde se hace la pregunta');

  // Las correcciones no compiten con la decisión: están detrás de un "⋯".
  const menores = bloque(index, 'function accionesMenores(p) {');
  t.ok(/togglePedMenores/.test(menores), 'otro día / proveedor / borrar viven detrás de "⋯"');
  t.ok(/Otro día/.test(menores) && /Proveedor/.test(menores) && /borrarPedido/.test(menores),
    'y las tres siguen existiendo, no se perdieron');

  // ══ 2. Qué pregunta el modal, según lo que dijo la compra ════════════════
  const salidasDe = new Function(
    bloque(index, 'const PED_SALIDAS = {') + '\n'
    + 'const pedYaPago = p => !!p && p.pagoPrevisto === "pagado";\n'
    + "const salidasDe = p => PED_SALIDAS[pedYaPago(p) ? 'pagado' : 'noPagado'];\n"
    + 'return salidasDe;')();

  const yaPago = { pagoPrevisto: 'pagado', costoEstimado: 12400 };
  const alRecibir = { pagoPrevisto: 'al-recibir', costoEstimado: 117000 };
  const aCuenta = { pagoPrevisto: 'a-pagar', costoEstimado: 48000 };
  const sinDecir = { pagoPrevisto: '', costoEstimado: 0 };

  // LO MÁS IMPORTANTE DE ESTA SUITE: la salida simple NUNCA paga. En los dos
  // mundos, la respuesta corta es la que no mueve plata — que es la que se toca
  // sin leer, con el proveedor en la puerta.
  for (const [p, nombre] of [[yaPago, 'ya pago'], [alRecibir, 'se paga al recibir'],
                             [aCuenta, 'queda a cuenta'], [sinDecir, 'sin dato']]) {
    t.eq(salidasDe(p).simple.modo, 'no-pague',
      `la salida simple de "${nombre}" no mueve plata`);
  }

  // Y la otra salida significa cosas distintas según el mundo: con el pedido ya
  // pago no hay plata que poner, sólo un valor que corregir.
  t.eq(salidasDe(yaPago).otra.modo, 'no-pague',
    'sobre un pedido ya pago, la segunda salida TAMPOCO paga: si estaba pago, no sale plata');
  t.eq(salidasDe(alRecibir).otra.modo, 'pague',
    'sobre un pedido sin pagar, la segunda salida es haber pagado en la puerta');
  t.ok(/valió/.test(salidasDe(yaPago).otra.montoLabel),
    'al ya pago se le pregunta cuánto VALIÓ lo que llegó, no cuánto se pagó');
  t.ok(/pagaste/.test(salidasDe(alRecibir).otra.montoLabel),
    'al no pago se le pregunta cuánto se pagó');

  // La salida simple resuelve sin Confirmar: son dos toques y se terminó.
  const elegir = bloque(index, 'async function elegirSalida(clave) {');
  t.ok(/if \(clave === 'simple' && !faltaMonto\)[\s\S]*return confirmarPedRecibir\(\)/.test(elegir),
    'la salida simple confirma sola: no hay un tercer toque para decir que no pasó nada');
  t.ok(/const faltaMonto = !\(pedEsperado\(\) > 0\)/.test(elegir),
    'salvo que no haya monto cargado, donde no se puede resolver sin preguntar');

  // ══ 3. Con qué medio se anota lo que pasó en la puerta ═══════════════════
  const medioDeRecepcion = new Function(
    "const CAJA_EFECTIVO = 'Efectivo Local';\n"
    + bloque(server, 'function medioDeRecepcion(pedido, modo) {') + '\n'
    + 'return medioDeRecepcion;')();

  // SI SALIÓ PLATA EN LA PUERTA, ES EFECTIVO DEL LOCAL. Siempre, sin importar
  // qué diga la compra: es la única caja que existe ahí. Un pago anotado contra
  // otra caja es una caja que no se tocó y un arqueo que no cierra esa noche.
  for (const previsto of ['al-recibir', 'a-pagar', 'pagado', '']) {
    t.eq(medioDeRecepcion({ pagoPrevisto: previsto, medioPrevisto: 'Galicia' }, 'pague'),
      'Efectivo Local', `se pagó en la puerta (compra "${previsto || 'sin dato'}") → efectivo del local`);
  }

  // Cuando NADIE pagó, el medio es el que dijo la compra: por dónde se va a
  // pagar, o por dónde ya salió.
  t.eq(medioDeRecepcion({ pagoPrevisto: 'a-pagar', medioPrevisto: 'Galicia' }, 'no-pague'),
    'Galicia', 'nadie pagó → queda el medio que dijo la compra');
  t.eq(medioDeRecepcion({ pagoPrevisto: '', medioPrevisto: '' }, 'no-pague'),
    '', 'sin medio no se inventa uno: Pagos cae en la ficha del proveedor');

  // Y el formulario no ofrece elegirlo en la puerta, que es de donde salía el
  // medio raro. Las dos mitades de la misma regla.
  t.ok(/f-medio-wrap'\)\.style\.display = v === 'al-recibir' \? 'none' : ''/.test(index),
    'Nueva compra esconde el medio en "se paga al recibir"');
  t.ok(/medioPrevisto: previsto === 'al-recibir' \? CAJA_EFECTIVO/.test(server),
    'y el server lo fuerza a Efectivo Local igual, sin creerle al formulario');

  // ══ 4. Para qué lado va cada saldo ══════════════════════════════════════
  const saldos = bloque(server, 'async function saldosDeRecepcion({');

  // El pedido ya pago tiene su propia rama, y tiene que tenerla: la fórmula
  // general mide contra lo que hay que pagar HOY, y hoy no hay que pagar nada.
  // Pasado por ahí, "valió menos" anotaría que el bar le debe plata a quien
  // acaba de quedarse con la suya.
  t.ok(/pedido\.pagoPrevisto === 'pagado' && modo === 'no-pague' && esperadoYaPago > 0/.test(saldos),
    'el pedido ya pago que llega distinto tiene su propia rama');
  t.ok(/const dif = centavos\(esperadoYaPago - valio\)/.test(saldos),
    'la diferencia se mide contra lo que YA se había pagado');
  t.ok(/if \(dif !== 0\)/.test(saldos),
    'y va para los dos lados: pagó de más y lo deben, o valió más y se le debe');

  // La otra rama: se pagó algo distinto de lo cargado.
  t.ok(/const diferencia = centavos\(leerMonto\(monto\) - aPagar\)/.test(saldos),
    'la diferencia la saca el server, no la pantalla');
  t.ok(/const parteQueFalta = !!pedidos\.normalizarFecha\(restoFecha\)/.test(saldos),
    'y "el resto llega otro día" es lo único que la deja sin deuda');
  t.ok(/const nuevo = \(esperado > 0 && diferencia !== 0 && !parteQueFalta\)/.test(saldos),
    'cualquier otra diferencia queda anotada, con el signo que tenga');

  // Nada de esto toca el libro. Es la invariante de la que dependen el arqueo y
  // la fila de ajuste del cierre.
  t.ok(!/registrarGastoEnLibro|marcarFilaPagada/.test(saldos),
    'saldosDeRecepcion NO escribe en Movimientos');

  // ══ 5. La entrega partida ═══════════════════════════════════════════════
  t.ok(/const restoFecha = pedidos\.normalizarFecha\(req\.body\.restoFecha\)/.test(server),
    'la ruta lee la fecha del resto');
  t.ok(/origen: 'parcial'/.test(server),
    "el pedido del resto no nace como 'compra': ese corte le impediría enganchar la fila que ya existe");
  const ruta = server.slice(server.indexOf("app.post('/api/pedidos/:id/recibir'"));
  t.ok(ruta.indexOf('pedidos.marcarRecibido') < ruta.indexOf('const restoFecha'),
    'el resto se crea DESPUÉS de marcar recibido: no puede deshacer lo ya escrito');
  t.ok(/restoError = e\.message/.test(ruta),
    'si falla se informa: si no, lo que falta no queda anotado en ningún lado');

  // ══ 6. Lo que nadie recibe pasa de día solo, UNA vez ════════════════════
  //
  // El freno es lo que hace que esto sea seguro. Sin él, un pedido que no va a
  // llegar nunca se arrastra para siempre: siempre aparece "para hoy" y jamás
  // como problema.
  const repro = bloque(pedidos, 'async function reprogramarNoRecibidos({');
  t.ok(/p\.fecha < hoy && estaAbierto\(p\)/.test(repro),
    'sólo se mueven los que quedaron abiertos en un día que ya pasó');
  t.ok(/if \(p\.reprogramado\) \{ frenados\.push/.test(repro),
    'el que ya se movió solo una vez NO se vuelve a mover: queda como atrasado');
  t.ok(/reprogramado: p\.fecha/.test(repro),
    'se guarda la fecha original, que es la marca del freno y lo que deja decir cuándo se esperaba');
  t.ok(/catch \(e\) \{[\s\S]*?console\.error/.test(repro),
    'uno que falla no deja sin mover a los demás: corre sin nadie mirando');

  // La columna que lo sostiene, y que se agrega sola a las hojas que ya existen.
  t.ok(/'Categoria', 'Mes', 'Reprogramado'\]/.test(pedidos), 'la hoja Pedidos tiene la columna');
  t.ok(/const ULTIMA_COL = 'U'/.test(pedidos), 'y el rango que se lee llega hasta ella');

  // Y que esté programado de verdad, o la función es código muerto.
  const cron = fs.readFileSync(path.join(__dirname, '..', 'src', 'cron.js'), 'utf8');
  t.ok(/pedidos\.reprogramarNoRecibidos\(\)/.test(cron), 'el cron la corre');
  t.ok(/PEDIDOS_REPROGRAMAR_CRON \|\| '0 7 \* \* \*'/.test(cron),
    'a las 07:00: el bar ya cerró y el cocinero todavía no llegó');

  // ══ 7. Lo que se sacó no volvió por la ventana ══════════════════════════
  t.ok(!/segundoPago/.test(server) && !/segundoPago/.test(index),
    'el segundo pago sobre un pedido ya pago no existe más en ningún lado');
  t.ok(!/pagoTipo|pagoMotivo|SALDO_DEJA_DEUDA/.test(index),
    'la clasificación de "de más / de menos" salió de la pantalla');
}

module.exports = { nombre: 'Recibir: un botón y una pregunta', run };
