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
//
// ─── LA PLANILLA NO SE TOCA. Decidido el 18/8/2026 ──────────────────────────
//
// Es tentador "arreglar" esas filas de una pasada. NO se hace, y la decisión es
// del dueño: en su momento "Efectivo" era un valor válido, hoy ya no, y está
// bien que el libro conserve lo que efectivamente se escribió. Cuál de las tres
// cajas pagó cada una de esas filas es un dato que nadie tiene: escribirlo
// sería inventar precisión sobre gastos de 2026 ya cerrados.
//
// Consecuencia asumida: el `SUMIFS` de la hoja `Cajas` sigue sin contarlas,
// porque mira la celda y la celda no cambió. Es una diferencia CONOCIDA, no un
// error a investigar de nuevo.
//
// El audit trail —las 153 filas identificadas una por una, con fila, fecha,
// proveedor, monto y qué dice cada una— está en
// `PROYECTOS/Proyectos/Mercedes/06_entregables/medios-pago-legacy.csv`, y el
// razonamiento completo en `04_decisiones/2026-08-18-medios-de-pago-legacy.md`.
//
// ─── "Legacy" no es un valor roto ───────────────────────────────────────────
//
// Hay 29 filas que dicen `Legacy` y NO se traducen a ninguna caja. Son de marzo
// de 2026, anteriores a la apertura: fondo de comercio, escribanía, honorarios,
// adelanto del alquiler. Se pagaron antes de que las cajas existieran, así que
// `Legacy` significa algo — mapearlas a una caja sería peor que dejarlas. Se
// muestran tal cual y no se ofrecen para elegir.

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
