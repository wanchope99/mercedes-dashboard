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

// Devuelve { items: [...], rawText }. Lanza si la API falla.
async function extraerDeImagen({ base64, mime = 'image/jpeg' }) {
  const anthropic = client();
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: buildPrompt() },
      ],
    }],
  });
  let raw = (resp.content[0] && resp.content[0].text || '').trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error('El extractor no devolvió JSON válido: ' + raw.slice(0, 200)); }

  // Soportar dos formas: { factura, items } (nueva) o un array suelto (compat).
  let factura = {}, lineas = [];
  if (Array.isArray(parsed)) {
    lineas = parsed;
  } else if (parsed && typeof parsed === 'object') {
    factura = parsed.factura || {};
    lineas = Array.isArray(parsed.items) ? parsed.items : [];
  }

  factura.vendedor = factura.vendedor || '';
  const fconf = factura.confianza || {};
  // Aplanar: cada línea hereda los datos de cabecera de la factura. Así el resto
  // del pipeline (resolverItem, etc.) sigue trabajando con items planos.
  const items = lineas.map(l => ({
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
      ...(l.confianza || {}),
      // Heredar la confianza de forma_de_pago desde la cabecera
      forma_de_pago: fconf.forma_de_pago ?? (l.confianza && l.confianza.forma_de_pago) ?? 1,
    },
  }));

  return { items, factura, rawText: raw };
}

module.exports = { extraerDeImagen, buildPrompt, MODEL };
