// Dashboard y Balance no pueden mostrar períodos distintos del mismo dato.
//
// Las dos pantallas leen los mismos dos endpoints —`/api/resumen` y
// `/api/actividad-diaria`— y el comentario de Balance decía que era así "para
// que los números no puedan divergir". Divergían igual: cada una tenía su propio
// par de fechas y su propio selector de mes, y Balance copiaba los del Dashboard
// UNA sola vez, en su primera apertura (`state.repBal.inicializado`). Después,
// mirar julio en una y agosto en la otra era un clic, sin nada en pantalla que
// lo dijera.
//
// Esto se prueba leyendo el archivo, no ejecutándolo: lo que se fija es que no
// vuelva a existir un segundo período. El comportamiento se verificó en un
// navegador (sincronización en los dos sentidos, y cero pedidos extra al entrar
// y salir sin cambiar nada).

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function cuerpoDe(src, nombre) {
  let desde = src.indexOf('\nasync function ' + nombre + '(');
  if (desde === -1) desde = src.indexOf('\nfunction ' + nombre + '(');
  if (desde === -1) return null;
  const fin = src.indexOf('\n}', desde);
  return fin === -1 ? src.slice(desde) : src.slice(desde, fin + 2);
}

function run(t) {
  const src = fs.readFileSync(INDEX, 'utf8');

  // 1. No queda un segundo período. `state.repBal` puede tener cómo se mira y
  //    qué se cargó, pero no modo/mes/desde/hasta.
  for (const campo of ['modo', 'mes', 'desde', 'hasta']) {
    t.ok(!src.includes('state.repBal.' + campo), `state.repBal.${campo} ya no existe (el período es uno solo)`);
  }
  t.ok(!src.includes('state.repBal.inicializado'),
    'se fue el flag que hacía que Balance copiara el período una única vez');

  // 2. Las dos pantallas escriben en el mismo lugar.
  const onDash = cuerpoDe(src, 'onFilterChange');
  const onBal = cuerpoDe(src, 'onRepFilterChange');
  t.ok(onDash && onBal, 'existen los dos manejadores de filtros');
  for (const [nombre, cuerpo] of [['Dashboard', onDash], ['Balance', onBal]]) {
    t.ok(cuerpo.includes('state.mes ='), `${nombre} escribe el mes en el estado compartido`);
    t.ok(cuerpo.includes('state.desde ='), `${nombre} escribe el desde en el estado compartido`);
    t.ok(cuerpo.includes('state.hasta ='), `${nombre} escribe el hasta en el estado compartido`);
    t.ok(cuerpo.includes('pintarPeriodoEnTodas()'), `${nombre} repinta la otra pantalla`);
  }

  // 3. Los dos conmutadores de modo escriben el mismo `state.modo`.
  const setModo = cuerpoDe(src, 'setModo');
  const setRepModo = cuerpoDe(src, 'setRepModo');
  t.ok(setModo.includes('state.modo = modo'), 'setModo escribe el modo compartido');
  t.ok(setRepModo.includes('state.modo = modo'), 'setRepModo escribe el MISMO modo compartido');

  // 4. `buildRepQS` era una copia de `buildQS` sobre otro estado. Con un solo
  //    período no hay dos consultas que armar.
  t.ok(src.includes('const buildRepQS = buildQS'), 'buildRepQS dejó de ser una segunda implementación');

  // 5. El guard de recarga. Entrar y salir de una pantalla costaba dos viajes a
  //    Google Sheets aunque no hubiera cambiado nada.
  t.ok(src.includes('function clavePeriodo()'), 'existe una identidad del período para comparar');
  const loadAll = cuerpoDe(src, 'loadAll');
  const loadBal = cuerpoDe(src, 'loadReporteBalance');
  t.ok(loadAll.includes('state.dashPeriodoCargado = clavePeriodo()'),
    'el Dashboard marca el período dentro de su loader, no en un llamador');
  t.ok(loadBal.includes('state.repBal.periodoCargado = clavePeriodo()'),
    'Balance marca el período dentro de su loader, no en un llamador');

  // 6. Una carga que falla NO queda marcada como hecha, o la pantalla se queda
  //    vacía hasta cambiar el período. Misma regla que la simulación fiscal.
  const initBal = cuerpoDe(src, 'initReporteBalance');
  t.ok(initBal.includes('periodoCargado = null'), 'una carga fallida de Balance se puede reintentar');
  const cargar = cuerpoDe(src, 'cargarPanel');
  t.ok(cargar.includes('dashPeriodoCargado = null'), 'una carga fallida del Dashboard se puede reintentar');
  t.ok(cargar.includes("tab === 'dashboard'"), 'el Dashboard tiene rama en cargarPanel (antes no la tenía)');

  // 7. La barra de submenús ya no recorta en silencio en el escritorio.
  const css = src.slice(0, src.indexOf('</style>'));
  const reglaBase = css.slice(css.indexOf('.subtab-nav {'), css.indexOf('.subtab-nav.has-subs'));
  t.ok(reglaBase.includes('flex-wrap: wrap'), 'la barra de submenús envuelve en vez de cortar');
  t.ok(!reglaBase.includes('overflow-x: auto'), 'la regla base ya no depende de un scroll con la barra oculta');
  const bloqueTelefono = css.slice(css.lastIndexOf('@media (max-width: 640px)'));
  t.ok(bloqueTelefono.includes('.subtab-nav { flex-wrap: nowrap; overflow-x: auto'),
    'en el teléfono los submenús siguen siendo una tira que se desliza');
}

module.exports = { nombre: 'Un solo período para Dashboard y Balance', run };
