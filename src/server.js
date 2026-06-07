require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getCajas, getMovimientosCambio,
  getMeses, getCategorias, clearCache,
} = require('./sheets');
const { getServicios, getServicioDetalle, clearFudoCache } = require('./fudo');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
  const { efectivo, mercadoPago, galicia, galiciaNeto } = req.body;
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

  // Fecha del servicio en formato dd/mm/yy (día de apertura)
  // Convertir a hora AR (UTC-3) para que cierres después de las 21:00 no caigan en el día siguiente
  const aperturaAR = new Date(apertura.getTime() - 3 * 60 * 60 * 1000);
  const dd = String(aperturaAR.getUTCDate()).padStart(2, '0');
  const mm = String(aperturaAR.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(aperturaAR.getUTCFullYear()).slice(-2);
  const fechaServicio = `${dd}/${mm}/${yy}`;
  const mesesNombres = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const mesServicio = mesesNombres[aperturaAR.getUTCMonth()];
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

    // 2. Escribir en Movimientos — columnas A:M
    // A:Fecha, B:Mes, C:Tipo Movimiento, D:Estado, E:Vencimiento, F:Proveedor,
    // G:Categoría, H:Descripción, I:Medio de Pago, J:Monto Entrada ARS,
    // K:Monto Entrada USD, L:Monto Salida ARS, M:Monto Salida USD
    const makeIngreso = (medioPago, montoEntrada) => [
      fechaServicio, mesServicio, 'Ingreso', 'Pagado', '',
      'Servicio', 'Ingreso', descripcionServicio,
      medioPago, montoEntrada, '', '', '',
    ];
    // Solo se registra ingreso si el saldo final supera al inicial (delta > 0)
    const rowsMovimientos = [];
    const deltaEfectivo = Number(efectivo) - estadoCaja.efectivoInicial;
    const deltaMP       = Number(mercadoPago) - estadoCaja.mpInicial;
    // Para Galicia usamos el neto acreditado como ingreso (bruto ya descuenta impuestos)
    const deltaGalicia  = galiciaNetoVal > 0 ? galiciaNetoVal : 0;
    if (deltaEfectivo > 0) rowsMovimientos.push(makeIngreso('Efectivo Local', deltaEfectivo));
    if (deltaMP       > 0) rowsMovimientos.push(makeIngreso('Mercado Pago',   deltaMP));
    if (deltaGalicia  > 0) rowsMovimientos.push(makeIngreso('Galicia',        deltaGalicia));
    if (impuestos > 0) {
      rowsMovimientos.push([
        fechaServicio, mesServicio, 'Gasto', 'Pagado', '',
        'Servicio', 'Fiscales', descripcionServicio,
        'Galicia', '', '', impuestos, '',
      ]);
    }
    if (rowsMovimientos.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Movimientos!A:M',
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
  estadoCaja = { abierta: false, apertura: null, encargado: null, efectivoInicial: null, mpInicial: null };

  res.json({ ok: true, data: resumen });
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
    let pagos = todos.filter(m => m.tipo === 'Gasto' && !m.pagado && !m.esCambio && !m.esFondeo);
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

app.post('/api/pagos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { fecha, mes, proveedor, categoria, medioPago, salidaARS, vencimiento, descripcion } = req.body;
    if (!fecha || !proveedor) return res.status(400).json({ ok: false, error: 'Fecha y proveedor son obligatorios' });
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const row = [fecha, mes||'', 'Gasto', 'A pagar', vencimiento||'', proveedor, categoria||'', descripcion||'', medioPago||'', '', '', salidaARS||'', ''];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:N',
      valueInputOption: 'USER_ENTERED', requestBody: { values: [row] },
    });
    clearCache();
    res.json({ ok: true, message: 'Pago registrado correctamente' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/proveedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Proveedores!A:F' });
    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ ok: true, data: {} });
    let headerIdx = rows.findIndex(r => r && (r[0]||'').toString().trim().toLowerCase() === 'proveedor');
    if (headerIdx === -1) headerIdx = 0;
    const header = rows[headerIdx].map(h => (h||'').toString().trim().toLowerCase());
    const idxNombre = header.indexOf('proveedor');
    const idxFormaPago = header.findIndex(h => h.includes('forma') || h.includes('pago'));
    const idxDatos = header.findIndex(h => h.includes('datos') || h.includes('banco') || h.includes('cbu') || h.includes('alias'));
    const idxComentarios = header.findIndex(h => h.includes('comentario') || h.includes('nota'));
    const proveedores = {};
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[idxNombre]) continue;
      const nombre = (row[idxNombre]||'').trim();
      if (!nombre) continue;
      proveedores[nombre.toLowerCase()] = {
        nombre, formaPago: idxFormaPago >= 0 ? (row[idxFormaPago]||'') : '',
        datosParaPagar: idxDatos >= 0 ? (row[idxDatos]||'') : '',
        comentarios: idxComentarios >= 0 ? (row[idxComentarios]||'') : '',
      };
    }
    res.json({ ok: true, data: proveedores });
  } catch (err) { res.json({ ok: true, data: {} }); }
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

// ─── Static y fallback ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
});
