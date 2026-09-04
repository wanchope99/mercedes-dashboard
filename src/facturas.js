// ─── Registro de facturas — el crédito fiscal, factura por factura ───────────
//
// El libro (`Movimientos`) contesta CUÁNTA PLATA SALIÓ: una fila con el total y
// nada más. No tiene neto, ni IVA, ni CUIT, ni número de comprobante. La hoja
// `Compras` desglosa el IVA por RENGLÓN, que sirve para el precio de un producto
// y no para el impuesto: un renglón no es un comprobante, y el crédito fiscal se
// computa por comprobante.
//
// Por eso `regimen-fiscal.js` devuelve el crédito como un RANGO y lo dice en su
// cabecera: "el crédito no se lee, se estima". Este archivo es lo que lo hace
// leerse. Una fila por factura, con lo que un contador necesita para computarla.
//
// ─── Qué es este número (03/09/2026) ────────────────────────────────────────
//
// Decisión de Gonzalo: el paso a Responsable Inscripto está en curso, así que
// esto NO es una simulación. Es el IVA crédito del mes, el que se computa contra
// el débito de las ventas. Se registra desde hoy hacia adelante; lo anterior
// sigue siendo lo que estima `regimen-fiscal.js`.
//
// ─── La regla, y es una sola ────────────────────────────────────────────────
//
//     hay crédito ⟺ hay factura A
//
// Es la misma regla del 02/09 que ya gobierna la conversación del bot y las
// columnas de `Compras`. Un IVA discriminado en una factura B no da crédito
// fiscal: mirar ese número sería confundir cómo está escrito el papel con qué se
// puede hacer con él.
//
// Consecuencia directa en esta hoja: una factura NO computable deja las columnas
// de neto, alícuota e IVA **vacías**, no en cero. Cero significa "el IVA de esta
// factura es cero", que es una afirmación distinta y falsa. Mismo criterio que
// `appendCompras`.
//
// ─── Las facturas que no dan crédito SE REGISTRAN IGUAL ─────────────────────
//
// Podría parecer que una factura B no tiene nada que hacer acá. Al revés: es lo
// único que permite decir qué parte del gasto del mes YA está mirada. Un total
// de crédito sin cobertura es un número que no se sabe si está completo, y un
// número así invita a decidir sobre una precisión que no existe — el mismo
// motivo por el que el módulo fiscal habla en rangos.
//
// ─── Persistencia ──────────────────────────────────────────────────────────
//
// Hoja `Facturas` en la planilla de COMPARACIÓN PROVEEDORES, junto a `Compras`:
// son la cabecera y los renglones del mismo papel. Creada sola al primer uso.
//
//   A Fecha | B Mes | C Proveedor | D CUIT | E Comprobante | F Punto Venta |
//   G Numero | H Neto Gravado | I Alicuota | J IVA | K Otros Impuestos |
//   L Total | M Computable | N Fuente Importes | O ID Movimiento |
//   P Origen | Q Usuario | R Cargado
//
// NO hay columna "Crédito Fiscal", y es a propósito: sería exactamente la
// columna J cuando M dice S. Un total guardado al lado de lo que lo produce se
// desincroniza el día que alguien edita la planilla a mano, y entonces hay dos
// respuestas para la misma pregunta. El crédito del mes es la suma de J.

const { google } = require('googleapis');
const NodeCache = require('node-cache');
const { parseMonto, centavos } = require('./monto');

const cache = new NodeCache({ stdTTL: 60 });
const CACHE_KEY = 'facturas';

// ═══════════════════════════════════════════════════════════════════════════
// La planilla, y por qué acá NO hay fallback
// ═══════════════════════════════════════════════════════════════════════════
//
// Mismo criterio que `saldos.js`. `proveedores.js` cae a SPREADSHEET_ID cuando
// la variable no está; acá eso crearía la hoja sola en la planilla de GESTIÓN y
// nadie se enteraría hasta encontrarla ahí.
//
// Y el costo de apagarse es el correcto de los dos: sin registro, la cobertura
// del mes da 0% y la pantalla lo grita. Una hoja en la planilla equivocada no
// avisa nunca.
const SHEET_ID = process.env.PROVEEDORES_SHEET_ID || null;
const HOJA = process.env.FACTURAS_SHEET || 'Facturas';
const HEADER = ['Fecha', 'Mes', 'Proveedor', 'CUIT', 'Comprobante', 'Punto Venta',
  'Numero', 'Neto Gravado', 'Alicuota', 'IVA', 'Otros Impuestos', 'Total',
  'Computable', 'Fuente Importes', 'ID Movimiento', 'Origen', 'Usuario', 'Cargado'];
const ULTIMA_COL = 'R';
const TZ = 'America/Argentina/Buenos_Aires';

// Las letras que dan crédito fiscal. `M` es la factura A emitida a un sujeto no
// categorizado: mismo tratamiento, IVA discriminado y computable.
const COMPROBANTES_CON_CREDITO = ['A', 'M'];
const COMPROBANTES = ['A', 'B', 'C', 'M', 'X'];

// Las alícuotas del impuesto. Se usan para redondear una cuenta que da cerca:
// si el neto y el IVA leídos de la foto dan 20,97%, la alícuota es 21.
const ALICUOTAS_CONOCIDAS = [27, 21, 10.5, 5, 2.5];

// Cuánto puede no cerrar `neto + iva + otros` contra el total antes de que los
// importes leídos dejen de ser creíbles y haya que calcularlos. Un peso de
// redondeo es normal; un 1% ya es otro número.
const TOLERANCIA_MIN = 1;
const TOLERANCIA_PCT = 0.01;

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ═══════════════════════════════════════════════════════════════════════════
// Puras — todo lo de abajo se ejercita sin planilla y sin credenciales
// ═══════════════════════════════════════════════════════════════════════════

const _txt = v => (v == null ? '' : String(v)).trim();

const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** Texto comparable. Mismo criterio que proveedores-config y saldos. */
const norm = v => _txt(v).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

function _num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let n;
  try { n = parseMonto(v); } catch (e) { return null; }
  return Number.isFinite(n) ? n : null;
}

function mesDeISO(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(_txt(iso));
  return m ? MESES[Number(m[2]) - 1] || '' : '';
}

/** La letra del comprobante, o '' si no se sabe. */
function normalizarComprobante(v) {
  const s = _txt(v).toUpperCase().replace(/[^A-Z]/g, '');
  return COMPROBANTES.includes(s) ? s : '';
}

/**
 * ¿Esta factura da crédito fiscal?
 *
 * La letra manda cuando se conoce. Cuando no —la foto no la mostró y la persona
 * contestó la pregunta igual— manda lo que contestó. Nunca se deduce del IVA ni
 * del CUIT: los dos aparecen en facturas B que no dan crédito.
 */
function esComputable({ comprobante, deducible } = {}) {
  const letra = normalizarComprobante(comprobante);
  if (letra) return COMPROBANTES_CON_CREDITO.includes(letra);
  return deducible === true;
}

/** El punto de venta y el número, con los ceros que usa AFIP. '' si no se sabe. */
function formatearNumero(puntoVenta, numero) {
  const pv = _txt(puntoVenta).replace(/\D/g, '');
  const nu = _txt(numero).replace(/\D/g, '');
  if (!nu) return { puntoVenta: pv ? pv.padStart(5, '0') : '', numero: '' };
  return { puntoVenta: pv ? pv.padStart(5, '0') : '', numero: nu.padStart(8, '0') };
}

/**
 * La identidad de una factura, para no cargarla dos veces.
 *
 * En orden de qué tan bien identifica:
 *
 *   1. proveedor + letra + punto de venta + número → es el comprobante. Dos
 *      facturas distintas no pueden compartirlo, y la misma factura
 *      re-fotografiada siempre lo comparte. Es la clave de verdad.
 *   2. la fila del libro que ya tiene esa compra. Sirve para no registrar dos
 *      veces la misma compra cuando la foto no dejó ver el número.
 *   3. nada. Sin número y sin fila vinculada no hay forma de reconocerla, y
 *      entonces NO se bloquea: una factura sin cargar es peor que una repetida
 *      que se ve en la lista del mes.
 */
function claveDe(f = {}) {
  const { puntoVenta, numero } = formatearNumero(f.puntoVenta, f.numero);
  if (numero) {
    return `cbte:${norm(f.proveedor)}|${normalizarComprobante(f.comprobante)}|${puntoVenta}-${numero}`;
  }
  if (_txt(f.idMovimiento)) return `mov:${_txt(f.idMovimiento)}`;
  return '';
}

/**
 * Redondea a una alícuota conocida sólo si el resultado está cerca. Si la cuenta
 * da 14,7% no es ninguna y se devuelve tal cual: inventar un 21 ahí sería
 * escribir en la planilla un número que la factura no dice.
 */
function acercarAlicuota(pct) {
  if (!Number.isFinite(pct) || pct <= 0) return null;
  const cerca = ALICUOTAS_CONOCIDAS.find(a => Math.abs(a - pct) <= 0.6);
  return cerca != null ? cerca : Math.round(pct * 100) / 100;
}

/**
 * El desglose de una factura: neto gravado, IVA y otros impuestos.
 *
 * ─── Por qué el total SIEMPRE es con IVA ───────────────────────────────────
 *
 * "IVA incluido" y "IVA discriminado" describen los PRECIOS DE LOS RENGLONES —
 * si el precio unitario ya lo lleva adentro o hay que sumárselo. Es lo que
 * decide las columnas L y M de `Compras`. El pie de la factura no tiene esa
 * ambigüedad: el total final es el total final. Así que acá la cuenta es una
 * sola y no depende de `ivaIncluido`.
 *
 * ─── Otros impuestos NO son crédito ────────────────────────────────────────
 *
 * Percepciones, impuestos internos, sellos: se pagan, están adentro del total y
 * no se computan como IVA. Se restan antes de sacar el neto y quedan en su
 * propia columna, porque tratarlos como IVA infla el crédito con plata que no
 * vuelve.
 *
 * ─── Se prefiere lo LEÍDO sobre lo calculado, y sólo si cierra ─────────────
 *
 * Si la factura mostró su neto y su IVA, esos son los números del comprobante y
 * ganan. Pero sólo cuando `neto + IVA + otros` da el total: si no cierra, uno de
 * los tres se leyó mal y calcular a partir del total —que es el dato que una
 * persona confirmó con un toque— es más confiable que arrastrar el error.
 *
 * Devuelve `fuente` para que la planilla diga de dónde salió cada fila. Un
 * número sin origen declarado es un número que nadie puede auditar.
 */
function desglosar({
  total, otrosImpuestos = 0, computable, alicuota,
  netoLeido = null, ivaLeido = null,
} = {}) {
  const tot = centavos(_num(total) || 0);
  const otros = centavos(Math.max(0, _num(otrosImpuestos) || 0));

  if (!(tot > 0)) {
    return { neto: null, alicuota: null, iva: null, otros: 0, total: 0, fuente: 'sin-total' };
  }

  // No computable: las columnas del impuesto quedan VACÍAS, no en cero.
  if (!computable) {
    return { neto: null, alicuota: null, iva: null, otros, total: tot, fuente: 'no-computable' };
  }

  const neto0 = _num(netoLeido);
  const iva0 = _num(ivaLeido);
  if (neto0 > 0 && iva0 > 0) {
    const tolerancia = Math.max(TOLERANCIA_MIN, tot * TOLERANCIA_PCT);
    if (Math.abs(neto0 + iva0 + otros - tot) <= tolerancia) {
      return {
        neto: centavos(neto0),
        alicuota: acercarAlicuota((iva0 / neto0) * 100),
        iva: centavos(iva0),
        otros, total: tot, fuente: 'leido',
      };
    }
  }

  const pct = _num(alicuota);
  if (!(pct > 0)) {
    // Computable pero sin alícuota y sin importes creíbles: no se puede sacar el
    // IVA. Se registra la factura con su total y las columnas del impuesto
    // vacías, y la fila queda marcada para completar. Inventar una alícuota acá
    // sería inventar crédito fiscal.
    return { neto: null, alicuota: null, iva: null, otros, total: tot, fuente: 'falta-alicuota' };
  }

  const base = centavos(tot - otros);
  const neto = centavos(base / (1 + pct / 100));
  return {
    neto,
    alicuota: acercarAlicuota(pct),
    iva: centavos(base - neto),
    otros, total: tot, fuente: 'calculado',
  };
}

/**
 * Arma la fila lista para escribir, o explica por qué no se puede.
 *
 * PURA a propósito, igual que `construirFilaGasto` en server.js: es el contrato
 * con la planilla (18 posiciones exactas) y se puede ejercitar sin escribir.
 */
function construirFila(f = {}) {
  const fecha = _txt(f.fecha);
  if (!/^\d{4}-\d{2}-\d{2}/.test(fecha)) {
    return { ok: false, error: 'La fecha de la factura tiene que venir como AAAA-MM-DD.' };
  }
  const proveedor = _txt(f.proveedor);
  if (!proveedor) return { ok: false, error: 'Falta el proveedor.' };

  const computable = esComputable(f);
  const d = desglosar({
    total: f.total,
    otrosImpuestos: f.otrosImpuestos,
    computable,
    alicuota: f.alicuota,
    netoLeido: f.neto,
    ivaLeido: f.iva,
  });
  if (d.fuente === 'sin-total') {
    return { ok: false, error: 'El total de la factura tiene que ser un número mayor que cero.' };
  }

  const { puntoVenta, numero } = formatearNumero(f.puntoVenta, f.numero);
  const mes = _txt(f.mes) || mesDeISO(fecha);

  const row = [
    fecha,                                  // A Fecha
    mes,                                    // B Mes
    proveedor,                              // C Proveedor
    _txt(f.cuit),                           // D CUIT
    normalizarComprobante(f.comprobante),   // E Comprobante
    puntoVenta,                             // F Punto Venta
    numero,                                 // G Numero
    d.neto == null ? '' : d.neto,           // H Neto Gravado
    d.alicuota == null ? '' : d.alicuota,   // I Alicuota
    d.iva == null ? '' : d.iva,             // J IVA
    d.otros || '',                          // K Otros Impuestos
    d.total,                                // L Total
    computable ? 'S' : 'N',                 // M Computable
    d.fuente,                               // N Fuente Importes
    _txt(f.idMovimiento),                   // O ID Movimiento
    _txt(f.origen) || 'app',                // P Origen
    _txt(f.usuario),                        // Q Usuario
    new Date().toISOString(),               // R Cargado
  ];

  return { ok: true, row, desglose: d, computable, clave: claveDe({ ...f, comprobante: f.comprobante }) };
}

/** Una fila de la planilla → objeto. */
function parsearFila(f = [], i = 0) {
  const fecha = _txt(f[0]);
  const proveedor = _txt(f[2]);
  if (!fecha && !proveedor) return null;
  const computable = /^s/i.test(_txt(f[12]));
  return {
    fecha,
    mes: _txt(f[1]) || mesDeISO(fecha),
    proveedor,
    cuit: _txt(f[3]),
    comprobante: normalizarComprobante(f[4]),
    puntoVenta: _txt(f[5]),
    numero: _txt(f[6]),
    neto: _num(f[7]),
    alicuota: _num(f[8]),
    // El crédito es el IVA de una factura computable, y NADA MÁS. Una fila que
    // dice N con un IVA escrito al lado no aporta crédito: la letra manda.
    iva: computable ? _num(f[9]) : null,
    ivaEscrito: _num(f[9]),
    otrosImpuestos: _num(f[10]) || 0,
    total: _num(f[11]) || 0,
    computable,
    fuente: _txt(f[13]),
    idMovimiento: _txt(f[14]),
    origen: _txt(f[15]),
    usuario: _txt(f[16]),
    cargado: _txt(f[17]),
    rowIndex: i + 1,
  };
}

/**
 * El acumulado de un mes: cuánto crédito fiscal se juntó y de dónde sale.
 *
 * Puro. Recibe las facturas ya leídas y el mes por su nombre — la misma columna
 * `Mes` que agrupa todo el resto de la app. Nunca agrupa por fecha: en este
 * repo eso ya invirtió una conclusión una vez (ver el bloque de informes en
 * CLAUDE.md), y una factura de un pago diferido pertenece al mes en que se
 * compró, no al que se paga.
 */
function acumuladoDelMes(facturas, mes) {
  const clave = norm(mes);
  const delMes = (facturas || []).filter(f => norm(f.mes) === clave);

  const porAlicuota = new Map();
  const porProveedor = new Map();
  let credito = 0, netoGravado = 0, otros = 0, totalConFactura = 0;
  let computables = 0, sinCredito = 0, incompletas = 0;

  for (const f of delMes) {
    totalConFactura += f.total || 0;
    otros += f.otrosImpuestos || 0;

    const p = porProveedor.get(norm(f.proveedor))
      || { proveedor: f.proveedor, credito: 0, total: 0, facturas: 0, computables: 0 };
    p.total += f.total || 0;
    p.facturas += 1;

    if (f.computable) {
      computables += 1;
      p.computables += 1;
      if (f.iva > 0) {
        credito += f.iva;
        netoGravado += f.neto || 0;
        p.credito += f.iva;
        const a = f.alicuota == null ? 'sin alícuota' : String(f.alicuota);
        const acc = porAlicuota.get(a) || { alicuota: f.alicuota, neto: 0, iva: 0, facturas: 0 };
        acc.neto += f.neto || 0;
        acc.iva += f.iva;
        acc.facturas += 1;
        porAlicuota.set(a, acc);
      } else {
        // Computable pero sin IVA cargado: es crédito que existe y todavía no se
        // sabe cuánto. Se cuenta aparte en vez de sumar cero, que lo escondería.
        incompletas += 1;
      }
    } else {
      sinCredito += 1;
    }

    porProveedor.set(norm(f.proveedor), p);
  }

  return {
    mes,
    facturas: delMes.length,
    computables, sinCredito, incompletas,
    credito: centavos(credito),
    netoGravado: centavos(netoGravado),
    otrosImpuestos: centavos(otros),
    totalConFactura: centavos(totalConFactura),
    porAlicuota: [...porAlicuota.values()]
      .map(a => ({ ...a, neto: centavos(a.neto), iva: centavos(a.iva) }))
      .sort((x, y) => y.iva - x.iva),
    porProveedor: [...porProveedor.values()]
      .map(p => ({ ...p, credito: centavos(p.credito), total: centavos(p.total) }))
      .sort((x, y) => y.credito - x.credito || y.total - x.total),
  };
}

/**
 * Qué parte del gasto del mes tiene una factura detrás.
 *
 * Es la mitad que le falta al acumulado para poder creerse. El crédito del mes
 * sin cobertura no dice si está completo, y un total que no se sabe si está
 * completo invita a decidir sobre una precisión que no existe — el mismo motivo
 * por el que `regimen-fiscal.js` habla en rangos.
 *
 * El cruce es por `ID Movimiento`: una factura vinculada a una fila cubre ESA
 * fila. Las facturas sin vínculo suman a `montoSinVincular` y se declaran
 * aparte, en vez de contarse como cobertura de una fila que nadie identificó.
 */
function cobertura(facturas, movimientos, mes) {
  const clave = norm(mes);
  const delMes = (facturas || []).filter(f => norm(f.mes) === clave);

  const vinculadas = new Map();
  let montoSinVincular = 0;
  for (const f of delMes) {
    if (f.idMovimiento) vinculadas.set(f.idMovimiento, f);
    else montoSinVincular += f.total || 0;
  }

  const gastos = (movimientos || []).filter(m =>
    norm(m.mes) === clave && m.tipo === 'Gasto' && !m.esCuota && !m.esCambio && (m.salidaARS || 0) > 0);

  let gastoTotal = 0, gastoCubierto = 0;
  const sinFactura = [];
  for (const m of gastos) {
    const monto = m.salidaARS || 0;
    gastoTotal += monto;
    if (m.cuotaId && vinculadas.has(m.cuotaId)) {
      gastoCubierto += monto;
    } else {
      sinFactura.push({
        idMovimiento: m.cuotaId || '',
        fecha: m.fechaISO || m.fechaStr || '',
        proveedor: m.proveedor,
        categoria: m.categoria,
        descripcion: m.descripcion,
        monto: centavos(monto),
        estado: m.estado,
        rowIndex: m.rowIndex || null,
      });
    }
  }

  return {
    gastoTotal: centavos(gastoTotal),
    gastoCubierto: centavos(gastoCubierto),
    pct: gastoTotal > 0 ? Math.round((gastoCubierto / gastoTotal) * 1000) / 10 : 0,
    montoSinVincular: centavos(montoSinVincular),
    sinFactura: sinFactura.sort((a, b) => b.monto - a.monto),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ¿Esta compra YA está en el libro?
// ═══════════════════════════════════════════════════════════════════════════
//
// Sacarle la foto a la factura no siempre es la primera vez que esa compra se
// anota. Los dos caminos por los que ya puede estar escrita:
//
//   · alguien la cargó desde "Nueva compra" en la app y después le saca la foto
//     para tener el detalle de productos y el IVA;
//   · el pedido llegó y se recibió, y la recepción escribió su fila.
//
// Hasta el 03/09/2026 el bot escribía una fila igual: `registrarCompra` acuña un
// id nuevo en cada llamada, así que la idempotencia por columna H —que protege
// contra el doble toque— nunca podía reconocer una fila que ya existía. El gasto
// quedaba duplicado y el mes, inflado.
//
// ─── Esto propone, no decide ────────────────────────────────────────────────
//
// La respuesta es una pregunta para una persona, y hay que decir por qué. Los
// dos errores son caros y son opuestos:
//
//   · dar por buena una fila que NO es → el gasto no se escribe NUNCA, en
//     silencio. Es el peor de los dos porque nada lo delata.
//   · escribir de más → una fila duplicada, que se ve en Pagos y en el Balance
//     y alguien la encuentra.
//
// Por eso `fuerza` viaja con el resultado: quien dibuja la pregunta ordena los
// botones según cuánto prueba la evidencia, en vez de empujar siempre para el
// mismo lado. Es la misma regla que en `planificarAsiento` separa "no es una
// pista: es la respuesta" del resto de las pistas.

// Cuánto se puede correr la fecha de la fila respecto de la fecha de la factura.
// Diez días cubre una compra cargada el día de la factura y una entrega que se
// recibió una semana después.
const VENTANA_DIAS = 10;

// Cuánto puede diferir el monto y seguir siendo la misma compra: el peso del
// redondeo, no un importe distinto.
const TOLERANCIA_MONTO_MIN = 1;
const TOLERANCIA_MONTO_PCT = 0.005;

function _diasEntre(isoA, isoB) {
  const a = Date.parse(`${_txt(isoA).slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${_txt(isoB).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / 86400000;
}

/**
 * Las filas del libro que podrían ser esta factura, la mejor primero.
 *
 * `facturas` son las ya registradas: una fila que YA tiene su factura no se
 * ofrece, porque ofrecerla sería proponer vincular dos comprobantes distintos a
 * la misma fila y perder uno de los dos gastos.
 *
 * Puro. Recibe los movimientos ya leídos.
 */
function buscarCompraEnLibro(movimientos, { proveedor, fecha, total } = {}, facturas = []) {
  const clave = norm(proveedor);
  if (!clave) return { candidatas: [], mejor: null };

  const yaVinculadas = new Set((facturas || []).map(f => f.idMovimiento).filter(Boolean));
  const monto = _num(total);
  const tol = monto > 0 ? Math.max(TOLERANCIA_MONTO_MIN, monto * TOLERANCIA_MONTO_PCT) : 0;

  const candidatas = [];
  for (const m of (movimientos || [])) {
    if (m.tipo !== 'Gasto' || m.esCuota || m.esCambio) continue;
    if (!((m.salidaARS || 0) > 0)) continue;
    const nom = norm(m.proveedor);
    if (!nom) continue;
    // Nombre exacto, o uno contenido en el otro ("Thames" ↔ "Thames SA"). La
    // contención sola no alcanza para nada: sirve para no perder la fila, y la
    // fuerza del match la sigue decidiendo el monto.
    if (nom !== clave && !nom.includes(clave) && !clave.includes(nom)) continue;

    const dias = _diasEntre(m.fechaISO || m.fechaStr, fecha);
    if (dias == null || dias > VENTANA_DIAS) continue;

    const diff = monto > 0 ? Math.abs((m.salidaARS || 0) - monto) : null;
    const porMonto = diff != null && diff <= tol;

    candidatas.push({
      idMovimiento: m.cuotaId || '',
      rowIndex: m.rowIndex || null,
      fecha: m.fechaISO || m.fechaStr || '',
      mes: m.mes,
      proveedor: m.proveedor,
      categoria: m.categoria,
      descripcion: m.descripcion,
      medioPago: m.medioPago,
      estado: m.estado,
      monto: centavos(m.salidaARS || 0),
      diferencia: diff == null ? null : centavos(diff),
      dias,
      // 'monto' → el importe coincide: es casi seguro la misma compra.
      // 'fecha' → mismo proveedor en la ventana, pero por otra plata.
      fuerza: porMonto ? 'monto' : 'fecha',
      // Una fila ya vinculada se informa pero no se propone.
      yaTieneFactura: !!(m.cuotaId && yaVinculadas.has(m.cuotaId)),
    });
  }

  const libres = candidatas.filter(c => !c.yaTieneFactura);
  libres.sort((a, b) => {
    if (a.fuerza !== b.fuerza) return a.fuerza === 'monto' ? -1 : 1;
    if (a.fuerza === 'monto' && a.diferencia !== b.diferencia) return a.diferencia - b.diferencia;
    return a.dias - b.dias;
  });

  return {
    candidatas: libres,
    mejor: libres[0] || null,
    // Cuántas quedaron afuera por ya tener su propia factura. Se dice en vez de
    // callarse: que no aparezca una fila que existe tiene que tener explicación.
    conFactura: candidatas.filter(c => c.yaTieneFactura).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// I/O
// ═══════════════════════════════════════════════════════════════════════════

/** ¿Está configurada la planilla? Si no, el módulo no hace nada y lo dice. */
function configurada() { return !!SHEET_ID; }

function _sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }),
  });
}

async function _ensureHoja(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOJA } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${HOJA}!A1:${ULTIMA_COL}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

async function _leer(api) {
  let filas;
  try {
    const r = await api.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${HOJA}!A:${ULTIMA_COL}`,
    });
    filas = r.data.values || [];
  } catch (e) {
    await _ensureHoja(api).catch(() => {});
    return [];
  }
  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const f = parsearFila(filas[i] || [], i);
    if (f) out.push(f);
  }
  return out;
}

/** Todas las facturas registradas. `[]` si el módulo está apagado. */
async function listar() {
  if (!configurada()) return [];
  const hit = cache.get(CACHE_KEY);
  if (hit) return hit;
  const val = await _leer(_sheets());
  cache.set(CACHE_KEY, val);
  return val;
}

function limpiarCache() { cache.del(CACHE_KEY); }

/**
 * ¿Ya está registrada esta factura? Devuelve la fila que la tiene, o null.
 *
 * Se relee SIN cache: es la pregunta que evita duplicar, y contestarla con datos
 * de hasta un minuto atrás la haría fallar justo en el caso que importa — dos
 * fotos de la misma factura, una atrás de la otra.
 */
async function buscarPorClave(clave) {
  if (!configurada() || !clave) return null;
  const filas = await _leer(_sheets());
  cache.set(CACHE_KEY, filas);
  return filas.find(f => claveDe(f) === clave) || null;
}

/**
 * Registra una factura. NUNCA tira.
 *
 * Misma regla que `avisos.js` y `saldos.js`: quien llama ya hizo el trabajo real
 * —la fila del libro escrita, los productos cargados— y nada de eso puede
 * fallar porque no se pudo anotar el comprobante. Devuelve `{ ok:false }` y la
 * pantalla dice que la factura quedó sin registrar, que es lo único que hace que
 * alguien la cargue a mano.
 */
async function registrar(f = {}) {
  if (!configurada()) {
    return { ok: false, error: 'El registro de facturas no está configurado (falta PROVEEDORES_SHEET_ID).' };
  }
  const armado = construirFila(f);
  if (!armado.ok) return armado;

  try {
    const api = _sheets();
    if (armado.clave) {
      const ya = await buscarPorClave(armado.clave);
      if (ya) return { ok: true, yaExistia: true, fila: ya.rowIndex, factura: ya };
    }
    await _ensureHoja(api).catch(() => {});
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${HOJA}!A:${ULTIMA_COL}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [armado.row] },
    });
    limpiarCache();
    return { ok: true, desglose: armado.desglose, computable: armado.computable, clave: armado.clave };
  } catch (e) {
    console.error('No se pudo registrar la factura:', e.message);
    return { ok: false, error: e.message };
  }
}

/** El acumulado de un mes, leyendo la planilla. */
async function resumenDelMes(mes) {
  return acumuladoDelMes(await listar(), mes);
}

module.exports = {
  // I/O
  configurada, listar, registrar, buscarPorClave, resumenDelMes, limpiarCache,
  // Puras — exportadas para poder ejercitarlas sin planilla
  desglosar, construirFila, parsearFila, acumuladoDelMes, cobertura,
  buscarCompraEnLibro,
  esComputable, normalizarComprobante, formatearNumero, claveDe,
  acercarAlicuota, mesDeISO, norm, VENTANA_DIAS,
  COMPROBANTES, COMPROBANTES_CON_CREDITO, ALICUOTAS_CONOCIDAS, HOJA, HEADER,
};
