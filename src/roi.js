// ─── Recupero de Inversión (ROI) ────────────────────────────────────────────────
//
// El dueño invirtió USD 60.000 en el bar y quiere recuperarlos. Cada mes, al cerrar,
// se asigna parte del resultado a "recupero de inversión" (col L de Cierres) y parte
// a "fondo extraordinarias" (col M). Este módulo agrega ese histórico y lo compara
// contra la meta.
//
// - El recupero de cada mes se valúa en USD con el TC CONGELADO de ese cierre (col B),
//   igual que el resto de los USD del histórico, para que no se corra al cambiar el
//   dólar de hoy.
// - La brecha que falta se valúa en pesos de HOY con el dólar blue EN VIVO (tc.js),
//   porque el ARS/USD se mueve rápido y nunca asumimos un valor fijo.
// - Deadline duro: roiMesesLimite (24). Meta stretch: roiMesesTarget (18). El monto
//   sugerido para el próximo cierre apunta al ritmo del deadline de 24 meses.

const cierresMod = require('./cierres');
const plan = require('./plan');
const tc = require('./tc');
const { ORDEN_MESES } = require('./proyecciones');

const MES_IDX = {};
ORDEN_MESES.forEach((m, i) => { MES_IDX[m.toLowerCase()] = i; });

// "Junio 2026" -> "2026-06". El año es opcional en la clave del cierre (a veces se
// guarda solo "Junio"): si falta, se usa `fallbackYear` (típicamente el año de la
// fecha de cierre). Devuelve '' si no parsea.
function mesLabelToISO(label, fallbackYear) {
  const m = /^([A-Za-zñÑ]+)(?:\s+(\d{4}))?$/.exec((label || '').toString().trim());
  if (!m) return '';
  const idx = MES_IDX[m[1].toLowerCase()];
  if (idx == null) return '';
  const year = m[2] || (fallbackYear ? String(fallbackYear) : '');
  if (!/^\d{4}$/.test(year)) return '';
  return `${year}-${String(idx + 1).padStart(2, '0')}`;
}

// Año-mes actual en hora de Argentina, "YYYY-MM".
function nowARYearMonth() {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return s.slice(0, 7);
}

function mesesEntre(isoA, isoB) {
  if (!isoA || !isoB) return 0;
  const [ya, ma] = isoA.split('-').map(Number);
  const [yb, mb] = isoB.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

async function resumenRecupero() {
  const [cierres, planData, blue] = await Promise.all([
    cierresMod.listCierres(),
    plan.listPlan(),
    tc.getDolarBlue(),
  ]);
  const cfg = planData.config || {};
  const inversionUSD = Number(cfg.roiInversionUSD) || 60000;
  const mesesTarget = Number(cfg.roiMesesTarget) || 18;
  const mesesLimite = Number(cfg.roiMesesLimite) || 24;
  const tcVivo = Number(blue.tc) || 0;

  // Cierres con su ISO, ordenados cronológicamente (viejo → nuevo). Si la clave del
  // mes no trae año, se infiere del año de la fecha de cierre.
  const anioActual = nowARYearMonth().slice(0, 4);
  const conISO = cierres
    .map(c => {
      const anioCierre = /^\d{4}/.test(c.fechaCierre || '') ? c.fechaCierre.slice(0, 4) : anioActual;
      return { ...c, iso: mesLabelToISO(c.mes, anioCierre) };
    })
    .filter(c => c.iso)
    .sort((a, b) => a.iso.localeCompare(b.iso));

  // Mes de inicio del reloj: config, o el cierre más viejo.
  const mesInicio = cfg.roiMesInicio || (conISO.length ? conISO[0].iso : '');

  // Serie por mes con acumulado, brecha y sugerencia de recupero. La sugerencia de
  // cada mes es el MÍNIMO para completar la inversión en el plazo límite dado el
  // estado a esa altura (brecha ANTES de recuperar este mes ÷ meses que faltan del
  // plan), topeado al resultado positivo del mes. Usa el TC congelado del cierre.
  let acumuladoUSD = 0;
  const porMes = conISO.map(c => {
    const gapAntesUSD = Math.max(0, inversionUSD - acumuladoUSD);
    const elapsed = mesInicio ? Math.max(0, mesesEntre(mesInicio, c.iso)) : 0;
    const restantes = Math.max(1, mesesLimite - elapsed);
    const resUSD = c.tcUsd > 0 ? Math.round(Math.max(0, c.resultadoARS) / c.tcUsd) : 0;
    const sugUSD = Math.min(Math.max(0, Math.round(gapAntesUSD / restantes)), resUSD);
    const sugARS = c.tcUsd > 0 ? Math.round(sugUSD * c.tcUsd) : 0;
    acumuladoUSD += c.recuperoUSD;
    return {
      mes: c.mes,
      iso: c.iso,
      resultadoARS: c.resultadoARS,
      tcUsd: c.tcUsd,
      recuperoARS: c.recuperoARS,
      recuperoUSD: c.recuperoUSD,
      extraordinariaARS: c.extraordinariaARS,
      extraordinariaUSD: c.extraordinariaUSD,
      sugeridoRecuperoUSD: sugUSD,
      sugeridoRecuperoARS: sugARS,
      acumuladoUSD,
      gapUSD: Math.max(0, inversionUSD - acumuladoUSD),
    };
  });

  const recuperadoUSD = acumuladoUSD;
  const gapUSD = Math.max(0, inversionUSD - recuperadoUSD);
  const pctRecuperado = inversionUSD > 0 ? Math.min(100, (recuperadoUSD / inversionUSD) * 100) : 0;
  const gapARS = tcVivo > 0 ? Math.round(gapUSD * tcVivo) : 0;

  const fondoExtraordinariasUSD = porMes.reduce((s, m) => s + m.extraordinariaUSD, 0);
  const fondoExtraordinariasARS = tcVivo > 0 ? Math.round(fondoExtraordinariasUSD * tcVivo) : 0;

  // Reloj calendario: meses transcurridos desde el inicio hasta hoy.
  const hoy = nowARYearMonth();
  const mesesTranscurridos = mesInicio ? Math.max(0, mesesEntre(mesInicio, hoy)) : 0;

  // Sugerido para el mes en curso (aún sin cerrar): mínimo para completar la
  // inversión en el plazo límite, al dólar blue EN VIVO. Mismo criterio de ritmo
  // que porMes, pero a hoy: brecha actual ÷ meses que faltan del plan.
  const mesesRestantesLimite = Math.max(1, mesesLimite - mesesTranscurridos);
  const sugeridoUSD = Math.max(0, Math.round(gapUSD / mesesRestantesLimite));
  const sugeridoARS = tcVivo > 0 ? Math.round(sugeridoUSD * tcVivo) : 0;

  const mesesRestantes24 = Math.max(0, mesesLimite - mesesTranscurridos);
  const mesesRestantes18 = Math.max(0, mesesTarget - mesesTranscurridos);

  // On-track: ¿lo recuperado alcanza el ritmo lineal esperado a esta altura?
  const esperado24 = inversionUSD * Math.min(1, mesesTranscurridos / mesesLimite);
  const esperado18 = inversionUSD * Math.min(1, mesesTranscurridos / mesesTarget);

  return {
    inversionUSD,
    recuperadoUSD,
    gapUSD,
    gapARS,
    pctRecuperado,
    mesesTarget,
    mesesLimite,
    mesInicio,
    mesesTranscurridos,
    mesesRestantes18,
    mesesRestantes24,
    onTrack18: recuperadoUSD >= esperado18,
    onTrack24: recuperadoUSD >= esperado24,
    esperado18USD: Math.round(esperado18),
    esperado24USD: Math.round(esperado24),
    fondoExtraordinariasUSD,
    fondoExtraordinariasARS,
    sugerido: { usd: sugeridoUSD, ars: sugeridoARS, mesesRestantesLimite },
    blue,
    porMes,
  };
}

module.exports = { resumenRecupero, mesLabelToISO };
