// Una compra se puede anotar SIN monto, salvo que ya esté paga (08/09/2026).
//
// Pedido de Gonzalo: *"a veces pasa que no es claro o es a definir el monto pero
// ya se hizo el pedido"*. Hasta hoy el formulario no dejaba guardar sin importe,
// así que la alternativa no era anotarlo con monto — era no anotarlo, y que la
// entrega llegara sin estar en ningún lado.
//
// La regla tiene DOS mitades y las dos se prueban acá, porque separadas son un
// agujero: se puede anotar sin monto (mitad uno) *porque* el importe se completa
// donde aparece el número (mitad dos). Sin la segunda, esa fila pasaría a
// `Pagado` con la columna O vacía: plata que salió de una caja y que ningún
// saldo resta nunca.
//
// `validarCompra` y `construirFilaGasto` se EJECUTAN de verdad — la primera se
// extrae de index.html como ya hacía tests/compra.test.js, la segunda de
// server.js inyectándole sus dependencias, porque requerir server.js levanta el
// servidor. Lo que no se puede correr (escribe en Sheets) se fija por texto.

const fs = require('fs');
const path = require('path');
const { parseMonto } = require('../src/monto');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// El cuerpo de una función top-level, cortando en el `}` de columna 0.
function cuerpoDe(src, decl) {
  const desde = src.indexOf(decl);
  if (desde === -1) throw new Error('No se encontró: ' + decl);
  const fin = src.indexOf('\n}', desde);
  return src.slice(desde, fin + 2);
}

// Lo mismo, para una función cuya lista de parámetros ocupa varias líneas y
// cierra con un `}` en columna 0 — que es donde el corte de arriba se equivoca,
// y se equivoca en silencio: devuelve el encabezado solo. Se corta contra lo que
// viene DESPUÉS y se vuelve al último `}` de columna 0.
function cuerpoEntre(src, decl, siguiente) {
  const desde = src.indexOf(decl);
  if (desde === -1) throw new Error('No se encontró: ' + decl);
  const hasta = src.indexOf(siguiente, desde);
  if (hasta === -1) throw new Error('No se encontró el final: ' + siguiente);
  const trozo = src.slice(desde, hasta);
  return trozo.slice(0, trozo.lastIndexOf('\n}') + 2);
}

// ─── construirFilaGasto, corriendo de verdad ────────────────────────────────
//
// Se le pasan sus dependencias como parámetros en vez de copiarlas: así lo que
// corre es EL código de server.js y no una versión parecida. `parseMonto` es el
// de verdad (es un módulo aparte); el resto son las piezas mínimas que la
// función usa, con el comportamiento que importa para estas afirmaciones.
function armarConstruirFilaGasto(src) {
  const cuerpo = cuerpoEntre(src, 'function construirFilaGasto({', 'async function registrarGastoEnLibro');
  if (!/return \{ ok: true, row/.test(cuerpo)) throw new Error('construirFilaGasto salió cortada');
  const fabrica = new Function(
    'leerMonto', 'centavos', 'normalizarMedio', 'MEDIOS_CANONICOS',
    'aFechaPlanilla', 'mesDeCualquierFecha', 'cats',
    cuerpo + '\nreturn construirFilaGasto;');
  return fabrica(
    parseMonto,
    n => Math.round((Number(n) || 0) * 100) / 100,
    m => (m == null ? '' : String(m)).trim(),
    ['Efectivo Local', 'Galicia', 'Mercado Pago Pablo'],
    f => (f ? '24/08/2026' : ''),
    () => 'Agosto',
    { normalizarCategoriaGasto: c => c || '' },
  );
}

function run(t) {
  const idx = fs.readFileSync(INDEX, 'utf8');
  const server = fs.readFileSync(SERVER, 'utf8');

  // ── 1. El formulario: el monto sólo es obligatorio si ya está pago ────────
  const val = cuerpoDe(idx, 'function validarCompra(d) {');
  const validar = new Function(val + '\nreturn validarCompra;')();
  const base = { fecha: '2026-09-08', proveedor: 'Eze Materin', salidaARS: 0, cuotas: 1,
                 conCuotas: false, vencRaw: '2026-10-22', medioPago: 'Galicia', previsto: 'a-pagar' };
  const campos = d => validar({ ...base, ...d }).map(e => e.campo);

  t.eq(campos({}), [], 'queda a pagar sin monto: se puede guardar');
  t.eq(campos({ previsto: 'al-recibir' }), [], 'se paga al recibir sin monto: se puede guardar');
  t.eq(campos({ previsto: 'pagado', medioPago: 'Galicia' }), ['f-monto'],
    'ya está pago sin monto: NO se puede, esa plata ya salió de una caja');
  // El caso de la pantalla que mandó Gonzalo: cuotas, sin monto. Con cuotas el
  // bloque de cómo se paga no se muestra y `datosDeCompra` fuerza 'a-pagar'.
  t.eq(campos({ conCuotas: true, cuotas: 3 }), [],
    'una compra en cuotas sin monto se puede guardar (es "a pagar" por definición)');
  t.eq(campos({ conCuotas: true, cuotas: 3, vencRaw: '' }), ['f-vencimiento'],
    'lo que sigue siendo obligatorio en cuotas es el vencimiento de la primera');
  t.ok(idx.includes("previsto: conCuotas ? 'a-pagar'"),
    'con cuotas el previsto es "a-pagar", que es lo que hace opcional al monto');

  // El rótulo lo dice ANTES de apretar Guardar: un campo que a veces es
  // obligatorio y a veces no, sin decir cuándo, se prueba a los golpes.
  const pintar = cuerpoDe(idx, 'function pintarMontoOpcional() {');
  t.ok(/opcional/.test(pintar), 'el rótulo del monto avisa que es opcional');
  t.ok(/no suma en el resultado del mes/.test(pintar),
    'y en cuotas avisa lo que cuesta: hasta cargar el total, esa compra no suma en el mes');

  // ── 2. La fila del libro: vacía es "no se sabe", cero sería mentira ───────
  const construir = armarConstruirFilaGasto(server);
  const compra = extra => construir({
    facturaId: 'ped1', fecha: '2026-08-24', proveedor: 'Eze Materin',
    categoria: 'Mercaderia', descripcion: 'vino', estado: 'A pagar',
    vencimiento: '2026-10-22', ...extra,
  });
  const O = 14;   // columna O — Salida ARS

  const sinMonto = compra({ monto: '' });
  t.ok(sinMonto.ok, 'una fila "A pagar" se escribe sin monto');
  t.eq(sinMonto.row[O], '', 'y la columna O queda VACÍA, no en cero: cero diría que el gasto fue de cero');
  t.eq(sinMonto.sinMonto, true, 'la fila se reporta como sin monto');

  const pagado = compra({ monto: '', estado: 'Pagado', medioPago: 'Efectivo Local' });
  t.ok(!pagado.ok, 'una fila "Pagado" sin monto se rechaza');
  t.eq(pagado.motivo, 'monto', 'y el motivo es el monto');
  t.ok(/ninguna caja lo resta/.test(pagado.error),
    'el error dice POR QUÉ, que es lo que hace que no se lea como un capricho');

  const conMonto = compra({ monto: '632.999,95' });
  t.ok(conMonto.ok, 'con monto sigue andando');
  t.eq(conMonto.row[O], 632999.95, 'y el importe entra redondeado a centavos');
  t.eq(conMonto.sinMonto, false, 'esa no es una fila sin monto');
  t.ok(!compra({ monto: -5, estado: 'A pagar' }).ok, 'un monto negativo se sigue rechazando');

  // Lo que NO cambió: el medio sigue siendo obligatorio en "Pagado".
  t.ok(!compra({ monto: 1000, estado: 'Pagado', medioPago: '' }).ok,
    'un gasto pagado sigue teniendo que decir de qué caja salió');

  // ── 3. Cuotas: no se inventan tres ceros ─────────────────────────────────
  const cuotas = server.slice(server.indexOf('if (nCuotas > 1) {'), server.indexOf('// ─── Pago único'));
  t.ok(/const sinTotal = !\(total > 0\)/.test(cuotas), 'la rama de cuotas mira si hay total');
  t.ok(/sinTotal \? '' : total/.test(cuotas), 'sin total, la fila madre va con el importe vacío');
  t.ok(/const monto = sinTotal \? ''/.test(cuotas), 'y cada cuota también');
  t.ok(/suma en el resultado del mes/i.test(cuotas),
    'queda escrito lo que cuesta: la fila madre vacía es la que no suma en el mes');

  // ── 4. La otra mitad: al pagar se completa el importe ─────────────────────
  const marcar = cuerpoDe(server, 'async function marcarFilaPagada({');
  t.ok(/descripcionSesion, monto } = \{\}/.test(marcar), 'marcarFilaPagada recibe el monto');
  t.ok(/const completaMonto = !\(montoFila > 0\) && montoDicho > 0/.test(marcar),
    'sólo completa cuando la fila NO tiene importe');
  t.ok(/Movimientos!O\$\{idx\}/.test(marcar), 'y lo escribe en la columna O de esa fila');
  t.ok(/no la resta ninguna caja/.test(marcar),
    'pagar una cuenta sin monto, sin decir cuánto, se rechaza');
  // El orden importa: si el monto recién escrito no llega al arqueo, la noche
  // cierra con un faltante que nadie perdió.
  t.ok(/montoSalida = completaMonto \? montoDicho/.test(marcar),
    'el esperado del arqueo descuenta lo que de verdad salió, no un cero');

  // Los dos que la llaman le pasan el monto: el botón Pagar y la recepción de
  // un pedido, que es la otra puerta por la que se cierra una fila.
  t.ok(/rowIndex, proveedor, medioPago, monto: req\.body\.monto/.test(server),
    'POST /api/pagos/pagar manda el monto tipeado');
  t.ok(/monto: montoDicho,\n      usuario: req\.user\.nombre,\n      descripcionSesion: `Pedido recibido/.test(server),
    'la recepción también, con lo que se pagó en la puerta');

  // ── 5. Y el guard que se sacó, que era el que no dejaba ──────────────────
  t.ok(!server.includes('Poné el monto de la compra: es lo que se va a registrar'),
    'ya no se rechaza una compra sin monto cuando la fila la escribe la recepción');

  // ── 6. La pantalla de Pagos lo muestra como algo a completar ─────────────
  t.ok(idx.includes('>sin monto</span>'), 'en la tabla de Pagos una cuenta sin importe dice "sin monto"');
  t.ok(idx.includes('id="pg-monto-wrap"'), 'el modal de pagar tiene dónde poner el importe que falta');
  const confirmar = cuerpoDe(idx, 'async function confirmarPagar() {');
  t.ok(/pideMonto && !\(monto > 0\)/.test(confirmar),
    'y no deja confirmar sin ponerlo, en vez de cerrar el modal y volver con un error');
}

module.exports = { nombre: 'Una compra se puede anotar sin monto', run };
