// ─── Utilidades compartidas de los informes ─────────────────────────────────
//
// Viven aparte del núcleo a propósito: informes.js carga a los analistas, y si
// los analistas le pidieran las utilidades de vuelta a informes.js se armaría
// un require circular — al cargar, informe-movimientos recibiría un módulo a
// medio construir y las funciones llegarían como undefined.

// Mediana y MAD en vez de promedio y desvío estándar: una sola noche récord o
// una sola compra grande arrastran el promedio, y después nada parece raro. La
// mediana no se mueve por un outlier, que es justo lo que hay que detectar.
function mediana(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(xs, med) {
  if (!xs.length) return 0;
  // 1.4826 lleva la MAD a la escala de un desvío estándar, para que el umbral
  // de "N desvíos" signifique lo mismo que significaría con uno normal.
  return 1.4826 * mediana(xs.map(x => Math.abs(x - med)));
}

// Escala contra la que se mide un desvío. Si la MAD da cero (la serie es
// siempre idéntica) cualquier cambio es señal, pero hace falta un mínimo para
// no marcar diferencias de un peso.
function escalaDe(xs, med) {
  const m = mad(xs, med);
  return m > 0 ? m : Math.abs(med) * 0.25;
}

const norm = s => (s || '').toString().trim().toLowerCase();
const diaISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mesISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const diasEntre = (a, b) => Math.round((b - a) / 86400000);
const redondear = n => Math.round(n || 0);

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Los nombres tal cual los escribe la columna Mes de la planilla. Se agrupa por
// esa columna y NO por la fecha: `Fecha` dice cuándo se movió la plata y `Mes`
// dice a qué mes pertenece el gasto, y en las compras en cuotas y en los pagos
// diferidos son distintos a propósito. Agrupar por fecha da otro resultado que
// el que muestra el Dashboard — en julio 2026, $9,6M contra los $12,8M reales.
const MESES_PLANILLA = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const mesPlanillaDe = d => MESES_PLANILLA[d.getMonth()];

// Los analistas semanales miran los últimos 7 días y se comparan contra las 8
// semanas previas. Un solo lugar para que los tres usen la misma ventana.
const DIAS_VENTANA = 7;
const SEMANAS_REFERENCIA = 8;

module.exports = {
  mediana, mad, escalaDe, norm, diaISO, mesISO, diasEntre, redondear,
  DIAS_SEMANA, MESES, MESES_PLANILLA, mesPlanillaDe, DIAS_VENTANA, SEMANAS_REFERENCIA,
};
