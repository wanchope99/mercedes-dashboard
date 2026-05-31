const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 120 });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
if (!SPREADSHEET_ID) throw new Error('Falta variable de entorno SPREADSHEET_ID');

// Mapeo de categorías de la planilla a grupos del reporte
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

async function getRawRows() {
  const cached = cache.get('raw_rows');
  if (cached) return cached;

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Movimientos!A:P',
  });

  const rows = response.data.values || [];
  cache.set('raw_rows', rows);
  return rows;
}

function parseAmount(val) {
  if (!val || val === '' || val === '-') return 0;
  const cleaned = String(val).replace(/[$\s.]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseDate(val) {
  if (!val) return null;
  const parts = val.trim().split('/');
  if (parts.length !== 3) return null;

  let day, month, year;

  if (parts[0].length <= 2 && parseInt(parts[0]) <= 12 && parseInt(parts[1]) > 12) {
    month = parseInt(parts[0]);
    day = parseInt(parts[1]);
    year = parseInt(parts[2]);
  } else {
    day = parseInt(parts[0]);
    month = parseInt(parts[1]);
    year = parseInt(parts[2]);
  }

  if (year < 100) year += 2000;
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return null;
  return date;
}

function getGrupo(categoria) {
  return CATEGORIA_GRUPO[categoria] || 'Otros';
}

async function getMovimientos() {
  const rows = await getRawRows();

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const c0 = (r[0] || '').toString().trim();
    const c1 = (r[1] || '').toString().trim();
    if (c0 === 'Fecha' && c1 === 'Mes') {
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
    const mes = row[1] || '';
    const tipo = row[2] || '';
    const estado = row[3] || '';
    const vencimiento = row[4] || '';
    const proveedor = row[5] || '';
    const categoria = row[6] || '';
    const descripcion = row[7] || '';
    const medioPago = row[8] || '';
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
      grupo: getGrupo(categoria),
      descripcion,
      medioPago,
      entradaARS,
      entradaUSD,
      salidaARS,
      salidaUSD,
      pagado: estado.toLowerCase() === 'pagado',
      diaSemana: DIAS_SEMANA[fecha.getDay()],
    });
  }

  return movimientos;
}

async function getResumenMensual(mes = null) {
  const movimientos = await getMovimientos();
  const filtered = mes ? movimientos.filter(m => m.mes === mes) : movimientos;

  const meses = {};

  for (const m of filtered) {
    const key = m.mes;
    if (!meses[key]) {
      meses[key] = {
        mes: key,
        // Gastos por grupo
        gastos: {
          Mercaderia: 0,
          Insumos: 0,
          Equipamiento: 0,
          Operativos: 0,
          Impuestos: 0,
          Personal: 0,
          Otros: 0,
          total: 0,
        },
        // Ingresos por medio de pago
        ingresos: {
          Efectivo: 0,
          'Mercado Pago': 0,
          Galicia: 0,
          Otros: 0,
          total: 0,
        },
        // Para charts
        gastosPorCategoria: {},
        ingresosPorMedioPago: {},
        totalGastosPagados: 0,
        totalGastosComprometidos: 0,
      };
    }

    const entry = meses[key];

    if (m.tipo === 'Ingreso') {
      // Agrupar medios de pago
      let mp = m.medioPago;
      if (mp.toLowerCase().includes('efectivo')) mp = 'Efectivo';
      else if (mp.toLowerCase().includes('mercado pago')) mp = 'Mercado Pago';
      else if (mp.toLowerCase().includes('galicia')) mp = 'Galicia';
      else mp = 'Otros';

      entry.ingresos[mp] = (entry.ingresos[mp] || 0) + m.entradaARS;
      entry.ingresos.total += m.entradaARS;
      entry.ingresosPorMedioPago[mp] = (entry.ingresosPorMedioPago[mp] || 0) + m.entradaARS;
    }

    if (m.tipo === 'Gasto') {
      const grupo = m.grupo;
      entry.gastos[grupo] = (entry.gastos[grupo] || 0) + m.salidaARS;
      entry.gastos.total += m.salidaARS;

      const cat = m.categoria || 'Sin categoría';
      entry.gastosPorCategoria[cat] = (entry.gastosPorCategoria[cat] || 0) + m.salidaARS;

      if (m.pagado) entry.totalGastosPagados += m.salidaARS;
      entry.totalGastosComprometidos += m.salidaARS;
    }
  }

  // Calcular resultado neto y % mercadería+insumos
  return Object.values(meses).map(m => ({
    ...m,
    resultadoNeto: m.ingresos.total - m.gastos.total,
    pctMercInsumos: m.ingresos.total > 0
      ? ((m.gastos.Mercaderia + m.gastos.Insumos) / m.ingresos.total) * 100
      : 0,
  }));
}

async function getActividadPorDiaSemana(mes = null) {
  const movimientos = await getMovimientos();
  const filtered = mes
    ? movimientos.filter(m => m.mes === mes && m.tipo === 'Ingreso' && m.proveedor === 'Servicio')
    : movimientos.filter(m => m.tipo === 'Ingreso' && m.proveedor === 'Servicio');

  // Agrupar por día de la semana
  const diasSemana = {};
  const ordenDias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

  for (const m of filtered) {
    const dia = m.diaSemana;
    if (!diasSemana[dia]) {
      diasSemana[dia] = {
        dia,
        totalIngresos: 0,
        cantServicios: 0,
        promedio: 0,
        fechas: [],
        // Breakdown por medio de pago
        efectivo: 0,
        mercadoPago: 0,
        galicia: 0,
      };
    }

    const entry = diasSemana[dia];
    entry.totalIngresos += m.entradaARS;

    const mp = m.medioPago.toLowerCase();
    if (mp.includes('efectivo')) entry.efectivo += m.entradaARS;
    else if (mp.includes('mercado pago')) entry.mercadoPago += m.entradaARS;
    else if (mp.includes('galicia')) entry.galicia += m.entradaARS;

    // Contar servicios únicos por fecha
    const fechaKey = m.fecha.toISOString().split('T')[0];
    if (!entry.fechas.includes(fechaKey)) {
      entry.fechas.push(fechaKey);
      entry.cantServicios++;
    }
  }

  // Calcular promedios
  return ordenDias
    .filter(d => diasSemana[d])
    .map(d => ({
      ...diasSemana[d],
      promedio: diasSemana[d].cantServicios > 0
        ? diasSemana[d].totalIngresos / diasSemana[d].cantServicios
        : 0,
    }));
}

async function getActividadPorDia(mes = null) {
  const movimientos = await getMovimientos();
  const filtered = mes ? movimientos.filter(m => m.mes === mes) : movimientos;

  const dias = {};
  for (const m of filtered) {
    const key = m.fecha.toISOString().split('T')[0];
    if (!dias[key]) {
      dias[key] = {
        fecha: key,
        fechaDisplay: `${m.fecha.getDate()}/${m.fecha.getMonth() + 1}`,
        diaSemana: m.diaSemana,
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

module.exports = {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getMeses, getCategorias, clearCache
};
