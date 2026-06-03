const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 120 });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
if (!SPREADSHEET_ID) throw new Error('Falta variable de entorno SPREADSHEET_ID');

// Tipo de cambio USD/ARS — idealmente esto viene de la planilla (Summary!B37)
// Por ahora usamos el valor de la planilla: 1425
const TC_USD = 1425;

// Mapeo de categorías a grupos del reporte
const CATEGORIA_GRUPO = {
  'Mercaderia': 'Mercaderia',
  'Insumos': 'Insumos',
  'Cocina': 'Equipamiento',
  'Sala': 'Equipamiento',
  'Mobiliario': 'Equipamiento',
  'Frios': 'Equipamiento',
  'Operativos': 'Operativos',
  'Gastos Operativos': 'Operativos',
  'Servicios': 'Operativos',
  'Fiscales': 'Impuestos',
  'Legal / Escribano': 'Impuestos',
  'Personal': 'Personal',
  'Alquiler': 'Operativos',
  'Fondo de Comercio': 'Equipamiento',
};

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function getAuth() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function getSheetRows(sheetName) {
  const cacheKey = `rows_${sheetName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:P`,
  });
  const rows = response.data.values || [];
  cache.set(cacheKey, rows);
  return rows;
}

function parseAmount(val) {
  if (!val || val === '' || val === '-') return 0;
  const str = String(val).trim();
  const noSign = str.replace(/[$\s]/g, '');
  const commaIdx = noSign.lastIndexOf(',');
  const dotIdx = noSign.lastIndexOf('.');
  let cleaned;
  if (commaIdx !== -1 && dotIdx === -1) {
    const afterComma = noSign.slice(commaIdx + 1);
    cleaned = afterComma.length === 3
      ? noSign.replace(/,/g, '')
      : noSign.replace(',', '.');
  } else if (dotIdx !== -1 && commaIdx === -1) {
    const afterDot = noSign.slice(dotIdx + 1);
    cleaned = afterDot.length === 3
      ? noSign.replace(/\./g, '')
      : noSign;
  } else {
    cleaned = noSign.replace(/[,.]/g, '');
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseDate(val) {
  if (!val) return null;
  const parts = val.trim().split('/');
  if (parts.length !== 3) return null;
  let day, month, year;
  if (parts[0].length <= 2 && parseInt(parts[0]) <= 12 && parseInt(parts[1]) > 12) {
    month = parseInt(parts[0]); day = parseInt(parts[1]); year = parseInt(parts[2]);
  } else {
    day = parseInt(parts[0]); month = parseInt(parts[1]); year = parseInt(parts[2]);
  }
  if (year < 100) year += 2000;
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return null;
  return date;
}

function getGrupo(categoria) {
  return CATEGORIA_GRUPO[categoria] || 'Otros';
}

// ─── Movimientos ──────────────────────────────────────────────────────────────
async function getMovimientos() {
  const rows = await getSheetRows('Movimientos');

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if ((r[0] || '').toString().trim() === 'Fecha' && (r[1] || '').toString().trim() === 'Mes') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error('No se encontró la sección Movimientos');

  const movimientos = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0] || row[0] === '') continue;

    const fecha = parseDate(row[0]);
    const tipo = (row[2] || '').trim();       // Gasto, Ingreso, Otros
    const estado = (row[3] || '').trim();
    const categoria = (row[6] || '').trim();

    if (!fecha || !tipo) continue;

    // Montos ARS y USD
    const entradaARS = parseAmount(row[9]);
    const entradaUSD = parseAmount(row[10]);
    const salidaARS  = parseAmount(row[11]);
    const salidaUSD  = parseAmount(row[12]);

    // Convertir USD a ARS para totales
    const entradaTotal = entradaARS + (entradaUSD * TC_USD);
    const salidaTotal  = salidaARS  + (salidaUSD  * TC_USD);

    movimientos.push({
      fecha,
      fechaStr: row[0],
      mes: (row[1] || '').trim(),
      tipo,
      estado,
      vencimiento: row[4] || '',
      proveedor: (row[5] || '').trim(),
      categoria,
      grupo: getGrupo(categoria),
      descripcion: row[7] || '',
      medioPago: (row[8] || '').trim(),
      entradaARS,
      entradaUSD,
      salidaARS,
      salidaUSD,
      entradaTotal,   // ARS + USD*TC
      salidaTotal,    // ARS + USD*TC
      pagado: estado.toLowerCase() === 'pagado',
      diaSemana: DIAS_SEMANA[fecha.getDay()],
      // Flags para filtrar
      esCambio: categoria === 'Cambio',
      esFondeo: tipo === 'Otros',
    });
  }

  return movimientos;
}

// Movimientos que son ingresos/gastos reales (excluye Cambios y Fondeos)
function filtrarOperativos(movimientos) {
  return movimientos.filter(m => !m.esCambio && !m.esFondeo);
}

// Aplicar filtro de fecha (mes o rango)
function filtrarFecha(movimientos, { mes, fechaDesde, fechaHasta } = {}) {
  return movimientos.filter(m => {
    if (mes) return m.mes === mes;
    if (fechaDesde && fechaHasta) {
      return m.fecha >= fechaDesde && m.fecha <= fechaHasta;
    }
    return true;
  });
}

// ─── Resumen mensual ──────────────────────────────────────────────────────────
async function getResumenMensual({ mes, fechaDesde, fechaHasta } = {}) {
  const todos = await getMovimientos();
  const operativos = filtrarOperativos(todos);
  const filtered = filtrarFecha(operativos, { mes, fechaDesde, fechaHasta });

  const meses = {};

  for (const m of filtered) {
    // Agrupar por mes (o por rango completo si hay fechas)
    const key = mes ? m.mes : (fechaDesde ? 'Período' : m.mes);

    if (!meses[key]) {
      meses[key] = {
        mes: key,
        gastos: { Mercaderia: 0, Insumos: 0, Equipamiento: 0, Operativos: 0, Impuestos: 0, Personal: 0, Otros: 0, total: 0 },
        ingresos: { Efectivo: 0, 'Mercado Pago': 0, Galicia: 0, Otros: 0, total: 0 },
        gastosPorCategoria: {},
        ingresosPorMedioPago: {},
        totalGastosPagados: 0,
        totalGastosComprometidos: 0,
      };
    }

    const entry = meses[key];

    if (m.tipo === 'Ingreso') {
      let mp = m.medioPago;
      if (mp.toLowerCase().includes('efectivo')) mp = 'Efectivo';
      else if (mp.toLowerCase().includes('mercado pago')) mp = 'Mercado Pago';
      else if (mp.toLowerCase().includes('galicia')) mp = 'Galicia';
      else mp = 'Otros';

      entry.ingresos[mp] = (entry.ingresos[mp] || 0) + m.entradaTotal;
      entry.ingresos.total += m.entradaTotal;
      entry.ingresosPorMedioPago[mp] = (entry.ingresosPorMedioPago[mp] || 0) + m.entradaTotal;
    }

    if (m.tipo === 'Gasto') {
      const grupo = m.grupo;
      entry.gastos[grupo] = (entry.gastos[grupo] || 0) + m.salidaTotal;
      entry.gastos.total += m.salidaTotal;
      const cat = m.categoria || 'Sin categoría';
      entry.gastosPorCategoria[cat] = (entry.gastosPorCategoria[cat] || 0) + m.salidaTotal;
      if (m.pagado) entry.totalGastosPagados += m.salidaTotal;
      entry.totalGastosComprometidos += m.salidaTotal;
    }
  }

  return Object.values(meses).map(m => ({
    ...m,
    resultadoNeto: m.ingresos.total - m.gastos.total,
    pctMercInsumos: m.ingresos.total > 0
      ? ((m.gastos.Mercaderia + m.gastos.Insumos) / m.ingresos.total) * 100 : 0,
    pctPersonal: m.ingresos.total > 0
      ? (m.gastos.Personal / m.ingresos.total) * 100 : 0,
  }));
}

// ─── Actividad por día de la semana ──────────────────────────────────────────
async function getActividadPorDiaSemana({ mes, fechaDesde, fechaHasta } = {}) {
  const todos = await getMovimientos();
  const operativos = filtrarOperativos(todos);
  const servicios = filtrarFecha(
    operativos.filter(m => m.tipo === 'Ingreso' && m.proveedor === 'Servicio'),
    { mes, fechaDesde, fechaHasta }
  );

  const ordenDias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const diasSemana = {};

  for (const m of servicios) {
    const dia = m.diaSemana;
    if (!diasSemana[dia]) {
      diasSemana[dia] = { dia, totalIngresos: 0, cantServicios: 0, promedio: 0, fechas: [], efectivo: 0, mercadoPago: 0, galicia: 0 };
    }
    const entry = diasSemana[dia];
    entry.totalIngresos += m.entradaTotal;
    const mp = m.medioPago.toLowerCase();
    if (mp.includes('efectivo')) entry.efectivo += m.entradaTotal;
    else if (mp.includes('mercado pago')) entry.mercadoPago += m.entradaTotal;
    else if (mp.includes('galicia')) entry.galicia += m.entradaTotal;
    const fechaKey = m.fecha.toISOString().split('T')[0];
    if (!entry.fechas.includes(fechaKey)) { entry.fechas.push(fechaKey); entry.cantServicios++; }
  }

  return ordenDias
    .filter(d => diasSemana[d])
    .map(d => ({ ...diasSemana[d], promedio: diasSemana[d].cantServicios > 0 ? diasSemana[d].totalIngresos / diasSemana[d].cantServicios : 0 }));
}

// ─── Actividad por día ────────────────────────────────────────────────────────
async function getActividadPorDia({ mes, fechaDesde, fechaHasta } = {}) {
  const todos = await getMovimientos();
  const operativos = filtrarOperativos(todos);
  const filtered = filtrarFecha(operativos, { mes, fechaDesde, fechaHasta });

  const dias = {};
  for (const m of filtered) {
    const key = m.fecha.toISOString().split('T')[0];
    if (!dias[key]) {
      dias[key] = { fecha: key, fechaDisplay: `${m.fecha.getDate()}/${m.fecha.getMonth() + 1}`, diaSemana: m.diaSemana, mes: m.mes, ingresos: 0, gastosPagados: 0, gastosComprometidos: 0, movimientos: [], servicioDelDia: false };
    }
    const entry = dias[key];
    entry.movimientos.push(m);
    if (m.tipo === 'Ingreso') { entry.ingresos += m.entradaTotal; if (m.proveedor === 'Servicio') entry.servicioDelDia = true; }
    if (m.tipo === 'Gasto') { if (m.pagado) entry.gastosPagados += m.salidaTotal; entry.gastosComprometidos += m.salidaTotal; }
  }
  return Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ─── Cajas ────────────────────────────────────────────────────────────────────
async function getCajas() {
  const rows = await getSheetRows('Cajas');

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && (rows[i][0] || '').trim() === 'Caja') { headerIdx = i; break; }
  }
  if (headerIdx === -1) return [];

  const cajas = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    cajas.push({
      caja: row[0],
      alias: row[1] || '',
      moneda: row[2] || 'ARS',
      entradas: parseAmount(row[3]),
      salidas: parseAmount(row[4]),
      saldoCalculado: parseAmount(row[5]),
      saldoReal: parseAmount(row[6]),
      cobroPendiente: parseAmount(row[7]),
      diff: parseAmount(row[8]),
    });
  }
  return cajas;
}

// ─── Movimientos de cambio (entre cajas) ─────────────────────────────────────
async function getMovimientosCambio({ mes, fechaDesde, fechaHasta } = {}) {
  const todos = await getMovimientos();
  const cambios = todos.filter(m => m.esCambio || m.esFondeo);
  return filtrarFecha(cambios, { mes, fechaDesde, fechaHasta }).map(m => ({
    ...m,
    fecha: m.fecha.toISOString().split('T')[0],
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getMeses() {
  const movimientos = await getMovimientos();
  const meses = [...new Set(movimientos.map(m => m.mes).filter(Boolean))];
  const orden = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return meses.sort((a, b) => orden.indexOf(a) - orden.indexOf(b));
}

async function getCategorias() {
  const movimientos = await getMovimientos();
  return [...new Set(movimientos.filter(m => m.tipo === 'Gasto' && !m.esCambio).map(m => m.categoria))].sort();
}

function clearCache() { cache.flushAll(); }

module.exports = {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getCajas, getMovimientosCambio,
  getMeses, getCategorias, clearCache,
};
