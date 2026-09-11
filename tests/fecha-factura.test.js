// La fecha de una factura no puede leerse al revés ni caer en el futuro.
//
// El 10/09/2026 una factura de Láctea El Puente entró al libro fechada el 9 de
// octubre: el papel decía "10/09/2026" y se leyó mes 10, día 09. Pasó la
// confirmación sin que nadie lo notara porque el resumen escribía "9/10", que
// son las mismas dos cifras que "10/9".
//
// Acá se corre el módulo de verdad —es puro, no lee nada— sobre ese caso y
// sobre los que lo rodean. `compra-conversacion` se ejercita de verdad también:
// el paso de la fecha y la respuesta son funciones puras.

const fechas = require('../src/fecha-factura');
const { envFalso } = require('./_harness');

envFalso();
const convo = require('../src/compra-conversacion');

const HOY = '2026-09-11';

function run(t) {
  // ─── El caso que pasó ───────────────────────────────────────────────────
  {
    const r = fechas.revisar({
      fecha: '2026-10-09', fechaTexto: '10/09/2026', hoy: '2026-09-10',
    });
    t.eq(r.fecha, '2026-09-10', 'el papel manda: 10/09/2026 es el 10 de septiembre');
    t.eq(r.corregida, true, 'se corrige sin preguntar');
    t.eq(r.motivo, 'orden-dd-mm', 'y queda dicho por qué');
    t.eq(r.duda, null, 'no se pregunta nada: el formato del país no es una suposición');
  }

  // Sin `fecha_texto` —una lectura vieja, o el modelo que no lo mandó— la red
  // que queda es que la fecha cae en el futuro.
  {
    const r = fechas.revisar({ fecha: '2026-10-09', hoy: '2026-09-10' });
    t.ok(r.duda, 'sin el papel, una fecha futura se pregunta');
    t.eq(r.motivo, 'futura-invertida', 'y se reconoce como el día y el mes cruzados');
    t.eq(r.duda.sugerido, '2026-09-10', 'la fecha dada vuelta es la sugerida');
    t.eq(r.fecha, '2026-10-09', 'pero NO se cambia sola: la contesta una persona');
  }

  // ─── Regla 2: del futuro no entra nada ──────────────────────────────────
  {
    const r = fechas.revisar({ fecha: '2026-12-25', fechaTexto: '25/12/2026', hoy: HOY });
    t.ok(r.duda, 'una fecha futura se pregunta aunque el papel la confirme');
    t.eq(r.motivo, 'futura', 'y sin vuelta posible (el día 25 no es un mes)');
    t.eq(r.duda.sugerido, '', 'no se sugiere nada: no hay lectura alternativa');
    t.ok(r.duda.opciones.includes(HOY), 'se ofrece hoy como opción');
  }
  {
    const r = fechas.revisar({ fecha: '2026-09-12', hoy: HOY });
    t.ok(r.duda, 'un solo día en el futuro también se pregunta');
  }
  t.eq(fechas.revisar({ fecha: HOY, hoy: HOY }).duda, null, 'hoy no es el futuro');

  // ─── Regla 3: sola en otro mes ──────────────────────────────────────────
  {
    const recientes = ['2026-09-10', '2026-09-09', '2026-09-09', '2026-09-08'];
    const r = fechas.revisar({ fecha: '2026-05-09', hoy: HOY, recientes });
    t.ok(r.duda, 'una de mayo en medio de una tanda de septiembre se pregunta');
    t.eq(r.duda.sugerido, '2026-09-05', 'y se propone la lectura dada vuelta');
    t.ok(r.duda.pregunta.includes('septiembre'), 'la pregunta dice de qué mes es la tanda');
  }
  {
    // El mes corriente y el anterior nunca preguntan: una factura del 28 de
    // agosto subida el 11 de septiembre es lo más normal del mundo.
    const r = fechas.revisar({ fecha: '2026-08-28', hoy: HOY, recientes: ['2026-09-10'] });
    t.eq(r.duda, null, 'el mes anterior no es una anomalía');
  }
  {
    // Cargar un atraso viejo: la primera pregunta, y a partir de ahí la tanda
    // abre ese mes y las demás entran solas.
    const sola = fechas.revisar({ fecha: '2026-06-15', hoy: HOY, recientes: [] });
    t.ok(sola.duda, 'la primera de junio se pregunta');
    const conTanda = fechas.revisar({ fecha: '2026-06-15', hoy: HOY, recientes: ['2026-06-12'] });
    t.eq(conTanda.duda, null, 'con otra de junio ya subida, la siguiente pasa sola');
  }
  {
    // Sin vuelta posible, igual se pregunta — pero lo que se propone es lo leído.
    const r = fechas.revisar({ fecha: '2026-06-25', hoy: HOY, recientes: ['2026-09-10'] });
    t.eq(r.duda.sugerido, '2026-06-25', 'sin lectura alternativa, la sugerida es la leída');
    t.eq(r.duda.opciones.length, 1, 'y hay una sola opción, no una inventada');
  }

  // ─── Nada raro, nada que preguntar ──────────────────────────────────────
  {
    const r = fechas.revisar({ fecha: '2026-09-10', fechaTexto: '10/09/2026', hoy: HOY });
    t.eq(r.fecha, '2026-09-10', 'la fecha bien leída queda como está');
    t.eq(r.corregida, false, 'no se corrige nada');
    t.eq(r.duda, null, 'y no se molesta a nadie');
  }
  {
    const r = fechas.revisar({ fecha: '', fechaTexto: '', hoy: HOY });
    t.eq(r.motivo, 'sin-fecha', 'sin fecha se dice, no se inventa una');
    t.eq(r.fecha, '', 'y no se devuelve ninguna');
  }

  // ─── Leer el papel ──────────────────────────────────────────────────────
  t.eq(fechas.normalizarTexto('10/09/2026'), '2026-09-10', 'dd/mm/aaaa');
  t.eq(fechas.normalizarTexto('10-09-26'), '2026-09-10', 'dd-mm-aa');
  t.eq(fechas.normalizarTexto('10.09.2026'), '2026-09-10', 'dd.mm.aaaa');
  t.eq(fechas.normalizarTexto('2026-09-10'), '2026-09-10', 'ISO impreso');
  t.eq(fechas.normalizarTexto('10-SEP-26'), '2026-09-10', 'con el mes abreviado');
  t.eq(fechas.normalizarTexto('10 de Septiembre de 2026'), '2026-09-10', 'con el mes en letras');
  t.eq(fechas.normalizarTexto('10/09/2026 14:33'), '2026-09-10', 'con la hora al lado');
  t.eq(fechas.normalizarTexto('31/02/2026'), '', 'el 31 de febrero no existe y no se corre a marzo');
  t.eq(fechas.normalizarTexto('cualquier cosa'), '', 'lo que no se reconoce no se adivina');
  t.eq(fechas.normalizarTexto(''), '', 'vacío es vacío');

  // ─── Dar vuelta el día y el mes ─────────────────────────────────────────
  t.eq(fechas.invertirDiaMes('2026-10-09'), '2026-09-10', 'se da vuelta cuando el día es ≤ 12');
  t.eq(fechas.invertirDiaMes('2026-09-25'), '', 'el 25 no puede ser un mes: no hay vuelta');
  t.eq(fechas.invertirDiaMes('2026-09-09'), '', 'el 9/9 dado vuelta es el mismo día');
  t.eq(fechas.invertirDiaMes('2026-02-30'), '', 'una fecha que no existe no se invierte');

  // ─── La conversación del bot ────────────────────────────────────────────
  const base = {
    factura: { fecha: '2026-10-09', total_factura: 117300, tipo_comprobante: 'A' },
    proveedor: 'Lactea El Puente', pendienteId: 'p1',
  };
  {
    const duda = fechas.revisar({ fecha: '2026-10-09', hoy: '2026-09-10' }).duda;
    const e = convo.estadoInicial({ ...base, dudaFecha: duda });
    const paso = convo.siguientePaso(e);
    t.eq(paso.campo, 'fecha', 'la fecha se pregunta ANTES que el IVA y que el total');
    t.ok(paso.permiteTexto, 'y se puede escribir otra');
    t.ok(paso.botones.some(b => b.id === '2026-09-10' && b.sugerido),
      'el botón sugerido es la fecha dada vuelta');
    t.ok(paso.botones.every(b => !b.label.includes('✅')),
      'el ✅ del sugerido lo pone el bot: no va duplicado en la etiqueta');
    t.ok(paso.botones.every(b => /de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/.test(b.label)),
      'los botones escriben el mes con letras: "9/10" y "10/9" se leen igual');

    // Contestarla destraba el resto de la conversación.
    const r = convo.aplicarRespuesta(e, { campo: 'fecha', valor: '2026-09-10' });
    t.ok(!r.error, 'la fecha elegida se acepta');
    t.eq(r.estado.fecha, '2026-09-10', 'y queda guardada');
    t.eq(r.estado.dudaFecha, null, 'la duda se cierra');
    t.ok(convo.siguientePaso(r.estado).campo !== 'fecha', 'y no se vuelve a preguntar');

    // Escrita a mano también, y el año sale de la fecha en discusión.
    const m = convo.aplicarRespuesta(e, { campo: 'fecha', valor: '4/9' });
    t.eq(m.estado.fecha, '2026-09-04', 'se puede escribir "4/9"');

    // Lo que no se acepta.
    t.ok(convo.aplicarRespuesta(e, { campo: 'fecha', valor: 'el martes' }).error,
      'una fecha que no se entiende se repregunta');
    const fut = convo.aplicarRespuesta(e, { campo: 'fecha', valor: '2099-01-01' });
    t.ok(fut.error, 'contestar otra fecha del futuro tampoco vale');
    t.ok(/todavía no pasó/.test(fut.error), 'y el error dice por qué');
  }
  {
    // Sin duda, la fecha no aparece como paso: no se le pregunta a nadie algo
    // que ya está resuelto.
    const e = convo.estadoInicial({ ...base, factura: { ...base.factura, fecha: '2026-09-10' } });
    t.ok(convo.siguientePaso(e).campo !== 'fecha', 'sin duda no hay paso de fecha');
  }

  // El resumen escribe el mes con letras — es donde el error se coló.
  {
    const e = convo.estadoInicial({ ...base, factura: { ...base.factura, fecha: '2026-09-10' } });
    const resumen = convo.armarResumen(e);
    t.ok(resumen.includes('10 de septiembre'), 'el resumen dice "10 de septiembre", no "10/9"');
  }
  {
    // Una corrección silenciosa igual se ve: es la única que no pasa por una
    // pregunta, así que si no se dijera sería indistinguible de un error.
    const e = convo.estadoInicial({
      ...base,
      factura: { ...base.factura, fecha: '2026-09-10', fechaCorregidaDe: '2026-10-09' },
    });
    const resumen = convo.armarResumen(e);
    t.ok(resumen.includes('la había leído como 9 de octubre'),
      'el resumen cuenta que la fecha se corrigió y cuál era');
    t.ok(convo.siguientePaso(e).campo !== 'fecha', 'pero no se pregunta: el papel no es una suposición');
  }
  t.eq(convo.fechaLarga('2026-09-10'), '10 de septiembre', 'el año corriente no se escribe');
  t.ok(convo.fechaLarga('2025-09-10').includes('2025'), 'otro año sí se escribe');

  // ─── El prompt del extractor le dice al modelo cuál es el orden ─────────
  const fs = require('fs');
  const path = require('path');
  const ext = fs.readFileSync(path.join(__dirname, '..', 'src', 'extractor.js'), 'utf8');
  t.ok(ext.includes('"fecha_texto"'), 'la cabecera pide la fecha tal cual está impresa');
  t.ok(/DÍA\/MES\/AÑO/.test(ext), 'el prompt dice que en Argentina es día/mes/año');
  t.ok(/Hoy es \$\{dia\}/.test(ext), 'y le dice al modelo qué día es hoy');
}

module.exports = { nombre: 'La fecha de una factura', run };
