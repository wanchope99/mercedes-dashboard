// ─── Categorías, normalización e inferencia para Compras de Proveedores ─────────
//
// Fuente única de verdad para las CATEGORÍAS de ingredientes (las mismas que usa
// FUDO en su sección "Ingredientes"). Toda fila que se escriba en la hoja
// "Compras" de la planilla Comparacion Proveedores usa estas categorías.
//
// Este módulo NO toca la red: son funciones puras para que server.js y los tests
// las usen. La inferencia "aprende" mirando las filas ya cargadas (no hay hoja
// de mapeos aparte): si El Ekeko siempre fue "Carnes y Embutidos", una compra
// nueva de El Ekeko sin categoría clara sugiere esa categoría.

// ─── Categorías canónicas (FUDO Ingredientes) ───────────────────────────────────
const CATEGORIAS = [
  'Pescados y Mariscos',
  'Frutas y Verduras',
  'Aceites, Vinagres y Grasas',
  'Carnes y Embutidos',
  'Condimentos y Otros Secos',
  'Conservas, Fermentos y Salsas Industriales',
  'Legumbres, Cereales y Harinas',
  'Lacteos y Huevos',
  'Panificados y Masas',
  'Bebidas y Alcohol',
  // Catch-all para gastos que no son ingredientes pero entran por factura
  'Insumos',
  'Otro',
];

const CATEGORIAS_SET = new Set(CATEGORIAS);

// ─── Mapeo de categorías VIEJAS (las que ya están en Compras) → canónicas ────────
const MAPEO_CATEGORIAS_VIEJAS = {
  'pescados y mariscos': 'Pescados y Mariscos',
  'pescado': 'Pescados y Mariscos',
  'pescados': 'Pescados y Mariscos',
  'mariscos': 'Pescados y Mariscos',
  'frutas y verduras': 'Frutas y Verduras',
  'verduleria': 'Frutas y Verduras',
  'fruta': 'Frutas y Verduras',
  'verdura': 'Frutas y Verduras',
  'aceites, vinagres y grasas': 'Aceites, Vinagres y Grasas',
  'aceites': 'Aceites, Vinagres y Grasas',
  'aceite': 'Aceites, Vinagres y Grasas',
  'carnes': 'Carnes y Embutidos',
  'carne': 'Carnes y Embutidos',
  'carnes y embutidos': 'Carnes y Embutidos',
  'embutidos': 'Carnes y Embutidos',
  'condimentos y otros secos': 'Condimentos y Otros Secos',
  'condimentos': 'Condimentos y Otros Secos',
  'secos': 'Condimentos y Otros Secos',
  'secos y conservas': 'Condimentos y Otros Secos',
  'conservas, fermentos y salsas industriales': 'Conservas, Fermentos y Salsas Industriales',
  'conservas': 'Conservas, Fermentos y Salsas Industriales',
  'salsas': 'Conservas, Fermentos y Salsas Industriales',
  'fermentos': 'Conservas, Fermentos y Salsas Industriales',
  'legumbres, cereales y harinas': 'Legumbres, Cereales y Harinas',
  'legumbres': 'Legumbres, Cereales y Harinas',
  'cereales': 'Legumbres, Cereales y Harinas',
  'harinas': 'Legumbres, Cereales y Harinas',
  'harina': 'Legumbres, Cereales y Harinas',
  'lacteos y huevos': 'Lacteos y Huevos',
  'lacteos': 'Lacteos y Huevos',
  'huevos': 'Lacteos y Huevos',
  'panificados y masas': 'Panificados y Masas',
  'panificados': 'Panificados y Masas',
  'panaderia': 'Panificados y Masas',
  'pan': 'Panificados y Masas',
  'bebidas y alcohol': 'Bebidas y Alcohol',
  'bebidas': 'Bebidas y Alcohol',
  'bebida': 'Bebidas y Alcohol',
  'alcohol': 'Bebidas y Alcohol',
  'vinos': 'Bebidas y Alcohol',
  'vino': 'Bebidas y Alcohol',
  // No-ingredientes
  'insumos': 'Insumos',
  'limpieza': 'Insumos',
  'otro': 'Otro',
  'otros': 'Otro',
};

// ─── Palabras clave por categoría (heurística de respaldo para inferir) ──────────
const KEYWORDS = {
  'Pescados y Mariscos': ['langostino', 'calamar', 'corvina', 'chernia', 'lisa', 'merluza', 'mero', 'anchoa', 'pesca', 'pescado', 'marisco', 'cholga', 'mejillon', 'ostra', 'camaron', 'salmon', 'atun', 'trucha', 'pulpo', 'rabas'],
  'Frutas y Verduras': ['lechuga', 'tomate', 'cebolla', 'papa', 'zanahoria', 'zapallo', 'ajo', 'lima', 'limon', 'anco', 'espinaca', 'jalapeno', 'verdura', 'fruta', 'manzana', 'banana', 'palta', 'morron', 'pimiento', 'jengibre', 'remolacha', 'repollito', 'repollo', 'bruselas', 'rucula', 'apio', 'puerro', 'champignon', 'hongo', 'batata'],
  'Aceites, Vinagres y Grasas': ['aceite', 'oliva', 'oliovita', 'vinagre', 'grasa', 'manteca', 'margarina', 'alto oleico'],
  'Carnes y Embutidos': ['ojo de bife', 'bife', 'matambre', 'matambrito', 'lomo', 'cuadril', 'marucha', 'carrillera', 'rabo', 'hueso', 'huesito', 'carne', 'pollo', 'cerdo', 'chorizo', 'panceta', 'bondiola', 'asado', 'vacio', 'entrana', 'achura', 'quijada', 'molida', 'milanesa', 'jamon', 'salame', 'lechon'],
  'Condimentos y Otros Secos': ['sal', 'pimienta', 'comino', 'oregano', 'pimenton', 'especia', 'condimento', 'azucar', 'levadura', 'bicarbonato', 'curry', 'laurel', 'nuez moscada', 'gelatina'],
  'Conservas, Fermentos y Salsas Industriales': ['kimchi', 'tabasco', 'alcaparron', 'alcaparra', 'soja', 'gochujang', 'gochu', 'chipotle', 'salsa', 'mostaza', 'mayonesa', 'ketchup', 'aceituna', 'pepinillo', 'conserva', 'enlatado', 'pesto', 'tomate triturado', 'pure de tomate', 'fish sauce', 'miso', 'vino cocina'],
  'Legumbres, Cereales y Harinas': ['harina', 'lenteja', 'garbanzo', 'poroto', 'arroz', 'fideo', 'pasta', 'avena', 'polenta', 'maiz', 'cereal', 'legumbre', 'semola', 'quinoa', 'arveja'],
  'Lacteos y Huevos': ['huevo', 'maple', 'leche', 'crema', 'queso', 'manteca', 'yogur', 'ricota', 'muzzarella', 'mozzarella', 'parmesano', 'dulce de leche', 'lacteo'],
  'Panificados y Masas': ['pan', 'panificado', 'factura', 'masa', 'tapa', 'prepizza', 'bizcocho', 'galleta', 'tostada', 'budin', 'medialuna', 'acequia'],
  'Bebidas y Alcohol': ['vino', 'cerveza', 'birra', 'barril', 'gaseosa', 'coca', 'sprite', 'schweppes', 'tonica', 'agua', 'soda', 'vermut', 'vermu', 'whisky', 'gin', 'fernet', 'aperitivo', 'espumante', 'champagne', 'malbec', 'cabernet', 'pinot', 'chardonnay', 'sauvignon', 'jugo', 'tetra', 'conac'],
  'Insumos': ['detergente', 'lavandina', 'esponja', 'fibra', 'rejilla', 'trapo', 'virulana', 'jabon', 'limpiador', 'rociador', 'escoba', 'balde', 'cloro', 'papelera', 'film', 'aluminio', 'papel', 'servilleta', 'descartable', 'bolsa', 'guante', 'frasco', 'precinto', 'rollo', 'vela', 'pila', 'escarbadiente', 'alumax', 'polyfilm', 'folex', 'tupper', 'envase'],
};

// ─── Medios de pago ──────────────────────────────────────────────────────────────
// REGLA CLAVE: "Efectivo" en una factura = "Efectivo Local" en el sistema.
const MEDIOS_PAGO = ['Efectivo Local', 'Mercado Pago', 'Galicia', 'Echeq', 'Otro'];

function normalizarMedioPago(medio) {
  const m = (medio || '').toString().trim().toLowerCase();
  if (!m) return '';
  if (m === 'efectivo' || m === 'contado efectivo' || m === 'cash') return 'Efectivo Local';
  if (m.includes('efectivo')) return 'Efectivo Local';
  if (m.includes('mercado pago') || m === 'mp') return 'Mercado Pago';
  if (m.includes('galicia')) return 'Galicia';
  if (m.includes('echeq') || m.includes('cheque')) return 'Echeq';
  if (m === 'contado' || m.includes('contado')) return 'Efectivo Local';
  return medio; // dejar tal cual si no matchea (puede quedar pendiente de confirmar)
}

// ─── Helpers de texto ────────────────────────────────────────────────────────────
function quitarTildes(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function norm(s) {
  return quitarTildes(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

// ─── Normalización de categoría ──────────────────────────────────────────────────
// Devuelve { categoria, ok }. ok=false → no reconocida con certeza.
function normalizarCategoria(cat) {
  const raw = (cat || '').toString().trim();
  if (!raw) return { categoria: '', ok: false };
  if (CATEGORIAS_SET.has(raw)) return { categoria: raw, ok: true };
  const n = norm(raw);
  if (MAPEO_CATEGORIAS_VIEJAS[n]) return { categoria: MAPEO_CATEGORIAS_VIEJAS[n], ok: true };
  for (const c of CATEGORIAS) {
    if (norm(c) === n) return { categoria: c, ok: true };
  }
  return { categoria: raw, ok: false };
}

// ─── Inferencia por keywords ─────────────────────────────────────────────────────
function inferirPorKeywords(nombreProducto) {
  const n = norm(nombreProducto);
  if (!n) return null;
  let mejor = null, mejorLargo = 0;
  for (const [cat, kws] of Object.entries(KEYWORDS)) {
    for (const kw of kws) {
      if (n.includes(kw) && kw.length > mejorLargo) {
        mejor = cat; mejorLargo = kw.length;
      }
    }
  }
  return mejor;
}

// ─── Inferencia a partir del histórico de Compras ────────────────────────────────
// historial: [{ proveedor, producto, categoria }] (categoria ya canónica)
function construirIndiceInferencia(historial) {
  const porProducto = {};
  const porProveedor = {};
  for (const r of historial || []) {
    const cat = (r.categoria || '').trim();
    if (!cat || !CATEGORIAS_SET.has(cat)) continue;
    const p = norm(r.producto);
    const pv = norm(r.proveedor);
    if (p) {
      porProducto[p] = porProducto[p] || {};
      porProducto[p][cat] = (porProducto[p][cat] || 0) + 1;
    }
    if (pv) {
      porProveedor[pv] = porProveedor[pv] || {};
      porProveedor[pv][cat] = (porProveedor[pv][cat] || 0) + 1;
    }
  }
  return { porProducto, porProveedor };
}

function topCategoria(conteo) {
  if (!conteo) return null;
  let mejor = null, max = 0, total = 0;
  for (const [cat, n] of Object.entries(conteo)) {
    total += n;
    if (n > max) { max = n; mejor = cat; }
  }
  return mejor ? { categoria: mejor, conteo: max, total } : null;
}

// Sugiere categoría para (proveedor, producto). Devuelve { categoria, fuente, confianza } o null.
function sugerirCategoria({ proveedor, producto }, indice) {
  const p = norm(producto);
  const pv = norm(proveedor);

  if (indice && indice.porProducto[p]) {
    const t = topCategoria(indice.porProducto[p]);
    if (t) return { categoria: t.categoria, fuente: 'producto-historico', confianza: t.conteo / t.total };
  }
  if (indice && indice.porProveedor[pv]) {
    const t = topCategoria(indice.porProveedor[pv]);
    if (t && t.total >= 2 && (t.conteo / t.total) >= 0.7) {
      return { categoria: t.categoria, fuente: 'proveedor-historico', confianza: t.conteo / t.total };
    }
  }
  const kw = inferirPorKeywords(producto);
  if (kw) return { categoria: kw, fuente: 'keywords', confianza: 0.5 };
  return null;
}

// ─── Resolución completa de una fila extraída ────────────────────────────────────
// item crudo del extractor + índice → { categoria, medioPago, dudas: [...] }.
function resolverItem(item, indice) {
  const dudas = [];

  let categoria = '';
  const normCat = normalizarCategoria(item.categoria);
  if (normCat.ok) {
    categoria = normCat.categoria;
  } else {
    const sug = sugerirCategoria({ proveedor: item.proveedor, producto: item.producto }, indice);
    if (sug && sug.confianza >= 0.99) {
      categoria = sug.categoria; // producto idéntico ya clasificado: sin molestar
    } else if (sug) {
      categoria = sug.categoria;
      dudas.push({ campo: 'categoria', sugerido: sug.categoria, fuente: sug.fuente, opciones: CATEGORIAS });
    } else {
      dudas.push({ campo: 'categoria', sugerido: '', fuente: 'ninguna', opciones: CATEGORIAS });
    }
  }

  let medioPago = normalizarMedioPago(item.forma_de_pago || item.medioPago);
  if (!medioPago) {
    dudas.push({ campo: 'medioPago', sugerido: '', fuente: 'ninguna', opciones: MEDIOS_PAGO });
  } else if (!MEDIOS_PAGO.includes(medioPago)) {
    dudas.push({ campo: 'medioPago', sugerido: medioPago, fuente: 'normalizado', opciones: MEDIOS_PAGO });
  }

  if (!item.producto || !item.producto.toString().trim()) {
    dudas.push({ campo: 'producto', sugerido: item.producto || '', fuente: 'ilegible', opciones: [] });
  }
  const precio = Number(item.precio_unitario);
  if (!Number.isFinite(precio) || precio <= 0) {
    dudas.push({ campo: 'precio_unitario', sugerido: item.precio_unitario || '', fuente: 'ilegible', opciones: [] });
  }

  return { categoria, medioPago, dudas };
}


// ─── Nombre canónico de producto (para agrupar equivalentes en la vista) ────────
// Quita sufijos que describen la FORMA de cobro/entrega, no el producto:
// "+ IVA", "en Remito", "c/IVA", "s/IVA", "con IVA", códigos entre [] o (), etc.
// "Langostino Entero L1 Congelado a Bordo + IVA" y "... en Remito" → mismo canónico.
function nombreCanonico(nombre) {
  let s = (nombre || '').toString();
  // Quitar codigos entre corchetes o parentesis: [EMLB027], (964043)
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  // Quitar sufijos de cobro/entrega/IVA (incluyendo un "+" previo)
  s = s.replace(/\+?\s*con\s+iva/gi, ' ');
  s = s.replace(/\+?\s*sin\s+iva/gi, ' ');
  s = s.replace(/\+?\s*c\/\s*iva/gi, ' ');
  s = s.replace(/\+?\s*s\/\s*iva/gi, ' ');
  s = s.replace(/\+\s*iva/gi, ' ');
  s = s.replace(/\biva\s*\d+([.,]\d+)?\s*%?/gi, ' ');
  s = s.replace(/\biva\b/gi, ' ');
  s = s.replace(/\ben\s+remito\b/gi, ' ');
  s = s.replace(/\bremito\b/gi, ' ');
  // Compactar espacios y limpiar un "+" o separador suelto que haya quedado
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/\s+\+\s+/g, ' ').replace(/\s*\+\s*$/g, '').trim();
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || (nombre || '').toString().trim();
}


// ─── Normalización de nombre de proveedor (alias) ───────────────────────────────
// Algunos proveedores aparecen en la factura con un nombre distinto al que usamos.
// Reglas:
//  · "Adicional 2015"  → "Thames"
//  · vendedor "Diego Wesenack" (en cualquier factura) → proveedor "Thames"
// alias por nombre: { nombreNormalizado: 'Nombre Final' }
const ALIAS_PROVEEDOR = {
  'adicional 2015': 'Thames',
  'adicional2015': 'Thames',
};
// alias por vendedor (si el vendedor matchea, se fuerza ese proveedor)
const ALIAS_POR_VENDEDOR = {
  'diego wesenack': 'Thames',
};

function normalizarProveedor(nombre, vendedor) {
  const v = norm(vendedor);
  for (const [k, final] of Object.entries(ALIAS_POR_VENDEDOR)) {
    if (v && v.includes(k)) return final;
  }
  const n = norm(nombre);
  if (ALIAS_PROVEEDOR[n]) return ALIAS_PROVEEDOR[n];
  // match parcial (por si viene "Adicional 2015 SRL" o similar)
  for (const [k, final] of Object.entries(ALIAS_PROVEEDOR)) {
    if (n && n.includes(k)) return final;
  }
  return (nombre || '').toString().trim();
}

module.exports = {
  CATEGORIAS, CATEGORIAS_SET, MEDIOS_PAGO,
  MAPEO_CATEGORIAS_VIEJAS, KEYWORDS,
  normalizarMedioPago, normalizarCategoria,
  inferirPorKeywords, construirIndiceInferencia, sugerirCategoria,
  resolverItem, norm, nombreCanonico, normalizarProveedor,
};
