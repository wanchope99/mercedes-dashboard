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
Analizá la imagen y extraé los datos de compra. Si hay múltiples productos en la misma
factura, devolvé UNA entrada por producto.

Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional. Cada item:
{
  "fecha": "YYYY-MM-DD",
  "proveedor": "Nombre del proveedor",
  "categoria": "una de las categorías válidas o \\"\\" si no estás seguro",
  "producto": "Nombre del producto",
  "cantidad": 10,
  "unidad": "Kg | Unidad | Caja | Bandeja | Litro | Atado | Bolsa | Maple | ...",
  "precio_unitario": 350,
  "forma_de_pago": "Efectivo | Mercado Pago | Galicia | Echeq | Contado | \\"\\"",
  "dias_credito": 0,
  "entrega_ok": "Sí",
  "notas": "",
  "confianza": { "categoria": 0.0, "producto": 0.0, "precio_unitario": 0.0, "forma_de_pago": 0.0 }
}

Categorías válidas (usá EXACTAMENTE estos nombres):
${cats.CATEGORIAS.map(c => `  · ${c}`).join('\n')}

Reglas:
- "confianza" es tu certeza de 0 a 1 para cada campo. Si no podés leer algo con
  claridad, poné el valor que mejor estimes y una confianza BAJA (< 0.6). NO inventes.
- Si un campo es ilegible, dejá "" (o 0 para números) y confianza 0.
- La fecha debe estar en formato YYYY-MM-DD. Si no aparece, dejala "" (confianza 0).
- forma_de_pago: si la factura dice efectivo/contado en efectivo, poné "Efectivo".
- precio_unitario es el precio por unidad (no el total de la línea).
- Sé conservador: es mejor marcar baja confianza y que un humano confirme,
  que escribir un dato equivocado.`;
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
  let items;
  try { items = JSON.parse(raw); }
  catch (e) { throw new Error('El extractor no devolvió JSON válido: ' + raw.slice(0, 200)); }
  if (!Array.isArray(items)) items = [items];
  return { items, rawText: raw };
}

module.exports = { extraerDeImagen, buildPrompt, MODEL };
