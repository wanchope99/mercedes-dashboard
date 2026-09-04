// ─── La conversación de cargar una compra desde una foto ────────────────────
//
// Sacarle una foto a la factura tiene que ser el equivalente de "Nueva compra"
// en la app. Este módulo es LA CONVERSACIÓN: qué se pregunta, en qué orden, con
// qué botones, y qué payload sale al final.
//
// ─── Por qué vive acá y no en el bot (02/09/2026) ───────────────────────────
//
// Hasta hoy la lógica estaba partida: el servidor armaba las dudas y `bot.py`
// decidía el orden, armaba la cola y traducía las etiquetas. Se desincronizaron
// —el bot muestra "Leí None producto(s)" porque lee un campo que el servidor no
// manda— y esa es la falla que se arregla moviendo la decisión a un solo lado.
//
// Además, y es la razón que manda: en la máquina donde se desarrolla esto NO hay
// Python. Todo lo que quede en `bot.py` no se puede ejecutar ni chequear; todo
// lo que esté acá se recorre entero en Node, sin credenciales y sin modelo.
//
// Por eso este archivo es PURO Y SINCRÓNICO: no lee planillas, no llama al
// modelo, no mira el reloj salvo por `hoyAR()`. Mismo patrón que
// `calcularReparto` en Propinas y `calcularBaselines` en Nómina.
//
// El bot no decide nada: pide un paso, lo dibuja, y devuelve el botón que se
// tocó.

const pedidos = require('./pedidos');
const cats = require('./proveedores-categorias');
const facturas = require('./facturas');
const { parseMonto } = require('./monto');

// ─── Qué categorías tienen una puerta donde recibir ─────────────────────────
//
// Las mismas seis que llevan `data-entrega` en el formulario de la app. Un
// alquiler o un VEP no se reciben en ningún lado, así que a esos no se les
// pregunta cuándo llegan.
//
// Es una copia de una lista que en la app vive en el HTML. Se copia y no se
// importa porque el HTML no es un módulo; si se toca una, van las dos.
const CATEGORIAS_CON_ENTREGA = ['Mercaderia', 'Cocina', 'Mobiliario', 'Sala', 'Frios', 'Insumos'];

// Domingo y lunes no entrega nadie: los atajos de fecha los saltean. Es la misma
// constante que `SIN_ENTREGA` en el navegador.
const SIN_ENTREGA = [0, 1];

// Las alícuotas que se ofrecen como botón. La guía es del dueño: carnes y
// verduras 10,5; el resto 21; algunos servicios como la luz, 27.
const ALICUOTAS = [21, 10.5, 27];

// Los medios que se ofrecen al decir "ya lo pagué". Es `MEDIOS_LIBRO`, que ya
// está ordenado por uso real y son todos nombres exactos de caja — la condición
// para que el SUMIFS de la hoja Cajas los vea.
const MEDIOS = cats.MEDIOS_LIBRO;

// Cuánta diferencia de confianza tolera el total antes de preguntarlo. El total
// es la plata que se registra: es el único campo que se repregunta por dudar.
const CONFIANZA_MINIMA_TOTAL = 0.7;

// ═══════════════════════════════════════════════════════════════════════════
// El estado
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arma el estado inicial cruzando lo que se leyó de la foto con lo que ya se
 * sabe del proveedor.
 *
 * `factura` es lo que devuelve `extractor.extraerCabecera`.
 * `cfg` es la ficha del proveedor (`proveedores-config.leerConfig().byNombre[x]`),
 * o null si es un proveedor que nunca pasó por acá.
 */
function estadoInicial({
  factura = {}, cfg = null, proveedor = '', itemsCount = 0, pendienteId = '',
  // Lo que se encontró antes de empezar a preguntar. Los dos vienen de afuera
  // porque leen planillas y este archivo no lee ninguna.
  //   · `enLibro`    → salida de `facturas.buscarCompraEnLibro`: filas del libro
  //                    que podrían ser esta misma compra.
  //   · `yaCargada`  → la factura YA registrada con este mismo número.
  enLibro = null, yaCargada = null,
} = {}) {
  const conf = factura.confianza || {};
  const tipo = factura.tipo_comprobante || '';

  // Deducible ⟺ es factura A. Es la regla del dueño y no admite deducción de
  // otra cosa: un IVA discriminado en una factura B no da crédito fiscal.
  //
  // `null` es "no se sabe" y dispara la pregunta. Sólo se afirma cuando la
  // letra se leyó de verdad: ni el IVA ni el CUIT alcanzan para deducirla.
  let deducible = null;
  if (tipo === 'A' || tipo === 'M') deducible = true;
  else if (tipo === 'B' || tipo === 'C' || tipo === 'X') deducible = false;

  // Lo que el proveedor ya contestó alguna vez gana sobre lo que se dedujo de
  // la foto sólo cuando la foto no dijo nada.
  if (deducible === null && cfg && cfg.ivaDeducible != null) deducible = cfg.ivaDeducible;

  const fecha = factura.fecha || pedidos.hoyAR();
  const categoria = (cfg && cfg.categoriaGasto) || '';

  const e = {
    pendienteId,
    // ─── Lo leído ───
    proveedor: proveedor || factura.proveedor || '',
    fecha,
    total: numeroONull(factura.total_factura),
    tipoComprobante: tipo,
    cuit: factura.cuit_proveedor || '',
    itemsCount,
    confianzaTotal: conf.total_factura == null ? 1 : Number(conf.total_factura),

    // ─── La identidad fiscal del comprobante ───────────────────────────────
    //
    // El punto de venta y el número son lo único que identifica una factura sin
    // ambigüedad: dos facturas distintas no pueden compartirlo y la misma
    // re-fotografiada siempre lo comparte. No se pregunta nunca — si la foto no
    // lo mostró, se registra sin él y la factura se identifica por la fila del
    // libro a la que se enganchó.
    puntoVenta: factura.punto_venta || '',
    numero: factura.numero_comprobante || '',
    // El pie de la factura, tal como se leyó. Sirve para no recalcular lo que el
    // comprobante ya dice — ver `facturas.desglosar`, que los prefiere sobre la
    // cuenta pero sólo cuando cierran contra el total.
    subtotalLeido: numeroONull(factura.subtotal_factura),
    ivaMontoLeido: numeroONull(factura.iva_monto),
    otrosImpuestos: numeroONull(factura.otros_impuestos_monto) || 0,

    // ─── Lo que hay que definir ───
    deducible,
    ivaPct: deducible === true ? alicuotaDe(factura, cfg) : null,
    // Si la factura discrimina el IVA, no está incluido en el precio. Es la
    // misma pregunta dicha al revés, así que no hace falta hacerla.
    ivaIncluido: deducible === true ? ivaIncluidoDe(factura, cfg) : null,
    categoria,
    estaPago: null,
    medioPago: '',
    pagaAlLlegar: null,
    entregaFecha: null,        // null = no se preguntó · '' = no lleva entrega
    vencimiento: '',

    // ─── Contexto que no se pregunta ───
    proveedorConocido: !!cfg,
    diasCredito: (cfg && cfg.plazoDias) || Number(factura.dias_credito) || 0,
    medioSugerido: (cfg && cfg.medioPago) || '',
    // Qué se propuso solo, para poder decirlo en el resumen. Lo propuesto se
    // confirma o se cambia; nada de esto se escribe sin que alguien lo mire.
    propuesto: [],

    // ─── Lo que ya estaba cargado ──────────────────────────────────────────
    //
    // `yaCargada` es la MISMA factura (mismo número) ya registrada. Es un
    // rechazo, no una rama: lo único que puede pasar es cancelar o insistir.
    yaCargada: yaCargada || null,
    yaCargadaOk: false,
    // `duplicado` es la misma COMPRA ya anotada en Movimientos, por otro
    // camino: la cargaron en la app, o llegó el pedido y se recibió. Acá no se
    // cancela nada: se carga la factura y sus productos SIN volver a escribir
    // la plata. Ver el bloque del paso 0b en `siguientePaso`.
    duplicado: enLibro && enLibro.mejor ? enLibro : null,
    duplicadoOk: false,
    // Cuando alguien dice "sí, es esa fila": la compra ya está en el libro y
    // esta foto sólo aporta el comprobante, sus renglones y el IVA.
    soloFactura: false,
    movimiento: null,

    confirmado: false,
  };

  return conPropuestaDePago(e, cfg);
}

/**
 * Rellena el bloque del pago con lo que ese proveedor viene siendo, para que la
 * compra se confirme de un toque.
 *
 * Esto NO viola la regla de que `pagoPrevisto` nunca se inventa. Inventar sería
 * escribir un valor en silencio; acá el valor se muestra en el resumen y se
 * confirma a propósito, con "Cambiar pago" al lado. La diferencia es que alguien
 * lo miró.
 *
 * Sin hábito guardado —y después del borrado del aprendizaje, ningún proveedor
 * lo tiene— no se propone nada y las preguntas se hacen de verdad.
 */
function conPropuestaDePago(e, cfg) {
  const hab = cfg && cfg.pagoHabitual;
  if (!hab || !e.categoria) return e;

  const conEntrega = CATEGORIAS_CON_ENTREGA.includes(e.categoria);
  const prox = conEntrega ? (atajosDeEntrega(e.fecha, 1)[0] || {}).valor || null : '';

  if (hab === 'pagado') {
    // Sin medio guardado no se propone nada: un gasto pagado que no dice de qué
    // caja salió es plata que ningún saldo resta.
    if (!e.medioSugerido) return e;
    e.estaPago = true;
    e.medioPago = e.medioSugerido;
    e.entregaFecha = prox;
    e.propuesto = ['pago', ...(conEntrega ? ['entrega'] : [])];
    return e;
  }

  if (hab === 'al-recibir') {
    if (!conEntrega) return e;   // sin puerta no hay "al recibir"
    e.estaPago = false;
    e.pagaAlLlegar = true;
    e.entregaFecha = prox;
    e.propuesto = ['pago', 'entrega'];
    return e;
  }

  if (hab === 'a-pagar') {
    e.estaPago = false;
    e.pagaAlLlegar = false;
    e.entregaFecha = prox;
    // Sin plazo cargado no hay vencimiento que proponer: proponer el día de la
    // compra sería inventar una deuda que vence hoy. Se pregunta.
    if (e.diasCredito > 0) e.vencimiento = vencimientoSugerido(e);
    e.propuesto = ['pago', ...(conEntrega ? ['entrega'] : [])];
    return e;
  }

  return e;
}

function numeroONull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseMonto(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// La alícuota: la que discrimina la factura, o la que ya contestaron para ese
// proveedor. Nunca se inventa una — si no hay ninguna, se pregunta.
function alicuotaDe(factura, cfg) {
  const sub = Number(factura.subtotal_factura);
  const iva = Number(factura.iva_monto);
  if (sub > 0 && iva > 0) {
    const pct = (iva / sub) * 100;
    // Redondear a una alícuota conocida sólo si está cerca: si la cuenta da
    // 14,7% no es ninguna de las tres y hay que preguntar.
    const cerca = [27, 21, 10.5, 5, 2.5].find(a => Math.abs(a - pct) <= 0.6);
    if (cerca != null) return cerca;
  }
  return null;
}

function ivaIncluidoDe(factura, cfg) {
  if (typeof factura.iva_discriminado === 'boolean') return !factura.iva_discriminado;
  if (cfg && cfg.ivaIncluido != null) return cfg.ivaIncluido;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Lo que se deriva del estado
// ═══════════════════════════════════════════════════════════════════════════

/** ¿La categoría elegida tiene una puerta donde recibir? */
function llevaEntrega(estado) {
  return CATEGORIAS_CON_ENTREGA.includes(estado.categoria);
}

/**
 * Las tres respuestas del modelo de pago, derivadas de dos preguntas que una
 * persona sí puede contestar: ¿ya lo pagaste? y ¿lo pagás cuando llegue?
 *
 * Devuelve null mientras no alcance para decidir — nunca un default. Que
 * `pagoPrevisto` no se invente es una regla del repo: es la intención de quien
 * compra, y escribir una que nadie dijo es exactamente lo que hace que la
 * columna deje de ser creíble.
 */
function pagoPrevistoDe(estado) {
  if (estado.estaPago === true) return 'pagado';
  if (estado.estaPago !== false) return null;
  // No está pago. Si hay entrega, falta saber si se paga en la puerta.
  if (estado.entregaFecha) {
    if (estado.pagaAlLlegar === true) return 'al-recibir';
    if (estado.pagaAlLlegar === false) return 'a-pagar';
    return null;
  }
  // Sin entrega no hay puerta donde pagar: queda a pagar y listo.
  if (estado.entregaFecha === '') return 'a-pagar';
  return null;
}

/** El vencimiento que se propone: la fecha de la compra + el plazo del proveedor. */
function vencimientoSugerido(estado) {
  const dias = Number(estado.diasCredito) || 0;
  return sumarDias(estado.fecha, dias);
}

// Suma días a una fecha 'YYYY-MM-DD'. Se ancla al MEDIODÍA UTC —el mismo truco
// que `_aDate` en pedidos.js— para que ningún corrimiento de zona horaria tire
// el resultado al día anterior. Acá el `toISOString()` es seguro justamente por
// eso: la hora es 12:00 y no la del reloj.
function sumarDias(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Los atajos de fecha de entrega: hoy, mañana y los próximos días en que
 * alguien entrega, salteando domingo y lunes.
 *
 * Se arman con la fecha local de Argentina y NUNCA con `toISOString()` sobre la
 * hora actual: ese bug ya se pagó una vez — después de las 21:00 cada atajo
 * apuntaba un día más adelante que su propia etiqueta.
 */
function atajosDeEntrega(desdeISO, cuantos = 4) {
  const base = desdeISO || pedidos.hoyAR();
  const out = [];
  for (let i = 0; out.length < cuantos && i <= 14; i++) {
    const f = sumarDias(base, i);
    if (!f) break;
    const dow = new Date(`${f}T12:00:00Z`).getUTCDay();
    // Hoy y mañana se ofrecen aunque caigan domingo o lunes: el filtro dice que
    // nadie entrega esos días COMO RUTINA, y no tiene nada que decir sobre un
    // proveedor que está en la puerta un lunes.
    if (i > 1 && SIN_ENTREGA.includes(dow)) continue;
    out.push({
      valor: f,
      label: i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : capitalizar(pedidos.diaSemanaDe(f)),
    });
  }
  return out;
}

function capitalizar(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ═══════════════════════════════════════════════════════════════════════════
// Los pasos
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El próximo paso de la conversación.
 *
 * Devuelve `{ tipo, campo, texto, botones, permiteTexto }`:
 *   · tipo 'pregunta'  → falta un dato; los botones lo contestan.
 *   · tipo 'confirmar' → no falta nada; se muestra todo y se confirma.
 *   · tipo 'listo'     → ya se confirmó, no hay más que preguntar.
 *
 * El orden es el de la tabla del plan y no es arbitrario: primero lo que decide
 * cómo se escribe la compra (IVA, total, categoría) y al final lo que decide
 * cuándo sale la plata, que es lo que depende de la categoría.
 */
function siguientePaso(estado) {
  const e = estado;

  // ─── 0a. Esta MISMA factura ya está registrada ───────────────────────────
  //
  // Mismo proveedor, misma letra, mismo punto de venta y mismo número: es el
  // comprobante, no una compra parecida. Acá no hay nada que decidir, así que no
  // se ofrece enganchar nada: o se cancela, o alguien afirma que el número se
  // leyó mal. Cancelar va primero porque es lo que casi siempre corresponde.
  if (e.yaCargada && !e.yaCargadaOk) {
    const y = e.yaCargada;
    return paso('yaCargada',
      `🧾 La factura *${nroComprobante(e)}* de *${e.proveedor}* ya está registrada `
      + `(${plata(y.total)} del ${fechaCorta(y.fecha)}).\n\n`
      + 'Si le sacaste la foto de nuevo, no hay nada que hacer.',
      [
        { id: 'cancelar', label: '🚫 Listo, no cargues nada', sugerido: true },
        { id: 'igual', label: 'Es otra factura, seguí' },
      ]);
  }

  // ─── 0b. Esta COMPRA ya está en el libro ─────────────────────────────────
  //
  // La plata ya se anotó por otro camino: la cargaron desde "Nueva compra" o
  // llegó el pedido y se recibió. Volver a escribirla duplica el gasto del mes.
  //
  // Pero la factura SÍ falta: el comprobante, sus renglones y el IVA no están en
  // ningún lado. Por eso las opciones no son "seguí" y "cancelá" —que era como
  // estaba escrito este paso y nunca llegó a usarse—: la que importa es la
  // tercera, cargar la factura SIN tocar la plata.
  //
  // El orden de los botones lo decide la evidencia y no una preferencia fija.
  // Con el importe coincidiendo, "es esa" arriba; con sólo el proveedor y la
  // fecha, arriba va "es otra compra". Los dos errores son caros y opuestos —
  // enganchar mal deja un gasto sin escribir para siempre y en silencio,
  // desenganchar mal deja una fila duplicada que se ve en Pagos— así que lo que
  // manda es cuánto prueba lo que se encontró.
  if (e.duplicado && !e.duplicadoOk) {
    const cands = (e.duplicado.candidatas || []).slice(0, 2);
    const fuerte = (e.duplicado.mejor || {}).fuerza === 'monto';

    const L = [`📒 Esta compra de *${e.proveedor}* puede que ya esté anotada en el libro:`, ''];
    for (const c of cands) {
      const que = c.descripcion ? ` · ${c.descripcion}` : '';
      L.push(`• *${plata(c.monto)}* del ${fechaCorta(c.fecha)} · ${c.estado}${que}`);
    }
    L.push('');
    L.push(fuerte
      ? '¿Es esta misma compra? Si sí, cargo la factura y los productos y *no* vuelvo a anotar la plata.'
      : '⚠️ El importe no coincide, así que puede ser otra compra del mismo proveedor.');

    const botonesCand = cands.map(c => ({
      id: `misma:${c.idMovimiento}`,
      label: cands.length > 1
        ? `✅ Es la de ${plata(c.monto)}`
        : '✅ Sí, es esta — no la anotes de nuevo',
      sugerido: fuerte,
    }));
    const botonOtra = { id: 'otra', label: '➕ Es otra compra, anotala', sugerido: !fuerte };

    return paso('duplicado', L.join('\n'),
      fuerte ? [...botonesCand, botonOtra, { id: 'cancelar', label: '🚫 Cancelá' }]
             : [botonOtra, ...botonesCand, { id: 'cancelar', label: '🚫 Cancelá' }],
      { ayuda: e.duplicado.conFactura
        ? `Hay ${e.duplicado.conFactura} fila(s) más de este proveedor que ya tienen su factura, así que no las ofrezco.`
        : '' });
  }

  // 1. ¿Descuenta IVA? La condición es ser factura A.
  if (e.deducible == null) {
    const visto = e.tipoComprobante ? `Leí un comprobante "${e.tipoComprobante}". ` : 'No pude ver la letra del comprobante. ';
    return paso('deducible', `${visto}¿Sirve para descontar IVA?`, [
      { id: 'si', label: '🅰️ Sí, es factura A' },
      { id: 'no', label: '❌ No' },
    ]);
  }

  // 2. La alícuota.
  if (e.deducible === true && e.ivaPct == null) {
    return paso('ivaPct', '¿De cuánto es el IVA?',
      ALICUOTAS.map(a => ({ id: String(a), label: `${String(a).replace('.', ',')}%` })),
      { permiteTexto: true, ayuda: 'Carnes y verduras suelen ser 10,5; el resto 21; la luz, 27.' });
  }

  // 3. Incluido o discriminado.
  if (e.deducible === true && e.ivaIncluido == null) {
    return paso('ivaIncluido', '¿El IVA ya está incluido en los precios?', [
      { id: 'no', label: 'Discriminado' },
      { id: 'si', label: 'Ya incluido' },
    ]);
  }

  // 4. El total. Se pregunta si no se leyó, o si se leyó con poca confianza.
  if (!(e.total > 0) || e.confianzaTotal < CONFIANZA_MINIMA_TOTAL) {
    const leido = e.total > 0 ? `Leí *${plata(e.total)}*. ` : 'No pude leer el total. ';
    return paso('total', `${leido}¿Es correcto?`,
      e.total > 0 ? [{ id: String(e.total), label: `✅ ${plata(e.total)}`, sugerido: true }] : [],
      { permiteTexto: true, ayuda: 'Si no, escribí el monto.' });
  }

  // ─── De acá para abajo, todo lo que decide la PLATA ──────────────────────
  //
  // En modo "sólo la factura" nada de esto se pregunta, y no es un atajo: la
  // categoría, el medio, si está paga, cuándo llega y cuándo vence YA están
  // escritos en la fila del libro y en su pedido. Preguntarlos de nuevo sería
  // pedirle a alguien que conteste algo que el sistema sabe, y peor, dejarlo
  // contestar distinto de lo que quedó registrado sin que eso cambie nada.
  if (e.soloFactura) {
    if (!e.confirmado) {
      return {
        tipo: 'confirmar', campo: '', texto: armarResumen(e),
        botones: [
          { id: 'confirmar', label: '✅ Confirmar así', sugerido: true },
          { id: 'corregir:datos', label: '✏️ Corregir el IVA o el total' },
          { id: 'corregir:enganche', label: '🔗 No era esa compra' },
        ],
        permiteTexto: false,
      };
    }
    return { tipo: 'listo', campo: '', texto: armarResumen(e), botones: [], permiteTexto: false };
  }

  // 5. La categoría del gasto.
  if (!e.categoria) {
    return paso('categoria', '¿Qué tipo de gasto es?',
      cats.CATEGORIAS_COLUMNA_J.map(c => ({ id: c, label: c })));
  }

  // 6. ¿Está pago? Siempre. Es la decisión del momento y no se hereda.
  if (e.estaPago == null) {
    return paso('estaPago', '¿Está pago?', [
      { id: 'si', label: '✅ Sí, ya lo pagué' },
      { id: 'no', label: '⏳ No' },
    ]);
  }

  // 7. Con qué se pagó.
  if (e.estaPago === true && !e.medioPago) {
    return paso('medioPago', '¿Con qué se pagó?',
      MEDIOS.map(m => ({ id: m, label: m, sugerido: m === e.medioSugerido })));
  }

  // 8. Cuándo llega. Sólo si la categoría tiene puerta.
  if (llevaEntrega(e) && e.entregaFecha == null) {
    const botones = atajosDeEntrega(e.fecha).map(a => ({ id: a.valor, label: a.label }));
    botones.push({ id: '', label: 'No lleva entrega' });
    return paso('entregaFecha', '¿Cuándo llega al local?', botones,
      { permiteTexto: true, ayuda: 'O escribí la fecha (dd/mm).' });
  }

  // 9. Si no está pago y hay entrega: ¿se paga en la puerta o después?
  if (e.estaPago === false && e.entregaFecha && e.pagaAlLlegar == null) {
    return paso('pagaAlLlegar', '¿Se paga cuando llega, o después?', [
      { id: 'si', label: '🚪 Al llegar' },
      { id: 'no', label: '📅 Después' },
    ]);
  }

  // 10. El vencimiento del pago diferido.
  if (pagoPrevistoDe(e) === 'a-pagar' && !e.vencimiento) {
    const sug = vencimientoSugerido(e);
    const botones = [];
    if (e.diasCredito > 0) {
      botones.push({ id: sug, label: `✅ ${fechaCorta(sug)} (${e.diasCredito} días)`, sugerido: true });
    }
    for (const d of [7, 15, 30]) {
      const f = sumarDias(e.fecha, d);
      if (f !== sug) botones.push({ id: f, label: `${fechaCorta(f)} (${d} días)` });
    }
    return paso('vencimiento', '¿Cuándo vence?', botones,
      { permiteTexto: true, ayuda: 'O escribí la fecha (dd/mm).' });
  }

  // No falta nada.
  if (!e.confirmado) {
    return {
      tipo: 'confirmar',
      campo: '',
      texto: armarResumen(e),
      botones: [
        { id: 'confirmar', label: '✅ Confirmar así', sugerido: true },
        { id: 'corregir:pago', label: '💳 Cambiar pago' },
        { id: 'corregir:entrega', label: '🚚 Cambiar entrega' },
        { id: 'corregir:datos', label: '✏️ Corregir otro dato' },
      ],
      permiteTexto: false,
    };
  }

  return { tipo: 'listo', campo: '', texto: armarResumen(e), botones: [], permiteTexto: false };
}

function paso(campo, pregunta, botones, extra = {}) {
  return {
    tipo: 'pregunta',
    campo,
    // El resumen va SIEMPRE arriba de la pregunta: lo que se está por escribir
    // tiene que estar a la vista mientras se contesta, no dos mensajes atrás.
    texto: pregunta,
    ayuda: extra.ayuda || '',
    botones: botones || [],
    permiteTexto: !!extra.permiteTexto,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Aplicar una respuesta
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Devuelve `{ estado, error }`. Nunca muta el estado que recibe.
 *
 * Un valor que no se entiende NO se guarda: vuelve como error y el paso se
 * repregunta. Guardar basura acá es escribirla en la planilla después.
 */
function aplicarRespuesta(estado, { campo, valor } = {}) {
  const e = { ...estado };
  const v = valor == null ? '' : String(valor).trim();

  switch (campo) {
    case 'yaCargada':
      if (v === 'igual') { e.yaCargadaOk = true; return { estado: e }; }
      return { estado: e, cancelar: true };

    case 'duplicado': {
      if (v === 'cancelar') return { estado: e, cancelar: true };
      e.duplicadoOk = true;
      if (v === 'otra') return { estado: e };

      // "misma:<idMovimiento>" — se engancha a ESA fila y no a la que el
      // sistema prefería: el botón dice el importe, así que lo que se tocó es
      // lo que se eligió.
      const id = v.startsWith('misma:') ? v.slice(6) : '';
      const cand = ((e.duplicado && e.duplicado.candidatas) || [])
        .find(c => c.idMovimiento === id);
      if (!cand) return { estado, error: 'Esa fila ya no está. Volvé a mandar la foto.' };

      e.soloFactura = true;
      e.movimiento = cand;
      // Lo que ya está decidido se COPIA de la fila, no se vuelve a preguntar.
      // La categoría se normaliza igual: la columna J de una fila vieja puede
      // decir algo que hoy no es una categoría válida.
      e.categoria = cats.normalizarCategoriaGasto(cand.categoria) || e.categoria || '';
      e.estaPago = null; e.medioPago = ''; e.pagaAlLlegar = null;
      e.entregaFecha = ''; e.vencimiento = ''; e.propuesto = [];
      return { estado: e };
    }

    case 'deducible':
      e.deducible = esSi(v);
      // Si no descuenta IVA, no hay alícuota que preguntar ni que escribir.
      if (!e.deducible) { e.ivaPct = null; e.ivaIncluido = null; }
      return { estado: e };

    case 'ivaPct': {
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { estado, error: 'Poné el IVA como número (21, 10,5, 27).' };
      }
      e.ivaPct = n;
      return { estado: e };
    }

    case 'ivaIncluido':
      e.ivaIncluido = esSi(v);
      return { estado: e };

    case 'total': {
      let n;
      try { n = parseMonto(v); } catch (err) { n = NaN; }
      if (!Number.isFinite(n) || n <= 0) {
        return { estado, error: 'No entendí el monto. Escribilo así: 117300 o 117.300,50' };
      }
      e.total = n;
      // Contestado a mano, el total deja de ser una lectura dudosa.
      e.confianzaTotal = 1;
      return { estado: e };
    }

    case 'categoria': {
      const c = cats.normalizarCategoriaGasto(v);
      if (!c) return { estado, error: 'Esa categoría no existe.' };
      e.categoria = c;
      // Cambiar de categoría puede sacar (o poner) la pregunta de la entrega.
      if (!CATEGORIAS_CON_ENTREGA.includes(c)) { e.entregaFecha = ''; e.pagaAlLlegar = null; }
      return { estado: e };
    }

    case 'estaPago':
      e.estaPago = esSi(v);
      if (e.estaPago) { e.pagaAlLlegar = null; e.vencimiento = ''; }
      else e.medioPago = '';
      return { estado: e };

    case 'medioPago': {
      const m = cats.normalizarParaLibro ? cats.normalizarParaLibro(v) : v;
      if (!MEDIOS.includes(m)) return { estado, error: 'Ese medio de pago no es una caja.' };
      e.medioPago = m;
      return { estado: e };
    }

    case 'entregaFecha': {
      if (v === '') { e.entregaFecha = ''; e.pagaAlLlegar = null; return { estado: e }; }
      const f = pedidos.normalizarFecha(v) || fechaSuelta(v, e.fecha);
      if (!f) return { estado, error: 'No entendí la fecha. Escribila así: 4/9' };
      e.entregaFecha = f;
      return { estado: e };
    }

    case 'pagaAlLlegar':
      e.pagaAlLlegar = esSi(v);
      // Al llegar, el vencimiento ES el día de la entrega: no se pregunta.
      if (e.pagaAlLlegar) e.vencimiento = '';
      return { estado: e };

    case 'vencimiento': {
      const f = pedidos.normalizarFecha(v) || fechaSuelta(v, e.fecha);
      if (!f) return { estado, error: 'No entendí la fecha. Escribila así: 26/9' };
      e.vencimiento = f;
      return { estado: e };
    }

    case 'confirmar':
      e.confirmado = true;
      return { estado: e };

    // Reabrir un bloque para corregirlo. Se limpian TODOS los campos del bloque
    // y no sólo el primero: si se cambia "está pago", el medio que se había
    // elegido dejó de tener sentido.
    case 'corregir':
      if (v === 'pago') { e.estaPago = null; e.medioPago = ''; e.pagaAlLlegar = null; e.vencimiento = ''; }
      else if (v === 'entrega') { e.entregaFecha = null; e.pagaAlLlegar = null; }
      else if (v === 'datos') {
        e.total = null; e.confianzaTotal = 0; e.deducible = null; e.ivaPct = null; e.ivaIncluido = null;
        // Enganchada a una fila, la categoría es la de esa fila y no algo que
        // esta pantalla pueda cambiar: borrarla haría que se pregunte de nuevo
        // para después no escribirla en ningún lado.
        if (!e.soloFactura) e.categoria = '';
      } else if (v === 'enganche') {
        // Deshacer el enganche: vuelve a preguntarse todo el bloque de la plata,
        // y la propuesta se muestra otra vez para poder elegir bien.
        e.soloFactura = false; e.movimiento = null; e.duplicadoOk = false;
        e.estaPago = null; e.medioPago = ''; e.pagaAlLlegar = null;
        e.entregaFecha = null; e.vencimiento = '';
      } else return { estado, error: 'No sé qué corregir.' };
      // Deja de ser una propuesta en cuanto alguien la toca: lo que conteste
      // ahora SÍ es lo que ese proveedor hace, y eso es lo que se aprende.
      e.propuesto = (e.propuesto || []).filter(x => x !== v);
      return { estado: e };

    default:
      return { estado, error: `No esperaba una respuesta de "${campo}".` };
  }
}

function esSi(v) {
  const s = String(v).toLowerCase();
  return s === 'si' || s === 'sí' || s === 'true' || s === '1';
}

/** 'dd/mm' o 'dd/mm/aaaa' → ISO, tomando el año de la compra si no vino. */
function fechaSuelta(txt, refISO) {
  const m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(String(txt || '').trim());
  if (!m) return '';
  const anio = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]))
    : Number(String(refISO || '').slice(0, 4)) || new Date().getUTCFullYear();
  const d = Number(m[1]), mes = Number(m[2]);
  if (!(d >= 1 && d <= 31 && mes >= 1 && mes <= 12)) return '';
  return `${anio}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// El resumen
// ═══════════════════════════════════════════════════════════════════════════

function plata(n) {
  const num = Number(n) || 0;
  const ent = Math.round(num * 100) / 100;
  return '$' + ent.toLocaleString('es-AR', { minimumFractionDigits: ent % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])}/${Number(m[2])}` : String(iso || '');
}

/**
 * El resumen que se muestra arriba de cada pregunta y en la confirmación.
 *
 * Lo que falta se marca con ❓ en vez de omitirse: una línea ausente y una línea
 * sin contestar se leen igual, y la diferencia es justo lo que hay que ver.
 */
function armarResumen(e) {
  const L = [];
  const nro = nroComprobante(e);
  L.push(`🧾 *${e.proveedor || '¿?'}*${nro ? ` · ${nro}` : ''} · ${fechaCorta(e.fecha)}`);
  L.push(e.total > 0 ? `💵 *${plata(e.total)}*` : '💵 ❓ falta el total');

  if (e.deducible === true) {
    const como = e.ivaIncluido === true ? 'incluido' : e.ivaIncluido === false ? 'discriminado' : '❓';
    L.push(`🅰️ Descuenta IVA · ${e.ivaPct != null ? `${String(e.ivaPct).replace('.', ',')}%` : '❓'} ${como}`);
    // Cuánto crédito fiscal deja esta factura. Es el número que el registro
    // existe para acumular, así que se dice ACÁ y no sólo en la pantalla: quien
    // sacó la foto tiene que poder ver el aporte del mes creciendo.
    const d = desgloseDe(e);
    if (d && d.iva > 0) L.push(`   ↳ crédito IVA *${plata(d.iva)}* sobre ${plata(d.neto)} de neto`);
  } else if (e.deducible === false) {
    L.push('🚫 No descuenta IVA');
  } else {
    L.push('❓ No sé si descuenta IVA');
  }

  // La fila del libro a la que se engancha. Va arriba de todo lo demás porque
  // cambia qué significa el resto del resumen: la plata no se vuelve a escribir.
  if (e.soloFactura && e.movimiento) {
    const m = e.movimiento;
    L.push(`📒 Ya está en el libro: ${plata(m.monto)} del ${fechaCorta(m.fecha)} · ${m.estado}`
      + `${m.medioPago ? ` · ${m.medioPago}` : ''}`);
    L.push('   ↳ *no* la vuelvo a anotar; cargo la factura y los productos.');
    // Si el total de la factura no es el de la fila, hay que decirlo: puede ser
    // un pago parcial, un saldo o una lectura mal hecha, y las tres se resuelven
    // mirándolo, no eligiendo por la persona.
    const dif = (e.total || 0) - (m.monto || 0);
    if (e.total > 0 && Math.abs(dif) > Math.max(1, (m.monto || 0) * 0.005)) {
      L.push(`   ⚠️ La factura dice ${plata(e.total)} y la fila ${plata(m.monto)} `
        + `(${dif > 0 ? '+' : '−'}${plata(Math.abs(dif))}).`);
    }
  }

  const trozos = [];
  trozos.push(e.categoria ? `🏷️ ${e.categoria}` : '🏷️ ❓');
  if (e.itemsCount > 0) trozos.push(`📦 ${e.itemsCount} producto${e.itemsCount === 1 ? '' : 's'}`);
  L.push(trozos.join(' · '));

  // Enganchada a una fila, el bloque del pago ya está contestado en el libro.
  // Repetirlo acá con un "❓ falta definir el pago" diría que falta algo que no
  // falta, que es la única cosa que este resumen no puede hacer.
  if (e.soloFactura) return L.join('\n');

  // Lo que se propuso solo se marca: hay que poder distinguir "esto lo dijiste
  // vos" de "esto lo supuse yo porque es lo que hacés siempre".
  const prop = new Set(e.propuesto || []);
  const marca = (b) => (prop.has(b) ? ' _(como siempre)_' : '');

  const pp = pagoPrevistoDe(e);
  if (pp === 'pagado') L.push(`💳 Pagado con ${e.medioPago || '❓'}${marca('pago')}`);
  else if (pp === 'al-recibir') L.push(`💳 Se paga cuando llega${marca('pago')}`);
  else if (pp === 'a-pagar') L.push(`💳 Queda a pagar${e.vencimiento ? ` · vence ${fechaCorta(e.vencimiento)}` : ''}${marca('pago')}`);
  else L.push('💳 ❓ falta definir el pago');

  // La entrega NO lleva la marca aunque se haya propuesto: no sale de ningún
  // hábito, sale de que el día por default es hoy. Decir "como siempre" ahí
  // afirmaría algo que nadie observó.
  if (e.entregaFecha) {
    L.push(`🚚 Llega el ${capitalizar(pedidos.diaSemanaDe(e.entregaFecha))} ${fechaCorta(e.entregaFecha)}`);
  }

  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// La salida
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El payload de `registrarCompra` — el mismo que arma el formulario de la app.
 *
 * `fecha` va en DD/MM/AAAA porque es lo que espera el libro; la entrega va en
 * ISO porque es lo que espera `pedidos.normalizarFecha`.
 */
function aDatosDeCompra(estado, { usuario = '' } = {}) {
  const e = estado;
  const pp = pagoPrevistoDe(e);
  return {
    fecha: aDDMMAAAA(e.fecha),
    mes: mesDe(e.fecha),
    proveedor: e.proveedor,
    categoria: e.categoria,
    salidaARS: e.total,
    vencimiento: e.vencimiento ? aDDMMAAAA(e.vencimiento) : '',
    descripcion: e.itemsCount > 0
      ? `Factura ${e.proveedor} · ${e.itemsCount} producto${e.itemsCount === 1 ? '' : 's'}`
      : `Factura ${e.proveedor}`,
    medioPago: pp === 'pagado' ? e.medioPago : (e.medioPago || ''),
    pagoPrevisto: pp,
    estado: pp === 'pagado' ? 'Pagado' : 'A pagar',
    entrega: e.entregaFecha ? { fecha: e.entregaFecha } : null,
    usuario,
  };
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function mesDe(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m ? MESES[Number(m[2]) - 1] : '';
}

function aDDMMAAAA(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : String(iso || '');
}

// ═══════════════════════════════════════════════════════════════════════════
// La factura como comprobante
// ═══════════════════════════════════════════════════════════════════════════

/** "A 00003-00001234", o '' si la foto no mostró el número. */
function nroComprobante(e) {
  const { puntoVenta, numero } = facturas.formatearNumero(e.puntoVenta, e.numero);
  if (!numero) return '';
  const letra = facturas.normalizarComprobante(e.tipoComprobante);
  return `${letra ? `${letra} ` : ''}${puntoVenta || '?????'}-${numero}`;
}

/** El desglose fiscal de lo que se lleva contestado. Puede dar null. */
function desgloseDe(e) {
  if (!(e.total > 0)) return null;
  return facturas.desglosar({
    total: e.total,
    otrosImpuestos: e.otrosImpuestos,
    computable: facturas.esComputable({ comprobante: e.tipoComprobante, deducible: e.deducible }),
    alicuota: e.ivaPct,
    netoLeido: e.subtotalLeido,
    ivaLeido: e.ivaMontoLeido,
  });
}

/**
 * El renglón que va a la hoja `Facturas`.
 *
 * `idMovimiento` lo pone quien llama: cuando la compra se escribe ahora es el id
 * que acuñó `registrarCompra`, y cuando se engancha a una fila que ya existía es
 * el de esa fila. Es el único dato que este archivo no puede saber solo, porque
 * nace de una escritura.
 */
function aRegistroDeFactura(estado, { usuario = '', origen = 'bot', idMovimiento = '' } = {}) {
  const e = estado;
  const { puntoVenta, numero } = facturas.formatearNumero(e.puntoVenta, e.numero);
  return {
    fecha: e.fecha,
    mes: mesDe(e.fecha),
    proveedor: e.proveedor,
    cuit: e.cuit || '',
    comprobante: e.tipoComprobante,
    // Cuando la letra no se leyó pero alguien contestó que descuenta IVA, la
    // columna `Computable` lo dice igual. No se escribe una "A" inventada: la
    // letra es lo que dice el papel, no lo que se dedujo de una respuesta.
    deducible: e.deducible,
    puntoVenta, numero,
    total: e.total,
    alicuota: e.ivaPct,
    neto: e.subtotalLeido,
    iva: e.ivaMontoLeido,
    otrosImpuestos: e.otrosImpuestos,
    idMovimiento: idMovimiento || (e.movimiento && e.movimiento.idMovimiento) || '',
    origen, usuario,
  };
}

/** Lo que hay que guardar en la ficha del proveedor para no repreguntarlo. */
function aprendizajeDe(estado) {
  const e = estado;
  const out = {};
  if (e.deducible != null) {
    out['IVA Deducible'] = e.deducible ? 'S' : 'N';
    out['IVA'] = e.deducible ? 'Con IVA' : 'Sin IVA';
  }
  if (e.deducible === true && e.ivaIncluido != null) out['IVA Incluido'] = e.ivaIncluido ? 'S' : 'N';
  if (e.categoria) out['Categoria Gasto'] = e.categoria;
  // El hábito de pago: lo que se le va a PROPONER la próxima vez. Se guarda
  // recién cuando alguien lo contestó de verdad, no cuando confirmó la propuesta
  // que salió de acá mismo — si no, el primer error se vuelve permanente solo.
  const pp = pagoPrevistoDe(e);
  if (pp && !(e.propuesto || []).includes('pago')) out['Pago Habitual'] = pp;
  return out;
}

/**
 * El comprobante que se siembra en el padrón fiscal.
 *
 * Sólo cuando la letra se leyó de la foto o la contestó una persona, y NUNCA
 * pisa una ficha cargada a mano (eso lo decide quien llama, mirando `Fuente
 * Fiscal`). Es gratis: la pregunta se hace igual, y hoy 16 de 20 proveedores
 * hay que relevarlos a mano.
 */
function fiscalDe(estado) {
  const e = estado;
  const out = {};
  if (['A', 'B', 'C', 'M'].includes(e.tipoComprobante)) out['Comprobante Habitual'] = e.tipoComprobante;
  else if (e.deducible === true) out['Comprobante Habitual'] = 'A';
  if (e.cuit) out['CUIT'] = e.cuit;
  if (e.deducible === true && e.ivaPct != null) out['Alicuota IVA'] = e.ivaPct;
  return out;
}

/** Lo que se le pone a cada renglón de la hoja Compras. */
function ivaParaCompras(estado) {
  // No deducible → las columnas de IVA van VACÍAS. Ver `appendCompras`.
  if (estado.deducible !== true) return { ivaPct: null, ivaIncluido: null };
  return { ivaPct: estado.ivaPct, ivaIncluido: !!estado.ivaIncluido };
}

module.exports = {
  estadoInicial, siguientePaso, aplicarRespuesta,
  armarResumen, aDatosDeCompra, aprendizajeDe, fiscalDe, ivaParaCompras,
  aRegistroDeFactura,
  // Puras, exportadas para poder ejercitarlas.
  nroComprobante, desgloseDe,
  pagoPrevistoDe, llevaEntrega, atajosDeEntrega, vencimientoSugerido,
  fechaSuelta, mesDe, aDDMMAAAA, plata, fechaCorta,
  CATEGORIAS_CON_ENTREGA, SIN_ENTREGA, ALICUOTAS, MEDIOS, CONFIANZA_MINIMA_TOTAL,
};
