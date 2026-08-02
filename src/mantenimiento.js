// ─── Mantenimiento — la libreta de lo que hay que arreglar ──────────────────────
//
// Durante el servicio aparecen cosas para arreglar: se quemó una lámpara, gotea
// un baño, la heladera hace ruido. Hasta ahora eso se decía de palabra y se
// perdía. Este módulo es una libreta: se anota en dos segundos (desde la app o
// mandándole un mensaje al bot de Telegram) y después se ordena tranquilo por
// semana y por prioridad.
//
// IMPORTANTE — esto NO toca la contabilidad del bar, igual que Propinas:
//   * No escribe una sola fila en Movimientos.
//   * No lee ni modifica la hoja Cajas.
//   * No se conecta con Plan de Inversiones.
// Anotar "hay que cambiar el extractor" no es haber gastado la plata. Si un
// arreglo termina siendo una inversión de verdad, se carga a mano en Plan; que
// dos listas describan el mismo gasto es cómo se termina contando dos veces.
//
// Persistencia (sin base de datos, como todo el resto): una hoja en la planilla
// maestra SPREADSHEET_ID, creada automáticamente al primer uso.
//
//   Hoja "Mantenimiento" — una fila por cosa a arreglar:
//     A ID | B Fecha | C Semana | D Titulo | E Sector | F Prioridad | G Estado |
//     H ReportadoPor | I Origen | J Notas | K Resuelto | L Actualizado
//
// La columna Semana se guarda escrita (no se recalcula al leer) para que la hoja
// se entienda sola abierta en Google Sheets, sin la app en el medio.
//
// Cache: 5 min en memoria. Se invalida tras cada write.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 300 });
const CACHE_KEY = 'mantenimiento';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.MANTENIMIENTO_SHEET || 'Mantenimiento';
const TZ = 'America/Argentina/Buenos_Aires';

const HEADER = ['ID', 'Fecha', 'Semana', 'Titulo', 'Sector', 'Prioridad', 'Estado', 'ReportadoPor', 'Origen', 'Notas', 'Resuelto', 'Actualizado'];

// Los sectores del local. Es una lista corta a propósito: elegir entre veinte
// opciones en medio del servicio es exactamente lo que hace que no se anote.
const SECTORES = ['Salón', 'Baño', 'Cocina', 'Barra', 'Depósito', 'Exterior', 'Equipamiento', 'Otros'];
const SECTOR_DEFAULT = 'Otros';

// Tres prioridades, no cuatro. Con más, nadie las distingue y todo termina en
// "alta". El orden del array es el orden en que se muestran y se ordenan.
const PRIORIDADES = ['urgente', 'normal', 'baja'];
const PRIORIDAD_DEFAULT = 'normal';

const ESTADOS = ['pendiente', 'en curso', 'resuelto'];
const ESTADO_DEFAULT = 'pendiente';

// Un título vacío deja una fila que no dice nada; uno larguísimo rompe la vista
// y en general es una nota, no un título.
const TITULO_MAX = 140;
const NOTAS_MAX = 1000;

// ═══════════════════════════════════════════════════════════════════════════
// Fechas y semanas — funciones puras, sin I/O.
// ═══════════════════════════════════════════════════════════════════════════

function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// Una fecha 'YYYY-MM-DD' se parsea a mediodía UTC para que ningún corrimiento de
// zona horaria la tire al día anterior y la mande a la semana equivocada.
function _aDate(fecha) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

/**
 * La semana ISO (lunes a domingo) a la que pertenece una fecha.
 *
 * Se usa la semana ISO y no "los últimos 7 días" porque la semana del bar es
 * exactamente esa — es la misma que ya se usa para repartir las propinas ("28/7
 * al 3/8"), así que las dos pantallas hablan de la misma semana.
 *
 * @returns {{ id: string, label: string, desde: string, hasta: string }}
 *   id: 'YYYY-Www' — ordenable alfabéticamente, que es como se agrupa después.
 */
function semanaDe(fecha) {
  const d = _aDate(fecha);
  if (!d) return { id: '', label: 'Sin fecha', desde: '', hasta: '' };

  // Lunes de esa semana (getUTCDay: 0=domingo → se trata como 7).
  const dow = d.getUTCDay() || 7;
  const lunes = new Date(d);
  lunes.setUTCDate(d.getUTCDate() - (dow - 1));
  const domingo = new Date(lunes);
  domingo.setUTCDate(lunes.getUTCDate() + 6);

  // Número de semana ISO: el jueves de la semana define a qué año pertenece.
  const jueves = new Date(lunes);
  jueves.setUTCDate(lunes.getUTCDate() + 3);
  const eneUno = new Date(Date.UTC(jueves.getUTCFullYear(), 0, 1, 12));
  const nro = Math.floor((jueves - eneUno) / 86400000 / 7) + 1;

  const iso = x => x.toISOString().slice(0, 10);
  const corto = x => `${x.getUTCDate()}/${x.getUTCMonth() + 1}`;
  return {
    id: `${jueves.getUTCFullYear()}-W${String(nro).padStart(2, '0')}`,
    label: `${corto(lunes)} al ${corto(domingo)}`,
    desde: iso(lunes),
    hasta: iso(domingo),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalización de lo que entra
// ═══════════════════════════════════════════════════════════════════════════

function _txt(v) { return (v == null ? '' : v).toString().trim(); }

function _deLista(valor, lista, porDefecto) {
  const s = _txt(valor).toLowerCase();
  return lista.find(x => x.toLowerCase() === s) || porDefecto;
}

function normalizarSector(v) { return _deLista(v, SECTORES, SECTOR_DEFAULT); }
function normalizarPrioridad(v) { return _deLista(v, PRIORIDADES, PRIORIDAD_DEFAULT); }
function normalizarEstado(v) { return _deLista(v, ESTADOS, ESTADO_DEFAULT); }

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

async function _ensureHoja(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOJA } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A1:L1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

async function _leer(api) {
  let rows;
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:L` });
    rows = res.data.values || [];
  } catch (e) {
    await _ensureHoja(api);
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !_txt(r[0])) continue;
    const fecha = _txt(r[1]);
    // La semana se recalcula si la fila no la trae: pasa con filas cargadas a
    // mano en la planilla, y agruparlas bajo "Sin fecha" sería esconderlas.
    const semanaId = _txt(r[2]) || semanaDe(fecha).id;
    out.push({
      id: _txt(r[0]),
      fecha,
      semana: semanaId,
      semanaLabel: semanaDe(fecha).label,
      titulo: _txt(r[3]),
      sector: normalizarSector(r[4]),
      prioridad: normalizarPrioridad(r[5]),
      estado: normalizarEstado(r[6]),
      reportadoPor: _txt(r[7]),
      origen: _txt(r[8]) || 'app',
      notas: _txt(r[9]),
      resuelto: _txt(r[10]),
      actualizado: _txt(r[11]),
      rowIndex: i + 1,
    });
  }
  return out;
}

// Orden de la lista: primero lo que sigue abierto, después por prioridad, y
// dentro de todo eso lo más nuevo arriba.
function _ordenar(items) {
  const pesoEstado = e => (e === 'resuelto' ? 1 : 0);
  const pesoPrio = p => PRIORIDADES.indexOf(p);
  return items.slice().sort((a, b) =>
    (pesoEstado(a.estado) - pesoEstado(b.estado))
    || (pesoPrio(a.prioridad) - pesoPrio(b.prioridad))
    || (b.fecha || '').localeCompare(a.fecha || '')
    || (b.id || '').localeCompare(a.id || '')
  );
}

async function _load() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;
  if (!SPREADSHEET_ID) return [];
  const items = await _leer(_sheets());
  cache.set(CACHE_KEY, items);
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// API pública
// ═══════════════════════════════════════════════════════════════════════════

async function listMantenimiento() {
  const items = await _load();
  const abiertos = items.filter(i => i.estado !== 'resuelto');
  const semanaActual = semanaDe(hoyAR());
  return {
    items: _ordenar(items).map(({ rowIndex, ...rest }) => rest),
    resumen: {
      pendientes: abiertos.length,
      urgentes: abiertos.filter(i => i.prioridad === 'urgente').length,
      enCurso: items.filter(i => i.estado === 'en curso').length,
      resueltosSemana: items.filter(i => i.estado === 'resuelto' && semanaDe(i.resuelto || i.fecha).id === semanaActual.id).length,
    },
    semanaActual,
    sectores: SECTORES,
    prioridades: PRIORIDADES,
    estados: ESTADOS,
  };
}

// Sólo lo abierto, más urgente primero. Es lo que contesta el bot cuando le
// preguntan qué falta arreglar.
async function pendientes() {
  const items = await _load();
  return _ordenar(items.filter(i => i.estado !== 'resuelto')).map(({ rowIndex, ...rest }) => rest);
}

async function crearItem(datos) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const titulo = _txt(datos && datos.titulo).slice(0, TITULO_MAX);
  if (!titulo) throw new Error('Escribí qué hay que arreglar');

  const api = _sheets();
  await _ensureHoja(api);

  const fecha = _txt(datos.fecha) || hoyAR();
  const item = {
    id: `m${Date.now()}`,
    fecha,
    semana: semanaDe(fecha).id,
    titulo,
    sector: normalizarSector(datos.sector),
    prioridad: normalizarPrioridad(datos.prioridad),
    estado: normalizarEstado(datos.estado),
    reportadoPor: _txt(datos.reportadoPor),
    origen: _txt(datos.origen) || 'app',
    notas: _txt(datos.notas).slice(0, NOTAS_MAX),
    resuelto: '',
    actualizado: new Date().toISOString(),
  };

  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA}!A:L`,
    valueInputOption: 'RAW',
    requestBody: { values: [_aFila(item)] },
  });
  cache.del(CACHE_KEY);
  return { ...item, semanaLabel: semanaDe(fecha).label };
}

function _aFila(i) {
  return [i.id, i.fecha, i.semana, i.titulo, i.sector, i.prioridad, i.estado,
          i.reportadoPor, i.origen, i.notas, i.resuelto, i.actualizado];
}

/**
 * Edita un item. Sólo se tocan los campos que vienen en `cambios`: mandar
 * `{ estado: 'resuelto' }` no debe borrar las notas ni el sector.
 *
 * @param {string[]} [camposPermitidos] si viene, se ignora todo campo fuera de
 *   la lista. Así el encargado puede marcar algo como resuelto sin poder
 *   reescribir el título o la prioridad de lo que anotó otro.
 */
async function actualizarItem(id, cambios, camposPermitidos) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const buscado = _txt(id);
  if (!buscado) throw new Error('Falta el id');

  const api = _sheets();
  const items = await _leer(api);
  const actual = items.find(i => i.id === buscado);
  if (!actual) throw new Error('No se encontró ese arreglo');

  const permitido = c => !camposPermitidos || camposPermitidos.includes(c);
  const tiene = c => cambios && Object.prototype.hasOwnProperty.call(cambios, c) && permitido(c);

  const actualizado = { ...actual };
  if (tiene('titulo')) {
    const t = _txt(cambios.titulo).slice(0, TITULO_MAX);
    if (!t) throw new Error('El título no puede quedar vacío');
    actualizado.titulo = t;
  }
  if (tiene('sector')) actualizado.sector = normalizarSector(cambios.sector);
  if (tiene('prioridad')) actualizado.prioridad = normalizarPrioridad(cambios.prioridad);
  if (tiene('notas')) actualizado.notas = _txt(cambios.notas).slice(0, NOTAS_MAX);
  if (tiene('estado')) {
    actualizado.estado = normalizarEstado(cambios.estado);
    // La fecha de resolución la pone el módulo, no quien manda el request: es el
    // dato que después dice en qué semana se arregló.
    actualizado.resuelto = actualizado.estado === 'resuelto' ? (actual.resuelto || hoyAR()) : '';
  }
  actualizado.actualizado = new Date().toISOString();

  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${HOJA}!A${actual.rowIndex}:L${actual.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [_aFila(actualizado)] },
  });
  cache.del(CACHE_KEY);
  const { rowIndex, ...rest } = actualizado;
  return rest;
}

async function deleteItem(id) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const api = _sheets();
  const items = await _leer(api);
  const item = items.find(i => i.id === _txt(id));
  if (!item) throw new Error('No se encontró ese arreglo');

  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === HOJA);
  if (!sheet) throw new Error(`No existe la hoja "${HOJA}"`);
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: {
      sheetId: sheet.properties.sheetId, dimension: 'ROWS',
      startIndex: item.rowIndex - 1, endIndex: item.rowIndex,
    } } }] },
  });
  cache.del(CACHE_KEY);
}

function clearCache() { cache.del(CACHE_KEY); }

module.exports = {
  listMantenimiento, pendientes, crearItem, actualizarItem, deleteItem,
  semanaDe, hoyAR, normalizarSector, normalizarPrioridad, normalizarEstado,
  clearCache,
  SECTORES, PRIORIDADES, ESTADOS, HOJA,
};
