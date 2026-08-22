// ─── Padrón fiscal de proveedores ─────────────────────────────────────────────
//
// Para calcular el crédito fiscal del paso a Responsable Inscripto hay que saber
// quién emite factura A y a qué alícuota. Hoy el sistema no lo sabe de nadie: no
// existe CUIT, ni condición fiscal, ni tipo de comprobante en ninguna hoja.
//
// ─── Dónde vive y por qué NO en Movimientos ───────────────────────────────────
//
// La condición fiscal es un atributo del PROVEEDOR, no del asiento — igual que
// `IVA` y `Medio de Pago`, que ya viven en la hoja `Proveedores`. Ponerlo por
// fila en `Movimientos` sería repetir el mismo dato mil veces y, además, ahí no
// hay lugar: A–P es el contrato de escritura y Q–T ya están tomadas por tipo de
// cambio y saldo. El join es `Movimientos.I (Proveedor)` → norm → `Proveedores.A`.
//
// ─── Lo que se puede sembrar solo, medido contra los datos reales ─────────────
//
// Medido el 2026-08-22 sobre los 92 renglones reales de la hoja `Compras`:
//
//     con Factura A detectada :  1 de 20 proveedores  (5%)
//     con alícuota observada  :  4 de 20              (20%)
//     con CUIT                :  1 de 20              (5%)
//     ── con algún dato útil  :  4 de 20              (20%)
//
// O sea: **16 de 20 proveedores hay que relevarlos a mano**. La siembra sirve,
// pero no alcanza ni de cerca, y por eso la cola de relevamiento va ordenada por
// PLATA DE LOS ÚLTIMOS MESES y no alfabéticamente: con 16 para cargar, el orden
// es la diferencia entre resolver el 80% del gasto en diez minutos o abandonar a
// la mitad.
//
// ─── La regla derivada ────────────────────────────────────────────────────────
//
//     ivaComputable = (Condicion Fiscal === 'RI' && Comprobante Habitual === 'A')
//
// y si `IVA Deducible` está cargada a mano, ESA gana. Ese campo ya existía en la
// hoja, se preguntaba al confirmar una factura y no se usaba en ningún cálculo:
// pasa a ser el override del contador sin crear un campo que compita con él.

const prov = require('./proveedores');
const provCfg = require('./proveedores-config');
const fiscal = require('./regimen-fiscal');

// Headers de las columnas nuevas en la hoja `Proveedores`. Los crea
// `setAtributosProveedor` la primera vez que se guarda una, en una sola
// escritura y salteando lo que no cambió.
const COL_CUIT = 'CUIT';
const COL_CONDICION = 'Condicion Fiscal';
const COL_COMPROBANTE = 'Comprobante Habitual';
const COL_ALICUOTA = 'Alicuota IVA';
const COL_FUENTE = 'Fuente Fiscal';
const COL_RELEVADO = 'Fecha Relevamiento';

const CONDICIONES = ['RI', 'Monotributo', 'Exento', 'Consumidor Final', 'Desconocido'];
const COMPROBANTES = ['A', 'B', 'C', 'Sin comprobante', 'Desconocido'];

const norm = provCfg.norm;

// ─── Lectura del padrón ───────────────────────────────────────────────────────
//
// Devuelve { [nombreNorm]: { nombre, cuit, condicion, comprobante, alicuotaIva,
//            emiteFacturaA, fuente, relevado } }
//
// `emiteFacturaA` es lo único que consume el módulo de cálculo, y sale de la
// cascada: el override manual del contador primero, la regla derivada después.
async function leerPadron() {
  const cfg = await provCfg.leerConfig();
  const filas = await _filasCrudas();
  const out = {};

  for (const [clave, p] of Object.entries(cfg.byNombre || {})) {
    const extra = filas[clave] || {};
    const condicion = extra[COL_CONDICION] || 'Desconocido';
    const comprobante = extra[COL_COMPROBANTE] || 'Desconocido';

    // La regla derivada, y el override manual por encima.
    let emiteFacturaA;
    if (p.ivaDeducible === true) emiteFacturaA = 'S';
    else if (p.ivaDeducible === false) emiteFacturaA = 'N';
    else if (condicion === 'RI' && comprobante === 'A') emiteFacturaA = 'S';
    else if (condicion !== 'Desconocido' && comprobante !== 'Desconocido') emiteFacturaA = 'N';
    else emiteFacturaA = '?';

    out[clave] = {
      nombre: p.nombre,
      cuit: extra[COL_CUIT] || null,
      condicion,
      comprobante,
      alicuotaIva: fiscal.normalizarAlicuota(extra[COL_ALICUOTA]),
      emiteFacturaA,
      // De dónde salió: 'manual' es lo que cargó una persona y nunca se pisa solo.
      fuente: extra[COL_FUENTE] || null,
      relevado: extra[COL_RELEVADO] || null,
      ivaDeducible: p.ivaDeducible,
    };
  }
  return out;
}

// Las columnas nuevas todavía no las lee `leerConfig`, así que se leen aparte
// por nombre de header. Una sola llamada, y tolera que ninguna exista todavía.
async function _filasCrudas() {
  const { google } = require('googleapis');
  const ID = process.env.SPREADSHEET_ID;
  const HOJA = process.env.PROVEEDORES_HOJA_CONFIG || 'Proveedores';
  if (!ID) return {};

  let rows = [];
  try {
    const credentials = process.env.GOOGLE_CREDENTIALS_JSON
      ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
      : require('../../credentials.json');
    const auth = new google.auth.GoogleAuth({
      credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const api = google.sheets({ version: 'v4', auth });
    const res = await api.spreadsheets.values.get({ spreadsheetId: ID, range: `${HOJA}!A:Z` });
    rows = res.data.values || [];
  } catch (e) { return {}; }

  let hIdx = rows.findIndex(r => norm(r && r[0]) === 'proveedor');
  if (hIdx === -1) hIdx = 0;
  const header = (rows[hIdx] || []).map(h => norm(h));
  const idxDe = nombre => header.findIndex(h => h === norm(nombre));

  const cols = {
    [COL_CUIT]: idxDe(COL_CUIT),
    [COL_CONDICION]: idxDe(COL_CONDICION),
    [COL_COMPROBANTE]: idxDe(COL_COMPROBANTE),
    [COL_ALICUOTA]: idxDe(COL_ALICUOTA),
    [COL_FUENTE]: idxDe(COL_FUENTE),
    [COL_RELEVADO]: idxDe(COL_RELEVADO),
  };

  const out = {};
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const e = {};
    for (const [nombre, idx] of Object.entries(cols)) {
      if (idx >= 0 && r[idx] !== undefined && r[idx] !== '') e[nombre] = String(r[idx]).trim();
    }
    out[norm(r[0])] = e;
  }
  return out;
}

// ─── Escritura ────────────────────────────────────────────────────────────────
//
// Una sola vuelta a Sheets vía setAtributosProveedor, que crea las columnas que
// falten y saltea lo que no cambió.
async function setFiscalProveedor(nombre, { cuit, condicion, comprobante, alicuotaIva } = {}) {
  if (!nombre) throw new Error('Falta el nombre del proveedor');
  if (condicion && !CONDICIONES.includes(condicion)) {
    throw new Error(`Condición fiscal inválida: ${condicion}. Válidas: ${CONDICIONES.join(', ')}`);
  }
  if (comprobante && !COMPROBANTES.includes(comprobante)) {
    throw new Error(`Comprobante inválido: ${comprobante}. Válidos: ${COMPROBANTES.join(', ')}`);
  }
  const alic = alicuotaIva === undefined || alicuotaIva === null || alicuotaIva === ''
    ? null : fiscal.normalizarAlicuota(alicuotaIva);
  if (alicuotaIva !== undefined && alicuotaIva !== null && alicuotaIva !== '' && alic === null) {
    throw new Error(`Alícuota inválida: ${alicuotaIva}. Válidas: ${fiscal.ALICUOTAS_CONOCIDAS.join(', ')}`);
  }
  // Un CUIT de 11 dígitos o nada. Uno mal cargado es peor que ninguno: da la
  // impresión de que el proveedor está relevado.
  const cuitLimpio = cuit ? String(cuit).replace(/[^0-9]/g, '') : '';
  if (cuitLimpio && cuitLimpio.length !== 11) {
    throw new Error(`CUIT inválido: ${cuit}. Tiene que tener 11 dígitos.`);
  }

  const mapa = {};
  if (cuitLimpio) mapa[COL_CUIT] = cuitLimpio;
  if (condicion) mapa[COL_CONDICION] = condicion;
  if (comprobante) mapa[COL_COMPROBANTE] = comprobante;
  if (alic !== null) mapa[COL_ALICUOTA] = String(alic);
  mapa[COL_FUENTE] = 'manual';
  mapa[COL_RELEVADO] = new Date().toISOString().slice(0, 10);

  const r = await provCfg.setAtributosProveedor(nombre, mapa);
  provCfg.clearConfigCache();
  return r;
}

// ─── Siembra automática desde lo que ya existe ────────────────────────────────
//
// Dry-run por defecto: devuelve qué cambiaría y NO escribe. Nunca pisa una fila
// cuya `Fuente Fiscal` sea 'manual' — lo que cargó una persona vale más que lo
// que dedujo el sistema de una factura vieja.
async function sembrarPadron({ aplicar = false } = {}) {
  const [compras, padron] = await Promise.all([prov.getCompras(), leerPadron()]);
  const calib = fiscal.calibrarDesdeCompras(compras);

  const propuestos = [];
  for (const [clave, obs] of Object.entries(calib)) {
    const actual = padron[clave];
    if (actual && actual.fuente === 'manual') continue;   // no se pisa lo humano

    const cambios = {};
    if (obs.cuit && (!actual || !actual.cuit)) cambios[COL_CUIT] = obs.cuit;
    if (obs.condicionFiscal && (!actual || actual.condicion === 'Desconocido')) {
      cambios[COL_CONDICION] = obs.condicionFiscal;
    }
    if (obs.emiteFacturaA === 'S' && (!actual || actual.comprobante === 'Desconocido')) {
      cambios[COL_COMPROBANTE] = 'A';
    }
    if (obs.alicuotaIva !== null && (!actual || actual.alicuotaIva === null)) {
      cambios[COL_ALICUOTA] = String(obs.alicuotaIva);
    }
    if (!Object.keys(cambios).length) continue;

    propuestos.push({
      proveedor: obs.nombre,
      cambios,
      evidencia: `${obs.renglones} renglón(es) en Compras` +
        (obs.alicuotasVistas.length ? ` · alícuotas vistas: ${obs.alicuotasVistas.join(', ')}%` : ''),
    });
  }

  let escritas = 0;
  if (aplicar) {
    for (const p of propuestos) {
      await provCfg.setAtributosProveedor(p.proveedor, { ...p.cambios, [COL_FUENTE]: 'compras' });
      escritas++;
    }
    provCfg.clearConfigCache();
  }

  return {
    aplicado: aplicar,
    proveedoresEnCompras: Object.keys(calib).length,
    propuestos,
    escritas,
  };
}

// ─── La cola de relevamiento ──────────────────────────────────────────────────
//
// Ordenada por GASTO, no por nombre. Con 16 proveedores para cargar, el orden es
// lo que decide si se resuelve el 80% del gasto en diez minutos o si se abandona
// a la mitad. Cada fila trae cuánta plata de crédito fiscal está en juego, que es
// la única razón para molestarse en cargarla.
// `sinCredito` son las categorías que no generan crédito por naturaleza. Su
// gasto NO entra en la cola: preguntar la condición fiscal de "Sueldos" o de
// "ARCA" es trabajo inventado, y como se ordena por plata caían primeras — el
// sueldo es el gasto más grande del bar, así que lo primero que veía la persona
// era la fila que nunca hay que completar.
function armarCola({ movimientos = [], padron = {}, credito = null, parametros = {} } = {}) {
  const sinCredito = new Set(parametros.categoriasSinCredito || fiscal.PARAMETROS.categoriasSinCredito);
  const porProv = {};
  for (const m of movimientos) {
    if (!m || m.tipo !== 'Gasto' || m.esCuota) continue;
    if (sinCredito.has((m.categoria || '').trim())) continue;
    const nombre = (m.proveedor || '').trim();
    const monto = Number(m.salidaTotal) || 0;
    if (monto <= 0) continue;
    if (!nombre) { porProv['__sin_proveedor__'] = porProv['__sin_proveedor__'] || { nombre: '(sin proveedor)', gasto: 0, sinNombre: true }; porProv['__sin_proveedor__'].gasto += monto; continue; }
    const clave = norm(nombre);
    if (!porProv[clave]) porProv[clave] = { nombre, gasto: 0, categorias: new Set() };
    porProv[clave].gasto += monto;
    if (m.categoria) porProv[clave].categorias.add(m.categoria);
  }

  // Cuánto crédito está sin resolver por proveedor, según el módulo de cálculo.
  const enJuego = {};
  if (credito && credito.porProveedor) {
    for (const p of credito.porProveedor) {
      enJuego[norm(p.nombre)] = Math.max(0, (p.credito.max || 0) - (p.credito.min || 0));
    }
  }

  const gastoTotal = Object.values(porProv).reduce((s, p) => s + p.gasto, 0);
  let acumulado = 0;

  return Object.entries(porProv)
    .map(([clave, p]) => {
      const pad = padron[clave];
      return {
        proveedor: p.nombre,
        gasto: Math.round(p.gasto * 100) / 100,
        pctDelGasto: gastoTotal > 0 ? Math.round(p.gasto / gastoTotal * 10000) / 100 : 0,
        categorias: p.categorias ? [...p.categorias] : [],
        sinNombre: !!p.sinNombre,
        // Estado del relevamiento
        relevado: !!(pad && pad.fuente === 'manual'),
        condicion: pad ? pad.condicion : 'Desconocido',
        comprobante: pad ? pad.comprobante : 'Desconocido',
        emiteFacturaA: pad ? pad.emiteFacturaA : '?',
        cuit: pad ? pad.cuit : null,
        creditoEnJuegoARS: Math.round((enJuego[clave] || 0) * 100) / 100,
      };
    })
    .filter(p => !p.relevado || p.emiteFacturaA === '?')
    .sort((a, b) => b.gasto - a.gasto)
    .map(p => {
      acumulado += p.gasto;
      // Cuánto del gasto queda cubierto si se relevan todos hasta acá. Es lo que
      // permite parar a tiempo: con seis proveedores ya suele estar el 80%.
      p.acumuladoPct = gastoTotal > 0 ? Math.round(acumulado / gastoTotal * 10000) / 100 : 0;
      return p;
    });
}

module.exports = {
  leerPadron, setFiscalProveedor, sembrarPadron, armarCola,
  CONDICIONES, COMPROBANTES,
  COL_CUIT, COL_CONDICION, COL_COMPROBANTE, COL_ALICUOTA, COL_FUENTE, COL_RELEVADO,
};
