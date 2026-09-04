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
const { extraerCabecera, extraerItems } = require('./extractor');
const cats = require('./proveedores-categorias');
const provCfg = require('./proveedores-config');
const convo = require('./compra-conversacion');
const pedidos = require('./pedidos');
const facturasReg = require('./facturas');

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
    ivaPctSugerido, otrosImpuestos, subtotalFact, ivaMonto, dudas,
    // Para el gasto del libro
    totalGasto: totalSugerido, sumaLineas: redondear(sumaLineas), totalLeido: redondear(totalLeido),
    categoriaGasto, estadoGasto: '', diasCredito, fecha: factura.fecha || '',
    // ─── La identidad fiscal del comprobante ──────────────────────────────
    // Viaja para que el registro de facturas pueda escribirla y para poder
    // reconocer la MISMA factura si alguien la fotografía dos veces. No genera
    // ninguna pregunta: si la foto no la mostró, se registra sin ella.
    tipoComprobante: factura.tipo_comprobante || '',
    cuit: factura.cuit_proveedor || '',
    puntoVenta: factura.punto_venta || '',
    numero: factura.numero_comprobante || '' };
}

module.exports = function ({ authMiddleware, adminOnly, registrarGastoEnLibro, registrarCompra, buscarCompraParaFactura } = {}) {

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

  // ─── Confirmar la compra: acá se escribe todo ─────────────────────────────
  //
  // El orden importa y es el de siempre en este repo: primero la plata, después
  // el pedido, después el análisis. Cada paso que falla se INFORMA y no se
  // deshace — deshacer la fila del libro sería dejar plata sin registrar, y
  // callarse sería peor todavía.
  //
  //   1. los renglones (se esperan primero para saber cuántos son)
  //   2. `registrarCompra` → Movimientos y/o el pedido en Pedidos
  //   3. los renglones del pedido → Pedidos Items
  //   4. la hoja Compras
  //   5. la hoja Facturas — el comprobante y su crédito fiscal
  //   6. el aprendizaje del proveedor
  //
  // Sólo el 2 es imprescindible: si falla, no se hizo nada y se dice.
  //
  // ─── Y el paso 2 puede no existir (03/09/2026) ────────────────────────────
  //
  // Cuando la compra YA está anotada en el libro —la cargaron desde la app, o
  // llegó el pedido y se recibió— la foto no viene a escribir plata: viene a
  // aportar el comprobante, sus renglones y el IVA. Ahí el paso 2 se saltea
  // entero y el resto ocurre igual. Ver `soloFactura` en compra-conversacion.js.
  async function confirmarCompra(id, conv, req) {
    if (typeof registrarCompra !== 'function' && !conv.soloFactura) {
      return { ok: false, error: 'El servidor no tiene habilitada la carga de compras.' };
    }
    const reg = prov.getPendiente(id);
    const usuario = (reg && reg.origen && reg.origen.usuario) || 'bot';
    const avisos = [];

    // 1. Los renglones. Para acá casi siempre ya llegaron: la persona tardó más
    //    en contestar que el modelo en leer.
    const esp = await prov.esperarItems(id);
    const items = (esp.ok && reg ? (reg.items || []) : []).filter(it => !it.descartado);
    if (!esp.ok) avisos.push(`No se pudieron leer los productos (${esp.error}).`);
    const conItems = { ...conv, itemsCount: items.length };

    // 2. La plata y el pedido, por la MISMA función que usa el formulario de la
    //    app. Enganchada a una fila que ya existe, esto NO corre: volver a
    //    escribirla duplicaría el gasto del mes, que es exactamente lo que la
    //    pregunta del enganche existe para evitar.
    let out;
    const datos = conv.soloFactura ? null : convo.aDatosDeCompra(conItems, { usuario });
    if (conv.soloFactura) {
      const m = conv.movimiento || {};
      out = {
        ok: true, idCompra: m.idMovimiento || '', enElLibro: true, yaEstaba: true,
        pedido: null, aviso: '',
      };
      // El pedido de esa compra, si lo tuvo. Un id que empieza con `ped` es un
      // pedido; uno `cmp` es una compra sin entrega y no hay nada que buscar.
      if (/^ped/.test(out.idCompra)) {
        try {
          const p = await pedidos.getPedido(out.idCompra);
          if (p) out.pedido = p;
        } catch (e) { /* sin pedido no se pierde nada: los productos van a Compras igual */ }
      }
    } else {
      out = await registrarCompra(datos);
      if (!out.ok) return { ok: false, error: out.error };
      if (out.aviso) avisos.push(out.aviso);
    }

    // 3. Qué llega, para poder tildarlo en la puerta. Reemplaza al pegado manual
    //    de la imagen en la app: sale de la misma foto.
    //
    //    Enganchada a un pedido que YA tiene renglones, no se agrega nada: un
    //    remito nuevo SUMA filas y no las pisa (regla de `agregarItems`), así que
    //    volver a mandarlos duplicaría la lista que alguien ya está tildando.
    let itemsPedido = 0;
    if (out.pedido && items.length) {
      let yaTiene = 0;
      if (conv.soloFactura) {
        try { yaTiene = (await pedidos.itemsDe(out.pedido.id) || []).length; }
        catch (e) { yaTiene = -1; }   // no se pudo saber → no se toca
      }
      if (yaTiene > 0) {
        avisos.push(`El pedido ya tenía ${yaTiene} producto(s) cargados, así que no los volví a agregar.`);
      } else if (yaTiene < 0) {
        avisos.push('No pude ver si el pedido ya tenía productos, así que no le agregué ninguno.');
      } else {
        try {
          const creados = await pedidos.agregarItems(out.pedido.id, items.map(it => ({
            producto: it.producto, cantidad: it.cantidad, unidad: it.unidad, nota: '',
          })), { origen: 'remito' });
          itemsPedido = (creados || []).length;
        } catch (e) {
          avisos.push(`El pedido quedó sin la lista de productos (${e.message}). Se puede pegar el remito desde Operación › Pedidos.`);
        }
      }
    }

    // 4. La hoja Compras. Es análisis de costos: que falle no invalida nada de
    //    lo anterior, pero hay que decirlo porque ese renglón no se reescribe solo.
    let escritas = 0;
    if (items.length) {
      const iva = convo.ivaParaCompras(conItems);
      // Enganchada a una fila que ya existe no hay `datos`: la compra no se
      // vuelve a armar. El medio sale de esa fila, que es donde está escrito de
      // verdad — y puede estar vacío, porque una fila "A pagar" no lleva medio
      // hasta que se paga.
      const medio = datos
        ? datos.medioPago
        : ((conv.movimiento && conv.movimiento.medioPago) || '');
      for (const it of items) {
        it.formaPago = medio || it.formaPago || '';
        it.ivaPct = iva.ivaPct;
        it.ivaIncluido = iva.ivaIncluido;
      }
      try {
        escritas = await prov.appendCompras(items);
        prov.marcarEscritosYCerrar(id, items);
      } catch (e) {
        avisos.push(`Los productos no entraron en la hoja Compras (${e.message}).`);
      }
    }

    // 5. El COMPROBANTE. Compras responde "a qué precio compramos" y Movimientos
    //    "cuánta plata salió"; ninguna de las dos contesta "cuánto crédito IVA
    //    acumulamos este mes", que se computa por comprobante y no por renglón.
    //    Esta es la única hoja que lo contesta.
    //
    //    Va después de todo lo demás y no puede tumbar nada: `registrar` nunca
    //    tira. Que falle sólo cuesta cargar la factura a mano, y el aviso es lo
    //    que hace que alguien la cargue.
    const factura = await facturasReg.registrar(
      convo.aRegistroDeFactura(conItems, { usuario, origen: 'bot', idMovimiento: out.idCompra }));
    if (factura && !factura.ok) {
      avisos.push(`La factura no quedó en el registro de IVA (${factura.error}). Cargala desde Plan › Fiscal.`);
    }

    // 6. Lo que no se vuelve a preguntar. Que falle sólo cuesta una repregunta
    //    la próxima vez, así que nunca frena nada.
    try {
      const aprender = convo.aprendizajeDe(conItems);
      if (datos && datos.medioPago) aprender['Medio de Pago'] = datos.medioPago;
      Object.assign(aprender, await fiscalSiCorresponde(conItems));
      if (Object.keys(aprender).length) {
        await provCfg.setAtributosProveedor(conItems.proveedor, aprender);
      }
    } catch (e) {
      console.warn('No se pudo guardar el aprendizaje del proveedor:', e.message);
    }

    prov.marcarResuelto(id);

    return {
      ok: true, status: 'escrito',
      resumen: convo.armarResumen(conItems),
      enElLibro: out.enElLibro,
      // `yaEstaba` es lo que separa "lo anoté" de "ya estaba anotado". Sin este
      // campo el bot diría "quedó anotado en Movimientos" sobre una fila que
      // escribió otro, que es cierto y engañoso a la vez.
      yaEstaba: !!out.yaEstaba,
      pedido: out.pedido ? { id: out.pedido.id, fecha: out.pedido.fecha, items: itemsPedido } : null,
      escritas,
      // El crédito fiscal que aportó esta factura. `texto` viaja ya armado
      // porque el bot no formatea plata: sería una cuarta copia de esa regla.
      factura: factura && factura.ok
        ? { ok: true, yaExistia: !!factura.yaExistia,
            iva: (factura.desglose && factura.desglose.iva) || 0,
            computable: !!factura.computable,
            texto: textoDeFactura(factura) }
        : { ok: false, error: (factura && factura.error) || '', texto: '' },
      avisos,
    };
  }

  // Cómo se cuenta en el chat lo que quedó registrado del comprobante. Vive acá
  // y no en el bot porque `plata()` es la regla de formato del repo y el bot no
  // tiene ninguna: dibuja lo que la app le manda.
  function textoDeFactura(f) {
    if (!f || !f.ok) return '';
    if (f.yaExistia) return '🧾 Esa factura ya estaba en el registro de IVA.';
    const iva = (f.desglose && f.desglose.iva) || 0;
    if (f.computable && iva > 0) return `🅰️ Crédito IVA registrado: *${convo.plata(iva)}*.`;
    if (f.computable) return '🅰️ Factura registrada, pero sin el IVA: falta la alícuota.';
    return '🧾 Factura registrada (no da crédito IVA).';
  }

  // El padrón fiscal se siembra con lo que ya se preguntó, PERO nunca se pisa
  // una ficha que cargó una persona: `Fuente Fiscal = 'manual'` es la marca de
  // relevamiento a mano y gana siempre. Hoy 16 de 20 proveedores están sin
  // relevar, así que esto es lo que los va llenando solo.
  async function fiscalSiCorresponde(conv) {
    const nuevo = convo.fiscalDe(conv);
    if (!Object.keys(nuevo).length) return {};
    try {
      const todos = await provCfg.leerConfig();
      const ficha = (todos.byNombre || {})[provCfg.norm(conv.proveedor)];
      if (ficha && String(ficha.fuenteFiscal || '').toLowerCase() === 'manual') return {};
    } catch (e) { return {}; }
    // La fecha de acá, no la UTC: después de las 21:00 `toISOString()` ya está
    // en el día siguiente y el relevamiento quedaría fechado mañana.
    return { ...nuevo, 'Fuente Fiscal': 'bot', 'Fecha Relevamiento': pedidos.hoyAR() };
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
      const mimeOk = mime || 'image/jpeg';

      // ─── Las dos lecturas arrancan JUNTAS ────────────────────────────────
      //
      // La persona espera solamente la cabecera: con el proveedor y el total ya
      // se le puede hacer la primera pregunta. Los renglones tardan mucho más
      // —cada uno cuesta ~114 tokens de salida, y se generan de a uno— pero no
      // hacen falta hasta que termina de contestar.
      //
      // Antes se esperaban las dos cosas juntas y por eso una factura de siete
      // renglones tardaba 15 a 22 segundos en hacer la primera pregunta.
      const pItems = extraerItems({ base64: imageBase64, mime: mimeOk });
      // Que un rechazo sin nadie escuchándolo no tumbe el proceso: el error se
      // vuelve a mirar cuando alguien hace await sobre la promesa.
      pItems.catch(() => {});

      const [{ factura }, indice] = await Promise.all([
        extraerCabecera({ base64: imageBase64, mime: mimeOk }),
        prov.getIndiceInferencia(),
      ]);

      if (!factura || (!factura.proveedor && !(Number(factura.total_factura) > 0))) {
        return res.json({ ok: true, status: 'sin_datos', message: 'No se pudo leer la factura de la imagen.' });
      }

      // Normalizar el nombre del proveedor (alias). Ej: "Adicional 2015" o el
      // vendedor "Diego Wesenack" → "Thames".
      const vendedor = factura.vendedor || '';
      const provNombre = cats.normalizarProveedor(factura.proveedor || '', vendedor);
      factura.proveedor = provNombre;

      // Las preguntas de cabecera se arman SIN los renglones. La única que los
      // miraba era el cruce del total contra la suma de las líneas; con la
      // lectura partida se compara cuando llegan, y si no cierran queda anotado
      // en el pendiente para que se vea en el panel.
      const items = [];
      const fact = await procesarFactura(factura, items);

      // El pendiente nace SIN renglones y se contesta ya. Los renglones se le
      // enganchan cuando terminan de leerse.
      const reg = prov.crearPendiente({ origen, imagenInfo, items: [], factura: fact });
      prov.adjuntarItems(reg.id, pItems.then(({ items: crudos }) => {
        // Todo esto corría antes dentro del request, haciendo esperar a la
        // persona. Ahora corre mientras contesta.
        crudos.forEach(c => { c.proveedor = provNombre; });
        const procesados = procesarItems(crudos, indice);
        if (fact.medioPago) procesados.forEach(it => { it.formaPago = fact.medioPago; });
        procesados.forEach(it => {
          if (fact.descuentoIncluido != null) it.descIncluido = fact.descuentoIncluido;
          if (fact.ivaIncluido != null) it.ivaIncluido = fact.ivaIncluido;
        });
        aplicarOtroImpuesto(procesados, fact.otrosImpuestos);
        const hayDudaIva = (fact.dudas || []).some(d => d.campo === 'ivaPct');
        if (fact.ivaPctSugerido != null && !hayDudaIva) {
          procesados.forEach(it => { if (!(Number(it.ivaPct) > 0)) it.ivaPct = fact.ivaPctSugerido; });
        }
        // Control E*G vs total leído: si difiere, se anota en notas (no bloquea).
        for (const it of procesados) {
          const chk = prov.chequearTotalLinea(it);
          if (!chk.ok && chk.diff != null) {
            const aviso = `⚠ Control: E×G=${Math.round((it.cantidad || 0) * (it.precioUnit || 0))} vs total factura ${it.total_linea} (dif ${chk.diff})`;
            it.notas = it.notas ? `${it.notas} · ${aviso}` : aviso;
          }
        }
        return procesados;
      }));

      // ─── La conversación ────────────────────────────────────────────────
      //
      // El bot no decide qué preguntar: acá se arma el estado cruzando lo que
      // se leyó de la foto con lo que ya se sabe del proveedor, y se devuelve
      // el primer paso ya dibujado. Ver `compra-conversacion.js`.
      // ─── Las tres lecturas van JUNTAS ───────────────────────────────────
      //
      // La ficha del proveedor, si la compra ya está en el libro, y si esta
      // misma factura ya está registrada. Son tres planillas distintas y
      // ninguna depende de las otras: encadenarlas le sumaría dos idas y
      // vueltas a Google a la espera de la primera pregunta, que es justo el
      // tiempo que este circuito ya peleó una vez.
      //
      // ─── Por qué se pregunta ACÁ y no al confirmar ──────────────────────
      //
      // Si la compra ya está en el libro, la mitad de la conversación —el
      // medio, si está paga, cuándo llega, cuándo vence— no hay que hacerla:
      // ya está contestada en esa fila. Preguntarlo primero es lo que ahorra
      // esos toques, no un chequeo de más.
      //
      // Ninguna de las tres puede frenar la ingesta: todas leen planillas, y un
      // error de lectura no puede dejar una factura sin poder cargarse.
      const [cfg, enLibro, yaCargada] = await Promise.all([
        provCfg.leerConfig()
          .then(todos => (todos.byNombre || {})[provCfg.norm(provNombre)] || null)
          .catch(() => null),   // sin ficha se pregunta todo, que es lo correcto
        typeof buscarCompraParaFactura === 'function'
          ? buscarCompraParaFactura({
            proveedor: provNombre, fecha: factura.fecha, total: factura.total_factura,
          }).catch(() => null)
          : Promise.resolve(null),
        facturasReg.buscarPorClave(facturasReg.claveDe({
          proveedor: provNombre,
          comprobante: factura.tipo_comprobante,
          puntoVenta: factura.punto_venta,
          numero: factura.numero_comprobante,
        })).catch(() => null),
      ]);

      const conv = convo.estadoInicial({
        factura, cfg, proveedor: provNombre, pendienteId: reg.id,
        itemsCount: 0, enLibro, yaCargada,
      });
      prov.setConversacion(reg.id, conv);

      return res.json({
        ok: true, status: 'pendiente',
        pendienteId: reg.id,
        itemsEnCurso: true,
        factura: reg.factura, items: [],
        resumen: convo.armarResumen(conv),
        paso: convo.siguientePaso(conv),
        message: 'Leí la factura.',
      });
    } catch (err) {
      console.error('Error /api/proveedores/ingest:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Un paso de la conversación ──────────────────────────────────────────
  //
  // El bot manda el botón que se tocó y recibe el próximo paso. Toda la lógica
  // —qué se pregunta, en qué orden, qué se puede omitir— vive en
  // `compra-conversacion.js`, que es puro y se prueba sin Telegram.
  //
  // Cuando no falta nada y se confirma, acá se orquesta la escritura.
  router.post('/api/proveedores/pendientes/:id/paso', ingestAuth, async (req, res) => {
    try {
      await prov.cargarPendientesPersistidos();
      const id = req.params.id;
      let conv = prov.getConversacion(id);
      if (!conv) return res.status(404).json({ ok: false, error: 'Esa factura ya no está en curso. Mandá la foto de nuevo.' });

      const { campo, valor } = req.body || {};
      const r = convo.aplicarRespuesta(conv, { campo, valor });

      if (r.cancelar) {
        prov.descartarPendiente(id);
        return res.json({ ok: true, status: 'cancelado', message: 'Listo, no cargué nada.' });
      }
      if (r.error) {
        // El valor no se guarda: se repregunta el mismo paso con el error arriba.
        return res.json({
          ok: true, status: 'pregunta', error: r.error,
          resumen: convo.armarResumen(conv), paso: convo.siguientePaso(conv),
        });
      }

      conv = r.estado;
      prov.setConversacion(id, conv);

      const paso = convo.siguientePaso(conv);
      if (paso.tipo !== 'listo') {
        return res.json({ ok: true, status: 'pregunta', resumen: convo.armarResumen(conv), paso });
      }

      // Confirmado: se escribe.
      const out = await confirmarCompra(id, conv, req);
      return res.json(out);
    } catch (err) {
      console.error('Error /api/proveedores/pendientes/:id/paso:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── Empezar de cero con los proveedores ─────────────────────────────────
  //
  // Vacía SÓLO las columnas que fue creando el bot. `dryRun` es el default (el
  // mismo patrón que POST /api/movimientos/completar-tc): la primera llamada
  // dice qué se va a borrar y recién la segunda, con `dryRun:false`, borra —
  // después de dejar una copia de la hoja entera.
  //
  // adminOnly y NO ingestAuth: esto no lo dispara el bot.
  router.post('/api/proveedores/reset-aprendizaje', authMiddleware, soloAdmin, async (req, res) => {
    try {
      const dryRun = req.body && req.body.dryRun === false ? false : true;
      const r = await provCfg.resetAprendizaje({ dryRun });
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (err) {
      console.error('Error /api/proveedores/reset-aprendizaje:', err.message);
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

      // Los renglones se leen en paralelo con la cabecera y recién hacen falta
      // acá. Para este momento la persona ya contestó dos a cuatro preguntas, así
      // que casi siempre están listos y este await no espera nada.
      const listos = await prov.esperarItems(req.params.id);
      if (!listos.ok && listos.error && !/no encontrado/i.test(listos.error)) {
        return res.json({ ok: true, status: 'error_items', message: listos.error });
      }

      const out = prov.aplicarResoluciones(req.params.id, (req.body && req.body.resoluciones) || {});
      if (!out) return res.status(404).json({ ok: false, error: 'Pendiente no encontrado' });

      // SÓLO una duda de CABECERA frena. Las de renglón no.
      //
      // Dos cosas distintas que antes estaban mezcladas:
      //
      //  · Una duda de cabecera —el total, el medio de pago, si está pagada—
      //    frena todo, porque de eso depende la fila del libro. Ojo: antes acá
      //    se miraba sólo `faltan`, que son dudas de items; si lo único que
      //    faltaba era de cabecera, esto seguía de largo, escribía CERO
      //    productos y marcaba el pendiente como resuelto. La factura
      //    desaparecía sin cargarse.
      //
      //  · Una duda de RENGLÓN (un producto ilegible, un precio raro) ya no
      //    frena nada: el gasto se anota igual y ese renglón queda esperando en
      //    el panel de la app. Decisión del dueño — confirmar el nombre de un
      //    producto desde el teléfono es incómodo, y no tiene por qué demorar
      //    el registro de la plata, que es lo urgente.
      if (!out.facturaOk) {
        return res.json({
          ok: true, status: 'incompleto',
          faltan: out.faltan, facturaDudas: out.facturaDudas || [],
          listos: out.listoParaEscribir.length,
          message: `Falta confirmar de la factura: ${(out.facturaDudas || []).map(d => d.campo).join(', ')}.`,
        });
      }

      // Aplicar el IVA del proveedor (con/sin) a los items según la resolución.
      const reg = prov.getPendiente(req.params.id);
      const ivaProv = reg && reg.factura && reg.factura.iva;  // 'con' | 'sin'
      const fk = (reg && reg.factura) || {};
      // Si es "sin IVA", las columnas de IVA quedan VACÍAS (no en 0); si "con",
      // se respeta lo leído. Vacío es "esta compra no da crédito fiscal", que es
      // lo que significa una factura que no es A — ver el comentario de
      // `appendCompras`. Hasta el 02/09/2026 acá iba un 0, que en esta hoja
      // significa "sale cero" y no "no corresponde".
      for (const it of out.listoParaEscribir) {
        if (fk.descuentoIncluido != null) it.descIncluido = fk.descuentoIncluido;
        if (fk.ivaIncluido != null) it.ivaIncluido = fk.ivaIncluido;
        // Va último a propósito: "sin IVA" gana sobre lo que haya dicho la
        // cabecera. Si no hay alícuota, decir si está incluida no significa nada.
        if (ivaProv === 'sin') { it.ivaPct = null; it.ivaIncluido = null; }
      }
      const n = await prov.appendCompras(out.listoParaEscribir);
      // Los renglones que quedaron con dudas NO se pierden: el pendiente sigue
      // vivo con ellos y aparecen en el panel de la app. Los ya escritos quedan
      // marcados para que no se carguen dos veces si alguien resuelve el resto.
      const quedan = prov.marcarEscritosYCerrar(req.params.id, out.listoParaEscribir);

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

      // ─── Y el comprobante ────────────────────────────────────────────────
      //
      // Esta ruta es el panel de la app, no el bot: no pasa por la
      // conversación, así que no tiene la letra ni el número del comprobante —
      // el pendiente sólo guarda un subconjunto de lo leído. Se registra con lo
      // que SÍ hay, y `Computable` sale de `ivaDeducible`, que es la respuesta a
      // la misma pregunta ("¿esta factura sirve para descontar IVA?").
      //
      // Registrar de menos acá sería peor que registrar sin número: una factura
      // que no está deja su gasto en la lista de pendientes del mes para
      // siempre, y nadie sabe que ya se miró.
      const facturaReg = await facturasReg.registrar({
        fecha: fk.fecha || (out.listoParaEscribir[0] && out.listoParaEscribir[0].fecha) || '',
        proveedor: fk.proveedor,
        comprobante: fk.tipoComprobante,
        deducible: fk.ivaDeducible,
        cuit: fk.cuit,
        puntoVenta: fk.puntoVenta,
        numero: fk.numero,
        total: fk.totalGasto,
        alicuota: fk.ivaPct != null ? fk.ivaPct : fk.ivaPctSugerido,
        neto: fk.subtotalFact,
        iva: fk.ivaMonto,
        otrosImpuestos: fk.otrosImpuestos,
        // Es el mismo id que `escribirGastoDeFactura` pone en la columna H.
        idMovimiento: reg.id,
        origen: 'panel',
        usuario: (req.user && req.user.nombre) || (reg.origen && reg.origen.usuario) || 'bot',
      });

      res.json({
        ok: true, status: 'escrito', escritas: n,
        items: out.listoParaEscribir,
        gasto, factura: facturaReg, renglonesPendientes: quedan,
        message: `${n} producto(s) cargado(s) en Compras.`
          + (gasto && gasto.ok && !gasto.yaExistia ? ` Gasto de ${gasto.montoTexto} anotado en el libro.` : '')
          + (gasto && gasto.ok && gasto.yaExistia ? ' El gasto ya estaba anotado en el libro.' : '')
          + (gasto && !gasto.ok ? ` ⚠️ El gasto NO se anotó en el libro: ${gasto.error}` : '')
          + (quedan ? ` Quedaron ${quedan} producto(s) para confirmar en la app.` : ''),
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
