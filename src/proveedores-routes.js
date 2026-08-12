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
// Prorratea un monto de "Otro Impuesto" (de la factura) entre las líneas, en
// proporción al subtotal de cada una (cantidad × precioUnit). El total se conserva.
function aplicarOtroImpuesto(items, montoTotal) {
  const monto = Number(montoTotal) || 0;
  if (!monto || !items.length) return;
  const base = items.map(it => (Number(it.cantidad) || 0) * (Number(it.precioUnit) || 0));
  const suma = base.reduce((s, x) => s + x, 0);
  if (suma <= 0) { items[0].otroImpuesto = (items[0].otroImpuesto || 0) + monto; return; }
  let acum = 0;
  items.forEach((it, i) => {
    let parte = (i === items.length - 1)
      ? monto - acum                                  // última: el resto exacto
      : Math.round((base[i] / suma) * monto * 100) / 100;
    acum += parte;
    it.otroImpuesto = (Number(it.otroImpuesto) || 0) + parte;
  });
}

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
      unidadesPorPaquete: raw.unidades_por_paquete ?? raw.unidadesPorPaquete ?? null,
      precioUnit: Number(raw.precio_unitario) || null,
      descuento: raw.descuento_porcentaje != null && raw.descuento_porcentaje !== '' ? Number(raw.descuento_porcentaje) : null,
      total_linea: raw.total_linea != null ? Number(raw.total_linea) : null,
      otroImpuesto: (raw.otro_impuesto != null && raw.otro_impuesto !== '') ? Number(raw.otro_impuesto) : null,
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
  //
  // Desde que el medio también decide de qué CAJA sale la plata (columna L de
  // Movimientos), sólo sirve si es el nombre exacto de una caja. Lo guardado por
  // proveedor muchas veces no lo es: de 38 proveedores, 9 dicen "Mercado Pago
  // Tincho / Galicia" y uno dice "Todos". Eso es una pista para un humano, no un
  // dato — así que se usa para ARMAR LAS OPCIONES, no para responder solo.
  const opcionesDelProveedor = cats.opcionesDeMedioGuardado(cfg && cfg.medioPago);
  let medioDeProveedor = false;
  if ((!medioPago || esContadoAmbiguo || (fconf.forma_de_pago ?? 1) < UMBRAL)
      && opcionesDelProveedor.length === 1) {
    medioPago = opcionesDelProveedor[0];
    medioDeProveedor = true;
  }

  const necesitaConfirmar =
    !medioPago ||
    !cats.esMedioDeLibro(medioPago) ||                 // no es una caja → hay que preguntar sí o sí
    (esContadoAmbiguo && !medioDeProveedor) ||         // "Contado" sin medio del proveedor → preguntar
    ((fconf.forma_de_pago ?? 1) < UMBRAL && !medioDeProveedor);

  if (necesitaConfirmar) {
    // Las opciones del proveedor van PRIMERO: si la hoja dice "Mercado Pago
    // Tincho / Galicia", esas dos aparecen arriba y el resto abajo.
    const opciones = [...opcionesDelProveedor,
      ...cats.MEDIOS_LIBRO.filter(m => !opcionesDelProveedor.includes(m))];
    dudas.push({
      campo: 'medioPago',
      sugerido: cats.normalizarParaLibro(medioPago) || opcionesDelProveedor[0] || 'Efectivo Local',
      fuente: esContadoAmbiguo ? 'plazo-no-es-medio'
        : (opcionesDelProveedor.length > 1 ? 'proveedor-config' : (cfg && cfg.medioPago ? 'proveedor-config' : 'ninguna')),
      opciones,
      pregunta: opcionesDelProveedor.length > 1
        ? `A *${proveedor}* se le paga por ${opcionesDelProveedor.join(' o ')}. ¿Con cuál fue esta vez?`
        : undefined,
    });
  }

  // ── IVA con/sin (atributo del proveedor) ──
  let iva = cfg && cfg.iva ? cfg.iva : null;  // 'con' | 'sin'
  if (!iva) {
    // No lo sabemos todavía → preguntar la primera vez para este proveedor.
    dudas.push({ campo: 'iva', sugerido: '', fuente: 'ninguna', opciones: ['con', 'sin'] });
  }

  // ── Atributos fiscales del proveedor (se preguntan 1 vez y se recuerdan) ──
  // 1) ¿La factura sirve para descontar IVA? (deducible / pasar a Responsable Inscripto)
  // 2) ¿El descuento ya viene INCLUIDO en el precio de lista? (S → no se resta)
  // 3) ¿El IVA ya viene INCLUIDO en el precio? (S → no se suma)
  const ivaDeducible      = (cfg && cfg.ivaDeducible      != null) ? cfg.ivaDeducible      : null;
  const descuentoIncluido = (cfg && cfg.descuentoIncluido != null) ? cfg.descuentoIncluido : null;
  const ivaIncluido       = (cfg && cfg.ivaIncluido       != null) ? cfg.ivaIncluido       : null;
  if (ivaDeducible === null) {
    dudas.push({ campo: 'ivaDeducible', sugerido: '', fuente: 'ninguna', opciones: ['si', 'no'],
      pregunta: '¿Esta factura sirve para descontar IVA (es deducible)?' });
  }
  if (descuentoIncluido === null) {
    dudas.push({ campo: 'descuentoIncluido', sugerido: '', fuente: 'ninguna', opciones: ['si', 'no'],
      pregunta: '¿El descuento ya viene incluido en el precio de lista?' });
  }
  if (ivaIncluido === null) {
    dudas.push({ campo: 'ivaIncluido', sugerido: '', fuente: 'ninguna', opciones: ['si', 'no'],
      pregunta: '¿El IVA ya viene incluido en el precio?' });
  }

  // ── IVA en MONTO (pie de factura) → deducir el % y confirmar con el usuario ──
  // Si la factura trae el monto de IVA pero las líneas no tienen % (ej: Strange),
  // deducimos iva% = iva_monto / subtotal × 100 y sugerimos el valor para confirmar.
  const ivaMonto = Number(factura.iva_monto) || 0;
  const subtotalFact = Number(factura.subtotal_factura) || 0;
  const lineasSinIva = items.every(it => !(Number(it.ivaPct) > 0));
  let ivaPctSugerido = null;
  if (ivaMonto > 0 && subtotalFact > 0 && lineasSinIva) {
    const pct = (ivaMonto / subtotalFact) * 100;
    // Redondear a alícuota conocida si está cerca (21, 10.5, 27, 5, 2.5); si no, 1 decimal.
    const conocidas = [27, 21, 10.5, 5, 2.5];
    const cerca = conocidas.find(a => Math.abs(a - pct) <= 0.6);
    ivaPctSugerido = cerca != null ? cerca : Math.round(pct * 10) / 10;
    dudas.push({
      campo: 'ivaPct',
      sugerido: ivaPctSugerido,
      fuente: 'deducido-de-monto',
      opciones: [],
      pregunta: `La factura tiene IVA de $${Math.round(ivaMonto).toLocaleString('es-AR')} sobre un subtotal de $${Math.round(subtotalFact).toLocaleString('es-AR')}. ¿Confirmás un IVA del ${ivaPctSugerido}%?`,
    });
  }

  // ── El gasto que va al LIBRO (Movimientos) ────────────────────────────────
  //
  // Desde el 12/08/2026 una factura no sólo alimenta Compras: también deja una
  // fila de gasto en Movimientos con el total. Eso convierte "sacarle una foto a
  // la factura" en la forma rápida de anotar un gasto.
  //
  // Tres preguntas más, y ninguna es opcional por la misma razón: esta plata
  // entra al libro del negocio. Las dos primeras salen SIEMPRE; la tercera y el
  // medio de pago sólo la primera vez con cada proveedor.

  // 1) EL TOTAL. Lo lee el modelo de una foto, así que siempre se confirma con
  //    un toque. Se cruza contra la suma de las líneas —que es un dato
  //    independiente, extraído aparte— y si difieren se muestran las dos para
  //    que la persona elija, en vez de elegir nosotros.
  const totalLeido = Number(factura.total_factura) || 0;
  const sumaLineas = items.reduce((s, it) => {
    const base = (Number(it.cantidad) || 0) * (Number(it.precioUnit) || 0);
    const conDesc = it.descIncluido ? base : base * (1 - (Number(it.descuento) || 0) / 100);
    const conIva = it.ivaIncluido ? conDesc : conDesc * (1 + (Number(it.ivaPct) || 0) / 100);
    return s + conIva + (Number(it.otroImpuesto) || 0);
  }, 0);
  const redondear = n => Math.round(n);
  const totalSugerido = totalLeido > 0 ? redondear(totalLeido) : redondear(sumaLineas);
  const difere = totalLeido > 0 && sumaLineas > 0
    && Math.abs(totalLeido - sumaLineas) > Math.max(1, totalLeido * 0.01);

  const pesos = n => '$' + Math.round(n).toLocaleString('es-AR');
  const opcionesTotal = [];
  if (totalSugerido > 0) opcionesTotal.push(String(totalSugerido));
  if (difere && redondear(sumaLineas) !== totalSugerido) opcionesTotal.push(String(redondear(sumaLineas)));

  dudas.push({
    campo: 'totalGasto',
    sugerido: String(totalSugerido || ''),
    fuente: difere ? 'total-no-cierra' : (totalLeido > 0 ? 'total-de-factura' : 'suma-de-lineas'),
    opciones: opcionesTotal,
    pregunta: difere
      ? `⚠️ El total de la factura dice ${pesos(totalLeido)} pero las líneas suman ${pesos(sumaLineas)}. `
        + '¿Cuál es el gasto real? Este es el monto que entra al libro.'
      : `El gasto que voy a anotar en el libro es ${pesos(totalSugerido)}. ¿Está bien?`,
  });

  // 2) ¿YA ESTÁ PAGADA O QUEDA A PAGAR? Un toque más, pero deja el tema cerrado:
  //    si queda a pagar, aparece sola en la lista de Pagos con su vencimiento.
  const diasCredito = Number(factura.dias_credito) || (cfg && Number(cfg.plazoDias)) || 0;
  dudas.push({
    campo: 'estadoGasto',
    sugerido: diasCredito > 0 ? 'A pagar' : 'Pagado',
    fuente: diasCredito > 0 ? 'plazo-del-proveedor' : 'ninguna',
    opciones: ['Pagado', 'A pagar'],
    pregunta: diasCredito > 0
      ? `Esta factura tiene ${diasCredito} días de plazo. ¿Ya la pagaste o queda a pagar?`
      : '¿Ya está pagada o queda a pagar?',
  });

  // 3) CATEGORÍA DEL GASTO. No es la del producto (que es por ingrediente y va a
  //    Compras): es qué clase de gasto es para el negocio, y va en la columna J
  //    de Movimientos. Se pregunta una sola vez por proveedor y se recuerda.
  const categoriaGasto = (cfg && cats.normalizarCategoriaGasto(cfg.categoriaGasto)) || '';
  if (!categoriaGasto) {
    dudas.push({
      campo: 'categoriaGasto',
      sugerido: cats.normalizarCategoriaGasto(items[0] && items[0].categoria) || 'Mercaderia',
      fuente: 'ninguna',
      opciones: cats.CATEGORIAS_GASTO,
      pregunta: `¿En qué categoría entra el gasto de *${proveedor}*? Te lo pregunto una sola vez.`,
    });
  }

  const otrosImpuestos = Number(factura.otros_impuestos_monto) || 0;
  return { proveedor, medioPago, iva, ivaDeducible, descuentoIncluido, ivaIncluido,
    ivaPctSugerido, otrosImpuestos, subtotalFact, dudas,
    // Para el gasto del libro
    totalGasto: totalSugerido, sumaLineas: redondear(sumaLineas), totalLeido: redondear(totalLeido),
    categoriaGasto, estadoGasto: '', diasCredito, fecha: factura.fecha || '' };
}

module.exports = function ({ authMiddleware, adminOnly, registrarGastoEnLibro } = {}) {

  // Escribe en Movimientos el gasto de una factura ya confirmada.
  //
  // `registrarGastoEnLibro` lo inyecta server.js porque necesita cosas que viven
  // allá (la caja abierta, normalizarMedio, el cache). Si no viene —tests, o un
  // server viejo— esto no rompe: devuelve un aviso y el circuito de Compras
  // sigue funcionando exactamente como antes.
  //
  // NUNCA tira: un error escribiendo el gasto no puede perder los productos que
  // ya se cargaron en Compras.
  async function escribirGastoDeFactura(reg) {
    const f = (reg && reg.factura) || {};
    if (typeof registrarGastoEnLibro !== 'function') {
      return { ok: false, error: 'el servidor no tiene habilitada la escritura en el libro' };
    }
    const monto = Number(f.totalGasto) || 0;
    if (!(monto > 0)) return { ok: false, error: 'no hay un total confirmado' };

    const nProd = (reg.items || []).filter(it => !it.descartado).length;
    try {
      const r = await registrarGastoEnLibro({
        // El id del pendiente es la clave de idempotencia: reintentar la misma
        // confirmación no puede duplicar el gasto.
        facturaId: reg.id,
        fecha: f.fecha || (reg.items && reg.items[0] && reg.items[0].fecha) || '',
        proveedor: f.proveedor,
        categoria: f.categoriaGasto || 'Otros',
        monto,
        descripcion: `Factura ${f.proveedor}${nProd ? ` · ${nProd} producto${nProd > 1 ? 's' : ''}` : ''}`,
        medioPago: f.medioPago,
        estado: f.estadoGasto || 'Pagado',
        vencimiento: vencimientoDe(f),
        usuario: (reg.origen && reg.origen.usuario) || 'bot',
      });
      return { ...r, montoTexto: '$' + Math.round(monto).toLocaleString('es-AR') };
    } catch (e) {
      console.error('No se pudo anotar el gasto en el libro:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // Si queda a pagar, el vencimiento sale de los días de plazo contra la fecha
  // de la factura. Sin plazo conocido no se inventa uno: la fila queda "A pagar"
  // sin vencimiento y aparece igual en la lista de Pagos.
  function vencimientoDe(f) {
    const dias = Number(f.diasCredito) || 0;
    if ((f.estadoGasto || '') !== 'A pagar' || dias <= 0) return '';
    const base = (f.fecha || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = base ? new Date(Number(base[1]), Number(base[2]) - 1, Number(base[3])) : new Date();
    d.setDate(d.getDate() + dias);
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  }

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
      // Propagar atributos fiscales (booleans) a cada item para appendCompras.
      const _aplicarFiscales = (lista, fk) => lista.forEach(it => {
        if (fk.descuentoIncluido != null) it.descIncluido = fk.descuentoIncluido;
        if (fk.ivaIncluido != null) it.ivaIncluido = fk.ivaIncluido;
      });
      _aplicarFiscales(items, fact);
      // Prorratear "Otro Impuesto" (monto de factura) por el subtotal de cada línea.
      aplicarOtroImpuesto(items, fact.otrosImpuestos);
      // Si la factura traía IVA en monto y no hay duda pendiente de ivaPct, aplicar el %.
      const _hayDudaIva = (fact.dudas || []).some(d => d.campo === 'ivaPct');
      if (fact.ivaPctSugerido != null && !_hayDudaIva) {
        items.forEach(it => { if (!(Number(it.ivaPct) > 0)) it.ivaPct = fact.ivaPctSugerido; });
      }
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
      //
      // OJO: desde el 12/08/2026 este camino en la práctica no se toma nunca,
      // y es a propósito. `procesarFactura` siempre agrega dos dudas de cabecera
      // —el total del gasto y si está pagada o a pagar— porque desde que la
      // factura también deja una fila en el libro, ningún gasto entra sin que una
      // persona lo haya mirado. Decisión del dueño, tomada sabiendo que cuesta un
      // toque más por factura.
      //
      // Se deja el camino en pie igual: si algún día se decide que un proveedor
      // ya aprendido pueda escribir solo, alcanza con no empujar esas dudas.
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

      // Una duda de CABECERA sin resolver también deja el pendiente incompleto.
      //
      // Antes sólo se miraba `faltan`, que son dudas de items: si lo único que
      // quedaba era una duda de factura, `faltan` venía vacío, `listoParaEscribir`
      // también (porque lo bloquea `facturaOk`), y esto seguía de largo hasta
      // escribir CERO productos y marcar el pendiente como resuelto. La factura
      // desaparecía sin haberse cargado nunca.
      //
      // Con las preguntas del gasto —total, estado, categoría, medio— que son
      // todas de cabecera, ese agujero pasaría a ser el camino normal.
      if (out.faltan.length > 0 || !out.facturaOk) {
        const pendientesCabecera = (out.facturaDudas || []).map(d => d.campo);
        return res.json({
          ok: true, status: 'incompleto',
          faltan: out.faltan, facturaDudas: out.facturaDudas || [],
          listos: out.listoParaEscribir.length,
          message: out.faltan.length > 0
            ? `Todavía faltan ${out.faltan.length} producto(s) por confirmar.`
            : `Falta confirmar de la factura: ${pendientesCabecera.join(', ')}.`,
        });
      }

      // Aplicar el IVA del proveedor (con/sin) a los items según la resolución.
      const reg = prov.getPendiente(req.params.id);
      const ivaProv = reg && reg.factura && reg.factura.iva;  // 'con' | 'sin'
      const fk = (reg && reg.factura) || {};
      // Si es "sin IVA", la columna % IVA queda 0; si "con", se respeta lo leído.
      for (const it of out.listoParaEscribir) {
        if (ivaProv === 'sin') it.ivaPct = 0;
        if (fk.descuentoIncluido != null) it.descIncluido = fk.descuentoIncluido;
        if (fk.ivaIncluido != null) it.ivaIncluido = fk.ivaIncluido;
      }
      const n = await prov.appendCompras(out.listoParaEscribir);
      prov.marcarResuelto(req.params.id);

      // ─── Lo que aprende del proveedor, TODO junto ────────────────────────
      //
      // Antes eran seis llamadas —IVA, medio, categoría de gasto y los tres
      // atributos fiscales—, cada una con su propia lectura de la hoja y su
      // escritura: unas 14 idas y vueltas a Google, más de 4 segundos de espera.
      // Y a partir de la segunda factura de un proveedor reescribían exactamente
      // los mismos valores.
      //
      // Ahora es una sola lectura y una sola escritura con lo que de verdad
      // cambió. En una factura repetida no escribe nada.
      //
      // El medio se guarda con el nombre EXACTO de la caja que eligió la
      // persona: así un "Mercado Pago Tincho / Galicia" —que hay que preguntar
      // siempre porque son dos— se vuelve un valor concreto la primera vez que
      // alguien contesta, y deja de preguntarse.
      if (reg.factura.proveedor) {
        const sn = b => (b ? 'S' : 'N');
        const aprender = {};
        if (ivaProv) aprender['IVA'] = ivaProv === 'con' ? 'Con IVA' : 'Sin IVA';
        const medioProv = cats.normalizarParaLibro(reg.factura.medioPago);
        if (medioProv) aprender['Medio de Pago'] = medioProv;
        if (reg.factura.categoriaGasto) aprender['Categoria Gasto'] = reg.factura.categoriaGasto;
        if (fk.ivaDeducible != null) aprender['IVA Deducible'] = sn(fk.ivaDeducible);
        if (fk.descuentoIncluido != null) aprender['Descuento Incluido'] = sn(fk.descuentoIncluido);
        if (fk.ivaIncluido != null) aprender['IVA Incluido'] = sn(fk.ivaIncluido);
        try { await provCfg.setAtributosProveedor(reg.factura.proveedor, aprender); }
        catch (e) { console.warn('No se pudo guardar lo aprendido del proveedor:', e.message); }
      }

      // ─── Y el gasto en el libro ─────────────────────────────────────────
      // Compras responde "a qué precio compramos"; Movimientos responde "cuánta
      // plata salió y de qué caja". Son dos preguntas distintas y por eso son
      // dos escrituras, pero pasan a ocurrir juntas: sacar la foto ahora también
      // anota el gasto.
      //
      // Va DESPUÉS de appendCompras y no puede tumbar la respuesta: si falla, los
      // productos ya quedaron cargados y el aviso dice qué pasó, en vez de perder
      // las dos cosas.
      const gasto = await escribirGastoDeFactura(reg);

      res.json({
        ok: true, status: 'escrito', escritas: n,
        items: out.listoParaEscribir,
        gasto,
        message: `${n} producto(s) cargado(s) en Compras.`
          + (gasto && gasto.ok && !gasto.yaExistia ? ` Gasto de ${gasto.montoTexto} anotado en el libro.` : '')
          + (gasto && gasto.ok && gasto.yaExistia ? ' El gasto ya estaba anotado en el libro.' : '')
          + (gasto && !gasto.ok ? ` ⚠️ El gasto NO se anotó en el libro: ${gasto.error}` : ''),
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
      await stocks.cargarMatchOverrides().catch(() => {});
      res.json({ ok: true, data: await stocks.getSerieStock({ producto, categoria, desde, hasta }) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  // Serie agregada de toda una categoría (sin elegir producto)
  router.get('/api/stocks/serie-categoria', authMiddleware, soloAdmin, async (req, res) => {
    try {
      const { categoria, desde, hasta } = req.query;
      if (!categoria) return res.status(400).json({ ok: false, error: 'Falta el parámetro categoria' });
      res.json({ ok: true, data: await stocks.getSerieCategoria({ categoria, desde, hasta }) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  // Lista de productos FUDO del periodo + el override actual de un insumo (para la UI).
  router.get('/api/stocks/fudo-productos', authMiddleware, soloAdmin, async (req, res) => {
    try {
      const { desde, hasta, producto } = req.query;
      await stocks.cargarMatchOverrides().catch(() => {});
      const fudoProductos = await stocks.listarProductosFudo({ desde, hasta });
      const actual = producto ? stocks.getMatchOverride(producto) : [];
      res.json({ ok: true, data: { fudoProductos, actual } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Corrección manual del match insumo↔venta(s) FUDO. Acepta uno o varios nombres.
  // Body: { producto, nombresFudo: [..] }  (nombreFudo string sigue soportado).
  router.post('/api/stocks/match', authMiddleware, soloAdmin, async (req, res) => {
    try {
      const { producto, nombresFudo, nombreFudo } = req.body || {};
      const lista = Array.isArray(nombresFudo) ? nombresFudo : (nombreFudo ? [nombreFudo] : []);
      if (!producto) return res.status(400).json({ ok: false, error: 'Falta el producto' });
      await stocks.setMatchOverride(producto, lista);
      res.json({ ok: true, message: lista.length ? 'Match actualizado' : 'Match eliminado' });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  return router;
};
