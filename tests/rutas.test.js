// El orden de declaración de las rutas es parte del contrato de Express.
//
// El 04/09/2026 se agregó `GET /api/servicios/agregado` al final de server.js,
// 1.843 líneas debajo de `GET /api/servicios/:fecha`. Express resuelve por orden
// de declaración, así que toda llamada a /api/servicios/agregado entraba por el
// detalle de un día con `fecha = 'agregado'` y terminaba en un RangeError: 500.
// La ventana "Productos vendidos en el período" no abrió nunca, y nada avisó.
//
// Esta suite lee server.js COMO TEXTO. No levanta el servidor ni toca la red: lo
// que se verifica es el orden en el archivo, que es exactamente lo que se rompió.

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// Devuelve [{ metodo, ruta, linea }] en orden de aparición.
function rutasDeclaradas(src) {
  const out = [];
  const lineas = src.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(/^\s*app\.(get|post|put|delete|patch)\(\s*'([^']+)'/);
    if (m) out.push({ metodo: m[1], ruta: m[2], linea: i + 1 });
  }
  return out;
}

// Un segmento es un parámetro si empieza con ':'.
const esParam = (seg) => seg.startsWith(':');

// Dos rutas chocan cuando tienen el mismo método, la misma cantidad de segmentos,
// y una tiene un literal donde la otra tiene un parámetro, siendo el resto igual.
// En ese caso la literal DEBE estar declarada antes.
function conflictos(rutas) {
  const malos = [];
  for (let i = 0; i < rutas.length; i++) {
    for (let j = i + 1; j < rutas.length; j++) {
      const a = rutas[i], b = rutas[j];
      if (a.metodo !== b.metodo) continue;
      const sa = a.ruta.split('/'), sb = b.ruta.split('/');
      if (sa.length !== sb.length) continue;

      let aTapaB = true;   // ¿la declarada primero (a) captura lo que iba a b?
      let hayParam = false;
      for (let k = 0; k < sa.length; k++) {
        if (sa[k] === sb[k]) continue;
        if (esParam(sa[k]) && !esParam(sb[k])) { hayParam = true; continue; }
        aTapaB = false; break;
      }
      // `a` va primero en el archivo: si tiene el parámetro y `b` el literal,
      // `b` es inalcanzable.
      if (aTapaB && hayParam) malos.push({ tapada: b, tapadaPor: a });
    }
  }
  return malos;
}

function run(t) {
  const src = fs.readFileSync(SERVER, 'utf8');
  const rutas = rutasDeclaradas(src);

  t.ok(rutas.length > 100, `se encontraron rutas en server.js (${rutas.length})`);

  // 1. Ninguna ruta queda tapada por un parámetro declarado antes.
  const malos = conflictos(rutas);
  t.eq(
    malos.map(m => `${m.tapada.metodo.toUpperCase()} ${m.tapada.ruta} (línea ${m.tapada.linea}) tapada por ${m.tapadaPor.ruta} (línea ${m.tapadaPor.linea})`),
    [],
    'ninguna ruta literal queda debajo de una ruta con parámetro que la capture',
  );

  // 2. El caso concreto que se rompió, fijado por su nombre para que se lea.
  const agregado = rutas.find(r => r.ruta === '/api/servicios/agregado');
  const detalle  = rutas.find(r => r.ruta === '/api/servicios/:fecha');
  t.ok(agregado, '/api/servicios/agregado sigue existiendo');
  t.ok(detalle, '/api/servicios/:fecha sigue existiendo');
  if (agregado && detalle) {
    t.ok(agregado.linea < detalle.linea,
      `/api/servicios/agregado (${agregado.linea}) se declara antes que /api/servicios/:fecha (${detalle.linea})`);
  }

  // 3. El otro par que ya convivía bien y conviene que siga así.
  const omitir = rutas.find(r => r.ruta === '/api/pedidos/omitir' && r.metodo === 'post');
  const porId  = rutas.find(r => r.ruta === '/api/pedidos/:id' && r.metodo === 'post');
  if (omitir && porId) {
    t.ok(omitir.linea < porId.linea, 'POST /api/pedidos/omitir se declara antes que /api/pedidos/:id');
  } else {
    t.ok(true, 'no hay par omitir/:id en POST (nada que ordenar)');
  }

  // 4. No hay dos declaraciones del mismo método+ruta (la segunda sería muerta).
  const vistas = new Map();
  const dupes = [];
  for (const r of rutas) {
    const k = `${r.metodo} ${r.ruta}`;
    if (vistas.has(k)) dupes.push(`${k} (líneas ${vistas.get(k)} y ${r.linea})`);
    else vistas.set(k, r.linea);
  }
  t.eq(dupes, [], 'ninguna ruta está declarada dos veces');
}

module.exports = { nombre: 'Orden de declaración de rutas', run };
