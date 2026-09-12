// ─── Extracción de datos de facturas/remitos con Claude Vision ──────────────────
//
// Recibe una imagen (base64 + mime) y devuelve un array de items de compra.
// Una entrada por producto. NO escribe nada ni normaliza: eso lo hace server.js
// con el módulo de categorías/inferencia. Acá solo "leemos" la imagen.
//
// Credencial: ANTHROPIC_API_KEY (variable de entorno).

const Anthropic = require('@anthropic-ai/sdk');
const cats = require('./proveedores-categorias');
const fechas = require('./fecha-factura');

// ─── Dos llamadas, dos modelos, y por qué no es el mismo ───────────────────────
//
// Medido el 11/09/2026 con `scripts/comparar-extractor.js` sobre facturas reales
// del historial (tickets térmicos arrugados, un presupuesto manuscrito, una
// factura de once renglones). Las dos mitades NO se comportan igual:
//
// · LA CABECERA la lee Haiku igual que Opus. Seis de siete totales idénticos, y
//   en el séptimo —un presupuesto a mano sin renglón de TOTAL— Haiku contestó
//   "no sé" con confianza 0 donde Opus afirmó con 0,65. Eso es exactamente lo
//   que esta app quiere: lo que duda se convierte en una pregunta al que sacó
//   la foto, no en una fila mal escrita.
//
// · LOS RENGLONES no. En la única factura densa de la muestra Haiku fusionó dos
//   productos y CORRIÓ CINCO PRECIOS un renglón hacia arriba. La plata no corre
//   peligro —el cruce suma-de-líneas contra total de cabecera en
//   `proveedores-routes.js` dispara la pregunta— pero `chequearTotalLinea` marcó
//   uno solo de diez: los otros cierran su propia aritmética con el precio de
//   OTRO producto. Eso entra a `Compras`, que es de donde salen el CMV y el
//   `precio_unitario_movido` de los informes, y nadie lo pregunta.
//
// Así que la cabecera va en el modelo barato y los renglones en el caro, y de
// paso la llamada que la persona ESPERA pasó de 10,6 a 5,2 segundos, que era la
// razón de partirlas en dos.
//
// LO QUE AHORRA, con los números en su lugar: 3,47 centavos por factura contra
// 5,46 todo en Opus, o sea **36%**. Las dos mitades cuestan casi lo mismo (la
// cabecera 46% del total, los renglones 54%), así que bajar sólo la cabecera a
// una quinta parte rinde 0,46 × 80% ≈ 36% — no la mitad. Todo en Haiku serían
// 1,01 centavos (−81%), y esa diferencia es lo que se está pagando por no
// ensuciar `Compras`: alrededor de 2,5 centavos por factura.
//
// EXTRACTOR_MODEL pisa las dos: es la marcha atrás sin deploy.
const MODELO_CABECERA = process.env.EXTRACTOR_MODEL
  || process.env.EXTRACTOR_MODEL_CABECERA || 'claude-haiku-4-5';
const MODELO_ITEMS = process.env.EXTRACTOR_MODEL
  || process.env.EXTRACTOR_MODEL_ITEMS || 'claude-opus-4-6';

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
// Hasta el 11/09/2026 las dos usaban el mismo modelo, y la razón escrita acá era
// que bajar de Opus para leer plata de una foto no estaba sobre la mesa. Se
// midió y resultó al revés de lo que parecía: la mitad que lee la plata es
// justamente la que Haiku hace igual de bien —y donde duda, pregunta—, y la que
// no se puede bajar es la de los renglones. Ver el bloque de los dos modelos
// arriba de `client()`.
//
// Partirlas en dos llamadas, que se hizo por latencia, terminó habilitando esto:
// con una sola llamada el modelo sería uno solo y habría que elegir el caro.
function buildPromptCabecera(hoy) {
  const dia = hoy || fechas.hoyAR();
  return `Sos un asistente que procesa facturas y remitos de un bar-restaurante en Argentina.
Analizá la imagen y extraé SOLAMENTE los datos de CABECERA (los de toda la factura).
NO extraigas los renglones de productos: eso se pide aparte.

Hoy es ${dia}. Ninguna factura puede tener fecha posterior a hoy.

Devolvé un OBJETO JSON con esta forma EXACTA, sin texto adicional:

{
  "fecha": "YYYY-MM-DD",
  "fecha_texto": "la fecha tal cual está impresa, sin reordenar",
  "proveedor": "Nombre del proveedor",
  "tipo_comprobante": "A | B | C | M | X | Remito | \\"\\"",
  "punto_venta": "",
  "numero_comprobante": "",
  "cuit_proveedor": "",
  "forma_de_pago": "Efectivo | Mercado Pago | Galicia | Echeq | Contado | \\"\\"",
  "vendedor": "Nombre del vendedor si figura, o \\"\\"",
  "dias_credito": 0,
  "subtotal_factura": 0,
  "iva_monto": 0,
  "iva_desglose": [],
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
- punto_venta y numero_comprobante = el número de la factura, que en Argentina
  viene como "0003-00001234" (punto de venta - número), casi siempre arriba a la
  derecha, cerca de la letra. Poné cada mitad por separado y SÓLO los dígitos:
  punto_venta = "0003", numero_comprobante = "00001234". Si sólo ves un número
  sin guion, poné todo en numero_comprobante y dejá punto_venta = "".
  Es lo que identifica a esta factura y a ninguna otra: sirve para no cargar dos
  veces la misma. Si no lo ves, poné "" — no lo inventes ni lo deduzcas.
- proveedor = el nombre de QUIEN EMITE el comprobante y nos vende. Casi siempre
  es el membrete: el logo y la razón social arriba de todo.
  OJO, mismo error que el CUIT: un comprobante tiene los datos del EMISOR y los
  del COMPRADOR, y los del comprador aparecen bajo rótulos como "Señores:",
  "Cliente", "Consumidor Final" o "Domicilio". Ésos NO son el proveedor.
  · Un DOMICILIO NUNCA es un nombre de proveedor. "LISANDRO DE LA TORRE 2020,
    Capital Federal" es una dirección, no una empresa, aunque esté sola en el
    renglón y aunque no haya otro nombre en el papel.
  · Un nombre de PERSONA que figura como cajero, vendedor o quien atendió
    tampoco: eso va en "vendedor", que se pide aparte.
  · Un teléfono, un CUIT o un número de pedido no son un nombre.
  · Si el papel NO IMPRIME el nombre de quien vende —pasa en tickets de control
    de caja y en comandas—, poné "" con confianza 0. Un humano lo va a
    completar, y eso es MUCHO mejor que un proveedor inventado: con un nombre
    que no existe la compra se le atribuye a alguien que no vendió nada, ensucia
    la ficha y el aprendizaje, y nadie se entera porque nadie preguntó.
  NO lo deduzcas del domicilio, del CUIT ni de los productos.
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
- iva_desglose = EL CUADRO DE IVA DEL PIE, fila por fila. Es lo más importante de
  todo este bloque, porque una factura puede tener MÁS DE UNA ALÍCUOTA y casi
  todas las de alimentos la tienen: en Argentina las carnes, frutas, verduras,
  harina de trigo, pan y leche van al 10,5% y el resto al 21%, así que un pedido
  a un distribuidor mezcla las dos.
  El pie trae un cuadro con una FILA POR TASA, con columnas del estilo
  "Subtotal | IVA Inscripto | %". Devolvé una entrada por cada fila:
    [{ "alicuota": 21, "neto": 247634.39, "iva": 52003.23 },
     { "alicuota": 10.5, "neto": 44794.42, "iva": 4703.42 }]
  · Con UNA sola tasa, va una sola entrada. Es lo normal y también se llena.
  · Si no hay cuadro o no se puede leer, devolvé [] — NO inventes las filas ni
    las deduzcas de los productos.
  · Copiá los importes de ese cuadro, no los calcules: para eso están impresos.
  · Los renglones marcados con "**", "(*)" o similar suelen ser los de la tasa
    reducida; el pie lo aclara al final ("Productos con tasa de IVA al 10,5%").
    Eso sirve para poner bien el iva_porcentaje DE CADA RENGLÓN, que se pide en
    la otra llamada — acá sólo interesa el cuadro del pie.
- subtotal_factura = el SUBTOTAL ANTES de IVA e impuestos. Si el pie tiene VARIAS
  tasas, es la SUMA de todos los subtotales, no el de una sola fila.
- iva_monto = el MONTO de IVA en pesos del pie. Con varias tasas, la SUMA de
  todas. Quedarse con una sola fila deja afuera crédito fiscal que existe, o
  hace que el sistema calcule el IVA del total entero a una tasa que no le
  corresponde a la mitad de la factura.
- otros_impuestos_monto = MONTO en pesos de impuestos que NO son IVA (ej "IMP INT").
- LA FECHA. Van los dos campos y son distintos:
  · fecha_texto = los caracteres tal cual están impresos en el papel, sin
    reordenar ni interpretar: "10/09/2026", "10-SEP-26", "10 de septiembre de
    2026". Copiala, no la traduzcas.
  · fecha = esa misma fecha en YYYY-MM-DD.
  En Argentina las facturas se emiten en DÍA/MES/AÑO, SIEMPRE: "10/09/2026" es
  el 10 de septiembre, NO el 9 de octubre. Nunca leas una fecha numérica como
  MES/DÍA/AÑO, aunque el día sea menor o igual a 12.
  Si la fecha que armaste queda después de ${dia}, la leíste mal: revisá el
  orden antes de contestar.
  Si no aparece, "" en los dos campos, con confianza 0.
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
- iva_porcentaje: la alícuota de IVA de esa línea (21, 10.5, 0).
  · Si la factura tiene una columna de IVA por línea, usá la de cada línea.
  · MUY COMÚN Y FÁCIL DE PASAR POR ALTO: muchas facturas de alimentos NO tienen
    esa columna y en cambio MARCAN los renglones de la tasa reducida con un
    símbolo —"**", "(*)", una letra— y lo aclaran en una nota al pie del estilo
    "(**) Productos con tasa de IVA al 10,5 %". Buscá esa nota SIEMPRE: si
    existe, los renglones marcados llevan la tasa que dice la nota y los NO
    marcados la otra. En Argentina van al 10,5% las carnes, frutas, verduras,
    legumbres, granos, harina de trigo, pan y leche; el resto al 21%.
  · Si no discrimina nada y hay una sola tasa, repetí la misma en todas.
  · Si no podés determinarla para una línea, dejala en null con confianza 0. Un
    humano la confirma, y es mejor que una tasa inventada.
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
- iva_porcentaje: la alícuota de IVA de esa línea (21, 10.5, 0).
  · Si la factura tiene una columna de IVA por línea, usá la de cada línea.
  · MUY COMÚN Y FÁCIL DE PASAR POR ALTO: muchas facturas de alimentos NO tienen
    esa columna y en cambio MARCAN los renglones de la tasa reducida con un
    símbolo —"**", "(*)", una letra— y lo aclaran en una nota al pie del estilo
    "(**) Productos con tasa de IVA al 10,5 %". Buscá esa nota SIEMPRE: si
    existe, los renglones marcados llevan la tasa que dice la nota y los NO
    marcados la otra. En Argentina van al 10,5% las carnes, frutas, verduras,
    legumbres, granos, harina de trigo, pan y leche; el resto al 21%.
  · Si no discrimina nada y hay una sola tasa, repetí la misma en todas.
  · Si no podés determinarla para una línea, dejala en null con confianza 0. Un
    humano la confirma, y es mejor que una tasa inventada.
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
// que se pide: la cabecera nunca necesita 3000. `modelo` es obligatorio y no
// tiene default a propósito: cuál de los dos se usa es la decisión medida que
// explica el bloque de arriba, y un default acá la volvería invisible.
async function pedirAlModelo({ base64, mime, prompt, maxTokens, modelo }) {
  if (!modelo) throw new Error('pedirAlModelo: falta el modelo');
  const anthropic = client();
  const resp = await anthropic.messages.create({
    model: modelo,
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
async function extraerCabecera({ base64, mime = 'image/jpeg', hoy } = {}) {
  const { parsed, raw } = await pedirAlModelo({
    base64, mime, prompt: buildPromptCabecera(hoy), maxTokens: 420, modelo: MODELO_CABECERA,
  });
  const factura = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  factura.vendedor = factura.vendedor || '';
  // La fecha impresa viaja cruda hasta `fecha-factura.revisar`, que es quien
  // decide. Acá no se normaliza nada: si el modelo la ordenó mal, el texto es
  // la única prueba de lo que decía el papel, y normalizarlo la borraría.
  factura.fecha_texto = String(factura.fecha_texto == null ? '' : factura.fecha_texto).trim();
  factura.subtotal_factura = factura.subtotal_factura ?? null;
  factura.iva_monto = factura.iva_monto ?? null;
  // El cuadro de IVA del pie. Acá sólo se le dan tipos; si cierra o no contra el
  // total lo decide `facturas.desglosar`, que es donde vive la regla de cuándo
  // gana lo leído sobre lo calculado y con qué tolerancia.
  factura.iva_desglose = normalizarDesgloseIva(factura.iva_desglose);
  factura.otros_impuestos_monto = factura.otros_impuestos_monto ?? null;
  factura.tipo_comprobante = normalizarComprobante(factura.tipo_comprobante);
  factura.cuit_proveedor = normalizarCuit(factura.cuit_proveedor);
  // El número del comprobante: sólo dígitos. Es la identidad de esta factura y
  // de ninguna otra, así que un "0003-00001234" que llegue entero en un campo se
  // parte acá en vez de guardarse como una cadena que después no matchea nada.
  const nro = partirNumero(factura.punto_venta, factura.numero_comprobante);
  factura.punto_venta = nro.puntoVenta;
  factura.numero_comprobante = nro.numero;
  // Si el modelo no se pronunció, el pie de la factura ya lo dice: un IVA en
  // pesos separado del subtotal ES el IVA discriminado. Se deduce sólo cuando
  // el campo no vino, nunca se pisa lo que el modelo afirmó.
  if (typeof factura.iva_discriminado !== 'boolean') {
    factura.iva_discriminado = Number(factura.iva_monto) > 0 && Number(factura.subtotal_factura) > 0;
  }
  return { factura, rawText: raw };
}

// El punto de venta y el número, a dígitos limpios.
//
// El modelo a veces manda las dos mitades juntas en un solo campo ("0003-00001234"
// o "0003 00001234"): si el punto de venta vino vacío y el número trae un
// separador, se parte. Se hace ACÁ y no en la comparación porque la clave que
// identifica una factura se arma con las dos mitades, y una guardada entera no
// vuelve a encontrarse nunca.
function partirNumero(pv, nro) {
  let a = String(pv == null ? '' : pv).replace(/\D/g, '');
  let b = String(nro == null ? '' : nro).trim();
  if (!a) {
    const m = /^(\d{1,5})[\s\-–/]+(\d{1,8})$/.exec(b);
    if (m) { a = m[1]; b = m[2]; }
  }
  b = b.replace(/\D/g, '');
  return { puntoVenta: a, numero: b };
}

// El cuadro de IVA del pie, con tipos. Una entrada por alícuota.
//
// Se descarta la fila a la que le falte cualquiera de los tres números o que
// traiga una alícuota imposible: una entrada a medias no es "casi el cuadro",
// es un cuadro que no cierra, y más abajo se usa justamente para decidir si se
// puede confiar en lo leído. Mejor ninguna entrada que una inventada.
//
// Se ordena por alícuota descendente para que la fila grande —casi siempre la
// del 21%— quede primera en todo lo que se muestre.
function normalizarDesgloseIva(v) {
  if (!Array.isArray(v)) return [];
  const n = x => {
    const y = Number(x);
    return Number.isFinite(y) ? y : null;
  };
  return v
    .map(e => ({ alicuota: n(e && e.alicuota), neto: n(e && e.neto), iva: n(e && e.iva) }))
    .filter(e => e.alicuota != null && e.alicuota > 0 && e.alicuota <= 30
      && e.neto != null && e.neto > 0 && e.iva != null && e.iva >= 0)
    .sort((a, b) => b.alicuota - a.alicuota);
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
    base64, mime, prompt: buildPromptItems(), maxTokens: 3000, modelo: MODELO_ITEMS,
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
    base64, mime, prompt: buildPromptRemito(), maxTokens: 2000, modelo: MODELO_ITEMS,
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
    base64, mime, prompt: buildPrompt(), maxTokens: 3000, modelo: MODELO_ITEMS,
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
  extraerDeImagen, buildPrompt, MODELO_CABECERA, MODELO_ITEMS,
  // Las dos mitades, para pedirlas en paralelo.
  extraerCabecera, extraerItems, buildPromptCabecera, buildPromptItems, aplanar,
  // El remito de un pedido: qué y cuánto llega, sin precios. Ver su comentario.
  extraerItemsRemito, buildPromptRemito,
  // Exportados para poder probarlos sin llamar al modelo.
  normalizarComprobante, normalizarCuit, normalizarDesgloseIva,
};
