// Una factura con dos alícuotas.
//
// El 11/09/2026 Gonzalo mandó la factura A de Distribuidora Blancaluna del
// 08/09: diez renglones, dos de ellos marcados con "**", y un pie con DOS filas
// —$247.634,39 al 21% y $44.794,42 al 10,5%—. No es un caso exótico: en
// Argentina las carnes, frutas, verduras, harina de trigo, pan y leche van a la
// tasa reducida, así que cualquier distribuidor de alimentos mezcla las dos.
//
// Todo el circuito asumía UNA alícuota por factura:
//
//   · el prompt pedía un `subtotal_factura` y un `iva_monto` sin decir qué hacer
//     con un pie de dos filas;
//   · la conversación preguntaba "¿De cuánto es el IVA?" con botones 21/10,5/27,
//     una pregunta que en esta factura NO TIENE respuesta;
//   · `desglosar` derivaba la alícuota de neto/IVA, y acá daba 19,4% — una tasa
//     que no existe;
//   · `ivaParaCompras` estampaba esa única tasa en los diez renglones.
//
// El crédito salía bien de casualidad: el modelo sumó los dos bloques por su
// cuenta y la tolerancia del 1% se tragó 91 pesos que leyó mal del neto. Si en
// otra factura hubiera elegido un bloque en vez de sumar, el crédito se iba a
// $60.593,76 contra los $56.706,65 reales: **$3.887 de más declarados**.
//
// Los números de esta suite son los de esa factura.

const path = require('path');
const { envFalso } = require('./_harness');

const RAIZ = path.join(__dirname, '..');

// El pie, tal como lo imprime la factura.
const PIE = [
  { alicuota: 21, neto: 247634.39, iva: 52003.23 },
  { alicuota: 10.5, neto: 44794.42, iva: 4703.42 },
];
const TOTAL = 349135.46;
const CREDITO = 56706.65;

// Los diez renglones, con la tasa que el modelo leyó DE VERDAD (medido contra
// la API): acertó las dos harinas por el "**" y marcó además el aceite, que va
// al 21%. Nueve de diez.
const RENGLONES = [
  { nombre: 'AZUCAR', total: 11475, tasa: 21 },
  { nombre: 'HARINA LEUDANTE', total: 25850.75, tasa: 10.5 },
  { nombre: 'HARINA 0000', total: 18943.67, tasa: 10.5 },
  { nombre: 'RICOTA', total: 14610, tasa: 21 },
  { nombre: 'QUESO', total: 35109.89, tasa: 21 },
  { nombre: 'MANTECA', total: 52510, tasa: 21 },
  { nombre: 'TOMATE', total: 17900, tasa: 21 },
  { nombre: 'ALCAPARRAS', total: 23161.36, tasa: 21 },
  { nombre: 'VINAGRE', total: 4393.74, tasa: 21 },
  { nombre: 'ACEITE', total: 88474.4, tasa: 10.5 },
];

function run(t) {
  envFalso();
  const f = require(path.join(RAIZ, 'src', 'facturas.js'));
  const convo = require(path.join(RAIZ, 'src', 'compra-conversacion.js'));
  const ex = require(path.join(RAIZ, 'src', 'extractor.js'));

  // ─── 1. El cuadro del pie gana, y sólo si se verifica ─────────────────────
  const d = f.desglosar({
    total: TOTAL, otrosImpuestos: 0, computable: true, alicuota: 21,
    netoLeido: 292337.81, ivaLeido: CREDITO, desgloseIva: PIE,
  });
  t.eq(d.fuente, 'leido-varias-tasas', 'con dos tasas el pie manda');
  t.eq(d.iva, CREDITO, 'el crédito es la suma de las dos filas del pie');
  // El neto sale del cuadro, no del subtotal suelto: el cuadro tiene dos filas
  // que se verifican solas, así que arregla los 91 pesos mal leídos.
  t.eq(d.neto, 292428.81, 'el neto se recompone del cuadro y corrige lo mal leído');
  t.eq(d.alicuota, null, 'con dos tasas NO se inventa una alícuota (era 19,4%)');
  t.eq(d.desglose.length, 2, 'el desglose viaja entero');

  // Un cuadro que no cierra consigo mismo no se usa: media verdad acá es
  // crédito fiscal inventado.
  const roto = f.desglosar({
    total: TOTAL, computable: true, alicuota: 21,
    desgloseIva: [{ alicuota: 21, neto: 247634.39, iva: 99999 }],
  });
  t.ok(roto.fuente !== 'leido-varias-tasas', 'un cuadro cuya fila no cierra se descarta');

  // Y uno que cierra fila por fila pero no contra el total, tampoco.
  const noCierraTotal = f.desglosar({
    total: 999999, computable: true, alicuota: 21, desgloseIva: PIE,
  });
  t.ok(noCierraTotal.fuente !== 'leido-varias-tasas', 'un cuadro que no da el total se descarta');

  // Con UNA sola tasa se comporta igual que siempre: la fila se lee normal.
  const una = f.desglosar({ total: 121000, computable: true, desgloseIva: [{ alicuota: 21, neto: 100000, iva: 21000 }] });
  t.eq(una.fuente, 'leido', 'con una sola tasa la fuente sigue siendo "leido"');
  t.eq(una.alicuota, 21, 'y la alícuota se escribe normalmente');

  // ─── 2. La celda del desglose va y vuelve ─────────────────────────────────
  const celda = f.formatearDesglose(d.desglose);
  t.eq(celda, '21:247634.39:52003.23|10.5:44794.42:4703.42', 'el cuadro se guarda legible en una celda');
  t.eq(f.parsearDesglose(celda), PIE, 'y se vuelve a leer idéntico');
  t.eq(f.parsearDesglose(''), [], 'una celda vacía no rompe nada');
  t.eq(f.parsearDesglose('basura'), [], 'y una celda escrita a mano tampoco');

  // ─── 3. La fila de la planilla ────────────────────────────────────────────
  const fila = f.construirFila({
    fecha: '2026-09-08', proveedor: 'Distribuidora Blancaluna SA', comprobante: 'A',
    puntoVenta: '0015', numero: '00551907', total: TOTAL,
    neto: 292337.81, iva: CREDITO, alicuota: 21, desgloseIva: PIE,
    origen: 'bot', usuario: 'pablo',
  });
  t.ok(fila.ok, 'la fila se construye');
  t.eq(fila.row.length, f.HEADER.length, 'la fila tiene tantas celdas como columnas el encabezado');
  t.eq(fila.row[9], CREDITO, 'J lleva el crédito, que es lo que se suma en el mes');
  t.eq(fila.row[8], '', 'I queda vacía en vez de mentir con una tasa promedio');
  t.eq(fila.row[18], celda, 'S lleva el cuadro del pie');
  // La columna nueva va AL FINAL. Insertarla en el medio correría el
  // significado de todas las de la derecha en las filas que ya existen.
  t.eq(f.HEADER[f.HEADER.length - 1], 'Desglose IVA', 'la columna nueva es la última');

  // ─── 4. El informe del mes reparte la factura entre las dos tasas ─────────
  const leida = f.parsearFila(fila.row);
  t.eq(leida.desglose, PIE, 'la fila leída trae su desglose');
  const ac = f.acumuladoDelMes([leida], 'Septiembre');
  t.eq(ac.credito, CREDITO, 'el crédito del mes es el mismo con una factura mixta');
  const buckets = {};
  ac.porAlicuota.forEach(a => { buckets[a.alicuota] = a.iva; });
  t.eq(buckets['21'], 52003.23, 'el cuadro por tasa pone $52.003,23 en el 21%');
  t.eq(buckets['10.5'], 4703.42, 'y $4.703,42 en el 10,5%');
  t.eq(ac.porAlicuota.length, 2, 'dos buckets, no uno fantasma de 19,4%');

  // Una factura de una sola tasa, sin desglose (las que ya están cargadas),
  // sigue cayendo entera en su bucket.
  const vieja = { mes: 'Septiembre', computable: true, iva: 21000, neto: 100000, alicuota: 21, total: 121000, desglose: [] };
  const ac2 = f.acumuladoDelMes([vieja], 'Septiembre');
  t.eq(ac2.porAlicuota.length, 1, 'una factura vieja sin desglose se agrupa como antes');

  // ─── 5. La conversación deja de hacer una pregunta sin respuesta ──────────
  const factura = {
    proveedor: 'Distribuidora Blancaluna SA', fecha: '2026-09-08', total_factura: TOTAL,
    tipo_comprobante: 'A', punto_venta: '0015', numero_comprobante: '00551907',
    subtotal_factura: 292428.81, iva_monto: CREDITO, iva_discriminado: true,
    iva_desglose: PIE, confianza: { total_factura: 0.95 },
  };
  const e = convo.estadoInicial({ factura, cfg: null, proveedor: factura.proveedor, pendienteId: 'p1', itemsCount: 10 });
  t.eq(e.ivaDesglose, PIE, 'el estado se queda con el cuadro del pie');

  // Se recorre la conversación entera: la alícuota no puede aparecer en NINGÚN
  // paso, no sólo en el primero.
  let cur = e, pasos = [], guarda = 0;
  while (guarda++ < 20) {
    const p = convo.siguientePaso(cur);
    if (p.tipo !== 'pregunta') break;
    pasos.push(p.campo);
    const r = convo.aplicarRespuesta(cur, { campo: p.campo, valor: (p.botones[0] || {}).id || '1' });
    if (!r.estado || r.error) break;
    cur = r.estado;
  }
  t.ok(!pasos.includes('ivaPct'), 'no se pregunta la alícuota: el pie ya la contestó dos veces');

  // Sin cuadro en el pie, la pregunta vuelve. Es el caso normal.
  const sinPie = convo.estadoInicial({
    factura: { ...factura, iva_desglose: [], subtotal_factura: null, iva_monto: null },
    cfg: null, proveedor: factura.proveedor, pendienteId: 'p2', itemsCount: 10,
  });
  t.eq(convo.siguientePaso(sinPie).campo, 'ivaPct', 'sin cuadro en el pie la alícuota se sigue preguntando');

  // El resumen muestra las dos tasas en vez de un promedio.
  const resumen = convo.armarResumen(e);
  t.ok(/21% sobre/.test(resumen) && /10,5% sobre/.test(resumen), 'el resumen lista las dos tasas');
  t.ok(!/19,4/.test(resumen), 'y no muestra el promedio ponderado, que no es una tasa real');
  t.ok(resumen.includes('$56.706,65'), 'el crédito del resumen es el de la factura');

  // ─── 6. Qué tasa le toca a cada renglón ───────────────────────────────────
  //
  // Éste es el caso medido: el modelo marcó el aceite al 10,5% y no lo está.
  const asig = f.asignarTasasALineas(RENGLONES, PIE);
  t.ok(asig, 'se pudo asignar');
  t.eq(asig.fuente, 'resuelto', 'la lectura no cerraba, así que se resolvió contra el pie');
  const porNombre = {};
  asig.tasas.forEach((tas, i) => { porNombre[RENGLONES[i].nombre] = tas; });
  t.eq(porNombre['HARINA LEUDANTE'], 10.5, 'la harina leudante queda al 10,5%');
  t.eq(porNombre['HARINA 0000'], 10.5, 'la harina 0000 también');
  t.eq(porNombre['ACEITE'], 21, 'el aceite vuelve al 21%: el modelo lo había marcado mal');
  const suma105 = asig.tasas.reduce((s, tas, i) => (tas === 10.5 ? s + RENGLONES[i].total : s), 0);
  t.ok(Math.abs(suma105 - 44794.42) < 1, 'los renglones al 10,5% suman exacto la base del pie');

  // Si lo leído YA cierra, se respeta y no se resuelve nada.
  const bienLeidos = RENGLONES.map(r => ({ ...r, tasa: r.nombre.startsWith('HARINA') ? 10.5 : 21 }));
  t.eq(f.asignarTasasALineas(bienLeidos, PIE).fuente, 'lineas', 'una lectura que cierra se respeta tal cual');

  // Una sola tasa en el pie: todos los renglones la llevan, sin resolver nada.
  const unaTasa = f.asignarTasasALineas(
    [{ total: 100, tasa: null }, { total: 200, tasa: null }],
    [{ alicuota: 21, neto: 300, iva: 63 }]);
  t.eq(unaTasa.fuente, 'unica', 'con una sola tasa no hay nada que repartir');
  t.eq(unaTasa.tasas, [21, 21], 'y todos los renglones la llevan');

  // Los renglones que no suman el neto del pie: no se reparte sobre una base
  // falsa. Falta un renglón o se leyó mal un importe.
  t.eq(f.asignarTasasALineas([{ total: 100, tasa: 21 }], PIE), null,
    'si los renglones no suman el neto del pie, no se asigna nada');
  t.eq(f.asignarTasasALineas([], PIE), null, 'sin renglones no se asigna nada');
  t.eq(f.asignarTasasALineas(RENGLONES, []), null, 'sin cuadro en el pie tampoco');

  // ─── 7. El extractor le da tipos al cuadro sin juzgarlo ───────────────────
  t.eq(ex.normalizarDesgloseIva([{ alicuota: '10.5', neto: '44794.42', iva: '4703.42' }]),
    [{ alicuota: 10.5, neto: 44794.42, iva: 4703.42 }], 'los números llegan como texto y se convierten');
  t.eq(ex.normalizarDesgloseIva([{ alicuota: 21, neto: 100 }]), [],
    'una fila a medias se descarta: no es "casi el cuadro", es un cuadro que no cierra');
  t.eq(ex.normalizarDesgloseIva([{ alicuota: 99, neto: 100, iva: 99 }]), [],
    'una alícuota imposible se descarta');
  t.eq(ex.normalizarDesgloseIva(null), [], 'sin cuadro, array vacío');
  t.eq(ex.normalizarDesgloseIva([
    { alicuota: 10.5, neto: 1, iva: 0.1 }, { alicuota: 21, neto: 2, iva: 0.42 },
  ]).map(x => x.alicuota), [21, 10.5], 'el cuadro sale ordenado por tasa descendente');

  // ─── 8. El prompt le pide el cuadro y le avisa de los "**" ────────────────
  const pc = ex.buildPromptCabecera('2026-09-11');
  t.ok(pc.includes('iva_desglose'), 'el prompt de cabecera pide el cuadro del pie');
  t.ok(/10,5/.test(pc) && /SUMA/.test(pc), 'y dice explícitamente que con varias tasas se SUMAN');
  const pi = ex.buildPromptItems();
  t.ok(/\*\*/.test(pi) && /nota al pie/.test(pi),
    'el prompt de renglones busca la marca "**" y su nota al pie');
}

module.exports = { nombre: 'IVA: una factura con dos alícuotas', run };
