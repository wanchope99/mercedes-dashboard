// ─── Reglas de consumo de INSUMOS ───────────────────────────────────────────────
//
// Los insumos (bobinas, papeles, químicos, pilas, etc.) NO se venden en FUDO, así
// que solo tenemos su INGRESO (compras) pero no su EGRESO/consumo. Acá el usuario
// define una "regla de consumo" por producto: cuánto se consume por día o por semana.
// Con eso + el stock comprado, estimamos los días de cobertura y cuándo recomprar.
//
// Persistencia: hoja "Consumo Insumos" del spreadsheet de GESTIÓN (SPREADSHEET_ID).
// Columnas: A Producto · B Cantidad · C Periodo (dia|semana) · D Actualizado

const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CONSUMO_SHEET = process.env.CONSUMO_INSUMOS_SHEET || 'Consumo Insumos';

function _sheetsClient() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

function norm(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

async function _ensureSheet(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: CONSUMO_SHEET } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${CONSUMO_SHEET}!A1:D1`, valueInputOption: 'RAW',
      requestBody: { values: [['Producto', 'Cantidad', 'Periodo', 'Actualizado']] },
    });
  } catch (e) { if (!String(e.message || '').toLowerCase().includes('already exists')) throw e; }
}

// Devuelve todas las reglas: [{ producto, cantidad, periodo, porDia, rowIndex }]
async function listConsumo() {
  if (!SPREADSHEET_ID) return [];
  const api = _sheetsClient();
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CONSUMO_SHEET}!A:D` });
    rows = res.data.values || [];
  } catch (e) { await _ensureSheet(api); return []; }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const producto = (r[0] || '').toString().trim();
    const cantidad = parseFloat(String(r[1] || '').replace(',', '.')) || 0;
    const periodo = (r[2] || 'semana').toString().trim().toLowerCase().startsWith('d') ? 'dia' : 'semana';
    const porDia = periodo === 'dia' ? cantidad : cantidad / 7;
    out.push({ producto, cantidad, periodo, porDia, rowIndex: i + 1 });
  }
  return out;
}

// Crea o actualiza la regla de un producto (upsert por nombre normalizado).
async function setConsumo(producto, cantidad, periodo) {
  if (!SPREADSHEET_ID || !producto) return;
  const api = _sheetsClient();
  await _ensureSheet(api);
  const per = (periodo || 'semana').toString().toLowerCase().startsWith('d') ? 'dia' : 'semana';
  const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CONSUMO_SHEET}!A:D` });
  const rows = res.data.values || [];
  const nrm = norm(producto);
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) { if (norm(rows[i][0] || '') === nrm) { rowIndex = i + 1; break; } }
  const fila = [producto, Number(cantidad) || 0, per, new Date().toISOString()];
  if (rowIndex > 0) {
    await api.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${CONSUMO_SHEET}!A${rowIndex}:D${rowIndex}`, valueInputOption: 'RAW', requestBody: { values: [fila] } });
  } else {
    await api.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${CONSUMO_SHEET}!A:D`, valueInputOption: 'RAW', requestBody: { values: [fila] } });
  }
}

// Elimina la regla de un producto.
async function deleteConsumo(producto) {
  if (!SPREADSHEET_ID || !producto) return;
  const api = _sheetsClient();
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === CONSUMO_SHEET);
  if (!sheet) return;
  const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CONSUMO_SHEET}!A:D` });
  const rows = res.data.values || [];
  const nrm = norm(producto);
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) { if (norm(rows[i][0] || '') === nrm) { rowIndex = i + 1; break; } }
  if (rowIndex < 2) return;
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] },
  });
}

// Estima cobertura: para cada regla, cruza el consumo con lo comprado (ingresos).
// comprasPorProducto: { norm(producto): { ingresado, ultimaCompra } }.
// Devuelve [{ producto, cantidad, periodo, porDia, ingresado, consumidoEstimado,
//            stockEstimado, diasCobertura, ultimaCompra }].
function calcularCobertura(reglas, comprasPorProducto, hoy = new Date()) {
  return (reglas || []).map(r => {
    const info = comprasPorProducto[norm(r.producto)] || { ingresado: 0, ultimaCompra: null };
    let diasDesde = null, consumido = null, stock = null, diasCobertura = null;
    if (info.ultimaCompra) {
      diasDesde = Math.max(0, Math.round((hoy - new Date(info.ultimaCompra)) / 86400000));
      consumido = Math.round(r.porDia * diasDesde * 100) / 100;
      stock = Math.round((info.ingresado - consumido) * 100) / 100; // aprox sobre la última compra
      diasCobertura = r.porDia > 0 ? Math.round((info.ingresado / r.porDia)) : null;
    }
    return {
      producto: r.producto, cantidad: r.cantidad, periodo: r.periodo, porDia: Math.round(r.porDia * 100) / 100,
      ingresado: info.ingresado, ultimaCompra: info.ultimaCompra,
      diasDesdeUltimaCompra: diasDesde, consumidoEstimado: consumido,
      stockEstimado: stock, diasCobertura,
    };
  });
}

module.exports = { listConsumo, setConsumo, deleteConsumo, calcularCobertura, norm };
