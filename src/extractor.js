// ─── Extracción de datos de facturas/remitos con Claude Vision ──────────────────
//
// Recibe una imagen (base64 + mime) y devuelve un array de items de compra.
// Una entrada por producto. NO escribe nada ni normaliza: eso lo hace server.js
// con el módulo de categorías/inferencia. Acá solo "leemos" la imagen.
//
// Credencial: ANTHROPIC_API_KEY (variable de entorno).

const Anthropic = require('@anthropic-ai/sdk');
const cats = require('./proveedores-categorias');

const MODEL = process.env.EXTRACTOR_MODEL || 'claude-opus-4-6';

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY');
  return new Anthropic({ apiKey });
}

// ─── Por qué son DOS llamadas y no una ─────────────────────────────────────────
//
// El tiempo de una llamada lo domina la SALIDA, que se genera token por token;
// la imagen se procesa de una sola vez. Medido sobre la forma que pide este
// prompt: la cabecera son ~82 tokens y CADA renglón ~114. Una factura de siete
// renglones son ~889 tokens de salida, o sea 15 a 22 segundos — que es
// exactamente lo que se veía esperando al bot.
//
// Y la primera pregunta que le hacemos a la persona ("el gasto es $X, ¿está
// bien?") necesita ÚNICAMENTE la cabecera. Los renglones recién hacen falta para
// escribir en Compras, que pasa después de que terminó de contestar.
//
// Así que se piden por separado y se lanzan juntas: la cabecera vuelve en ~2
// segundos y desbloquea la conversación, y los renglones terminan de leerse
// mientras la persona toca botones.
//
// Las dos usan el mismo modelo. Bajar de Opus para leer plata de una foto no
// estaba sobre la mesa.
function buildPromptCabecera() {
  return `Sos un asistente que procesa facturas y remitos de un bar-restaurante en Argentina.
Analizá la imagen y extraé SOLAMENTE los datos de CABECERA (los de toda la factura).
NO extraigas los renglones de productos: eso se pide aparte.

Devolvé un OBJETO JSON con esta forma EXACTA, sin texto adicional:

{
  "fecha": "YYYY-MM-DD",
  "proveedor": "Nombre del proveedor",
  "tipo_comprobante": "A | B | C | M | X | Remito | \\"\\"",
  "cuit_proveedor": "",
  "forma_de_pago": "Efectivo | Mercado Pago | Galicia | Echeq | Contado | \\"\\"",
  "vendedor": "Nombre del vendedor si figura, o \\"\\"",
  "dias_credito": 0,
  "subtotal_factura": 0,
  "iva_monto": 0,
  "iva_discriminado": true,
  "otros_impuestos_monto": 0,
  "total_factura": 0,
  "confianza": { "proveedor": 0.0, "fecha": 0.0, "forma_de_pago": 0.0, "total_factura": 0.0, "tipo_comprobante": 0.0 }
}

Reglas IMPORTANTES:
- tipo_comprobante = la LETRA del comprobante. En las facturas argentinas es una
  letra grande dentro de un recuadro, arriba y al medio, entre los datos del
  emisor y los del comprador. Es el dato que decide si se puede descontar IVA,
  así que importa casi tanto como el total.
  · Si ves la letra, ponela con confianza ALTA ("A", "B", "C", "M", "X").
  · Si el papel dice "REMITO" o "PRESUPUESTO" en vez de "FACTURA", poné
    "Remito" — no es un comprobante fiscal.
  · Si NO la podés ver, poné "" con confianza 0. NO la deduzcas del IVA ni del
    CUIT: un humano lo va a confirmar y es preferible.
- cuit_proveedor = el CUIT de QUIEN EMITE la factura (el proveedor), con guiones
  (ej "30-71234567-8"). OJO: una factura tiene DOS CUIT, el del emisor arriba y
  el del comprador. Queremos el del EMISOR. Si dudás cuál es, poné "".
- iva_discriminado = true si la factura muestra el IVA como un renglón aparte en
  el pie (ej "IVA 21%: $21.000"), false si los precios ya vienen con IVA adentro
  y no se discrimina en ningún lado.
- DISTINGUÍ forma de pago (CÓMO se paga: efectivo, transferencia, Mercado Pago,
  tarjeta) de días de crédito / condición (plazo: "30 días", "Contado").
  · "30 días" → dias_credito = 30, NO es forma de pago.
  · "Contado" o "Plazo de Pago: Contado" es una CONDICIÓN, no dice cómo se pagó.
    En ese caso poné forma_de_pago = "Contado" PERO con confianza BAJA (0.2).
  · Solo poné forma_de_pago con confianza ALTA si la factura dice explícitamente
    el medio (ej. "Efectivo", "Transferencia", "Mercado Pago", "Tarjeta").
- total_factura = el TOTAL final de la factura, con impuestos. Es el dato MÁS
  importante de todos: es la plata que se va a registrar como gasto. Si no lo
  podés leer con seguridad, poné tu mejor lectura con confianza baja.
- subtotal_factura = el SUBTOTAL ANTES de IVA e impuestos.
- iva_monto = el MONTO de IVA en pesos del pie de la factura.
- otros_impuestos_monto = MONTO en pesos de impuestos que NO son IVA (ej "IMP INT").
- La fecha en formato YYYY-MM-DD. Si no aparece, "" con confianza 0.
- "confianza" 0 a 1. NO inventes: es mejor que un humano confirme.`;
}

function buildPromptItems() {
  return `Sos un asistente que procesa facturas y remitos de un bar-restaurante en Argentina.
Analizá la imagen y extraé SOLAMENTE los RENGLONES de productos, uno por producto.
NO extraigas los datos de cabecera (proveedor, total, forma de pago): eso se pide aparte.

Devolvé un ARRAY JSON, sin texto adicional:

[
  {
    "categoria": "una de las categorías válidas o \\"\\" si no estás seguro",
    "producto": "Nombre del producto",
    "cantidad": 10,
    "unidad": "Kg | Unidad | Caja | Bandeja | Litro | Atado | Bolsa | Maple | ...",
    "unidades_por_paquete": 6,
    "precio_unitario": 350,
    "descuento_porcentaje": 0,
    "iva_porcentaje": 21,
    "otro_impuesto": 0,
    "total_linea": 3500
  }
]

PARA QUE LA RESPUESTA SEA CORTA (importa: cada renglón se paga por separado):
- NO incluyas "notas" si no tenés nada que aclarar.
- NO incluyas "confianza" en los campos que leés con seguridad. Incluí
  "confianza" SÓLO para los campos que dudás, así: "confianza": { "producto": 0.4 }.
  Un renglón que leés bien no lleva "confianza" ninguna.
- NO repitas el proveedor, la fecha ni la forma de pago en cada renglón.

Categorías válidas (usá EXACTAMENTE estos nombres):
${cats.CATEGORIAS.map(c => `  · ${c}`).join('\n')}

Reglas IMPORTANTES:
- iva_porcentaje: la alícuota de IVA de esa línea (21, 10.5, 0). Si la factura la
  discrimina por línea, usá la de cada línea; si es general, repetí la misma.
- precio_unitario = precio por unidad (P.U.) ANTES de descuento, NO el total de la línea.
- descuento_porcentaje = el % de descuento de esa línea si la factura tiene una
  columna "% Dto", "Dcto", "Descuento" o similar (ej. 50 = 50%). Si no hay, 0.
  OJO: el precio_unitario es el de lista (sin descuento); el descuento se aplica aparte.
- otro_impuesto = monto ARS ABSOLUTO de otros impuestos de esa línea que NO sean IVA
  (ej: "IMP INT", impuestos internos). Si no hay, 0. Es un MONTO en pesos, no un %.
- total_linea = el total de esa línea tal como figura en la factura (para control).
- unidades_por_paquete: SOLO para bebidas/vinos vendidos por EMPAQUE (Caja, Cajón,
  Pack, Bulto). Es cuántas BOTELLAS trae ese empaque. Buscalo en la descripción:
  "Caja x6", "x6", "Pack 6u", "6x750ml", "Caja de 12". Ej: "Malbec Caja x6" → 6.
  · Si la unidad ya es Botella/Unidad suelta, poné 1.
  · Si NO podés determinar cuántas botellas trae el empaque, poné 0 con
    "confianza": { "unidades_por_paquete": 0 } — un humano lo confirmará. NO inventes.
- Si no podés leer un campo, poné tu mejor estimación con confianza BAJA (< 0.6)
  o "" / 0 si es ilegible. NO inventes.`;
}

function buildPrompt() {
  return `Sos un asistente que procesa facturas y remitos de un bar-restaurante en Argentina.
Analizá la imagen y extraé los datos. Una factura tiene datos de CABECERA (comunes a
toda la factura: proveedor, fecha, forma de pago, total) y datos de LÍNEA (uno por
producto). Devolvé un OBJETO JSON con esta forma EXACTA, sin texto adicional:

{
  "factura": {
    "fecha": "YYYY-MM-DD",
    "proveedor": "Nombre del proveedor",
    "forma_de_pago": "Efectivo | Mercado Pago | Galicia | Echeq | Contado | \\"\\"",
    "vendedor": "Nombre del vendedor si figura en la factura, o \\"\\"",
    "dias_credito": 0,
    "subtotal_factura": 0,
    "iva_monto": 0,
    "otros_impuestos_monto": 0,
    "total_factura": 0,
    "confianza": { "proveedor": 0.0, "fecha": 0.0, "forma_de_pago": 0.0, "total_factura": 0.0 }
  },
  "items": [
    {
      "categoria": "una de las categorías válidas o \\"\\" si no estás seguro",
      "producto": "Nombre del producto",
      "cantidad": 10,
      "unidad": "Kg | Unidad | Caja | Bandeja | Litro | Atado | Bolsa | Maple | ...",
      "unidades_por_paquete": 6,
      "precio_unitario": 350,
      "descuento_porcentaje": 0,
      "iva_porcentaje": 21,
      "otro_impuesto": 0,
      "total_linea": 3500,
      "notas": "",
      "confianza": { "categoria": 0.0, "producto": 0.0, "precio_unitario": 0.0, "iva_porcentaje": 0.0, "unidades_por_paquete": 0.0 }
    }
  ]
}

Categorías válidas (usá EXACTAMENTE estos nombres):
${cats.CATEGORIAS.map(c => `  · ${c}`).join('\n')}

Reglas IMPORTANTES:
- DISTINGUÍ forma de pago (CÓMO se paga: efectivo, transferencia, Mercado Pago,
  tarjeta) de días de crédito / condición (plazo: "30 días", "Contado").
  · "30 días" → dias_credito = 30, NO es forma de pago.
  · "Contado" o "Plazo de Pago: Contado" es una CONDICIÓN, no dice cómo se pagó.
    En ese caso poné forma_de_pago = "Contado" PERO con confianza BAJA (0.2),
    porque no sabés si fue efectivo, transferencia o MP — que un humano confirme.
  · Solo poné forma_de_pago con confianza ALTA si la factura dice explícitamente
    el medio (ej. "Efectivo", "Transferencia", "Mercado Pago", "Tarjeta").
- forma_de_pago y dias_credito van en "factura" (son de toda la factura, NO por
  producto).
- iva_porcentaje: la alícuota de IVA de esa línea (21, 10.5, 0). Si la factura la
  discrimina por línea, usá la de cada línea; si es general, repetí la misma.
- precio_unitario = precio por unidad (P.U.) ANTES de descuento, NO el total de la línea.
- descuento_porcentaje = el % de descuento de esa línea si la factura tiene una
  columna "% Dto", "Dcto", "Descuento" o similar (ej. 50 = 50%). Si no hay, 0.
  OJO: el precio_unitario es el de lista (sin descuento); el descuento se aplica aparte.
- otro_impuesto = monto ARS ABSOLUTO de otros impuestos de esa línea que NO sean IVA
  (ej: "IMP INT", impuestos internos). Si no hay, 0. Es un MONTO en pesos, no un %.
- total_linea = el total de esa línea tal como figura en la factura (para control).
- subtotal_factura = el SUBTOTAL de la factura ANTES de IVA e impuestos (suma de líneas).
- iva_monto = el MONTO de IVA en pesos que figura en el pie de la factura (ej: "IVA: $21.420").
  Si la factura solo muestra el monto de IVA (no el %), igual ponelo acá; el sistema deduce el %.
- otros_impuestos_monto = el MONTO en pesos de impuestos que NO son IVA, del pie de la
  factura (ej: "Impuestos Imp. Int.: $8.874"). Si no hay, 0.
- total_factura = el TOTAL final de la factura (con impuestos), para control.
- "confianza" 0 a 1. Si no podés leer algo, poné tu mejor estimación con confianza
  BAJA (< 0.6) o "" / 0 si es ilegible. NO inventes. Es mejor que un humano confirme.
- unidades_por_paquete: SOLO para bebidas/vinos vendidos por EMPAQUE (Caja, Cajón,
  Pack, Bulto). Es cuántas BOTELLAS trae ese empaque. Buscalo en la descripción:
  "Caja x6", "x6", "Pack 6u", "6x750ml", "Caja de 12". Ej: "Malbec Caja x6" → 6.
  · Si la unidad ya es Botella/Unidad suelta, poné 1.
  · Si NO podés determinar cuántas botellas trae el empaque, poné 0 con confianza 0
    (un humano lo confirmará). NO inventes el número.
- La fecha en formato YYYY-MM-DD. Si no aparece, "" con confianza 0.`;
}

// Una llamada al modelo con la imagen y un prompt. `maxTokens` se ajusta a lo
// que se pide: la cabecera nunca necesita 3000.
async function pedirAlModelo({ base64, mime, prompt, maxTokens }) {
  const anthropic = client();
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  let raw = (resp.content[0] && resp.content[0].text || '').trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  }
  try { return { parsed: JSON.parse(raw), raw }; }
  catch (e) { throw new Error('El extractor no devolvió JSON válido: ' + raw.slice(0, 200)); }
}

// Sólo la cabecera. Es lo único que hace falta para la primera pregunta, y por
// eso es la llamada que la persona espera. ~82 tokens de salida.
async function extraerCabecera({ base64, mime = 'image/jpeg' }) {
  const { parsed, raw } = await pedirAlModelo({
    base64, mime, prompt: buildPromptCabecera(), maxTokens: 400,
  });
  const factura = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  factura.vendedor = factura.vendedor || '';
  factura.subtotal_factura = factura.subtotal_factura ?? null;
  factura.iva_monto = factura.iva_monto ?? null;
  factura.otros_impuestos_monto = factura.otros_impuestos_monto ?? null;
  factura.tipo_comprobante = normalizarComprobante(factura.tipo_comprobante);
  factura.cuit_proveedor = normalizarCuit(factura.cuit_proveedor);
  // Si el modelo no se pronunció, el pie de la factura ya lo dice: un IVA en
  // pesos separado del subtotal ES el IVA discriminado. Se deduce sólo cuando
  // el campo no vino, nunca se pisa lo que el modelo afirmó.
  if (typeof factura.iva_discriminado !== 'boolean') {
    factura.iva_discriminado = Number(factura.iva_monto) > 0 && Number(factura.subtotal_factura) > 0;
  }
  return { factura, rawText: raw };
}

// La letra del comprobante, normalizada a los valores que entiende
// `fiscal-proveedores.js` (COMPROBANTES). Cualquier cosa que no reconozcamos
// vuelve como '' — o sea "no se sabe", que es lo que dispara la pregunta.
// NO se deduce de nada: adivinar la letra es adivinar si se descuenta IVA.
function normalizarComprobante(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return '';
  if (/^(FACTURA\s*)?([ABCM])$/.test(s)) return s.replace(/[^ABCM]/g, '');
  if (s === 'X') return 'X';
  if (/REMITO|PRESUPUESTO/.test(s)) return 'Remito';
  return '';
}

// CUIT a "NN-NNNNNNNN-N". Devuelve '' si no tiene 11 dígitos: un CUIT a medias
// no sirve para cruzar contra el padrón y ensucia la ficha del proveedor.
function normalizarCuit(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  if (d.length !== 11) return '';
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

// Sólo los renglones. Corre en paralelo con la cabecera y termina mientras la
// persona contesta. Devuelve los items YA APLANADOS con los datos de cabecera,
// que es lo que espera el resto del pipeline.
async function extraerItems({ base64, mime = 'image/jpeg', factura = {} }) {
  const { parsed, raw } = await pedirAlModelo({
    base64, mime, prompt: buildPromptItems(), maxTokens: 3000,
  });
  const lineas = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.items) ? parsed.items : []);
  return { items: aplanar(lineas, factura), rawText: raw };
}

// ─── El remito de un pedido, que NO es una factura ──────────────────────────
//
// Alguien saca un recorte de pantalla del remito o del pedido que le mandó el
// proveedor y lo pega en la app. Lo único que hace falta de ahí es QUÉ Y CUÁNTO
// va a llegar, para poder tildarlo cuando llegue.
//
// Es un extractor aparte de `extraerItems` y no una variante suya, por tres
// razones que empujan todas para el mismo lado:
//
//  1. **Un remito muchas veces no tiene precios**, y el prompt de facturas pide
//     precio unitario, IVA, descuentos e impuestos internos. Pedir campos que no
//     están en la imagen es pedirle al modelo que invente o que devuelva nulls.
//  2. **La persona está esperando.** Pega y mira. La salida de facturas son
//     ~114 tokens por renglón; ésta son ~25, así que una lista de quince
//     productos vuelve en un cuarto del tiempo.
//  3. **No se categoriza nada.** La categoría del gasto ya la eligió quien cargó
//     la compra, y las categorías por ingrediente son para la hoja `Compras`,
//     que este camino no toca.
//
// LA IMAGEN NO SE GUARDA. Se lee y se descarta: lo que queda son los items como
// datos. Decisión del dueño (21/08/2026) y es la que hace que esto funcione en
// un teléfono — una lista se adapta a cualquier pantalla, una foto de un remito
// hay que abrirla, agrandarla y moverla con dos dedos.
function buildPromptRemito() {
  return `Sos un asistente que lee remitos y listas de pedido de un bar-restaurante en Argentina.
Analizá la imagen y extraé QUÉ PRODUCTOS van a llegar y en qué cantidad.

Devolvé un ARRAY JSON, sin texto adicional:

[
  { "producto": "Nombre del producto", "cantidad": 10, "unidad": "Kg" }
]

Reglas:
- "producto": el nombre tal como figura, sin códigos internos ni números de artículo.
  Si el nombre trae la presentación (ej. "Coca Cola 2.25L"), dejala en el nombre.
- "cantidad": el número de bultos/unidades que se entregan. Si no se lee, poné 1.
- "unidad": Kg, Unidad, Caja, Bandeja, Litro, Atado, Bolsa, Maple, Cajón, Pack...
  Si no está claro, poné "Unidad".
- NO incluyas precios, IVA, descuentos ni totales aunque estén en la imagen: acá
  no se usan y alargan la respuesta.
- NO incluyas renglones que no sean productos (subtotales, "TOTAL", observaciones,
  datos del transportista, condiciones de pago).
- Si la imagen no es un remito ni una lista de productos, devolvé [].
- Si un renglón no se lee con seguridad, incluilo igual con lo que puedas leer:
  es preferible un renglón para corregir a mano que un producto que falta. Para
  esos, y SÓLO para esos, agregá "dudoso": true.`;
}

// Devuelve { items: [{producto, cantidad, unidad, dudoso}], rawText }.
//
// Tolerante a propósito con lo que devuelve el modelo: un renglón sin nombre se
// descarta, pero uno sin cantidad vale 1 y uno sin unidad vale "Unidad". Un
// remito medio borroso tiene que dar una lista para corregir, no un error.
async function extraerItemsRemito({ base64, mime = 'image/jpeg' }) {
  const { parsed, raw } = await pedirAlModelo({
    base64, mime, prompt: buildPromptRemito(), maxTokens: 2000,
  });
  const lineas = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.items) ? parsed.items : []);
  const items = lineas
    .map(l => ({
      producto: String((l && l.producto) || '').trim().slice(0, 200),
      cantidad: Number(l && l.cantidad) > 0 ? Number(l.cantidad) : 1,
      unidad: String((l && l.unidad) || 'Unidad').trim().slice(0, 40) || 'Unidad',
      dudoso: !!(l && l.dudoso),
    }))
    .filter(i => i.producto);
  return { items, rawText: raw };
}

// Devuelve { items: [...], rawText }. Lanza si la API falla.
//
// El camino de UNA sola llamada. Queda para compatibilidad y para poder volver
// atrás sin tocar nada más; el circuito del bot usa las dos llamadas separadas.
async function extraerDeImagen({ base64, mime = 'image/jpeg' }) {
  const { parsed, raw } = await pedirAlModelo({
    base64, mime, prompt: buildPrompt(), maxTokens: 3000,
  });

  // Soportar dos formas: { factura, items } (nueva) o un array suelto (compat).
  let factura = {}, lineas = [];
  if (Array.isArray(parsed)) {
    lineas = parsed;
  } else if (parsed && typeof parsed === 'object') {
    factura = parsed.factura || {};
    lineas = Array.isArray(parsed.items) ? parsed.items : [];
  }

  factura.vendedor = factura.vendedor || '';
  factura.subtotal_factura = factura.subtotal_factura ?? null;
  factura.iva_monto = factura.iva_monto ?? null;
  factura.otros_impuestos_monto = factura.otros_impuestos_monto ?? null;
  return { items: aplanar(lineas, factura), factura, rawText: raw };
}

// Cada línea hereda los datos de cabecera. Así el resto del pipeline
// (resolverItem, procesarItems) sigue trabajando con items planos, venga la
// lectura de una llamada o de dos.
//
// OJO con la confianza: el prompt de renglones ahora pide OMITIR el campo cuando
// el modelo lee bien, para que la respuesta sea más corta. O sea que "no vino"
// significa "seguro", no "cero". Por eso el default es 1 y no 0 — si fuera 0,
// cada renglón bien leído generaría tres dudas y el bot preguntaría todo.
function aplanar(lineas, factura = {}) {
  const fconf = factura.confianza || {};
  return (lineas || []).map(l => ({
    fecha: l.fecha || factura.fecha || '',
    proveedor: l.proveedor || factura.proveedor || '',
    categoria: l.categoria || '',
    producto: l.producto || '',
    cantidad: l.cantidad ?? null,
    unidad: l.unidad || '',
    unidades_por_paquete: l.unidades_por_paquete ?? l.unidadesPorPaquete ?? l.unidades_por_caja ?? null,
    precio_unitario: l.precio_unitario ?? l.precioUnit ?? null,
    descuento_porcentaje: l.descuento_porcentaje ?? l.descuento ?? l.dcto ?? null,
    iva_porcentaje: l.iva_porcentaje ?? l.iva ?? null,
    otro_impuesto: l.otro_impuesto ?? l.imp_int ?? null,
    total_linea: l.total_linea ?? l.total ?? null,
    forma_de_pago: factura.forma_de_pago || l.forma_de_pago || '',
    dias_credito: factura.dias_credito ?? l.dias_credito ?? 0,
    notas: l.notas || '',
    confianza: {
      categoria: 1, producto: 1, precio_unitario: 1, iva_porcentaje: 1, unidades_por_paquete: 1,
      ...(l.confianza || {}),   // lo que el modelo SÍ marcó como dudoso pisa el default
      // La confianza de forma_de_pago es de la cabecera, no del renglón.
      forma_de_pago: fconf.forma_de_pago ?? (l.confianza && l.confianza.forma_de_pago) ?? 1,
    },
  }));
}

module.exports = {
  extraerDeImagen, buildPrompt, MODEL,
  // Las dos mitades, para pedirlas en paralelo.
  extraerCabecera, extraerItems, buildPromptCabecera, buildPromptItems, aplanar,
  // El remito de un pedido: qué y cuánto llega, sin precios. Ver su comentario.
  extraerItemsRemito, buildPromptRemito,
  // Exportados para poder probarlos sin llamar al modelo.
  normalizarComprobante, normalizarCuit,
};
