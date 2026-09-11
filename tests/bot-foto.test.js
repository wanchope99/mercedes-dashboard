// Qué tamaño de foto le pide el bot a Telegram.
//
// Telegram manda varios tamaños de cada foto y el bot elegía `photo[-1]`, el
// mayor. La imagen viaja al modelo DOS veces por factura (cabecera y renglones,
// ver el encabezado de src/extractor.js) y se paga por píxel, así que ese `-1`
// era la línea más cara del repo por carácter.
//
// Lo que esta suite cuida no es el ahorro —eso lo mide
// `scripts/comparar-extractor.js`— sino las dos formas en que esto se rompe sin
// dar error:
//
//   · que alguien vuelva a `photo[-1]` en un merge y el ahorro desaparezca en
//     silencio, con el bot funcionando igual de bien;
//   · que la elección se quede con la miniatura de 90 px cuando la foto
//     original era chica. Eso NO falla: el modelo contesta, con un total
//     inventado o una pregunta que no hacía falta. Es el error caro de los dos.
//
// POR QUÉ ES DE TEXTO Y NO CORRE NADA: en la máquina donde se desarrolla este
// repo no hay Python instalado (mismo motivo que tests/bot.test.js, que lo
// explica en su encabezado). `elegir_foto` no se puede ejecutar acá. Lo que se
// puede fijar es lo que dice el archivo.

const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot', 'bot.py');

function cuerpoDe(src, nombre) {
  const lineas = src.split(/\r?\n/);
  let i = lineas.findIndex(l => l.startsWith('def ' + nombre + '(') || l.startsWith('async def ' + nombre + '('));
  if (i === -1) return null;
  const out = [lineas[i]];
  for (i = i + 1; i < lineas.length; i++) {
    const l = lineas[i];
    if (l.trim() === '') { out.push(l); continue; }
    if (!/^\s/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

function run(t) {
  const src = fs.readFileSync(BOT, 'utf8');

  // 1. El `photo[-1]` no vuelve. Es la regresión que no da ningún síntoma.
  //    Se busca en el archivo entero y no sólo en handle_photo: si aparece en
  //    otro handler el problema es el mismo. Se saltean las líneas de
  //    comentario, donde el `photo[-1]` está NOMBRADO a propósito: el bloque
  //    que explica el cambio tiene que poder decir qué es lo que se dejó de
  //    hacer, y una prueba que prohíba mencionarlo obliga a escribir el
  //    comentario en clave.
  const codigo = src.split(/\r?\n/).filter(l => !/^\s*#/.test(l));
  t.eq(
    codigo.filter(l => l.includes('photo[-1]')).length, 0,
    'ya no se agarra el tamaño más grande a ciegas (photo[-1])'
  );

  // 2. La función existe y es la que usa el handler. Sin esto, el punto 1 se
  //    cumple igual borrando la foto entera.
  const elegir = cuerpoDe(src, 'elegir_foto');
  t.ok(elegir, 'existe elegir_foto');
  const handler = cuerpoDe(src, 'handle_photo');
  t.ok(handler && handler.includes('elegir_foto(update.message.photo)'),
    'handle_photo elige el tamaño con elegir_foto');

  // 3. El piso: si ningún tamaño llega al mínimo se devuelve el MAYOR. Una
  //    versión que devolviera `ordenados[0]` ahorraría más y mandaría la
  //    miniatura, que es el modo de falla caro.
  t.ok(elegir.includes('ordenados[-1]'),
    'si ningún tamaño llega al mínimo, se cae al mayor y no a la miniatura');
  t.ok(/return\s+ordenados\[0\]/.test(elegir) === false,
    'nunca se devuelve el más chico de la lista sin mirar su tamaño');

  // 4. No se confía en el orden en que llegó la lista.
  t.ok(elegir.includes('sorted('), 'elegir_foto ordena los tamaños en vez de asumirlos ordenados');

  // 5. El número es configurable y tiene default. El 0 es la marcha atrás sin
  //    deploy: vuelve al comportamiento de siempre.
  t.ok(/FOTO_LADO_MINIMO\s*=\s*int\(os\.environ\.get\("FOTO_LADO_MINIMO"/.test(src),
    'FOTO_LADO_MINIMO sale del entorno con un default');
  t.ok(elegir.includes('if minimo > 0'),
    'FOTO_LADO_MINIMO=0 se queda con el mayor, que es el comportamiento de siempre');

  // 6. El default es 0, y eso es un resultado y no una omisión: medido el
  //    11/09/2026, achicar la foto no ahorró nada porque Telegram ya la manda
  //    comprimida a 1280. Que quede fijado impide que alguien lo suba a 1280
  //    "porque parece razonable" — que es exactamente lo que la medición
  //    descartó— sin volver a correr el experimento.
  t.ok(/os\.environ\.get\("FOTO_LADO_MINIMO",\s*"0"\)/.test(src),
    'el default es 0: achicar la foto se midió y no ahorró nada');
}

module.exports = { nombre: 'Bot: qué tamaño de foto se le pide a Telegram', run };
