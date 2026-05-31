require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getMovimientos, getResumenMensual, getActividadPorDia, getMeses, getCategorias, clearCache } = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── API Endpoints ─────────────────────────────────────────────────────────────

// GET /api/meses — lista de meses disponibles
app.get('/api/meses', async (req, res) => {
  try {
    const meses = await getMeses();
    res.json({ ok: true, data: meses });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/categorias — lista de categorías de gastos
app.get('/api/categorias', async (req, res) => {
  try {
    const categorias = await getCategorias();
    res.json({ ok: true, data: categorias });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/resumen?mes=Mayo
app.get('/api/resumen', async (req, res) => {
  try {
    const { mes } = req.query;
    const resumen = await getResumenMensual(mes || null);
    res.json({ ok: true, data: resumen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/actividad-diaria?mes=Mayo
app.get('/api/actividad-diaria', async (req, res) => {
  try {
    const { mes } = req.query;
    const dias = await getActividadPorDia(mes || null);
    res.json({ ok: true, data: dias });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/movimientos?mes=Mayo&tipo=Gasto&categoria=Mercaderia&estado=Pagado
app.get('/api/movimientos', async (req, res) => {
  try {
    const { mes, tipo, categoria, estado } = req.query;
    let movimientos = await getMovimientos();

    if (mes) movimientos = movimientos.filter(m => m.mes === mes);
    if (tipo) movimientos = movimientos.filter(m => m.tipo === tipo);
    if (categoria) movimientos = movimientos.filter(m => m.categoria === categoria);
    if (estado) movimientos = movimientos.filter(m => m.estado.toLowerCase() === estado.toLowerCase());

    // Serializar fechas para JSON
    const data = movimientos.map(m => ({
      ...m,
      fecha: m.fecha.toISOString().split('T')[0],
    }));

    res.json({ ok: true, data, total: data.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/refresh — fuerza refresco del cache
app.post('/api/refresh', (req, res) => {
  clearCache();
  res.json({ ok: true, message: 'Cache limpiado. Próxima llamada trae datos frescos.' });
});

// GET /api/kpis?mes=Mayo — KPIs ejecutivos para el header del dashboard
app.get('/api/kpis', async (req, res) => {
  try {
    const { mes } = req.query;
    const resumen = await getResumenMensual(mes || null);
    const diasData = await getActividadPorDia(mes || null);

    // Si hay un mes específico, tomar ese; si no, todos
    const data = resumen;

    const totalIngresos = data.reduce((s, m) => s + m.totalIngresos, 0);
    const totalGastosPagados = data.reduce((s, m) => s + m.totalGastosPagados, 0);
    const totalGastosComprometidos = data.reduce((s, m) => s + m.totalGastosComprometidos, 0);

    // Días con servicio (ingresos de ventas)
    const diasConServicio = diasData.filter(d => d.servicioDelDia);
    const promedioIngresoPorServicio = diasConServicio.length
      ? diasConServicio.reduce((s, d) => s + d.ingresos, 0) / diasConServicio.length
      : 0;

    // Breakdown de gastos por categoría (comprometido)
    const gastosPorCategoria = {};
    for (const m of data) {
      for (const [cat, val] of Object.entries(m.gastosPorCategoriaComprometido)) {
        gastosPorCategoria[cat] = (gastosPorCategoria[cat] || 0) + val;
      }
    }

    // Ingresos por medio de pago
    const ingresosPorMedioPago = {};
    for (const m of data) {
      for (const [mp, val] of Object.entries(m.ingresosPorMedioPago)) {
        ingresosPorMedioPago[mp] = (ingresosPorMedioPago[mp] || 0) + val;
      }
    }

    res.json({
      ok: true,
      data: {
        totalIngresos,
        totalGastosPagados,
        totalGastosComprometidos,
        resultado: totalIngresos - totalGastosPagados,
        resultadoComprometido: totalIngresos - totalGastosComprometidos,
        diasConServicio: diasConServicio.length,
        promedioIngresoPorServicio,
        gastosPorCategoria,
        ingresosPorMedioPago,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Fallback: servir el frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
});
