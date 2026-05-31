require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getMeses, getCategorias, clearCache
} = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API endpoints ANTES del static
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

// Static y fallback DESPUÉS de la API
app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
});
