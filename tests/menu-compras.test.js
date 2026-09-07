// Pedidos vive adentro de Compras, y cada rol entra por donde le sirve.
//
// El 07/09/2026 `pedidos` se mudó del grupo `operacion` al grupo `caja`
// (Compras), por decisión de Gonzalo. El motivo es que cargar una compra, ver
// llegar la entrega y pagarla son UN circuito —`POST /api/pagos` crea el pedido
// y `POST /api/pedidos/:id/recibir` escribe la fila del libro— y el menú lo
// partía en dos grupos, al punto de que la app tenía que explicar en prosa dónde
// estaba la otra mitad.
//
// Con la mudanza apareció una pregunta que antes no existía: los dos roles
// entran a Compras a cosas distintas. El dueño a mirar lo que se debe, el
// cocinero que llega a las 10 a ver qué pedidos esperar hoy. Hasta ese día
// `switchGroup` abría siempre `subs[0]`, o sea que el orden de la barra decidía
// también con qué se entra. Ahora eso lo dice `abre`, por rol.
//
// Lo que esta suite protege:
//   1. Pedidos está en Compras y no en Operación.
//   2. Pagos es soloAdmin — para el encargado esa pantalla era una pantalla rota
//      (sin tabla, sin KPIs, con un botón que le contestaba 403) y existía sólo
//      para llegar a "+ Nueva compra", que ahora está en Pedidos.
//   3. El encargado sigue viendo Pedidos, que es lo que el cambio no podía
//      romper: es su pantalla principal.
//   4. `abre` resuelve a un sub que ese rol EXISTE y VE. Una preferencia que
//      apunte a un id inexistente o escondido es la clase de error que no da
//      ningún síntoma: el grupo abre otra cosa y nadie sabe por qué.
//   5. El formulario de compra se puede abrir desde Pedidos.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

// Ejecuta el TAB_GROUPS de verdad, igual que hace tests/permisos-informes.js:
// mirar el texto contesta "¿está escrito?", ejecutarlo contesta "¿qué resuelve?".
function leerTabGroups(index) {
  const desde = index.indexOf('const TAB_GROUPS = {');
  const hasta = index.indexOf('\n};', desde);
  if (desde === -1 || hasta === -1) throw new Error('No se encontró TAB_GROUPS en index.html');
  return new Function(index.slice(desde, hasta + 3) + '\nreturn TAB_GROUPS;')();
}

// Las mismas dos reglas que aplican `gruposVisibles` y `switchGroup`.
const subsVisibles = (TAB_GROUPS, grupo, rol) =>
  (TAB_GROUPS[grupo].subs || []).filter(s => !s.soloAdmin || rol === 'admin');

// Lo que hace switchGroup desde el 07/09/2026, copiado en una línea: la
// preferencia del rol, y si no existe o no la ve, el primero que le quedó.
const abreCon = (TAB_GROUPS, grupo, rol) => {
  const subs = subsVisibles(TAB_GROUPS, grupo, rol);
  const preferido = TAB_GROUPS[grupo].abre && TAB_GROUPS[grupo].abre[rol];
  return (subs.find(s => s.id === preferido) || subs[0] || {}).id;
};

function run(t) {
  const index = fs.readFileSync(INDEX, 'utf8');
  const TAB_GROUPS = leerTabGroups(index);

  // ── 1. Dónde vive Pedidos ─────────────────────────────────────────────────
  const idsDe = g => (TAB_GROUPS[g].subs || []).map(s => s.id);
  t.ok(idsDe('caja').includes('pedidos'), 'Pedidos es un submenú de Compras');
  t.ok(!idsDe('operacion').includes('pedidos'), 'Pedidos ya no está en Operación');

  // El orden de la barra cuenta el circuito: primero lo que llega.
  t.eq(idsDe('caja')[0], 'pedidos', 'Pedidos abre la barra de Compras');

  // Operación vuelve a la regla del archivo: a los siete subs hay que repensar
  // el agrupamiento. Estuvo en siete tres días, con el costo anotado.
  t.ok(idsDe('operacion').length <= 6, 'Operación no pasa de seis submenús');

  // ── 2. Qué ve cada rol ────────────────────────────────────────────────────
  const delAdmin = subsVisibles(TAB_GROUPS, 'caja', 'admin').map(s => s.id);
  const delEnc = subsVisibles(TAB_GROUPS, 'caja', 'encargado').map(s => s.id);

  t.ok(delEnc.includes('pedidos'), 'el encargado ve Pedidos');
  t.ok(!delEnc.includes('pagos'), 'el encargado NO ve Pagos: esa pantalla era una pantalla rota para él');
  t.ok(!delEnc.includes('historial-arqueos'), 'el encargado sigue sin ver el Historial de Arqueos');
  t.ok(delEnc.includes('arqueo'), 'el encargado conserva el Arqueo');
  t.ok(delAdmin.includes('pagos'), 'el admin sí ve Pagos');

  // ── 3. Con qué entra cada uno ─────────────────────────────────────────────
  t.eq(abreCon(TAB_GROUPS, 'caja', 'admin'), 'pagos', 'el dueño entra a Compras por Pagos');
  t.eq(abreCon(TAB_GROUPS, 'caja', 'encargado'), 'pedidos', 'el cocinero entra a Compras por Pedidos');

  // ── 4. Ningún `abre` apunta al vacío ──────────────────────────────────────
  // Un id mal escrito, o uno que el rol no ve, no rompe nada visible: el grupo
  // abre otra cosa. Por eso se prueba acá y no se descubre usándolo.
  for (const [id, cfg] of Object.entries(TAB_GROUPS)) {
    if (!cfg.abre) continue;
    for (const [rol, sub] of Object.entries(cfg.abre)) {
      const visibles = subsVisibles(TAB_GROUPS, id, rol).map(s => s.id);
      t.ok(visibles.includes(sub), `${id}.abre.${rol} = "${sub}" es un submenú que ${rol} ve`);
    }
  }

  // Y switchGroup tiene que estar usándolo de verdad: sin esta línea el objeto
  // `abre` es decoración y el grupo vuelve a abrir siempre el primero.
  t.ok(/cfg\.abre\s*&&\s*cfg\.abre\[getRol\(\)\]/.test(index),
    'switchGroup lee `abre` para elegir con qué submenú entra');

  // ── 5. El formulario de compra se abre desde Pedidos ──────────────────────
  // Es lo que permite que Pagos sea soloAdmin: si el botón no estuviera acá, el
  // encargado se quedaría sin ninguna forma de cargar una compra en la
  // computadora.
  const panel = index.slice(index.indexOf('<div id="tab-pedidos"'), index.indexOf('<div class="modal-overlay" id="ped-recibir-overlay">'));
  t.ok(/onclick="openModal\(\)"/.test(panel), 'el panel de Pedidos tiene el botón de Nueva compra');

  // ── 6. Ya no queda ningún cartel mandando a la sección vieja ──────────────
  t.ok(!/Operación › Pedidos/.test(index), 'ningún texto manda a "Operación › Pedidos"');
}

module.exports = { nombre: 'Pedidos adentro de Compras', run };
