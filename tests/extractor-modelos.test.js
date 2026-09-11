// Qué modelo lee cada mitad de la factura.
//
// Desde el 11/09/2026 el extractor usa DOS modelos distintos, y cuál va en cada
// mitad no es una preferencia: sale de medir con `scripts/comparar-extractor.js`
// sobre facturas reales. La cabecera —donde está la plata— la lee Haiku igual
// que Opus, y donde no puede, duda, que es lo que esta app quiere. Los renglones
// no: en una factura densa Haiku corrió cinco precios un renglón, y eso entra a
// `Compras` sin que nadie pregunte.
//
// Lo que esta suite cuida es la resolución de las variables, que es donde esto
// se rompe en silencio:
//
//   · que el default sea el par medido, y no los dos en el mismo modelo;
//   · que `EXTRACTOR_MODEL` siga pisando las dos. Es la marcha atrás sin deploy,
//     y una marcha atrás que no funciona sólo se descubre el día que hace falta;
//   · que las dos mitades no se crucen — un copy/paste que le pase
//     MODELO_CABECERA a los renglones ahorra plata y ensucia Compras, sin dar
//     ningún error.
//
// Corre de verdad: recarga el módulo con distintos entornos y mira qué exporta.

const path = require('path');
const fs = require('fs');

const RAIZ = path.join(__dirname, '..');
const RUTA = path.join(RAIZ, 'src', 'extractor.js');

const CLAVES = ['EXTRACTOR_MODEL', 'EXTRACTOR_MODEL_CABECERA', 'EXTRACTOR_MODEL_ITEMS'];

// Recarga el extractor con un entorno dado. Hay que sacarlo del cache de
// require: el módulo lee process.env una sola vez, al cargarse.
//
// El entorno se restaura al salir Y el módulo se saca del cache al final, las
// dos cosas. Limpiar sólo el entorno es el error que ya pasó una vez en este
// repo (la suite de multi-negocio dejaba cargada la versión de Pulpería en
// memoria, y la suite siguiente fallaba por las cajas del otro bar).
function cargar(env) {
  const previo = {};
  for (const k of CLAVES) { previo[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve(RUTA)];
  const ext = require(RUTA);
  for (const k of CLAVES) {
    if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k];
  }
  return ext;
}

function run(t) {
  // 1. El default es el par medido. Si algún día los dos vuelven a ser iguales,
  //    que sea una decisión y no un merge.
  const base = cargar({});
  t.eq(base.MODELO_CABECERA, 'claude-haiku-4-5', 'por default la cabecera la lee Haiku');
  t.eq(base.MODELO_ITEMS, 'claude-opus-4-6', 'por default los renglones los lee Opus');
  t.ok(base.MODELO_CABECERA !== base.MODELO_ITEMS, 'las dos mitades no usan el mismo modelo');

  // 2. La marcha atrás: una sola variable devuelve todo a un modelo.
  const atras = cargar({ EXTRACTOR_MODEL: 'claude-opus-4-6' });
  t.eq(atras.MODELO_CABECERA, 'claude-opus-4-6', 'EXTRACTOR_MODEL pisa la cabecera');
  t.eq(atras.MODELO_ITEMS, 'claude-opus-4-6', 'EXTRACTOR_MODEL pisa los renglones');

  // 3. Cada mitad se puede mover sola, sin tocar la otra.
  const soloCab = cargar({ EXTRACTOR_MODEL_CABECERA: 'claude-sonnet-5' });
  t.eq(soloCab.MODELO_CABECERA, 'claude-sonnet-5', 'la cabecera se puede cambiar sola');
  t.eq(soloCab.MODELO_ITEMS, 'claude-opus-4-6', 'y eso no toca los renglones');

  const soloItems = cargar({ EXTRACTOR_MODEL_ITEMS: 'claude-sonnet-5' });
  t.eq(soloItems.MODELO_ITEMS, 'claude-sonnet-5', 'los renglones se pueden cambiar solos');
  t.eq(soloItems.MODELO_CABECERA, 'claude-haiku-4-5', 'y eso no toca la cabecera');

  // 4. EXTRACTOR_MODEL le gana a las específicas. Es lo que hace que la marcha
  //    atrás funcione en una instancia que ya tenga las dos cargadas — que es
  //    exactamente la instancia donde va a hacer falta.
  const gana = cargar({
    EXTRACTOR_MODEL: 'claude-opus-4-6',
    EXTRACTOR_MODEL_CABECERA: 'claude-haiku-4-5',
    EXTRACTOR_MODEL_ITEMS: 'claude-haiku-4-5',
  });
  t.eq(gana.MODELO_CABECERA, 'claude-opus-4-6', 'EXTRACTOR_MODEL le gana a la de cabecera');
  t.eq(gana.MODELO_ITEMS, 'claude-opus-4-6', 'EXTRACTOR_MODEL le gana a la de renglones');

  // 5. Cada llamada manda SU modelo, y son los que corresponden. El texto es lo
  //    único que puede ver esto sin llamar a la API: la cabecera con
  //    MODELO_CABECERA, y las tres que leen renglones —factura, remito y el
  //    camino viejo de una sola llamada— con MODELO_ITEMS.
  const src = fs.readFileSync(RUTA, 'utf8');
  const llamadas = [
    ['buildPromptCabecera(hoy)', 'MODELO_CABECERA'],
    ['buildPromptItems()', 'MODELO_ITEMS'],
    ['buildPromptRemito()', 'MODELO_ITEMS'],
    ['buildPrompt()', 'MODELO_ITEMS'],
  ];
  for (const [prompt, modelo] of llamadas) {
    const linea = src.split(/\r?\n/).find(l => l.includes('prompt: ' + prompt));
    t.ok(linea && linea.includes('modelo: ' + modelo),
      `la llamada con ${prompt} usa ${modelo}`);
  }

  // 6. Y no queda ningún call site sin modelo: `pedirAlModelo` tira si falta,
  //    pero tiraría recién con una factura de verdad adelante.
  const sinModelo = src.split(/\r?\n/).filter(l => /prompt: build/.test(l) && !/modelo:/.test(l));
  t.eq(sinModelo, [], 'ninguna llamada al modelo se quedó sin decir cuál');

  // Devolver el módulo al cache en su forma normal, sin las variables de prueba.
  cargar({});
}

module.exports = { nombre: 'Extractor: un modelo por mitad de la factura', run };
