// ─── Régimen fiscal — simular meses cerrados como Responsable Inscripto ────────
//
// El bar tributa hoy como Monotributo: una cuota fija, y el costo fiscal es casi
// cero como porcentaje de los ingresos. Al pasar a Responsable Inscripto el costo
// deja de ser una cuota y pasa a ser proporcional a la actividad: IVA (débito
// menos crédito), Ingresos Brutos y Ganancias.
//
// Este módulo recalcula meses REALES ya cerrados como si hubieran ocurrido bajo
// RI. No proyecta ni estima actividad: toma la plata que efectivamente entró y
// salió, y le aplica el régimen nuevo.
//
// ─── Lo que este módulo NO es ─────────────────────────────────────────────────
//
// No es asesoramiento fiscal. Las alícuotas y las escalas viven en PARAMETROS y
// se pueden pisar enteras desde la pantalla, porque quien las valida es el
// contador, no este archivo. Hardcodearlas como verdad sería fingir una certeza
// que el código no tiene.
//
// ─── Por qué el crédito fiscal es un RANGO y no un número ─────────────────────
//
// El libro (hoja Movimientos) guarda el total con impuestos y nada más: no tiene
// IVA, ni neto, ni CUIT, ni tipo de comprobante. La hoja Compras sí desglosa IVA
// por línea, pero cubre ~90 renglones de ~20 proveedores — es la muestra de las
// facturas que pasaron por el bot, no el universo del gasto.
//
// Entonces el crédito no se lee: se estima. Y una estimación que se presenta como
// un número exacto es peor que una que se presenta como rango, porque invita a
// decidir sobre una precisión que no existe. Todo lo que devuelve este módulo
// viene como { min, esperado, max } y con su cobertura declarada:
//
//   · min      → lo que se recupera si todo lo no clasificado NO da factura A
//   · max      → lo que se recupera si todo lo no clasificado SÍ da factura A
//   · esperado → el punto medio ponderado por lo que sí se sabe
//
// El rango se angosta solo a medida que se completa el padrón de proveedores. Esa
// es la señal de progreso: no "cuántos proveedores cargué" sino "cuánto se achicó
// la incertidumbre en pesos".

// ─── Parámetros: todos overridables desde la pantalla ─────────────────────────
//
// A CONFIRMAR CON EL CONTADOR. Los defaults son un punto de partida razonable
// para poder correr el modelo, no una afirmación sobre la ley vigente.
const PARAMETROS = {
  // IVA de ventas. Gastronomía: alícuota general.
  ivaVentasPct: 21,

  // IVA esperable por categoría de gasto (columna J de Movimientos), cuando el
  // proveedor no tiene alícuota declarada en el padrón ni observada en Compras.
  // El rango existe porque una categoría mezcla alícuotas: en Mercadería, carne
  // y verdura van al 10,5% y bebida y secos al 21%.
  ivaPorCategoria: {
    'Mercaderia':        { min: 10.5, esperado: 16,   max: 21 },
    'Insumos':           { min: 21,   esperado: 21,   max: 21 },
    'Operativos':        { min: 10.5, esperado: 21,   max: 21 },
    'Servicios':         { min: 21,   esperado: 21,   max: 21 },
    'Cocina':            { min: 21,   esperado: 21,   max: 21 },
    'Sala':              { min: 21,   esperado: 21,   max: 21 },
    'Mobiliario':        { min: 21,   esperado: 21,   max: 21 },
    'Frios':             { min: 21,   esperado: 21,   max: 21 },
    'Legal / Escribano': { min: 21,   esperado: 21,   max: 21 },
    'Alquiler':          { min: 0,    esperado: 21,   max: 21 },
    // La comisión del posnet de Galicia. Es plata real y todos los meses: el
    // cierre la manda acá como gasto (Bruto − Neto acreditado), y hoy no se
    // computa como nada. Sobre la venta bancarizada son varios puntos al año.
    'Financieros':       { min: 21,   esperado: 21,   max: 21 },
    'Otros':             { min: 0,    esperado: 21,   max: 21 },
  },

  // ─── Lo que el proveedor te cobra de más por empezar a facturar ─────────────
  //
  // Decisión de Gonzalo (31/08/2026), y es la que más cambia el resultado de
  // todo este módulo. Hasta acá el cálculo asumía que el precio de hoy YA tiene
  // el IVA adentro, así que al pasar a RI el crédito salía de adentro del mismo
  // precio y aparecía como ahorro puro. Eso es cierto para el que ya te factura
  // A. Para el que hoy no factura es falso: cuando le pidas factura no va a
  // absorber el impuesto, te lo va a agregar al precio.
  //
  // Y cuando lo agrega, la cuenta se cierra sola:
  //
  //     pagás  G × (1 + p/100)      recuperás  G × p/100      te cuesta  G
  //
  // O sea NEUTRO: el crédito existe pero no es plata que ganás, es plata que
  // pusiste antes. Sin este supuesto el modelo mostraba un ahorro de ~17% sobre
  // todo el gasto sin relevar que no va a ocurrir.
  //
  // El aumento es la alícuota del proveedor, porque es literalmente el IVA que
  // agrega. Por eso `pctReducido` para los de 10,5%: El Ekeko y las
  // verdulerías/fruterías no pueden agregar 21 sobre algo que vende al 10,5.
  aumentoAlFacturar: {
    activo: true,
    pctDefault: 21,
    pctReducido: 10.5,
    // Por nombre normalizado (sin acentos, minúsculas). Match exacto.
    porProveedor: { 'el ekeko': 10.5 },
    // Frutas y verduras, por cómo se escriben en la planilla. Es un patrón y no
    // una lista de nombres porque el mismo proveedor aparece escrito de varias
    // formas según quién cargó la fila.
    patronesReducidos: ['verdul', 'frut', 'granja', 'huerta', 'quinta'],
  },

  // Categorías que NO generan crédito fiscal por naturaleza, sin importar quién
  // sea el proveedor. No es que no se sepa: es que no hay IVA que recuperar.
  //   · Personal → los sueldos están fuera del objeto del impuesto.
  //   · Fiscales → un impuesto no genera crédito de otro impuesto.
  categoriasSinCredito: ['Personal', 'Fiscales'],

  // Ingresos Brutos — CABA. Gastronomía: 3,5% (confirmado por Gonzalo, 01/09/2026).
  iibbPct: 3.5,

  // ─── Beneficio de transición Monotributo → RI ──────────────────────────────
  //
  // El bar es elegible (confirmado por Gonzalo, 01/09/2026): el IVA a pagar
  // (débito menos crédito) se reduce 50% el primer año como RI, 30% el segundo
  // y 10% el tercero. Si el saldo del mes da $6M, el primer año se pagan $3M.
  // La pantalla elige el año; `reduccionIvaPct` es el valor vigente y es el que
  // usa `descuentoEfectivo` cuando la pantalla no manda otro. Los porcentajes
  // los valida el contador, como todo lo demás de este archivo.
  reduccionIvaPorAnio: { 1: 50, 2: 30, 3: 10 },
  reduccionIvaPct: 50,

  // Ganancias. Dos figuras porque todavía no está definida cuál va a ser.
  // Escala progresiva por tramos: se paga `fijo` + `pct` sobre el excedente de `desde`.
  gananciasPersonaHumana: [
    { desde: 0,          fijo: 0,        pct: 5 },
    { desde: 20000000,   fijo: 1000000,  pct: 15 },
    { desde: 60000000,   fijo: 7000000,  pct: 27 },
    { desde: 120000000,  fijo: 23200000, pct: 35 },
  ],
  gananciasSociedad: [
    { desde: 0,          fijo: 0,        pct: 25 },
    { desde: 100000000,  fijo: 25000000, pct: 30 },
    { desde: 1000000000, fijo: 295000000, pct: 35 },
  ],

  // Lo que se paga HOY de monotributo, por mes. Se ingresa a mano: la categoría
  // `Fiscales` del libro no sirve como línea de base (dio $0 en julio y agosto, y
  // las cargas sociales se están cargando dentro de `Personal`).
  cuotaMonotributoMensual: 0,

  // ─── Deducibilidad en Ganancias: dos ajustes que bajan mucho el gasto ──────
  //
  // 1) Personal. La hoja `Nómina` distingue `Sueldo actual` (el neto total que
  //    cobra la persona) de `En blanco neto` (la parte que va por recibo). Sólo
  //    la parte en blanco tiene respaldo y se puede deducir. Lo que se paga por
  //    fuera es costo real del bar y NO es gasto deducible.
  //    La ruta calcula esta fracción desde `Nómina!D / Nómina!C` y la inyecta;
  //    el default de 1 existe para que el módulo corra sin nómina, no porque
  //    todo esté en blanco.
  pctPersonalDeducible: 1,

  // 2) Equipamiento. Una heladera no es gasto del mes: se amortiza. El libro de
  //    bienes de uso no existe, así que se aproxima con amortización lineal.
  //    Es una aproximación declarada, no un cálculo impositivo.
  categoriasEquipamiento: ['Cocina', 'Sala', 'Mobiliario', 'Frios', 'Fondo de Comercio'],
  amortizacionAnios: 5,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// IVA contenido en un monto que YA lo incluye. Es la operación que se repite en
// todo el módulo: el libro guarda importes finales, nunca netos.
function ivaContenido(montoConIva, alicuotaPct) {
  const a = Number(alicuotaPct) || 0;
  if (a <= 0) return 0;
  return (Number(montoConIva) || 0) * (a / (100 + a));
}

// Neto de un monto con IVA incluido.
function netoDe(montoConIva, alicuotaPct) {
  const a = Number(alicuotaPct) || 0;
  return (Number(montoConIva) || 0) / (1 + a / 100);
}

// Escala progresiva por tramos: fijo del tramo + pct sobre el excedente.
function aplicarEscala(base, tramos) {
  const b = Number(base) || 0;
  if (b <= 0) return 0;
  const orden = [...(tramos || [])].sort((x, y) => x.desde - y.desde);
  let tramo = orden[0];
  for (const t of orden) if (b >= t.desde) tramo = t;
  if (!tramo) return 0;
  return tramo.fijo + (b - tramo.desde) * (tramo.pct / 100);
}

// Cuánto Ganancias se ahorra el PRÓXIMO peso deducible. Es la alícuota del tramo
// donde cae la utilidad, no la efectiva: la pregunta que responde es "si deduzco
// un peso más de esta categoría, cuánto menos pago", y ésa la contesta el tramo.
// Con utilidad negativa o cero es 0 — no hay impuesto del que descontar.
function tasaMarginal(base, tramos) {
  const b = Number(base) || 0;
  if (b <= 0) return 0;
  const orden = [...(tramos || [])].sort((x, y) => x.desde - y.desde);
  let tramo = orden[0];
  for (const t of orden) if (b >= t.desde) tramo = t;
  return tramo ? (Number(tramo.pct) || 0) / 100 : 0;
}

// Las únicas alícuotas de IVA que existen. Cualquier otra cosa que aparezca en
// la planilla es ruido de formato o un error de carga, y se descarta en vez de
// propagarse a un cálculo de plata.
const ALICUOTAS_CONOCIDAS = [0, 2.5, 5, 10.5, 21, 27];

// Normaliza un valor leído de la planilla a una alícuota real.
//
// Caso visto en los datos reales: la celda `% IVA` de Vinandina exporta como
// "2100%" porque contiene el número 21 con formato de porcentaje — Sheets
// renderiza 21 como 2100%. La fórmula de la hoja usa L/100 y da bien, pero el
// texto exportado miente. Un valor mayor a 100 es siempre ese caso.
function normalizarAlicuota(valor) {
  let v = Number(valor);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v > 100) v = v / 100;                       // 2100% → 21
  // Snap a la alícuota conocida más cercana, con tolerancia chica: 20,99 es 21,
  // pero 15 no es nada y se descarta.
  let mejor = null, dist = Infinity;
  for (const a of ALICUOTAS_CONOCIDAS) {
    const d = Math.abs(a - v);
    if (d < dist) { dist = d; mejor = a; }
  }
  return dist <= 0.6 ? mejor : null;
}

const vacioRango = () => ({ min: 0, esperado: 0, max: 0 });
function sumarRango(a, b) {
  return { min: a.min + b.min, esperado: a.esperado + b.esperado, max: a.max + b.max };
}
const redondearRango = r => ({
  min: round2(r.min), esperado: round2(r.esperado), max: round2(r.max),
});

// ─── Padrón fiscal de proveedores ─────────────────────────────────────────────
//
// Una entrada del padrón es { emiteFacturaA: 'S'|'N'|'?', alicuotaIva, cuit,
// condicionFiscal, fuente }. `fuente` dice de dónde salió el dato y es lo que
// después separa un número duro de un supuesto:
//   · 'factura'   → se leyó de una factura real (lo más fuerte)
//   · 'declarado' → lo cargó una persona en la pantalla
//   · 'inferido'  → lo dedujo el sistema de la alícuota observada en Compras
//
// Se busca por nombre normalizado porque la planilla escribe el mismo proveedor
// de formas distintas según quién cargó la fila.
function normNombre(s) {
  return (s || '').toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function buscarEnPadron(padron, proveedor) {
  if (!padron || !proveedor) return null;
  return padron[normNombre(proveedor)] || null;
}

// Cuánto sube el precio ESTE proveedor cuando empieza a facturar. Orden: lo que
// se dijo de él por nombre, después el patrón (verdulerías y fruterías, que
// venden al 10,5%), y si no, el default. Ver `aumentoAlFacturar` arriba.
function pctAumentoDe(proveedor, cfg) {
  if (!cfg || !cfg.activo) return 0;
  const n = normNombre(proveedor);
  if (n && cfg.porProveedor && cfg.porProveedor[n] != null) return Number(cfg.porProveedor[n]) || 0;
  if (n && (cfg.patronesReducidos || []).some(p => n.includes(p))) {
    return Number(cfg.pctReducido) || 0;
  }
  return Number(cfg.pctDefault) || 0;
}

// ─── Qué filas del libro NO son gasto ─────────────────────────────────────────
//
// `Movimientos` mezcla el gasto con la tesorería: los retiros de efectivo, los
// cambios entre cajas y los ajustes por arqueo se escriben como filas de Gasto,
// pero no son una compra. No hay proveedor, no hay factura y no hay IVA que
// recuperar — es la misma plata en otro bolsillo, o menos plata en el bolsillo
// de los socios.
//
// Colarlas hacía dos daños a la vez. En el cálculo, "Retiro eft Galicia" son
// $8.000.000 en un solo mes que entraban como gasto sin clasificar con techo del
// 21%: inflaban el crédito máximo, ensuciaban el porcentaje relevado y se
// deducían enteros en Ganancias. Y en la cola de relevamiento, que ordena por
// plata, encabezaban la lista de proveedores a relevar.
//
// Se reconocen por tres marcas porque la planilla las escribe de tres formas:
//   · `esCambio` / categoría `Cambio` → los cambios y retiros entre cajas.
//   · `esFondeo` (Tipo = Otros)       → lo que no es ni ingreso ni gasto.
//   · Proveedor `Ajuste de Caja`      → lo que postea el arqueo. Su categoría es
//     `Otros` porque la validación de la columna J no acepta otra cosa, así que
//     la única marca que queda es el nombre (ver `postearAjusteEfectivo`).
const PROVEEDORES_DE_CAJA = [/^retiro\b/, /^ajuste de caja\b/, /^cambio\b/, /^fondeo\b/];

function esMovimientoDeCaja(m) {
  if (!m) return false;
  if (m.esCambio || m.esFondeo) return true;
  if ((m.categoria || '').trim() === 'Cambio') return true;
  const p = normNombre(m.proveedor);
  return !!p && PROVEEDORES_DE_CAJA.some(re => re.test(p));
}

// ─── Calibración: qué sabe la hoja Compras de verdad ──────────────────────────
//
// Compras cubre poco, pero lo que cubre es dato real y no supuesto. Se usa para
// dos cosas: fijar la alícuota observada de un proveedor, y detectar que emite
// factura A. Devuelve { [nombreNorm]: { alicuotaIva, emiteFacturaA, cuit, ... } }
//
// El dato más rico está en TEXTO LIBRE en la columna Notas, porque el extractor
// de facturas lo escribe ahí. La forma de una nota (con los datos cambiados —
// este repo es público y las notas reales traen CUIT y razón social):
//   "Factura A Nº 0000-00000000. IVA 21%. Neto: 19812.24. IVA: 4160.57.
//    Total: 23972.81. Cliente: <razón social>. CUIT: <11 dígitos>.
//    Monotributista."
// Minarlo con regex es feo pero es la única forma de recuperar meses ya cerrados
// sin volver a pasar cada factura por el extractor.
function calibrarDesdeCompras(compras = []) {
  const acc = {};

  for (const c of compras) {
    const nom = normNombre(c.proveedor);
    if (!nom) continue;
    if (!acc[nom]) {
      acc[nom] = {
        nombre: c.proveedor, alicuotas: [], emiteFacturaA: null,
        cuit: null, condicionFiscal: null, renglones: 0,
      };
    }
    const e = acc[nom];
    e.renglones++;

    // Alícuota de la columna L (% IVA), cuando está poblada.
    const pct = normalizarAlicuota(c.ivaPct);
    if (pct !== null && pct > 0) e.alicuotas.push(pct);

    const notas = (c.notas || '').toString();
    if (!notas) continue;

    // "Factura A Nº ..." → el proveedor emite A. Sólo la A da crédito fiscal;
    // B y C no discriminan IVA y no se pueden computar.
    if (/factura\s*a\b/i.test(notas)) e.emiteFacturaA = 'S';
    else if (/factura\s*[bc]\b/i.test(notas) && e.emiteFacturaA === null) e.emiteFacturaA = 'N';

    // "IVA 21%" / "IVA 10.50%" en el texto, cuando la columna quedó vacía.
    const mIva = notas.match(/iva[:\s]*(\d{1,4}(?:[.,]\d{1,2})?)\s*%/i);
    if (mIva) {
      const v = normalizarAlicuota(parseFloat(mIva[1].replace(',', '.')));
      if (v !== null && v > 0) e.alicuotas.push(v);
    }

    const mCuit = notas.match(/cuit[:\s]*(\d{2}[-\s]?\d{8}[-\s]?\d)/i);
    if (mCuit && !e.cuit) e.cuit = mCuit[1].replace(/[-\s]/g, '');

    if (/monotributista/i.test(notas) && !e.condicionFiscal) e.condicionFiscal = 'Monotributo';
    else if (/responsable\s+inscripto/i.test(notas) && !e.condicionFiscal) e.condicionFiscal = 'RI';
  }

  const out = {};
  for (const [nom, e] of Object.entries(acc)) {
    // La alícuota que manda es la MÁS FRECUENTE, no el promedio: promediar 21 y
    // 10,5 daría 15,75, que no es una alícuota que exista.
    let alicuotaIva = null;
    if (e.alicuotas.length) {
      const cuenta = {};
      for (const a of e.alicuotas) cuenta[a] = (cuenta[a] || 0) + 1;
      alicuotaIva = Number(Object.entries(cuenta).sort((x, y) => y[1] - x[1])[0][0]);
    }
    out[nom] = {
      nombre: e.nombre,
      alicuotaIva,
      alicuotasVistas: [...new Set(e.alicuotas)].sort((a, b) => a - b),
      emiteFacturaA: e.emiteFacturaA,
      cuit: e.cuit,
      condicionFiscal: e.condicionFiscal,
      renglones: e.renglones,
      fuente: 'factura',
    };
  }
  return out;
}

// ─── Crédito fiscal estimado sobre el universo del gasto ──────────────────────
//
// Recorre las filas de Gasto del libro y decide, para cada una, si su IVA se
// recupera y a qué alícuota. Las cuotas se saltean por la misma razón que en
// getResumenMensual: la fila madre ya computa el total de la compra.
//
// movimientos: filas de getMovimientos() (ya filtradas por mes si corresponde)
// padron:      { [nombreNorm]: { emiteFacturaA, alicuotaIva, ... } } — lo declarado
// calibracion: salida de calibrarDesdeCompras() — lo observado en facturas reales
function estimarCreditoFiscal({ movimientos = [], padron = {}, calibracion = {}, parametros = {} } = {}) {
  const P = { ...PARAMETROS, ...parametros };
  const sinCredito = new Set(P.categoriasSinCredito || []);

  const porCategoria = {};
  const porProveedor = {};
  let total = vacioRango();
  let totalAumento = vacioRango();
  let gastoTotal = 0;
  let gastoClasificado = 0;   // filas donde SÍ se sabe si da factura A
  let gastoSinIvaPorNaturaleza = 0;

  for (const m of movimientos) {
    if (!m || m.tipo !== 'Gasto') continue;
    if (m.esCuota) continue;
    if (esMovimientoDeCaja(m)) continue;   // retiros, cambios y ajustes de caja

    const monto = Number(m.salidaTotal) || 0;
    if (monto <= 0) continue;

    const categoria = (m.categoria || 'Otros').trim();
    const proveedor = (m.proveedor || '').trim();
    gastoTotal += monto;

    // 1) Categorías que no generan crédito por naturaleza. No entran al rango:
    //    no son incertidumbre, son un cero conocido.
    if (sinCredito.has(categoria)) {
      gastoSinIvaPorNaturaleza += monto;
      gastoClasificado += monto;
      acumular(porCategoria, categoria, monto, vacioRango(), 'naturaleza', vacioRango());
      if (proveedor) acumular(porProveedor, proveedor, monto, vacioRango(), 'naturaleza', vacioRango());
      continue;
    }

    // 2) ¿Da factura A? El padrón declarado manda sobre lo observado, porque una
    //    persona que dice "este me da A" sabe más que una factura vieja suelta.
    const decl = buscarEnPadron(padron, proveedor);
    const obs = buscarEnPadron(calibracion, proveedor);
    const emite = (decl && decl.emiteFacturaA) || (obs && obs.emiteFacturaA) || '?';

    // 3) La alícuota, en orden de fuerza: declarada → observada → supuesto de categoría.
    const rangoCat = P.ivaPorCategoria[categoria] || P.ivaPorCategoria['Otros'] || { min: 0, esperado: 21, max: 21 };
    const alicDecl = decl && Number(decl.alicuotaIva);
    const alicObs = obs && Number(obs.alicuotaIva);
    const alicFija = Number.isFinite(alicDecl) && alicDecl > 0 ? alicDecl
      : (Number.isFinite(alicObs) && alicObs > 0 ? alicObs : null);

    const alicuotas = alicFija !== null
      ? { min: alicFija, esperado: alicFija, max: alicFija }
      : rangoCat;

    // El IVA que la compra YA LLEVA ADENTRO, se recupere o no. Es lo que separa
    // "no genera crédito por naturaleza" (un sueldo: no hay IVA que perder) de
    // "lo pagaste y no te vuelve" (un proveedor que factura B). Sin este número
    // la pérdida por categoría no se puede escribir: el crédito recuperado solo
    // dice cuánto volvió, nunca cuánto había.
    const teorico = {
      min: ivaContenido(monto, alicuotas.min),
      esperado: ivaContenido(monto, alicuotas.esperado),
      max: ivaContenido(monto, alicuotas.max),
    };

    // Cuánto te cobraría de más este proveedor si empezara a facturar. Cero para
    // el que YA factura A: su precio de hoy ya trae el IVA adentro, no hay nada
    // que agregar. Ver `aumentoAlFacturar` en PARAMETROS.
    const pctAum = pctAumentoDe(proveedor, P.aumentoAlFacturar);
    const aumentaSiFactura = pctAum > 0 ? monto * (pctAum / 100) : 0;

    let rango;
    let aumento;
    let confianza;
    if (emite === 'S') {
      gastoClasificado += monto;
      confianza = alicFija !== null ? 'dato' : 'alicuota-supuesta';
      // Ya te factura: el precio de hoy ya tiene el IVA adentro y se saca de ahí.
      // Éste es el único crédito que es ahorro de verdad.
      rango = {
        min: ivaContenido(monto, alicuotas.min),
        esperado: ivaContenido(monto, alicuotas.esperado),
        max: ivaContenido(monto, alicuotas.max),
      };
      aumento = vacioRango();
    } else if (emite === 'N') {
      gastoClasificado += monto;
      confianza = 'dato';
      rango = vacioRango();   // paga el IVA y no lo recupera: ésa es la pérdida
      aumento = vacioRango(); // y como no va a facturar, tampoco sube el precio
    } else {
      // Sin clasificar: es la incertidumbre real. El mínimo asume que no da A
      // (cero crédito) y el máximo que sí. El esperado NO parte al medio a ciegas:
      // usa la proporción de gasto ya clasificado que sí da factura A, que es la
      // mejor pista disponible. Se resuelve en la segunda pasada.
      //
      // Con el supuesto de aumento activo, el techo cambia de naturaleza: si
      // empieza a facturar te cobra `monto × p/100` MÁS y ese mismo importe
      // vuelve como crédito. Crédito y aumento son el mismo número, y por eso el
      // costo neto no se mueve. Sin el supuesto, el techo es el IVA contenido en
      // el precio de hoy, que es asumir que el proveedor absorbe el impuesto.
      const techo = aumentaSiFactura > 0
        ? aumentaSiFactura
        : ivaContenido(monto, alicuotas.max);
      rango = { min: 0, esperado: 0, max: techo };
      aumento = { min: 0, esperado: 0, max: aumentaSiFactura };
      confianza = 'sin-clasificar';
    }

    total = sumarRango(total, rango);
    totalAumento = sumarRango(totalAumento, aumento);
    acumular(porCategoria, categoria, monto, rango, confianza, teorico, aumento);
    if (proveedor) acumular(porProveedor, proveedor, monto, rango, confianza, teorico, aumento, { emite, alicuota: alicFija, pctAumento: pctAum });
  }

  // Segunda pasada: repartir el "esperado" de lo no clasificado usando la tasa
  // observada en lo que sí se conoce. Si no se conoce nada todavía, se cae a la
  // mitad del rango, que es lo único honesto cuando no hay ninguna evidencia.
  //
  // Lo que se reparte es el crédito a la alícuota ESPERADA, no al techo. Son dos
  // incertidumbres distintas —si el proveedor da factura A, y a qué alícuota
  // compra— y la tasa sólo resuelve la primera. Multiplicando el techo por la
  // tasa se estaba asumiendo, además, que todo lo sin relevar compra al 21%.
  const baseConocida = gastoClasificado - gastoSinIvaPorNaturaleza;
  const tasaA = baseConocida > 0 ? creditoRealizadoSobre(porProveedor, baseConocida) : null;
  const peso = tasaA !== null ? tasaA : 0.5;
  let esperadoExtra = 0, aumentoExtra = 0;
  for (const grupo of [porCategoria, porProveedor]) {
    for (const e of Object.values(grupo)) {
      if (!e.sinClasificar) continue;
      const extra = e.creditoEspSinClasificar * peso;
      const extraAum = e.aumentoMaxSinClasificar * peso;
      e.credito.esperado = round2(e.credito.esperado + extra);
      e.aumento.esperado = round2(e.aumento.esperado + extraAum);
      if (grupo === porCategoria) { esperadoExtra += extra; aumentoExtra += extraAum; }
    }
  }
  total.esperado += esperadoExtra;
  totalAumento.esperado += aumentoExtra;

  const pctClasificado = gastoTotal > 0 ? (gastoClasificado / gastoTotal) * 100 : 100;

  return {
    total: redondearRango(total),
    // Lo que los proveedores cobrarían de más por empezar a facturar. Es el
    // contrapeso del crédito y hay que leerlos juntos: el neto de los dos es el
    // ahorro real, y para el gasto sin relevar da cero.
    aumentoProveedores: redondearRango(totalAumento),
    porCategoria: ordenarPorGasto(porCategoria),
    porProveedor: ordenarPorGasto(porProveedor),
    cobertura: {
      gastoTotal: round2(gastoTotal),
      // El gasto que habría bajo RI: lo de hoy más lo que suben los proveedores.
      gastoRI: round2(gastoTotal + totalAumento.esperado),
      gastoClasificado: round2(gastoClasificado),
      pctClasificado: round2(pctClasificado),
      gastoSinIvaPorNaturaleza: round2(gastoSinIvaPorNaturaleza),
      // Cuánta plata de crédito está en juego sin resolver. Es la métrica de
      // progreso del padrón: no cuántos proveedores faltan, sino cuántos pesos.
      incertidumbreARS: round2(total.max - total.min),
    },
  };
}

function acumular(grupo, clave, monto, rango, confianza, teorico = vacioRango(), aumento = vacioRango(), extra = {}) {
  if (!grupo[clave]) {
    grupo[clave] = {
      nombre: clave, gasto: 0,
      credito: vacioRango(),
      // Lo que el proveedor te cobraría de más por facturar. Va al lado del
      // crédito porque sólo se leen juntos: un crédito de $100 conseguido
      // pagando $100 de más no es un ahorro de $100, es un ahorro de cero.
      aumento: vacioRango(),
      // El IVA que el grupo lleva adentro, se recupere o no. `credito` nunca lo
      // supera: la diferencia es la pérdida.
      ivaTeorico: vacioRango(),
      sinClasificar: 0, conDato: 0,
      // El techo de crédito que aporta SÓLO la parte sin clasificar. Se lleva
      // aparte porque la segunda pasada reparte sobre eso y no sobre el máximo
      // del grupo entero: sumar el crédito ya confirmado de los proveedores
      // conocidos empujaba el esperado por encima del propio máximo.
      creditoMaxSinClasificar: 0,
      // Y lo mismo a la alícuota ESPERADA, que es sobre lo que reparte la
      // segunda pasada. Son dos preguntas distintas y usar el techo para las dos
      // mezclaba "¿da factura A?" con "¿a qué alícuota compra?": en Mercaderia,
      // que va de 10,5% a 21%, el esperado del crédito salía por encima del IVA
      // que la compra lleva adentro — más plata de vuelta de la que se pagó.
      creditoEspSinClasificar: 0,
      // El aumento que aporta sólo la parte sin clasificar, para repartirlo en
      // la segunda pasada con la MISMA tasa que el crédito: son el mismo evento
      // (el proveedor empieza a facturar) y separarlos rompería la neutralidad.
      aumentoMaxSinClasificar: 0,
      ...extra,
    };
  }
  const e = grupo[clave];
  e.gasto = round2(e.gasto + monto);
  e.credito = sumarRango(e.credito, rango);
  e.aumento = sumarRango(e.aumento, aumento);
  e.ivaTeorico = sumarRango(e.ivaTeorico, teorico);
  if (confianza === 'sin-clasificar') {
    e.sinClasificar = round2(e.sinClasificar + monto);
    e.creditoMaxSinClasificar = round2(e.creditoMaxSinClasificar + rango.max);
    // Con aumento activo el esperado del crédito ES el techo: si factura, cobra
    // el aumento entero y ése es el crédito. Sin aumento, es el IVA contenido
    // en el precio de hoy a la alícuota esperada.
    e.creditoEspSinClasificar = round2(e.creditoEspSinClasificar +
      (aumento.max > 0 ? aumento.max : teorico.esperado));
    e.aumentoMaxSinClasificar = round2(e.aumentoMaxSinClasificar + aumento.max);
  } else {
    e.conDato = round2(e.conDato + monto);
  }
  if (extra.emite && !e.emite) e.emite = extra.emite;
}

// Proporción del gasto clasificado que efectivamente generó crédito. Sirve como
// prior para estimar lo no clasificado.
function creditoRealizadoSobre(porProveedor, baseConocida) {
  let conA = 0;
  for (const e of Object.values(porProveedor)) {
    if (e.emite === 'S') conA += e.conDato;
  }
  return baseConocida > 0 ? conA / baseConocida : null;
}

function ordenarPorGasto(grupo) {
  return Object.values(grupo)
    .map(e => ({
      ...e,
      credito: redondearRango(e.credito),
      aumento: redondearRango(e.aumento),
      ivaTeorico: redondearRango(e.ivaTeorico),
    }))
    .sort((a, b) => b.gasto - a.gasto);
}

// ─── Simulación de un mes bajo Responsable Inscripto ──────────────────────────
//
// escenarioPrecio: cuánto del IVA se le traslada al cliente.
//   · 0   → la carta no cambia. El precio de hoy pasa a ser precio final con IVA
//           adentro, así que el ingreso neto BAJA a precio/1,21. El IVA sale del
//           margen. Es el piso.
//   · 1   → la carta sube 21% y el ingreso neto se mantiene igual al de hoy.
//   · 0,5 → la mitad, y así.
//
// baseVentas: la decisión de Gonzalo es declarar sólo lo que liquida por Galicia
// (Tarjeta Crédito + Débito + QR). Es un supuesto de negocio, no la obligación
// legal —como RI hay que facturar todo—, y por eso viaja explícito en la salida.
function simularMes({ resumen, credito, escenarioPrecio = 0, parametros = {}, baseVentas = 'galicia' } = {}) {
  const P = { ...PARAMETROS, ...parametros };
  const t = Math.max(0, Math.min(1, Number(escenarioPrecio) || 0));
  const alic = P.ivaVentasPct;

  const ingresos = (resumen && resumen.ingresos) || {};
  const cobrado = baseVentas === 'todo'
    ? (Number(ingresos.total) || 0)
    : (Number(ingresos.Galicia) || 0);

  // Con traslado t, el cliente pasa a pagar `cobrado × (1 + alic·t)`. El neto que
  // le queda al bar es siempre precioFinal / (1 + alic).
  const precioFinal = cobrado * (1 + (alic / 100) * t);
  const neto = netoDe(precioFinal, alic);
  const debito = precioFinal - neto;

  const cred = credito && credito.total ? credito.total : vacioRango();

  // IVA a pagar por escenario de crédito. Si el crédito supera al débito no se
  // "cobra" la diferencia: queda saldo técnico a favor, que se arrastra.
  const ivaDe = c => Math.max(0, debito - c);
  const saldoFavorDe = c => Math.max(0, c - debito);
  const iva = {
    min: ivaDe(cred.max),        // más crédito → menos IVA a pagar
    esperado: ivaDe(cred.esperado),
    max: ivaDe(cred.min),
  };
  const saldoAFavor = {
    min: saldoFavorDe(cred.min), esperado: saldoFavorDe(cred.esperado), max: saldoFavorDe(cred.max),
  };

  // IIBB grava el ingreso, se declare o no. Se calcula sobre la base elegida,
  // pero se devuelve también el que correspondería sobre todo (ver más abajo).
  const iibb = neto * ((Number(P.iibbPct) || 0) / 100);

  const advertencias = [];

  // ─── Gasto deducible en Ganancias ───────────────────────────────────────────
  //
  // No todo lo que sale es deducible, y los dos ajustes son grandes:
  //   · Personal: sólo la parte en blanco tiene respaldo.
  //   · Equipamiento: no es gasto del mes, se amortiza.
  // Y del resto hay que sacar el IVA que se recupera: si el crédito se computa,
  // el costo es el neto — deducirlo con IVA adentro sería contar dos veces.
  // El gasto que hay que deducir es el de RI —el de hoy más lo que suben los
  // proveedores al facturar—, no el de hoy. Deducir el precio viejo mientras se
  // computa el crédito del precio nuevo es contar el aumento como si fuera
  // gratis, y de ahí salía una utilidad más alta que la real.
  const porCat = {};
  for (const c of (credito && credito.porCategoria) || []) {
    porCat[c.nombre] = (Number(c.gasto) || 0) + ((c.aumento && c.aumento.esperado) || 0);
  }
  const gastoTotal = (credito && credito.cobertura)
    ? (credito.cobertura.gastoRI != null ? credito.cobertura.gastoRI : credito.cobertura.gastoTotal)
    : 0;

  const gastoPersonal = porCat['Personal'] || 0;
  const gastoEquip = (P.categoriasEquipamiento || [])
    .reduce((s, c) => s + (porCat[c] || 0), 0);
  const gastoResto = gastoTotal - gastoPersonal - gastoEquip;

  const pctBlanco = Math.max(0, Math.min(1, Number(P.pctPersonalDeducible)));
  const personalDeducible = gastoPersonal * pctBlanco;
  const amortizacionMensual = gastoEquip / (Math.max(1, Number(P.amortizacionAnios) || 5) * 12);

  if (gastoPersonal > 0 && pctBlanco < 1) {
    advertencias.push({
      codigo: 'personal-fuera-de-recibo',
      texto: 'La parte del sueldo que se paga fuera de recibo es costo real del bar pero no se puede deducir en Ganancias.',
      impactoARS: round2(gastoPersonal - personalDeducible),
    });
  }
  if (gastoEquip > 0) {
    advertencias.push({
      codigo: 'equipamiento-amortizado',
      texto: `Equipamiento comprado en el mes: se amortiza en ${P.amortizacionAnios} años en vez de deducirse entero. Aproximación: no existe libro de bienes de uso.`,
      impactoARS: round2(gastoEquip - amortizacionMensual),
    });
  }

  // Gasto deducible por escenario de crédito (a más crédito recuperado, menos costo).
  const deducibleDe = c => Math.max(0, gastoResto + personalDeducible + amortizacionMensual - c);

  // ─── Las tres bases de Ganancias ────────────────────────────────────────────
  //
  // Ésta es la inconsistencia que hay que mostrar, no esconder. Declarar sólo
  // las ventas de Galicia contra el 100% de los costos NO es un escenario: es un
  // error de método que hace dar una utilidad artificialmente baja. Se calcula
  // igual, y se marca como inválido, justamente para que se vea por qué no sirve.
  const ventaTotalHoy = Number(ingresos.total) || 0;
  const pctDeclarado = ventaTotalHoy > 0 ? cobrado / ventaTotalHoy : 1;
  const netoTodo = netoDe(ventaTotalHoy * (1 + (alic / 100) * t), alic);

  // La utilidad puede dar NEGATIVA y se devuelve negativa. El `max(0, …)` es una
  // regla del impuesto —no existe Ganancias negativo— y vive en aplicarEscala,
  // que devuelve 0 para base <= 0. Aplicarlo acá tapaba justo lo que esta tabla
  // existe para mostrar: la base inválida no da "utilidad cero", da pérdida, y
  // ver el número en rojo es el argumento entero.
  const basesDe = c => ({
    soloDeclarado: {
      ingresos: round2(neto), gastos: round2(deducibleDe(c)),
      utilidad: round2(neto - deducibleDe(c)),
      valida: false,
      motivo: `Declara el ${round2(pctDeclarado * 100)}% de los ingresos contra el 100% de los costos. La utilidad sale artificialmente baja —muchas veces negativa— y Ganancias da mal. No es un escenario: es un error de método.`,
    },
    proporcional: {
      ingresos: round2(neto), gastos: round2(deducibleDe(c) * pctDeclarado),
      utilidad: round2(neto - deducibleDe(c) * pctDeclarado),
      valida: true,
      motivo: 'Los gastos se prorratean al mismo porcentaje que los ingresos declarados. Es la lectura menos mentirosa de declarar sólo Galicia.',
    },
    todoDeclarado: {
      ingresos: round2(netoTodo), gastos: round2(deducibleDe(c)),
      utilidad: round2(netoTodo - deducibleDe(c)),
      valida: true,
      motivo: 'El único internamente consistente: se declara todo lo que entra y se deduce todo lo que sale.',
    },
  });

  // ─── El total, evaluado entero por escenario de crédito ─────────────────────
  //
  // OJO: el mínimo del total NO se compone tomando el mínimo de cada impuesto.
  // Más crédito fiscal baja el IVA a pagar pero SUBE Ganancias, porque el costo
  // deducible es menor. Los dos se mueven en sentidos opuestos, así que hay que
  // evaluar el total completo en cada punto del rango y recién ahí ordenar.
  //
  // El KPI usa la base `proporcional`, que es la base válida que responde la
  // pregunta "¿qué pasa si declaro sólo Galicia?".
  const evaluarEn = (c, tramos) => {
    const ivaV = ivaDe(c);
    const ganV = aplicarEscala(basesDe(c).proporcional.utilidad, tramos);
    return { iva: ivaV, ganancias: ganV, total: ivaV + iibb + ganV };
  };

  const porFigura = (tramos) => {
    const puntos = [evaluarEn(cred.min, tramos), evaluarEn(cred.esperado, tramos), evaluarEn(cred.max, tramos)];
    const totales = puntos.map(p => p.total);
    return {
      ganancias: {
        min: Math.min(...puntos.map(p => p.ganancias)),
        esperado: puntos[1].ganancias,
        max: Math.max(...puntos.map(p => p.ganancias)),
      },
      total: {
        min: Math.min(...totales),
        esperado: puntos[1].total,
        max: Math.max(...totales),
      },
    };
  };

  const ph = porFigura(P.gananciasPersonaHumana);
  const soc = porFigura(P.gananciasSociedad);

  // Cuánto vale en pesos un peso deducido, en este escenario. Es lo único del
  // desglose por categoría que depende del aumento de carta (la carta mueve la
  // utilidad y la utilidad puede cambiar de tramo), así que viaja por escenario
  // en vez de repetir la tabla entera veintiún veces.
  const utilidadKPI = basesDe(cred.esperado).proporcional.utilidad;
  const tasaMarginalGanancias = {
    personaHumana: tasaMarginal(utilidadKPI, P.gananciasPersonaHumana),
    sociedad: tasaMarginal(utilidadKPI, P.gananciasSociedad),
  };

  const ganancias = {
    personaHumana: ph.ganancias,
    sociedad: soc.ganancias,
    bases: basesDe(cred.esperado),
  };
  const totalFiscal = { personaHumana: ph.total, sociedad: soc.total };

  // El número que se busca: qué porcentaje de lo que entra se va en impuestos.
  // El denominador es lo que el cliente paga (precioFinal), no el neto, porque
  // ésa es la plata que pasa por la caja.
  const pctDe = v => (precioFinal > 0 ? (v / precioFinal) * 100 : 0);
  const pctRango = r => ({ min: pctDe(r.min), esperado: pctDe(r.esperado), max: pctDe(r.max) });
  const pctSobreIngresos = {
    personaHumana: pctRango(totalFiscal.personaHumana),
    sociedad: pctRango(totalFiscal.sociedad),
  };

  // Contra qué se compara: lo que hoy se paga de monotributo.
  const hoy = Number(P.cuotaMonotributoMensual) || 0;

  return {
    mes: resumen && resumen.mes,
    baseVentas,
    escenarioPrecio: t,
    ventas: {
      cobradoHoy: round2(cobrado),
      precioFinalRI: round2(precioFinal),
      neto: round2(neto),
      // Cuánto más paga el cliente por el traslado, y cuánto margen resigna el bar.
      aumentoAlCliente: round2(precioFinal - cobrado),
      netoResignado: round2(cobrado - neto),
    },
    iva: {
      debito: round2(debito),
      credito: redondearRango(cred),
      aPagar: redondearRango(iva),
      saldoAFavor: redondearRango(saldoAFavor),
    },
    iibb: {
      sobreBaseDeclarada: round2(iibb),
      // IIBB grava lo que se vende, se declare o no. Se muestra el que
      // correspondería sobre todas las ventas para que la brecha esté a la vista.
      sobreTodasLasVentas: round2(netoTodo * ((Number(P.iibbPct) || 0) / 100)),
    },
    ganancias: {
      personaHumana: redondearRango(ganancias.personaHumana),
      sociedad: redondearRango(ganancias.sociedad),
      bases: ganancias.bases,
    },
    // Cuánto de lo que se vende se está declarando, en % y en pesos. Hoy no
    // aparece en ninguna pantalla del sistema.
    declaracion: {
      pctDeclarado: round2(pctDeclarado * 100),
      ventaTotalHoy: round2(ventaTotalHoy),
      brechaARS: round2(ventaTotalHoy - cobrado),
      brechaAnualizadaARS: round2((ventaTotalHoy - cobrado) * 12),
    },
    advertencias,
    tasaMarginalGanancias,
    // ─── Cada impuesto por separado, en plata y en % de la caja ───────────────
    //
    // El total contesta "cuánto", no "de qué". Son tres impuestos con tres
    // palancas distintas: el IVA se baja consiguiendo factura A, IIBB no se baja
    // con nada porque grava la venta, y Ganancias se baja deduciendo — y ahí
    // manda la nómina, porque lo que se paga fuera de recibo no se puede
    // deducir. Verlos juntos y en una sola escala es lo que deja decidir dónde
    // apretar.
    //
    // El denominador es el mismo para los tres (`precioFinal`, la plata que pasa
    // por la caja), así que los porcentajes suman el del total y se pueden leer
    // uno contra otro.
    porImpuesto: {
      iva:  { ars: redondearRango(iva), pct: redondearRango(pctRango(iva)) },
      iibb: { ars: round2(iibb), pct: round2(pctDe(iibb)) },
      ganancias: {
        personaHumana: { ars: redondearRango(ph.ganancias), pct: redondearRango(pctRango(ph.ganancias)) },
        sociedad:      { ars: redondearRango(soc.ganancias), pct: redondearRango(pctRango(soc.ganancias)) },
      },
    },
    totalFiscal: {
      personaHumana: redondearRango(totalFiscal.personaHumana),
      sociedad: redondearRango(totalFiscal.sociedad),
    },
    pctSobreIngresos: {
      personaHumana: redondearRango(pctSobreIngresos.personaHumana),
      sociedad: redondearRango(pctSobreIngresos.sociedad),
    },
    hoyMonotributo: {
      cuota: round2(hoy),
      pctSobreIngresos: round2(precioFinal > 0 ? (hoy / precioFinal) * 100 : 0),
    },
  };
}

// ─── Qué le hace el régimen a cada categoría de compra ────────────────────────
//
// El total no dice dónde duele. Pasar a RI no le hace lo mismo a la mercadería
// que a los sueldos que a una heladera, y las tres cosas están en el mismo
// número. Esta tabla las separa por la ÚNICA razón que las distingue: cómo se
// trata cada peso.
//
//   · normal        → genera crédito de IVA y se deduce neto en Ganancias.
//   · sin-credito   → Personal y Fiscales. No hay IVA que recuperar (no es que
//                     no se sepa: los sueldos están fuera del objeto y un
//                     impuesto no genera crédito de otro). Del sueldo, además,
//                     sólo la parte por recibo se deduce.
//   · amortiza      → equipamiento. El IVA se recupera entero en el mes, pero el
//                     gasto se deduce en `amortizacionAnios`, así que en el mes
//                     de la compra la deducción es una fracción chica.
//
// Todo lo que devuelve es INDEPENDIENTE del aumento de carta: son compras, y el
// precio del menú no las toca. Lo único que depende del escenario es cuánto vale
// en pesos un peso deducido, y eso viaja aparte como `tasaMarginalGanancias`.
function impactoPorCategoria({ credito, parametros = {} } = {}) {
  const P = { ...PARAMETROS, ...parametros };
  const sinCredito = new Set(P.categoriasSinCredito || []);
  const equipamiento = new Set(P.categoriasEquipamiento || []);
  const pctBlanco = Math.max(0, Math.min(1, Number(P.pctPersonalDeducible)));
  const meses = Math.max(1, Number(P.amortizacionAnios) || 5) * 12;

  return ((credito && credito.porCategoria) || []).map(c => {
    const gasto = Number(c.gasto) || 0;
    const rec = (c.credito && c.credito.esperado) || 0;
    const aum = (c.aumento && c.aumento.esperado) || 0;
    const teorico = (c.ivaTeorico && c.ivaTeorico.esperado) || 0;
    // Lo que se le paga al proveedor bajo RI: el precio de hoy más lo que sube
    // por empezar a facturar. Todo lo que sigue se calcula sobre esto y no sobre
    // el gasto de hoy — deducir un precio que ya no existe sería inventar.
    const gastoRI = gasto + aum;

    let tratamiento, deducible, nota;
    if (sinCredito.has(c.nombre)) {
      tratamiento = 'sin-credito';
      // Personal es el único con parte no deducible; Fiscales se deduce entero.
      deducible = c.nombre === 'Personal' ? gastoRI * pctBlanco : gastoRI;
      nota = c.nombre === 'Personal'
        ? 'Los sueldos no generan crédito de IVA, y sólo la parte por recibo se deduce en Ganancias.'
        : 'Un impuesto no genera crédito de otro impuesto.';
    } else if (equipamiento.has(c.nombre)) {
      tratamiento = 'amortiza';
      deducible = (gastoRI - rec) / meses;
      nota = 'El IVA vuelve entero este mes, pero el gasto se deduce en ' + P.amortizacionAnios + ' años.';
    } else {
      tratamiento = 'normal';
      deducible = gastoRI - rec;
      nota = 'Genera crédito de IVA y se deduce neto en Ganancias.';
    }

    return {
      nombre: c.nombre,
      gasto: round2(gasto),
      // Lo que suben los proveedores de esta categoría al empezar a facturar, y
      // el precio que quedaría. Van al lado del crédito porque sólo se leen
      // juntos: sin esto, el crédito parece ahorro y no lo es.
      aumentoProveedores: round2(aum),
      gastoRI: round2(gastoRI),
      // Lo que la categoría lleva de IVA adentro, y cuánto de eso vuelve.
      ivaPagado: round2(teorico),
      creditoRecuperado: round2(rec),
      // El ahorro REAL de la categoría: lo que vuelve menos lo que te cobran de
      // más por hacerlo volver. Para el gasto sin relevar da cero, y ése es todo
      // el punto del supuesto.
      ahorroNeto: round2(rec - aum),
      credito: c.credito,
      // Plata que sale por IVA y no vuelve. En `sin-credito` es cero por
      // definición y no por falta de dato — la tabla tiene que decir cuál es cuál.
      ivaPerdido: round2(Math.max(0, teorico - rec)),
      // Cuánto de ese gasto todavía no tiene proveedor relevado: es la parte del
      // número que se puede mejorar preguntando, y es gratis.
      sinRelevar: round2(Number(c.sinClasificar) || 0),
      enJuego: round2(((c.credito && c.credito.max) || 0) - ((c.credito && c.credito.min) || 0)),
      deducibleGanancias: round2(Math.max(0, deducible)),
      tratamiento,
      nota,
    };
  }).sort((a, b) => b.gasto - a.gasto);
}

// ─── Dónde se está perdiendo crédito fiscal ───────────────────────────────────
//
// El output accionable. Dos formas de perder crédito, y son distintas:
//   · 'sin-factura-a' → el proveedor no da A. Se paga IVA que no se recupera.
//     La acción es negociar, o cambiar de proveedor.
//   · 'sin-clasificar' → no se sabe. La acción es averiguarlo, que es gratis.
//
// El monto va ANUALIZADO porque una oportunidad de $80.000 al mes no se lee igual
// que una de $960.000 al año, y la decisión (cambiar de proveedor) es anual.
function oportunidades({ credito, mesesAnalizados = 1 } = {}) {
  if (!credito || !credito.porProveedor) return [];
  const factor = mesesAnalizados > 0 ? 12 / mesesAnalizados : 12;
  const out = [];

  for (const p of credito.porProveedor) {
    // Lo que se perdería si no da factura A: el IVA contenido en lo que se le
    // compra. Para los no clasificados es directamente el techo del rango.
    if (p.emite === 'N' && p.gasto > 0) {
      const perdido = p.credito.max > 0 ? p.credito.max : ivaContenido(p.gasto, 21);
      out.push({
        tipo: 'sin-factura-a', proveedor: p.nombre, gasto: p.gasto,
        perdidoMensual: round2(perdido),
        perdidoAnualizado: round2(perdido * factor),
        accion: 'Pedir factura A, negociar, o comparar contra un proveedor que la emita',
      });
    } else if (p.sinClasificar > 0) {
      out.push({
        tipo: 'sin-clasificar', proveedor: p.nombre, gasto: p.gasto,
        enJuegoMensual: round2(p.credito.max - p.credito.min),
        enJuegoAnualizado: round2((p.credito.max - p.credito.min) * factor),
        accion: 'Averiguar si emite factura A — es gratis y achica el rango',
      });
    }
  }

  return out.sort((a, b) =>
    (b.perdidoAnualizado || b.enJuegoAnualizado || 0) - (a.perdidoAnualizado || a.enJuegoAnualizado || 0));
}

// ─── Cuánto se puede descontar por cobrar en efectivo ─────────────────────────
//
// La misma mesa deja plata distinta según cómo pague, y la diferencia no es
// chica. Cobrada por Galicia se lleva comisión del posnet, IVA débito, IIBB y
// Ganancias sobre la utilidad de esa venta. Cobrada en efectivo y no declarada
// no se lleva nada de eso — y por eso se puede resignar parte del precio con un
// descuento y TERMINAR IGUAL O MEJOR.
//
// ─── Lo que esto NO dice ──────────────────────────────────────────────────────
//
// Como Responsable Inscripto hay que facturar todas las ventas. Este cálculo
// describe la consecuencia económica de una decisión que ya está tomada y
// declarada en el resto del módulo (`baseVentas: 'galicia'`), no una
// recomendación ni asesoramiento fiscal. Lo mismo que ya dice `simularMes` sobre
// declarar sólo lo que liquida Galicia.
//
// ─── La cuenta ────────────────────────────────────────────────────────────────
//
// Sobre una venta de X (precio final, IVA adentro):
//
//   comisión      X × comisionPct                        (sólo electrónico)
//   IVA débito    (X − X/(1+a/100)) × (1 − reducción)    (sólo si se declara;
//                 la reducción es el beneficio Monotributo → RI, que también
//                 alcanza al IVA marginal de una venta más declarada)
//   IIBB          neto × iibbPct                         (sólo si se declara)
//   Ganancias     tasaMarginal × (neto − CMV)            (sólo si se declara)
//
// El COSTO DE LA MERCADERÍA no aparece como resta porque es el mismo plato en
// los dos casos: se compró y se pagó igual, se cobre como se cobre. Entra sólo
// donde de verdad cambia, que es la utilidad sobre la que corre Ganancias.
//
// El descuento de equilibrio es entonces lo que se va en todo eso, sobre X:
// descontar exactamente eso deja lo mismo por los dos caminos, y descontar menos
// deja más.
function descuentoEfectivo({
  ventas = [], parametros = {}, comisionPct = 0, cmvPct = 0,
  tasaMarginalGanancias = 0, descuentos = [10, 15],
} = {}) {
  const P = { ...PARAMETROS, ...parametros };
  const a = Number(P.ivaVentasPct) || 0;
  const com = Math.max(0, Number(comisionPct) || 0) / 100;
  const cmv = Math.max(0, Math.min(1, Number(cmvPct) || 0));
  const tm = Math.max(0, Math.min(1, Number(tasaMarginalGanancias) || 0));
  const iibbP = (Number(P.iibbPct) || 0) / 100;
  const red = Math.max(0, Math.min(100, Number(P.reduccionIvaPct) || 0)) / 100;

  const filas = (ventas || []).map(v => {
    const X = Number(v && v.montoARS != null ? v.montoARS : v) || 0;
    if (X <= 0) return null;

    const comision = X * com;
    const neto = netoDe(X, a);
    const ivaDebito = (X - neto) * (1 - red);
    const iibb = neto * iibbP;
    const costoMercaderia = X * cmv;
    // Ganancias grava la utilidad, no la venta. Si la mesa diera pérdida no hay
    // impuesto que ahorrarse: el max(0) es la regla del impuesto, no un piso
    // puesto para que el número quede lindo.
    const utilidad = Math.max(0, neto - costoMercaderia);
    const ganancias = utilidad * tm;

    const seVa = comision + ivaDebito + iibb + ganancias;
    const quedaElectronico = X - seVa;
    // Descontar esto en efectivo deja exactamente lo mismo que cobrar por
    // Galicia. Es el techo: por debajo se gana, por encima se pierde.
    const pctEquilibrio = X > 0 ? (seVa / X) * 100 : 0;

    return {
      etiqueta: (v && v.etiqueta) || null,
      ventaARS: round2(X),
      electronico: {
        comision: round2(comision),
        ivaDebito: round2(ivaDebito),
        iibb: round2(iibb),
        ganancias: round2(ganancias),
        seVa: round2(seVa),
        queda: round2(quedaElectronico),
        pctQueda: round2(X > 0 ? (quedaElectronico / X) * 100 : 0),
      },
      pctEquilibrio: round2(pctEquilibrio),
      // El precio con descuento redondeado a $100 hacia abajo, que es como se
      // dice en el salón. Se informa aparte para no ensuciar la cuenta.
      descuentos: (descuentos || []).map(d => {
        const pct = Math.max(0, Math.min(100, Number(d) || 0));
        const cobras = X * (1 - pct / 100);
        return {
          pct,
          cobras: round2(cobras),
          cobrasRedondeado: Math.floor(cobras / 100) * 100,
          resigna: round2(X - cobras),
          // Contra el electrónico: positivo es que te conviene el efectivo.
          ganasVsElectronico: round2(cobras - quedaElectronico),
          conviene: cobras > quedaElectronico,
        };
      }),
    };
  }).filter(Boolean);

  return {
    filas,
    supuestos: {
      ivaVentasPct: a,
      reduccionIvaPct: round2(red * 100),
      iibbPct: Number(P.iibbPct) || 0,
      comisionPct: round2(com * 100),
      cmvPct: round2(cmv * 100),
      tasaMarginalGananciasPct: round2(tm * 100),
    },
  };
}

// ─── Punto de entrada: varios meses × varios escenarios ───────────────────────
//
// Devuelve además la comparación "declarado vs todo", que es la inconsistencia
// que hay que mostrar y no esconder: si se declaran sólo las ventas de Galicia
// (~67% del total) pero se deducen el 100% de los costos, la utilidad simulada
// queda artificialmente baja y Ganancias sale mal. Las dos columnas dejan la
// brecha a la vista para que sea una decisión consciente.
function simular({ meses = [], movimientosPorMes = {}, padron = {}, calibracion = {},
                   escenarios = [0, 0.5, 1], parametros = {} } = {}) {
  const P = { ...PARAMETROS, ...parametros };
  const salida = [];

  for (const resumen of meses) {
    const movs = movimientosPorMes[resumen.mes] || [];
    const credito = estimarCreditoFiscal({ movimientos: movs, padron, calibracion, parametros: P });

    salida.push({
      mes: resumen.mes,
      credito,
      // El desglose por categoría de compra. Va al nivel del MES y no del
      // escenario porque describe lo que se compró, y el precio de la carta no
      // cambia una factura ya pagada.
      impactoCategorias: impactoPorCategoria({ credito, parametros: P }),
      escenarios: escenarios.map(t => ({
        traslado: t,
        declarado: simularMes({ resumen, credito, escenarioPrecio: t, parametros: P, baseVentas: 'galicia' }),
        todo: simularMes({ resumen, credito, escenarioPrecio: t, parametros: P, baseVentas: 'todo' }),
      })),
      oportunidades: oportunidades({ credito, mesesAnalizados: 1 }),
    });
  }

  return { meses: salida, parametros: P };
}

module.exports = {
  PARAMETROS,
  // Cálculo
  estimarCreditoFiscal, simularMes, simular, oportunidades, impactoPorCategoria, descuentoEfectivo,
  calibrarDesdeCompras, esMovimientoDeCaja,
  // Helpers exportados para poder ejercitarlos sin montar el módulo entero
  ivaContenido, netoDe, aplicarEscala, tasaMarginal, normNombre, normalizarAlicuota, ALICUOTAS_CONOCIDAS,
};
