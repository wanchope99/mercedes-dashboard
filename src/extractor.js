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
      "precio_unitario": 350,
      "iva_porcentaje": 21,
      "total_linea": 3500,
      "notas": "",
      "confianza": { "categoria": 0.0, "producto": 0.0, "precio_unitario": 0.0, "iva_porcentaje": 0.0 }
    }
  ]
}

Categorías válidas (usá EXACTAMENTE estos nombres):
${cats.CATEGORIAS.map(c => `  · ${c}`).join('\n')}

Reglas IMPORTANTES:
- DISTINGUÍ forma de pago (cómo se paga: efectivo, transferencia, etc.) de
  días de crédito (plazo: "30 días", "Contado"). NUNCA pongas "30 días" como
  forma de pago: eso es dias_credito = 30. Si dice "Contado" / "Contado efectivo",
  forma_de_pago = "Efectivo" y dias_credito = 0.
- forma_de_pago y dias_credito van en "factura" (son de toda la factura, NO por
  producto).
- iva_porcentaje: la alícuota de IVA de esa línea (21, 10.5, 0). Si la factura la
  discrimina por línea, usá la de cada línea; si es general, repetí la misma.
- precio_unitario = precio por unidad (P.U.), NO el total de la línea.
- total_linea = el total de esa línea tal como figura en la factura (para control).
- total_factura = el TOTAL final de la factura (con impuestos), para control.
- "confianza" 0 a 1. Si no podés leer algo, poné tu mejor estimación con confianza
  BAJA (< 0.6) o "" / 0 si es ilegible. NO inventes. Es mejor que un humano confirme.
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
    precio_unitario: l.precio_unitario ?? l.precioUnit ?? null,
    iva_porcentaje: l.iva_porcentaje ?? l.iva ?? null,
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
