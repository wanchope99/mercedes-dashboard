// ─── Finanzas — capital del recupero de la inversión ────────────────────────────
//
// La plata que cada mes se separa para RECUPERAR la inversión (col L de Cierres,
// ver roi.js) no se deja quieta en la caja operativa: se coloca en una cuenta
// aparte que rinde. Desde el 24/07/2026 la estrategia es UNA SOLA:
//
//   · 100% a MERCADO PAGO PABLO — cuenta remunerada, rinde tnaMercadoPago (17%
//     TNA al 24/07/2026), liquidez inmediata, sin plazo ni riesgo de precio.
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
const BALDES = [BALDE_MP];
const BALDES_LEGACY = ['uva', 'cer'];
const TIPOS = ['colocacion', 'rescate', 'renovacion', 'ajuste'];

// Defaults al 24/07/2026: inflación INDEC jun-2026, TNA de la cuenta remunerada
// de Mercado Pago, y los $15.000.000 que ese día se pasaron de Galicia a
// Mercado Pago Pablo para arrancar la colocación.
const DEFAULT_CONFIG = {
  inflacionMensual: 0.019,
  tnaMercadoPago: 0.17,
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
// cuatro. No usar para ratios de config (ver _numCfg).
function _num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[$\s%]/g, '');
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  if (coma !== -1 && punto !== -1) {
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma !== -1) {
    s = s.slice(coma + 1).length === 3 && s.length - coma - 1 === 3 && /^\d{1,3}(,\d{3})+$/.test(s)
      ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (punto !== -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

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
      monto: Math.round(_num(r[1])),
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
      monto: Math.round(_num(r[4])),
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
  let colocado = 0, deRecupero = 0, capitalPropio = 0;
  let enMercadoPago = 0, enLegacy = 0;
  for (const m of movimientos) {
    if (m.tipo === 'renovacion') continue;         // no mueve capital, sólo lo reubica
    const v = signo(m.tipo) * (m.monto || 0);
    colocado += v;
    if (m.mesRecupero) deRecupero += v; else capitalPropio += v;
    if (m.balde === BALDE_MP) enMercadoPago += v; else enLegacy += v;
  }
  const asignado = (recuperoPorMes || []).reduce((s, m) => s + (m.recuperoARS || 0), 0);
  return {
    asignadoARS: Math.round(asignado),
    colocadoARS: Math.round(colocado),
    deRecuperoARS: Math.round(deRecupero),
    capitalPropioARS: Math.round(capitalPropio),
    sinColocarARS: Math.round(asignado - deRecupero),
    porDestino: {
      mercadoPago: Math.round(enMercadoPago),
      legacy: Math.round(enLegacy),
    },
    movimientos: movimientos.length,
  };
}

// ─── API pública ────────────────────────────────────────────────────────────
// Arma la vista completa. `recuperoPorMes` viene de roi.js (server.js lo inyecta
// para no crear una dependencia circular finanzas ↔ roi ↔ plan).
async function resumenFinanzas(recuperoPorMes = []) {
  const { config, aportes, movimientos } = await _load();
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
  return {
    config,
    mesInicio: inicio,
    aportes: serie,
    movimientos: movimientos.map(({ rowIndex, ...m }) => m),
    proyeccion,
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
  const fila = [mesISO, Math.max(0, Math.round(_num(monto))), (notas || '').toString().trim(), new Date().toISOString()];
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
  // El destino ya no se elige: todo va a Mercado Pago Pablo. Se acepta el campo
  // por compatibilidad con clientes viejos, pero sólo si coincide.
  const balde = (mov.balde || BALDE_MP).toString().trim().toLowerCase();
  const monto = Math.round(_num(mov.monto));
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo inválido (${TIPOS.join(' | ')})`);
  if (balde !== BALDE_MP) throw new Error('El único destino vigente es Mercado Pago Pablo');
  if (!(monto > 0)) throw new Error('El monto debe ser mayor a cero');
  const fecha = (mov.fecha || '').toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('Fecha inválida (se espera YYYY-MM-DD)');
  const mesRec = (mov.mesRecupero || '').toString().trim();
  if (mesRec && !/^\d{4}-\d{2}$/.test(mesRec)) throw new Error('Mes de recupero inválido (YYYY-MM)');

  const api = _sheets();
  await _ensureHoja(api, HOJA_MOVS, HEADER_MOVS, 'A1:J1');
  const fila = [
    `f${Date.now()}`, fecha, tipo, balde, monto,
    (mov.instrumento || 'Mercado Pago Pablo').toString().trim(),
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
  resumenFinanzas, calcularProyeccion, conciliar,
  guardarConfig, guardarAporte, guardarMovimiento, borrarMovimiento,
  clearCache, DEFAULT_CONFIG, BALDES, BALDE_MP, BALDES_LEGACY, TIPOS,
  HOJA_CONFIG, HOJA_APORTES, HOJA_MOVS,
};
