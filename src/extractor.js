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
  "forma_de_pago": "Efectivo | Mercado Pago | Galicia | Echeq | Contado | \\"\\"",
  "vendedor": "Nombre del vendedor si figura, o \\"\\"",
  "dias_credito": 0,
  "subtotal_factura": 0,
  "iva_monto": 0,
  "otros_impuestos_monto": 0,
  "total_factura": 0,
  "confianza": { "proveedor": 0.0, "fecha": 0.0, "forma_de_pago": 0.0, "total_factura": 0.0 }
}

Reglas IMPORTANTES:
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
  return { factura, rawText: raw };
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
};
