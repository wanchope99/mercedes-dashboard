// El formulario de compra no puede perder lo cargado.
//
// Hasta el 06/09/2026 `guardarCompra` hacía `closeModal()` ANTES del await del
// POST. Cuando la planilla fallaba, el cartel decía "la compra NO quedó
// registrada, volvé a intentarlo" y no había nada que reintentar: `openModal()`
// ya había limpiado los dieciocho campos. Sumado a que el overlay cerraba
// tocando afuera, había dos formas distintas de tirar una compra entera.
//
// Se verifica sobre el TEXTO del archivo. No hay DOM acá: lo que se fija es el
// orden de las operaciones y que las salvaguardas sigan puestas, que es
// exactamente lo que se rompió y lo que un refactor volvería a romper.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

// Devuelve el cuerpo de una función top-level, cortando en el próximo salto de
// línea seguido de `}` en columna 0. Sin regex armadas por concatenación: el
// nombre viene de acá adentro, no de afuera.
function cuerpoDe(src, nombre) {
  let desde = src.indexOf('\nasync function ' + nombre + '(');
  if (desde === -1) desde = src.indexOf('\nfunction ' + nombre + '(');
  if (desde === -1) return null;
  const fin = src.indexOf('\n}', desde);
  return fin === -1 ? src.slice(desde) : src.slice(desde, fin + 2);
}

function run(t) {
  const src = fs.readFileSync(INDEX, 'utf8');
  const cuerpo = cuerpoDe(src, 'guardarCompra');
  t.ok(cuerpo, 'se encuentra guardarCompra en index.html');
  if (!cuerpo) return;

  // 1. El POST va antes del cierre. Éste es el bug, dicho como orden.
  const post = cuerpo.indexOf("await api('/api/pagos'");
  const cierre = cuerpo.indexOf('closeModal()');
  t.ok(post > -1, 'guardarCompra hace POST a /api/pagos');
  t.ok(cierre > -1, 'guardarCompra cierra el modal en algún momento');
  t.ok(post < cierre, 'el modal se cierra DESPUÉS del await del POST, no antes');

  // 2. El cierre está dentro del try, o sea sólo se alcanza si el POST salió bien.
  const tryIdx = cuerpo.indexOf('try {');
  const catchIdx = cuerpo.indexOf('} catch (err)');
  t.ok(tryIdx > -1 && catchIdx > tryIdx, 'guardarCompra tiene try/catch');
  t.ok(cierre > tryIdx && cierre < catchIdx, 'el closeModal() vive en el camino feliz, no en el catch');

  // 3. El catch NO cierra el modal: ahí está el valor del arreglo.
  const rama = cuerpo.slice(catchIdx);
  t.ok(rama.indexOf('closeModal()') === -1, 'el catch NO cierra el modal (los datos quedan para reintentar)');
  t.ok(rama.includes('NO quedó registrada'), 'el catch sigue diciendo que la compra no se registró');
  t.ok(rama.includes('tocá Guardar de nuevo'), 'el catch dice que los datos siguen ahí');

  // 4. Los botones se apagan mientras el POST viaja: dos toques serían dos filas.
  t.ok(cuerpo.includes('compraGuardando(true'), 'se apagan los botones antes de mandar');
  t.ok(rama.includes('compraGuardando(false'), 'se vuelven a encender en el catch');
  t.ok(src.includes('const BOTONES_COMPRA = ['), 'existe la lista de botones de compra');
  for (const id of ['f-btn-seguir', 'f-sin-entrega', 'f-btn-guardar']) {
    t.ok(src.includes('id="' + id + '"'), 'el botón ' + id + ' existe en el HTML');
  }

  // 5. El overlay de la compra no cierra tocando afuera.
  const listeners = [...src.matchAll(/getElementById\('([a-z0-9-]+)'\)\.addEventListener\('click'/g)].map(m => m[1]);
  t.ok(listeners.length > 0, 'se detectaron listeners de click en overlays (' + listeners.length + ')');
  t.ok(!listeners.includes('modal-overlay'), 'modal-overlay ya no cierra al tocar el fondo');

  // 6. Escape cierra overlays, pero no el de la compra.
  t.ok(src.includes('ESC_NO_CIERRA'), 'existe la lista de overlays que Escape no cierra');
  t.ok(src.includes("ESC_NO_CIERRA = new Set(['modal-overlay'])"), 'el de la compra está exceptuado de Escape');
  t.ok(src.includes("e.key !== 'Escape'"), 'hay un listener global de Escape');
  t.ok(src.includes('e.defaultPrevented'), 'Escape respeta a quien ya lo manejó (edición inline de Plan y Finanzas)');
  t.ok(src.includes('login-screen') && !src.includes("ESC_NO_CIERRA.add('login"),
    'login-screen no necesita excepción: no termina en -overlay');

  // 7. openModal sigue limpiando: es lo que hace que perder el modal duela.
  //    Si algún día deja de hacerlo, esta suite tiene que mirarse de nuevo.
  const abrir = cuerpoDe(src, 'openModal');
  t.ok(abrir && abrir.includes("f-monto').value = ''"), 'openModal() sigue limpiando los campos al abrir');
  t.ok(abrir && abrir.includes('marcarErroresCompra([])'), 'openModal() limpia los errores del intento anterior');

  // ── 8. Las validaciones, ejercitadas de verdad ────────────────────────────
  // `validarCompra` es pura: se extrae y se corre. Era una cadena de cinco
  // `alert()` — corregías el primero, apretabas Guardar, aparecía el segundo.
  const desdeVal = src.indexOf('function validarCompra(d) {');
  const finVal = src.indexOf('\n}', desdeVal);
  t.ok(desdeVal > -1, 'existe validarCompra');
  const validar = new Function(src.slice(desdeVal, finVal + 2) + '\nreturn validarCompra;')();

  const base = { fecha: '2026-09-06', proveedor: 'Thames', salidaARS: 15000, cuotas: 1,
                 conCuotas: false, vencRaw: '', medioPago: 'Efectivo Pablo', previsto: 'pagado' };
  const campos = d => validar({ ...base, ...d }).map(e => e.campo);

  t.eq(campos({}), [], 'una compra completa no tiene errores');
  t.eq(campos({ proveedor: '' }), ['f-proveedor'], 'falta el proveedor');
  t.eq(campos({ fecha: '' }), ['f-fecha'], 'falta la fecha');
  t.eq(campos({ salidaARS: 0 }), ['f-monto'], 'falta el monto');
  t.eq(campos({ medioPago: '' }), ['f-medio'], 'un gasto ya pagado tiene que decir de qué caja salió');
  t.eq(campos({ medioPago: '', previsto: 'a-pagar' }), [],
    'lo que queda a pagar todavía no salió de ninguna caja: no se pide medio de pago');
  t.eq(campos({ cuotas: 3, conCuotas: true, previsto: 'a-pagar', medioPago: '', vencRaw: '' }),
    ['f-vencimiento'], 'en cuotas hace falta el vencimiento de la primera');

  // Lo que motivó el cambio: TODOS los errores salen juntos, no de a uno.
  t.eq(campos({ proveedor: '', salidaARS: 0, medioPago: '' }),
    ['f-proveedor', 'f-monto', 'f-medio'], 'los errores se devuelven todos juntos, no de a uno');
  t.ok(validar({ ...base, proveedor: '', salidaARS: 0 }).every(e => e.msg && e.msg.length > 3),
    'cada error trae su texto');

  // 9. El foco va al primer campo VISIBLE: enfocar uno oculto no mueve nada y
  //    parece que el botón no respondió.
  t.ok(src.includes('el.offsetParent !== null'), 'el foco salta los campos ocultos');

  // 10. La cadena de alert() se fue del flujo de la compra.
  const flujo = cuerpoDe(src, 'saveNewPago') + cuerpo;
  t.ok(!flujo.includes('alert('), 'no queda ningún alert() en el flujo de carga de una compra');
  t.ok(src.includes('class="modal-errores" id="modal-errores"'), 'el resumen de errores existe en el HTML');
  t.ok(src.includes('.campo-error {'), 'hay un estilo para marcar el campo que falta');
}

module.exports = { nombre: 'Formulario de compra', run };
