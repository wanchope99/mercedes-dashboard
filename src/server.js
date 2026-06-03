require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getCajas, getMovimientosCambio,
  getMeses, getCategorias, clearCache,
} = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Auth helper ──────────────────────────────────────────────────────────────
function getAuth() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ─── Filtro de fecha ──────────────────────────────────────────────────────────
function parseFiltro(query) {
  const { mes, desde, hasta } = query;
  if (mes) return { mes };
  if (desde && hasta) {
    return {
      fechaDesde: new Date(desde),
      fechaHasta: new Date(hasta + 'T23:59:59'),
    };
  }
  return {};
}

// ─── Dashboard endpoints ──────────────────────────────────────────────────────
app.get('/api/meses', async (req, res) => {
  try { res.json({ ok: true, data: await getMeses() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/categorias', async (req, res) => {
  try { res.json({ ok: true, data: await getCategorias() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/resumen', async (req, res) => {
  try { res.json({ ok: true, data: await getResumenMensual(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-diaria', async (req, res) => {
  try { res.json({ ok: true, data: await getActividadPorDia(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-semana', async (req, res) => {
  try { res.json({ ok: true, data: await getActividadPorDiaSemana(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cajas', async (req, res) => {
  try { res.json({ ok: true, data: await getCajas() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cambios', async (req, res) => {
  try { res.json({ ok: true, data: await getMovimientosCambio(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/movimientos', async (req, res) => {
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

app.post('/api/refresh', (req, res) => {
  clearCache();
  res.json({ ok: true, message: 'Cache limpiado.' });
});

// ─── Pagos pendientes ─────────────────────────────────────────────────────────
// Lee movimientos con estado "A pagar" o "A Pagar" y los enriquece con urgencia

function calcUrgencia(vencimiento) {
  if (!vencimiento) return { urgencia: 'sin-fecha', diasHastaVenc: null, vencDate: null };

  // Parsear fecha en formato DD/MM/YY o DD/MM/YYYY
  const parts = vencimiento.trim().split('/');
  if (parts.length !== 3) return { urgencia: 'sin-fecha', diasHastaVenc: null, vencDate: null };

  let [d, m, y] = parts.map(Number);
  if (y < 100) y += 2000;
  const vencDate = new Date(y, m - 1, d);
  if (isNaN(vencDate.getTime())) return { urgencia: 'sin-fecha', diasHastaVenc: null, vencDate: null };

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const diffMs = vencDate - hoy;
  const dias = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  let urgencia;
  if (dias < 0) urgencia = 'vencido';
  else if (dias === 0) urgencia = 'hoy';
  else if (dias <= 3) urgencia = 'urgente';
  else if (dias <= 10) urgencia = 'proximo';
  else urgencia = 'ok';

  // Formato YYYY-MM-DD para el frontend
  const vencISO = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  return { urgencia, diasHastaVenc: dias, vencDate: vencISO };
}

app.get('/api/pagos', async (req, res) => {
  try {
    const { sort = 'vencimiento', medioPago, q } = req.query;

    const todos = await getMovimientos();

    // Filtrar: Gasto, estado A pagar (cualquier variante), excluir cambios/fondeos
    let pagos = todos.filter(m =>
      m.tipo === 'Gasto' &&
      !m.pagado &&
      !m.esCambio &&
      !m.esFondeo
    );

    // Filtros opcionales
    if (medioPago) pagos = pagos.filter(p => (p.medioPago || '').toLowerCase().includes(medioPago.toLowerCase()));
    if (q) pagos = pagos.filter(p => (p.proveedor || '').toLowerCase().includes(q.toLowerCase()));

    // Enriquecer con urgencia
    pagos = pagos.map(p => ({
      ...p,
      fecha: p.fecha.toISOString().split('T')[0],
      ...calcUrgencia(p.vencimiento),
    }));

    // Ordenar
    const ordenUrgencia = { vencido: 0, hoy: 1, urgente: 2, proximo: 3, ok: 4, 'sin-fecha': 5 };
    if (sort === 'vencimiento') {
      pagos.sort((a, b) => {
        if (a.urgencia !== b.urgencia) return (ordenUrgencia[a.urgencia] || 5) - (ordenUrgencia[b.urgencia] || 5);
        if (a.diasHastaVenc !== null && b.diasHastaVenc !== null) return a.diasHastaVenc - b.diasHastaVenc;
        return 0;
      });
    } else if (sort === 'monto') {
      pagos.sort((a, b) => (b.salidaTotal || 0) - (a.salidaTotal || 0));
    } else if (sort === 'proveedor') {
      pagos.sort((a, b) => (a.proveedor || '').localeCompare(b.proveedor || ''));
    } else if (sort === 'formapago') {
      pagos.sort((a, b) => (a.medioPago || '').localeCompare(b.medioPago || ''));
    }

    // Summary
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const finSemana = new Date(hoy); finSemana.setDate(hoy.getDate() + 7);

    const summary = {
      total: pagos.length,
      totalARS: pagos.reduce((s, p) => s + (p.salidaARS || 0), 0),
      totalUSD: pagos.reduce((s, p) => s + (p.salidaUSD || 0), 0),
      vencidos: pagos.filter(p => p.urgencia === 'vencido').length,
      estaSemanaCant: pagos.filter(p => p.vencDate && new Date(p.vencDate + 'T12:00:00') <= finSemana && p.urgencia !== 'vencido').length,
      estaSemanaARS: pagos.filter(p => p.vencDate && new Date(p.vencDate + 'T12:00:00') <= finSemana && p.urgencia !== 'vencido').reduce((s, p) => s + (p.salidaARS || 0), 0),
    };

    res.json({ ok: true, data: pagos, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/pagos — agrega una fila nueva en la hoja Movimientos
app.post('/api/pagos', async (req, res) => {
  try {
    const { fecha, mes, proveedor, categoria, medioPago, salidaARS, vencimiento, descripcion } = req.body;
    if (!fecha || !proveedor) return res.status(400).json({ ok: false, error: 'Fecha y proveedor son obligatorios' });

    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Fila: Fecha, Mes, Tipo, Estado, Vencimiento, Proveedor, Categoría, Descripción, Medio de pago, MEntrada ARS, MEntrada USD, MSalida ARS, MSalida USD
    const row = [fecha, mes || '', 'Gasto', 'A pagar', vencimiento || '', proveedor, categoria || '', descripcion || '', medioPago || '', '', '', salidaARS || '', ''];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Movimientos!A:N',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    clearCache();
    res.json({ ok: true, message: 'Pago registrado correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Proveedores ──────────────────────────────────────────────────────────────
// Lee la hoja "Proveedores" y devuelve un objeto indexado por nombre (lowercase)

app.get('/api/proveedores', async (req, res) => {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Proveedores!A:F',
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ ok: true, data: {} });

    // Buscar header
    let headerIdx = rows.findIndex(r => r && (r[0] || '').toString().trim().toLowerCase() === 'proveedor');
    if (headerIdx === -1) headerIdx = 0;

    const header = rows[headerIdx].map(h => (h || '').toString().trim().toLowerCase());
    const idxNombre = header.indexOf('proveedor');
    const idxFormaPago = header.findIndex(h => h.includes('forma') || h.includes('pago'));
    const idxDatos = header.findIndex(h => h.includes('datos') || h.includes('banco') || h.includes('cbu') || h.includes('alias'));
    const idxComentarios = header.findIndex(h => h.includes('comentario') || h.includes('nota'));

    const proveedores = {};
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[idxNombre]) continue;
      const nombre = (row[idxNombre] || '').trim();
      if (!nombre) continue;
      proveedores[nombre.toLowerCase()] = {
        nombre,
        formaPago: idxFormaPago >= 0 ? (row[idxFormaPago] || '') : '',
        datosParaPagar: idxDatos >= 0 ? (row[idxDatos] || '') : '',
        comentarios: idxComentarios >= 0 ? (row[idxComentarios] || '') : '',
      };
    }

    res.json({ ok: true, data: proveedores });
  } catch (err) {
    console.error(err);
    // Si la hoja no existe o hay error, devolver objeto vacío en lugar de romper
    res.json({ ok: true, data: {} });
  }
});

// ─── Static y fallback ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
});
