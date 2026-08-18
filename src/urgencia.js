// ─── Cuán urgente es un vencimiento ─────────────────────────────────────────
//
// Vivía adentro de server.js, sin exportar. Salió acá cuando las notificaciones
// necesitaron la misma clasificación: dos lugares diciendo "vence hoy" con dos
// criterios distintos es como la campanita y la sección Pagos terminan
// contradiciéndose. Este repo ya tiene el caso testigo de una función duplicada
// (`parseDate`), y no conviene sumar otro.
//
// El vencimiento llega como texto D/M/AAAA desde la planilla — igual que el
// resto de las fechas del libro, se lee el texto mostrado y no el serial.

function calcUrgencia(vencimiento) {
  if (!vencimiento) return { urgencia: 'sin-fecha', diasHastaVenc: null, vencDate: null };
  const parts = vencimiento.trim().split('/');
  if (parts.length !== 3) return { urgencia: 'sin-fecha', diasHastaVenc: null, vencDate: null };
  let [d, m, y] = parts.map(Number);
  if (y < 100) y += 2000;
  const vencDate = new Date(y, m - 1, d);
  if (isNaN(vencDate.getTime())) return { urgencia: 'sin-fecha', diasHastaVenc: null, vencDate: null };
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dias = Math.ceil((vencDate - hoy) / (1000 * 60 * 60 * 24));
  const urgencia = dias < 0 ? 'vencido' : dias === 0 ? 'hoy' : dias <= 3 ? 'urgente' : dias <= 10 ? 'proximo' : 'ok';
  const vencISO = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { urgencia, diasHastaVenc: dias, vencDate: vencISO };
}

module.exports = { calcUrgencia };
