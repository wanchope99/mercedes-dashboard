// ─── Finanzas — escalera de recupero de inversión ───────────────────────────────
//
// La plata que cada mes se separa para RECUPERAR la inversión (col L de Cierres,
// ver roi.js) no se deja quieta: se coloca en instrumentos de bajo riesgo y en
// pesos que preserven su valor real hasta llegar a la meta (~24 meses). Como el
// dinero entra todos los meses, el modelo es una ESCALERA de plazos escalonados.
//
// Tres "baldes", cada aporte mensual se reparte entre ellos:
//   · colchón (money market)  → liquidez inmediata, rinde MENOS que la inflación
//   · UVA (plazo fijo precancelable, plazoUvaMeses) → ajusta por CER, sin riesgo
//     de precio. El aporte del mes t constituye un tramo que vence en t+plazo.
//   · CER (bonos)             → ajusta por CER + tasa real, con riesgo de precio
// CER y UVA no son ajustes distintos: la UVA se actualiza por el mismo CER. Lo
// que cambia es el envoltorio (depósito bancario vs. bono que cotiza).
//
// DOS PLANOS, deliberadamente separados:
//   1. PROYECCIÓN (calcularEscalera): simulación con parámetros configurables.
//      Todo se deriva de los aportes + parámetros, no se persiste.
//   2. REGISTRO REAL (hoja "Finanzas Movimientos"): qué se colocó de verdad,
//      cuándo, en qué instrumento y con qué comprobante. Es la pista de
//      auditoría que permite demostrar que la plata del recupero NO se mezcló
//      con la caja operativa del bar. conciliacion() compara ambos planos.
//
// Persistencia (sin base de datos, como todo el resto): tres hojas en la
// planilla maestra SPREADSHEET_ID, creadas automáticamente al primer uso.
//
//   "Finanzas Config"      A Clave | B Valor
//   "Finanzas Aportes"     A MesISO | B MontoARS | C Notas | D Actualizado
//       Sólo guarda los meses EDITADOS a mano. Si un mes no está, el aporte sale
//       del recupero real de ese cierre (roi.js). Así el default siempre sigue a
//       la realidad y lo que el usuario tocó queda explícito.
//   "Finanzas Movimientos" A ID | B Fecha | C Tipo | D Balde | E MontoARS |
//       F Instrumento | G Comprobante | H MesRecupero | I Notas | J Registrado
//
// No es asesoramiento financiero: los rendimientos son supuestos configurables y
// las condiciones reales (TNA, tasa real CER, cotización UVA) hay que
// verificarlas en el banco al momento de invertir.

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
const HEADER_MOVS = ['ID', 'Fecha', 'Tipo', 'Balde', 'MontoARS', 'Instrumento', 'Comprobante', 'MesRecupero', 'Notas', 'Registrado'];

const BALDES = ['colchon', 'uva', 'cer'];
const TIPOS = ['colocacion', 'rescate', 'renovacion', 'ajuste'];

// Defaults del spec (INDEC jun-2026 / pantalla Galicia).
const DEFAULT_CONFIG = {
  inflacionMensual: 0.019,
  pctColchon: 0.15,
  pctUva: 0.65,
  pctCer: 0.20,
  rendColchonMensual: 0.014,
  rendRealCerAnual: 0.08,
  plazoUvaMeses: 12,
  tnaPrecancelacion: 0.10,
  cotizacionUvaInicial: 2045.53,
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
// que el formato canónico es JS ("0.019", "2045.53"): se parsea estricto. La
// heurística de miles de es-AR NO sirve acá — leería "0.019" como 19, tomando
// el punto por separador de miles. Sólo se tolera la coma decimal por si el
// valor se editó a mano en la planilla.
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
// cuatro. No usar para config (ver _numCfg).
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
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const clave = r[0].toString().trim();
    const valor = (r[1] == null ? '' : r[1]).toString().trim();
    if (clave === 'mesInicio') cfg.mesInicio = /^\d{4}-\d{2}$/.test(valor) ? valor : '';
    else if (CLAVES_NUM.includes(clave)) cfg[clave] = _numCfg(valor);
  }
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
    out.push({
      id: r[0].toString().trim(),
      fecha: (r[1] || '').toString().trim(),          // "YYYY-MM-DD"
      tipo: (r[2] || 'colocacion').toString().trim(),
      balde: (r[3] || '').toString().trim(),
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

// ─── Cálculo de la escalera (puro; §5 del spec) ─────────────────────────────
// aportes: [{ mes: "YYYY-MM", monto, origen }] ordenado, uno por mes del horizonte.
// El aporte del mes t empieza a rendir el mes SIGUIENTE (base t=0 = 0).
function calcularEscalera(config, aportes) {
  const p = { ...DEFAULT_CONFIG, ...(config || {}) };
  const infl = Number(p.inflacionMensual) || 0;
  const rendCer = Math.pow(1 + (Number(p.rendRealCerAnual) || 0), 1 / 12) - 1;
  const plazo = Math.max(1, Math.round(Number(p.plazoUvaMeses) || 12));
  const N = aportes.length;

  const filas = [];
  const tramos = [];
  let sColchon = 0, sUva = 0, sCer = 0, aportadoAcum = 0, aportadoReal = 0;

  for (let i = 0; i < N; i++) {
    const t = i + 1;
    const aporte = Number(aportes[i].monto) || 0;
    const aColchon = aporte * p.pctColchon;
    const aUva = aporte * p.pctUva;
    const aCer = aporte * p.pctCer;

    sColchon = sColchon * (1 + (Number(p.rendColchonMensual) || 0)) + aColchon;
    sUva = sUva * (1 + infl) + aUva;
    sCer = sCer * (1 + infl) * (1 + rendCer) + aCer;

    const indicePrecios = Math.pow(1 + infl, t - 1);
    const totalNominal = sColchon + sUva + sCer;
    aportadoAcum += aporte;
    aportadoReal += aporte / indicePrecios;
    const totalReal = totalNominal / indicePrecios;

    filas.push({
      mes: t,
      mesISO: aportes[i].mes,
      origen: aportes[i].origen || 'sin datos',
      aporte,
      aColchon, aUva, aCer,
      saldoColchon: sColchon, saldoUva: sUva, saldoCer: sCer,
      totalNominal, aportadoAcum,
      indicePrecios, totalReal, aportadoReal,
      gananciaReal: totalReal - aportadoReal,
    });

    // Tramo UVA constituido este mes (§5). El valor al vencer es puro ajuste por
    // inflación: cantidadUvas * cotización del mes de vencimiento.
    if (aUva > 0) {
      const cotConstitucion = p.cotizacionUvaInicial * Math.pow(1 + infl, t - 1);
      const mesVencimiento = t + plazo;
      const cotVencimiento = p.cotizacionUvaInicial * Math.pow(1 + infl, mesVencimiento - 1);
      const cantidadUvas = cotConstitucion > 0 ? aUva / cotConstitucion : 0;
      tramos.push({
        mesConstitucion: t,
        mesConstitucionISO: aportes[i].mes,
        montoUva: aUva,
        cantidadUvas,
        cotizacionConstitucion: cotConstitucion,
        mesVencimiento,
        mesVencimientoISO: _sumarMeses(aportes[i].mes, plazo),
        cotizacionVencimiento: cotVencimiento,
        valorAlVencer: cantidadUvas * cotVencimiento,
        disponibleEnHorizonte: mesVencimiento <= N,
      });
    }
  }

  const ultima = filas[filas.length - 1] || null;
  return {
    filas,
    tramos,
    parametros: { ...p, rendRealCerMensual: rendCer },
    resumen: ultima ? {
      meses: N,
      totalNominal: ultima.totalNominal,
      totalReal: ultima.totalReal,
      aportadoAcum: ultima.aportadoAcum,
      aportadoReal: ultima.aportadoReal,
      gananciaReal: ultima.gananciaReal,
      pctGananciaReal: ultima.aportadoReal > 0 ? (ultima.gananciaReal / ultima.aportadoReal) * 100 : 0,
    } : null,
  };
}

// Precancelar un tramo UVA: se pierde el ajuste y se cobra la TNA de
// precancelación (§5). Sirve para mostrar el costo de romper antes de tiempo.
function valorPrecancelado(config, montoUva, dias) {
  const p = { ...DEFAULT_CONFIG, ...(config || {}) };
  return (Number(montoUva) || 0) * (1 + (Number(p.tnaPrecancelacion) || 0) * (Number(dias) || 0) / 365);
}

function _sumarMeses(iso, n) {
  if (!/^\d{4}-\d{2}$/.test(iso || '')) return '';
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Conciliación: proyección vs. plata realmente colocada ──────────────────
// El punto de todo esto: que el capital del recupero no se mezcle con la caja
// operativa. Compara lo asignado a recupero en los cierres contra lo que
// efectivamente se colocó en instrumentos según el registro.
function conciliar(movimientos, recuperoPorMes) {
  const signo = t => (t === 'rescate' ? -1 : 1);   // rescate saca plata de los instrumentos
  const porBalde = { colchon: 0, uva: 0, cer: 0 };
  let colocado = 0;
  for (const m of movimientos) {
    if (m.tipo === 'renovacion') continue;         // no mueve capital, sólo lo reubica
    const v = signo(m.tipo) * (m.monto || 0);
    colocado += v;
    if (porBalde[m.balde] !== undefined) porBalde[m.balde] += v;
  }
  const asignado = (recuperoPorMes || []).reduce((s, m) => s + (m.recuperoARS || 0), 0);
  return {
    asignadoARS: Math.round(asignado),
    colocadoARS: Math.round(colocado),
    sinColocarARS: Math.round(asignado - colocado),
    porBalde: {
      colchon: Math.round(porBalde.colchon),
      uva: Math.round(porBalde.uva),
      cer: Math.round(porBalde.cer),
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

  const escalera = calcularEscalera(config, serie);
  return {
    config,
    mesInicio: inicio,
    aportes: serie,
    movimientos: movimientos.map(({ rowIndex, ...m }) => m),
    escalera,
    conciliacion: conciliar(movimientos, recuperoPorMes),
    pctValido: Math.abs((config.pctColchon + config.pctUva + config.pctCer) - 1) < 1e-9,
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
  const balde = (mov.balde || '').toString().trim();
  const monto = Math.round(_num(mov.monto));
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo inválido (${TIPOS.join(' | ')})`);
  if (!BALDES.includes(balde)) throw new Error(`Balde inválido (${BALDES.join(' | ')})`);
  if (!(monto > 0)) throw new Error('El monto debe ser mayor a cero');
  const fecha = (mov.fecha || '').toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('Fecha inválida (se espera YYYY-MM-DD)');
  const mesRec = (mov.mesRecupero || '').toString().trim();
  if (mesRec && !/^\d{4}-\d{2}$/.test(mesRec)) throw new Error('Mes de recupero inválido (YYYY-MM)');

  const api = _sheets();
  await _ensureHoja(api, HOJA_MOVS, HEADER_MOVS, 'A1:J1');
  const fila = [
    `f${Date.now()}`, fecha, tipo, balde, monto,
    (mov.instrumento || '').toString().trim(),
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
  resumenFinanzas, calcularEscalera, valorPrecancelado, conciliar,
  guardarConfig, guardarAporte, guardarMovimiento, borrarMovimiento,
  clearCache, DEFAULT_CONFIG, BALDES, TIPOS,
  HOJA_CONFIG, HOJA_APORTES, HOJA_MOVS,
};
