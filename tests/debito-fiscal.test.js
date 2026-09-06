// El IVA de las ventas — la otra mitad del impuesto.
//
// Hasta el 06/09/2026 no existía medido: el crédito se lleva por comprobante
// desde el 3/9, pero del lado de las ventas sólo había simulación, porque la API
// de Fudo NO informa si una venta se facturó (probado el 12/8: una venta con
// Factura C y una sin comprobante devuelven exactamente los mismos campos).
//
// Lo que lo destraba es una regla del dueño: **toda venta que no se cobra en
// efectivo se factura, así que lleva IVA**. No es algo que el sistema deduzca —
// es cómo se opera— y por eso lo que se prueba acá es que la regla se aplique
// entera y que el desglose que permite auditarla viaje siempre al lado.

const path = require('path');
const { envFalso } = require('./_harness');

function run(t) {
  envFalso();
  const rf = require(path.join(__dirname, '..', 'src', 'regimen-fiscal.js'));
  const fac = require(path.join(__dirname, '..', 'src', 'facturas.js'));

  // ── 1. Qué cuenta como efectivo ───────────────────────────────────────────
  // Los nombres son los que usa Fudo, sacados del export real de ventas.
  for (const m of ['Efectivo', 'efectivo', 'EFECTIVO', 'Efectivo Local', 'Contado']) {
    t.ok(rf.esMedioEfectivo(m), `"${m}" es efectivo`);
  }
  for (const m of ['Tarj. Crédito', 'Tarj. Débito', 'QR', 'Mercado Pago', 'Sena']) {
    t.ok(!rf.esMedioEfectivo(m), `"${m}" NO es efectivo, así que factura`);
  }
  // Un medio que se llame parecido pero no lo sea no puede colarse como efectivo:
  // ahí la plata se volvería no facturada sin que nadie lo note.
  t.ok(!rf.esMedioEfectivo('Efectivos S.A.'), '"Efectivos S.A." no es efectivo (no confundir por prefijo)');
  t.ok(!rf.esMedioEfectivo(''), 'un medio vacío no es efectivo');
  t.ok(!rf.esMedioEfectivo(null), 'un medio nulo no rompe');

  // ── 2. La cuenta, contra números hechos a mano ────────────────────────────
  const r = rf.debitoFiscalDeVentas({ mediosPago: {
    'Efectivo': 2000000,
    'Tarj. Crédito': 3500000,
    'Tarj. Débito': 2500000,
    'QR': 1500000,
    'Mercado Pago': 500000,
  }});
  t.eq(r.totalARS, 10000000, 'el total es todo lo cobrado');
  t.eq(r.efectivoARS, 2000000, 'el efectivo se separa');
  t.eq(r.facturadoARS, 8000000, 'lo facturado es todo lo demás');
  t.eq(r.pctFacturado, 80, 'da el ~80% que el dueño espera');
  // 8.000.000 × 21/121 = 1.388.429,75
  t.eq(r.debitoFiscalARS, 1388429.75, 'el débito es el IVA CONTENIDO, no el 21% del total');
  t.eq(r.netoGravadoARS, 6611570.25, 'el neto es lo facturado sin el IVA');
  t.eq(r.netoGravadoARS + r.debitoFiscalARS, r.facturadoARS, 'neto + IVA cierra contra lo facturado');
  // El contraejemplo que hace falta dejar escrito: aplicar la alícuota al total
  // daría 1.680.000, que no es el IVA de ninguna venta.
  t.ok(r.debitoFiscalARS !== 8000000 * 0.21, 'no se aplica el 21% SOBRE lo facturado (sería 1.680.000)');

  // ── 3. El desglose por medio, que es lo que permite auditar el supuesto ───
  t.eq(r.porMedio.length, 5, 'viene una fila por medio de pago');
  t.eq(r.porMedio[0].medio, 'Tarj. Crédito', 'ordenado por plata, de mayor a menor');
  const efec = r.porMedio.find(m => m.medio === 'Efectivo');
  t.eq(efec.clase, 'efectivo', 'el efectivo queda marcado como tal');
  t.eq(efec.debitoARS, 0, 'el efectivo aporta cero IVA, y se dice cero en vez de omitirlo');
  const suma = r.porMedio.reduce((s, m) => s + m.debitoARS, 0);
  t.ok(Math.abs(suma - r.debitoFiscalARS) < 1, 'la suma de las filas cierra contra el total del débito');
  t.ok(r.base === 'fecha de servicio', 'la respuesta declara sobre qué base agrupa');

  // ── 4. Bordes ─────────────────────────────────────────────────────────────
  const vacio = rf.debitoFiscalDeVentas({ mediosPago: {} });
  t.eq(vacio.totalARS, 0, 'un mes sin ventas da cero');
  t.eq(vacio.pctFacturado, 0, 'sin ventas el porcentaje es cero y no NaN');
  t.eq(vacio.debitoFiscalARS, 0, 'sin ventas no hay débito');
  t.eq(rf.debitoFiscalDeVentas().totalARS, 0, 'sin argumentos no rompe');

  const soloEfectivo = rf.debitoFiscalDeVentas({ mediosPago: { 'Efectivo': 500000 } });
  t.eq(soloEfectivo.debitoFiscalARS, 0, 'un mes todo en efectivo no genera débito');
  t.eq(soloEfectivo.pctFacturado, 0, 'y el porcentaje facturado es cero');

  const otraAlicuota = rf.debitoFiscalDeVentas({ mediosPago: { 'QR': 1000 }, alicuota: 10.5 });
  // 1000 × 10,5/110,5 = 95,02. Es IVA contenido, no 10,5% de 1000 (que daría 105).
  t.eq(otraAlicuota.debitoFiscalARS, 95.02, 'la alícuota es configurable, y sigue siendo IVA contenido');

  // ── 5. La resta del mes ───────────────────────────────────────────────────
  t.eq(rf.liquidacionIVA({ debitoARS: 1000, creditoARS: 400 }),
    { debitoARS: 1000, creditoARS: 400, aPagarARS: 600, saldoAFavorARS: 0 },
    'débito mayor que crédito: se paga la diferencia');
  t.eq(rf.liquidacionIVA({ debitoARS: 400, creditoARS: 1000 }),
    { debitoARS: 400, creditoARS: 1000, aPagarARS: 0, saldoAFavorARS: 600 },
    'crédito mayor que débito NO es un impuesto negativo: es saldo a favor');
  t.eq(rf.liquidacionIVA({ debitoARS: 500, creditoARS: 500 }).aPagarARS, 0, 'iguales: no se paga nada');
  t.eq(rf.liquidacionIVA().aPagarARS, 0, 'sin argumentos no rompe');

  // ── 6. Del nombre del mes a su rango de fechas ────────────────────────────
  // El crédito se agrupa por la columna `Mes`, que es un nombre sin año; el
  // débito sale de Fudo, que sólo entiende fechas.
  t.eq(fac.rangoDelMes('Septiembre', '2026-09-06'), { desde: '2026-09-01', hasta: '2026-09-30', anio: 2026 },
    'el mes en curso');
  t.eq(fac.rangoDelMes('Julio', '2026-09-06'), { desde: '2026-07-01', hasta: '2026-07-31', anio: 2026 },
    'un mes anterior del mismo año');
  t.eq(fac.rangoDelMes('Diciembre', '2026-09-06'), { desde: '2025-12-01', hasta: '2025-12-31', anio: 2025 },
    'un mes que todavía no llegó se resuelve al año anterior, no al futuro');
  t.eq(fac.rangoDelMes('Febrero', '2028-03-10').hasta, '2028-02-29', 'febrero bisiesto tiene 29');
  t.eq(fac.rangoDelMes('Febrero', '2026-03-10').hasta, '2026-02-28', 'febrero común tiene 28');
  t.eq(fac.rangoDelMes('septiembre', '2026-09-06').anio, 2026, 'no distingue mayúsculas');
  t.eq(fac.rangoDelMes('Cualquiera', '2026-09-06'), null, 'un mes inexistente devuelve null, no un rango raro');

  // ── 7. El endpoint junta las dos mitades en un solo viaje ────────────────
  const fs = require('fs');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = server.indexOf("app.get('/api/facturas'");
  const bloque = server.slice(i, i + 3000);
  t.ok(bloque.includes('debitoFiscalDeVentas'), '/api/facturas calcula el débito');
  t.ok(bloque.includes('liquidacionIVA'), '/api/facturas devuelve la resta ya hecha');
  t.ok(bloque.includes('getServicios'), 'el débito sale de las ventas de Fudo');
  t.ok(bloque.includes('return null; })'), 'si Fudo falla, el crédito se muestra igual');
  t.ok(bloque.includes('mediosPago[medio] = (mediosPago[medio] || 0)'),
    'los medios se suman POR PAGO sobre los días del mes, no por venta');
}

module.exports = { nombre: 'IVA de ventas (débito fiscal)', run };
