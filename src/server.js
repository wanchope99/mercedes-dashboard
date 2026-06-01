require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getMeses, getCategorias, clearCache,
  getPagos, appendPago,
} = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Endpoints existentes ─────────────────────────────────────────────────────

app.get('/api/meses', async (req, res) => {
  try { res.json({ ok: true, data: await getMeses() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/categorias', async (req, res) => {
  try { res.json({ ok: true, data: await getCategorias() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/resumen', async (req, res) => {
  try {
    const { mes } = req.query;
    res.json({ ok: true, data: await getResumenMensual(mes || null) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-diaria', async (req, res) => {
  try {
    const { mes } = req.query;
    res.json({ ok: true, data: await getActividadPorDia(mes || null) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-semana', async (req, res) => {
  try {
    const { mes } = req.query;
    res.json({ ok: true, data: await getActividadPorDiaSemana(mes || null) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/movimientos', async (req, res) => {
  try {
    const { mes, tipo, categoria, estado } = req.query;
    let movimientos = await getMovimientos();
    if (mes) movimientos = movimientos.filter(m => m.mes === mes);
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

// ─── Endpoints de Pagos ───────────────────────────────────────────────────────

/**
 * GET /api/pagos
 * Retorna todos los movimientos con estado "A pagar" / "Pendiente".
 * Query params opcionales:
 *   - sort: 'vencimiento' | 'monto' | 'proveedor' | 'formapago'  (default: vencimiento)
 *   - medioPago: filtra por forma de pago (substring, case-insensitive)
 *   - q: búsqueda libre en proveedor + descripción
 */
app.get('/api/pagos', async (req, res) => {
  try {
    const { sort = 'vencimiento', medioPago, q } = req.query;
    let pagos = await getPagos();

    // Filtros
    if (medioPago) {
      pagos = pagos.filter(p => (p.medioPago || '').toLowerCase().includes(medioPago.toLowerCase()));
    }
    if (q) {
      const term = q.toLowerCase();
      pagos = pagos.filter(p =>
        (p.proveedor || '').toLowerCase().includes(term) ||
        (p.descripcion || '').toLowerCase().includes(term)
      );
    }

    // Ordenamiento
    pagos.sort((a, b) => {
      if (sort === 'vencimiento') {
        if (!a.vencDate && !b.vencDate) return 0;
        if (!a.vencDate) return 1;
        if (!b.vencDate) return -1;
        return a.vencDate.localeCompare(b.vencDate);
      }
      if (sort === 'monto') return b.salidaARS - a.salidaARS;
      if (sort === 'proveedor') return (a.proveedor || '').localeCompare(b.proveedor || '');
      if (sort === 'formapago') return (a.medioPago || '').localeCompare(b.medioPago || '');
      return 0;
    });

    // Summary para las cards
    const today = new Date().toISOString().split('T')[0];
    const vencidos = pagos.filter(p => p.urgencia === 'vencido').length;
    const estaSemanaCant = pagos.filter(p => p.urgencia === 'urgente' || p.urgencia === 'hoy').length;
    const estaSemanaARS = pagos
      .filter(p => p.urgencia === 'urgente' || p.urgencia === 'hoy')
      .reduce((s, p) => s + p.salidaARS, 0);
    const totalARS = pagos.reduce((s, p) => s + p.salidaARS, 0);

    res.json({
      ok: true,
      data: pagos,
      summary: { total: pagos.length, totalARS, vencidos, estaSemanaCant, estaSemanaARS },
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/**
 * POST /api/pagos
 * Agrega una nueva fila en la hoja Movimientos con estado "A pagar".
 * Body JSON: { fecha, mes, proveedor, categoria, medioPago, salidaARS, vencimiento, descripcion }
 */
app.post('/api/pagos', async (req, res) => {
  try {
    const { fecha, mes, proveedor, categoria, medioPago, salidaARS, vencimiento, descripcion } = req.body;
    if (!fecha || !proveedor) {
      return res.status(400).json({ ok: false, error: 'fecha y proveedor son obligatorios.' });
    }
    await appendPago({ fecha, mes, proveedor, categoria, medioPago, salidaARS, vencimiento, descripcion });
    res.json({ ok: true, message: `Pago de ${proveedor} registrado correctamente.` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Static y fallback ────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
});
