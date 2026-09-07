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

  // ── Y que la grilla de los formularios no desborde el modal ───────────────
  //
  // `1fr` es `minmax(auto, 1fr)`: la columna nunca baja del min-content de lo
  // que tiene adentro. Un `<input>` sin ancho declarado trae ~198px de
  // min-content —el ancho por defecto de un campo de texto—, así que dos
  // columnas pedían 412px de mínimo contra los 399px que tiene el modal por
  // dentro. La grilla se desbordaba y aparecía una barra horizontal con media
  // columna cortada afuera de la pantalla.
  //
  // Lo encontró Gonzalo el 07/09/2026 abriendo "Datos de la factura", donde la
  // segunda columna es una fila flex (punto de venta + número) cuyo min-content
  // daba 298px y sola ya no entraba. Es la misma familia que el bug de
  // Servicios de septiembre: una grilla de ancho fijo adentro de algo que
  // recorta se rompe sin avisar.
  t.ok(/\.form-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css),
    '.form-grid usa minmax(0, 1fr): las columnas pueden achicarse abajo del contenido');
  t.ok(/\.form-group \{[^}]*min-width: 0/.test(css),
    '.form-group no impone su min-content como ancho mínimo de la columna');
  t.ok(/\.form-group input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/.test(css),
    'los campos ocupan su celda…');
  t.ok(/\.form-group input:not\(\[type="checkbox"\]\)[\s\S]{0,160}width: 100%; min-width: 0/.test(css),
    '…con width:100% y min-width:0, que es lo que los saca de la ecuación del ancho');

  // Los checkboxes quedan AFUERA de ese width, y tiene que seguir así: no son
  // campos que llenen un renglón sino un cuadradito al lado de su texto.
  // Estirarlos al 100% le come el ancho a la etiqueta y la parte en dos líneas
  // — pasó en el primer intento del arreglo.
  t.ok(!/\.form-group input \{[^}]*width: 100%/.test(css),
    'no hay un width:100% suelto para TODOS los input del formulario');

  // ── Los dos que NO se cierran sin querer ─────────────────────────────────
  //
  // Adentro de los dos hay algo tipeado que no se reconstruye solo, así que un
  // clic al costado o un Escape lo borran entero. El de la compra son sus
  // dieciocho campos; el de recibir se usa CON EL PROVEEDOR EN LA PUERTA, que
  // es el peor momento para volver a empezar — y además queda el modal del día
  // abierto detrás, así que cerrarlo parece que no hizo nada. De los dos se
  // sale por Cancelar.
  t.ok(/const ESC_NO_CIERRA = new Set\(\['modal-overlay', 'ped-recibir-overlay'\]\)/.test(index),
    'Escape no cierra ni Nueva compra ni Recibir');

  // Y que no vuelva el listener de clic al fondo sobre el de recibir, que es
  // por donde entraba el accidente.
  t.ok(!/\['ped-recibir-overlay', closePedRecibir\]/.test(index),
    'el modal de recibir no cierra tocando afuera');
  t.ok(/\['ped-sem-overlay', closePedSem\]/.test(index),
    'el del cuadro semanal sí sigue cerrando: se edita sentado y sin nadie esperando');
}

module.exports = { nombre: 'Los modales: esconderse y no desbordar', run };
