// ─── Finanzas — capital del recupero de la inversión ────────────────────────────
//
// La plata que cada mes se separa para RECUPERAR la inversión (col L de Cierres,
// ver roi.js) no se deja quieta en la caja operativa: se coloca en una cuenta
// aparte que rinde. Desde el 24/07/2026 la estrategia es UNA SOLA:
//
//   · 100% a MERCADO PAGO PABLO — cuenta remunerada, rinde tnaMercadoPago (17,5%
//     TNA al 03/08/2026), liquidez inmediata, sin plazo ni riesgo de precio.
//
// CUÁNTO VALE EL POZO NO SE SUMA ACÁ: se lee del saldo de la caja "Mercado Pago
// Pablo" en la hoja Cajas, que la planilla ya calcula sobre Movimientos. Antes se
// derivaba sumando el registro manual de abajo y el resultado quedaba viejo: al
// 03/08/2026 el registro daba $15.092.924 contra $20.570.325 reales, porque le
// faltaban una colocación de $6.000.000 y $522.599 de salidas que nadie cargó.
// El saldo de la caja no se puede desactualizar — sale de los mismos movimientos
// que todo el resto de la app.
//
// Esa cuenta ADEMÁS se usa para pagar gastos del bar (Pablo saca de ahí). Así que
// no es un pozo puro: el desglose muestra las salidas operativas por separado en
// lugar de dejarlas escondidas dentro de un saldo. El registro de movimientos
// sigue existiendo, pero para otra pregunta: de qué cierre salió cada peso.
//
// Antes había dos buckets (UVA + CER) con una escalera de plazos escalonados.
// Se sacó a propósito: obligaba a mantener un reparto, un calendario de
// vencimientos y una cotización UVA para administrar plata que en la práctica se
// coloca en un solo lugar. Los movimientos viejos cargados con bucket "uva" o
// "cer" NO se migran ni se descartan: conciliar() los junta aparte para que el
// total siga cerrando y se vean como lo que son, plata en otro instrumento.
//
// OJO — esta estrategia NO protege contra la inflación. A 17% TNA (≈1,42%
// mensual) contra una inflación de ~1,9% mensual, el capital pierde poder
// adquisitivo mes a mes. La proyección lo muestra explícito en "valor real": es
// la contrapartida de tener la plata disponible al instante y sin riesgo de
// precio. Decisión tomada a conciencia, no un descuido del modelo.
//
// DOS PLANOS, deliberadamente separados:
//   1. PROYECCIÓN (calcularProyeccion): simulación con parámetros configurables.
//      Todo se deriva del capital inicial + aportes + parámetros, no se persiste.
//   2. REGISTRO REAL (hoja "Finanzas Movimientos"): qué se colocó de verdad,
//      cuándo, en qué instrumento y con qué comprobante. Es la pista de
//      auditoría que permite demostrar que la plata del recupero NO se mezcló
//      con la caja operativa del bar. conciliar() compara ambos planos.
//
// Persistencia (sin base de datos, como todo el resto): tres hojas en la
// planilla maestra SPREADSHEET_ID, creadas automáticamente al primer uso.
//
//   "Finanzas Config"      A Clave | B Valor
//   "Finanzas Aportes"     A MesISO | B MontoARS | C Notas | D Actualizado
//       Sólo guarda los meses EDITADOS a mano. Si un mes no está, el aporte sale
//       del recupero real de ese cierre (roi.js). Así el default siempre sigue a
//       la realidad y lo que el usuario tocó queda explícito.
//   "Finanzas Movimientos" A ID | B Fecha | C Tipo | D Bucket | E MontoARS |
//       F Instrumento | G Comprobante | H MesRecupero | I Notas | J Registrado
//
// No es asesoramiento financiero: los rendimientos son supuestos configurables y
// las condiciones reales (TNA vigente) hay que verificarlas en la app de Mercado
// Pago al momento de colocar — la TNA de la cuenta remunerada cambia seguido.

const { google } = require('googleapis');
const NodeCache = require('node-cache');
const { parseMonto, centavos } = require('./monto');

const cache = new NodeCache({ stdTTL: 300 });
const CACHE_KEY = 'finanzas';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA_CONFIG = process.env.FINANZAS_CONFIG_SHEET || 'Finanzas Config';
const HOJA_APORTES = process.env.FINANZAS_APORTES_SHEET || 'Finanzas Aportes';
const HOJA_MOVS = process.env.FINANZAS_MOVS_SHEET || 'Finanzas Movimientos';

const HEADER_CONFIG = ['Clave', 'Valor'];
const HEADER_APORTES = ['MesISO', 'MontoARS', 'Notas', 'Actualizado'];
const HEADER_MOVS = ['ID', 'Fecha', 'Tipo', 'Bucket', 'MontoARS', 'Instrumento', 'Comprobante', 'MesRecupero', 'Notas', 'Registrado'];

// Único destino vigente. Los históricos 'uva'/'cer' se siguen LEYENDO (no se
// pierde historial) pero ya no se pueden cargar nuevos.
const BALDE_MP = 'mp';
// Vault en dólares (12/08/2026). Un porcentaje del capital de recupero se guarda
// en dólares en la caja `MP Pablo USD`.
//
// INCLUSIÓN MÍNIMA, A PROPÓSITO: hoy este balde sirve para que la plata deje de
// ser invisible —se puede registrar y el pozo la cuenta— pero el modelo sigue
// siendo el de un solo destino en pesos. Lo que TODAVÍA NO hace y hay que
// resolver en el revamp:
//   · el interés se devenga sólo sobre la cuenta en pesos (la TNA del 17,5% es
//     de esa cuenta; el vault en dólares no rinde eso, rinde lo que haga el dólar);
//   · no hay política de qué porcentaje va a cada destino, ni nada que la controle;
//   · la proyección (calcularProyeccion) razona en pesos y no sabe de esto.
// No agregar features encima de este balde sin encarar eso primero.
const BALDE_MP_USD = 'mp-usd';
const BALDES = [BALDE_MP, BALDE_MP_USD];
const BALDES_LEGACY = ['uva', 'cer'];
// "interes" es lo que la cuenta remunerada pagó: NO es plata colocada, es lo que
// rindió la que ya estaba. Se registra a medida que se acredita, y como cada
// acreditación sube el saldo sobre el que Mercado Pago calcula la siguiente, el
// registro compone solo — no hay que proyectar nada acá.
const TIPOS = ['colocacion', 'rescate', 'renovacion', 'ajuste', 'interes'];

// Defaults al 24/07/2026: inflación INDEC jun-2026, TNA de la cuenta remunerada
// de Mercado Pago, y los $15.000.000 que ese día se pasaron de Galicia a
// Mercado Pago Pablo para arrancar la colocación.
const DEFAULT_CONFIG = {
  inflacionMensual: 0.019,
  tnaMercadoPago: 0.175,
  capitalInicialARS: 15000000,
  horizonteMeses: 24,
  mesInicio: '',   // "YYYY-MM"; vacío = el primer mes con recupero
};
const CLAVES_NUM = Object.keys(DEFAULT_CONFIG).filter(k => k !== 'mesInicio');

function _sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function _ensureHoja(api, titulo, header, rango) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: titulo } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${titulo}!${rango}`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

// Parser de los valores de CONFIG. Los escribe la app con String(number), así
// que el formato canónico es JS ("0.019", "0.17"): se parsea estricto. La
// heurística de miles de es-AR NO sirve acá — leería "0.019" como 19, tomando
// el punto por separador de miles. Sólo se tolera la coma decimal por si el
// valor se editó a mano en la planilla.
//
// Excepción: capitalInicialARS es un MONTO, no un ratio. Un "15.000.000" tipeado
// a mano en la planilla tiene que leerse como quince millones, no como 15.
function _numCfg(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[$\s%]/g, '');
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Número tolerante a "$ 1.234,56", "1,9%" y a los puntos de miles de es-AR.
// Para MONTOS cargados a mano, donde "1.234" significa mil doscientos treinta y
// cuatro. No usar para ratios de config (ver _numCfg), que es justamente por lo
// que esta regla y la de `monto.js` son dos y no una sola: acá conviven las dos
// lecturas del punto y hay que elegir por campo.
const _num = parseMonto;

// Claves que son montos en pesos y no ratios.
const CLAVES_MONTO = ['capitalInicialARS'];

// ─── Lectura ────────────────────────────────────────────────────────────────
async function _leerConfig(api) {
  const cfg = { ...DEFAULT_CONFIG };
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_CONFIG}!A:B` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA_CONFIG, HEADER_CONFIG, 'A1:B1');
    return cfg;
  }
  // Claves de la estrategia vieja (UVA/CER) que puedan haber quedado guardadas.
  // No se borran de la planilla — se ignoran acá y se listan para poder avisar.
  const obsoletas = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const clave = r[0].toString().trim();
    const valor = (r[1] == null ? '' : r[1]).toString().trim();
    if (clave === 'mesInicio') cfg.mesInicio = /^\d{4}-\d{2}$/.test(valor) ? valor : '';
    else if (CLAVES_MONTO.includes(clave)) cfg[clave] = _num(valor);
    else if (CLAVES_NUM.includes(clave)) cfg[clave] = _numCfg(valor);
    else obsoletas.push(clave);
  }
  if (obsoletas.length) cfg.clavesObsoletas = obsoletas;
  return cfg;
}

async function _leerAportes(api) {
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_APORTES}!A:D` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA_APORTES, HEADER_APORTES, 'A1:D1');
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const mes = r[0].toString().trim();
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    out.push({
      mes,
      monto: centavos(_num(r[1])),
      notas: (r[2] || '').toString().trim(),
      actualizado: (r[3] || '').toString().trim(),
      rowIndex: i + 1,
    });
  }
  return out;
}

async function _leerMovimientos(api) {
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_MOVS}!A:J` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, HOJA_MOVS, HEADER_MOVS, 'A1:J1');
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const balde = (r[3] || '').toString().trim().toLowerCase();
    out.push({
      id: r[0].toString().trim(),
      fecha: (r[1] || '').toString().trim(),          // "YYYY-MM-DD"
      tipo: (r[2] || 'colocacion').toString().trim(),
      balde,
      esLegacy: BALDES_LEGACY.includes(balde),
      monto: centavos(_num(r[4])),
      instrumento: (r[5] || '').toString().trim(),
      comprobante: (r[6] || '').toString().trim(),
      mesRecupero: (r[7] || '').toString().trim(),    // "YYYY-MM" que originó la plata
      notas: (r[8] || '').toString().trim(),
      registrado: (r[9] || '').toString().trim(),
      rowIndex: i + 1,
    });
  }
  return out;
}

async function _load() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return { config: { ...DEFAULT_CONFIG }, aportes: [], movimientos: [] };
  const api = _sheets();
  const [config, aportes, movimientos] = await Promise.all([
    _leerConfig(api), _leerAportes(api), _leerMovimientos(api),
  ]);
  const data = { config, aportes, movimientos };
  cache.set(CACHE_KEY, data);
  return data;
}

// ─── Proyección (pura) ──────────────────────────────────────────────────────
// aportes: [{ mes: "YYYY-MM", monto, origen }] ordenado, uno por mes del horizonte.
//
// Modelo: el capital inicial ya está colocado al arrancar y rinde desde el mes 1.
// El aporte del mes t entra al final de ese mes, así que empieza a rendir en t+1.
//
// La tasa mensual sale de TNA/12. La cuenta de Mercado Pago capitaliza todos los
// días, así que el rendimiento efectivo es apenas mayor; la diferencia a 17% TNA
// es de centésimas por mes y no justifica modelar la capitalización diaria en una
// proyección cuya variable dominante — la TNA futura — es una suposición.
function calcularProyeccion(config, aportes) {
  const p = { ...DEFAULT_CONFIG, ...(config || {}) };
  const infl = Number(p.inflacionMensual) || 0;
  const rMensual = (Number(p.tnaMercadoPago) || 0) / 12;
  const capitalInicial = Math.max(0, Number(p.capitalInicialARS) || 0);
  const N = aportes.length;

  const filas = [];
  let saldo = capitalInicial;
  let aportadoAcum = capitalInicial;
  let aportadoReal = capitalInicial;

  for (let i = 0; i < N; i++) {
    const t = i + 1;
    const aporte = Number(aportes[i].monto) || 0;

    const interes = saldo * rMensual;
    saldo = saldo + interes + aporte;

    const indicePrecios = Math.pow(1 + infl, t - 1);
    aportadoAcum += aporte;
    aportadoReal += aporte / indicePrecios;
    const totalReal = saldo / indicePrecios;

    filas.push({
      mes: t,
      mesISO: aportes[i].mes,
      origen: aportes[i].origen || 'sin datos',
      aporte,
      interes,
      totalNominal: saldo,
      aportadoAcum,
      indicePrecios,
      totalReal,
      aportadoReal,
      gananciaReal: totalReal - aportadoReal,
    });
  }

  const ultima = filas[filas.length - 1] || null;
  // Tasa real mensual: cuánto poder adquisitivo gana (o pierde) el capital una
  // vez descontada la inflación. Con 17% TNA e inflación 1,9% mensual es
  // NEGATIVA, y es el número más importante de toda la pantalla.
  const tasaRealMensual = infl === 0 ? rMensual : (1 + rMensual) / (1 + infl) - 1;

  return {
    filas,
    parametros: {
      ...p,
      rendMensual: rMensual,
      tasaRealMensual,
      tasaRealAnual: Math.pow(1 + tasaRealMensual, 12) - 1,
      capitalInicial,
    },
    resumen: ultima ? {
      meses: N,
      capitalInicial,
      totalNominal: ultima.totalNominal,
      totalReal: ultima.totalReal,
      aportadoAcum: ultima.aportadoAcum,
      aportadoReal: ultima.aportadoReal,
      gananciaReal: ultima.gananciaReal,
      pctGananciaReal: ultima.aportadoReal > 0 ? (ultima.gananciaReal / ultima.aportadoReal) * 100 : 0,
      interesesAcum: filas.reduce((s, f) => s + f.interes, 0),
    } : null,
  };
}

function _sumarMeses(iso, n) {
  if (!/^\d{4}-\d{2}$/.test(iso || '')) return '';
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Conciliación: lo asignado a recupero vs. lo realmente colocado ─────────
// El punto de todo esto: que el capital del recupero no se mezcle con la caja
// operativa del bar.
//
// Se separa por ORIGEN de la plata, no por instrumento. Un movimiento con
// "MesRecupero" cargado es plata que salió del recupero de ese cierre; sin
// MesRecupero es capital propio puesto aparte (el caso de los $15.000.000 que
// vinieron de Galicia el 24/07/2026). Mezclarlos hacía que colocar capital
// propio apareciera como "colocado de más respecto de lo asignado", que es una
// alarma falsa.
function conciliar(movimientos, recuperoPorMes) {
  const signo = t => (t === 'rescate' ? -1 : 1);   // rescate saca plata de los instrumentos
  let colocado = 0, deRecupero = 0, capitalPropio = 0, intereses = 0;
  let enMercadoPago = 0, enLegacy = 0;
  for (const m of movimientos) {
    if (m.tipo === 'renovacion') continue;         // no mueve capital, sólo lo reubica
    const v = signo(m.tipo) * (m.monto || 0);
    if (m.tipo === 'interes') {
      // El interés queda FUERA de "colocado" a propósito. Sumarlo ahí haría
      // aparecer capital propio que nadie puso, y "sin colocar" se volvería
      // negativo solo — la alarma de "colocado de más" que este mismo cálculo
      // separa el capital propio para evitar.
      intereses += v;
    } else {
      colocado += v;
      if (m.mesRecupero) deRecupero += v; else capitalPropio += v;
    }
    // El destino sí lleva todo: es lo que hay en la cuenta, puesto o generado.
    if (m.balde === BALDE_MP) enMercadoPago += v; else enLegacy += v;
  }
  const asignado = (recuperoPorMes || []).reduce((s, m) => s + (m.recuperoARS || 0), 0);
  return {
    asignadoARS: Math.round(asignado),
    colocadoARS: Math.round(colocado),
    deRecuperoARS: Math.round(deRecupero),
    capitalPropioARS: Math.round(capitalPropio),
    sinColocarARS: Math.round(asignado - deRecupero),
    interesesARS: Math.round(intereses),
    // Lo que dice el REGISTRO. No es lo que el pozo vale -eso sale del saldo de
    // la caja- sino lo que alguien alcanzó a asentar. La diferencia entre los dos
    // es justamente lo que falta cargar, y por eso se expone en vez de esconderse.
    valorRegistroARS: Math.round(colocado + intereses),
    porDestino: {
      mercadoPago: Math.round(enMercadoPago),
      legacy: Math.round(enLegacy),
    },
    movimientos: movimientos.length,
  };
}

// ─── El pozo real: sale del saldo de la caja, no de sumar el registro ────────
//
// La caja se busca por NOMBRE. En la hoja Cajas las filas se mueven -el 24/07/2026
// se insertó una y todo lo de abajo bajó un lugar- así que cualquier referencia
// fija (Cajas!F3) tarde o temprano lee la cuenta de otro.
const CAJA_POZO = 'Mercado Pago Pablo';

// El vault en dólares. Se lleva EN DÓLARES (columna Moneda = USD en la hoja
// Cajas), así que su saldo no se puede sumar al de la cuenta en pesos sin
// convertirlo. Se valúa al blue de HOY porque es una foto del presente —"cuánto
// vale hoy el pozo"—, no un movimiento histórico. Los movimientos históricos sí
// se valúan al TC de su día (ver sheets.js).
const CAJA_POZO_USD = 'MP Pablo USD';

// Las salidas de esa cuenta son gastos del bar que Pablo paga desde ahí. No es
// plata que "se perdió" del pozo: es plata del bar que salió por esa ventanilla.
// Se muestran aparte justamente porque el saldo solo no deja verlo.
async function _pozoReal() {
  const { getCajas, getMovimientos } = require('./sheets');
  const norm = s => (s || '').toString().trim().toLowerCase();

  const cajas = await getCajas().catch(() => []);
  const caja = cajas.find(c => norm(c.caja) === norm(CAJA_POZO));
  if (!caja) {
    return { encontrada: false, caja: CAJA_POZO, saldoARS: 0, entradasARS: 0, salidasARS: 0, salidas: [] };
  }

  const movs = await getMovimientos().catch(() => []);
  const deLaCaja = movs.filter(m => norm(m.medioPago) === norm(CAJA_POZO));

  const salidas = deLaCaja
    .filter(m => (m.salidaARS || 0) > 0)
    .map(m => ({
      rowIndex: m.rowIndex, fecha: m.fechaStr, tipo: m.tipo, categoria: m.categoria,
      proveedor: m.proveedor, descripcion: m.descripcion, montoARS: m.salidaARS,
    }))
    .sort((a, b) => b.rowIndex - a.rowIndex);

  // Flujos día a día para devengar el interés. Se separa lo que es RENDIMIENTO
  // ya acreditado por Mercado Pago de lo que es capital: el devengado que
  // calculamos reemplaza al acreditado, no se suma (ver calcularIntereses).
  const flujos = deLaCaja
    .filter(m => m.fecha)
    .map(m => ({
      fecha: m.fecha,
      monto: (m.entradaARS || 0) - (m.salidaARS || 0),
      esInteres: (m.entradaARS || 0) > 0 && RE_INTERES.test(`${m.descripcion} ${m.proveedor}`),
      rowIndex: m.rowIndex, descripcion: m.descripcion,
    }));

  // El vault en dólares, como componente APARTE. No se mezcla con saldoARS: ese
  // campo es la cuenta en pesos y hay pantallas y cálculos que dependen de que
  // siga significando exactamente eso. El total combinado se arma en
  // resumenFinanzas(), donde está el tipo de cambio.
  const cajaUSD = cajas.find(c => norm(c.caja) === norm(CAJA_POZO_USD));
  const vaultUSD = cajaUSD
    ? {
        encontrada: true,
        caja: cajaUSD.caja,
        saldoUSD: Math.round(cajaUSD.saldoCalculado || 0),
        saldoRealUSD: Math.round(cajaUSD.saldoReal || 0),
      }
    : { encontrada: false, caja: CAJA_POZO_USD, saldoUSD: 0, saldoRealUSD: 0 };

  return {
    encontrada: true,
    caja: caja.caja,
    saldoARS: Math.round(caja.saldoCalculado || 0),
    saldoRealARS: Math.round(caja.saldoReal || 0),
    entradasARS: Math.round(caja.entradas || 0),
    salidasARS: Math.round(caja.salidas || 0),
    salidas,
    vaultUSD,
    flujos,
  };
}

// ─── Interés devengado: lo que la cuenta TENDRÍA que haber pagado ────────────
//
// Para qué existe: poder decir cuánto hay en Mercado Pago Pablo sin tener que
// abrir la cuenta ni compartir el acceso con nadie. La cuenta remunerada rinde
// sobre el saldo todos los días y acredita los días hábiles — lo que devenga
// sábado y domingo entra el lunes junto con el del lunes.
//
// SE CALCULA, NO SE ASIENTA. Los rendimientos que Mercado Pago paga de verdad
// entran al ledger como una fila más de Movimientos ("Rendimientos MP") y el
// saldo de la caja ya los tiene adentro. Si además escribiéramos el devengado
// como movimiento, la misma plata quedaría contada dos veces. Lo que se hace es
// COMPARAR devengado esperado contra acreditado real: esa diferencia es la única
// forma de ver, desde acá, si la cuenta pagó lo que tenía que pagar.
//
// Convención: tasa diaria = TNA/365 sobre el saldo del día, y lo devengado se
// capitaliza el siguiente día hábil (por eso un lunes acredita tres días). Así
// el rendimiento del año da la TNA completa. La plata rinde desde el día que
// entra. Los feriados no se contemplan a propósito: corren una acreditación un
// día, no cambian el total del período.
const DIAS_ANIO = 365;
const RE_INTERES = /rendimiento|inter[eé]s/i;
const _DIA_MS = 86400000;

// Clave YYYY-MM-DD tomando el día LOCAL. Construir la clave en UTC correría las
// fechas un día para cualquier huso al oeste de Greenwich, que es el nuestro.
function _diaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function calcularIntereses(flujos, { tna, hasta } = {}) {
  const tasa = Number(tna) || 0;
  const capitalPorDia = new Map();
  let acreditadoReal = 0, primera = null;

  for (const f of flujos || []) {
    if (!f.fecha) continue;
    if (f.esInteres) { acreditadoReal += f.monto; continue; }
    const k = _diaISO(f.fecha);
    capitalPorDia.set(k, (capitalPorDia.get(k) || 0) + f.monto);
    if (!primera || k < primera) primera = k;
  }
  if (!primera || !(tasa > 0)) {
    return {
      tna: tasa, desde: primera || null, hasta: hasta || null,
      esperadosARS: 0, acreditadosARS: Math.round(acreditadoReal),
      diferenciaARS: -Math.round(acreditadoReal), sinAcreditarARS: 0,
      saldoEsperadoARS: 0, porMes: [],
    };
  }

  const finISO = hasta || _diaISO(new Date());
  const [y, m, d] = primera.split('-').map(Number);
  let cursor = new Date(y, m - 1, d);
  let balance = 0, pendiente = 0, capitalizado = 0;
  const porMes = new Map();

  while (_diaISO(cursor) <= finISO) {
    const k = _diaISO(cursor);
    balance += capitalPorDia.get(k) || 0;      // rinde desde el día que entra
    const dev = balance * (tasa / DIAS_ANIO);
    pendiente += dev;
    const mes = k.slice(0, 7);
    porMes.set(mes, (porMes.get(mes) || 0) + dev);
    const dow = cursor.getDay();
    if (dow >= 1 && dow <= 5) {               // hábil: se capitaliza lo devengado
      balance += pendiente;
      capitalizado += pendiente;
      pendiente = 0;
    }
    cursor = new Date(cursor.getTime() + _DIA_MS);
  }

  const esperados = capitalizado + pendiente;
  return {
    tna: tasa,
    desde: primera,
    hasta: finISO,
    esperadosARS: Math.round(esperados),
    acreditadosARS: Math.round(acreditadoReal),
    // Positivo = la cuenta pagó MENOS de lo que debería según la TNA cargada.
    diferenciaARS: Math.round(esperados - acreditadoReal),
    sinAcreditarARS: Math.round(pendiente),
    saldoEsperadoARS: Math.round(balance + pendiente),
    porMes: [...porMes.entries()]
      .map(([mes, monto]) => ({ mes, montoARS: Math.round(monto) }))
      .sort((a, b) => a.mes.localeCompare(b.mes)),
  };
}

// ─── API pública ────────────────────────────────────────────────────────────
// Arma la vista completa. `recuperoPorMes` viene de roi.js (server.js lo inyecta
// para no crear una dependencia circular finanzas ↔ roi ↔ plan).
async function resumenFinanzas(recuperoPorMes = []) {
  const { config, aportes, movimientos } = await _load();
  const pozo = await _pozoReal();
  const overrides = new Map(aportes.map(a => [a.mes, a]));
  const recuperoMap = new Map((recuperoPorMes || []).map(m => [m.iso, m]));

  // Mes de arranque: el configurado, o el primer cierre con recupero, o hoy.
  const mesesRecupero = (recuperoPorMes || []).map(m => m.iso).filter(Boolean).sort();
  const inicio = config.mesInicio || mesesRecupero[0] || _hoyISO();
  const N = Math.max(1, Math.round(config.horizonteMeses) || 24);

  const serie = [];
  for (let i = 0; i < N; i++) {
    const mes = _sumarMeses(inicio, i);
    const ov = overrides.get(mes);
    const rec = recuperoMap.get(mes);
    if (ov) serie.push({ mes, monto: ov.monto, origen: 'manual', notas: ov.notas });
    else if (rec) serie.push({ mes, monto: Math.round(rec.recuperoARS || 0), origen: 'cierre', notas: '' });
    else serie.push({ mes, monto: 0, origen: 'sin datos', notas: '' });
  }

  const proyeccion = calcularProyeccion(config, serie);
  // Los flujos sólo sirven para devengar; no se mandan al browser.
  const { flujos, ...pozoPublico } = pozo;
  const intereses = calcularIntereses(flujos || [], { tna: config.tnaMercadoPago });

  // Cuánto vale el pozo en dólares. El ARS/USD se mueve rápido, así que NUNCA se
  // asume un valor fijo: sale en vivo del blue (tc.js, cache de 10 min, con
  // fallback marcado `stale` si la consulta falla). Es el mismo módulo que usa
  // roi.js, así que las dos pantallas valúan con el MISMO número — dos fuentes
  // darían dos respuestas para la misma pregunta.
  const blue = await require('./tc').getDolarBlue().catch(() => null);
  const enUSD = ars => (blue && blue.tc > 0 ? Math.round((ars || 0) / blue.tc) : null);
  // El vault en dólares valuado en pesos, y el pozo total sumando los dos.
  // `pozoUSD` sigue significando lo mismo que antes —la cuenta en PESOS medida en
  // dólares— para no cambiarle el sentido a un campo que ya se está mostrando.
  // Lo nuevo va en campos nuevos.
  const vault = pozoPublico.vaultUSD || { saldoUSD: 0 };
  const vaultEnARS = (blue && blue.tc > 0) ? Math.round(vault.saldoUSD * blue.tc) : null;
  const dolar = blue
    ? {
        tc: blue.tc, compra: blue.compra, venta: blue.venta,
        fecha: blue.fecha, fuente: blue.fuente, stale: !!blue.stale,
        pozoUSD: enUSD(pozoPublico.saldoARS),
        vaultUSD: vault.saldoUSD,
        vaultEnARS,
        // El pozo completo: la cuenta en pesos más el vault en dólares valuado
        // a hoy. Es el número que contesta "cuánto hay puesto", ahora que la
        // plata vive en dos monedas.
        pozoTotalARS: vaultEnARS != null ? pozoPublico.saldoARS + vaultEnARS : null,
        pozoTotalUSD: enUSD(pozoPublico.saldoARS) != null
          ? enUSD(pozoPublico.saldoARS) + vault.saldoUSD : null,
      }
    : null;
  return {
    config,
    mesInicio: inicio,
    aportes: serie,
    movimientos: movimientos.map(({ rowIndex, ...m }) => m),
    proyeccion,
    pozo: pozoPublico,
    intereses,
    dolar,
    conciliacion: conciliar(movimientos, recuperoPorMes),
    // Claves de la estrategia vieja que siguen en la planilla y ya no se usan.
    clavesObsoletas: config.clavesObsoletas || null,
  };
}

function _hoyISO() {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return s.slice(0, 7);
}

// ─── Escritura ──────────────────────────────────────────────────────────────
async function guardarConfig(clave, valor) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  if (clave !== 'mesInicio' && !CLAVES_NUM.includes(clave)) throw new Error(`Clave desconocida: ${clave}`);
  const api = _sheets();
  await _ensureHoja(api, HOJA_CONFIG, HEADER_CONFIG, 'A1:B1');
  await _upsertClaveValor(api, HOJA_CONFIG, clave, valor);
  cache.del(CACHE_KEY);
}

async function _upsertClaveValor(api, hoja, clave, valor) {
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${hoja}!A:B` });
    rows = res.data.values || [];
  } catch (e) { rows = []; }
  let rowIndex = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i][0] && rows[i][0].toString().trim() === clave) { rowIndex = i + 1; break; }
  }
  const fila = [clave, valor == null ? '' : String(valor)];
  if (rowIndex > 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${hoja}!A${rowIndex}:B${rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${hoja}!A:B`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  }
}

// Fija a mano el aporte de un mes. monto === null → borra el override y el mes
// vuelve a tomar el recupero real del cierre.
async function guardarAporte(mesISO, monto, notas) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  if (!/^\d{4}-\d{2}$/.test(mesISO || '')) throw new Error('Mes inválido (se espera YYYY-MM)');
  const api = _sheets();
  await _ensureHoja(api, HOJA_APORTES, HEADER_APORTES, 'A1:D1');
  const aportes = await _leerAportes(api);
  const existente = aportes.find(a => a.mes === mesISO);

  if (monto == null) {
    if (existente) await _borrarFila(api, HOJA_APORTES, existente.rowIndex);
    cache.del(CACHE_KEY);
    return null;
  }
  const fila = [mesISO, Math.max(0, centavos(_num(monto))), (notas || '').toString().trim(), new Date().toISOString()];
  const data = [{ range: `${HOJA_APORTES}!A1:D1`, values: [HEADER_APORTES] }];
  if (existente) {
    data.push({ range: `${HOJA_APORTES}!A${existente.rowIndex}:D${existente.rowIndex}`, values: [fila] });
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: 'RAW', data },
    });
  } else {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: 'RAW', data },
    });
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA_APORTES}!A:D`,
      valueInputOption: 'RAW', requestBody: { values: [fila] },
    });
  }
  cache.del(CACHE_KEY);
  return { mes: mesISO, monto: Number(fila[1]) };
}

// Alta de un movimiento real (la pista de auditoría). No se editan: para
// corregir se borra y se vuelve a cargar, así el historial no miente.
async function guardarMovimiento(mov) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const tipo = (mov.tipo || 'colocacion').toString().trim();
  // Dos destinos desde el 12/08/2026: la cuenta en pesos y el vault en dólares.
  // Si no se especifica, sigue siendo la de pesos — así ningún cliente viejo
  // cambia de comportamiento por el solo hecho de que exista el segundo.
  const balde = (mov.balde || BALDE_MP).toString().trim().toLowerCase();
  const monto = centavos(_num(mov.monto));
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo inválido (${TIPOS.join(' | ')})`);
  if (!BALDES.includes(balde)) {
    throw new Error(`Destino inválido. Los vigentes son: ${BALDES.join(' | ')}`);
  }
  if (!(monto > 0)) throw new Error('El monto debe ser mayor a cero');
  const fecha = (mov.fecha || '').toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('Fecha inválida (se espera YYYY-MM-DD)');
  const mesRec = (mov.mesRecupero || '').toString().trim();
  if (mesRec && !/^\d{4}-\d{2}$/.test(mesRec)) throw new Error('Mes de recupero inválido (YYYY-MM)');

  const api = _sheets();
  await _ensureHoja(api, HOJA_MOVS, HEADER_MOVS, 'A1:J1');
  const fila = [
    `f${Date.now()}`, fecha, tipo, balde, monto,
    // El instrumento por defecto sigue al destino: si no, un movimiento al vault
    // quedaría registrado como si hubiera ido a la cuenta en pesos.
    (mov.instrumento || (balde === BALDE_MP_USD ? CAJA_POZO_USD : CAJA_POZO)).toString().trim(),
    (mov.comprobante || '').toString().trim(),
    mesRec,
    (mov.notas || '').toString().trim(),
    new Date().toISOString(),
  ];
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: [{ range: `${HOJA_MOVS}!A1:J1`, values: [HEADER_MOVS] }] },
  });
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA_MOVS}!A:J`,
    valueInputOption: 'RAW', requestBody: { values: [fila] },
  });
  cache.del(CACHE_KEY);
  return { id: fila[0], fecha, tipo, balde, monto };
}

async function borrarMovimiento(id) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  const movs = await _leerMovimientos(api);
  const m = movs.find(x => x.id === id);
  if (!m) throw new Error('Movimiento no encontrado');
  await _borrarFila(api, HOJA_MOVS, m.rowIndex);
  cache.del(CACHE_KEY);
}

async function _borrarFila(api, hoja, rowIndex) {
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === hoja);
  if (!sheet) throw new Error(`No existe la hoja ${hoja}`);
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: 'ROWS',
      startIndex: rowIndex - 1, endIndex: rowIndex,
    } } }] },
  });
}

function clearCache() { cache.del(CACHE_KEY); }

module.exports = {
  resumenFinanzas, calcularProyeccion, conciliar, calcularIntereses,
  guardarConfig, guardarAporte, guardarMovimiento, borrarMovimiento,
  clearCache, DEFAULT_CONFIG, BALDES, BALDE_MP, BALDES_LEGACY, TIPOS,
  HOJA_CONFIG, HOJA_APORTES, HOJA_MOVS,
};
