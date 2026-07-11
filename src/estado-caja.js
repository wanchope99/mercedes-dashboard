// Persistencia de la caja abierta (Arqueo) entre reinicios del proceso.
//
// estadoCaja vive en memoria en server.js por simplicidad, pero eso significa que
// cada redeploy (o crash) pierde silenciosamente una sesión de caja ya abierta:
// el próximo GET /api/arqueo/estado muestra "cerrada" aunque el mozo nunca cerró,
// y esa noche queda sin arquear. Este módulo espeja ese mismo objeto en una hoja
// oculta ("Estado Caja") para poder restaurarlo al arrancar.
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Estado Caja';

function getAuth() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function ensureSheetExists(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (meta.data.sheets.some(s => s.properties.title === SHEET_NAME)) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME, hidden: true } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:B1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['No editar — estado técnico de la caja, se sobreescribe solo', 'estado_json']] },
  });
}

// Se llama una vez al arrancar el server. Devuelve el estadoCaja guardado si la
// caja había quedado abierta, o null si no hay nada que restaurar.
async function cargarEstadoCaja() {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureSheetExists(sheets);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!B2` });
    const raw = r.data.values?.[0]?.[0];
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('No se pudo leer el estado de caja persistido:', err.message);
    return null;
  }
}

// Se llama cada vez que estadoCaja cambia (abrir, gasto rápido con caja abierta,
// cerrar). No lanza si falla: perder este respaldo no debe romper el flujo real.
async function guardarEstadoCaja(estado) {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureSheetExists(sheets);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!B2`,
      valueInputOption: 'RAW',
      requestBody: { values: [[JSON.stringify(estado)]] },
    });
  } catch (err) {
    console.error('No se pudo persistir el estado de caja:', err.message);
  }
}

module.exports = { cargarEstadoCaja, guardarEstadoCaja };
