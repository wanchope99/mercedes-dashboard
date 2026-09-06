// El bot es la otra puerta al libro, y no tiene roles.
//
// Quien pasa el filtro del bot escribe una fila de gasto en Movimientos, elige
// de qué caja sale la plata y registra el IVA de una factura. En la app eso pide
// login con JWT y `adminOnly`. Acá lo único que hay es `is_allowed`.
//
// Hasta el 06/09/2026 esa función fallaba ABIERTA —sin ALLOWED_USERS devolvía
// True para cualquiera— y encima `on_button` y `on_text` no la llamaban.
//
// POR QUÉ ESTA SUITE ES DE TEXTO Y NO CORRE NADA: en la máquina donde se
// desarrolla este repo no hay Python instalado (está anotado en el propio
// bot.py, que por eso es un cliente deliberadamente tonto). Nada de bot.py se
// puede ejecutar ni compilar acá, así que lo que se puede fijar es lo que dice
// el archivo. Es poco, y es más que nada.

const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot', 'bot.py');

// El cuerpo de una función de Python: desde su `def` hasta la próxima línea que
// arranca en columna 0 con algo que no sea espacio ni comentario suelto.
function cuerpoDe(src, nombre) {
  const lineas = src.split(/\r?\n/);
  let i = lineas.findIndex(l => l.startsWith('def ' + nombre + '(') || l.startsWith('async def ' + nombre + '('));
  if (i === -1) return null;
  const out = [lineas[i]];
  for (i = i + 1; i < lineas.length; i++) {
    const l = lineas[i];
    if (l.trim() === '') { out.push(l); continue; }
    if (!/^\s/.test(l)) break;   // volvió a columna 0: terminó la función
    out.push(l);
  }
  return out.join('\n');
}

function run(t) {
  const src = fs.readFileSync(BOT, 'utf8');
  const lineas = src.split(/\r?\n/);

  // 1. Nada de sintaxis de otro lenguaje. Sin intérprete acá, un `//` colado en
  //    un bloque de comentarios es un SyntaxError que sólo aparecería en
  //    Railway, con el bot caído.
  const jsComments = [];
  lineas.forEach((l, i) => { if (/^\s*\/\//.test(l)) jsComments.push(`línea ${i + 1}: ${l.trim()}`); });
  t.eq(jsComments, [], 'ninguna línea de bot.py usa // como comentario');

  // Tabs mezclados con espacios: en Python es un error de indentación.
  const tabs = [];
  lineas.forEach((l, i) => { if (/^\t/.test(l)) tabs.push(`línea ${i + 1}`); });
  t.eq(tabs, [], 'ninguna línea de bot.py indenta con tabulaciones');

  // 2. is_allowed falla CERRADA.
  const isAllowed = cuerpoDe(src, 'is_allowed');
  t.ok(isAllowed, 'existe is_allowed');
  if (isAllowed) {
    const vacio = isAllowed.indexOf('if not ALLOWED_USERS:');
    t.ok(vacio > -1, 'is_allowed contempla el caso de ALLOWED_USERS vacía');
    const despues = isAllowed.slice(vacio, vacio + 120);
    t.ok(despues.includes('return False'),
      'sin ALLOWED_USERS el bot NO atiende a nadie (fail-closed, no fail-open)');
    t.ok(!despues.includes('return True'),
      'sin ALLOWED_USERS no se devuelve True bajo ninguna forma');
    t.ok(isAllowed.includes('user.id'), 'is_allowed acepta también por user_id, que no se puede reclamar');
    t.ok(isAllowed.includes('user is None'), 'is_allowed tolera un update sin usuario');
  }

  // 3. TODO handler que puede escribir chequea permisos. Es la lista completa,
  //    no una muestra: el que falte es justamente el que se olvidó.
  const handlers = ['cmd_arreglo', 'cmd_pendientes', 'handle_photo', 'on_button', 'on_text'];
  const sinChequeo = handlers.filter(h => {
    const c = cuerpoDe(src, h);
    return !c || !c.includes('is_allowed(update)');
  });
  t.eq(sinChequeo, [], 'todos los handlers que escriben chequean is_allowed');

  // 4. El arranque dice si quedó sin usuarios: "no contesta" y "está caído" se
  //    ven igual desde afuera.
  t.ok(src.includes('ALLOWED_USERS esta vacia'), 'el arranque avisa si ALLOWED_USERS quedó vacía');

  // 5. Los handlers siguen registrados (un chequeo nuevo no sirve si el handler
  //    dejó de existir).
  for (const h of handlers) {
    t.ok(src.includes(h), `el handler ${h} sigue en bot.py`);
  }
}

module.exports = { nombre: 'Bot de Telegram: permisos', run };
