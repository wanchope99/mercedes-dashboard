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
const { getServicios, getServicioDetalle, getServicioDebug, resnapshotDia, getDetallesTodos, getAgregadoProductos, getProductoDebug, clearFudoCache, fechaServicio: fechaServicioDe, fechaServicioHoy } = require('./fudo');
const { proyectar, calcularCalculadora, proyeccionMes } = require('./proyecciones');
const proveedoresRoutes = require('./proveedores-routes');
const prov = require('./proveedores');
const costos = require('./costos');

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
//  · Galicia: el ingreso se registra en BRUTO; los impuestos (Bruto − Neto)
//    van como Gasto · Fiscales. El neto queda como resultado, discriminado.
// gastosEfectivoSesion / gastosMPSesion: gastos YA registrados en Movimientos con la
// caja abierta (ej: hielo). Reducen el esperado y NO deben generar fila delta duplicada.
function buildFilasCierreServicio({ fechaServicio, mesServicio, descripcionServicio, deltaEfectivo, deltaMP, galiciaBruto, impuestos, fudo, gastosEfectivoSesion = 0, gastosMPSesion = 0 }) {
  const ingreso = (medio, monto, desc) => [
    fechaServicio, mesServicio, 'Ingreso', 'Pagado', '', '', '',
    'Servicio', 'Ingreso', desc || descripcionServicio,
    medio, monto, '', '', '',
  ];
  const gasto = (medio, monto, desc, categoria = 'Operativos') => [
    fechaServicio, mesServicio, 'Gasto', 'Pagado', '', '', '',
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

  // Galicia: ingreso BRUTO + impuestos como gasto fiscal → resultado neto discriminado
  if (galiciaBruto > 0) rows.push(ingreso('Galicia', galiciaBruto));
  if (impuestos > 0) {
    rows.push(gasto('Galicia', impuestos, descripcionServicio, 'Fiscales'));
  }
  return rows;
}

// ─── Arqueo de Cajas ──────────────────────────────────────────────────────────

// GET /api/arqueo/estado — estado actual de la caja
app.get('/api/arqueo/estado', authMiddleware, (req, res) => {
  res.json({ ok: true, data: estadoCaja });
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
  const { efectivo, mercadoPago, galicia, galiciaNeto, fudo } = req.body;
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

  // Fechas para hoja Arqueo de Cajas (formato largo local)
  const fechaStr = apertura.toLocaleDateString('es-AR');
  const aperturaStr = apertura.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const cierreStr = cierre.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

  // Impuestos = diferencia entre Bruto y Neto Acreditado
  const galiciaBruto = Number(galicia) || 0;
  const galiciaNetoVal = Number(galiciaNeto) || 0;
  const impuestos = galiciaBruto > galiciaNetoVal ? galiciaBruto - galiciaNetoVal : 0;

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. Escribir en Arqueo de Cajas
    // Columnas: A:Fecha, B:Apertura, C:Cierre, D:Duración,
    // E:Efectivo Inicial, F:MP Inicial, G:Galicia Inicial (vacío),
    // H:Efectivo Final, I:MP Final, J:Galicia Final,
    // K:Diff Efectivo Local Inicial, L:Diff Mercado Pago Inicial
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
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Arqueo de Cajas!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowArqueo] },
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

    // 2. Escribir en Movimientos — columnas A:O
    // A:Fecha, B:Mes, C:Tipo Movimiento, D:Estado, E:Vencimiento, F:Cuotas,
    // G:ID Compra, H:Proveedor, I:Categoría, J:Descripción, K:Medio de Pago,
    // L:Monto Entrada ARS, M:Monto Entrada USD, N:Monto Salida ARS, O:Monto Salida USD
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
        range: 'Movimientos!A:O',
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
    const row = [fecha, mes || '', 'Gasto', estadoRow, '', '', '', proveedor, categoria || 'Insumos', descripcion || '', medioPago || '', '', '', Number(monto), ''];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:O',
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

app.post('/api/pagos', authMiddleware, adminOnly, async (req, res) => {
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
      // Fila madre: estado "En cuotas", medio de pago vacío, col F = total de cuotas, col G = ID
      values = [[fecha, mes||'', 'Gasto', 'En cuotas', '', String(nCuotas), cuotaId, proveedor, categoria||'', `${descBase} — Total en ${nCuotas} cuotas`, '', '', '', total, '']];
      for (let i = 1; i <= nCuotas; i++) {
        const venc = addMonthsDDMM(vencimiento, i - 1);
        // Ajuste última cuota para que la suma cierre exacta con el total
        const monto = i === nCuotas ? total - montoCuota * (nCuotas - 1) : montoCuota;
        // Medio de pago vacío hasta que se pague (las fórmulas de Cajas suman por medio):
        // al marcarla Pagado se completa el medio, la fecha real y el mes.
        values.push([venc, mesDeFecha(venc), 'Gasto', 'A pagar', venc, `${i}/${nCuotas}`, cuotaId, proveedor, categoria||'', `${descBase} — Cuota ${i}/${nCuotas}${medioPago ? ' ('+medioPago+')' : ''}`, '', '', '', monto, '']);
      }
    } else {
      // Pagado: sin vencimiento (ya salió de caja) · A pagar: con vencimiento
      values = [[fecha, mes||'', 'Gasto', estadoRow, estadoRow === 'Pagado' ? '' : (vencimiento||''), '', '', proveedor, categoria||'', descripcion||'', medioPago||'', '', '', salidaARS||'', '']];
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:O',
      valueInputOption: 'USER_ENTERED', requestBody: { values },
    });
    clearCache();
    res.json({ ok: true, message: nCuotas > 1 ? `Compra en ${nCuotas} cuotas registrada (${values.length} filas)` : 'Pago registrado correctamente' });
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
// fila existente (no agrega línea): Estado (col D) → Pagado, y Medio de pago (col K)
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
    if (medio) data.push({ range: `Movimientos!K${idx}`, values: [[medio]] });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
    clearCache();
    res.json({ ok: true, message: `${m.proveedor} marcado como Pagado`, proveedor: m.proveedor, monto: m.salidaARS, medio });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/proveedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    res.json({ ok: true, data: await leerProveedoresSheet() });
  } catch (err) { res.json({ ok: true, data: {} }); }
});

// Sugerencias para el alta de pagos: proveedores ya usados en Movimientos
// (con su última categoría y medio de pago) + los de la hoja Proveedores.
app.get('/api/proveedores-sugerencias', authMiddleware, adminOnly, async (req, res) => {
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
    const [movimientos, resumen, variables] = await Promise.all([
      getMovimientos(), getResumenMensual({}), leerVariables(),
    ]);
    const data = proyectar({ movimientos, resumen, variables, horizonte });
    res.json({ ok: true, data: { ...data, variables } });
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
    const [compras, detallesFudo] = await Promise.all([
      prov.getCompras().catch(() => []),
      getDetallesTodos({ desde, hasta }).catch(() => []),
    ]);
    res.json({ ok: true, data: costos.costosVsIngresos({ compras, detallesFudo, desde, hasta }) });
  } catch (err) {
    console.error('Error /api/costos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Override manual del mapeo producto FUDO → categoría de costo
app.post('/api/costos/override', authMiddleware, adminOnly, (req, res) => {
  const { producto, categoria } = req.body || {};
  if (!producto || !categoria) return res.status(400).json({ ok: false, error: 'Faltan producto y categoría' });
  costos.setOverrideProducto(producto, categoria);
  res.json({ ok: true, message: 'Mapeo actualizado', overrides: costos.getOverrides() });
});

// ─── CMV desagregado Comida / Bebida / Insumos (composición desde Compras) ─────
// El TOTAL fiel del CMV sale del resumen (Movimientos); acá damos la composición.
app.get('/api/cmv-desglose', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filtro = parseFiltro(req.query);
    const desde = filtro.fechaDesde ? filtro.fechaDesde.toISOString().slice(0,10) : undefined;
    const hasta = filtro.fechaHasta ? filtro.fechaHasta.toISOString().slice(0,10) : undefined;
    const [compras, resumenArr] = await Promise.all([
      prov.getCompras().catch(() => []),
      getResumenMensual(filtro).catch(() => []),
    ]);
    const desglose = costos.cmvDesglose(compras, { desde, hasta });
    const r = resumenArr[0] || { gastos: {}, ingresos: {} };
    const insumosMovimientos = r.gastos?.Insumos || 0;
    const cmvMovimientos = (r.gastos?.Mercaderia || 0) + insumosMovimientos;
    const ingresos = r.ingresos?.total || 0;
    // Insumos viene de MOVIMIENTOS (no de Compras): pisar el grupo y su detalle.
    desglose.grupos.Insumos = insumosMovimientos;
    desglose.detalle.Insumos = [{ categoria: 'Insumos (Movimientos)', costo: insumosMovimientos }];
    // Recalcular total de composición con el Insumos de Movimientos
    desglose.total = (desglose.grupos.Comida||0) + (desglose.grupos.Bebida||0) + (desglose.grupos.Insumos||0) + (desglose.grupos.Otros||0);
    res.json({ ok: true, data: {
      desglose,                       // Comida/Bebida (Compras) + Insumos (Movimientos)
      cmvMovimientos,                 // total fiel (Movimientos)
      ingresos,
      pctCMV: ingresos > 0 ? Math.round((cmvMovimientos / ingresos) * 1000) / 10 : 0,
      nota: 'CMV total e Insumos salen de Movimientos (P&L real). Comida y Bebida se desagregan desde la hoja Compras.',
    } });
  } catch (err) {
    console.error('Error /api/cmv-desglose:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Detalle de movimientos por GRUPO de gasto (para modales del dashboard) ────
// grupo: Mercaderia | Insumos | Equipamiento | Operativos | Impuestos | Personal | Otros
app.get('/api/movimientos/grupo/:grupo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const grupo = req.params.grupo;
    const filtro = parseFiltro(req.query);
    let movs = await getMovimientos();
    movs = movs.filter(m => m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCuota);
    if (filtro.mes) movs = movs.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movs = movs.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    movs = movs.filter(m => m.grupo === grupo);
    // Desglose por categoría dentro del grupo + filas
    const porCategoria = {};
    for (const m of movs) {
      const c = m.categoria || 'Sin categoría';
      porCategoria[c] = (porCategoria[c] || 0) + m.salidaTotal;
    }
    const data = movs
      .map(m => ({ fecha: m.fecha.toISOString().split('T')[0], proveedor: m.proveedor, categoria: m.categoria, descripcion: m.descripcion, medioPago: m.medioPago, monto: m.salidaTotal, estado: m.estado }))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    res.json({ ok: true, data, porCategoria, total: data.reduce((s, x) => s + x.monto, 0) });
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

// ─── Módulo Proveedores (ingesta de facturas + dashboard de costos) ───────────
app.use(proveedoresRoutes({ authMiddleware, adminOnly }));

// ─── Static y fallback ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
});

module.exports = { buildFilasCierreServicio, leerProveedoresSheet };
