// ─── Los medios de pago, que son los nombres de las cajas ───────────────────
//
// Un medio de pago en este sistema NO es una etiqueta: es el nombre EXACTO de
// una caja. La hoja `Cajas` calcula cada saldo con un SUMIFS por texto contra la
// columna L de `Movimientos`, así que una diferencia de una letra vuelve esa
// plata invisible para el saldo, para siempre y sin ningún error a la vista.
//
// Vivía adentro de server.js. Salió acá el 18/8/2026 cuando hubo que usar la
// misma normalización del lado de la LECTURA: hasta entonces sólo se aplicaba al
// escribir, así que la app seguía mostrando "Efectivo" en filas viejas aunque
// nunca volviera a escribirlo.
//
// ─── "Efectivo" a secas es legacy y no se ofrece más ────────────────────────
//
// Hay tres cajas de efectivo y son DISTINTAS: `Efectivo Local` es el cajón del
// bar (el que se arquea todas las noches), `Efectivo Pablo` y `Efectivo Tincho`
// son las de cada socio. Un "Efectivo" pelado no dice de cuál salió la plata.
//
// Quedan 124 filas históricas con ese valor (medido el 18/8/2026; son las mismas
// que CLAUDE.md documenta como invisibles para el saldo). Se MUESTRAN como
// `Efectivo Local` porque es lo que el normalizador de escritura ya asumía desde
// siempre y porque son gastos operativos del bar — pero es un supuesto, no un
// dato: si alguna de esas filas era plata de Pablo o de Tincho, hay que
// corregirla en la planilla. La app no la reescribe sola.
//
// `medioPagoOriginal` conserva lo que decía la celda, para que ese supuesto se
// pueda auditar y deshacer.

const CAJA_EFECTIVO = process.env.CAJA_EFECTIVO || 'Efectivo Local';
const CAJA_MP = process.env.CAJA_MP || 'Mercado Pago Tincho';

// Los nombres van EXACTAMENTE como figuran en la columna A de la hoja Cajas.
// `MP Pablo USD` se llama así y no "MP USD Pablo".
const MEDIOS_CANONICOS = [
  'Efectivo Local', 'Efectivo Pablo', 'Efectivo Tincho',
  'Mercado Pago Tincho', 'Mercado Pago Pablo',
  'Galicia', 'USD Pablo', 'USD Tincho', 'MP Pablo USD',
];

// Las tres cajas de efectivo, que son lo que la app ofrece elegir.
const CAJAS_EFECTIVO = MEDIOS_CANONICOS.filter(m => m.startsWith('Efectivo'));

function normalizarMedio(medio) {
  const m = (medio || '').toString().trim();
  if (!m) return '';                       // vacío es válido: fila madre de cuotas
  const low = m.toLowerCase();
  // Un Echeq sale de la cuenta Galicia: en Movimientos se registra como Galicia.
  if (low === 'echeq' || low.includes('cheque')) return 'Galicia';
  const canonico = MEDIOS_CANONICOS.find(c => c.toLowerCase() === low);
  if (canonico) return canonico;           // corrige capitalización
  if (low === 'efectivo' || low === 'cash' || low.startsWith('contado')) return CAJA_EFECTIVO;
  if (low === 'mp' || low === 'mercado pago') return CAJA_MP;
  return m;                                // desconocido: se deja tal cual
}

// ¿Este valor es de los que la app ya no ofrece y muestra traducido? Sirve para
// avisar en pantalla en vez de fingir que la fila siempre dijo eso.
const esLegacy = medio => {
  const low = (medio || '').toString().trim().toLowerCase();
  if (!low) return false;
  return !MEDIOS_CANONICOS.some(c => c.toLowerCase() === low);
};

module.exports = {
  MEDIOS_CANONICOS, CAJAS_EFECTIVO, CAJA_EFECTIVO, CAJA_MP,
  normalizarMedio, esLegacy,
};
