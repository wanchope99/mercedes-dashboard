// Los atajos de rango: "Hoy · 7 días · Este mes · Mes pasado".
//
// Son la única aritmética de fechas nueva de esta tanda, y la aritmética de
// fechas es donde este repo ya se quemó dos veces: `toISOString()` sobre la hora
// actual, pasadas las 21:00 en Argentina, devuelve el día SIGUIENTE. Por eso los
// atajos salen de `hoyISOLocal()` y no de `new Date()`.
//
// Cómo se prueban sin navegador: se extrae el texto de las funciones puras del
// index.html y se las evalúa acá con un `hoyISOLocal` fijo. Es el mismo patrón
// que ya usaban las verificaciones sueltas de cada sesión — datos en memoria,
// ninguna planilla, ningún DOM — sólo que ahora queda escrito.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

// Extrae un bloque desde una marca hasta otra, para evaluarlo suelto.
function trozo(src, desdeMarca, hastaMarca) {
  const a = src.indexOf(desdeMarca);
  if (a === -1) return null;
  const b = src.indexOf(hastaMarca, a);
  return b === -1 ? null : src.slice(a, b);
}

function cargarPuras(hoyFijo) {
  const src = fs.readFileSync(INDEX, 'utf8');
  const codigo = trozo(src, 'const PRESETS_RANGO = [', 'function presetsHTML');
  if (!codigo) return null;
  // `hoyISOLocal` vive en otra parte del archivo: se inyecta fijo para que el
  // resultado no dependa del día en que se corren los tests.
  const envoltorio = new Function(
    'hoyISOLocal',
    codigo + '\nreturn { PRESETS_RANGO, rangoDePreset, presetDeRango };'
  );
  return envoltorio(() => hoyFijo);
}

function run(t) {
  // Un miércoles de septiembre. Se elige un mes de 30 días con el anterior de 31.
  const M = cargarPuras('2026-09-16');
  t.ok(M, 'se pueden extraer las funciones puras de los atajos desde index.html');
  if (!M) return;

  const { rangoDePreset, presetDeRango, PRESETS_RANGO } = M;

  t.eq(PRESETS_RANGO.map(p => p.id), ['hoy', '7d', 'mes', 'mespas'], 'los cuatro atajos, en ese orden');

  // 1. Hoy.
  t.eq(rangoDePreset('hoy'), { desde: '2026-09-16', hasta: '2026-09-16' }, 'Hoy es un solo día');

  // 2. Siete días INCLUYE hoy: son 7 fechas, no 8. Es lo que ya significaba el
  //    default de Servicios (SERVICIOS_DIAS_DEFAULT - 1).
  t.eq(rangoDePreset('7d'), { desde: '2026-09-10', hasta: '2026-09-16' }, '7 días cuenta hoy adentro');

  // 3. Este mes: del 1 a hoy, no al fin de mes. Un rango que termina en el
  //    futuro haría que el promedio por servicio se divida por días que no
  //    ocurrieron.
  t.eq(rangoDePreset('mes'), { desde: '2026-09-01', hasta: '2026-09-16' }, 'Este mes va del 1 a hoy');

  // 4. Mes pasado: entero, del 1 al último.
  t.eq(rangoDePreset('mespas'), { desde: '2026-08-01', hasta: '2026-08-31' }, 'Mes pasado es el mes completo');

  // 5. Los bordes que rompen la aritmética de meses.
  const enero = cargarPuras('2026-01-05');
  t.eq(enero.rangoDePreset('mespas'), { desde: '2025-12-01', hasta: '2025-12-31' },
    'en enero, el mes pasado es diciembre del año anterior');
  t.eq(enero.rangoDePreset('7d'), { desde: '2025-12-30', hasta: '2026-01-05' },
    '7 días cruza el año sin romperse');

  const marzo = cargarPuras('2026-03-10');
  t.eq(marzo.rangoDePreset('mespas'), { desde: '2026-02-01', hasta: '2026-02-28' },
    'febrero de un año común tiene 28 días');
  const marzoBisiesto = cargarPuras('2028-03-10');
  t.eq(marzoBisiesto.rangoDePreset('mespas'), { desde: '2028-02-01', hasta: '2028-02-29' },
    'febrero de un año bisiesto tiene 29');

  const finDeMes = cargarPuras('2026-05-31');
  t.eq(finDeMes.rangoDePreset('mespas'), { desde: '2026-04-01', hasta: '2026-04-30' },
    'estando a 31, el mes pasado de 30 días no se desborda');
  t.eq(finDeMes.rangoDePreset('mes'), { desde: '2026-05-01', hasta: '2026-05-31' },
    'el último día del mes, "este mes" llega hasta él');

  // 6. Un id que no existe no inventa un rango.
  t.eq(rangoDePreset('cualquiera'), null, 'un atajo desconocido devuelve null en vez de un rango raro');

  // 7. El camino de vuelta: qué atajo describe un rango. Es lo que enciende el
  //    botón correcto cuando el rango viene de localStorage.
  t.eq(presetDeRango('2026-09-01', '2026-09-16'), 'mes', 'reconoce "este mes"');
  t.eq(presetDeRango('2026-08-01', '2026-08-31'), 'mespas', 'reconoce "mes pasado"');
  t.eq(presetDeRango('2026-09-16', '2026-09-16'), 'hoy', 'reconoce "hoy"');
  t.eq(presetDeRango('2026-09-03', '2026-09-11'), null, 'un rango tipeado a mano no enciende ningún atajo');
  t.eq(presetDeRango('', ''), null, 'un rango vacío no enciende ningún atajo');
  t.eq(presetDeRango('2026-09-01', null), null, 'un rango a medias no enciende ningún atajo');

  // 8. Todos los atajos devuelven fechas bien formadas y desde <= hasta.
  for (const p of PRESETS_RANGO) {
    const r = rangoDePreset(p.id);
    t.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.desde) && /^\d{4}-\d{2}-\d{2}$/.test(r.hasta),
      `${p.id}: las dos fechas tienen forma ISO`);
    t.ok(r.desde <= r.hasta, `${p.id}: desde no queda después de hasta`);
  }

  // 9. El HTML de los atajos no interpola una función: eso pegaría código fuente
  //    adentro de un atributo onclick.
  const src = fs.readFileSync(INDEX, 'utf8');
  t.ok(src.includes('nombreRecargar'), 'presetsHTML recibe el NOMBRE de la función, no la función');
  // Las cinco pantallas con rango de fechas. Las dos primeras llaman a
  // `onRangoManual` desde el propio input; las otras tres ya tenían su handler
  // de filtros y lo que se les agregó es que recuerde y marque el atajo.
  for (const [cont, d, h, fn] of [
    ['serv-presets', 'serv-desde', 'serv-hasta', 'loadServicios'],
    ['costos-presets', 'costos-desde', 'costos-hasta', 'loadCostos'],
    ['dash-presets', 'filter-desde', 'filter-hasta', 'onFilterChange'],
    ['rep-presets', 'rep-filter-desde', 'rep-filter-hasta', 'onRepFilterChange'],
    ['rsv-presets', 'rsv-filter-desde', 'rsv-filter-hasta', 'onRepServPeriodoChange'],
  ]) {
    t.ok(src.includes(`id="${cont}"`), `existe el contenedor ${cont} en el HTML`);
    t.ok(src.includes(`montarPresets('${cont}', '${d}', '${h}', '${fn}')`), `${cont} se monta con ${fn}`);
  }
  for (const [d, h, fn] of [
    ['serv-desde', 'serv-hasta', 'loadServicios'],
    ['costos-desde', 'costos-hasta', 'loadCostos'],
  ]) {
    t.ok(src.includes(`onRangoManual('${d}','${h}',${fn})`), `tipear una fecha en ${d}/${h} recuerda y recarga`);
  }
  for (const fn of ['onFilterChange', 'onRepFilterChange', 'onRepServPeriodoChange']) {
    const cuerpo = src.slice(src.indexOf('function ' + fn + '('));
    t.ok(cuerpo.slice(0, 500).includes('recordarRango('), `${fn} recuerda el rango`);
  }

  // 10. El rango se guarda por pantalla: la clave lleva los ids adentro, así que
  //     el de Costos no puede pisar el de Servicios.
  t.ok(src.includes('mb_rango_${idDesde}_${idHasta}'), 'la clave de localStorage incluye los dos ids');
  t.ok(src.includes('catch (e) { /* modo privado'), 'escribir en localStorage no puede romper la pantalla');
}

module.exports = { nombre: 'Atajos de rango de fechas', run };
