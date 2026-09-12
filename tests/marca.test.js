// La marca de cada negocio: dos colores y un logo.
//
// Tres cosas se fijan acá, y las tres se pueden romper sin que nada dé error:
//
//   1. **Mercedes no cambia.** Sin `NEGOCIO_COLOR` la paleta son los seis
//      literales que estaban en el CSS. Es la regla que gobierna
//      config-negocio.js y acá se puede verificar valor por valor.
//   2. **La tinta se lee sobre CUALQUIER color.** Es lo único que convierte
//      "elegí tu color" en algo que no puede salir mal: se mide el contraste
//      WCAG de la paleta derivada, no se confía en que la función eligió bien.
//   3. **El logo de Mercedes no se le sirve a otro negocio.** El default de
//      `NEGOCIO_LOGO` era `/logo.jpg`, un archivo del repo —que es público— con
//      el logo de un bar de Palermo.
//
// `config-negocio` se recarga con el entorno de cada caso, y se limpia el caché
// de require al salir: hay una fuga documentada en config-negocio.test.js por no
// hacer exactamente esto.

const fs = require('fs');
const path = require('path');
const marca = require('../src/marca');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// Los colores de marca reales que puede elegir alguien: el bordó de Mercedes, un
// verde de café, un amarillo, un rojo de bandera, un rosa pastel, un violeta, y
// los tres grises/medios que son los que rompen una regla de luminancia simple.
const COLORES = [
  '#50251f', '#1b7f5a', '#e8c547', '#c8102e', '#f7d9e3', '#4a2c6b',
  '#808080', '#7f7f00', '#00a0a0', '#ff6600', '#123456', '#ffffff', '#000000',
];

function conEntorno(vars, fn) {
  const previo = {};
  for (const [k, v] of Object.entries(vars)) { previo[k] = process.env[k]; process.env[k] = v; }
  delete require.cache[require.resolve('../src/config-negocio')];
  try {
    return fn(require('../src/config-negocio'));
  } finally {
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[require.resolve('../src/config-negocio')];
  }
}

function run(t) {
  // ── 1. Mercedes, valor por valor ──────────────────────────────────────────
  const sinNada = marca.paleta('', '');
  t.eq(sinNada, marca.PALETA_MERCEDES, 'sin color configurado la paleta es la de Mercedes');
  t.eq(sinNada.accent, '#50251f', 'el accent de Mercedes sigue siendo el bordó');
  t.eq(sinNada.onAccent, '#f0e6d3', 'la tinta de Mercedes sigue siendo la crema');
  t.eq(sinNada.accentHover, '#6b3530', 'el hover de Mercedes sigue siendo el literal de siempre');
  t.eq(sinNada.accent2, '#e08a5c', 'el secundario por default es el naranja que ya usaba .btn-acento');

  // Un color inválido NO deja la app sin colores: cae a Mercedes. Una pestaña
  // vieja o una variable mal tipeada no puede dejar una pantalla en blanco.
  for (const basura of ['', '   ', 'rojo', '#12', '#1234567', 'rgb(1,2,3)', null, undefined]) {
    t.eq(marca.paleta(basura), marca.PALETA_MERCEDES, `un color inválido (${JSON.stringify(basura)}) cae al default`);
  }

  // La instancia entera, no sólo la función.
  conEntorno({ NEGOCIO_ID: 'mercedes', NEGOCIO_COLOR: '', NEGOCIO_COLOR_2: '', NEGOCIO_LOGO: '' }, cfg => {
    t.eq(cfg.PALETA, marca.PALETA_MERCEDES, 'la instancia Mercedes arranca con su paleta de siempre');
    t.eq(cfg.NEGOCIO_LOGO, '/logo.jpg', 'Mercedes sigue mostrando su logo del repo');
    t.ok(cfg.paraElNavegador().paleta, 'la paleta viaja en GET /api/config');
  });

  // ── 2. La tinta se lee encima, sea cual sea el color ──────────────────────
  //
  // Ésta es la afirmación que hace que la función valga: 4.5 es el mínimo de la
  // WCAG para texto normal, y estos seis colores son fondos de botón con una
  // palabra encima.
  for (const c of COLORES) {
    const p = marca.paleta(c, c);
    const ct = marca.contraste(p.accent, p.onAccent);
    t.ok(ct >= marca.CONTRASTE_MINIMO, `${c}: la tinta sobre el primario contrasta ${ct && ct.toFixed(2)} (mínimo ${marca.CONTRASTE_MINIMO})`);
    const ct2 = marca.contraste(p.accent2, p.onAccent2);
    t.ok(ct2 >= marca.CONTRASTE_MINIMO, `${c}: la tinta sobre el secundario contrasta ${ct2 && ct2.toFixed(2)}`);
  }

  // El caso que obligó a salir de las dos tintas de la casa. Si alguien vuelve a
  // elegir "la de mayor contraste entre crema y oscura" sin el escalón, esto cae.
  const verde = marca.paleta('#1b7f5a');
  t.ok(marca.contraste('#1b7f5a', marca.TINTA_CLARA) < marca.CONTRASTE_MINIMO,
    'el verde medio NO llega al mínimo con la crema de la casa (es el caso que motivó el escalón)');
  t.ok(marca.contraste(verde.accent, verde.onAccent) >= marca.CONTRASTE_MINIMO,
    'y aun así la paleta le da una tinta legible');

  // El hover se mueve, y para el lado correcto: un color oscuro se aclara.
  t.ok(marca.luminancia(marca.hoverDe('#50251f')) > marca.luminancia('#50251f'),
    'un color oscuro se aclara en el hover');
  t.ok(marca.luminancia(marca.hoverDe('#e8c547')) < marca.luminancia('#e8c547'),
    'un color claro se oscurece en el hover (sobre fondo negro, aclararlo lo empasta)');
  for (const c of COLORES) {
    t.ok(marca.hoverDe(c) !== c, `${c}: el hover no es idéntico al color`);
  }

  // El soft conserva el color y sólo le pone alfa.
  t.eq(marca.softDe('#50251f'), 'rgba(80, 37, 31, 0.18)', 'el fondo suave es el mismo color al 18%');

  // ── 3. El bloque CSS que se inyecta ───────────────────────────────────────
  const css = marca.bloqueCss(marca.paleta('#1b7f5a', '#e8c547'));
  for (const v of ['--accent:', '--accent-hover:', '--accent-soft:', '--on-accent:', '--accent2:', '--on-accent2:']) {
    t.ok(css.includes(v), `el bloque inyectado define ${v}`);
  }
  t.ok(css.startsWith(':root{') && css.endsWith('}'), 'el bloque es una regla :root cerrada');
  t.ok(!css.includes('#50251f'), 'con un color propio, el bordó de Mercedes no aparece en el CSS servido');

  // ── 4. El HTML no tiene el color de marca escrito a mano ──────────────────
  //
  // La regla es la forma, no el archivo: si alguien vuelve a escribir la crema o
  // el bordó en una clase nueva, ese lugar deja de seguir la marca del negocio y
  // NO da ningún error — se ve bien en Mercedes y mal en todos los demás.
  const html = fs.readFileSync(INDEX, 'utf8');
  const cuerpo = html.slice(html.indexOf('</style>') === -1 ? 0 : 0); // el archivo entero
  const prohibidos = ['#f0e6d3', '#6b3530', 'rgba(107,53,48', 'rgba(80,37,31'];
  for (const lit of prohibidos) {
    const donde = [];
    cuerpo.split('\n').forEach((l, i) => { if (l.includes(lit)) donde.push(i + 1); });
    // El :root puede declarar los defaults; cualquier otra línea, no.
    const fuera = donde.filter(n => n > 25);
    t.eq(fuera, [], `${lit} no está escrito fuera del :root (líneas: ${fuera.join(', ')})`);
  }
  t.ok(html.includes('var(--on-accent)'), 'la tinta sobre el accent sale de la variable');
  t.ok(html.includes('var(--accent-hover)'), 'el hover sale de la variable');
  t.ok(html.includes('var(--accent-soft)'), 'el fondo suave sale de la variable');
  t.ok(html.includes('var(--accent2)'), 'el botón de acción usa el color secundario');

  // El :root sigue declarando los cinco, que son el fallback si la inyección
  // falla: sin esto la app se quedaría sin tinta y sin hover.
  const root = html.slice(html.indexOf(':root'), html.indexOf(':root') + 1200);
  for (const v of ['--accent:', '--accent-hover:', '--accent-soft:', '--on-accent:', '--accent2:', '--on-accent2:']) {
    t.ok(root.includes(v), `el :root del HTML declara ${v} como fallback`);
  }

  // Los gráficos leen el color del CSS en vez de tenerlo escrito.
  t.ok(html.includes('colorDeMarca()'), 'CHART_COLORS toma el color de marca del CSS');
  t.ok(!/CHART_COLORS = \['#50251f'/.test(html), 'CHART_COLORS ya no arranca con el bordó escrito a mano');

  // ── 5. El logo ────────────────────────────────────────────────────────────
  conEntorno({ NEGOCIO_ID: 'doc', NEGOCIO_NOMBRE: 'DOC Café', NEGOCIO_LOGO: '', NEGOCIO_COLOR: '#1b7f5a' }, cfg => {
    t.eq(cfg.NEGOCIO_LOGO, '', 'fuera de Mercedes, sin variable, NO se sirve /logo.jpg');
    t.ok(cfg.paraElNavegador().logo === '', 'y el navegador recibe el vacío, que es lo que dispara la inicial');
    t.eq(cfg.PALETA.accent, '#1b7f5a', 'el color propio llega a la paleta de la instancia');
    t.ok(cfg.PALETA.accentHover !== '#6b3530', 'y el hover se deriva del color propio');
  });

  conEntorno({ NEGOCIO_ID: 'doc', NEGOCIO_LOGO: 'https://ejemplo.com/doc.png' }, cfg => {
    t.eq(cfg.NEGOCIO_LOGO, 'https://ejemplo.com/doc.png',
      'una URL entera vale como logo: el archivo no tiene que vivir en el repo público');
  });

  // El HTML tiene el lugar donde se dibuja la inicial, y aplicarConfigNegocio
  // apaga el <img> en vez de dejarlo con el src de Mercedes.
  t.ok(html.includes('data-negocio="inicial"'), 'el HTML tiene dónde dibujar la inicial del negocio');
  t.eq((html.match(/class="logo-inicial"/g) || []).length, 2,
    'hay una inicial por cada logo (login y header)');
  const aplicar = html.slice(html.indexOf('function aplicarConfigNegocio'), html.indexOf('async function cargarConfigNegocio'));
  t.ok(aplicar.includes('logos[k].hidden = true'), 'sin logo, el <img> del logo se esconde');
  t.ok(!/if \(NEGOCIO\.logo\) \{\s*var logos/.test(aplicar),
    'la rama sin logo existe (antes el else no estaba y quedaba el logo de Mercedes)');

  // ── 7. La rama del logo, corrida de verdad ────────────────────────────────
  //
  // Las afirmaciones de texto de arriba dicen que el código está escrito; ésta
  // dice que hace lo que tiene que hacer. `aplicarConfigNegocio` se saca del
  // HTML y se corre contra un DOM de mentira con los dos <img> y las dos
  // iniciales — el mismo procedimiento que `validarCompra`/`rangoDePreset`: donde
  // una función es pura (o casi), se ejerce en vez de leerse.
  const fuente = html.slice(html.indexOf('function aplicarConfigNegocio'),
                            html.indexOf('// Se espera a que resuelva antes de dibujar nada'));

  function correrAplicar(cfg) {
    const nodo = (attrs) => ({
      ...attrs, hidden: false, textContent: '',
      setAttribute(k, v) { this[k] = v; },
    });
    const logos = [nodo({ src: '/logo.jpg', alt: 'Bar Mercedes' }), nodo({ src: '/logo.jpg', alt: 'Bar Mercedes' })];
    const iniciales = [nodo({}), nodo({})];
    const titulos = [nodo({}), nodo({})];
    const doc = {
      title: '',
      querySelectorAll(sel) {
        if (sel.includes('logo')) return logos;
        if (sel.includes('inicial')) return iniciales;
        return titulos;
      },
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function('NEGOCIO', 'document', 'llenarSelectsDeCajas',
      fuente + '\nreturn aplicarConfigNegocio();');
    fn(cfg, doc, () => {});
    return { logos, iniciales, titulos, doc };
  }

  const conLogo = correrAplicar({ nombre: 'DOC Café', logo: 'https://ejemplo.com/doc.png' });
  t.eq(conLogo.logos[0].src, 'https://ejemplo.com/doc.png', 'con logo, el <img> apunta al del cliente');
  t.eq(conLogo.logos[0].alt, 'DOC Café', 'y el alt deja de decir Bar Mercedes');
  t.eq(conLogo.logos[0].hidden, false, 'con logo, el <img> se ve');
  t.eq(conLogo.iniciales[0].hidden, true, 'con logo, la inicial NO se dibuja');

  const sinLogo = correrAplicar({ nombre: 'DOC Café', logo: '' });
  t.eq(sinLogo.logos[0].src, '/logo.jpg', 'sin logo el src queda como estaba...');
  t.eq(sinLogo.logos[0].hidden, true, '...pero el <img> se esconde: NADIE ve el logo de Mercedes');
  t.eq(sinLogo.logos[1].hidden, true, 'los dos logos, el del login y el del header');
  t.eq(sinLogo.iniciales[0].hidden, false, 'sin logo aparece la inicial');
  t.eq(sinLogo.iniciales[0].textContent, 'D', 'y la inicial es la del nombre del negocio');

  const sinNombre = correrAplicar({ nombre: '', logo: '' });
  t.eq(sinNombre.iniciales[0].hidden, true, 'sin nombre ni logo no se dibuja un círculo vacío');

  // ── 6. El server inyecta la marca ANTES de express.static ─────────────────
  //
  // static contesta `/` con index.html por su cuenta, así que declarado después
  // el handler no se usaría nunca y nadie vería un error: es el mismo modo de
  // falla que el repo ya documenta para el guard de módulos y para
  // /api/servicios/agregado.
  const srv = fs.readFileSync(SERVER, 'utf8');
  const iHandler = srv.indexOf("app.get(['/', '/index.html']");
  const iStatic = srv.indexOf('app.use(express.static');
  t.ok(iHandler > -1, 'el server sirve / con la marca inyectada');
  t.ok(iStatic > -1, 'express.static sigue declarado');
  t.ok(iHandler < iStatic, 'el handler de / está ANTES de express.static, o no se usa nunca');
  t.ok(srv.includes('lastIndexOf(\'</head>\')'),
    'la marca se inyecta al final del <head>, después del <style> con los defaults');
}

module.exports = { nombre: 'La marca de cada negocio: colores y logo', run };
