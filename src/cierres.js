// ─── Cierres mensuales (ARS + USD) ──────────────────────────────────────────────
//
// Cuando un mes termina, se "cierra": se congelan sus totales en ARS y se expresan
// también en USD usando un tipo de cambio FIJO de ese período (lo carga el usuario,
// con un default ajustable). Así el histórico muestra cómo cerró cada mes tanto en
// pesos como en dólares de ese entonces, sin que cambie aunque después se editen
// datos viejos.
//
// Persistencia: hoja "Cierres" del spreadsheet de GESTIÓN (SPREADSHEET_ID).
// Columnas:
//   A Mes              (ej. "Junio 2026" — la clave del resumen mensual)
//   B TC USD           (pesos por dólar usado para este cierre)
//   C Ingresos ARS
//   D Gastos ARS
//   E Resultado ARS
//   F Ingresos USD
//   G Gastos USD
//   H Resultado USD
//   I Estado           ("cerrado" | "pendiente_tc")
//   J Fecha de cierre  (ISO)
//   K Nota             (opcional)
//   L Recupero ARS     (parte del resultado asignada a recuperar la inversión USD)
//   M Extraordinaria ARS (parte apartada para financiar otras extraordinarias)
//
// Los USD de L/M NO se guardan: se derivan del TC de la columna B (mismo criterio
// que Ingresos/Gastos/Resultado USD), para que el histórico no se corra si después
// se ajusta el TC. Ver roi.js para la agregación de recupero.

const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CIERRES_SHEET = process.env.CIERRES_SHEET || 'Cierres';

// TC por defecto cuando se cierra sin que el usuario haya cargado uno todavía.
// Se puede sobrescribir por env y SIEMPRE es ajustable desde la UI después.
const TC_DEFAULT = Number(process.env.TC_USD_DEFAULT) || 1425;

const HEADER = ['Mes', 'TC USD', 'Ingresos ARS', 'Gastos ARS', 'Resultado ARS',
  'Ingresos USD', 'Gastos USD', 'Resultado USD', 'Estado', 'Fecha cierre', 'Nota',
  'Recupero ARS', 'Extraordinaria ARS'];

function _sheetsClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

function _norm(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function _num(val) {
  if (val == null || val === '') return 0;
  return parseFloat(String(val).replace(/[$\s]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0;
}

async function _ensureSheet(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: CIERRES_SHEET } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${CIERRES_SHEET}!A1:M1`, valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

function _rowToCierre(r, i) {
  const tcUsd = _num(r[1]);
  const recuperoARS = _num(r[11]);
  const extraordinariaARS = _num(r[12]);
  return {
    mes: (r[0] || '').toString().trim(),
    tcUsd,
    ingresosARS: _num(r[2]),
    gastosARS: _num(r[3]),
    resultadoARS: _num(r[4]),
    ingresosUSD: _num(r[5]),
    gastosUSD: _num(r[6]),
    resultadoUSD: _num(r[7]),
    estado: (r[8] || 'cerrado').toString().trim() || 'cerrado',
    fechaCierre: (r[9] || '').toString().trim(),
    nota: (r[10] || '').toString().trim(),
    recuperoARS,
    extraordinariaARS,
    // USD derivados del TC de este cierre (no se guardan).
    recuperoUSD: tcUsd > 0 ? Math.round(recuperoARS / tcUsd) : 0,
    extraordinariaUSD: tcUsd > 0 ? Math.round(extraordinariaARS / tcUsd) : 0,
    rowIndex: i + 1,
  };
}

// Lista todo el histórico de cierres (más recientes primero por fecha de cierre).
async function listCierres() {
  if (!SPREADSHEET_ID) return [];
  const api = _sheetsClient();
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CIERRES_SHEET}!A:M` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureSheet(api);
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    out.push(_rowToCierre(r, i));
  }
  out.sort((a, b) => (b.fechaCierre || '').localeCompare(a.fechaCierre || ''));
  return out;
}

async function getCierre(mes) {
  const todos = await listCierres();
  return todos.find(c => _norm(c.mes) === _norm(mes)) || null;
}

// Cierra (o re-cierra) un mes. Recibe los totales en ARS (calculados por el caller
// a partir del resumen mensual) y un TC. Calcula los USD y hace upsert por mes.
//   { mes, tcUsd, ingresosARS, gastosARS, resultadoARS, estado, nota,
//     recuperoARS, extraordinariaARS }
// Si tcUsd no viene, usa TC_DEFAULT y marca estado 'pendiente_tc'.
async function cerrarMes({ mes, tcUsd, ingresosARS, gastosARS, resultadoARS, estado, nota,
  recuperoARS, extraordinariaARS } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  if (!mes) throw new Error('Falta el mes a cerrar');
  const api = _sheetsClient();
  await _ensureSheet(api);

  const tcProvisto = Number(tcUsd) > 0;
  const tc = tcProvisto ? Number(tcUsd) : TC_DEFAULT;
  const ing = Number(ingresosARS) || 0;
  const gas = Number(gastosARS) || 0;
  const res = (resultadoARS != null) ? Number(resultadoARS) : (ing - gas);
  const estadoFinal = estado || (tcProvisto ? 'cerrado' : 'pendiente_tc');
  const recup = Math.max(0, Math.round(Number(recuperoARS) || 0));
  const extra = Math.max(0, Math.round(Number(extraordinariaARS) || 0));

  const fila = [
    mes,
    tc,
    Math.round(ing),
    Math.round(gas),
    Math.round(res),
    Math.round(ing / tc),
    Math.round(gas / tc),
    Math.round(res / tc),
    estadoFinal,
    new Date().toISOString(),
    nota || '',
    recup,
    extra,
  ];

  // Upsert por nombre de mes
  let rows = [];
  try {
    const r = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CIERRES_SHEET}!A:M` });
    rows = r.data.values || [];
  } catch (e) { rows = []; }

  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && _norm(rows[i][0]) === _norm(mes)) { rowIndex = i + 1; break; }
  }

  if (rowIndex > 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${CIERRES_SHEET}!A${rowIndex}:M${rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${CIERRES_SHEET}!A:M`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  }

  return _rowToCierre(fila, rowIndex > 0 ? rowIndex - 1 : rows.length);
}

// Solo actualiza el TC de un mes ya cerrado y recalcula los USD (ajuste posterior).
async function ajustarTC({ mes, tcUsd } = {}) {
  const c = await getCierre(mes);
  if (!c) throw new Error('No existe un cierre para ' + mes);
  if (!(Number(tcUsd) > 0)) throw new Error('TC inválido');
  return cerrarMes({
    mes: c.mes, tcUsd, ingresosARS: c.ingresosARS, gastosARS: c.gastosARS,
    resultadoARS: c.resultadoARS, estado: 'cerrado', nota: c.nota,
    recuperoARS: c.recuperoARS, extraordinariaARS: c.extraordinariaARS,
  });
}

// Ajusta SOLO la asignación de recupero/extraordinaria de un mes ya cerrado
// (para asignar retroactivamente cierres viejos o editar el reparto), sin tocar
// los demás totales ni el TC. Re-cierra con los mismos ARS y TC guardados.
async function ajustarRecupero({ mes, recuperoARS, extraordinariaARS } = {}) {
  const c = await getCierre(mes);
  if (!c) throw new Error('No existe un cierre para ' + mes);
  return cerrarMes({
    mes: c.mes, tcUsd: c.tcUsd, ingresosARS: c.ingresosARS, gastosARS: c.gastosARS,
    resultadoARS: c.resultadoARS, estado: c.estado || 'cerrado', nota: c.nota,
    recuperoARS: recuperoARS != null ? recuperoARS : c.recuperoARS,
    extraordinariaARS: extraordinariaARS != null ? extraordinariaARS : c.extraordinariaARS,
  });
}

module.exports = { listCierres, getCierre, cerrarMes, ajustarTC, ajustarRecupero, TC_DEFAULT, CIERRES_SHEET };
