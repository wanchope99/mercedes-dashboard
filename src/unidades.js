// ─── Normalización de unidades de compra → unidad base ──────────────────────────
//
// PROBLEMA: algunos proveedores (ej: Zuccardi) facturan en "Cajas", pero el bar
// vende y FUDO procesa BOTELLAS. 1 Caja = 6 Botellas. Para poder estudiar el
// comportamiento en el tiempo (cuánto vino INGRESÓ en botellas vs cuánto se VENDIÓ
// en botellas) hay que llevar todo a la MISMA unidad base.
//
// ESTRATEGIA (definida con el usuario):
//  1. El extractor (Claude Vision) intenta deducir el FACTOR de la factura
//     (ej: "Caja x6", "Pack 6u", "Caja de 6 botellas") → unidades_por_paquete.
//  2. Si lo encuentra → normalizamos automático: cantidadBase = cantidad * factor.
//  3. Si NO viene factor del extractor pero la unidad es de empaque (Caja, Pack,
//     Cajón…), intentamos deducirlo del TEXTO (nombre del producto, notas, unidad).
//  4. Si aun así no hay factor confiable → se marca como DUDA para que un humano
//     lo confirme UNA vez (mismo mecanismo que categoría / IVA). NUNCA inventa.
//
// Este módulo NO toca la red: funciones puras, testeables.

// ─── Unidad base por categoría ──────────────────────────────────────────────────
// La unidad "atómica" en la que se vende/cuenta el producto. Para bebidas/alcohol
// es la Botella (lo que ve FUDO). El resto, por ahora, se deja tal cual (no se
// normaliza salvo que se pida): kg, unidad, etc.
const UNIDAD_BASE_POR_CATEGORIA = {
  'Bebidas y Alcohol': 'Botella',
};

// Unidades que YA son base (no hace falta convertir).
const UNIDADES_BASE = new Set([
  'botella', 'botellas', 'unidad', 'unidades', 'u', 'un', 'botls', 'botl',
]);

// Unidades de EMPAQUE: agrupan varias unidades base. Necesitan un factor.
const UNIDADES_EMPAQUE = new Set([
  'caja', 'cajas', 'cajon', 'cajones', 'pack', 'packs', 'bulto', 'bultos',
  'six', 'sixpack', 'sixpacks', 'docena', 'docenas', 'fardo', 'fardos',
  'estuche', 'estuches', 'display', 'displays',
]);

// Factores "de calle" conocidos cuando la unidad lo dice sola (sin número).
// Solo se usan como ÚLTIMO recurso y con baja confianza si la factura no aclara.
const FACTOR_IMPLICITO = {
  docena: 12, docenas: 12,
  six: 6, sixpack: 6, sixpacks: 6,
};

function quitarTildes(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function norm(s) {
  return quitarTildes(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

// Singulariza groseramente una unidad para clasificar/mostrar.
function unidadNorm(u) {
  return norm(u).replace(/s$/, ''); // "Cajas" → "caja"
}

function esUnidadBase(u) {
  const n = norm(u);
  return UNIDADES_BASE.has(n) || UNIDADES_BASE.has(n.replace(/s$/, ''));
}
function esUnidadEmpaque(u) {
  const n = norm(u);
  return UNIDADES_EMPAQUE.has(n) || UNIDADES_EMPAQUE.has(n.replace(/s$/, ''));
}

// ─── Deducción del factor desde texto libre ─────────────────────────────────────
// Busca patrones tipo "x6", "x 6", "6u", "pack 6", "caja de 6", "6 botellas",
// "6x750", "6 x 750ml". Devuelve el factor (entero > 1) o null.
function factorDesdeTexto(...textos) {
  const t = norm(textos.filter(Boolean).join(' '));
  if (!t) return null;

  // "caja de 6", "cajon de 12", "pack de 6"
  let m = t.match(/(?:caja|cajon|pack|bulto|estuche|fardo|display)\s*(?:de|x|por)?\s*(\d{1,3})\b/);
  if (m) { const n = parseInt(m[1], 10); if (n > 1 && n <= 600) return n; }

  // "x6", "x 6", "6x" (evitando capturar mililitros tipo 6x750 → tomamos el primero)
  m = t.match(/\bx\s*(\d{1,3})\b/);
  if (m) { const n = parseInt(m[1], 10); if (n > 1 && n <= 600) return n; }

  // "6x750ml" → el factor es el 6, no el 750
  m = t.match(/\b(\d{1,3})\s*x\s*\d{2,4}\s*(?:ml|cc|cm3|l)\b/);
  if (m) { const n = parseInt(m[1], 10); if (n > 1 && n <= 600) return n; }

  // "6 botellas", "6 unidades", "6 u"
  m = t.match(/\b(\d{1,3})\s*(?:botellas?|unidades?|u\b)/);
  if (m) { const n = parseInt(m[1], 10); if (n > 1 && n <= 600) return n; }

  // "6u" pegado
  m = t.match(/\b(\d{1,3})u\b/);
  if (m) { const n = parseInt(m[1], 10); if (n > 1 && n <= 600) return n; }

  return null;
}

// ─── Resolución del factor de conversión para una línea ──────────────────────────
// Entrada: { categoria, unidad, producto, notas, unidadesPorPaquete (del extractor) }
// Salida: {
//   normalizable: bool,        // la categoría tiene unidad base definida (ej: bebidas)
//   esBase: bool,              // la unidad ya es la base → factor 1
//   factor: number|null,       // botellas por paquete (null = desconocido)
//   unidadBase: string,        // 'Botella'
//   fuente: 'extractor'|'texto'|'implicito'|'base'|null,
//   confianza: number,         // 0..1
//   necesitaConfirmar: bool,   // empaque sin factor confiable → preguntar
// }
function resolverFactor({ categoria, unidad, producto, notas, unidadesPorPaquete } = {}) {
  const unidadBase = UNIDAD_BASE_POR_CATEGORIA[(categoria || '').trim()] || null;
  const normalizable = Boolean(unidadBase);

  const out = {
    normalizable, esBase: false, factor: null, unidadBase: unidadBase || '',
    fuente: null, confianza: 0, necesitaConfirmar: false,
  };
  if (!normalizable) return out; // categoría que no normalizamos: dejar tal cual

  // 1) Unidad ya es base → factor 1
  if (esUnidadBase(unidad) || !unidad) {
    out.esBase = true; out.factor = 1; out.fuente = 'base'; out.confianza = 1;
    return out;
  }

  // 2) Factor que vino del extractor (lo leyó de la factura)
  const fx = Number(unidadesPorPaquete);
  if (Number.isFinite(fx) && fx > 1 && fx <= 600) {
    out.factor = Math.round(fx); out.fuente = 'extractor'; out.confianza = 0.95;
    return out;
  }

  // 3) Deducir del texto (nombre del producto, notas, la propia unidad)
  const fxTexto = factorDesdeTexto(producto, notas, unidad);
  if (fxTexto) {
    out.factor = fxTexto; out.fuente = 'texto'; out.confianza = 0.8;
    return out;
  }

  // 4) Factor implícito de la unidad (docena=12, six=6) — último recurso
  const ui = unidadNorm(unidad);
  if (FACTOR_IMPLICITO[ui]) {
    out.factor = FACTOR_IMPLICITO[ui]; out.fuente = 'implicito'; out.confianza = 0.6;
    return out;
  }

  // 5) Empaque sin factor → no inventamos: hay que confirmar.
  if (esUnidadEmpaque(unidad)) {
    out.necesitaConfirmar = true;
    return out;
  }

  // Unidad rara no reconocida en categoría normalizable: tratar como base (factor 1)
  // pero dejar señal por las dudas.
  out.esBase = true; out.factor = 1; out.fuente = 'base'; out.confianza = 0.5;
  return out;
}

// ─── Normalización de una línea de compra ─────────────────────────────────────────
// Devuelve la línea con cantidad/unidad/precio LLEVADOS A LA UNIDAD BASE, más los
// campos originales preservados. Si no es normalizable o falta factor, devuelve la
// línea casi intacta con flags para que el caller decida (escribir o preguntar).
//
// Conserva el TOTAL de la línea: si 5 cajas a $X la caja → 30 botellas a $X/6 c/u.
function normalizarLinea(item = {}) {
  const r = resolverFactor({
    categoria: item.categoria,
    unidad: item.unidad,
    producto: item.producto,
    notas: item.notas,
    unidadesPorPaquete: item.unidadesPorPaquete ?? item.unidades_por_paquete,
  });

  const base = {
    ...item,
    // Campos originales preservados (lo que decía la factura)
    cantidadOriginal: item.cantidad ?? null,
    unidadOriginal: item.unidad || '',
    precioUnitOriginal: item.precioUnit ?? item.precio_unitario ?? null,
    factorConversion: r.factor,
    factorFuente: r.fuente,
    unidadBase: r.unidadBase,
    normalizada: false,
  };

  // No normalizable (no es bebida) o ya es base → no cambia cantidad/precio.
  if (!r.normalizable) {
    return { ...base, normalizable: false, necesitaConfirmarFactor: false };
  }
  if (r.esBase) {
    return {
      ...base, normalizable: true, necesitaConfirmarFactor: false,
      // dejar unidad como Botella para uniformar la base
      unidad: r.unidadBase || item.unidad || '',
      factorConversion: 1, normalizada: true,
    };
  }
  if (r.necesitaConfirmar || !r.factor) {
    // Empaque sin factor confiable: NO tocar cantidad. Marcar para preguntar.
    return { ...base, normalizable: true, necesitaConfirmarFactor: true };
  }

  // Normalizar: multiplicar cantidad por el factor, dividir el precio unitario.
  const cant = Number(item.cantidad);
  const pu = Number(item.precioUnit ?? item.precio_unitario);
  const factor = r.factor;
  const cantidadBase = Number.isFinite(cant) ? cant * factor : null;
  const precioBase = Number.isFinite(pu) ? Math.round((pu / factor) * 100) / 100 : null;

  return {
    ...base,
    normalizable: true,
    necesitaConfirmarFactor: false,
    normalizada: true,
    cantidad: cantidadBase,
    unidad: r.unidadBase,
    precioUnit: precioBase,
    factorConversion: factor,
    factorFuente: r.fuente,
  };
}

module.exports = {
  UNIDAD_BASE_POR_CATEGORIA, UNIDADES_BASE, UNIDADES_EMPAQUE,
  norm, unidadNorm, esUnidadBase, esUnidadEmpaque,
  factorDesdeTexto, resolverFactor, normalizarLinea,
};
