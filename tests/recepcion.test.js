// Recibir un pedido: los casos raros, que son los que mueven plata mal.
//
// El 07/09/2026 Gonzalo pidió cubrir TODOS los escenarios de la puerta, no sólo
// el normal, con la premisa de que **cómo se paga ya viene decidido desde Nueva
// compra o desde la foto al bot**. De ahí salieron cuatro cambios, y los cuatro
// tienen la misma forma: el sistema ya sabía la respuesta y estaba preguntando,
// o no la sabía y estaba adivinando.
//
//   1. El botón grande ahora acierta con los TRES valores de `pagoPrevisto`.
//      Faltaba el de todos los días: un pedido cargado como "no se paga acá"
//      ofrecía en verde "Llegó y lo pagué".
//   2. Si ya estaba pago y el proveedor cobra igual, esa plata se escribe. Antes
//      no se escribía en ningún lado y el arqueo de esa noche cerraba con un
//      faltante sin explicación.
//   3. El medio de pago sale de la compra en vez de ser `Efectivo Local` fijo,
//      para el proveedor que cobra en la puerta pero al que le transfiere Pablo.
//   4. Una entrega puede venir partida: lo que falta queda como un pedido nuevo.
//
// Se ejercitan las funciones PURAS de verdad —extraídas del archivo y
// ejecutadas— y se verifica por texto lo que no se puede ejecutar sin Google.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// Saca un bloque que empieza en `desde` y termina en el primer `\n}` — el mismo
// truco que usan las otras suites, y funciona porque son funciones y objetos
// declarados en columna 0.
function bloque(src, desde) {
  const i = src.indexOf(desde);
  if (i === -1) throw new Error('No se encontró: ' + desde);
  const fin = src.indexOf('\n}', i);
  return src.slice(i, fin + 2);
}

function run(t) {
  const index = fs.readFileSync(INDEX, 'utf8');
  const server = fs.readFileSync(SERVER, 'utf8');

  // ══ 1. Qué botón le toca a cada pedido ═══════════════════════════════════
  //
  // El botón grande es lo que va a pasar. Se corre la función real con los
  // cuatro estados posibles de `pagoPrevisto`.
  const ordenBotones = new Function(
    bloque(index, 'const PED_BOTONES = {') + '\n'
    + 'const pedYaPago = p => !!p && p.pagoPrevisto === "pagado";\n'
    + bloque(index, 'function ordenBotones(p) {') + '\n'
    + 'return { ordenBotones, PED_BOTONES };')();

  const primero = p => ordenBotones.PED_BOTONES[ordenBotones.ordenBotones(p)[0]];
  const segundo = p => ordenBotones.PED_BOTONES[ordenBotones.ordenBotones(p)[1]];

  const alRecibir = { pagoPrevisto: 'al-recibir', costoEstimado: 117000 };
  const yaPago    = { pagoPrevisto: 'pagado',     costoEstimado: 12400 };
  const aCuenta   = { pagoPrevisto: 'a-pagar',    costoEstimado: 48000 };
  const sinDecir  = { pagoPrevisto: '',           costoEstimado: 0 };

  t.eq(primero(alRecibir).modo, 'pague', 'se paga al recibir → el grande es "lo pagué"');
  t.eq(primero(yaPago).modo, 'no-pague', 'ya está pago → el grande NO cobra');
  t.eq(primero(aCuenta).modo, 'no-pague', 'queda a cuenta → el grande NO cobra');
  t.eq(primero(sinDecir).modo, 'pague', 'sin dato, el grande es el caso más común');

  // El segundo botón es siempre la excepción, y en los dos casos que no cobran
  // la excepción es justamente cobrar.
  t.eq(segundo(yaPago).modo, 'pague', 'ya está pago → la excepción es haber pagado');
  t.eq(segundo(aCuenta).modo, 'pague', 'queda a cuenta → la excepción es haber pagado');

  // Un toque directo tiene que resolver el pedido sin preguntar nada. Sólo
  // pueden serlo los dos donde la compra ya contestó todo.
  t.ok(primero(yaPago).directo, '"ya está pago" se recibe de un toque');
  t.ok(primero(aCuenta).directo, '"queda a cuenta" se recibe de un toque');
  t.ok(!primero(alRecibir).directo, 'pagar en la puerta SIEMPRE abre el modal: ahí sale plata');
  t.ok(!primero(sinDecir).directo, 'sin dato no hay toque directo: falta saber qué pasó');

  // Sin monto no se puede escribir la fila del libro, así que no hay atajo.
  t.ok(!primero({ pagoPrevisto: 'a-pagar', costoEstimado: 0 }).directo,
    'a cuenta SIN monto cargado cae al modal, que sí lo pregunta');

  // ══ 2. Con qué medio se anota lo que pasó en la puerta ═══════════════════
  const medioDeRecepcion = new Function(
    "const CAJA_EFECTIVO = 'Efectivo Local';\n"
    + bloque(server, 'function medioDeRecepcion(pedido, modo) {') + '\n'
    + 'return medioDeRecepcion;')();

  // El caso que motivó el cambio: la compra dijo que se paga en la puerta y por
  // dónde. Escribir Efectivo Local acá restaba de una caja que nadie tocó.
  t.eq(medioDeRecepcion({ pagoPrevisto: 'al-recibir', medioPrevisto: 'Mercado Pago Tincho' }, 'pague'),
    'Mercado Pago Tincho', 'se paga al recibir por transferencia → ese es el medio');
  t.eq(medioDeRecepcion({ pagoPrevisto: 'al-recibir', medioPrevisto: '' }, 'pague'),
    'Efectivo Local', 'se paga al recibir sin medio cargado → efectivo del local');

  // La EXCEPCIÓN es siempre efectivo: el medio de la compra describe otro pago
  // —el que ya se hizo, o el que se iba a hacer— y usarlo restaría de la caja
  // equivocada.
  t.eq(medioDeRecepcion({ pagoPrevisto: 'pagado', medioPrevisto: 'Galicia' }, 'pague'),
    'Efectivo Local', 'ya estaba pago por Galicia y cobran en la puerta → sale efectivo');
  t.eq(medioDeRecepcion({ pagoPrevisto: 'a-pagar', medioPrevisto: 'Galicia' }, 'pague'),
    'Efectivo Local', 'quedaba a cuenta por Galicia y se paga en la puerta → sale efectivo');

  // Cuando nadie pagó, el medio es el de la compra: por dónde se va a pagar, o
  // por dónde ya salió.
  t.eq(medioDeRecepcion({ pagoPrevisto: 'a-pagar', medioPrevisto: 'Galicia' }, 'no-pague'),
    'Galicia', 'nadie pagó → queda el medio que dijo la compra');
  t.eq(medioDeRecepcion({ pagoPrevisto: '', medioPrevisto: '' }, 'no-pague'),
    '', 'sin medio no se inventa uno: Pagos cae en la ficha del proveedor');

  // ══ 3. Cuáles "pagué de menos" dejan deuda ══════════════════════════════
  const SALDO_DEJA_DEUDA = new Function(
    bloque(server, 'const SALDO_DEJA_DEUDA = {') + '\nreturn SALDO_DEJA_DEUDA;')();

  t.ok(SALDO_DEJA_DEUDA.menos('pago-parcial'),
    'llegó todo y se pagó de menos → SE DEBE (es el default, y por eso importa)');
  t.ok(!SALDO_DEJA_DEUDA.menos('reduccion'),
    'no se aceptó la mercadería → no se debe');
  t.ok(!SALDO_DEJA_DEUDA.menos('viene-el-resto'),
    'el resto llega otro día → no se debe todavía: esa mercadería no está adentro');
  t.ok(SALDO_DEJA_DEUDA.demas('sin-cambio') && SALDO_DEJA_DEUDA.demas('otros'),
    'el vuelto se debe siempre, sea cual sea el motivo');

  // ══ 4. El segundo pago: lo que no se puede correr sin Google ═════════════
  //
  // Es el cambio que más plata mueve, así que se verifica su forma en el texto.
  const planificar = server.slice(server.indexOf('async function planificarAsiento('));

  // Corta ANTES de buscar ninguna fila. Si quedara debajo del atajo de la fila
  // propia, esa rama devolvería 'vincular-fila' y no se escribiría nada — que
  // es exactamente el agujero que esto vino a tapar.
  const corte = planificar.indexOf('if (segundoPago) {');
  const filaPropia = planificar.indexOf('const propia = delProveedor.find');
  t.ok(corte > -1, 'planificarAsiento contempla el segundo pago');
  t.ok(corte < filaPropia, 'el corte va ANTES del atajo de la fila propia, o nunca escribiría');
  t.ok(/idAsiento: `\$\{pedido\.id\}-r2`/.test(planificar),
    'la segunda fila lleva un id propio: con el del pedido, la idempotencia la borraría');

  t.ok(/facturaId: plan\.idAsiento \|\| pedido\.id/.test(server),
    'registrarGastoEnLibro usa el id del plan, no siempre el del pedido');

  // El server no le cree al navegador: sólo hay segundo pago si la compra decía
  // que estaba pagada Y el botón dijo que se pagó.
  t.ok(/req\.body\.segundoPago === true && pedido\.pagoPrevisto === 'pagado' && modo === 'pague'/.test(server),
    'el segundo pago se valida contra el pedido, no se acepta porque lo diga el cliente');

  // Las dos llamadas que planifican tienen que pasarlo, o la segunda —la que
  // corre cuando cerrar la fila falla— desharía la decisión.
  const llamadas = (server.match(/planificarAsiento\(\{ pedido, modo, monto, segundoPago \}\)/g) || []).length;
  t.eq(llamadas, 2, 'las dos planificaciones de la ruta pasan segundoPago (la normal y la de reintento)');

  // Y la vista previa también, o el modal mostraría lo contrario de lo que pasa.
  t.ok(/segundoPago = req\.query\.segundoPago === '1'/.test(server),
    'GET /plan acepta segundoPago para que la vista previa no mienta');
  t.ok(/'&segundoPago=1'/.test(index), 'el navegador se lo manda al pedir el plan');

  // La contrapartida: esa plata queda a favor del bar. Sin esto la fila nueva
  // sería un gasto duplicado y nada diría que el proveedor la debe.
  const saldos = bloque(server, 'async function saldosDeRecepcion({');
  t.ok(saldos.indexOf('if (segundoPago) {') > -1, 'saldosDeRecepcion contempla el segundo pago');
  t.ok(/motivo: 'doble-pago'/.test(saldos), 'queda anotado con su propio motivo');

  // ══ 5. La entrega partida ════════════════════════════════════════════════
  t.ok(/const restoFecha = pedidos\.normalizarFecha\(req\.body\.restoFecha\)/.test(server),
    'la ruta lee la fecha del resto');
  t.ok(/origen: 'parcial'/.test(server),
    "el pedido del resto NO nace como 'compra': ese corte le impediría enganchar la fila que ya existe");

  // Va después de marcar el pedido y no puede voltear la recepción: la
  // mercadería llegó y la plata ya se anotó. Misma regla que saldos y avisos.
  const ruta = server.slice(server.indexOf("app.post('/api/pedidos/:id/recibir'"));
  t.ok(ruta.indexOf('pedidos.marcarRecibido') < ruta.indexOf('const restoFecha'),
    'el resto se crea DESPUÉS de marcar recibido: no puede deshacer lo que ya se escribió');
  t.ok(/restoError = e\.message/.test(ruta),
    'si el pedido del resto falla se informa, no se traga: si no, lo que falta no queda en ningún lado');

  // ══ 6. Ya estaba pago y llegó de menos ═══════════════════════════════════
  //
  // El bar pagó de más, así que el sentido de la deuda es el CONTRARIO al del
  // caso normal: acá debe el proveedor. Por eso tiene su propia rama — con la
  // fórmula de `pagoTipo`, "llegó de menos" habría anotado que el bar le debe
  // plata a quien acaba de quedarse con la suya.
  t.ok(/pedido\.pagoPrevisto === 'pagado' && modo === 'no-pague' && esperadoYaPago > 0/.test(saldos),
    'saldosDeRecepcion contempla el pedido ya pago que llega incompleto');
  t.ok(/const aFavor = centavos\(esperadoYaPago - llego\)/.test(saldos),
    'la diferencia se saca contra lo que ya se había pagado, y queda a FAVOR del bar');
  t.ok(/monto: aFavor/.test(saldos), 'el saldo se anota positivo: lo debe el proveedor');

  // Y el toque directo no puede tapar un faltante que el sistema ya conoce.
  const directo = bloque(index, 'async function recibirDirecto(id, clave) {');
  t.ok(/p\.itemsResumen && p\.itemsResumen\.falta > 0\) return openPedRecibir/.test(directo),
    'con renglones marcados como que no llegaron, el atajo cae al modal');
}

module.exports = { nombre: 'Recibir: los casos de la puerta', run };
