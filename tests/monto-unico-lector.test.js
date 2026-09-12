// Un solo lector de importes, y ningún módulo con el suyo.
//
// El 12/09/2026 Gonzalo mandó la captura del día de Pedidos: el pedido de Aurea
// decía **$40.200.007**. Los cuatro importes mal eran exactamente los que tenían
// centavos, y el de Thames —$80.000, redondo— se veía bien. Ésa es la firma.
//
// `src/pedidos.js` tenía su propio lector, `_numero`, que hacía dos cosas mal y
// juntas multiplicaban la plata por cien:
//
//   · pasaba TODO por String(), incluso lo que ya era un número;
//   · y después borraba todos los puntos, suponiendo que un punto siempre es
//     separador de miles.
//
// `crearPedido` recibe `centavos(leerMonto(...))`, o sea un número con centavos,
// así que el daño no era de pantalla: **se escribía ×100 en la hoja**. Un
// importe redondo pasaba intacto, y por eso el bug vivió un mes a la vista.
//
// Es la segunda vez que pasa lo mismo. El encabezado de `src/monto.js` cuenta
// que hubo cinco copias de esta función y que por eso existe una sola; ésta era
// la sexta, escrita después de aquella limpieza.
//
// Por eso esta suite no sólo prueba los números: **prohíbe la forma**.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// Los cuatro de la captura, con lo que se veía y lo que tendría que verse.
const LA_CAPTURA = [
  { real: 402000.07, roto: 40200007, quien: 'Aurea' },
  { real: 89574.76, roto: 8957476, quien: 'Mercado Libre' },
  { real: 78688.93, roto: 7868893, quien: 'Mercado Libre' },
  { real: 311108.23, roto: 31110823, quien: 'Barracas Logistica' },
];

function run(t) {
  const { parseMonto, montoEntrante, centavos } = require(path.join(RAIZ, 'src', 'monto.js'));

  // ─── 1. El lector bueno devuelve los números tal cual ─────────────────────
  //
  // Un número YA es un número: el bug empezaba por convertirlo a texto.
  for (const c of LA_CAPTURA) {
    t.eq(parseMonto(c.real), c.real, `${c.quien}: ${c.real} se lee como ${c.real}, no como ${c.roto}`);
    t.eq(montoEntrante(c.real), c.real, `${c.quien}: y se escribe igual`);
  }
  t.eq(parseMonto(80000), 80000, 'un importe redondo también pasa intacto (es el que se veía bien)');

  // ─── 2. Y lee bien las dos convenciones cuando viene como texto ───────────
  t.eq(parseMonto('402.000,07'), 402000.07, 'formato argentino: el punto es de miles y la coma decimal');
  t.eq(parseMonto('402,000.07'), 402000.07, 'formato inglés: al revés, y da lo mismo');
  t.eq(parseMonto('402000.07'), 402000.07, 'un float suelto es decimal, no miles');
  t.eq(parseMonto('402000,07'), 402000.07, 'con coma, igual');
  // La ambigüedad genuina se resuelve como miles a propósito: escribir
  // doscientos mil es rutina y escribir mil pesos con centavos no lo es.
  t.eq(parseMonto('200.000'), 200000, '"200.000" son doscientos mil');
  t.eq(parseMonto('1.700.000'), 1700000, 'y "1.700.000" un millón setecientos');
  t.eq(parseMonto('200.93'), 200.93, 'pero "200.93" son doscientos con noventa y tres');

  // ─── 3. Lo que rompía: la forma prohibida ─────────────────────────────────
  //
  // Se reproduce el lector viejo para que quede escrito QUÉ hacía, y para que
  // la afirmación no dependa de recordar el número.
  const lectorViejo = v => {
    const n = Number(String(v == null ? '' : v)
      .replace(/[^0-9.,-]/g, '').replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };
  for (const c of LA_CAPTURA) {
    t.eq(lectorViejo(c.real), c.roto, `el lector viejo convertía ${c.real} en ${c.roto}`);
  }
  t.eq(lectorViejo(80000), 80000, 'y dejaba intactos los redondos, que es por qué no se notó');

  // ─── 4. Ningún módulo puede tener el suyo ─────────────────────────────────
  //
  // Ésta es la afirmación que importa. El bug no fue no saber la regla: fue que
  // un archivo nuevo se escribió su propia versión, y nadie lo vio porque la
  // app seguía andando. Se prohíbe la FORMA, no el archivo.
  //
  // La firma es borrar todos los puntos de un importe. Es la única manera de
  // convertir un decimal en miles, y no tiene ningún uso legítimo sobre plata.
  const FIRMA = /replace\(\s*\/\\\.\/g\s*,\s*['"]['"]\s*\)/;
  const yo = path.resolve(__filename);   // esta suite la nombra como texto
  const archivos = [];
  for (const dir of ['src', 'scripts']) {
    for (const f of fs.readdirSync(path.join(RAIZ, dir))) {
      if (f.endsWith('.js')) archivos.push(path.join(RAIZ, dir, f));
    }
  }
  archivos.push(path.join(RAIZ, 'public', 'index.html'));

  const culpables = archivos
    .filter(f => path.resolve(f) !== yo)
    .filter(f => FIRMA.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(RAIZ, f));
  t.eq(culpables, [], 'ningún archivo borra los puntos de un importe por su cuenta');

  // ─── 5. Y pedidos.js en particular usa el compartido ──────────────────────
  const ped = fs.readFileSync(path.join(RAIZ, 'src', 'pedidos.js'), 'utf8');
  t.ok(/require\(['"]\.\/monto['"]\)/.test(ped), 'pedidos.js importa el lector compartido');
  t.ok(!/function _numero/.test(ped), 'y ya no define el suyo');
  // Lo que ENTRA para escribirse pasa por montoEntrante, que redondea a
  // centavos: sin eso, el SUMIFS de la hoja devuelve 1356999,9999999999981.
  t.ok(/costoEstimado: montoEntrante\(/.test(ped), 'el costo que entra se redondea a centavos');
  t.ok(/montoPagado: montoEntrante\(/.test(ped), 'el monto pagado también');

  // ─── 6. El navegador y el servidor leen IGUAL ─────────────────────────────
  //
  // Son dos copias del mismo texto, y tienen que serlo: el mismo importe tipeado
  // en la app y mandado al servidor no puede dar dos números distintos.
  const html = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
  const cuerpoNav = (html.match(/function parseMonto\(valor\)[\s\S]*?\n\}/) || [''])[0];
  const cuerpoSrv = (fs.readFileSync(path.join(RAIZ, 'src', 'monto.js'), 'utf8')
    .match(/function parseMonto\(valor\)[\s\S]*?\n\}/) || [''])[0];
  // Se comparan sin comentarios: el del servidor explica la regla y el del
  // navegador no, y eso está bien. Lo que no puede diferir es lo que hacen.
  const pelado = s => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  t.ok(cuerpoNav.length > 200, 'se encontró el parseMonto del navegador');
  t.eq(pelado(cuerpoNav), pelado(cuerpoSrv),
    'el parseMonto del navegador hace exactamente lo mismo que el del servidor');

  // ─── 7. centavos() sigue haciendo lo suyo ─────────────────────────────────
  t.eq(centavos(1356999.9999999999981), 1357000, 'el ruido de punto flotante del SUMIFS se recorta');
  t.eq(centavos(402000.074), 402000.07, 'y los centavos se respetan');
}

module.exports = { nombre: 'Importes: un solo lector para todo el sistema', run };
