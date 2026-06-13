// ─── Rutas del módulo Proveedores ───────────────────────────────────────────────
//
// Se monta en server.js con: app.use(require('./proveedores-routes')(deps))
// donde deps = { authMiddleware, adminOnly }.
//
// Endpoints:
//   POST /api/proveedores/ingest            ← el bot manda la foto acá
//   GET  /api/proveedores/pendientes        ← lista de facturas a confirmar (panel app)
//   GET  /api/proveedores/pendientes/count  ← badge de notificaciones
//   POST /api/proveedores/pendientes/:id/resolver  ← confirmar/corregir y escribir
//   POST /api/proveedores/pendientes/:id/descartar
//   GET  /api/proveedores/productos         ← lista de productos + categorías (filtros)
//   GET  /api/proveedores/serie             ← serie temporal de precio unitario
//   POST /api/proveedores/normalizar-historico  ← migrar categorías viejas (admin)
//
// La ingesta admite un token de servicio (PROVEEDORES_INGEST_TOKEN) para que el
// bot autentique sin pasar por el login de usuarios.

const express = require('express');
const prov = require('./proveedores');
const { extraerDeImagen } = require('./extractor');
const cats = require('./proveedores-categorias');

// Umbral de confianza por debajo del cual un campo se considera dudoso.
const UMBRAL = parseFloat(process.env.PROVEEDORES_UMBRAL_CONFIANZA || '0.6');

// Construye, para cada item extraído, la versión resuelta + dudas detectadas.
function procesarItems(itemsCrudos, indice) {
  return itemsCrudos.map(raw => {
    const resuelto = cats.resolverItem(raw, indice);
    const conf = raw.confianza || {};

    // Dudas adicionales por baja confianza del extractor, aunque la normalización
    // haya "encajado" el valor. Ej: leyó "Carnes" con confianza 0.3 → confirmar.
    const dudas = [...resuelto.dudas];
    const yaDuda = campo => dudas.some(d => d.campo === campo);

    if (resuelto.categoria && !yaDuda('categoria') && (conf.categoria ?? 1) < UMBRAL) {
      dudas.push({ campo: 'categoria', sugerido: resuelto.categoria, fuente: 'baja-confianza', opciones: cats.CATEGORIAS });
    }
    if (resuelto.medioPago && !yaDuda('medioPago') && (conf.forma_de_pago ?? 1) < UMBRAL) {
      dudas.push({ campo: 'medioPago', sugerido: resuelto.medioPago, fuente: 'baja-confianza', opciones: cats.MEDIOS_PAGO });
    }
    if (raw.producto && !yaDuda('producto') && (conf.producto ?? 1) < UMBRAL) {
      dudas.push({ campo: 'producto', sugerido: raw.producto, fuente: 'baja-confianza', opciones: [] });
    }
    if (Number(raw.precio_unitario) > 0 && !yaDuda('precio_unitario') && (conf.precio_unitario ?? 1) < UMBRAL) {
      dudas.push({ campo: 'precio_unitario', sugerido: raw.precio_unitario, fuente: 'baja-confianza', opciones: [] });
    }

    return {
      fecha: raw.fecha || '',
      proveedor: raw.proveedor || '',
      categoria: resuelto.categoria,
      producto: raw.producto || '',
      cantidad: raw.cantidad ?? null,
      unidad: raw.unidad || '',
      precioUnit: Number(raw.precio_unitario) || null,
      total: raw.total != null ? Number(raw.total) : null,
      formaPago: resuelto.medioPago || raw.forma_de_pago || '',
      diasCredito: raw.dias_credito ?? 0,
      entregaOk: raw.entrega_ok || 'Sí',
      notas: raw.notas || '',
      dudas,
    };
  });
}

module.exports = function ({ authMiddleware, adminOnly } = {}) {
  const router = express.Router();

  // Solo admin puede ver el tab Proveedores (dashboard + panel de pendientes).
  // Si por algún motivo no llega adminOnly, caemos a authMiddleware (nunca abierto).
  const soloAdmin = adminOnly || authMiddleware || ((q, s, n) => n());

  // Auth para la ingesta: token de servicio (bot) O usuario logueado.
  function ingestAuth(req, res, next) {
    const svcToken = process.env.PROVEEDORES_INGEST_TOKEN;
    const provided = req.headers['x-ingest-token'] || (req.body && req.body.ingestToken);
    if (svcToken && provided && provided === svcToken) return next();
    if (authMiddleware) return authMiddleware(req, res, next);
    return res.status(401).json({ ok: false, error: 'No autenticado' });
  }

  // ─── Ingesta de una foto (desde el bot o la app) ──────────────────────────────
  // body: { imageBase64, mime, origen:{tipo,chatId,usuario}, imagenInfo:{nombre} }
  router.post('/api/proveedores/ingest', ingestAuth, async (req, res) => {
    try {
      const { imageBase64, mime, origen = {}, imagenInfo = {} } = req.body || {};
      if (!imageBase64) return res.status(400).json({ ok: false, error: 'Falta imageBase64' });

      const [{ items: crudos }, indice] = await Promise.all([
        extraerDeImagen({ base64: imageBase64, mime: mime || 'image/jpeg' }),
        prov.getIndiceInferencia(),
      ]);

      if (!crudos.length) {
        return res.json({ ok: true, status: 'sin_datos', message: 'No se pudieron extraer productos de la imagen.' });
      }

      const items = procesarItems(crudos, indice);
      const conDudas = items.filter(it => it.dudas.length > 0);
      const limpios  = items.filter(it => it.dudas.length === 0);

      // Si TODO está claro → escribir directo.
      if (conDudas.length === 0) {
        const n = await prov.appendCompras(limpios);
        return res.json({
          ok: true, status: 'escrito',
          escritas: n, items: limpios,
          message: `${n} producto(s) cargado(s) sin dudas.`,
        });
      }

      // Hay dudas → crear pendiente. Lo que está limpio NO se escribe todavía:
      // se escribe junto al resto cuando el usuario resuelve (así una factura
      // queda atómica). Pero se marca cuál estaba ok.
      const reg = prov.crearPendiente({ origen, imagenInfo, items });
      return res.json({
        ok: true, status: 'pendiente',
        pendienteId: reg.id,
        total: items.length, conDudas: conDudas.length, limpios: limpios.length,
        items, // incluye dudas para que el bot/app pregunten
        message: `${conDudas.length} de ${items.length} producto(s) necesitan confirmación.`,
      });
    } catch (err) {
      console.error('Error /api/proveedores/ingest:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Listado de pendientes (panel de notificaciones) ──────────────────────────
  router.get('/api/proveedores/pendientes', authMiddleware, soloAdmin, (req, res) => {
    res.json({ ok: true, data: prov.listPendientes() });
  });
  router.get('/api/proveedores/pendientes/count', authMiddleware, soloAdmin, (req, res) => {
    res.json({ ok: true, count: prov.countPendientes() });
  });
  router.get('/api/proveedores/pendientes/:id', authMiddleware, soloAdmin, (req, res) => {
    const reg = prov.getPendiente(req.params.id);
    if (!reg) return res.status(404).json({ ok: false, error: 'Pendiente no encontrado' });
    res.json({ ok: true, data: reg });
  });

  // ─── Resolver un pendiente (confirmar/corregir → escribir) ────────────────────
  // body: { resoluciones: { [itemIdx]: { categoria?, medioPago?, producto?, precioUnit?, descartar? } } }
  // Acepta token de servicio (bot) o usuario.
  router.post('/api/proveedores/pendientes/:id/resolver', ingestAuth, async (req, res) => {
    try {
      const out = prov.aplicarResoluciones(req.params.id, (req.body && req.body.resoluciones) || {});
      if (!out) return res.status(404).json({ ok: false, error: 'Pendiente no encontrado' });

      if (out.faltan.length > 0) {
        return res.json({
          ok: true, status: 'incompleto',
          faltan: out.faltan, listos: out.listoParaEscribir.length,
          message: `Todavía faltan ${out.faltan.length} producto(s) por confirmar.`,
        });
      }

      const n = await prov.appendCompras(out.listoParaEscribir);
      prov.marcarResuelto(req.params.id);
      res.json({
        ok: true, status: 'escrito', escritas: n,
        items: out.listoParaEscribir,
        message: `${n} producto(s) cargado(s) en Compras.`,
      });
    } catch (err) {
      console.error('Error resolver pendiente:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/proveedores/pendientes/:id/descartar', ingestAuth, (req, res) => {
    prov.descartarPendiente(req.params.id);
    res.json({ ok: true, message: 'Pendiente descartado' });
  });

  // ─── Dashboard: productos + categorías ────────────────────────────────────────
  router.get('/api/proveedores/productos', authMiddleware, soloAdmin, async (req, res) => {
    try { res.json({ ok: true, data: await prov.getProductosYCategorias() }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ─── Dashboard: serie temporal de precio unitario ─────────────────────────────
  router.get('/api/proveedores/serie', authMiddleware, soloAdmin, async (req, res) => {
    try {
      const { producto, categoria, desde, hasta } = req.query;
      if (!producto) return res.status(400).json({ ok: false, error: 'Falta el parámetro producto' });
      res.json({ ok: true, data: await prov.getSerieProducto({ producto, categoria, desde, hasta }) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ─── Categorías disponibles (para selects del front) ──────────────────────────
  router.get('/api/proveedores/categorias', authMiddleware, soloAdmin, (req, res) => {
    res.json({ ok: true, data: cats.CATEGORIAS });
  });

  // ─── Normalizar categorías históricas (admin) ─────────────────────────────────
  router.post('/api/proveedores/normalizar-historico', authMiddleware, soloAdmin, async (req, res) => {
    try {
      const dryRun = String(req.query.aplicar || req.body?.aplicar || '') !== 'true';
      const out = await prov.normalizarHistoricoCategorias({ dryRun });
      res.json({ ok: true, data: out });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/api/proveedores/refresh', authMiddleware, soloAdmin, (req, res) => {
    prov.clearProvCache();
    res.json({ ok: true, message: 'Cache de proveedores limpiado.' });
  });

  return router;
};
