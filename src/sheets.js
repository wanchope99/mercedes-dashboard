const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 120 });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
if (!SPREADSHEET_ID) throw new Error('Falta variable de entorno SPREADSHEET_ID');

// ─── Tipo de cambio USD/ARS: uno por fila, no uno global ──────────────────────
//
// Cada fila de Movimientos lleva SU propio tipo de cambio en la columna Q, que
// está oculta en la planilla y se carga desde la app (PUT /api/movimientos/:fila/tc).
//
// Antes había acá un único TC_USD = 1425 aplicado a las 35 filas en dólares de
// toda la historia. Con la volatilidad del peso eso no describe nada: la seña en
// dólares del servicio del 01/08/2026 se tomó a 1.500 (Fudo la registró en
// $300.000), y valuarla a 1.425 daba $285.000 — el dashboard mostraba $6.967
// menos que Fudo para ese mismo servicio.
//
// TC_FALLBACK es SÓLO para las filas que todavía no tienen TC propio. Vale
// exactamente lo que valía la constante vieja, así que introducir la columna no
// mueve ni un número histórico. Las filas que caen en el fallback viajan con
// tcConfirmado=false y la app las muestra marcadas: el TC puede faltar, pero
// nunca se convierte a un número inventado en silencio.
const TC_FALLBACK = 1425;

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

// Taxonomía jerárquica para el desglose de "Gastos" del dashboard (tabla + acordeón).
// Independiente de CATEGORIA_GRUPO/getGrupo (que siguen usándose sin cambios para
// CMV y Proyecciones) para no alterar comportamiento existente en esas áreas.
// superGrupo: 'Variables' | 'Personal' | 'Fijos' | 'Fiscales' | 'Financieros' | 'Extraordinarios' | 'Equipamiento' | 'Otros'
// subGrupo (solo para superGrupo 'Fijos'): 'Alquiler' | 'Servicios'
const CATEGORIA_SUPERGRUPO = {
  'Mercaderia':        { superGrupo: 'Variables' },
  'Insumos':           { superGrupo: 'Variables' },
  'Personal':          { superGrupo: 'Personal' },
  'Alquiler':          { superGrupo: 'Fijos', subGrupo: 'Alquiler' },
  'Servicios':         { superGrupo: 'Fijos', subGrupo: 'Servicios' },
  'Fiscales':          { superGrupo: 'Fiscales' },
  'Legal / Escribano': { superGrupo: 'Fiscales' },
  'Financieros':       { superGrupo: 'Financieros' },
  'Cocina':            { superGrupo: 'Equipamiento' },
  'Sala':              { superGrupo: 'Equipamiento' },
  'Mobiliario':        { superGrupo: 'Equipamiento' },
  'Frios':             { superGrupo: 'Equipamiento' },
  'Fondo de Comercio': { superGrupo: 'Equipamiento' },
  'Operativos':        { superGrupo: 'Otros' },
  'Gastos Operativos': { superGrupo: 'Otros' },
};
function getSuperGrupo(categoria) { return CATEGORIA_SUPERGRUPO[categoria] || { superGrupo: 'Otros' }; }

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

async function getSheetRows(sheetName, columnas = 'A:P', { crudo = false } = {}) {
  const cacheKey = `rows_${sheetName}_${columnas}${crudo ? '_crudo' : ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${columnas}`,
    // crudo: el valor guardado, sin pasar por el formato de la celda. Para un
    // número es la única lectura segura — ver el bloque del TC más abajo.
    ...(crudo ? { valueRenderOption: 'UNFORMATTED_VALUE' } : {}),
  });
  const rows = response.data.values || [];
  cache.set(cacheKey, rows);
  return rows;
}

// ─── Un tipo de cambio creíble ────────────────────────────────────────────────
//
// Piso de cordura para cualquier ARS/USD que venga de la planilla. No es
// decoración: el 12/08/2026 una sola celda de la columna T tenía formato de
// FECHA heredado, así que el 1420 que había guardado el sistema se leía como
// "11/20/03" (el serial 1420 es el 20-nov-1903) y parseAmount lo convertía en
// 11. Con TC=11 una compra de $198.000 pasaba a valer US$18.000, y esa sola
// fila inflaba el gasto de mayo en unos US$17.900.
//
// Dos defensas, y hacen falta las dos:
//   · la columna T se lee CRUDA, así ningún formato de celda puede alterar el
//     número (ataca la causa);
//   · un TC por debajo del piso se descarta y la fila queda SIN tipo de cambio,
//     que la app ya muestra y cuenta (ataca la consecuencia, venga de donde
//     venga el disparate).
//
// Descartar es lo correcto y no "usar el fallback": un valor absurdo significa
// que no sabemos el TC de esa fila, y valuarla igual la volvería a meter en un
// total sin que nadie se entere. Preferimos un total que dice "faltan N filas".
const TC_MINIMO_CREIBLE = Number(process.env.TC_MINIMO_CREIBLE || 100);
const tcCreible = v => (Number.isFinite(v) && v >= TC_MINIMO_CREIBLE ? v : 0);

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
  } else if (commaIdx !== -1 && dotIdx !== -1) {
    // Ambos separadores: el que está más a la derecha es el decimal
    cleaned = commaIdx > dotIdx
      ? noSign.replace(/\./g, '').replace(',', '.')   // 93.926,67
      : noSign.replace(/,/g, '');                      // 93,926.67
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

// ─── NO "arreglar" la lectura de fechas leyendo el serial de Sheets ───────────
//
// Medido el 12/08/2026, contra la columna Mes (texto escrito a mano, que es el
// único árbitro de la intención humana):
//
//   · parseDate() sobre el TEXTO MOSTRADO acierta 1097 de 1157 (95%), y los 60
//     desvíos son todos del tipo esperado — un pago que vence el 1 de junio y
//     pertenece a mayo. Es la diferencia Fecha/Mes que existe a propósito.
//   · Leer el SERIAL sin formatear acierta 49 de 469 (10%). Movería 432 filas
//     de mes.
//
// La razón: 469 celdas son fechas de verdad pero fueron cargadas escribiendo
// D/M en una planilla con formato M/D, así que Sheets guardó el día y el mes
// invertidos. El serial es el resultado de esa confusión, NO la intención. Al
// mostrarse, el mismo formato invierte de vuelta, y el texto vuelve a decir lo
// que la persona quiso escribir. Dos errores que se cancelan.
//
// Conclusión práctica: el texto mostrado es la fuente correcta y parseDate()
// está bien como está. Suena mal y es frágil, pero cambiarlo rompe 432 filas.
// Si algún día se normaliza la planilla, hay que arreglar los DATOS primero.
const isoLocal = d => (!d || isNaN(d.getTime())) ? null
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function getGrupo(categoria) {
  return CATEGORIA_GRUPO[categoria] || 'Otros';
}

// ─── Cuotas ───────────────────────────────────────────────────────────────────
// Convención en la planilla Movimientos:
//   Columna F "Cuotas":    fila madre → total de cuotas (ej: "6")
//                          fila cuota → "n/m" (ej: "2/6")
//   Columna H "ID Compra": mismo identificador en la madre y en todas sus cuotas
// La fila MADRE lleva el importe TOTAL, fecha/mes de la compra, estado "En cuotas"
// y medio de pago vacío (no toca cajas). Computa el total en el estado de
// resultados del mes de la compra.
// Cada CUOTA lleva el monto de la cuota, vencimiento, y estado A pagar/Pagado.
// Las cuotas mueven caja pero NO computan en el estado de resultados.
const RE_CUOTA = /^(\d+)\s*\/\s*(\d+)$/;

function parseCuotas(cuotasRaw, estado) {
  const info = { esCuota: false, esCompraEnCuotas: false, cuotaNum: null, cuotasTotal: null };
  // Tolerar el apóstrofe de "forzar texto" de Sheets ('2/6) por si quedó literal
  const raw = (cuotasRaw || '').toString().trim().replace(/^'+/, '');
  if (!raw) {
    // Fallback: una fila con estado "En cuotas" es madre aunque falte la col Q
    info.esCompraEnCuotas = (estado || '').toLowerCase() === 'en cuotas';
    return info;
  }
  const m = raw.match(RE_CUOTA);
  if (m) {
    info.esCuota = true;
    info.cuotaNum = parseInt(m[1]);
    info.cuotasTotal = parseInt(m[2]);
  } else if (/^\d+$/.test(raw) && parseInt(raw) > 1) {
    info.esCompraEnCuotas = true;
    info.cuotasTotal = parseInt(raw);
  }
  return info;
}

// ─── Movimientos ──────────────────────────────────────────────────────────────
async function getMovimientos() {
  // Hasta T: Q es el TC real de la operación y T el blue del día. Si la planilla
  // todavía no las tiene, las filas llegan cortas y quedan undefined → fallback,
  // sin romper nada. R y S NO se usan: son un bloque de saldos propio de la hoja.
  // La columna T se pide además CRUDA, en una lectura chica aparte: es un número
  // y el formato de la celda no puede tener voz sobre su valor. Va aparte y no en
  // lugar de la lectura formateada porque el resto de la fila sí se muestra tal
  // cual en la app (fechas y montos con su formato).
  const [rows, crudoT] = await Promise.all([
    getSheetRows('Movimientos', 'A:T'),
    getSheetRows('Movimientos', 'T:T', { crudo: true }),
  ]);

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

    // Columnas: A Fecha, B Mes, C Tipo, D Estado, E Vencimiento, F Cuotas,
    // G Extraodinario, H ID Compra, I Proveedor, J Categoría, K Descripción,
    // L Medio de pago, M Entrada ARS, N Entrada USD, O Salida ARS, P Salida USD,
    // Q TC USD de la operación (oculta, se carga desde la app),
    // R/S Saldo ARS y Saldo USD (bloque propio de la planilla, NO tocar),
    // T Blue del día (oculta, la completa el sistema — ver tc-movimientos.js)
    const fecha = parseDate(row[0]);
    const tipo = (row[2] || '').trim();       // Gasto, Ingreso, Otros
    const estado = (row[3] || '').trim();
    const categoria = (row[9] || '').trim();

    if (!fecha || !tipo) continue;

    // Montos ARS y USD
    const entradaARS = parseAmount(row[12]);
    const entradaUSD = parseAmount(row[13]);
    const salidaARS  = parseAmount(row[14]);
    const salidaUSD  = parseAmount(row[15]);

    // Convertir USD a ARS con el TC de ESTA fila (col Q). Sin TC propio se usa
    // el fallback, pero la fila queda marcada para que la app lo pida.
    const tieneUSD = entradaUSD > 0 || salidaUSD > 0;
    const tcFila = parseAmount(row[16]);
    const tcConfirmado = tcFila > 0;
    const tcUsd = tcConfirmado ? tcFila : TC_FALLBACK;

    const entradaTotal = entradaARS + (entradaUSD * tcUsd);
    const salidaTotal  = salidaARS  + (salidaUSD  * tcUsd);

    // Cambios y fondeos quedan FUERA del circuito de "cargá el TC". No es que no
    // tengan uno: es que no cambia ningún número que se reporte. Son plata pasando
    // de un bolsillo a otro — filtrarOperativos() ya los saca del resultado, y el
    // saldo de una caja en dólares se lleva en dólares, así que el TC no lo toca.
    // Pedir el TC de los 14 cambios seria trabajo cuyo unico efecto es tacharlos
    // de una lista. La condicion es la MISMA que filtrarOperativos, a proposito:
    // si algun dia cambia que entra y que no en el resultado, esto la sigue sola.
    const esCambioFila = categoria === 'Cambio';
    const esFondeoFila = tipo === 'Otros';
    const tcRelevante = tieneUSD && !esCambioFila && !esFondeoFila;

    // ─── Valuación en dólares ─────────────────────────────────────────────────
    // Cada fila se valúa al tipo de cambio de SU día, no a uno solo para toda la
    // historia. Sumar esas conversiones da plata a valor constante, que es el
    // único total comparable entre meses con esta inflación.
    //
    // Precedencia: Q manda sobre T. Q es a cuánto se hizo REALMENTE la operación
    // (un hecho de la transacción, cargado a mano); T es el blue de ese día (una
    // referencia de mercado, automática). Cuando existen las dos, la verdad es Q.
    //
    // Consecuencia que hay que tener presente al leer un KPI: el total en dólares
    // NO es el total en pesos dividido por un tipo de cambio. Son N conversiones
    // distintas sumadas.
    // Q sólo vale como TC de valuación si esta fila REALMENTE tiene un importe en
    // dólares: es "a cuánto se hizo esta operación en dólares". En una fila sólo
    // en pesos, Q no significa nada — y si trae algo, es basura arrastrada.
    const tcOperacion = tieneUSD ? tcCreible(tcFila) : 0;
    const tcBlueFila = tcCreible(parseAmount((crudoT[i] || [])[0]));
    const tcValuacion = tcOperacion > 0 ? tcOperacion : tcBlueFila;
    const origenTC = tcOperacion > 0 ? 'operacion' : (tcBlueFila > 0 ? 'blue' : 'ninguno');
    // Los importes ya cargados en dólares no se convierten: ya están en dólares.
    const entradaEnUSD = tcValuacion > 0 ? entradaUSD + (entradaARS / tcValuacion) : entradaUSD;
    const salidaEnUSD  = tcValuacion > 0 ? salidaUSD  + (salidaARS  / tcValuacion) : salidaUSD;

    // Cuotas (columnas F y H)
    const cuotasInfo = parseCuotas(row[5], estado);
    const cuotaId = (row[7] || '').toString().trim();

    // Clasificación jerárquica para el desglose de Gastos (independiente de `grupo`)
    const esExtraordinario = ((row[6] || '').toString().trim()).length > 0;
    const superGrupoBase = getSuperGrupo(categoria);
    const superGrupo = esExtraordinario ? 'Extraordinarios' : superGrupoBase.superGrupo;
    const subGrupo   = esExtraordinario ? null : (superGrupoBase.subGrupo || null);

    movimientos.push({
      fecha,
      fechaStr: row[0],
      mes: (row[1] || '').trim(),
      tipo,
      estado,
      vencimiento: row[4] || '',
      extraordinario: row[6] || '',
      esExtraordinario,
      superGrupo,
      subGrupo,
      proveedor: (row[8] || '').trim(),
      categoria,
      grupo: getGrupo(categoria),
      descripcion: row[10] || '',
      medioPago: (row[11] || '').trim(),
      entradaARS,
      entradaUSD,
      salidaARS,
      salidaUSD,
      entradaTotal,   // ARS + USD*TC de la fila
      salidaTotal,    // ARS + USD*TC de la fila
      // Valuación en dólares al TC del día de la fila (Q manda, si no T).
      entradaEnUSD,
      salidaEnUSD,
      tcValuacion: tcValuacion || null,
      origenTC,       // 'operacion' | 'blue' | 'ninguno'
      fechaISO: isoLocal(fecha),
      // TC: sólo tiene sentido en filas con importe en dólares. En el resto se
      // manda tcConfirmado=true para que la app no marque lo que no hay que cargar.
      tieneUSD,
      tcUsd: tieneUSD ? tcUsd : null,
      tcConfirmado: tieneUSD ? tcConfirmado : true,
      // Si vale false, la fila puede tener TC pero la app no lo reclama.
      tcRelevante,
      pagado: estado.toLowerCase() === 'pagado',
      diaSemana: DIAS_SEMANA[fecha.getDay()],
      // Flags para filtrar
      esCambio: categoria === 'Cambio',
      esFondeo: tipo === 'Otros',
      // Cuotas
      esCuota: cuotasInfo.esCuota,   // fila de pago de cuota (n/m)
      esCompraEnCuotas: cuotasInfo.esCompraEnCuotas || estado.toLowerCase() === 'en cuotas', // fila madre
      cuotaNum: cuotasInfo.cuotaNum,
      cuotasTotal: cuotasInfo.cuotasTotal,
      cuotaId: cuotaId || null,
      rowIndex: i + 1,   // fila real en la hoja (1-based) para updates in-place
    });
  }

  return movimientos;
}

// Info agregada por compra en cuotas (por ID Compra)
// { [cuotaId]: { totalCompra, cuotasTotal, cuotasPagadas, pagadoAcum, restante, medioPago, proveedor, descripcion, mesCompra } }
async function getComprasEnCuotas() {
  const todos = await getMovimientos();
  const grupos = {};
  for (const m of todos) {
    if (!m.cuotaId) continue;
    if (!grupos[m.cuotaId]) {
      grupos[m.cuotaId] = {
        cuotaId: m.cuotaId, totalCompra: 0, cuotasTotal: null,
        cuotasPagadas: 0, pagadoAcum: 0, restante: 0,
        medioPago: '', proveedor: '', descripcion: '', mesCompra: '',
      };
    }
    const g = grupos[m.cuotaId];
    if (m.esCompraEnCuotas) {
      g.totalCompra = m.salidaTotal;
      g.cuotasTotal = m.cuotasTotal || g.cuotasTotal;
      g.proveedor = g.proveedor || m.proveedor;
      g.descripcion = g.descripcion || m.descripcion;
      g.mesCompra = m.mes;
    }
    if (m.esCuota) {
      g.cuotasTotal = g.cuotasTotal || m.cuotasTotal;
      if (m.pagado) {
        g.cuotasPagadas++;
        g.pagadoAcum += m.salidaTotal;
        if (m.medioPago) g.medioPago = m.medioPago;  // medio real con el que se viene pagando
      } else {
        g.restante += m.salidaTotal;
      }
    }
  }
  return grupos;
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
    // Las CUOTAS no computan en el estado de resultados: el importe total
    // de la compra ya computa completo en el mes de la compra (fila madre).
    if (m.esCuota) continue;

    // Agrupar por mes (o por rango completo si hay fechas)
    const key = mes ? m.mes : (fechaDesde ? 'Período' : m.mes);

    if (!meses[key]) {
      meses[key] = {
        mes: key,
        gastos: {
          total: 0,
          Variables: 0, Personal: 0, Fijos: 0, Fiscales: 0, Financieros: 0, Extraordinarios: 0, Equipamiento: 0, Otros: 0,
          Mercaderia: 0, Insumos: 0,
          Alquiler: 0, Servicios: 0,
          serviciosPorProveedor: {},
          extraordinariosPorCategoria: {},
        },
        ingresos: { Efectivo: 0, 'Mercado Pago': 0, Galicia: 0, Otros: 0, total: 0 },
        gastosPorCategoria: {},
        ingresosPorMedioPago: {},
        totalGastosPagados: 0,
        totalGastosComprometidos: 0,
        // ─── El mismo mes, en dólares ───────────────────────────────────────
        // Cada fila se convierte al tipo de cambio de SU día (columna Q si la
        // operación tiene el suyo, si no el blue de la columna T) y recién ahí
        // se suma. Es plata a valor constante: lo único comparable entre meses
        // cuando el peso se mueve 13% en un trimestre.
        //
        // OJO al leerlo: usd.ingresos NO es ingresos.total dividido por un tipo
        // de cambio. Son N conversiones distintas sumadas, y por eso no da lo
        // mismo. La pantalla lo dice explícitamente.
        usd: { ingresos: 0, gastos: 0, filasSinTC: 0 },
      };
    }

    const entry = meses[key];

    if (m.tipo === 'Ingreso') {
      // Se agrupan las variantes por persona (Efectivo Local/Pablo/Tincho,
      // Mercado Pago Tincho/Pablo) en un solo medio: acá interesa por dónde
      // entró la plata, no de quién es la cuenta.
      let mp = m.medioPago;
      if (mp.toLowerCase().includes('efectivo')) mp = 'Efectivo';
      else if (mp.toLowerCase().includes('mercado pago')) mp = 'Mercado Pago';
      else if (mp.toLowerCase().includes('galicia')) mp = 'Galicia';
      else mp = 'Otros';

      entry.ingresos[mp] = (entry.ingresos[mp] || 0) + m.entradaTotal;
      entry.ingresos.total += m.entradaTotal;
      entry.ingresosPorMedioPago[mp] = (entry.ingresosPorMedioPago[mp] || 0) + m.entradaTotal;
      entry.usd.ingresos += m.entradaEnUSD;
      if (!m.tcValuacion && m.entradaTotal > 0) entry.usd.filasSinTC++;
    }

    if (m.tipo === 'Gasto') {
      const monto = m.salidaTotal;
      entry.gastos.total += monto;
      const sg = m.superGrupo;
      entry.gastos[sg] = (entry.gastos[sg] || 0) + monto;
      if (sg === 'Variables') {
        entry.gastos[m.categoria] = (entry.gastos[m.categoria] || 0) + monto;   // Mercaderia | Insumos
      } else if (sg === 'Fijos') {
        entry.gastos[m.subGrupo] = (entry.gastos[m.subGrupo] || 0) + monto;    // Alquiler | Servicios
        if (m.subGrupo === 'Servicios') {
          const prov = m.proveedor || 'Sin proveedor';
          entry.gastos.serviciosPorProveedor[prov] = (entry.gastos.serviciosPorProveedor[prov] || 0) + monto;
        }
      } else if (sg === 'Extraordinarios') {
        const catOrig = m.categoria || 'Sin categoría';
        entry.gastos.extraordinariosPorCategoria[catOrig] = (entry.gastos.extraordinariosPorCategoria[catOrig] || 0) + monto;
      }
      const cat = m.categoria || 'Sin categoría';
      entry.gastosPorCategoria[cat] = (entry.gastosPorCategoria[cat] || 0) + monto;
      // Una compra en cuotas se considera "pagada" en el estado de resultados
      // del mes de la compra (la financiación es tema de caja, no de P&L)
      if (m.pagado || m.esCompraEnCuotas) entry.totalGastosPagados += monto;
      entry.totalGastosComprometidos += monto;
      entry.usd.gastos += m.salidaEnUSD;
      if (!m.tcValuacion && monto > 0) entry.usd.filasSinTC++;
    }
  }

  return Object.values(meses).map(m => ({
    ...m,
    usd: {
      ...m.usd,
      resultadoNeto: m.usd.ingresos - m.usd.gastos,
      // El TC implícito del mes: los pesos que hubo que mover por cada dólar de
      // resultado. Sirve para explicar por qué el total en dólares no es el
      // total en pesos sobre una cotización sola.
      tcImplicito: m.usd.ingresos > 0 ? m.ingresos.total / m.usd.ingresos : null,
    },
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
    // Cuotas: no computan como gasto del día (igual que en el resumen mensual)
    if (m.esCuota) continue;
    const key = m.fecha.toISOString().split('T')[0];
    if (!dias[key]) {
      dias[key] = { fecha: key, fechaDisplay: `${m.fecha.getDate()}/${m.fecha.getMonth() + 1}`, diaSemana: m.diaSemana, mes: m.mes, ingresos: 0, gastosPagados: 0, gastosComprometidos: 0, movimientos: [], servicioDelDia: false };
    }
    const entry = dias[key];
    entry.movimientos.push(m);
    if (m.tipo === 'Ingreso') { entry.ingresos += m.entradaTotal; if (m.proveedor === 'Servicio') entry.servicioDelDia = true; }
    if (m.tipo === 'Gasto') { if (m.pagado || m.esCompraEnCuotas) entry.gastosPagados += m.salidaTotal; entry.gastosComprometidos += m.salidaTotal; }
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
  getComprasEnCuotas,
  getMeses, getCategorias, clearCache,
  TC_FALLBACK,
};
