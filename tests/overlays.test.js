// Cada ventana modal necesita su propia regla de CSS, o se dibuja A LA VISTA.
//
// En esta app NO hay un estilo genérico para `.modal-overlay`: cada overlay
// declara el suyo por id (`display:none` + `.open { display:flex }`). Es una
// decisión vieja y está escrita en el propio archivo, dos veces, con la
// advertencia incluida.
//
// Igual volvió a pasar. El 07/09/2026 se agregó `#ped-prov-overlay` con la
// clase y sin la regla, y el formulario "¿Quién trajo el pedido?" apareció
// dibujado en el medio de la página, en TODAS las secciones — Gonzalo lo
// encontró parado en Pagos. Ya había pasado con los dos modales de saldos en
// agosto, y el comentario que lo cuenta estaba a treinta líneas del lugar donde
// había que agregar la regla.
//
// O sea: la advertencia escrita no alcanzó dos veces. Esto lo prueba en vez de
// avisarlo. Recorre TODOS los overlays del archivo y falla si alguno no tiene
// cómo esconderse — el que venga después no necesita haber leído nada.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function run(t) {
  const index = fs.readFileSync(INDEX, 'utf8');

  // El bloque de estilos, que es donde tienen que estar las reglas. Se corta
  // ahí para no confundir un `display:none` que esté en el HTML de otra cosa.
  const css = index.slice(index.indexOf('<style'), index.indexOf('</style>'));
  t.ok(css.length > 1000, 'se encontró la hoja de estilos');

  // Todos los ids que terminan en -overlay, que es la convención de la app
  // (`Escape` cierra el de más arriba recorriendo justamente `[id$="-overlay"]`).
  const ids = [...index.matchAll(/id="([\w-]+-overlay)"/g)].map(m => m[1]);
  const unicos = [...new Set(ids)];
  t.ok(unicos.length > 20, `hay overlays para revisar (${unicos.length})`);

  // Un id puede estar escondido de dos formas legítimas:
  //   · una regla de CSS que lo nombre y le ponga display:none
  //   · un style inline en el propio div
  // Las dos valen; lo que no vale es ninguna.
  const reglasQueLoNombran = id => {
    const out = [];
    const re = new RegExp('[^{}]*#' + id + '\\b[^{}]*\\{[^}]*\\}', 'g');
    for (const m of css.matchAll(re)) out.push(m[0]);
    return out;
  };

  const inlineOculto = id => {
    const re = new RegExp('id="' + id + '"[^>]*style="[^"]*display:\\s*none', 'i');
    if (re.test(index)) return true;
    // El atributo style puede venir ANTES del id en el mismo tag.
    const re2 = new RegExp('<div[^>]*style="[^"]*display:\\s*none[^"]*"[^>]*id="' + id + '"', 'i');
    return re2.test(index);
  };

  for (const id of unicos) {
    // `login-screen` y los que no son overlays de verdad no entran acá: el
    // filtro ya es "termina en -overlay".
    const reglas = reglasQueLoNombran(id);
    const seEsconde = reglas.some(r => /display:\s*none/.test(r)) || inlineOculto(id);
    t.ok(seEsconde,
      `#${id} tiene cómo esconderse (regla propia con display:none, o style inline)`);

    // Y tiene que tener cómo MOSTRARSE, o es una ventana que no abre nunca.
    // Vale `.open` en el CSS o que alguien le toque style.display desde el JS.
    const abrePorClase = reglas.some(r => new RegExp('#' + id + '\\.open').test(r));
    const abrePorJs = new RegExp("getElementById\\('" + id + "'\\)\\.style\\.display\\s*=\\s*'flex'")
      .test(index)
      || new RegExp("getElementById\\('" + id + "'\\)\\.style\\.display\\s*=\\s*'block'").test(index);
    t.ok(abrePorClase || abrePorJs, `#${id} tiene cómo abrirse`);
  }

  // El caso concreto que motivó la suite, dicho por su nombre para que se lea
  // en la salida cuando alguien la rompa.
  t.ok(/#ped-prov-overlay\.open/.test(css),
    '#ped-prov-overlay —el que se rompió— tiene su regla');
}

module.exports = { nombre: 'Cada modal sabe esconderse', run };
