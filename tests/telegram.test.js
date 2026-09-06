// El canal de salida no puede romper lo que lo dispara.
//
// `telegram.avisar()` lo llama `avisos.registrar()`, y a ése lo llama alguien
// que ya escribió la fila del libro y ya marcó el pedido, con el proveedor en la
// puerta. Nada de lo de acá puede tirar, bloquear ni demorar esa operación.
//
// Ninguna afirmación de esta suite habla con Telegram: se corre sin token, que
// es además el caso que hay que garantizar (en local no hay token y el módulo
// tiene que apagarse solo en vez de fallar).

const path = require('path');

function run(t) {
  // Sin token, y sin ninguna variable de chat: el estado de una máquina de
  // desarrollo. Se limpia antes de cargar el módulo porque lee el env al
  // requerirse.
  delete process.env.TELEGRAM_BOT_TOKEN;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TELEGRAM_CHAT_')) delete process.env[k];
  }
  const modPath = path.join(__dirname, '..', 'src', 'telegram.js');
  delete require.cache[require.resolve(modPath)];
  const tg = require(modPath);

  // 1. Sin token el módulo se apaga solo y lo dice.
  t.ok(tg.configurado() === false, 'sin TELEGRAM_BOT_TOKEN el módulo se declara apagado');

  // 2. `chatDe` traduce el usuario de la app a su variable de entorno.
  t.eq(tg.chatDe('tincho'), '', 'sin variable seteada, un usuario no tiene chat (y no es un error)');
  process.env.TELEGRAM_CHAT_TINCHO = '12345';
  t.eq(tg.chatDe('tincho'), '12345', 'tincho → TELEGRAM_CHAT_TINCHO');
  t.eq(tg.chatDe('Tincho'), '12345', 'el nombre no distingue mayúsculas');
  t.eq(tg.chatDe(''), '', 'usuario vacío no resuelve a ningún chat');
  t.eq(tg.chatDe(null), '', 'usuario nulo no resuelve a ningún chat');
  // Un nombre con caracteres raros no puede alcanzar otra variable de entorno.
  t.eq(tg.chatDe('../../PATH'), tg.chatDe('PATH') , 'el nombre se normaliza antes de armar la variable');

  // 3. El texto del mensaje. Sin parse_mode, así que no hay nada que escapar,
  //    pero sí tiene que decir dónde volver a encontrarlo.
  const texto = tg.textoDeAviso({ titulo: 'Se pagó de más', detalle: 'Thames · $14.700', quien: 'juan' });
  t.ok(texto.includes('Se pagó de más'), 'el mensaje lleva el título');
  t.ok(texto.includes('Thames · $14.700'), 'el mensaje lleva el detalle');
  t.ok(texto.includes('juan'), 'el mensaje dice quién lo registró');
  t.ok(texto.includes('campanita'), 'el mensaje dice dónde está el aviso en la app');
  const sinNada = tg.textoDeAviso({ titulo: 'Algo' });
  t.ok(sinNada.includes('Algo'), 'un aviso sin detalle ni autor igual arma mensaje');

  // 4. `avisar` nunca tira, ni con basura.
  const casos = [
    undefined,
    {},
    { severidad: 'alta' },
    { severidad: 'alta', para: null },
    { severidad: 'alta', para: ['tincho'], titulo: 'x' },
    { severidad: 'media', para: ['tincho'], titulo: 'x' },
  ];
  return Promise.all(casos.map(c => tg.avisar(c))).then(res => {
    t.ok(true, 'avisar() no tiró con ninguno de los ' + casos.length + ' casos');
    for (const r of res) {
      t.ok(r && Array.isArray(r.enviados) && Array.isArray(r.fallaron),
        'avisar() siempre devuelve { enviados, fallaron }');
    }
    t.ok(res.every(r => r.enviados.length === 0), 'sin token no se manda nada');
    t.ok(res.every(r => r.apagado === true), 'sin token el resultado dice que está apagado');

    // 5. `enviar` sin token contesta el error en vez de tirar.
    return tg.enviar('12345', 'hola').then(r => {
      t.ok(r.ok === false, 'enviar() sin token no manda');
      t.ok(String(r.error).includes('TELEGRAM_BOT_TOKEN'), 'enviar() dice qué variable falta');
      return tg.enviar('', 'hola');
    }).then(r => {
      t.ok(r.ok === false, 'enviar() sin chat id no manda');
    });
  });
}

// La suite es asincrónica: el corredor la espera.
module.exports = { nombre: 'Telegram: canal de salida', run, async: true };
