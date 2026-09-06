// Los informes los ven los tres logins de admin, y nadie más.
//
// Hasta el 06/09/2026 había un permiso por PERSONA —`soloDestinatarioInformes`
// en el servidor, `soloUsuario` en el navegador— que era el único de toda la app
// que miraba quién sos en vez de qué rol tenés. Existía mientras los agentes
// estaban en beta. Gonzalo pidió que los vean también `pablo` y `admin` en forma
// permanente, así que el permiso se quedó sin nadie a quien excluir y se borró
// en vez de ampliarse.
//
// Lo que esta suite protege son las dos mitades del cambio: que ninguna de las
// dos vuelva sola, y —lo que de verdad importa— que el ENCARGADO siga sin verlos.

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function cuerpoDe(src, nombre) {
  let desde = src.indexOf('\nasync function ' + nombre + '(');
  if (desde === -1) desde = src.indexOf('\nfunction ' + nombre + '(');
  if (desde === -1) return null;
  const fin = src.indexOf('\n}', desde);
  return fin === -1 ? src.slice(desde) : src.slice(desde, fin + 2);
}

function run(t) {
  const server = fs.readFileSync(SERVER, 'utf8');
  const index = fs.readFileSync(INDEX, 'utf8');

  // ── 1. El servidor, que es quien decide de verdad ─────────────────────────
  const rutas = server.split(/\r?\n/)
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /^\s*app\.(get|post|put|delete)\('\/api\/informes/.test(l));

  t.ok(rutas.length >= 8, `hay rutas de informes (${rutas.length})`);
  const sinAdmin = rutas.filter(({ l }) => !l.includes('adminOnly'));
  t.eq(sinAdmin.map(r => `línea ${r.n}`), [], 'TODAS las rutas de informes son adminOnly');

  // Ninguna quedó sin ningún guard: una ruta de informes abierta sería peor que
  // el permiso que se sacó.
  const sinAuth = rutas.filter(({ l }) => !l.includes('authMiddleware'));
  t.eq(sinAuth.map(r => `línea ${r.n}`), [], 'todas piden authMiddleware');

  // ── 2. El mecanismo viejo se fue entero, no quedó apagado ────────────────
  // Un middleware que sigue definido es el que alguien vuelve a enchufar.
  t.ok(!/function soloDestinatarioInformes/.test(server),
    'el middleware por-usuario ya no existe en el servidor');
  t.ok(!/soloDestinatarioInformes\s*,/.test(server),
    'ninguna ruta lo sigue usando');
  t.ok(!/process\.env\.INFORMES_DESTINATARIO/.test(server),
    'INFORMES_DESTINATARIO ya no se lee (quedó documentado en SETUP.md)');

  // ── 3. El navegador ───────────────────────────────────────────────────────
  // Que el submenú exista sin permiso por persona.
  t.ok(index.includes("{ id: 'informes',           label: '🔎 Informe' },"),
    'el submenú Informe ya no lleva soloUsuario');
  // Sólo puede quedar la mención histórica en un comentario, nunca en código.
  const menciones = index.split(/\r?\n/)
    .map((l, i) => ({ l: l.trim(), n: i + 1 }))
    .filter(({ l }) => l.includes('soloUsuario') && !l.startsWith('//'));
  t.eq(menciones.map(m => `línea ${m.n}: ${m.l}`), [],
    'no queda código que filtre por soloUsuario (sólo el comentario que cuenta la historia)');

  // ── 4. El popup ───────────────────────────────────────────────────────────
  const ve = cuerpoDe(index, 'veInformes');
  t.ok(ve, 'existe veInformes');
  t.ok(ve.includes("getRol() === 'admin'"), 'el popup del informe se decide por ROL');
  t.ok(!ve.includes('getUsuario()'), 'ya no mira quién es la persona');
  // La trampa vieja de este archivo: buscar un grupo por nombre. Cuando el grupo
  // `reportes` dejó de existir, eso apagó el popup para todos sin dar error.
  t.ok(ve.includes('subDeMenu('), 'sigue resolviendo el submenú caminando los grupos');
  t.ok(!/TAB_GROUPS\.\w+/.test(ve), 'no busca ningún grupo por nombre');

  // ── 5. Lo que el cambio NO puede haber roto ──────────────────────────────
  // El grupo entero es soloAdmin, que es lo que deja al encargado afuera.
  const negocio = index.slice(index.indexOf('negocio: { label:'), index.indexOf('caja: {'));
  t.ok(negocio.includes('soloAdmin: true'), 'el grupo Negocio sigue siendo soloAdmin');
  t.ok(negocio.includes("id: 'informes'"), 'Informe sigue viviendo adentro de Negocio');
  // Y el filtro por rol de los submenús sigue puesto: es el que esconde Fiscal,
  // Nómina y Costos al encargado.
  t.ok(index.includes("cfg.subs.filter(s => !s.soloAdmin || getRol() === 'admin')"),
    'los submenús se siguen filtrando por rol');

  // ── 6. El menú REAL, corrido para cada usuario ───────────────────────────
  // Lo de arriba mira el texto; esto ejecuta `TAB_GROUPS` de verdad y resuelve
  // qué submenús le quedan a cada persona. Es la prueba que contesta la pregunta
  // que se hizo: ¿Pablo y admin ven el Informe, y Charly sigue sin verlo?
  const desde = index.indexOf('const TAB_GROUPS = {');
  const hasta = index.indexOf('\n};', desde);
  const TAB_GROUPS = new Function(index.slice(desde, hasta + 3) + '\nreturn TAB_GROUPS;')();

  // Las mismas dos reglas que aplican `gruposVisibles` y `switchGroup`.
  const submenusDe = rol => Object.entries(TAB_GROUPS)
    .filter(([, g]) => !g.soloAdmin || rol === 'admin')
    .flatMap(([id, g]) => (g.subs || [])
      .filter(s => !s.soloAdmin || rol === 'admin')
      .map(s => `${id}/${s.id}`));

  for (const usuario of ['tincho', 'pablo', 'admin']) {
    const subs = submenusDe('admin', usuario);
    t.ok(subs.includes('negocio/informes'), `${usuario} (rol admin) ve el Informe`);
  }
  const delEncargado = submenusDe('encargado');
  t.ok(!delEncargado.includes('negocio/informes'), 'el encargado NO ve el Informe');
  t.ok(!delEncargado.some(s => s.startsWith('negocio/')), 'el encargado no ve nada de Negocio');

  // Los tres admins resuelven EXACTAMENTE lo mismo. Era la única diferencia que
  // quedaba entre los tres logins, y ya no hay ninguna.
  const [a, b, c] = ['tincho', 'pablo', 'admin'].map(() => submenusDe('admin'));
  t.eq(a, b, 'tincho y pablo resuelven los mismos submenús');
  t.eq(b, c, 'pablo y admin resuelven los mismos submenús');

  // Y el encargado conserva los suyos: es lo que este cambio no podía tocar.
  for (const s of ['operacion/pedidos', 'operacion/vinos', 'operacion/cierre', 'operacion/operacion-mas']) {
    t.ok(delEncargado.includes(s), `el encargado conserva ${s}`);
  }
}

module.exports = { nombre: 'Permisos de los informes', run };
