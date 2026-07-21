require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getCajas, getMovimientosCambio,
  getComprasEnCuotas,
  getMeses, getCategorias, clearCache,
} = require('./sheets');
const { getServicios, getServicioDetalle, getServicioDebug, resnapshotDia, resnapshotTodos, getDetallesTodos, getDetallesFrescos, getAgregadoProductos, getProductoDebug, getVentaDebugCrudo, clearFudoCache, fechaServicio: fechaServicioDe, fechaServicioHoy, probeStock, probeStockMovements, getVentasItems, getVentasConCosto } = require('./fudo');
const vinos = require('./vinos');
const { proyectar, calcularCalculadora, proyeccionMes, calcularBaselines } = require('./proyecciones');
const proveedoresRoutes = require('./proveedores-routes');
const prov = require('./proveedores');
const costos = require('./costos');
const costosProveedores = require('./costos-proveedores');
const cats = require('./proveedores-categorias');
const consumo = require('./consumo');
const cierres = require('./cierres');
const plan = require('./plan');
const tc = require('./tc');
const roi = require('./roi');
const finanzas = require('./finanzas');
const stockBebidas = require('./stock-bebidas');
const { iniciarCron } = require('./cron');
const { cargarEstadoCaja, guardarEstadoCaja } = require('./estado-caja');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Las fotos de facturas viajan en base64 dentro del JSON → subir el límite.
app.use(express.json({ limit: '25mb' }));

// ─── Config ───────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const JWT_SECRET = process.env.JWT_SECRET || 'mercedes-secret-2026';

// Usuarios: credenciales desde variables de entorno
const USUARIOS = {
  admin: {
    password: process.env.ADMIN_PASSWORD || 'admin123',
    rol: 'admin',
    nombre: 'Administrador',
  },
  charly: {
    password: process.env.CHARLY_PASSWORD || 'charly123',
    rol: 'encargado',
    nombre: 'Charly',
  },
};

// Estado de caja en memoria (persiste mientras el servidor esté corriendo)
let estadoCaja = {
  abierta: false,
  apertura: null,         // timestamp ISO
  encargado: null,
  efectivoInicial: null,
  mpInicial: null,
  galiciaInicial: null,
  gastosSesion: [],       // gastos registrados con la caja abierta (hielo, etc.)
};

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function getAuth() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Sin permisos' });
  next();
}

// ─── Login ────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  const user = USUARIOS[usuario?.toLowerCase()];
  if (!user || user.password !== password) {
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  }
  const token = jwt.sign(
    { usuario: usuario.toLowerCase(), rol: user.rol, nombre: user.nombre },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ ok: true, token, rol: user.rol, nombre: user.nombre });
});

// Verificar token vigente
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ ok: true, usuario: req.user.usuario, rol: req.user.rol, nombre: req.user.nombre });
});

// ─── Filas de Movimientos que genera un cierre de caja ───────────────────────
// Regla de registración:
//  · Si hay datos de Fudo: por cada caja (Efectivo / MP) se registra el ingreso
//    según FUDO, y si lo contado difiere, una fila aparte por el DELTA
//    (Ingreso si sobra, Gasto si falta) con descripción explícita.
//    Así la planilla siempre matchea con Fudo y la diferencia queda a la vista.
//  · Sin datos de Fudo: se registra el delta contado (comportamiento anterior).
//  · Galicia: el ingreso se registra en BRUTO; la comisión del posnet (Bruto − Neto)
//    va como Gasto · Financieros. El neto queda como resultado, discriminado.
// gastosEfectivoSesion / gastosMPSesion: gastos YA registrados en Movimientos con la
// caja abierta (ej: hielo). Reducen el esperado y NO deben generar fila delta duplicada.
// ─── Zona horaria: TODA la app muestra horarios en Buenos Aires, Argentina ──────
const TZ_AR = 'America/Argentina/Buenos_Aires';
function fechaAR(d = new Date()) { return d.toLocaleDateString('es-AR', { timeZone: TZ_AR }); }
function horaAR(d = new Date()) { return d.toLocaleTimeString('es-AR', { timeZone: TZ_AR, hour: '2-digit', minute: '2-digit' }); }
function fechaHoraAR(d = new Date()) { return d.toLocaleString('es-AR', { timeZone: TZ_AR }); }

function buildFilasCierreServicio({ fechaServicio, mesServicio, descripcionServicio, deltaEfectivo, deltaMP, galiciaBruto, impuestos, fudo, gastosEfectivoSesion = 0, gastosMPSesion = 0 }) {
  const ingreso = (medio, monto, desc) => [
    fechaServicio, mesServicio, 'Ingreso', 'Pagado', '', '', '', '',
    'Servicio', 'Ingreso', desc || descripcionServicio,
    medio, monto, '', '', '',
  ];
  const gasto = (medio, monto, desc, categoria = 'Operativos') => [
    fechaServicio, mesServicio, 'Gasto', 'Pagado', '', '', '', '',
    'Servicio', categoria, desc,
    medio, '', '', monto, '',
  ];

  const rows = [];
  const fudoOk = fudo && fudo.encontrado;

  const registrarCaja = (medio, delta, fudoMonto, gastosSesion, etiqueta) => {
    if (fudoOk) {
      if (fudoMonto > 0) rows.push(ingreso(medio, fudoMonto));
      // El esperado del delta contado es: ventas Fudo − gastos pagados de la caja
      // durante el servicio (esos gastos ya tienen su propia fila en Movimientos).
      const diff = Math.round((delta - (fudoMonto - gastosSesion)) * 100) / 100;
      if (diff > 0.005) {
        rows.push(ingreso(medio, diff, `${descripcionServicio} delta ${etiqueta}`));
      } else if (diff < -0.005) {
        rows.push(gasto(medio, Math.abs(diff), `${descripcionServicio} delta ${etiqueta} (faltante)`));
      }
    } else if (delta > 0) {
      // Sin Fudo: delta + gastos de sesión = ingreso bruto del día por esa caja
      rows.push(ingreso(medio, delta + gastosSesion));
    }
  };

  registrarCaja('Efectivo Local', deltaEfectivo, fudoOk ? (Number(fudo.efectivo) || 0) : 0, gastosEfectivoSesion, 'efectivo');
  registrarCaja('Mercado Pago', deltaMP, fudoOk ? (Number(fudo.mercadoPago) || 0) : 0, gastosMPSesion, 'mercado pago');

  // Galicia: ingreso BRUTO + impuestos (comisión del posnet) como gasto financiero
  // → resultado neto discriminado
  if (galiciaBruto > 0) rows.push(ingreso('Galicia', galiciaBruto));
  if (impuestos > 0) {
    rows.push(gasto('Galicia', impuestos, descripcionServicio, 'Financieros'));
  }
  return rows;
}

// ─── Arqueo de Cajas ──────────────────────────────────────────────────────────

// Encabezados canónicos de la hoja "Arqueo de Cajas" (A1:O1). Deben coincidir EXACTO
// con el orden en que se escribe rowArqueo y en que lee /api/arqueo/historial. Se
// reescriben en cada cierre para que la planilla se autocorrija (ver POST cerrar).
const ARQUEO_HEADERS = [
  'Fecha', 'Apertura', 'Cierre', 'Duración',
  'Efectivo Local Inicial', 'Mercado Pago Inicial', 'Galicia Inicial',
  'Efectivo Local Final', 'Mercado Pago Final', 'Galicia Final',
  'Diff Efectivo Local Inicial', 'Diff Mercado Pago Inicial',
  'Notas', 'Ingreso Fudo efectivo', 'Diferencia Efectivo Turno',
];

// GET /api/arqueo/estado — estado actual de la caja
app.get('/api/arqueo/estado', authMiddleware, (req, res) => {
  res.json({ ok: true, data: estadoCaja });
});

// GET /api/arqueo/historial — log de todos los arqueos para troubleshooting.
// Foco EFECTIVO. Diferencia del turno = contado al cerrar − (inicial + Fudo efvo − gastos).
app.get('/api/arqueo/historial', authMiddleware, adminOnly, async (req, res) => {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Arqueo de Cajas!A:O',
    });
    const rows = r.data.values || [];
    const num = v => {
      if (v == null || v === '') return 0;
      const n = parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : 0;
    };
    let start = 0;
    if (rows.length && String(rows[0][0] || '').trim().toLowerCase() === 'fecha') start = 1;
    const arqueos = [];
    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [];
      if (!row[0]) continue;
      arqueos.push({
        rowIndex: i + 1,
        fecha: (row[0] || '').toString().trim(),
        apertura: (row[1] || '').toString().trim(),
        cierre: (row[2] || '').toString().trim(),
        duracion: (row[3] || '').toString().trim(),
        efectivoInicial: num(row[4]),
        mpInicial: num(row[5]),
        efectivoFinal: num(row[7]),
        mpFinal: num(row[8]),
        galiciaFinal: num(row[9]),
        diffAperturaEfectivo: num(row[10]),
        diffAperturaMP: num(row[11]),
        nota: (row[12] || '').toString().trim(),
        ingresoFudoEfectivo: (row[13] != null && row[13] !== '') ? num(row[13]) : null,
        difEfectivoTurno: (row[14] != null && row[14] !== '') ? num(row[14]) : null,
      });
    }
    // Continuidad entre turnos (referencial): efvo abierto vs cerrado el turno previo.
    for (let i = 0; i < arqueos.length; i++) {
      if (i === 0) { arqueos[i].diffContinuidadEfectivo = null; continue; }
      arqueos[i].diffContinuidadEfectivo = Math.round((arqueos[i].efectivoInicial - arqueos[i - 1].efectivoFinal) * 100) / 100;
    }
    arqueos.reverse();
    res.json({ ok: true, data: arqueos });
  } catch (err) {
    console.error('Error /api/arqueo/historial:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/arqueo/saldos-iniciales — lee saldos esperados de la hoja Cajas
// Efectivo Local = F8, Mercado Pago = F2
app.get('/api/arqueo/saldos-iniciales', authMiddleware, async (req, res) => {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Cajas!F2:F8',
    });
    const vals = response.data.values || [];
    // F2 = índice 0, F8 = índice 6
    const mpEsperado       = parseFloat((vals[0]?.[0] || '0').toString().replace(/[^0-9.-]/g, '')) || 0;
    const efectivoEsperado = parseFloat((vals[6]?.[0] || '0').toString().replace(/[^0-9.-]/g, '')) || 0;
    res.json({ ok: true, data: { efectivoEsperado, mpEsperado } });
  } catch (err) {
    console.error('Error leyendo saldos iniciales:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/arqueo/abrir
app.post('/api/arqueo/abrir', authMiddleware, (req, res) => {
  if (estadoCaja.abierta) {
    return res.status(400).json({ ok: false, error: 'La caja ya está abierta' });
  }
  // efectivo/mercadoPago = saldo REAL contado; efectivoEsperado/mpEsperado = saldo del sheet
  const { efectivo, mercadoPago, efectivoEsperado, mpEsperado } = req.body;
  if (efectivo === undefined || mercadoPago === undefined) {
    return res.status(400).json({ ok: false, error: 'Faltan valores de saldo inicial' });
  }
  const diffEfectivo = Number(efectivo) - Number(efectivoEsperado || 0);
  const diffMP       = Number(mercadoPago) - Number(mpEsperado || 0);
  estadoCaja = {
    abierta: true,
    apertura: new Date().toISOString(),
    encargado: req.user.nombre,
    efectivoInicial: Number(efectivo),
    mpInicial: Number(mercadoPago),
    efectivoEsperado: Number(efectivoEsperado || 0),
    mpEsperado: Number(mpEsperado || 0),
    diffEfectivoInicial: diffEfectivo,
    diffMPInicial: diffMP,
    gastosSesion: [],
  };
  guardarEstadoCaja(estadoCaja); // respaldo en planilla, no bloquea la respuesta
  res.json({ ok: true, data: estadoCaja, diffEfectivo, diffMP });
});

// POST /api/arqueo/cerrar
app.post('/api/arqueo/cerrar', authMiddleware, async (req, res) => {
  if (!estadoCaja.abierta) {
    return res.status(400).json({ ok: false, error: 'La caja no está abierta' });
  }
  // Guard contra doble cierre simultáneo
  if (estadoCaja.cerrando) {
    return res.status(400).json({ ok: false, error: 'El cierre ya está en proceso' });
  }
  estadoCaja.cerrando = true;

  // galicia = Total Bruto; galiciaNeto = Total Neto Acreditado
  // impuestos se calcula como Bruto - Neto
  // fudo = ingresos del día según Fudo { encontrado, efectivo, mercadoPago, galicia }
  const { efectivo, mercadoPago, galicia, galiciaNeto, fudo, nota } = req.body;
  if (efectivo === undefined || mercadoPago === undefined || galicia === undefined) {
    estadoCaja.cerrando = false;
    return res.status(400).json({ ok: false, error: 'Faltan valores de saldo final' });
  }

  const cierre = new Date();
  // La fecha del servicio corresponde al día de APERTURA de caja
  const apertura = new Date(estadoCaja.apertura);
  const duracionMs = cierre - apertura;
  const horas = Math.floor(duracionMs / 3_600_000);
  const minutos = Math.floor((duracionMs % 3_600_000) / 60_000);
  const duracionStr = `${horas}h ${minutos}m`;

  // Fecha del servicio = día de APERTURA del TURNO, con el mismo corte que Fudo
  // (16:00 hora AR). Así, aunque la caja se abra pasada la medianoche (ej: se
  // reabrió tras un redeploy), el servicio queda fechado en el día que abrió el
  // local. Ej: caja abierta 12/6 00:30 → servicio del 11/6.
  const [anioServ, mesServNum, diaServ] = fechaServicioDe(apertura.toISOString()).split('-').map(Number);
  const dd = String(diaServ).padStart(2, '0');
  const mm = String(mesServNum).padStart(2, '0');
  const yy = String(anioServ).slice(-2);
  const fechaServicio = `${dd}/${mm}/${yy}`;
  const mesesNombres = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const mesServicio = mesesNombres[mesServNum - 1];
  const descripcionServicio = `Servicio ${dd}/${mm}`;

  // Fechas para hoja Arqueo de Cajas — SIEMPRE en huso horario de Buenos Aires.
  const fechaStr = fechaAR(apertura);
  const aperturaStr = horaAR(apertura);
  const cierreStr = horaAR(cierre);

  // Impuestos = diferencia entre Bruto y Neto Acreditado
  const galiciaBruto = Number(galicia) || 0;
  const galiciaNetoVal = Number(galiciaNeto) || 0;
  const impuestos = galiciaBruto > galiciaNetoVal ? galiciaBruto - galiciaNetoVal : 0;

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. Escribir en Arqueo de Cajas
    // Columnas (este es el orden REAL en que se escribe y se lee — la fila de
    // encabezados de la planilla debe respetar exactamente este orden):
    //   A: Fecha                     — día del servicio (apertura), hora AR
    //   B: Apertura                  — hora de apertura de caja
    //   C: Cierre                    — hora de cierre
    //   D: Duración                  — "Xh Ym"
    //   E: Efectivo Local Inicial       — efectivo contado al abrir
    //   F: Mercado Pago Inicial         — saldo MP al abrir
    //   G: Galicia Inicial              — ya no se usa, siempre vacío
    //   H: Efectivo Local Final         — efectivo contado al cerrar
    //   I: Mercado Pago Final           — saldo MP al cerrar
    //   J: Galicia Final                — total BRUTO de tarjetas (Galicia)
    //   K: Diff Efectivo Local Inicial  — efectivo contado al abrir − esperado (hoja Cajas)
    //   L: Diff Mercado Pago Inicial    — MP contado al abrir − esperado (hoja Cajas)
    //   M: Notas                        — nota de cierre (opcional)
    //   N: Ingreso Fudo efectivo        — ventas en efectivo del turno según Fudo
    //   O: Diferencia Efectivo Turno    — H − (E + N − gastos efvo del turno):
    //                                  sobrante (+) o faltante (−) de caja del turno
    // Diferencia REAL del turno (efectivo): lo contado al cerrar vs lo esperado según
    // ventas de Fudo. Esperado = inicial + Fudo efectivo − gastos en efectivo del turno.
    const fudoEfectivo = (fudo && fudo.encontrado) ? (Number(fudo.efectivo) || 0) : 0;
    const _gastosEfvoTurno = (estadoCaja.gastosSesion || []).filter(g => g.bucket === 'efectivo').reduce((a, g) => a + g.monto, 0);
    const _esperadoEfvo = (estadoCaja.efectivoInicial || 0) + fudoEfectivo - _gastosEfvoTurno;
    const difEfectivoTurno = Math.round((Number(efectivo) - _esperadoEfvo) * 100) / 100;

    const rowArqueo = [
      fechaStr,
      aperturaStr,
      cierreStr,
      duracionStr,
      estadoCaja.efectivoInicial,
      estadoCaja.mpInicial,
      '',                                    // Galicia inicial ya no se usa
      Number(efectivo),
      Number(mercadoPago),
      galiciaBruto,
      estadoCaja.diffEfectivoInicial || 0,   // K: Diff Efectivo Local Inicial
      estadoCaja.diffMPInicial || 0,         // L: Diff Mercado Pago Inicial
      (nota || '').toString().trim(),        // M: Nota de cierre (cuando no cierra)
      fudoEfectivo,                          // N: Ingreso Fudo (efectivo) del turno
      difEfectivoTurno,                      // O: Diferencia de efectivo del turno
    ];
    // Escribimos en una fila absoluta calculada a partir de la columna A, NO con
    // values.append. append detecta automáticamente una "tabla" y agrega la fila
    // alineada al borde izquierdo de esa tabla: si queda cualquier bloque de datos
    // suelto a la derecha (p. ej. una fila que alguna vez cayó corrida), append se
    // "engancha" a ese bloque y sigue escribiendo en columnas equivocadas (N en
    // adelante) fila tras fila. Con update sobre A{n}:O{n} la fila siempre cae en
    // las columnas correctas, sin importar qué haya suelto a la derecha.
    const colA = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Arqueo de Cajas!A:A',
    });
    const proxFila = (colA.data.values || []).length + 1;
    // Reescribimos SIEMPRE la fila de encabezados (A1:O1) junto con el dato. Así la
    // planilla se autocorrige: si los títulos quedaron desordenados o falta alguno,
    // el próximo cierre los deja en el orden exacto en que el código escribe/lee.
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Arqueo de Cajas!A1:O1', values: [ARQUEO_HEADERS] },
          { range: `Arqueo de Cajas!A${proxFila}:O${proxFila}`, values: [rowArqueo] },
        ],
      },
    });

    // 1b. Actualizar Saldo Real en hoja Cajas (G2=Mercado Pago, G8=Efectivo Local)
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Cajas!G2', values: [[Number(mercadoPago)]] },
          { range: 'Cajas!G8', values: [[Number(efectivo)]] },
        ],
      },
    });

    // 2. Escribir en Movimientos — columnas A:P
    // A:Fecha, B:Mes, C:Tipo Movimiento, D:Estado, E:Vencimiento, F:Cuotas,
    // G:Extraodinario, H:ID Compra, I:Proveedor, J:Categoría, K:Descripción,
    // L:Medio de Pago, M:Monto Entrada ARS, N:Monto Entrada USD, O:Monto Salida ARS, P:Monto Salida USD
    const deltaEfectivo = Number(efectivo) - estadoCaja.efectivoInicial;
    const deltaMP       = Number(mercadoPago) - estadoCaja.mpInicial;
    // Gastos registrados durante la sesión (server-side, no se confía en el cliente)
    const gastosSesion = estadoCaja.gastosSesion || [];
    const gastosEfectivoSesion = gastosSesion.filter(g => g.bucket === 'efectivo').reduce((s, g) => s + g.monto, 0);
    const gastosMPSesion = gastosSesion.filter(g => g.bucket === 'mp').reduce((s, g) => s + g.monto, 0);
    const rowsMovimientos = buildFilasCierreServicio({
      fechaServicio, mesServicio, descripcionServicio,
      deltaEfectivo, deltaMP,
      galiciaBruto, impuestos,
      fudo,
      gastosEfectivoSesion, gastosMPSesion,
    });
    if (rowsMovimientos.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Movimientos!A:P',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsMovimientos },
      });
    }

    clearCache();
  } catch (err) {
    estadoCaja.cerrando = false;  // liberar lock en caso de error
    console.error('Error guardando arqueo:', err.message);
    return res.status(500).json({ ok: false, error: 'Error al guardar en la planilla: ' + err.message });
  }

  const resumen = {
    fecha: fechaStr,
    apertura: aperturaStr,
    cierre: cierreStr,
    duracion: duracionStr,
    encargado: estadoCaja.encargado,
    efectivoInicial: estadoCaja.efectivoInicial,
    mpInicial: estadoCaja.mpInicial,
    efectivoFinal: Number(efectivo),
    mpFinal: Number(mercadoPago),
    galiciaBruto,
    galiciaNeto: galiciaNetoVal,
    impuestosGalicia: impuestos,
    difEfectivo: Number(efectivo) - estadoCaja.efectivoInicial,
    difMP: Number(mercadoPago) - estadoCaja.mpInicial,
  };

  // Resetear estado
  estadoCaja = { abierta: false, apertura: null, encargado: null, efectivoInicial: null, mpInicial: null, gastosSesion: [] };
  guardarEstadoCaja(estadoCaja); // respaldo en planilla, no bloquea la respuesta

  res.json({ ok: true, data: resumen });
});

// POST /api/gastos-rapidos — gasto pagado en el momento (ej: hielo al empezar
// el servicio). Accesible para el encargado. Si la caja está ABIERTA y el medio
// es una caja arqueada (Efectivo Local / Mercado Pago), se anota en la sesión
// para descontarlo del esperado en el cierre.
app.post('/api/gastos-rapidos', authMiddleware, async (req, res) => {
  try {
    const { fecha, mes, proveedor, categoria, monto, descripcion, estado } = req.body;
    const medioPago = normalizarMedio(req.body.medioPago);
    if (!fecha || !proveedor || !monto) {
      return res.status(400).json({ ok: false, error: 'Fecha, proveedor y monto son obligatorios' });
    }
    const estadoRow = (estado || 'Pagado') === 'A pagar' ? 'A pagar' : 'Pagado';
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const row = [fecha, mes || '', 'Gasto', estadoRow, '', '', '', '', proveedor, categoria || 'Insumos', descripcion || '', medioPago || '', '', '', Number(monto), ''];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:P',
      valueInputOption: 'USER_ENTERED', requestBody: { values: [row] },
    });
    clearCache();

    // Si la caja está abierta y es un gasto YA PAGADO desde una caja arqueada,
    // anotarlo para el cierre (el esperado descuenta este efectivo que salió).
    let registradoEnSesion = false;
    const medioLower = (medioPago || '').toLowerCase();
    if (estadoCaja.abierta && estadoRow === 'Pagado') {
      const bucket = medioLower.includes('efectivo local') ? 'efectivo'
        : medioLower.includes('mercado pago') ? 'mp' : null;
      if (bucket) {
        estadoCaja.gastosSesion = estadoCaja.gastosSesion || [];
        estadoCaja.gastosSesion.push({
          bucket, monto: Number(monto),
          descripcion: descripcion || proveedor,
          ts: new Date().toISOString(),
          usuario: req.user.nombre,
        });
        registradoEnSesion = true;
        guardarEstadoCaja(estadoCaja); // respaldo en planilla, no bloquea la respuesta
      }
    }
    res.json({ ok: true, message: 'Gasto registrado', registradoEnSesion });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/arqueo/fudo-hoy — ventas del día de servicio en curso según Fudo,
// agrupadas en Efectivo / Mercado Pago / Otros. Para el control de cierre de caja.
app.get('/api/arqueo/fudo-hoy', authMiddleware, async (req, res) => {
  try {
    clearFudoCache(); // datos frescos: es el momento de la verdad del arqueo
    const fecha = fechaServicioHoy();
    const det = await getServicioDetalle(fecha);
    if (!det || !det.encontrado) {
      return res.json({ ok: true, data: { fecha, encontrado: false, efectivo: 0, mercadoPago: 0, galicia: 0, otros: 0, total: 0, mediosPago: {} } });
    }
    // Mapeo de medios de pago de Fudo a cajas internas:
    //   Galicia = QR + Tarjeta Débito + Tarjeta Crédito (los 3 liquidan vía Nave en Galicia)
    //   Mercado Pago = transferencias/dinero en cuenta MP · Efectivo = efectivo
    let efectivo = 0, mercadoPago = 0, galicia = 0, otros = 0;
    for (const [nombre, monto] of Object.entries(det.mediosPago || {})) {
      const n = nombre.toLowerCase();
      if (n.includes('efectivo')) efectivo += monto;
      else if (n.includes('qr') || n.includes('tarj') || n.includes('credito') || n.includes('crédito') || n.includes('debito') || n.includes('débito') || n.includes('visa') || n.includes('master')) galicia += monto;
      else if (n.includes('mercado') || n === 'mp') mercadoPago += monto;
      else otros += monto;
    }
    res.json({ ok: true, data: { fecha, encontrado: true, efectivo, mercadoPago, galicia, otros, total: det.total, mediosPago: det.mediosPago } });
  } catch (err) {
    console.error('Error /api/arqueo/fudo-hoy:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Healthcheck público (para Railway) ──────────────────────────────────────
// ─── Gestión de Vinos / bebida con alcohol: inventario + rotación ──────────────
app.get('/api/vinos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { desde, hasta, soloVino } = req.query;
    const data = await vinos.analizarVinos({ desde, hasta, soloVino: soloVino === '1' || soloVino === 'true' });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/vinos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DIAGNÓSTICO temporal: descubrir si Fudo expone el stock. Borrar tras usar.
app.get('/api/fudo/probe-stock', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await probeStock() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, status: 'ok' }));

// ─── Filtro de fecha ──────────────────────────────────────────────────────────
function parseFiltro(query) {
  const { mes, desde, hasta } = query;
  if (mes) return { mes };
  if (desde && hasta) {
    return { fechaDesde: new Date(desde), fechaHasta: new Date(hasta + 'T23:59:59') };
  }
  return {};
}

// ─── Dashboard endpoints (solo admin) ────────────────────────────────────────
app.get('/api/meses', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getMeses() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/categorias', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getCategorias() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/resumen', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getResumenMensual(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Cierres mensuales (ARS + USD) ────────────────────────────────────────────
// Histórico de cómo cerró cada mes en pesos y en dólares (TC fijo del período).

app.get('/api/cierres', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await cierres.listCierres() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/cierres/cerrar', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, tcUsd, nota, recuperoARS, extraordinariaARS } = req.body || {};
    if (!mes) return res.status(400).json({ ok: false, error: 'Falta el mes' });
    const resumen = await getResumenMensual({ mes });
    const m = (resumen || [])[0];
    if (!m) return res.status(404).json({ ok: false, error: 'No hay datos para el mes ' + mes });
    const data = await cierres.cerrarMes({
      mes,
      tcUsd: Number(tcUsd) || undefined,
      ingresosARS: m.ingresos.total,
      gastosARS: m.gastos.total,
      resultadoARS: m.resultadoNeto,
      nota,
      recuperoARS: Number(recuperoARS) || 0,
      extraordinariaARS: Number(extraordinariaARS) || 0,
    });
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Ajusta (o asigna retroactivamente) el reparto recupero/extraordinaria de un cierre.
app.put('/api/cierres/recupero', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, recuperoARS, extraordinariaARS } = req.body || {};
    if (!mes) return res.status(400).json({ ok: false, error: 'Falta el mes' });
    const data = await cierres.ajustarRecupero({
      mes,
      recuperoARS: recuperoARS != null ? Number(recuperoARS) : undefined,
      extraordinariaARS: extraordinariaARS != null ? Number(extraordinariaARS) : undefined,
    });
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.put('/api/cierres/tc', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, tcUsd } = req.body || {};
    const data = await cierres.ajustarTC({ mes, tcUsd: Number(tcUsd) });
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cierres/tc-default', authMiddleware, adminOnly, (req, res) => {
  res.json({ ok: true, data: { tcDefault: cierres.TC_DEFAULT } });
});

// Dólar blue en vivo (dolarapi) para prellenar el TC y valuar la brecha de ROI.
app.get('/api/tc-online', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await tc.getDolarBlue() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Progreso de recupero de la inversión (USD 60k por defecto).
app.get('/api/roi', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await roi.resumenRecupero() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-diaria', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getActividadPorDia(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-semana', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getActividadPorDiaSemana(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cajas', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await getCajas() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cambios', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getMovimientosCambio(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/movimientos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { tipo, categoria, estado } = req.query;
    let movimientos = await getMovimientos();
    if (!req.query.todos) movimientos = movimientos.filter(m => !m.esCambio && !m.esFondeo);
    const filtro = parseFiltro(req.query);
    if (filtro.mes) movimientos = movimientos.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movimientos = movimientos.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    if (tipo) movimientos = movimientos.filter(m => m.tipo === tipo);
    if (categoria) movimientos = movimientos.filter(m => m.categoria === categoria);
    if (estado) movimientos = movimientos.filter(m => m.estado.toLowerCase() === estado.toLowerCase());
    const data = movimientos.map(m => ({ ...m, fecha: m.fecha.toISOString().split('T')[0] }));
    res.json({ ok: true, data, total: data.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/refresh', authMiddleware, adminOnly, (req, res) => {
  clearCache();
  res.json({ ok: true, message: 'Cache limpiado.' });
});

// ─── Pagos (solo admin) ───────────────────────────────────────────────────────
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
  const vencISO = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return { urgencia, diasHastaVenc: dias, vencDate: vencISO };
}

app.get('/api/pagos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sort = 'vencimiento', medioPago, q } = req.query;
    const todos = await getMovimientos();
    const comprasCuotas = await getComprasEnCuotas();
    // Las filas MADRE de compras en cuotas no son pagables: se pagan sus cuotas
    let pagos = todos.filter(m => m.tipo === 'Gasto' && !m.pagado && !m.esCambio && !m.esFondeo && !m.esCompraEnCuotas);
    // Enriquecer cuotas con info de la compra (total, restante, medio de pago heredado)
    pagos = pagos.map(p => {
      if (!p.esCuota || !p.cuotaId || !comprasCuotas[p.cuotaId]) return p;
      const info = comprasCuotas[p.cuotaId];
      return {
        ...p,
        // Heredar medio de pago de la compra para agrupar (ej: tarjeta Galicia)
        medioPago: p.medioPago || info.medioPago || '',
        cuotaLabel: `${p.cuotaNum}/${p.cuotasTotal || info.cuotasTotal || '?'}`,
        compraTotal: info.totalCompra,
        compraPagado: info.pagadoAcum,
        compraRestante: info.restante,
        compraCuotasPagadas: info.cuotasPagadas,
        compraCuotasTotal: info.cuotasTotal,
      };
    });
    if (medioPago) pagos = pagos.filter(p => (p.medioPago || '').toLowerCase().includes(medioPago.toLowerCase()));
    if (q) pagos = pagos.filter(p => (p.proveedor || '').toLowerCase().includes(q.toLowerCase()));
    pagos = pagos.map(p => ({ ...p, fecha: p.fecha.toISOString().split('T')[0], ...calcUrgencia(p.vencimiento) }));
    const ordenU = { vencido: 0, hoy: 1, urgente: 2, proximo: 3, ok: 4, 'sin-fecha': 5 };
    if (sort === 'vencimiento') pagos.sort((a, b) => (ordenU[a.urgencia]||5) - (ordenU[b.urgencia]||5) || (a.diasHastaVenc||999) - (b.diasHastaVenc||999));
    else if (sort === 'monto') pagos.sort((a, b) => (b.salidaTotal||0) - (a.salidaTotal||0));
    else if (sort === 'proveedor') pagos.sort((a, b) => (a.proveedor||'').localeCompare(b.proveedor||''));
    else if (sort === 'formapago') pagos.sort((a, b) => (a.medioPago||'').localeCompare(b.medioPago||''));
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const finSemana = new Date(hoy); finSemana.setDate(hoy.getDate() + 7);
    const summary = {
      total: pagos.length,
      totalARS: pagos.reduce((s, p) => s + (p.salidaARS||0), 0),
      totalUSD: pagos.reduce((s, p) => s + (p.salidaUSD||0), 0),
      vencidos: pagos.filter(p => p.urgencia === 'vencido').length,
      estaSemanaCant: pagos.filter(p => p.vencDate && new Date(p.vencDate+'T12:00:00') <= finSemana && p.urgencia !== 'vencido').length,
      estaSemanaARS: pagos.filter(p => p.vencDate && new Date(p.vencDate+'T12:00:00') <= finSemana && p.urgencia !== 'vencido').reduce((s,p) => s+(p.salidaARS||0), 0),
    };
    res.json({ ok: true, data: pagos, summary });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Suma meses a una fecha dd/mm/yyyy manteniendo el día (con clamp a fin de mes)
function addMonthsDDMM(fechaStr, meses) {
  const parts = (fechaStr || '').split('/').map(Number);
  if (parts.length !== 3) return fechaStr;
  let [d, m, y] = parts;
  if (y < 100) y += 2000;
  const target = new Date(y, m - 1 + meses, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${String(day).padStart(2,'0')}/${String(target.getMonth()+1).padStart(2,'0')}/${target.getFullYear()}`;
}

const MESES_NOMBRES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function mesDeFecha(fechaStr) {
  const parts = (fechaStr || '').split('/').map(Number);
  return parts.length === 3 ? MESES_NOMBRES[parts[1] - 1] || '' : '';
}

// Un Echeq sale de la cuenta Galicia: en Movimientos se registra como Galicia.
function normalizarMedio(medio) {
  return (medio || '').trim().toLowerCase() === 'echeq' ? 'Galicia' : (medio || '');
}

// Creación de compras/pagos: accesible también para el encargado (botón "Nueva compra"),
// a diferencia del listado (GET) y el marcado de pagado, que permanecen solo admin.
app.post('/api/pagos', authMiddleware, async (req, res) => {
  try {
    const { fecha, mes, proveedor, categoria, salidaARS, vencimiento, descripcion, cuotas, estado } = req.body;
    const medioPago = normalizarMedio(req.body.medioPago);
    const estadoRow = estado === 'Pagado' ? 'Pagado' : 'A pagar';
    if (!fecha || !proveedor) return res.status(400).json({ ok: false, error: 'Fecha y proveedor son obligatorios' });
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const nCuotas = parseInt(cuotas) || 1;
    let values;

    if (nCuotas > 1) {
      // Compra en cuotas: fila madre (importe total, sin medio de pago → no toca cajas,
      // computa completa en el estado de resultados del mes de compra) + una fila por cuota.
      if (!vencimiento) return res.status(400).json({ ok: false, error: 'Para cuotas indicá el vencimiento de la primera cuota' });
      const total = Number(salidaARS) || 0;
      const montoCuota = Math.round(total / nCuotas);  // cuotas enteras (ARS)
      const cuotaId = `${proveedor}-${fecha}`.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
      const descBase = descripcion || proveedor;
      // Fila madre: estado "En cuotas", medio de pago vacío, col F = total de cuotas, col H = ID
      values = [[fecha, mes||'', 'Gasto', 'En cuotas', '', String(nCuotas), '', cuotaId, proveedor, categoria||'', `${descBase} — Total en ${nCuotas} cuotas`, '', '', '', total, '']];
      for (let i = 1; i <= nCuotas; i++) {
        const venc = addMonthsDDMM(vencimiento, i - 1);
        // Ajuste última cuota para que la suma cierre exacta con el total
        const monto = i === nCuotas ? total - montoCuota * (nCuotas - 1) : montoCuota;
        // Medio de pago vacío hasta que se pague (las fórmulas de Cajas suman por medio):
        // al marcarla Pagado se completa el medio, la fecha real y el mes.
        values.push([venc, mesDeFecha(venc), 'Gasto', 'A pagar', venc, `${i}/${nCuotas}`, '', cuotaId, proveedor, categoria||'', `${descBase} — Cuota ${i}/${nCuotas}${medioPago ? ' ('+medioPago+')' : ''}`, '', '', '', monto, '']);
      }
    } else {
      // Pagado: sin vencimiento (ya salió de caja) · A pagar: con vencimiento
      values = [[fecha, mes||'', 'Gasto', estadoRow, estadoRow === 'Pagado' ? '' : (vencimiento||''), '', '', '', proveedor, categoria||'', descripcion||'', medioPago||'', '', '', salidaARS||'', '']];
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:P',
      valueInputOption: 'USER_ENTERED', requestBody: { values },
    });
    clearCache();
    res.json({ ok: true, message: nCuotas > 1 ? `Compra en ${nCuotas} cuotas registrada (${values.length} filas)` : 'Compra registrada correctamente' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Lee la hoja Proveedores → { nombreLower: { nombre, formaPago, datosParaPagar, comentarios, plazoDias } }
async function leerProveedoresSheet() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Proveedores!A:H' });
  const rows = response.data.values || [];
  if (rows.length < 2) return {};
  let headerIdx = rows.findIndex(r => r && (r[0]||'').toString().trim().toLowerCase() === 'proveedor');
  if (headerIdx === -1) headerIdx = 0;
  const header = rows[headerIdx].map(h => (h||'').toString().trim().toLowerCase());
  const idxNombre = header.indexOf('proveedor');
  const idxFormaPago = header.findIndex(h => h.includes('forma') || h.includes('pago'));
  const idxDatos = header.findIndex(h => h.includes('datos') || h.includes('banco') || h.includes('cbu') || h.includes('alias'));
  const idxComentarios = header.findIndex(h => h.includes('comentario') || h.includes('nota'));
  const idxPlazo = header.findIndex(h => h.includes('plazo'));
  const proveedores = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[idxNombre]) continue;
    const nombre = (row[idxNombre]||'').trim();
    if (!nombre) continue;
    const plazoRaw = idxPlazo >= 0 ? parseInt(String(row[idxPlazo] || '').replace(/[^0-9]/g, '')) : NaN;
    proveedores[nombre.toLowerCase()] = {
      nombre, formaPago: idxFormaPago >= 0 ? (row[idxFormaPago]||'') : '',
      datosParaPagar: idxDatos >= 0 ? (row[idxDatos]||'') : '',
      comentarios: idxComentarios >= 0 ? (row[idxComentarios]||'') : '',
      plazoDias: Number.isFinite(plazoRaw) ? plazoRaw : null,
    };
  }
  return proveedores;
}

// POST /api/pagos/pagar — marca un registro "A pagar" como Pagado MODIFICANDO la
// fila existente (no agrega línea): Estado (col D) → Pagado, y Medio de pago (col L)
// si vino uno. La fecha de registración original se conserva.
app.post('/api/pagos/pagar', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rowIndex, proveedor, medioPago } = req.body;
    const idx = parseInt(rowIndex);
    if (!idx || idx < 2) return res.status(400).json({ ok: false, error: 'Falta el registro a pagar' });

    // Releer la fila para validar que sigue siendo la que el usuario eligió
    const movs = await getMovimientos();
    const m = movs.find(x => x.rowIndex === idx);
    if (!m) return res.status(404).json({ ok: false, error: 'No se encontró el registro. Refrescá la página e intentá de nuevo.' });
    if (m.pagado) return res.status(400).json({ ok: false, error: `"${m.proveedor}" ya figura como Pagado.` });
    if (proveedor && m.proveedor && proveedor.trim().toLowerCase() !== m.proveedor.toLowerCase()) {
      return res.status(409).json({ ok: false, error: 'La planilla cambió desde que abriste el modal. Refrescá e intentá de nuevo.' });
    }

    const medio = normalizarMedio(medioPago);
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const data = [{ range: `Movimientos!D${idx}`, values: [['Pagado']] }];
    if (medio) data.push({ range: `Movimientos!L${idx}`, values: [[medio]] });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
    clearCache();

    // Si la caja esta ABIERTA, este dinero YA salio de una caja arqueada al pagar
    // la cuenta pendiente. Se anota en la sesion para descontarlo del esperado en el
    // cierre (igual que /api/gastos-rapidos). Asi NO aparece como faltante en el arqueo.
    // Caso real: pagar a un proveedor "A pagar" con MP estando la caja abierta.
    let registradoEnSesion = false;
    const medioEfectivoPago = (medio || m.medioPago || '').toLowerCase();
    const montoSalida = Number(m.salidaTotal || m.salidaARS || 0);
    if (estadoCaja.abierta && montoSalida > 0) {
      const bucket = medioEfectivoPago.includes('efectivo local') ? 'efectivo'
        : medioEfectivoPago.includes('mercado pago') ? 'mp' : null;
      if (bucket) {
        estadoCaja.gastosSesion = estadoCaja.gastosSesion || [];
        estadoCaja.gastosSesion.push({
          bucket, monto: montoSalida,
          descripcion: `Pago pendiente: ${m.proveedor}`,
          ts: new Date().toISOString(),
          usuario: req.user.nombre,
        });
        registradoEnSesion = true;
      }
    }
    res.json({ ok: true, message: `${m.proveedor} marcado como Pagado`, proveedor: m.proveedor, monto: m.salidaARS, medio, registradoEnSesion });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Sin adminOnly: el formulario "Nueva compra" del encargado necesita esta
// referencia (plazo, forma de pago) para autocompletar, aunque no vea el listado de pagos.
app.get('/api/proveedores', authMiddleware, async (req, res) => {
  try {
    res.json({ ok: true, data: await leerProveedoresSheet() });
  } catch (err) { res.json({ ok: true, data: {} }); }
});

// Sugerencias para el alta de pagos: proveedores ya usados en Movimientos
// (con su última categoría y medio de pago) + los de la hoja Proveedores.
// Sin adminOnly por el mismo motivo que /api/proveedores arriba.
app.get('/api/proveedores-sugerencias', authMiddleware, async (req, res) => {
  try {
    const movs = await getMovimientos();
    const map = {};
    for (const m of movs) {
      if (m.tipo !== 'Gasto' || !m.proveedor || m.esCambio || m.esFondeo || m.esCuota || m.esCompraEnCuotas) continue;
      const key = m.proveedor.toLowerCase();
      const e = map[key] = map[key] || { nombre: m.proveedor, categoria: '', medioPago: '', plazoDias: null, usos: 0, _fc: null, _fm: null };
      e.usos++;
      if (m.categoria && (!e._fc || m.fecha > e._fc)) { e.categoria = m.categoria; e._fc = m.fecha; }
      if (m.medioPago && (!e._fm || m.fecha > e._fm)) { e.medioPago = m.medioPago; e._fm = m.fecha; }
    }
    let provSheet = {};
    try { provSheet = await leerProveedoresSheet(); } catch (e) {}
    for (const [key, p] of Object.entries(provSheet)) {
      const e = map[key] = map[key] || { nombre: p.nombre, categoria: '', medioPago: '', plazoDias: null, usos: 0 };
      if (!e.medioPago && p.formaPago) e.medioPago = p.formaPago;
      if (p.plazoDias != null) e.plazoDias = p.plazoDias;
    }
    const data = Object.values(map)
      .map(({ _fc, _fm, ...r }) => r)
      .sort((a, b) => b.usos - a.usos || a.nombre.localeCompare(b.nombre));
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Servicios (Fudo) — solo admin ──────────────────────────────────────────────
// Resumen de servicios por día (pax, total, comida vs bebida)
app.get('/api/servicios', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const data = await getServicios({ desde, hasta });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/servicios:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Detalle de un servicio (un día): productos por categoría + medios de pago
app.get('/api/servicios/:fecha', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await getServicioDetalle(req.params.fecha);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/servicios/:fecha:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Refrescar caché de Fudo manualmente
app.post('/api/servicios/refresh', authMiddleware, adminOnly, (req, res) => {
  clearFudoCache();
  res.json({ ok: true, message: 'Caché de Fudo limpiado.' });
});

// Diagnóstico: venta por venta de un día (total vs pagado, exclusiones, propinas)
app.get('/api/servicios/debug/:fecha', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await getServicioDebug(req.params.fecha);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/servicios/debug:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Rehacer TODOS los snapshots guardados con el cálculo actual (tras corregir la fórmula)
app.post('/api/servicios/resnapshot-todos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await resnapshotTodos();
    res.json({ ok: true, message: `Snapshots regenerados: ${data.regenerados}`, data });
  } catch (err) {
    console.error('Error /api/servicios/resnapshot-todos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Rehacer el snapshot guardado de un día (si se corrigió algo en Fudo a posteriori)
app.post('/api/servicios/resnapshot/:fecha', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await resnapshotDia(req.params.fecha);
    res.json({ ok: true, message: `Snapshot de ${req.params.fecha} actualizado`, data });
  } catch (err) {
    console.error('Error /api/servicios/resnapshot:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Proyecciones (solo admin) ────────────────────────────────────────────────
// Variables personalizadas en hoja "Proyeccion Variables":
// A ID · B Nombre · C Tipo (gasto/ingreso) · D Monto · E Meses (csv) · F Repite · G Creado
const VAR_SHEET = 'Proyeccion Variables';

async function ensureVarSheet(sheets) {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: VAR_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${VAR_SHEET}!A1:G1`, valueInputOption: 'RAW',
      requestBody: { values: [['ID', 'Nombre', 'Tipo', 'Monto', 'Meses', 'Repite', 'Creado']] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

async function leerVariables() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  let rows = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${VAR_SHEET}!A:G` });
    rows = res.data.values || [];
  } catch (e) {
    await ensureVarSheet(sheets);
    return [];
  }
  const vars = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    vars.push({
      id: r[0],
      nombre: r[1] || 'Sin nombre',
      tipo: (r[2] || 'gasto').toLowerCase() === 'ingreso' ? 'ingreso' : 'gasto',
      monto: parseFloat(String(r[3] || '0').replace(/[^0-9.-]/g, '')) || 0,
      meses: (r[4] || '').split(',').map(s => s.trim()).filter(Boolean),
      repite: String(r[5] || '').toUpperCase() === 'TRUE',
      creado: r[6] || '',
      rowIndex: i + 1,
    });
  }
  return vars;
}

// Proyección completa (baselines + variables + aguinaldos)
app.get('/api/proyecciones', authMiddleware, adminOnly, async (req, res) => {
  try {
    const horizonte = Math.min(parseInt(req.query.meses) || 3, 24);
    const [movimientos, resumen, variables, planData] = await Promise.all([
      getMovimientos(), getResumenMensual({}), leerVariables(), plan.listPlan(),
    ]);
    // Incluir el Plan de Inversiones en la proyección: query param si viene, si no
    // el default guardado en la config del plan.
    const incluirPlan = req.query.incluirPlan != null
      ? (req.query.incluirPlan === '1' || req.query.incluirPlan === 'true')
      : !!planData.config.incluirEnProyeccion;
    const planGastos = incluirPlan ? await plan.planGastosProgramados() : [];
    const data = proyectar({ movimientos, resumen, variables, planGastos, horizonte });
    res.json({ ok: true, data: { ...data, variables, incluirPlan } });
  } catch (err) {
    console.error('Error /api/proyecciones:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Alta de variable personalizada
app.post('/api/proyecciones/variables', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nombre, tipo, monto, meses, repite } = req.body;
    if (!nombre || !monto) return res.status(400).json({ ok: false, error: 'Nombre y monto son obligatorios' });
    if (!Array.isArray(meses) || !meses.length) return res.status(400).json({ ok: false, error: 'Elegí al menos un mes' });
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureVarSheet(sheets);
    const id = `v${Date.now()}`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${VAR_SHEET}!A:G`, valueInputOption: 'RAW',
      requestBody: { values: [[id, nombre, tipo === 'ingreso' ? 'ingreso' : 'gasto', Number(monto), meses.join(','), repite ? 'TRUE' : 'FALSE', new Date().toISOString()]] },
    });
    res.json({ ok: true, id, message: 'Variable agregada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Baja de variable personalizada
app.delete('/api/proyecciones/variables/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const vars = await leerVariables();
    const v = vars.find(x => x.id === req.params.id);
    if (!v) return res.status(404).json({ ok: false, error: 'Variable no encontrada' });
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
    const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === VAR_SHEET);
    if (!sheet) return res.status(500).json({ ok: false, error: 'No existe la hoja de variables' });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ deleteDimension: { range: {
        sheetId: sheet.properties.sheetId, dimension: 'ROWS',
        startIndex: v.rowIndex - 1, endIndex: v.rowIndex,
      } } }] },
    });
    res.json({ ok: true, message: 'Variable eliminada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Plan de Inversiones — gastos extraordinarios planificados (solo admin) ───
app.get('/api/plan', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await plan.listPlan() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Gastos reales de Movimientos candidatos a vincularse con un ítem del plan.
// Se excluyen las filas de cuota (n/m): la fila madre ya lleva el importe total.
app.get('/api/plan/movimientos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const movs = await getMovimientos();
    const out = movs
      .filter(m => m.tipo === 'Gasto' && !m.esCuota && m.salidaTotal > 0)
      .map(m => ({
        fila: m.rowIndex,
        fecha: m.fechaStr,
        ts: m.fecha ? m.fecha.getTime() : 0,
        mesISO: m.fecha ? `${m.fecha.getFullYear()}-${String(m.fecha.getMonth() + 1).padStart(2, '0')}` : '',
        proveedor: m.proveedor,
        descripcion: m.descripcion,
        categoria: m.categoria,
        medioPago: m.medioPago,
        monto: Math.round(m.salidaTotal),
        esExtraordinario: m.esExtraordinario,
        esCompraEnCuotas: m.esCompraEnCuotas,
      }))
      .sort((a, b) => b.ts - a.ts || b.fila - a.fila);
    res.json({ ok: true, data: out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Resuelve el vínculo con Movimientos de un ítem del plan.
// fila > 0  → snapshot del gasto real (importe, referencia legible) + estado hecho
//             y mes objetivo = mes real del gasto.
// fila == 0 → desvincula (el ítem vuelve a valer por su costo estimado).
async function resolverVinculoPlan(body) {
  if (body.movimientoFila === undefined) return body;
  const fila = Math.round(Number(body.movimientoFila)) || 0;
  if (!fila) return { ...body, movimientoFila: 0, costoReal: 0, movimientoRef: '' };
  // Un gasto real no puede respaldar dos ítems del plan: sería contarlo dos veces.
  const { items } = await plan.listPlan();
  const ocupado = items.find(i => i.movimientoFila === fila && i.id !== body.id);
  if (ocupado) throw new Error(`La fila ${fila} ya está vinculada al ítem "${ocupado.nombre}"`);
  const movs = await getMovimientos();
  const m = movs.find(x => x.rowIndex === fila);
  if (!m) throw new Error(`La fila ${fila} de Movimientos no existe o no es un movimiento válido`);
  if (m.tipo !== 'Gasto' || m.salidaTotal <= 0) {
    throw new Error(`La fila ${fila} no es un gasto (tipo "${m.tipo || '—'}", sin salida)`);
  }
  const mesISO = m.fecha ? `${m.fecha.getFullYear()}-${String(m.fecha.getMonth() + 1).padStart(2, '0')}` : '';
  return {
    ...body,
    movimientoFila: fila,
    costoReal: Math.round(m.salidaTotal),
    movimientoRef: [m.fechaStr, m.proveedor, m.descripcion].filter(Boolean).join(' · ').slice(0, 180),
    estado: 'hecho',                                   // vinculado = ejecutado
    mesObjetivo: mesISO || body.mesObjetivo || '',     // el mes real manda
  };
}

// Alta o edición (upsert por id): también se usa para agendar mes, repriorizar,
// marcar hecho y vincular/desvincular con una fila real de Movimientos.
app.post('/api/plan/items', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nombre, costoEstimado } = req.body;
    if (!nombre) return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    if (costoEstimado == null || Number(costoEstimado) < 0) return res.status(400).json({ ok: false, error: 'Costo estimado inválido' });
    const guardado = await plan.guardarItem(await resolverVinculoPlan(req.body));
    res.json({ ok: true, data: guardado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/plan/items/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await plan.deleteItem(req.params.id); res.json({ ok: true, message: 'Ítem eliminado' }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Config: budgetPct | incluirEnProyeccion | override:YYYY-MM
app.put('/api/plan/config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { clave, valor } = req.body;
    if (!clave) return res.status(400).json({ ok: false, error: 'Falta clave' });
    await plan.guardarConfig(clave, valor);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Finanzas — escalera de recupero (solo admin) ────────────────────────────
// La plata del recupero se coloca en instrumentos en pesos en vez de quedar
// quieta. Los aportes mensuales salen del recupero real de cada cierre (roi.js)
// salvo que se hayan editado a mano. Ver src/finanzas.js.
app.get('/api/finanzas', authMiddleware, adminOnly, async (req, res) => {
  try {
    const r = await roi.resumenRecupero().catch(() => ({ porMes: [] }));
    res.json({ ok: true, data: await finanzas.resumenFinanzas(r.porMes || []) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Config: una clave suelta { clave, valor }, o los tres porcentajes juntos
// { pcts: { colchon, uva, cer } } — que se validan sumando 100%.
app.put('/api/finanzas/config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { clave, valor, pcts } = req.body;
    if (pcts) {
      const c = Number(pcts.colchon), u = Number(pcts.uva), e = Number(pcts.cer);
      if (![c, u, e].every(n => Number.isFinite(n) && n >= 0)) {
        return res.status(400).json({ ok: false, error: 'Los porcentajes deben ser números positivos' });
      }
      if (Math.abs(c + u + e - 1) > 1e-6) {
        return res.status(400).json({ ok: false, error:
          `Los porcentajes tienen que sumar 100% (suman ${((c + u + e) * 100).toFixed(1)}%)` });
      }
      await finanzas.guardarConfig('pctColchon', c);
      await finanzas.guardarConfig('pctUva', u);
      await finanzas.guardarConfig('pctCer', e);
      return res.json({ ok: true });
    }
    if (!clave) return res.status(400).json({ ok: false, error: 'Falta clave' });
    await finanzas.guardarConfig(clave, valor);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Aporte de un mes. monto null/'' borra el override y el mes vuelve a tomar el
// recupero real del cierre.
app.put('/api/finanzas/aportes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, monto, notas } = req.body;
    const m = (monto === '' || monto == null) ? null : Number(monto);
    if (m != null && !(Number.isFinite(m) && m >= 0)) {
      return res.status(400).json({ ok: false, error: 'Monto inválido' });
    }
    res.json({ ok: true, data: await finanzas.guardarAporte(mes, m, notas) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Registro real de colocaciones/rescates: la pista de auditoría que separa el
// capital del recupero de la caja operativa del bar.
app.post('/api/finanzas/movimientos', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await finanzas.guardarMovimiento(req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.delete('/api/finanzas/movimientos/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await finanzas.borrarMovimiento(req.params.id); res.json({ ok: true, message: 'Movimiento eliminado' }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Servicios: agregado de productos multi-día (solo admin) ──────────────────
// Responde "¿se vendió más PARA COMER o PARA PICAR en general?" sobre un rango.
app.get('/api/servicios/agregado', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    res.json({ ok: true, data: await getAgregadoProductos({ desde, hasta }) });
  } catch (err) {
    console.error('Error /api/servicios/agregado:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnóstico CRUDO de una venta (items tal como vienen de Fudo)
app.get('/api/costos/venta-debug/:id', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getVentaDebugCrudo(req.params.id) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Diagnóstico por producto (auditar ingreso de Fudo): /api/costos/producto-debug?nombre=Vermu&desde=&hasta=
app.get('/api/costos/producto-debug', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nombre, desde, hasta } = req.query;
    res.json({ ok: true, data: await getProductoDebug(nombre || '', { desde, hasta }) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Costos vs Ingresos por categoría (solo admin) ────────────────────────────
// Cruza el costo (hoja Compras, por ingrediente) con el ingreso (FUDO, mapeado por
// producto a su categoría de costo dominante).
app.get('/api/costos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    await costos.cargarOverrides().catch(() => {});
    await costos.cargarComposiciones().catch(() => {});
    const [compras, detallesFudo] = await Promise.all([
      prov.getCompras().catch(() => []),
      getDetallesFrescos({ desde, hasta }).catch(() => []),
    ]);
    const data = costos.costosVsIngresos({ compras, detallesFudo, desde, hasta });
    // Food cost por categoría (ratio 0..1) para estimar costo de cada plato.
    const fcPorCat = {};
    for (const fila of data.filas) {
      if (fila.ingreso > 0) fcPorCat[fila.categoria] = fila.costo / fila.ingreso;
    }
    data.porPlato = costos.detallePorPlato({ detallesFudo, foodCostPorCategoria: fcPorCat });
    data.composiciones = costos.listComposiciones();
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/costos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Override manual del mapeo producto FUDO → categoría de costo (persiste en Sheets)
app.post('/api/costos/override', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { producto, categoria } = req.body || {};
    if (!producto || !categoria) return res.status(400).json({ ok: false, error: 'Faltan producto y categoría' });
    if (!costos.CATEGORIAS_COSTO.includes(categoria)) return res.status(400).json({ ok: false, error: 'Categoría no válida' });
    await costos.setOverrideProducto(producto, categoria);
    res.json({ ok: true, message: `"${producto}" reasignado a ${categoria}` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Lista de categorías de costo disponibles (para el dropdown de recategorizar)
app.get('/api/costos/categorias', authMiddleware, adminOnly, (req, res) => {
  res.json({ ok: true, data: costos.CATEGORIAS_COSTO });
});

// Composición % de un plato (qué categorías de costo lo componen)
app.get('/api/costos/composicion', authMiddleware, adminOnly, async (req, res) => {
  try {
    await costos.cargarComposiciones().catch(() => {});
    const { plato } = req.query;
    if (plato) return res.json({ ok: true, data: costos.getComposicion(plato) || [] });
    res.json({ ok: true, data: costos.listComposiciones() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/api/costos/composicion', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { plato, partes } = req.body || {};
    if (!plato || !Array.isArray(partes)) return res.status(400).json({ ok: false, error: 'Faltan plato y partes' });
    // Validar categorías y que sume ~100
    for (const p of partes) {
      if (!costos.CATEGORIAS_COSTO.includes(p.categoria)) return res.status(400).json({ ok: false, error: `Categoría no válida: ${p.categoria}` });
    }
    const suma = partes.reduce((a, p) => a + (Number(p.pct) || 0), 0);
    if (Math.abs(suma - 100) > 1) return res.status(400).json({ ok: false, error: `Los % deben sumar 100 (suman ${suma})` });
    await costos.setComposicion(plato, partes);
    res.json({ ok: true, message: `Composición de "${plato}" guardada` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Reglas de consumo de INSUMOS (persistente) ───────────────────────────────
// Lista las reglas + cobertura estimada cruzando con compras de insumos.
app.get('/api/consumo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [reglas, compras] = await Promise.all([
      consumo.listConsumo().catch(() => []),
      prov.getCompras().catch(() => []),
    ]);
    // Agregar compras por producto (solo categoría Insumos), en su unidad de compra.
    const porProd = {};
    for (const c of compras) {
      if (!c.producto) continue;
      const norm = consumo.norm(c.producto);
      const e = porProd[norm] = porProd[norm] || { ingresado: 0, ultimaCompra: null };
      e.ingresado += Number(c.cantidad) || 0;
      if (c.fecha && (!e.ultimaCompra || c.fecha > e.ultimaCompra)) e.ultimaCompra = c.fecha;
    }
    const data = consumo.calcularCobertura(reglas, porProd);
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/api/consumo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { producto, cantidad, periodo } = req.body || {};
    if (!producto || cantidad == null) return res.status(400).json({ ok: false, error: 'Faltan producto y cantidad' });
    await consumo.setConsumo(producto, Number(cantidad), periodo || 'semana');
    res.json({ ok: true, message: `Consumo de "${producto}" guardado` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.delete('/api/consumo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const producto = req.query.producto || (req.body && req.body.producto);
    if (!producto) return res.status(400).json({ ok: false, error: 'Falta producto' });
    await consumo.deleteConsumo(producto);
    res.json({ ok: true, message: 'Regla eliminada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── CMV desagregado Comida / Bebida / Insumos (composición desde Compras) ─────
// El TOTAL fiel del CMV sale del resumen (Movimientos); acá damos la composición.
app.get('/api/cmv-desglose', authMiddleware, adminOnly, async (req, res) => {
  try {
    await costos.cargarProveedorGrupoCMV().catch(() => {});
    const filtro = parseFiltro(req.query);
    const desde = filtro.fechaDesde ? filtro.fechaDesde.toISOString().slice(0,10) : undefined;
    const hasta = filtro.fechaHasta ? filtro.fechaHasta.toISOString().slice(0,10) : undefined;
    const [compras, resumenArr, movimientos] = await Promise.all([
      prov.getCompras().catch(() => []),
      getResumenMensual(filtro).catch(() => []),
      getMovimientos().catch(() => []),
    ]);
    const desglose = costos.cmvDesglose(compras, { desde, hasta });
    const r = resumenArr[0] || { gastos: {}, ingresos: {} };
    const insumosMovimientos = r.gastos?.Insumos || 0;
    const mercaderiaMovimientos = r.gastos?.Mercaderia || 0;
    const cmvMovimientos = mercaderiaMovimientos + insumosMovimientos;
    const ingresos = r.ingresos?.total || 0;

    // Insumos viene de MOVIMIENTOS (no de Compras): pisar el grupo y su detalle.
    desglose.grupos.Insumos = insumosMovimientos;
    desglose.detalle.Insumos = [{ categoria: 'Insumos (Movimientos)', costo: insumosMovimientos }];

    // Base desde Compras (lo que el ticket detalla)
    const comidaCompras = desglose.grupos.Comida || 0;
    const bebidaCompras = desglose.grupos.Bebida || 0;

    // --- Reasignacion por proveedor (cascada Compras -> regla proveedor -> Otros) ---
    // El resto de Mercaderia(Movimientos) que NO esta detallado en Compras se reparte
    // segun la regla del proveedor (hoja "Proveedor Grupo CMV"). Lo que no tiene regla -> Otros.
    let movsMerc = movimientos.filter(m => m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCuota);
    if (filtro.mes) movsMerc = movsMerc.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movsMerc = movsMerc.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    movsMerc = movsMerc.filter(m => m.grupo === 'Mercaderia');
    const normProv = (x) => (x || '').toString().trim().toLowerCase();

    const movPorProv = {};   // key cats.norm -> { nombre, monto }
    for (const m of movsMerc) {
      const k = cats.norm(m.proveedor || '') || '(sin proveedor)';
      const e = movPorProv[k] = movPorProv[k] || { nombre: m.proveedor || '(sin proveedor)', monto: 0 };
      e.monto += m.salidaTotal;
    }
    const compPorProvList = {};  // key cats.norm -> { nombre, monto }
    for (const c of (compras || [])) {
      if (desde && c.fecha && c.fecha < desde) continue;
      if (hasta && c.fecha && c.fecha > hasta) continue;
      const g = costos.grupoCMV(cats.normalizarCategoria(c.categoria).categoria || c.categoria);
      if (g !== 'Comida' && g !== 'Bebida') continue;
      const k = cats.norm(c.proveedor || '') || '(sin proveedor)';
      const e = compPorProvList[k] = compPorProvList[k] || { nombre: c.proveedor || '(sin proveedor)', monto: 0 };
      e.monto += costos.montoCompra(c);
    }
    const comprasArr = Object.values(compPorProvList);
    const comprasDe = (nombreMov) => {
      let tot = 0;
      for (const c of comprasArr) if (costos.mismoProveedor(nombreMov, c.nombre)) tot += c.monto;
      return tot;
    };

    let comidaRegla = 0, bebidaRegla = 0, insumosRegla = 0, otros = 0;
    for (const [k, e] of Object.entries(movPorProv)) {
      const montoMov = e.monto;
      const enCompras = Math.min(montoMov, comprasDe(e.nombre));
      const resto = Math.max(0, montoMov - enCompras);
      if (resto <= 0) continue;
      const grupoRegla = costos.grupoCMVPorProveedor(e.nombre);
      if (grupoRegla === 'Comida') comidaRegla += resto;
      else if (grupoRegla === 'Bebida') bebidaRegla += resto;
      else if (grupoRegla === 'Insumos') insumosRegla += resto;
      else otros += resto;
    }

    desglose.grupos.Comida = Math.round(comidaCompras + comidaRegla);
    desglose.grupos.Bebida = Math.round(bebidaCompras + bebidaRegla);
    desglose.grupos.Insumos = Math.round(insumosMovimientos + insumosRegla);
    desglose.grupos.Otros = Math.round(otros);
    desglose.detalle.Otros = [{ categoria: 'Mercaderia sin regla de proveedor (Movimientos)', costo: Math.round(otros) }];
    // El total es fiel al CMV real de Movimientos.
    desglose.total = cmvMovimientos;

    res.json({ ok: true, data: {
      desglose,
      cmvMovimientos,
      mercaderiaMovimientos,
      comidaCompras,
      bebidaCompras,
      insumosMovimientos,
      ingresos,
      pctCMV: ingresos > 0 ? Math.round((cmvMovimientos / ingresos) * 1000) / 10 : 0,
      nota: 'CMV total sale de Movimientos (P&L real). Comida/Bebida = lo detallado en Compras + lo asignado por la regla de proveedor. Otros = lo que no tiene regla.',
    } });
  } catch (err) {
    console.error('Error /api/cmv-desglose:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Detalle de "Otros" del CMV (conciliacion Movimientos vs Compras) ──────────
// "Otros" = Mercaderia (Movimientos) - Comida (Compras) - Bebida (Compras).
// Es la mercaderia real que la hoja Compras no logro atribuir a Comida ni Bebida.
// No existe como filas sueltas: es la BRECHA entre dos fuentes. Este endpoint la explica
// y devuelve, como referencia, las categorias de Compras que SI se clasificaron.
app.get('/api/cmv-otros-detalle', authMiddleware, adminOnly, async (req, res) => {
  try {
    await costos.cargarProveedorGrupoCMV().catch(() => {});
    const filtro = parseFiltro(req.query);
    const desde = filtro.fechaDesde ? filtro.fechaDesde.toISOString().slice(0,10) : undefined;
    const hasta = filtro.fechaHasta ? filtro.fechaHasta.toISOString().slice(0,10) : undefined;
    const [compras, movimientos] = await Promise.all([
      prov.getCompras().catch(() => []),
      getMovimientos().catch(() => []),
    ]);

    // --- Lado MOVIMIENTOS: gastos del grupo Mercaderia (mismo filtro que el dashboard) ---
    let movsMerc = movimientos.filter(m => m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCuota);
    if (filtro.mes) movsMerc = movsMerc.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movsMerc = movsMerc.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    movsMerc = movsMerc.filter(m => m.grupo === 'Mercaderia');

    const normProv = (x) => (x || '').toString().trim().toLowerCase();
    const porProvMov = {};   // proveedor -> { proveedor, montoMov, movimientos }
    for (const m of movsMerc) {
      const k = normProv(m.proveedor) || '(sin proveedor)';
      const e = porProvMov[k] = porProvMov[k] || { proveedor: m.proveedor || '(sin proveedor)', montoMov: 0, movimientos: 0 };
      e.montoMov += m.salidaTotal;
      e.movimientos++;
    }

    // --- Lado COMPRAS: lo detallado por proveedor que mapea a Comida o Bebida ---
    // Agrupado por proveedor REAL para cruzar por nombre flexible (Zuccardi vs Familia Zuccardi SA).
    const compPorProvList = {};  // key cats.norm -> { nombre, monto }
    for (const c of (compras || [])) {
      if (desde && c.fecha && c.fecha < desde) continue;
      if (hasta && c.fecha && c.fecha > hasta) continue;
      const g = costos.grupoCMV(cats.normalizarCategoria(c.categoria).categoria || c.categoria);
      if (g !== 'Comida' && g !== 'Bebida') continue;
      const k = cats.norm(c.proveedor || '') || '(sin proveedor)';
      const e = compPorProvList[k] = compPorProvList[k] || { nombre: c.proveedor || '(sin proveedor)', monto: 0 };
      e.monto += costos.montoCompra(c);
    }
    const comprasArr = Object.values(compPorProvList);
    const comprasDe = (nombreMov) => {
      let tot = 0;
      for (const c of comprasArr) if (costos.mismoProveedor(nombreMov, c.nombre)) tot += c.monto;
      return tot;
    };

    // --- Cascada por proveedor: Compras primero, luego regla por proveedor, sino Otros ---
    const filas = Object.entries(porProvMov).map(([k, e]) => {
      const montoMov = Math.round(e.montoMov);
      const enCompras = Math.min(montoMov, Math.round(comprasDe(e.proveedor)));
      const resto = Math.max(0, montoMov - enCompras);
      const grupoRegla = costos.grupoCMVPorProveedor(e.proveedor); // '', 'Comida', 'Bebida', 'Insumos'
      const porRegla = grupoRegla ? resto : 0;
      const sinClasificar = grupoRegla ? 0 : resto;
      return { proveedor: e.proveedor, movimientos: e.movimientos, montoMov, enCompras, grupoRegla, porRegla, sinClasificar };
    }).sort((a, b) => b.sinClasificar - a.sinClasificar || b.montoMov - a.montoMov);

    const mercaderiaMovimientos = Math.round(movsMerc.reduce((s, m) => s + m.salidaTotal, 0));
    const enComprasTotal = filas.reduce((s, f) => s + f.enCompras, 0);
    const porReglaTotal = filas.reduce((s, f) => s + f.porRegla, 0);
    const otros = filas.reduce((s, f) => s + f.sinClasificar, 0);

    res.json({ ok: true, data: {
      mercaderiaMovimientos,
      enComprasTotal,
      porReglaTotal,
      otros,
      filas,
      nota: 'Cascada: 1) lo detallado en Compras manda; 2) el resto se asigna por la regla del proveedor ' +
            '(hoja "Proveedor Grupo CMV"); 3) lo que queda sin regla es "Otros". ' +
            'Para que Otros baje a cero, agrega los proveedores con saldo "Sin clasificar" a esa hoja.',
    } });
  } catch (err) {
    console.error('Error /api/cmv-otros-detalle:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Detalle de movimientos por GRUPO de gasto (para modales/acordeón del dashboard) ──
// grupo: Mercaderia | Insumos | Personal | Alquiler | Servicios | Fiscales |
//        Financieros | Extraordinarios | Equipamiento | Otros
// Filtros opcionales (solo relevantes para Servicios/Extraordinarios):
//   ?proveedor=Edenor  → sub-filtro dentro de Servicios
//   ?categoria=Sala    → sub-filtro dentro de Extraordinarios
const LEAF_MATCH = {
  Mercaderia:      m => m.superGrupo === 'Variables' && m.categoria === 'Mercaderia',
  Insumos:         m => m.superGrupo === 'Variables' && m.categoria === 'Insumos',
  Personal:        m => m.superGrupo === 'Personal',
  Equipamiento:    m => m.superGrupo === 'Equipamiento',
  Otros:           m => m.superGrupo === 'Otros',
  Alquiler:        m => m.superGrupo === 'Fijos' && m.subGrupo === 'Alquiler',
  Servicios:       m => m.superGrupo === 'Fijos' && m.subGrupo === 'Servicios',
  Fiscales:        m => m.superGrupo === 'Fiscales',
  Financieros:     m => m.superGrupo === 'Financieros',
  Extraordinarios: m => m.superGrupo === 'Extraordinarios',
};
app.get('/api/movimientos/grupo/:grupo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const matcher = LEAF_MATCH[req.params.grupo];
    if (!matcher) return res.status(400).json({ ok: false, error: `Grupo desconocido: ${req.params.grupo}` });
    const filtro = parseFiltro(req.query);
    let movs = await getMovimientos();
    movs = movs.filter(m => m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCuota);
    if (filtro.mes) movs = movs.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movs = movs.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    movs = movs.filter(matcher);
    if (req.query.proveedor) movs = movs.filter(m => (m.proveedor || '') === req.query.proveedor);
    if (req.query.categoria) movs = movs.filter(m => (m.categoria || '') === req.query.categoria);

    // Desglose por categoría y por proveedor dentro del grupo + filas
    const porCategoria = {}, porProveedor = {};
    for (const m of movs) {
      const c = m.categoria || 'Sin categoría';
      porCategoria[c] = (porCategoria[c] || 0) + m.salidaTotal;
      const p = m.proveedor || 'Sin proveedor';
      porProveedor[p] = (porProveedor[p] || 0) + m.salidaTotal;
    }
    const data = movs
      .map(m => ({ fecha: m.fecha.toISOString().split('T')[0], proveedor: m.proveedor, categoria: m.categoria, descripcion: m.descripcion, medioPago: m.medioPago, monto: m.salidaTotal, estado: m.estado }))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    res.json({ ok: true, data, porCategoria, porProveedor, total: data.reduce((s, x) => s + x.monto, 0) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Calculadora P&L (régimen) con inputs editables (solo admin) ──────────────
app.post('/api/calculadora', authMiddleware, adminOnly, async (req, res) => {
  try {
    res.json({ ok: true, data: calcularCalculadora(req.body || {}) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Defaults de la calculadora a partir de los datos reales (para precargar inputs)
app.get('/api/calculadora/defaults', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [movimientos, resumen] = await Promise.all([getMovimientos(), getResumenMensual({})]);
    const base = require('./proyecciones').calcularBaselines(movimientos);
    res.json({ ok: true, data: base });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Punto de equilibrio diario (Servicios) ──────────────────────────────────
app.get('/api/punto-equilibrio', authMiddleware, adminOnly, async (req, res) => {
  try {
    const movimientos = await getMovimientos();
    const base = calcularBaselines(movimientos);
    res.json({
      ok: true,
      data: {
        puntoEquilibrioDiario: base.puntoEquilibrioDiario,
        fixedMensual: base.fixedMensual,
        fixedDiario: base.fixedDiario,
        pctCostoVariable: base.pctCostoVariable,
        diasServicioEquilibrio: base.diasServicioEquilibrio,
        diasServicio28: base.diasServicio28,
        desglose: {
          personal: base.personalMensual,
          fijos: base.fijosMensual,
          fiscales: base.fiscalesMensual,
          financieros: base.financierosMensual,
          extraordinarios: base.extraordinariosMensual,
          otros: base.otrosMensual,
        },
      },
    });
  } catch (err) {
    console.error('Error /api/punto-equilibrio:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Proyección del MES en curso (real acumulado + forecast a fin de mes) ──────
app.get('/api/proyeccion-mes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [movimientos, variables] = await Promise.all([getMovimientos(), leerVariables().catch(() => [])]);
    res.json({ ok: true, data: proyeccionMes({ movimientos, variables }) });
  } catch (err) {
    console.error('Error /api/proyeccion-mes:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Resumen simplificado de Costos (Comida / Bebida) ────────────────────────
// ─── Resumen simplificado de Costos (Comida / Bebida) ────────────────────────
// GET /api/costos/resumen?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Fuente de gastos: Movimientos hoja "Movimientos", grupo "Mercaderia".
// Clasificación Comida/Bebida: hoja "Costos Proveedores" en Gestión Mercedes.
// Si no se pasan fechas, defaultea al mes en curso.
app.get('/api/costos/resumen', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Período: default = mes en curso (hora Buenos Aires)
    let { desde, hasta } = req.query;
    if (!desde || !hasta) {
      const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      if (!desde) desde = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
      if (!hasta) hasta = hoy.toISOString().slice(0, 10);
    }

    // Traer movimientos, ventas y consumo real de stock (bebida) en paralelo
    // getVentasConCosto = getVentasItems enriquecido con product.cost de Fudo
    const [todosMovs, ventasConCosto, consumoStock] = await Promise.all([
      getMovimientos().catch(() => []),
      getVentasConCosto({ desde, hasta }).catch(() => []),
      stockBebidas.getConsumoMensualBebidas({ desde, hasta }).catch(() => null),
    ]);

    // Filtrar: solo Gastos de Mercadería del período, sin cuotas ni cambios
    const movsMercaderia = todosMovs.filter(m => {
      if (m.tipo !== 'Gasto') return false;
      if (m.esCambio || m.esFondeo || m.esCuota) return false;
      if (m.grupo !== 'Mercaderia') return false;
      const fechaStr = m.fecha ? m.fecha.toISOString().slice(0, 10) : null;
      if (!fechaStr) return false;
      if (desde && fechaStr < desde) return false;
      if (hasta && fechaStr > hasta) return false;
      return true;
    });

    // Clasificar gastos por proveedor (Comida% / Bebida%)
    const gastos = await costosProveedores.clasificarMovimientos(movsMercaderia);

    const data = costos.resumenCostosSimplificado(gastos, ventasConCosto, { desde, hasta }, consumoStock);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/costos/resumen:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/stock-bebidas/snapshot — toma la foto de stock de HOY manualmente
// (idempotente: si ya existe un snapshot de hoy, no hace nada). Útil para
// pruebas o para forzar un catch-up sin esperar a que reinicie el server.
app.post('/api/stock-bebidas/snapshot', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await stockBebidas.tomarSnapshot();
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error POST /api/stock-bebidas/snapshot:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Config de proveedores para Costos ────────────────────────────────────────
// GET /api/costos/proveedores → lista la config completa
app.get('/api/costos/proveedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await costosProveedores.listarConfig();
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error GET /api/costos/proveedores:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/costos/proveedores → guarda config de uno o varios proveedores
// Body: [{ proveedor, comidaPct, bebidaPct, notas? }]  (array)
//    o: { proveedor, comidaPct, bebidaPct, notas? }     (objeto único)
app.post('/api/costos/proveedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Nada que guardar' });
    for (const it of items) {
      if (!it.proveedor) return res.status(400).json({ ok: false, error: 'Falta proveedor en algún item' });
      const cp = Number(it.comidaPct) || 0;
      const bp = Number(it.bebidaPct) || 0;
      if (cp < 0 || cp > 100 || bp < 0 || bp > 100) {
        return res.status(400).json({ ok: false, error: `Porcentajes inválidos para ${it.proveedor}` });
      }
    }
    await costosProveedores.guardarConfigBatch(items);
    res.json({ ok: true, guardados: items.length });
  } catch (err) {
    console.error('Error POST /api/costos/proveedores:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Diagnóstico: shape de stock-movements de Fudo (temporal) ────────────────
app.get('/api/fudo/probe-stock-movements', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await probeStockMovements();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Probe de UN solo recurso — evita el rate limit del probe masivo
// GET /api/fudo/probe-stock-single?resource=stock-movements&size=5
app.get('/api/fudo/probe-stock-single', authMiddleware, adminOnly, async (req, res) => {
  try {
    const resource = req.query.resource || 'stock-movements';
    const size = parseInt(req.query.size) || 3;
    const desde = req.query.desde || '';
    const hasta = req.query.hasta || '';
    const token = await (require('./fudo').getToken ? require('./fudo') : { getToken: async () => '' });

    // Usar fetchRetry directamente desde fudo no es posible sin exponerla,
    // así que llamamos probeStockMovements con un solo candidato vía workaround:
    // Re-implementamos la llamada simple acá.
    const { default: nodeFetch } = await import('node-fetch').catch(() => ({ default: fetch }));
    const _fetch = typeof fetch !== 'undefined' ? fetch : nodeFetch;
    const API_BASE = process.env.FUDO_API_BASE || 'https://api.fu.do/v1alpha1';
    const AUTH_URL = process.env.FUDO_AUTH_URL || 'https://auth.fu.do/api';
    const API_KEY = process.env.FUDO_API_KEY;
    const API_SECRET = process.env.FUDO_API_SECRET;

    // Auth
    const authRes = await _fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY, apiSecret: API_SECRET }),
    });
    const authJson = await authRes.json();
    const fudoToken = authJson.token;

    // Build URL with optional date filters
    let url = `${API_BASE}/${resource}?page[size]=${size}`;
    if (desde) url += `&filter[from]=${desde}`;
    if (hasta) url += `&filter[to]=${hasta}`;

    const r = await _fetch(url, {
      headers: { 'Authorization': `Bearer ${fudoToken}`, 'Accept': 'application/json' },
    });
    const status = r.status;
    let body = null;
    try { body = await r.json(); } catch(e) { body = await r.text().catch(() => null); }
    res.json({ ok: r.ok, status, resource, url, body });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Módulo Proveedores (ingesta de facturas + dashboard de costos) ───────────
app.use(proveedoresRoutes({ authMiddleware, adminOnly }));

// ─── Static y fallback ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Antes de aceptar tráfico: si el proceso anterior murió (deploy, crash) con la
// caja abierta, restaurar esa sesión desde la planilla en vez de perderla en
// memoria — de lo contrario el próximo GET /api/arqueo/estado mostraría "cerrada"
// aunque el turno siga en curso, y esa noche quedaría sin arquear.
(async () => {
  const persistido = await cargarEstadoCaja();
  if (persistido && persistido.abierta) {
    estadoCaja = persistido;
    console.log(`Caja restaurada tras reinicio: abierta desde ${persistido.apertura} (${persistido.encargado})`);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
    iniciarCron();
  });
})();

module.exports = { buildFilasCierreServicio, leerProveedoresSheet };
