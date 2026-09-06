// "Actualizar" tiene que limpiar TODOS los cachés, no dos.
//
// Hasta el 06/09/2026 `POST /api/refresh` llamaba a `clearCache()` de sheets y a
// `vinos.clearCache()`. Los otros dieciséis módulos con caché exportaban su
// limpiador y nadie los llamaba: el botón dejaba stale pedidos, plan, propinas,
// nómina, finanzas, mantenimiento, costos, facturas, saldos, avisos y
// bebidas-proveedor, en silencio.
//
// Lo que fija esta suite no es la lista, es la FORMA: si mañana aparece un módulo
// con caché y no se agrega a LIMPIADORES_DE_CACHE, acá falla. Un llamado suelto
// es lo que se olvida; una lista comparada contra el repo, no.

const fs = require('fs');
const path = require('path');
const { envFalso } = require('./_harness');

const SRC = path.join(__dirname, '..', 'src');
const SERVER = path.join(SRC, 'server.js');

// Módulos que a propósito NO entran en el refresh general.
const EXCEPCIONES = {
  // Fudo cuesta segundos: vive detrás de su propio botón, "Actualizar Fudo".
  'fudo.js': 'tiene su propio botón (POST /api/servicios/refresh)',
};

// Los módulos que exportan un limpiador, leídos del repo y no de una lista.
function modulosConLimpiador() {
  return fs.readdirSync(SRC)
    .filter(f => f.endsWith('.js'))
    .filter(f => !EXCEPCIONES[f])
    .filter(f => {
      const src = fs.readFileSync(path.join(SRC, f), 'utf8');
      const exports = src.slice(src.lastIndexOf('module.exports'));
      return /\b(clearCache|limpiarCache)\b/.test(exports);
    })
    .map(f => f.replace(/\.js$/, ''));
}

function run(t) {
  envFalso();

  const serverSrc = fs.readFileSync(SERVER, 'utf8');

  // 1. La lista existe y el endpoint la usa.
  t.ok(/const LIMPIADORES_DE_CACHE = \[/.test(serverSrc), 'existe LIMPIADORES_DE_CACHE en server.js');
  t.ok(/limpiarTodosLosCaches\(\)/.test(serverSrc), '/api/refresh llama a limpiarTodosLosCaches()');

  // 2. Cada módulo del repo con limpiador está en la lista.
  const bloque = serverSrc.slice(
    serverSrc.indexOf('const LIMPIADORES_DE_CACHE = ['),
    serverSrc.indexOf('function limpiarTodosLosCaches'),
  );
  const enLista = [...bloque.matchAll(/\['([a-z-]+)'/g)].map(m => m[1]);
  // 'planillas' es el alias de sheets.js dentro de la lista.
  const enListaNorm = enLista.map(n => (n === 'planillas' ? 'sheets' : n));

  const faltantes = modulosConLimpiador().filter(m => !enListaNorm.includes(m));
  t.eq(faltantes, [], 'todo módulo que exporta clearCache/limpiarCache está en LIMPIADORES_DE_CACHE');

  // 3. Cada entrada de la lista resuelve a una función de verdad. Es lo que
  //    convierte un typo (`propinas.clearCahe`) en un fallo acá y no en un
  //    TypeError en producción con el bar abierto.
  const rotos = [];
  for (const nombre of enListaNorm) {
    const archivo = path.join(SRC, `${nombre}.js`);
    if (!fs.existsSync(archivo)) { rotos.push(`${nombre}: no existe el archivo`); continue; }
    let mod;
    try { mod = require(archivo); } catch (e) { rotos.push(`${nombre}: no carga (${e.message})`); continue; }
    const fn = mod.clearCache || mod.limpiarCache;
    if (typeof fn !== 'function') rotos.push(`${nombre}: no exporta una función limpiadora`);
  }
  t.eq(rotos, [], 'cada entrada de LIMPIADORES_DE_CACHE resuelve a una función');

  // 4. Fudo NO entra en el refresh general, y es una decisión, no un olvido.
  t.ok(!enListaNorm.includes('fudo'), 'fudo queda fuera del refresh general (tiene su propio botón)');

  // 5. costos.js: los tres mapas se vencen por tiempo, no por reinicio del proceso.
  const costosSrc = fs.readFileSync(path.join(SRC, 'costos.js'), 'utf8');
  t.ok(!/_provGrupoCargado|_compCargadas|_overridesCargados/.test(costosSrc),
    'costos.js ya no usa flags booleanos de "ya cargué" (se vencían sólo al redeployar)');
  t.ok(/function clearCache\(\)/.test(costosSrc), 'costos.js expone clearCache()');

  const costos = require(path.join(SRC, 'costos.js'));
  t.ok(typeof costos.clearCache === 'function', 'costos.clearCache es invocable');
  t.ok((() => { try { costos.clearCache(); return true; } catch (e) { return false; } })(),
    'costos.clearCache() no tira');
}

module.exports = { nombre: 'Invalidación de cachés', run };
