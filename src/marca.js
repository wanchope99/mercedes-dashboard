// ─── Los colores del negocio ─────────────────────────────────────────────────
//
// Hasta el 12/09/2026 la app tenía UN color de marca, el bordó de Mercedes,
// escrito como `--accent: #50251f` en el `:root` de `index.html`. Apareció el
// tercer cliente —DOC Café, en Villa Crespo— y la marca dejó de poder estar en
// el CSS: un café que abre su app y la ve en el bordó de un bar de Palermo no
// está viendo su app.
//
// ─── POR QUÉ ESTO ES UN MÓDULO Y NO DOS VARIABLES MÁS ───────────────────────
//
// Un color de marca solo no alcanza para pintar nada. Hacen falta cuatro cosas
// y tres se DERIVAN de la primera:
//
//   --accent        el color, tal cual lo eligió el dueño
//   --accent-hover  el mismo, un poco más claro, para el hover de un botón
//   --accent-soft   el mismo al 18%, para el fondo de algo seleccionado
//   --on-accent     LA TINTA QUE VA ENCIMA, y ésta es la que importa
//
// La tinta no se elige: se calcula. En `index.html` estaba escrita a mano como
// `#f0e6d3` —una crema— en ocho lugares, elegida contra un bordó muy oscuro. Es
// legible ahí y es ilegible sobre cualquier color claro. Que el dueño elija su
// color y ADEMÁS acierte la tinta que se lee encima no es una decisión que se
// pueda delegar: se resuelve con la luminancia relativa de la WCAG, que es
// exactamente la cuenta que dice si dos colores se distinguen.
//
// Hay un comentario en index.html que lo dice desde antes que esto existiera:
// "Naranja y no var(--accent): el accent es un marrón muy oscuro, ilegible como
// fondo de un botón". Esa clase de decisión, hecha a mano, es la que deja de
// escalar en cuanto el color deja de ser uno.
//
// ─── LA REGLA, QUE ES LA MISMA DE config-negocio.js ─────────────────────────
//
// **Cada default es el de Mercedes**, y acá se cumple de la forma más fuerte
// posible: sin `NEGOCIO_COLOR` seteada NO SE CALCULA NADA. `PALETA_MERCEDES`
// son los seis valores literales que hoy están en el CSS y se devuelven tal
// cual. Es el mismo criterio que `_derivar()` en config-negocio, que sólo
// deriva `CAJA_EFECTIVO` si `CAJAS` fue seteada: una derivación que corre
// siempre es una forma de cambiarle la cara a la instancia que ya está en
// producción sin que nadie lo haya pedido.

// Los seis valores que hoy están escritos en public/index.html. Si alguno de
// estos cambia, cambia Mercedes: son literales y no el resultado de una cuenta
// a propósito.
const PALETA_MERCEDES = {
  accent: '#50251f',                    // :root --accent
  accentHover: '#6b3530',               // .btn-accent:hover, .login-btn:hover
  accentSoft: 'rgba(80, 37, 31, 0.18)', // .cc-item.tocado
  onAccent: '#f0e6d3',                  // los ocho botones y chips activos
  accent2: '#e08a5c',                   // :root --orange, que es lo que usa .btn-acento
  onAccent2: '#17171f',                 // .btn-acento
};

// Las dos tintas que la app ya tenía escritas, y no dos genéricas. La clara es
// la crema de los ocho chips; la oscura es la de `.btn-acento`. Elegir #fff y
// #000 habría sido más limpio y habría cambiado el aspecto de Mercedes.
const TINTA_CLARA = '#f0e6d3';
const TINTA_OSCURA = '#17171f';

// Un hex de tres o seis dígitos, con o sin numeral, a sus tres canales. Devuelve
// null ante cualquier otra cosa: un color que no se entiende cae al default y no
// rompe la pantalla, que es el mismo criterio que el medio de pago de la
// recepción (la mercadería está en la puerta, una pestaña vieja no puede trabar
// nada).
function canales(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$/.test(s) && !/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const largo = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  return [
    parseInt(largo.slice(0, 2), 16),
    parseInt(largo.slice(2, 4), 16),
    parseInt(largo.slice(4, 6), 16),
  ];
}

function aHex([r, g, b]) {
  const dos = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + dos(r) + dos(g) + dos(b);
}

// Luminancia relativa de la WCAG 2.1. No es el promedio de los canales: el ojo
// ve el verde mucho más que el azul, y por eso un amarillo y un azul del mismo
// "brillo" aritmético piden tintas opuestas.
function luminancia(hex) {
  const rgb = canales(hex);
  if (!rgb) return null;
  const lineal = rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lineal[0] + 0.7152 * lineal[1] + 0.0722 * lineal[2];
}

// El contraste entre dos colores, 1 (idénticos) a 21 (blanco contra negro). La
// WCAG pide 4.5 para texto normal. Se exporta porque es lo que hace que las
// pruebas puedan AFIRMAR que un color cualquiera queda legible, en vez de
// confiar en que la función eligió bien.
function contraste(a, b) {
  const la = luminancia(a), lb = luminancia(b);
  if (la === null || lb === null) return null;
  const [alto, bajo] = la > lb ? [la, lb] : [lb, la];
  return (alto + 0.05) / (bajo + 0.05);
}

// El mínimo de la WCAG para texto normal. Estos seis colores son fondos de
// botón con una palabra encima, así que es el umbral que corresponde.
const CONTRASTE_MINIMO = 4.5;

// La tinta que se lee encima. Se prueban las dos que la app ya usa y gana la de
// mayor contraste — no un umbral de luminancia fijo, porque un umbral tiene un
// punto donde las dos opciones son malas y elige igual.
//
// **Y si ninguna de las dos llega al mínimo, se sale de la paleta de la app.**
// Eso no es una hipótesis: un verde medio como #1b7f5a —un color de marca
// perfectamente normal— da 4,01 contra la crema y menos todavía contra la tinta
// oscura, porque las dos están pensadas contra un bordó muy oscuro. El blanco
// puro lo lleva a 4,95. Se prefieren las tintas de la casa porque son las que
// hacen que la app se vea como una sola cosa, pero un botón ilegible no es una
// preferencia estética que se pueda sostener.
function tintaSobre(fondo) {
  const mejor = candidatas => candidatas
    .map(t => ({ t, c: contraste(fondo, t) }))
    .filter(x => x.c !== null)
    .sort((a, b) => b.c - a.c)[0];

  const deLaCasa = mejor([TINTA_CLARA, TINTA_OSCURA]);
  if (!deLaCasa) return TINTA_CLARA;
  if (deLaCasa.c >= CONTRASTE_MINIMO) return deLaCasa.t;

  const extrema = mejor(['#ffffff', '#000000']);
  return extrema && extrema.c > deLaCasa.c ? extrema.t : deLaCasa.t;
}

// El hover. Un color oscuro se aclara y uno claro se oscurece: sobre un fondo
// negro —que es el de esta app— aclarar un amarillo lo empasta con el texto.
// Es una mezcla contra blanco o negro y no una vuelta por HSL porque lo que se
// quiere es "el mismo color, un poco más presente", y girar el tono lo cambia.
function hoverDe(hex) {
  const rgb = canales(hex);
  if (!rgb) return null;
  const esOscuro = luminancia(hex) < 0.18;
  const f = 0.14;
  return aHex(rgb.map(c => (esOscuro ? c + (255 - c) * f : c * (1 - f))));
}

function softDe(hex, alfa = 0.18) {
  const rgb = canales(hex);
  if (!rgb) return null;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alfa})`;
}

// ─── La paleta entera ───────────────────────────────────────────────────────
//
// `primario` y `secundario` son lo único que se le pide al dueño, y lo normal es
// que salgan de su logo. Sin primario no se calcula nada y vuelve Mercedes; con
// primario y sin secundario, el secundario sigue siendo el naranja de siempre:
// es el color del botón de acción, y un negocio que no dio un segundo color
// tiene que tener un botón igual.
function paleta(primario, secundario) {
  const p = canales(primario) ? aHex(canales(primario)) : null;
  if (!p) return { ...PALETA_MERCEDES };

  const s = canales(secundario) ? aHex(canales(secundario)) : PALETA_MERCEDES.accent2;
  return {
    accent: p,
    accentHover: hoverDe(p),
    accentSoft: softDe(p),
    onAccent: tintaSobre(p),
    accent2: s,
    onAccent2: tintaSobre(s),
  };
}

// El bloque que se le inyecta al HTML. Va como `<style>` en el `<head>` y no por
// `GET /api/config` a propósito: la config se busca con `fetch`, y la pantalla de
// login es lo PRIMERO que se pinta. Por ahí, el dueño de DOC vería el bordó de
// Mercedes medio segundo cada vez que entra a su app.
function bloqueCss(p) {
  return ':root{'
    + `--accent:${p.accent};`
    + `--accent-hover:${p.accentHover};`
    + `--accent-soft:${p.accentSoft};`
    + `--on-accent:${p.onAccent};`
    + `--accent2:${p.accent2};`
    + `--on-accent2:${p.onAccent2};`
    + '}';
}

module.exports = {
  CONTRASTE_MINIMO,
  PALETA_MERCEDES, TINTA_CLARA, TINTA_OSCURA,
  canales, luminancia, contraste, tintaSobre, hoverDe, softDe,
  paleta, bloqueCss,
};
