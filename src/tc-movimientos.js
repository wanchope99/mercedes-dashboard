// ─── Completar el tipo de cambio de las filas de Movimientos (columna T) ───────
//
// DOS COLUMNAS, DOS SIGNIFICADOS. No mezclarlas:
//
//   Q "TC USD"        — a cuánto se hizo REALMENTE esa operación. Es un hecho de
//                       la transacción. Existe sólo en las filas con importe en
//                       dólares (35 de 1157) y se carga A MANO desde la app
//                       (PUT /api/movimientos/:fila/tc). Este módulo NO la toca
//                       nunca. La seña del servicio del 01/08/2026 se tomó a
//                       1.500 aunque el blue de ese día fuera otro: eso es Q.
//
//   T "Blue del día"  — la cotización de mercado del día de la fila. Es una
//                       referencia, no un hecho de la operación. Va en TODAS las
//                       filas y la completa el sistema. Sirve para valuar en
//                       dólares los movimientos en pesos.
//
// Al valuar, Q manda sobre T (ver sheets.js). Por eso este módulo puede rellenar
// T sin pisar ninguna decisión humana: si mañana alguien carga el TC real de una
// operación en Q, ese valor gana solo.
//
// Se escriben SÓLO celdas vacías de T. Nunca se sobrescribe una que ya tenga
// valor, ni siquiera si difiere del blue — puede haberla puesto una persona.
//
// POR QUÉ T Y NO R: R y S ya están ocupadas por un bloque de saldos de la propia
// planilla (R1 "Saldo ARS", S1 "Saldo USD"). Escribir ahí lo habría destruido.
// T es la primera columna realmente libre — verificado celda por celda el
// 12/08/2026. Antes de mover esta columna, volver a verificar.

const { google } = require('googleapis');
const { getBlueDeFecha } = require('./tc');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = 'Movimientos';
const COL_TC = 19;                // índice 0-based de la columna T
const HEADER_TC = 'Blue del dia';

function getAuth() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Misma lectura de fecha que sheets.js, y por la misma razón: el TEXTO MOSTRADO
// es la fuente correcta, no el serial. Ver el bloque de comentarios de sheets.js
// antes de tocar esto — leer el serial mueve 432 filas de mes.
function parseDate(val) {
  if (!val) return null;
  const parts = String(val).trim().split('/');
  if (parts.length !== 3) return null;
  let day, month, year;
  if (parts[0].length <= 2 && parseInt(parts[0]) <= 12 && parseInt(parts[1]) > 12) {
    month = parseInt(parts[0]); day = parseInt(parts[1]); year = parseInt(parts[2]);
  } else {
    day = parseInt(parts[0]); month = parseInt(parts[1]); year = parseInt(parts[2]);
  }
  if (year < 100) year += 2000;
  const d = new Date(year, month - 1, day);
  return isNaN(d.getTime()) ? null : d;
}

const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ─── El trabajo ────────────────────────────────────────────────────────────────
//
// dryRun: no escribe nada, sólo devuelve qué escribiría. Es el modo por defecto a
// propósito — esto toca 1100+ filas de la planilla de la que sale toda la plata
// del negocio, y mirar antes de escribir tiene que ser el camino fácil.
async function completarTC({ dryRun = true, limite = 0 } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA}!A:T`,
  });
  const rows = r.data.values || [];

  const headerIdx = rows.findIndex(x => x
    && String(x[0] || '').trim() === 'Fecha'
    && String(x[1] || '').trim() === 'Mes');
  if (headerIdx === -1) throw new Error('No se encontró el encabezado de Movimientos');

  const pendientes = [];
  const problemas = [];
  let yaTenian = 0, sinFecha = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (!row[0]) continue;                                  // fila vacía
    const actual = String(row[COL_TC] ?? '').trim();
    if (actual !== '') { yaTenian++; continue; }            // nunca se pisa

    const fecha = parseDate(row[0]);
    if (!fecha) {
      sinFecha++;
      problemas.push({ fila: i + 1, motivo: 'fecha ilegible', valor: String(row[0]) });
      continue;
    }
    pendientes.push({ fila: i + 1, fechaISO: isoLocal(fecha), textoFecha: String(row[0]) });
  }

  // Una sola descarga de la serie sirve para todas las fechas.
  const cotizadas = [];
  for (const p of pendientes) {
    const b = await getBlueDeFecha(p.fechaISO);
    if (!b) {
      problemas.push({ fila: p.fila, motivo: 'sin cotización para esa fecha', valor: p.fechaISO });
      continue;
    }
    cotizadas.push({ ...p, tc: b.tc, fechaCotizacion: b.fechaCotizacion, exacta: b.exacta });
  }

  const aEscribir = limite > 0 ? cotizadas.slice(0, limite) : cotizadas;

  const resumen = {
    dryRun,
    filasTotales: rows.length - headerIdx - 1,
    yaTenian,
    sinFecha,
    aEscribir: aEscribir.length,
    conCotizacionExacta: aEscribir.filter(x => x.exacta).length,
    conCotizacionPrevia: aEscribir.filter(x => !x.exacta).length,
    diasDistintos: new Set(aEscribir.map(x => x.fechaISO)).size,
    rangoTC: aEscribir.length
      ? { min: Math.min(...aEscribir.map(x => x.tc)), max: Math.max(...aEscribir.map(x => x.tc)) }
      : null,
    problemas,
    muestra: aEscribir.slice(0, 10),
  };

  if (dryRun || !aEscribir.length) return { ...resumen, escritas: 0 };

  // Forzar formato NÚMERO en toda la columna antes de escribir.
  //
  // No es cosmética. El 12/08/2026 una celda de T tenía formato de FECHA
  // heredado de antes: el 1420 que se guardó se MOSTRABA como "11/20/03" (el
  // serial 1420 es el 20-nov-1903), y quien leyera la planilla formateada leía
  // 11 en vez de 1420. Con TC=11 una compra de $198.000 valía US$18.000.
  // El valor guardado siempre estuvo bien; lo que engañaba era el formato.
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const hoja = (meta.data.sheets || []).find(s => s.properties.title === HOJA);
    if (hoja) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            repeatCell: {
              range: { sheetId: hoja.properties.sheetId, startColumnIndex: COL_TC, endColumnIndex: COL_TC + 1 },
              cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0' } } },
              fields: 'userEnteredFormat.numberFormat',
            },
          }],
        },
      });
    }
  } catch (e) {
    // Si no se pudo, se escribe igual: el VALOR va a quedar bien. Quien lee por
    // API ahora lee esta columna cruda, así que el formato ya no puede mentirle.
    console.warn('TC Movimientos: no se pudo forzar el formato numérico de la columna:', e.message);
  }

  // Encabezado de T, si falta. Se escribe primero: una columna con datos y sin
  // título es exactamente lo que hace que alguien la borre por no saber qué es.
  const headerActual = String((rows[headerIdx] || [])[COL_TC] ?? '').trim();
  const data = [];
  if (!headerActual) {
    data.push({ range: `${HOJA}!T${headerIdx + 1}`, values: [[HEADER_TC]] });
  }
  for (const c of aEscribir) {
    data.push({ range: `${HOJA}!T${c.fila}`, values: [[c.tc]] });
  }

  // batchUpdate en tandas: un solo request con 1100 rangos es frágil y difícil de
  // retomar si falla a la mitad. De a 200, un fallo deja las tandas anteriores
  // escritas y el reintento las saltea solas (ya no están vacías).
  let escritas = 0;
  for (let i = 0; i < data.length; i += 200) {
    const tanda = data.slice(i, i + 200);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: tanda },
    });
    escritas += tanda.length;
  }
  if (!headerActual) escritas--;   // el encabezado no es una fila de datos

  return { ...resumen, escritas };
}

module.exports = { completarTC, HEADER_TC };
