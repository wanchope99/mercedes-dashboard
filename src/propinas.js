// ─── Propinas — reparto semanal de las propinas digitales ───────────────────────
//
// Todas las semanas se reparten las propinas cobradas. Las de efectivo se
// entregan en mano en la barra y NO pasan por acá. Las digitales caen en dos
// cuentas — Brubank y Galicia — y hay que transferirle a cada persona su parte.
//
// El problema real no es la división (es en partes iguales), es la LOGÍSTICA:
// la plata está partida en dos cuentas, así que la parte de alguien puede no
// entrar entera en una sola y hay que armarla con dos transferencias. Este
// módulo resuelve de qué cuenta sale cada transferencia minimizando la cantidad
// de pagos partidos, y respetando que ciertas personas cobran preferentemente de
// una cuenta determinada (ver `prefiere`).
//
// IMPORTANTE — esto NO toca la contabilidad del bar:
//   * No escribe una sola fila en Movimientos.
//   * No lee ni modifica la hoja Cajas.
// La propina es plata de terceros que está de paso. Mezclarla con el ledger
// movería el balance del bar por plata que no es suya. Consecuencia conocida y
// aceptada: mientras haya propina sin repartir en la cuenta Galicia, el saldo
// real del banco va a estar por encima del "Saldo Calculado" de la hoja Cajas,
// justo por esa plata. Brubank directamente no existe como caja en el ledger.
//
// Persistencia (sin base de datos, como todo el resto): tres hojas en la
// planilla maestra SPREADSHEET_ID, creadas automáticamente al primer uso.
//
//   Hoja "Propinas Personas" — el equipo, una fila por persona:
//     A Nombre | B Prefiere (Galicia|Brubank|vacío) | C Activo (TRUE/FALSE) |
//     D Actualizado
//
//   Hoja "Propinas Repartos" — la cabecera de cada reparto:
//     A ID | B Fecha | C Periodo | D SaldoGalicia | E SaldoBrubank | F Total |
//     G Personas | H PorPersona | I Redondeo | J Sobrante | K Notas | L Creado
//
//   Hoja "Propinas Detalle" — a quién le tocó qué, una fila por persona:
//     A RepartoID | B Orden | C Persona | D Total | E Galicia | F Brubank |
//     G Prefiere
//
// El sobrante es lo que queda sin repartir por el redondeo (ver calcularReparto):
// no se le asigna a nadie, queda en la cuenta para la semana siguiente.
//
// Cache: 5 min en memoria. Se invalida tras cada write.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 300 });
const CACHE_KEY = 'propinas';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA_PERSONAS = process.env.PROPINAS_PERSONAS_SHEET || 'Propinas Personas';
const HOJA_REPARTOS = process.env.PROPINAS_REPARTOS_SHEET || 'Propinas Repartos';
const HOJA_DETALLE = process.env.PROPINAS_DETALLE_SHEET || 'Propinas Detalle';

const HEADER_PERSONAS = ['Nombre', 'Prefiere', 'Activo', 'Actualizado'];
const HEADER_REPARTOS = ['ID', 'Fecha', 'Periodo', 'SaldoGalicia', 'SaldoBrubank', 'Total', 'Personas', 'PorPersona', 'Redondeo', 'Sobrante', 'Notas', 'Creado'];
const HEADER_DETALLE = ['RepartoID', 'Orden', 'Persona', 'Total', 'Galicia', 'Brubank', 'Prefiere'];

// Las dos cuentas donde caen las propinas digitales. El orden importa: es el
// orden en que se vacían (ver calcularReparto).
const CUENTAS = ['Galicia', 'Brubank'];

// Unidad de redondeo por defecto para la parte de cada persona: $100. Ver
// calcularReparto para por qué se redondea para abajo y no para el más cercano.
const REDONDEO_DEFAULT = 100;
const REDONDEOS_VALIDOS = [1, 100, 1000];

// El equipo que cobra propina siempre es el mismo, así que la hoja arranca ya
// cargada y no hay que dar de alta a nadie a mano. Se escribe UNA sola vez,
// cuando la hoja se crea: si después se saca a alguien, no vuelve a aparecer.
const PERSONAS_DEFAULT = [
  { nombre: 'Ezequiel', prefiere: '' },
  { nombre: 'Juan', prefiere: '' },
  { nombre: 'Griselda', prefiere: '' },
  { nombre: 'Charly', prefiere: '' },
  { nombre: 'Pablo', prefiere: 'Galicia' },
  { nombre: 'Lucas', prefiere: '' },
];

// ═══════════════════════════════════════════════════════════════════════════
// El cálculo — función pura, sin I/O. Es la parte que se testea sola.
// ═══════════════════════════════════════════════════════════════════════════

// Todo el cálculo se hace en centavos enteros. Los saldos los tipea una persona
// y pueden traer decimales; sumar y dividir eso en punto flotante arrastra
// errores de centavos que después no cierran contra el banco.
function _aCentavos(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function _aPesos(centavos) { return Math.round(centavos) / 100; }

function _normalizarPreferencia(v) {
  const s = (v == null ? '' : String(v)).trim().toLowerCase();
  if (!s) return '';
  const match = CUENTAS.find(c => c.toLowerCase() === s);
  return match || '';
}

/**
 * Reparte el total de las dos cuentas en partes iguales y arma el plan de
 * transferencias.
 *
 * @param {object} args
 * @param {number} args.saldoGalicia  plata disponible en Galicia (ARS)
 * @param {number} args.saldoBrubank  plata disponible en Brubank (ARS)
 * @param {Array}  args.personas      [{ nombre, prefiere }] — prefiere: 'Galicia' | 'Brubank' | ''
 * @param {number} [args.redondeo]    unidad de redondeo de la parte de cada uno (1, 100 o 1000)
 *
 * Cómo decide de qué cuenta sale cada transferencia:
 *
 * Como todas las partes son IGUALES, el problema se vuelve simple: se ordena a
 * la gente y se paga de Galicia hasta agotarla, después de Brubank. Con ese
 * barrido hay como mucho UNA persona partida — la que queda justo en el borde
 * entre las dos cuentas — y ese es el mínimo posible: si ninguna cuenta es
 * múltiplo exacto de la parte individual, alguien tiene que quedar partido sí o sí.
 *
 * El orden del barrido es lo que hace que se respeten las preferencias:
 *   1º los que prefieren Galicia  → se llevan el principio, que es Galicia
 *   2º los que no tienen preferencia
 *   3º los que prefieren Brubank  → se llevan el final, que es Brubank
 * Dentro de cada grupo se respeta el orden en que vienen las personas, así que
 * si Galicia no alcanza para todos los que la prefieren, el que queda partido
 * es el último de esa lista, no uno al azar.
 *
 * El redondeo es SIEMPRE para abajo, nunca al más cercano: redondear para
 * arriba haría que la suma de las partes supere la plata que hay en las cuentas
 * y la última transferencia rebotaría. Lo que sobra queda en la cuenta y se
 * informa como `sobrante` — no se le regala a nadie ni se reparte en centavos.
 */
function calcularReparto({ saldoGalicia, saldoBrubank, personas, redondeo }) {
  const unidad = REDONDEOS_VALIDOS.includes(Number(redondeo)) ? Number(redondeo) : REDONDEO_DEFAULT;

  const gCent = _aCentavos(saldoGalicia);
  const bCent = _aCentavos(saldoBrubank);
  if (gCent < 0 || bCent < 0) throw new Error('Los saldos no pueden ser negativos');

  const lista = (Array.isArray(personas) ? personas : [])
    .map(p => ({
      nombre: (typeof p === 'string' ? p : (p && p.nombre) || '').toString().trim(),
      prefiere: _normalizarPreferencia(p && p.prefiere),
    }))
    .filter(p => p.nombre);
  if (!lista.length) throw new Error('No hay personas para repartir');

  const nombresVistos = new Set();
  for (const p of lista) {
    const clave = p.nombre.toLowerCase();
    if (nombresVistos.has(clave)) throw new Error(`"${p.nombre}" está repetido en la lista`);
    nombresVistos.add(clave);
  }

  const totalCent = gCent + bCent;
  if (totalCent <= 0) throw new Error('No hay plata para repartir: los dos saldos están en cero');

  const unidadCent = unidad * 100;
  const porPersonaCent = Math.floor(totalCent / lista.length / unidadCent) * unidadCent;
  if (porPersonaCent <= 0) {
    throw new Error(
      `No alcanza para darle al menos $${unidad.toLocaleString('es-AR')} a cada una de las ` +
      `${lista.length} personas. Bajá la unidad de redondeo o revisá los saldos.`
    );
  }

  const repartidoCent = porPersonaCent * lista.length;
  const sobranteCent = totalCent - repartidoCent;

  // Orden del barrido: Galicia primero, Brubank último (ver comentario de arriba).
  const peso = p => (p.prefiere === 'Galicia' ? 0 : p.prefiere === 'Brubank' ? 2 : 1);
  const orden = lista
    .map((p, i) => ({ ...p, _i: i }))
    .sort((a, b) => (peso(a) - peso(b)) || (a._i - b._i));

  // Barrido: se vacía Galicia y después Brubank.
  const pools = { Galicia: gCent, Brubank: bCent };
  const asignadas = orden.map(p => {
    const asignacion = { nombre: p.nombre, prefiere: p.prefiere, _orden: p._i, Galicia: 0, Brubank: 0 };
    let falta = porPersonaCent;
    for (const cuenta of CUENTAS) {
      if (falta <= 0) break;
      const toma = Math.min(pools[cuenta], falta);
      if (toma > 0) { asignacion[cuenta] += toma; pools[cuenta] -= toma; falta -= toma; }
    }
    // Con repartido <= total esto no puede pasar; si pasa, es un bug de este
    // módulo y es preferible reventar acá que emitir un plan que no cierra.
    if (falta !== 0) throw new Error('Error interno repartiendo: no se pudo cubrir la parte de ' + p.nombre);
    return asignacion;
  });

  // Se devuelve en el orden en que vino la gente, no en el del barrido.
  const detalle = asignadas
    .slice()
    .sort((a, b) => a._orden - b._orden)
    .map(a => ({
      nombre: a.nombre,
      prefiere: a.prefiere,
      total: _aPesos(porPersonaCent),
      galicia: _aPesos(a.Galicia),
      brubank: _aPesos(a.Brubank),
      partido: a.Galicia > 0 && a.Brubank > 0,
    }));

  // Plan de transferencias agrupado por cuenta: es así como se ejecuta después,
  // sentado en el homebanking de una cuenta a la vez.
  const porCuenta = CUENTAS.map(cuenta => {
    const transferencias = asignadas
      .filter(a => a[cuenta] > 0)
      .map(a => ({ nombre: a.nombre, monto: _aPesos(a[cuenta]), parcial: a.Galicia > 0 && a.Brubank > 0 }));
    const usado = transferencias.reduce((s, t) => s + t.monto, 0);
    return {
      cuenta,
      saldoInicial: _aPesos(cuenta === 'Galicia' ? gCent : bCent),
      usado: Math.round(usado * 100) / 100,
      restante: _aPesos(pools[cuenta]),
      transferencias,
    };
  });

  // ─── Avisos ────────────────────────────────────────────────────────────────
  const avisos = [];

  const partidos = detalle.filter(d => d.partido);
  for (const p of partidos) {
    avisos.push({
      tipo: 'partido',
      mensaje: `${p.nombre} cobra con DOS transferencias: $${p.galicia.toLocaleString('es-AR')} de Galicia + $${p.brubank.toLocaleString('es-AR')} de Brubank.`,
    });
  }

  // Sólo se avisa cuando la persona no recibió NADA de la cuenta que prefiere.
  // Si cobró todo lo que había ahí y el resto de la otra, ya se dijo arriba con
  // el aviso de "partido"; repetirlo sería el mismo problema contado dos veces.
  const preferenciaRota = detalle.filter(d =>
    (d.prefiere === 'Galicia' && d.galicia === 0) || (d.prefiere === 'Brubank' && d.brubank === 0)
  );
  for (const p of preferenciaRota) {
    const otra = p.prefiere === 'Galicia' ? 'Brubank' : 'Galicia';
    avisos.push({
      tipo: 'preferencia',
      mensaje: `${p.nombre} prefiere cobrar de ${p.prefiere}, pero no quedó nada ahí: cobra todo de ${otra}.`,
    });
  }

  if (sobranteCent > 0) {
    const dondeQueda = porCuenta.filter(c => c.restante > 0).map(c => c.cuenta).join(' y ') || '—';
    avisos.push({
      tipo: 'sobrante',
      mensaje: `Sobran $${_aPesos(sobranteCent).toLocaleString('es-AR')} por el redondeo a $${unidad.toLocaleString('es-AR')}. Quedan en ${dondeQueda} para la próxima semana.`,
    });
  }

  const resultado = {
    saldoGalicia: _aPesos(gCent),
    saldoBrubank: _aPesos(bCent),
    total: _aPesos(totalCent),
    cantidadPersonas: lista.length,
    porPersona: _aPesos(porPersonaCent),
    redondeo: unidad,
    repartido: _aPesos(repartidoCent),
    sobrante: _aPesos(sobranteCent),
    personas: detalle,
    porCuenta,
    avisos,
  };

  _verificar(resultado, { gCent, bCent, porPersonaCent, repartidoCent });
  return resultado;
}

// Chequeo de integridad del plan antes de devolverlo. Un plan que no cierra
// termina en transferencias reales mal hechas, así que se prefiere el error.
function _verificar(r, { gCent, bCent, porPersonaCent, repartidoCent }) {
  for (const p of r.personas) {
    if (_aCentavos(p.galicia) + _aCentavos(p.brubank) !== porPersonaCent) {
      throw new Error(`Error interno: las transferencias de ${p.nombre} no suman su parte`);
    }
  }
  const usadoGalicia = r.personas.reduce((s, p) => s + _aCentavos(p.galicia), 0);
  const usadoBrubank = r.personas.reduce((s, p) => s + _aCentavos(p.brubank), 0);
  if (usadoGalicia + usadoBrubank !== repartidoCent) {
    throw new Error('Error interno: el total transferido no coincide con lo repartido');
  }
  if (usadoGalicia > gCent) throw new Error('Error interno: se asignó más plata de la que hay en Galicia');
  if (usadoBrubank > bCent) throw new Error('Error interno: se asignó más plata de la que hay en Brubank');
}

// ═══════════════════════════════════════════════════════════════════════════
// Persistencia
// ═══════════════════════════════════════════════════════════════════════════

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

// Devuelve true sólo si tuvo que CREAR la hoja (false si ya existía). Eso es lo
// que distingue "primer uso" de "el usuario vació la hoja a propósito".
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
    return true;
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
    return false;
  }
}

// Carga el equipo por defecto en una hoja recién creada.
async function _sembrarPersonas(api) {
  const ahora = new Date().toISOString();
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA_PERSONAS}!A:D`,
    valueInputOption: 'RAW',
    requestBody: { values: PERSONAS_DEFAULT.map(p => [p.nombre, p.prefiere, 'TRUE', ahora]) },
  });
  return PERSONAS_DEFAULT.map((p, i) => ({ ...p, activo: true, rowIndex: i + 2 }));
}

function _num(v) { return Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0; }
function _txt(v) { return (v == null ? '' : v).toString().trim(); }

async function _leerHoja(api, hoja, rango, header, rangoHeader) {
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${hoja}!${rango}` });
    return res.data.values || [];
  } catch (e) {
    await _ensureHoja(api, hoja, header, rangoHeader);
    return [];
  }
}

async function _leerPersonas(api) {
  let rows;
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA_PERSONAS}!A:D` });
    rows = res.data.values || [];
  } catch (e) {
    // No existe la hoja: es el primer uso, se crea y se siembra el equipo.
    const creada = await _ensureHoja(api, HOJA_PERSONAS, HEADER_PERSONAS, 'A1:D1');
    return creada ? await _sembrarPersonas(api) : [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !_txt(r[0])) continue;
    out.push({
      nombre: _txt(r[0]),
      prefiere: _normalizarPreferencia(r[1]),
      // Sin valor escrito se asume activo: una fila cargada a mano en la planilla
      // sin completar la columna C debería aparecer en el reparto, no faltar.
      activo: _txt(r[2]) === '' ? true : _txt(r[2]).toUpperCase() === 'TRUE',
      rowIndex: i + 1,
    });
  }
  return out;
}

async function _leerRepartos(api) {
  const [cab, det] = await Promise.all([
    _leerHoja(api, HOJA_REPARTOS, 'A:L', HEADER_REPARTOS, 'A1:L1'),
    _leerHoja(api, HOJA_DETALLE, 'A:G', HEADER_DETALLE, 'A1:G1'),
  ]);

  const detallePorId = {};
  for (let i = 1; i < det.length; i++) {
    const r = det[i];
    if (!r || !_txt(r[0])) continue;
    const id = _txt(r[0]);
    (detallePorId[id] = detallePorId[id] || []).push({
      orden: Math.round(_num(r[1])),
      nombre: _txt(r[2]),
      total: _num(r[3]),
      galicia: _num(r[4]),
      brubank: _num(r[5]),
      prefiere: _normalizarPreferencia(r[6]),
      partido: _num(r[4]) > 0 && _num(r[5]) > 0,
      rowIndex: i + 1,
    });
  }

  const repartos = [];
  for (let i = 1; i < cab.length; i++) {
    const r = cab[i];
    if (!r || !_txt(r[0])) continue;
    const id = _txt(r[0]);
    repartos.push({
      id,
      fecha: _txt(r[1]),
      periodo: _txt(r[2]),
      saldoGalicia: _num(r[3]),
      saldoBrubank: _num(r[4]),
      total: _num(r[5]),
      cantidadPersonas: Math.round(_num(r[6])),
      porPersona: _num(r[7]),
      redondeo: Math.round(_num(r[8])) || REDONDEO_DEFAULT,
      sobrante: _num(r[9]),
      notas: _txt(r[10]),
      creado: _txt(r[11]),
      personas: (detallePorId[id] || [])
        .slice()
        .sort((a, b) => a.orden - b.orden)
        .map(({ rowIndex, ...rest }) => rest),
      rowIndex: i + 1,
    });
  }
  // Más nuevo primero.
  repartos.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.creado || '').localeCompare(a.creado || ''));
  return repartos;
}

async function _load() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return { personas: [], repartos: [] };
  const api = _sheets();
  const [personas, repartos] = await Promise.all([_leerPersonas(api), _leerRepartos(api)]);
  const data = { personas, repartos };
  cache.set(CACHE_KEY, data);
  return data;
}

// API pública de lectura: el equipo + el historial de repartos.
async function listPropinas() {
  const { personas, repartos } = await _load();
  return {
    personas: personas.map(({ rowIndex, ...rest }) => rest),
    repartos: repartos.map(({ rowIndex, ...rest }) => rest),
    cuentas: CUENTAS,
    redondeosValidos: REDONDEOS_VALIDOS,
    redondeoDefault: REDONDEO_DEFAULT,
  };
}

// ─── Equipo ─────────────────────────────────────────────────────────────────
async function guardarPersona(persona) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const nombre = _txt(persona && persona.nombre);
  if (!nombre) throw new Error('Falta el nombre');
  const api = _sheets();
  await _ensureHoja(api, HOJA_PERSONAS, HEADER_PERSONAS, 'A1:D1');
  const personas = await _leerPersonas(api);

  // El nombre es la identidad. Sólo es una edición si viene `nombreOriginal`:
  // buscar por el nombre nuevo haría que dar de alta a alguien que ya existe se
  // interprete como editarlo, y le pisaría la preferencia en silencio.
  const original = _txt(persona.nombreOriginal);
  const existente = original
    ? personas.find(p => p.nombre.toLowerCase() === original.toLowerCase())
    : null;
  if (original && !existente) throw new Error(`No se encontró a "${original}" en el equipo`);
  const choque = personas.find(p =>
    p.nombre.toLowerCase() === nombre.toLowerCase() && (!existente || p.rowIndex !== existente.rowIndex)
  );
  if (choque) throw new Error(`Ya hay alguien cargado como "${choque.nombre}"`);

  const guardado = {
    nombre,
    prefiere: _normalizarPreferencia(persona.prefiere),
    activo: persona.activo === undefined ? (existente ? existente.activo : true) : !!persona.activo,
  };
  const fila = [guardado.nombre, guardado.prefiere, guardado.activo ? 'TRUE' : 'FALSE', new Date().toISOString()];

  const data = [{ range: `${HOJA_PERSONAS}!A1:D1`, values: [HEADER_PERSONAS] }];
  if (existente) data.push({ range: `${HOJA_PERSONAS}!A${existente.rowIndex}:D${existente.rowIndex}`, values: [fila] });
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  if (!existente) {
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA_PERSONAS}!A:D`,
      valueInputOption: 'RAW',
      requestBody: { values: [fila] },
    });
  }
  cache.del(CACHE_KEY);
  return guardado;
}

async function deletePersona(nombre) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  const personas = await _leerPersonas(api);
  const p = personas.find(x => x.nombre.toLowerCase() === _txt(nombre).toLowerCase());
  if (!p) throw new Error('Persona no encontrada');
  await _borrarFilas(api, HOJA_PERSONAS, [p.rowIndex]);
  cache.del(CACHE_KEY);
}

// ─── Repartos ───────────────────────────────────────────────────────────────
// Guarda un reparto. Recalcula el plan acá a partir de los saldos y la gente:
// nunca guarda los montos que mandó el navegador, para que lo que queda escrito
// sea siempre lo que produce este módulo.
async function guardarReparto(datos) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const plan = calcularReparto({
    saldoGalicia: datos.saldoGalicia,
    saldoBrubank: datos.saldoBrubank,
    personas: datos.personas,
    redondeo: datos.redondeo,
  });

  const api = _sheets();
  await _ensureHoja(api, HOJA_REPARTOS, HEADER_REPARTOS, 'A1:L1');
  await _ensureHoja(api, HOJA_DETALLE, HEADER_DETALLE, 'A1:G1');

  const id = `r${Date.now()}`;
  const fecha = _txt(datos.fecha) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const creado = new Date().toISOString();

  const filaCabecera = [
    id, fecha, _txt(datos.periodo), plan.saldoGalicia, plan.saldoBrubank, plan.total,
    plan.cantidadPersonas, plan.porPersona, plan.redondeo, plan.sobrante,
    _txt(datos.notas), creado,
  ];
  const filasDetalle = plan.personas.map((p, i) => [id, i + 1, p.nombre, p.total, p.galicia, p.brubank, p.prefiere]);

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${HOJA_REPARTOS}!A1:L1`, values: [HEADER_REPARTOS] },
        { range: `${HOJA_DETALLE}!A1:G1`, values: [HEADER_DETALLE] },
      ],
    },
  });
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA_REPARTOS}!A:L`,
    valueInputOption: 'RAW',
    requestBody: { values: [filaCabecera] },
  });
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA_DETALLE}!A:G`,
    valueInputOption: 'RAW',
    requestBody: { values: filasDetalle },
  });

  cache.del(CACHE_KEY);
  return { ...plan, id, fecha, periodo: _txt(datos.periodo), notas: _txt(datos.notas), creado };
}

async function deleteReparto(id) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const buscado = _txt(id);
  if (!buscado) throw new Error('Falta el id del reparto');
  const api = _sheets();

  const [cab, det] = await Promise.all([
    _leerHoja(api, HOJA_REPARTOS, 'A:L', HEADER_REPARTOS, 'A1:L1'),
    _leerHoja(api, HOJA_DETALLE, 'A:G', HEADER_DETALLE, 'A1:G1'),
  ]);
  const filasCab = [];
  for (let i = 1; i < cab.length; i++) if (cab[i] && _txt(cab[i][0]) === buscado) filasCab.push(i + 1);
  if (!filasCab.length) throw new Error('Reparto no encontrado');
  const filasDet = [];
  for (let i = 1; i < det.length; i++) if (det[i] && _txt(det[i][0]) === buscado) filasDet.push(i + 1);

  await _borrarFilas(api, HOJA_DETALLE, filasDet);
  await _borrarFilas(api, HOJA_REPARTOS, filasCab);
  cache.del(CACHE_KEY);
}

// Borra filas por número (1-based). De abajo hacia arriba: borrar de arriba
// primero correría las de abajo y terminaría borrando la fila equivocada.
async function _borrarFilas(api, hoja, filas) {
  if (!filas || !filas.length) return;
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === hoja);
  if (!sheet) throw new Error(`No existe la hoja "${hoja}"`);
  const requests = filas
    .slice()
    .sort((a, b) => b - a)
    .map(f => ({ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: f - 1, endIndex: f,
    } } }));
  await api.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
}

function clearCache() { cache.del(CACHE_KEY); }

module.exports = {
  calcularReparto,
  listPropinas, guardarPersona, deletePersona,
  guardarReparto, deleteReparto,
  clearCache,
  CUENTAS, REDONDEOS_VALIDOS, REDONDEO_DEFAULT, PERSONAS_DEFAULT,
  HOJA_PERSONAS, HOJA_REPARTOS, HOJA_DETALLE,
};
