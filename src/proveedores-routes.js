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
const provCfg = require('./proveedores-config');

// Umbral de confianza por debajo del cual un campo se considera dudoso.
const UMBRAL = parseFloat(process.env.PROVEEDORES_UMBRAL_CONFIANZA || '0.6');

// Construye, para cada item extraído, la versión resuelta + dudas detectadas.
function procesarItems(itemsCrudos, indice) {
  return itemsCrudos.map(raw => {
    const resuelto = cats.resolverItem(raw, indice);
    const conf = raw.confianza || {};

    // Dudas SOLO por-item: categoría, producto, precio. El medio de pago y el IVA
    // se resuelven a nivel FACTURA (ver procesarFactura).
    const dudas = resuelto.dudas.filter(d => d.campo !== 'medioPago');
    const yaDuda = campo => dudas.some(d => d.campo === campo);

    if (resuelto.categoria && !yaDuda('categoria') && (conf.categoria ?? 1) < UMBRAL) {
      dudas.push({ campo: 'categoria', sugerido: resuelto.categoria, fuente: 'baja-confianza', opciones: cats.CATEGORIAS });
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
      descuento: raw.descuento_porcentaje != null && raw.descuento_porcentaje !== '' ? Number(raw.descuento_porcentaje) : null,
      total_linea: raw.total_linea != null ? Number(raw.total_linea) : null,
      ivaPct: raw.iva_porcentaje != null && raw.iva_porcentaje !== '' ? Number(raw.iva_porcentaje) : null,
      diasCredito: raw.dias_credito ?? 0,
      entregaOk: raw.entrega_ok || 'Sí',
      notas: raw.notas || '',
      dudas,
    };
  });
}

// Resuelve los datos a nivel FACTURA: medio de pago e IVA (con/sin) del proveedor.
// Consulta la hoja Proveedores (config): si ya sabemos el medio/IVA del proveedor,
// lo usamos; si no, queda como duda para preguntar UNA sola vez.
async function procesarFactura(factura, items) {
  const proveedor = (factura.proveedor || (items[0] && items[0].proveedor) || '').trim();
  const dudas = [];

  // Config conocida del proveedor (hoja Proveedores de Gestion Mercedes)
  let cfg = null;
  try { cfg = await provCfg.getProveedor(proveedor); } catch (e) { cfg = null; }

  // ── Medio de pago ──
  const fconf = factura.confianza || {};
  const fpRaw = (factura.forma_de_pago || '').toString().trim().toLowerCase();
  // "Contado" (y "Contado contra entrega") en una factura es un PLAZO/condición,
  // no el medio real con el que se pagó. Lo tratamos como ambiguo: por defecto
  // sugiere "Efectivo Local" pero SIEMPRE se pregunta (salvo medio del proveedor).
  const esContadoAmbiguo = fpRaw.includes('contado');
  let medioPago = cats.normalizarMedioPago(factura.forma_de_pago);

  // Si la factura no lo dice claro (o era "Contado") pero el proveedor tiene
  // medio habitual confirmado, usarlo y NO molestar.
  let medioDeProveedor = false;
  if ((!medioPago || esContadoAmbiguo || (fconf.forma_de_pago ?? 1) < UMBRAL) && cfg && cfg.medioPago) {
    const m = cats.normalizarMedioPago(cfg.medioPago);
    if (m && cats.MEDIOS_PAGO.includes(m)) { medioPago = m; medioDeProveedor = true; }
  }

  const necesitaConfirmar =
    !medioPago ||
    !cats.MEDIOS_PAGO.includes(medioPago) ||
    (esContadoAmbiguo && !medioDeProveedor) ||         // "Contado" sin medio del proveedor → preguntar
    ((fconf.forma_de_pago ?? 1) < UMBRAL && !medioDeProveedor);

  if (necesitaConfirmar) {
    dudas.push({
      campo: 'medioPago',
      sugerido: medioPago || (cfg && cats.normalizarMedioPago(cfg.medioPago)) || 'Efectivo Local',
      fuente: esContadoAmbiguo ? 'plazo-no-es-medio' : (cfg && cfg.medioPago ? 'proveedor-config' : 'ninguna'),
      opciones: cats.MEDIOS_PAGO,
    });
  }

  // ── IVA con/sin (atributo del proveedor) ──
  let iva = cfg && cfg.iva ? cfg.iva : null;  // 'con' | 'sin'
  if (!iva) {
    // No lo sabemos todavía → preguntar la primera vez para este proveedor.
    dudas.push({ campo: 'iva', sugerido: '', fuente: 'ninguna', opciones: ['con', 'sin'] });
  }

  return { proveedor, medioPago, iva, dudas };
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

      const [{ items: crudos, factura }, indice] = await Promise.all([
        extraerDeImagen({ base64: imageBase64, mime: mime || 'image/jpeg' }),
        prov.getIndiceInferencia(),
      ]);

      if (!crudos.length) {
        return res.json({ ok: true, status: 'sin_datos', message: 'No se pudieron extraer productos de la imagen.' });
      }

      // Normalizar el nombre del proveedor (alias). Ej: "Adicional 2015" o el
      // vendedor "Diego Wesenack" → "Thames". Se aplica a la factura y a cada item.
      const vendedor = (factura && factura.vendedor) || '';
      const provNombre = cats.normalizarProveedor(
        (factura && factura.proveedor) || (crudos[0] && crudos[0].proveedor) || '', vendedor);
      if (factura) factura.proveedor = provNombre;
      crudos.forEach(c => { c.proveedor = provNombre; });

      const items = procesarItems(crudos, indice);
      // Datos a nivel factura: medio de pago e IVA (con/sin) del proveedor.
      const fact = await procesarFactura(factura || {}, items);

      // Propagar el medio de pago (de la factura) a todos los items.
      if (fact.medioPago) items.forEach(it => { it.formaPago = fact.medioPago; });
      // Control E*G vs total leído: si difiere, anotarlo en notas (no bloquea).
      for (const it of items) {
        const chk = prov.chequearTotalLinea(it);
        if (!chk.ok && chk.diff != null) {
          const aviso = `⚠ Control: E×G=${Math.round((it.cantidad||0)*(it.precioUnit||0))} vs total factura ${it.total_linea} (dif ${chk.diff})`;
          it.notas = it.notas ? `${it.notas} · ${aviso}` : aviso;
        }
      }

      const itemDudas = items.filter(it => it.dudas.length > 0);
      const hayDudas = itemDudas.length > 0 || fact.dudas.length > 0;

      // Todo claro (items + factura) → escribir directo.
      if (!hayDudas) {
        const n = await prov.appendCompras(items);
        return res.json({
          ok: true, status: 'escrito',
          escritas: n, items,
          message: `${n} producto(s) cargado(s) sin dudas.`,
        });
      }

      // Hay dudas → crear pendiente (factura + items). No se escribe hasta resolver.
      const reg = prov.crearPendiente({ origen, imagenInfo, items, factura: fact });
      return res.json({
        ok: true, status: 'pendiente',
        pendienteId: reg.id,
        total: items.length, conDudas: itemDudas.length, limpios: items.length - itemDudas.length,
        factura: reg.factura, items,
        message: `Esta factura necesita confirmación${fact.dudas.length ? ' (medio de pago / IVA)' : ''}.`,
      });
    } catch (err) {
      console.error('Error /api/proveedores/ingest:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Listado de pendientes (panel de notificaciones) ──────────────────────────
  // Antes de listar, rehidratamos desde la hoja (sobreviven a los redeploys).
  router.get('/api/proveedores/pendientes', authMiddleware, soloAdmin, async (req, res) => {
    try { await prov.cargarPendientesPersistidos(); } catch (e) {}
    res.json({ ok: true, data: prov.listPendientes() });
  });
  router.get('/api/proveedores/pendientes/count', authMiddleware, soloAdmin, async (req, res) => {
    try { await prov.cargarPendientesPersistidos(); } catch (e) {}
    res.json({ ok: true, count: prov.countPendientes() });
  });
  router.get('/api/proveedores/pendientes/:id', authMiddleware, soloAdmin, async (req, res) => {
    try { await prov.cargarPendientesPersistidos(); } catch (e) {}
    const reg = prov.getPendiente(req.params.id);
    if (!reg) return res.status(404).json({ ok: false, error: 'Pendiente no encontrado' });
    res.json({ ok: true, data: reg });
  });

  // ─── Resolver un pendiente (confirmar/corregir → escribir) ────────────────────
  // body: { resoluciones: { [itemIdx]: { categoria?, medioPago?, producto?, precioUnit?, descartar? } } }
  // Acepta token de servicio (bot) o usuario.
  router.post('/api/proveedores/pendientes/:id/resolver', ingestAuth, async (req, res) => {
    try {
      try { await prov.cargarPendientesPersistidos(); } catch (e) {}
      const out = prov.aplicarResoluciones(req.params.id, (req.body && req.body.resoluciones) || {});
      if (!out) return res.status(404).json({ ok: false, error: 'Pendiente no encontrado' });

      if (out.faltan.length > 0) {
        return res.json({
          ok: true, status: 'incompleto',
          faltan: out.faltan, listos: out.listoParaEscribir.length,
          message: `Todavía faltan ${out.faltan.length} producto(s) por confirmar.`,
        });
      }

      // Aplicar el IVA del proveedor (con/sin) a los items según la resolución.
      const reg = prov.getPendiente(req.params.id);
      const ivaProv = reg && reg.factura && reg.factura.iva;  // 'con' | 'sin'
      // Si es "sin IVA", la columna % IVA queda 0; si "con", se respeta lo leído.
      for (const it of out.listoParaEscribir) {
        if (ivaProv === 'sin') it.ivaPct = 0;
      }
      const n = await prov.appendCompras(out.listoParaEscribir);
      prov.marcarResuelto(req.params.id);

      // Recordar el criterio de IVA del proveedor para la próxima vez.
      if (ivaProv && reg.factura.proveedor) {
        try { await provCfg.setIvaProveedor(reg.factura.proveedor, ivaProv); }
        catch (e) { console.warn('No se pudo guardar IVA del proveedor:', e.message); }
      }

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

  // ─── Stocks: productos (lista) y serie ingreso vs venta ───────────────────────
  const stocks = require('./stocks');
  router.get('/api/stocks/productos', authMiddleware, soloAdmin, async (req, res) => {
    try { res.json({ ok: true, data: await stocks.getProductosStock() }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  router.get('/api/stocks/serie', authMiddleware, soloAdmin, async (req, res) => {
    try {
      const { producto, categoria, desde, hasta } = req.query;
      if (!producto) return res.status(400).json({ ok: false, error: 'Falta el parámetro producto' });
      res.json({ ok: true, data: await stocks.getSerieStock({ producto, categoria, desde, hasta }) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  // Corrección manual del match producto↔venta FUDO
  router.post('/api/stocks/match', authMiddleware, soloAdmin, (req, res) => {
    const { producto, nombreFudo } = req.body || {};
    if (!producto || !nombreFudo) return res.status(400).json({ ok: false, error: 'Faltan producto y nombreFudo' });
    stocks.setMatchOverride(producto, nombreFudo);
    res.json({ ok: true, message: 'Match actualizado' });
  });

  return router;
};
