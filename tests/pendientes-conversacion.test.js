// El panel de la app y el bot preguntan lo mismo.
//
// El 11/09/2026 Gonzalo mandó la captura del panel: dos facturas "pendientes de
// confirmar" preguntando "¿Con o sin IVA?", "¿El descuento ya está incluido?" —
// preguntas de un cuestionario que la conversación nueva ya no hace— sobre
// facturas que nadie había mandado a la app.
//
// Eran dos bugs con un solo síntoma:
//
//   1. Había DOS modelos de pregunta sobre el mismo pendiente. `factura.dudas`,
//      congelado en el ingest por `procesarFactura`, era lo que dibujaba el
//      panel; `reg.conv`, que se actualiza con cada botón de Telegram, era lo
//      que usaba el bot. Nunca se hablaron.
//   2. Todo ingest crea un pendiente en el segundo cero, y sólo lo sacaba del
//      panel una conversación TERMINADA. Una charla a medias quedaba ahí para
//      siempre, y una que se estaba contestando en ese momento se veía igual.
//
// Lo que esta suite fija es lo que hace que no vuelvan: una sola fuente de
// verdad para las preguntas, y un reloj que distingue los tres estados.

const path = require('path');
const fs = require('fs');
const { envFalso } = require('./_harness');

const RAIZ = path.join(__dirname, '..');

function run(t) {
  envFalso();
  const convo = require(path.join(RAIZ, 'src', 'compra-conversacion.js'));
  const prov = require(path.join(RAIZ, 'src', 'proveedores.js'));

  // ─── 1. "Dejarlo para la app" ─────────────────────────────────────────────

  // Se puede tocar en cualquier paso, así que se atiende antes del switch. Lo
  // importante es que NO conteste la pregunta en la que se tocó: si lo hiciera,
  // derivar a la app grabaría una respuesta que nadie dio.
  const base = { proveedor: 'X', fecha: '2026-09-10', total: 1000, deducible: null };
  for (const campo of ['deducible', 'total', 'categoria', 'estaPago', 'medioPago']) {
    const r = convo.aplicarRespuesta(base, { campo, valor: convo.VALOR_APP });
    t.ok(r.derivarApp, `se puede derivar a la app desde el paso "${campo}"`);
    t.eq(r.estado, base, `derivar desde "${campo}" no contesta nada`);
    t.ok(!r.cancelar, `derivar desde "${campo}" no cancela la factura`);
  }

  // Y no es una cancelación disfrazada: cancelar descarta, derivar conserva.
  const cancel = convo.aplicarRespuesta({ ...base, yaCargada: true }, { campo: 'yaCargada', valor: 'cancelar' });
  t.ok(cancel.cancelar, 'cancelar sigue cancelando');

  // ─── 2. El botón NO ensucia el contrato de la conversación ────────────────
  //
  // `siguientePaso` describe la conversación: sus botones son las respuestas
  // posibles a la pregunta. El de derivar no contesta nada, así que lo agrega
  // la ruta del bot al serializar. La suite de la fecha —que exige que TODOS
  // los botones escriban el mes con letras— es la que cazó el primer intento.
  const paso = convo.siguientePaso({ ...base, deducible: null, tipoComprobante: 'A' });
  t.ok(paso.botones.every(b => b.id !== convo.VALOR_APP),
    'siguientePaso no mete el botón de derivar entre las respuestas');

  const rutas = fs.readFileSync(path.join(RAIZ, 'src', 'proveedores-routes.js'), 'utf8');
  t.ok(/function pasoPara\(conv, paraApp\)/.test(rutas), 'el botón lo agrega la ruta (pasoPara)');
  t.ok(rutas.includes('convo.BOTON_APP'), 'y usa la constante exportada, no una copia de la cadena');

  // ─── 3. Las dos puertas corren la MISMA función ───────────────────────────
  //
  // Es lo único que garantiza que lo contestado en Telegram esté contestado en
  // la app. Dos handlers parecidos se despegan igual que se despegaron las
  // preguntas.
  t.ok(/async function avanzarPaso\(req/.test(rutas), 'hay una sola función de paso');
  for (const r of ["'/api/proveedores/pendientes/:id/paso'", "'/api/proveedores/pendientes/:id/paso-app'"]) {
    t.ok(rutas.includes(r), `la ruta ${r} existe`);
  }
  const cuerposPaso = rutas.split('avanzarPaso(req').length - 1;
  t.eq(cuerposPaso, 3, 'avanzarPaso se declara una vez y se llama desde las dos rutas');
  // La puerta de la app es de una persona admin; la del bot, del token de
  // servicio. Que se crucen es cómo un endpoint termina abierto.
  t.ok(/paso-app', authMiddleware, soloAdmin/.test(rutas), 'la puerta de la app pide JWT y admin');
  t.ok(/pendientes\/:id\/paso', ingestAuth/.test(rutas), 'la puerta del bot sigue siendo el token de servicio');

  // ─── 4. El reloj: los tres estados ────────────────────────────────────────
  const AHORA = Date.parse('2026-09-11T15:00:00Z');
  const hace = min => new Date(AHORA - min * 60000).toISOString();

  const enCurso = { conv: {}, ultimaActividad: hace(2), creado: hace(10) };
  const trabado = { conv: {}, ultimaActividad: hace(90), creado: hace(120) };
  const derivado = { conv: {}, derivadoApp: true, ultimaActividad: hace(1), creado: hace(5) };
  const sinConv = { ultimaActividad: hace(1), creado: hace(1) };

  t.ok(!prov.estaTrabado(enCurso, AHORA), 'una conversación que se está contestando NO va al panel');
  t.ok(prov.estaTrabado(trabado, AHORA), 'una que nadie toca hace rato SÍ va al panel');
  t.ok(prov.estaTrabado(derivado, AHORA), 'una derivada a mano va al panel YA, sin esperar el reloj');
  // Sin conversación no hay nada que esperar: o es vieja, o lo único que queda
  // son renglones, y el bot no pregunta por renglones.
  t.ok(prov.estaTrabado(sinConv, AHORA), 'sin conversación va al panel siempre');

  t.eq(prov.minutosQuieto(enCurso, AHORA), 2, 'los minutos quietos se cuentan desde la última respuesta');
  // Un pendiente de antes del cambio no tiene la marca: se lee por su creación,
  // que es literalmente cuándo fue la única vez que alguien lo tocó.
  t.eq(prov.minutosQuieto({ creado: hace(45) }, AHORA), 45, 'un pendiente viejo se mide desde que se creó');

  // ─── 5. El panel y la campanita cuentan lo mismo ──────────────────────────
  //
  // Que el badge diga 3 y adentro haya 1 es la forma más rápida de que se deje
  // de mirar el badge.
  const provSrc = fs.readFileSync(path.join(RAIZ, 'src', 'proveedores.js'), 'utf8');
  t.ok(/function countPendientes\(\) \{ return listPendientes\(\{ soloTrabados: true \}\)/.test(provSrc),
    'countPendientes cuenta exactamente lo que el panel muestra');

  // ─── 6. El panel dejó de dibujar el modelo viejo ──────────────────────────
  const html = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
  t.ok(html.includes('function renderPendConversacion'), 'el panel dibuja la conversación');
  t.ok(/reg\.conversacion/.test(html), 'y lee el paso que arma el servidor');
  // El formulario viejo sobrevive SÓLO para los pendientes que ya existían sin
  // conversación. Si dejara de estar condicionado, volvería el bug.
  const cuerpo = html.slice(html.indexOf('function renderPendConversacion'), html.indexOf('function renderPendCard'));
  t.ok(/if \(!c\)/.test(cuerpo), 'el formulario viejo queda detrás de "no hay conversación"');
  t.ok(cuerpo.indexOf('if (!c)') < cuerpo.indexOf('fact.dudas'),
    'y factura.dudas sólo se lee adentro de esa rama');

  // El botón de "Confirmar y cargar" del pie no puede convivir con la
  // conversación: escribía la compra sin haber terminado de preguntar.
  const card = html.slice(html.indexOf('function renderPendCard'), html.indexOf('function minutosLargo'));
  t.ok(!/resolverPend\(/.test(card), 'el pie ya no ofrece confirmar por fuera de la conversación');
  t.ok(/guardarRenglones\(/.test(card), 'lo que queda en el pie es guardar los renglones');

  // ─── 7. Corregir renglones no escribe en ninguna planilla ─────────────────
  //
  // La ruta de renglones existe justamente para no disparar la carga: mezclarla
  // con /resolver haría que corregir el nombre de un producto escriba la compra.
  t.ok(rutas.includes("'/api/proveedores/pendientes/:id/items'"), 'hay una ruta sólo para renglones');
  const rItems = rutas.slice(rutas.indexOf("'/api/proveedores/pendientes/:id/items'"));
  const cuerpoItems = rItems.slice(0, rItems.indexOf('router.'));
  t.ok(!/appendCompras|registrarCompra|marcarResuelto/.test(cuerpoItems),
    'la ruta de renglones no escribe nada');
  t.ok(/delete resoluciones\.factura/.test(cuerpoItems),
    'y no deja entrar datos de cabecera: eso lo decide la conversación');

  // ─── 8. El bot sabe qué hacer con la respuesta nueva ──────────────────────
  //
  // `derivado` no trae `paso`. Sin su rama, el bot cae en `dibujar`, que espera
  // uno — y el que tocó el botón ve un mensaje roto en vez de "listo, la dejo en
  // la app". De texto porque acá no hay Python (ver tests/bot.test.js).
  const bot = fs.readFileSync(path.join(RAIZ, 'bot', 'bot.py'), 'utf8');
  t.ok(/if status == "derivado":/.test(bot), 'bot.py atiende el status derivado');
  const iDeriv = bot.indexOf('if status == "derivado":');
  const iDibujar = bot.indexOf('nuevo_mid = await dibujar(');
  t.ok(iDeriv > 0 && iDeriv < iDibujar, 'y lo atiende ANTES de intentar dibujar un paso');
  t.ok(/chat_data\.pop\("pend", None\)/.test(bot.slice(iDeriv, iDibujar)),
    'y cierra la conversación en el chat, como cancelado y escrito');

  // ─── 9. El JS de index.html PARSEA ────────────────────────────────────────
  //
  // No es de esta feature, pero se escribe acá porque acá hizo falta. Este
  // archivo no tiene build ni linter: un paréntesis de más en cualquiera de sus
  // 5.300 líneas no rompe una pantalla, rompe la app entera, y sólo se ve
  // abriéndola. Varias suites ya extraen UNA función y la ejecutan, así que
  // cazan errores adentro de esa función y de ninguna otra.
  //
  // `new Function` compila sin ejecutar: no toca el DOM ni dispara una llamada.
  const bloques = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  t.ok(bloques.length > 0, 'se encontró el bloque de script de index.html');
  const rotos = bloques.filter(b => {
    try { new Function(b[1]); return false; } catch (e) { return true; }
  });
  t.eq(rotos.length, 0, 'todo el JavaScript de index.html compila');
}

module.exports = { nombre: 'Pendientes: el panel pregunta lo mismo que el bot', run };
