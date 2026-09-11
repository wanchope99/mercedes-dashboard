// ─── Quién es el negocio que corre esta instancia ────────────────────────────
//
// Este repo nació para un solo bar y durante un año eso no costó nada: el nombre
// del bar, los nombres de las cajas y los seis logins vivían escritos en el
// código porque no había otro caso. El 09/09/2026 apareció el segundo —Pulpería
// Soler, en Palermo— y la decisión fue **un solo repositorio parametrizado**, no
// un fork: un fork diverge el día dos y cada arreglo hay que hacerlo dos veces.
//
// Este archivo es el único lugar que responde "¿de quién es esta instancia?".
// Todo lo que antes estaba repetido en seis módulos entra acá una vez.
//
// ─── LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO ────────────────────────────────
//
// **Cada default es el de Mercedes.** Una instancia sin ninguna de estas
// variables seteadas se comporta EXACTAMENTE como la app se comportaba antes de
// que este archivo existiera. Eso no es cortesía: Mercedes está en producción,
// con la caja abierta algunas noches, y la parametrización no puede pedir un
// cambio de variables en Railway para no romperse. Si algún día hay que mover un
// default, se mueve seteando la variable en la instancia nueva, nunca cambiando
// el valor que hay acá.
//
// Corolario para quien agregue algo: un default vacío o genérico ("Mi Negocio",
// lista de cajas vacía) parece más limpio y es la forma de romper Mercedes en
// silencio. El default correcto es el valor que el código tenía hardcodeado.

// ─── Identidad ──────────────────────────────────────────────────────────────

// `NEGOCIO_ID` no es cosmético: elige el archivo de contexto que se le inyecta a
// los agentes, los días excluidos de los informes, si se siembran los proveedores
// de arranque, y prefija el localStorage del navegador para que dos instancias
// abiertas en el mismo browser no se pisen la sesión.
const NEGOCIO_ID = (process.env.NEGOCIO_ID || 'mercedes').trim().toLowerCase();
const NEGOCIO_NOMBRE = (process.env.NEGOCIO_NOMBRE || 'Bar Mercedes').trim();
// La ciudad viaja al prompt de los tres agentes. No es decorado: cambia cómo lee
// el modelo un feriado, una alícuota de Ingresos Brutos o un día de lluvia.
const NEGOCIO_CIUDAD = (process.env.NEGOCIO_CIUDAD || 'Buenos Aires').trim();
const NEGOCIO_LOGO = (process.env.NEGOCIO_LOGO || '/logo.jpg').trim();

const esMercedes = () => NEGOCIO_ID === 'mercedes';

// Cómo se presenta el negocio en el system prompt de los tres agentes. Es una
// frase entera y no un nombre porque va detrás de "Sos el analista de datos ":
// "de Bar Mercedes" y "del bar Mercedes" no se escriben igual, y el default
// tiene que ser EXACTAMENTE lo que el prompt decía antes de existir esta
// variable — un prompt que cambia es un informe que cambia.
const NEGOCIO_DESCRIPCION = (process.env.NEGOCIO_DESCRIPCION || '').trim()
  || (esMercedes() ? 'del bar Mercedes (Buenos Aires)' : `de ${NEGOCIO_NOMBRE} (${NEGOCIO_CIUDAD})`);

// ─── Las cajas ──────────────────────────────────────────────────────────────
//
// Un medio de pago es el nombre EXACTO de una caja (ver la cabecera de
// medios-pago.js: la hoja `Cajas` hace un SUMIFS por texto contra la columna L
// de `Movimientos`, y una letra de diferencia vuelve esa plata invisible para
// siempre). Hasta hoy esta lista estaba escrita en `medios-pago.js` y COPIADA en
// `proveedores-categorias.js`, `finanzas.js` y `propinas.js` — cuatro listas que
// describían la misma realidad y podían discrepar. Ahora hay una.
//
// Lo correcto a largo plazo es leerlas de la hoja `Cajas`, que es lo que ya hace
// `POST /api/cambios` y lo que CLAUDE.md tiene escrito como regla ("las cajas
// válidas se leen de la hoja, nunca de una lista en código"). No se hizo todavía
// porque esta lista es sincrónica y la consumen los formularios al armarse; el
// paso está anotado, no olvidado.
const CAJAS_MERCEDES = [
  'Efectivo Local', 'Efectivo Pablo', 'Efectivo Tincho',
  'Mercado Pago Tincho', 'Mercado Pago Pablo',
  'Galicia', 'USD Pablo', 'USD Tincho', 'MP Pablo USD',
];

function _lista(valor) {
  return String(valor || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const _cajasEnv = _lista(process.env.CAJAS);
const CAJAS = _cajasEnv.length ? _cajasEnv : CAJAS_MERCEDES.slice();

// ─── Las dos cajas del arqueo ───────────────────────────────────────────────
//
// `CAJA_EFECTIVO` y `CAJA_MP` son las que se cuentan todas las noches, y el
// bucketing de la sesión abierta las matchea EXACTO — un match por substring
// sobre "mercado pago" se llevaría puesta la cuenta de Pablo, que no es del
// arqueo. Por eso se resuelven a un nombre y no a un patrón.
//
// La derivación desde `CAJAS` existe para que una instancia nueva no tenga que
// setear tres variables para decir lo mismo, pero **sólo se usa si CAJAS fue
// seteada**: con la lista de Mercedes los defaults literales son la respuesta
// correcta y no se calculan (Mercedes tiene tres cajas de efectivo y dos de
// Mercado Pago; adivinar cuál es la del arqueo sería exactamente el error).
function _derivar(prefijo, fallback) {
  if (!_cajasEnv.length) return fallback;
  const hit = CAJAS.find(c => c.toLowerCase().startsWith(prefijo));
  return hit || fallback;
}
const CAJA_EFECTIVO = (process.env.CAJA_EFECTIVO || '').trim()
  || _derivar('efectivo', 'Efectivo Local');
const CAJA_MP = (process.env.CAJA_MP || '').trim()
  || _derivar('mercado pago', 'Mercado Pago Tincho');

// Las cuentas por donde se pagan las propinas digitales. `Brubank` no es una
// caja —no existe en ningún otro lado de la app— y por eso esta lista es propia
// y no un filtro sobre CAJAS.
//
// Fuera de Mercedes el default es VACÍO y no estas dos: son los bancos por donde
// pasa la plata de otra gente, y ofrecerlos como destino en otro negocio es la
// clase de error que se descubre cuando una transferencia no llegó. Una lista
// vacía apaga el reparto y lo dice; una lista ajena lo hace mal en silencio.
const CUENTAS_PROPINAS = _lista(process.env.CUENTAS_PROPINAS).length
  ? _lista(process.env.CUENTAS_PROPINAS)
  : (esMercedes() ? ['Galicia', 'Brubank'] : []);

// El destino del capital de recupero. Es un solo lugar por decisión del 24/07/2026
// y sigue siéndolo; lo que cambia por instancia es el nombre de la cuenta.
const CAJA_POZO = (process.env.CAJA_POZO || '').trim() || 'Mercado Pago Pablo';
const CAJA_POZO_USD = (process.env.CAJA_POZO_USD || '').trim() || 'MP Pablo USD';

// ─── Las dos listas del circuito de facturas ────────────────────────────────
//
// Son distintas entre sí y ninguna es "todas las cajas".
//
// `MEDIOS_PAGO` es lo que el BOT le ofrece a una persona por Telegram y lo que va
// a la hoja `Compras`, que es analítica: por eso tolera 'Echeq' y 'Otro', que no
// son cajas. Es corta a propósito — son botones en un chat.
//
// `MEDIOS_LIBRO` es lo que se puede escribir en la columna L de `Movimientos`.
// Ahí sólo entran nombres literales de caja, porque el Saldo Calculado es un
// SUMIFS por texto exacto.
//
// Lo que las dos dejan afuera y es una DECISIÓN, no un olvido: la cuenta del
// recupero (`Mercado Pago Pablo` en Mercedes) y las cajas en dólares. De la
// primera no sale plata para pagar facturas —su movimiento se registra en
// Finanzas—, y elegirla es una decisión del dueño, no algo que infiera quien
// sacó la foto de la factura.
//
// Los defaults de Mercedes son LITERALES y no derivados. El orden de
// `MEDIOS_LIBRO` es por uso real en los gastos históricos (215/201/176/58/22) y
// una derivación lo reordenaría en silencio: la lista que ve el encargado todas
// las noches cambiaría de orden sin que nadie lo hubiera pedido. La derivación
// corre SÓLO cuando `CAJAS` fue seteada, o sea nunca en Mercedes.
const CAJAS_FUERA_DEL_LIBRO = _lista(process.env.CAJAS_FUERA_DEL_LIBRO).length
  ? _lista(process.env.CAJAS_FUERA_DEL_LIBRO)
  : [CAJA_POZO, CAJA_POZO_USD];

const _fueraDelLibro = new Set(CAJAS_FUERA_DEL_LIBRO.map(c => c.toLowerCase()));
// Las cajas en dólares tampoco: una factura de proveedor se paga en pesos.
const _esUSD = c => String(c).split(/[^A-Za-z]+/).some(t => t.toLowerCase() === "usd");

const MEDIOS_LIBRO = (() => {
  const env = _lista(process.env.MEDIOS_LIBRO);
  if (env.length) return env;
  if (!_cajasEnv.length) {
    return ['Mercado Pago Tincho', 'Galicia', 'Efectivo Local', 'Efectivo Pablo', 'Efectivo Tincho'];
  }
  return CAJAS.filter(c => !_fueraDelLibro.has(c.toLowerCase()) && !_esUSD(c));
})();

const MEDIOS_PAGO = (() => {
  const env = _lista(process.env.MEDIOS_PAGO);
  if (env.length) return env;
  if (!_cajasEnv.length) {
    return ['Efectivo Local', CAJA_MP, 'Galicia', 'Echeq', 'Otro'];
  }
  return [...MEDIOS_LIBRO, 'Echeq', 'Otro'];
})();

// ─── Módulos apagados ───────────────────────────────────────────────────────
//
// Tres de los módulos que un bar chico no usa YA se apagan solos no seteando su
// planilla: Nómina (`NOMINA_SHEET_ID`) y Cierre de cocina (`STOCKS_SHEET_ID`) se
// reportan no configurados y nada más se rompe. Esta lista es para los que no
// tienen esa puerta: Propinas, Arqueo y el grupo Plan entero.
//
// **Ocultar un módulo no oculta datos.** La planilla es compartida y cualquiera
// con el link ve todo; esto hace que la app no sea el camino fácil, no que sea un
// secreto. Es la misma frontera que ya está escrita para el cierre de cocina.
const MODULOS_OFF = new Set(_lista(process.env.MODULOS_OFF).map(s => s.toLowerCase()));
const moduloActivo = id => !MODULOS_OFF.has(String(id || '').toLowerCase());

// ─── Las cajas con las que se puede haber PAGADO una compra ─────────────────
//
// Es MEDIOS_LIBRO más la cuenta del recupero, y esa suma es una decisión con
// fecha: el 20/08/2026, porque `Mercado Pago Pablo` sigue siendo una cuenta de
// uso diario y de ahí se pagan gastos del bar, así que la compra tiene que
// poder cargarse así en vez de quedar como una fila a corregir en la planilla.
//
// **Desde el 10/09/2026 esta lista también son los botones del BOT de facturas**
// (pedido de Gonzalo: "incorporar Mercado Pago Pablo a los medios de pago
// disponibles"). Hasta ese día el bot ofrecía MEDIOS_LIBRO, que deja el pozo
// afuera, y una factura pagada por ahí no se podía cargar tal como pasó: había
// que elegir otra caja —plata que ese saldo nunca resta— o abandonar el bot y
// cargarla a mano. Es el mismo razonamiento del 20/08, aplicado al otro
// formulario que carga compras. Lo que NO cambió es MEDIOS_PAGO, la lista corta
// que va a la hoja Compras.
//
// El ORDEN sale de MEDIOS_LIBRO —que está por uso real— con el pozo al final, y
// NO de CAJAS: son botones en un chat y un desplegable que se miran todos los
// días, y derivar el orden de CAJAS los reordenaría en silencio. Una caja que no
// existe en esta instancia se cae sola: nombrarla escribiría en Movimientos un
// medio que ningún SUMIFS suma.
const MEDIOS_COMPRA = (() => {
  const env = _lista(process.env.MEDIOS_COMPRA);
  if (env.length) return env;
  const out = [];
  for (const pedida of [...MEDIOS_LIBRO, CAJA_POZO]) {
    const real = CAJAS.find(c => c.toLowerCase() === String(pedida).toLowerCase());
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
})();

// ─── Cajas que comparten prefijo y se pueden filtrar juntas ─────────────────
//
// El filtro de Pagos matchea por substring, así que el valor "Mercado Pago"
// alcanza a las dos cuentas de una. Es la opción "Mercado Pago (Tincho y Pablo)"
// que estaba escrita a mano en el HTML; acá se deriva, y para Mercedes sale con
// esa misma etiqueta, letra por letra.
//
// Sólo tiene sentido donde hay dos o más cuentas del mismo tipo. Un negocio con
// una sola cuenta de Mercado Pago no necesita agruparla consigo misma, y por eso
// un grupo con menos de dos integrantes no se emite.
const GRUPOS_CAJAS = (() => {
  const prefijos = _lista(process.env.CAJAS_GRUPOS).length
    ? _lista(process.env.CAJAS_GRUPOS)
    : (esMercedes() ? ['Mercado Pago'] : []);
  const out = [];
  for (const prefijo of prefijos) {
    const bajo = prefijo.toLowerCase();
    const miembros = CAJAS.filter(c => c.toLowerCase().startsWith(bajo));
    if (miembros.length < 2) continue;
    const colas = miembros.map(c => c.slice(prefijo.length).trim()).filter(Boolean);
    const etiqueta = colas.length
      ? `${prefijo} (${colas.slice(0, -1).join(', ')}${colas.length > 1 ? ' y ' : ''}${colas[colas.length - 1]})`
      : prefijo;
    out.push({ valor: prefijo, label: etiqueta, miembros });
  }
  return out;
})();

// ─── Lo que ve el navegador ─────────────────────────────────────────────────
//
// `public/index.html` no tiene build: los `<select>` de caja estaban escritos a
// mano, 151 literales repartidos por el archivo. Esto es lo que `GET /api/config`
// devuelve para que se armen solos. Va SIN secretos y sin nada que dependa del
// rol — quién ve qué lo sigue decidiendo el server en cada ruta.
function paraElNavegador() {
  return {
    id: NEGOCIO_ID,
    nombre: NEGOCIO_NOMBRE,
    logo: NEGOCIO_LOGO,
    cajas: CAJAS,
    cajaEfectivo: CAJA_EFECTIVO,
    cajaMP: CAJA_MP,
    cuentasPropinas: CUENTAS_PROPINAS,
    mediosLibro: MEDIOS_LIBRO,
    mediosCompra: MEDIOS_COMPRA,
    grupos: GRUPOS_CAJAS.map(({ valor, label }) => ({ valor, label })),
    modulosOff: [...MODULOS_OFF],
  };
}

module.exports = {
  NEGOCIO_ID, NEGOCIO_NOMBRE, NEGOCIO_CIUDAD, NEGOCIO_LOGO, NEGOCIO_DESCRIPCION, esMercedes,
  CAJAS, CAJA_EFECTIVO, CAJA_MP, CUENTAS_PROPINAS, CAJA_POZO, CAJA_POZO_USD,
  CAJAS_FUERA_DEL_LIBRO, MEDIOS_LIBRO, MEDIOS_PAGO, MEDIOS_COMPRA, GRUPOS_CAJAS,
  MODULOS_OFF, moduloActivo, paraElNavegador,
};
