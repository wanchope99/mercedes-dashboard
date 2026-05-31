const { google } = require('googleapis');
const NodeCache = require('node-cache');

// Cache de 2 minutos para no martillar la API en cada request
const cache = new NodeCache({ stdTTL: 120 });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
if (!SPREADSHEET_ID) throw new Error('Falta variable de entorno SPREADSHEET_ID');
const SHEET_NAME = 'Movimientos';

function getAuth() {
  // Soporta tanto JSON en variable de entorno como archivo
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function getRawRows() {
  const cached = cache.get('raw_rows');
  if (cached) return cached;

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:P`,
  });

  const rows = response.data.values || [];
  cache.set('raw_rows', rows);
  return rows;
}

function parseAmount(val) {
  if (!val || val === '' || val === '-') return 0;
  // Eliminar $, puntos de miles, espacios
  const cleaned = String(val).replace(/[$\s.]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseDate(val) {
  if (!val) return null;
  // Manejar formatos: 3/13/2026, 28/3/26, 1/5/26
  const parts = val.trim().split('/');
  if (parts.length !== 3) return null;

  let day, month, year;

  // Detectar si es M/D/YYYY o D/M/YY
  if (parts[0].length <= 2 && parseInt(parts[0]) <= 12 && parseInt(parts[1]) > 12) {
    // M/D/YYYY (formato americano)
    month = parseInt(parts[0]);
    day = parseInt(parts[1]);
    year = parseInt(parts[2]);
  } else {
    // D/M/YY o D/M/YYYY
    day = parseInt(parts[0]);
    month = parseInt(parts[1]);
    year = parseInt(parts[2]);
  }

  if (year < 100) year += 2000;

  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return null;
  return date;
}

async function getMovimientos() {
  const rows = await getRawRows();

  // Encontrar la fila de encabezados de Movimientos
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'Fecha' && rows[i][1] === 'Mes') {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) throw new Error('No se encontró la sección Movimientos');

  const movimientos = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0] || row[0] === '') break; // fin de sección

    const fecha = parseDate(row[0]);
    const mes = row[1] || '';
    const tipo = row[2] || ''; // Gasto, Ingreso, Otros
    const estado = row[3] || ''; // Pagado, A pagar
    const vencimiento = row[4] || '';
    const proveedor = row[5] || '';
    const categoria = row[6] || '';
    const descripcion = row[7] || '';
    const medioPago = row[8] || '';

    // Columnas de montos (índices 9-13 según la estructura)
    const entradaARS = parseAmount(row[9]);
    const entradaUSD = parseAmount(row[10]);
    const salidaARS = parseAmount(row[11]);
    const salidaUSD = parseAmount(row[12]);

    if (!fecha || !tipo) continue;

    movimientos.push({
      fecha,
      fechaStr: row[0],
      mes,
      tipo,
      estado,
      vencimiento,
      proveedor,
      categoria,
      descripcion,
      medioPago,
      entradaARS,
      entradaUSD,
      salidaARS,
      salidaUSD,
      // Pagado vs comprometido no pagado
      pagado: estado.toLowerCase() === 'pagado',
    });
  }

  return movimientos;
}

async function getResumenMensual(mes = null) {
  const movimientos = await getMovimientos();

  // Filtrar por mes si se especifica
  const filtered = mes ? movimientos.filter(m => m.mes === mes) : movimientos;

  // Agrupar por mes
  const meses = {};

  for (const m of filtered) {
    const key = m.mes;
    if (!meses[key]) {
      meses[key] = {
        mes: key,
        totalIngresos: 0,
        totalGastosPagados: 0,
        totalGastosComprometidos: 0, // incluye A pagar
        totalGastos: 0,
        ingresosPorMedioPago: {},
        gastosPorCategoria: {},
        gastosPorCategoriaComprometido: {},
        movimientos: [],
      };
    }

    const entry = meses[key];
    entry.movimientos.push(m);

    if (m.tipo === 'Ingreso') {
      entry.totalIngresos += m.entradaARS;

      if (!entry.ingresosPorMedioPago[m.medioPago]) {
        entry.ingresosPorMedioPago[m.medioPago] = 0;
      }
      entry.ingresosPorMedioPago[m.medioPago] += m.entradaARS;
    }

    if (m.tipo === 'Gasto') {
      const cat = m.categoria || 'Sin categoría';

      // Gastos pagados (impactan caja)
      if (m.pagado) {
        entry.totalGastosPagados += m.salidaARS;
        if (!entry.gastosPorCategoria[cat]) entry.gastosPorCategoria[cat] = 0;
        entry.gastosPorCategoria[cat] += m.salidaARS;
      }

      // Total comprometido (pagado + a pagar)
      entry.totalGastosComprometidos += m.salidaARS;
      if (!entry.gastosPorCategoriaComprometido[cat]) {
        entry.gastosPorCategoriaComprometido[cat] = 0;
      }
      entry.gastosPorCategoriaComprometido[cat] += m.salidaARS;

      entry.totalGastos += m.salidaARS;
    }
  }

  return Object.values(meses);
}

async function getActividadPorDia(mes = null) {
  const movimientos = await getMovimientos();
  const filtered = mes
    ? movimientos.filter(m => m.mes === mes)
    : movimientos;

  const dias = {};

  for (const m of filtered) {
    const key = m.fecha.toISOString().split('T')[0]; // YYYY-MM-DD
    if (!dias[key]) {
      dias[key] = {
        fecha: key,
        fechaDisplay: `${m.fecha.getDate()}/${m.fecha.getMonth() + 1}`,
        mes: m.mes,
        ingresos: 0,
        gastosPagados: 0,
        gastosComprometidos: 0,
        movimientos: [],
        servicioDelDia: false,
      };
    }

    const entry = dias[key];
    entry.movimientos.push(m);

    if (m.tipo === 'Ingreso') {
      entry.ingresos += m.entradaARS;
      if (m.proveedor === 'Servicio') entry.servicioDelDia = true;
    }

    if (m.tipo === 'Gasto') {
      if (m.pagado) entry.gastosPagados += m.salidaARS;
      entry.gastosComprometidos += m.salidaARS;
    }
  }

  return Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

async function getMeses() {
  const movimientos = await getMovimientos();
  const meses = [...new Set(movimientos.map(m => m.mes))];
  const orden = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return meses.sort((a, b) => orden.indexOf(a) - orden.indexOf(b));
}

async function getCategorias() {
  const movimientos = await getMovimientos();
  return [...new Set(movimientos.filter(m => m.tipo === 'Gasto').map(m => m.categoria))].sort();
}

function clearCache() {
  cache.flushAll();
}

module.exports = { getMovimientos, getResumenMensual, getActividadPorDia, getMeses, getCategorias, clearCache };
