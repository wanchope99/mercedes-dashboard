// ─── Saldos de proveedores — lo que sobra o falta cuando se paga ────────────
//
// Llega un pedido y la plata no cierra con lo acordado. Pasa todo el tiempo y
// hasta ahora no quedaba en ningún lado:
//
//   · El pedido es $117.000, no hay cambio y se pagan $120.000. Quedan $3.000 a
//     favor del bar que alguien tiene que acordarse de descontar la próxima vez.
//   · Se paga $2.000 de menos por lo mismo, al revés.
//
// Esto es una libreta de esos pesos, por proveedor. NO es una cuenta corriente
// de facturas: lo que se debe por mercadería entregada vive en `Movimientos`
// como "A pagar" y lo persigue la sección Pagos. Acá va lo que no tiene factura
// que lo explique.
//
// ═══════════════════════════════════════════════════════════════════════════
// EL SIGNO. Leer esto antes de tocar cualquier cosa de este archivo.
// ═══════════════════════════════════════════════════════════════════════════
//
//   POSITIVO  = a favor del BAR. El proveedor NOS DEBE.
//   NEGATIVO  = en contra del BAR. LE DEBEMOS.
//
// "A favor" y "en contra" no dicen nada sin decir de quién, y las dos frases se
// usan para los dos lados según quién hable. Es la misma trampa de vocabulario
// que ya está documentada en src/pedidos.js entre `sePagaEnPuerta` y el estado
// 'a-pagar', que significan cosas opuestas. Por eso en la PANTALLA no aparece
// ninguna de las dos: dice "le pagué de más" o "le quedé debiendo", que no se
// pueden leer al revés.
//
// ─── El saldo se SUMA, no se guarda ─────────────────────────────────────────
//
// El saldo de un proveedor es la suma de sus renglones. No hay una columna con
// el total, y es a propósito: un total guardado y una lista se desincronizan el
// día que alguien edita la planilla a mano, y entonces hay dos respuestas para
// la misma pregunta. La lista además es la única que puede contestar "¿y estos
// $3.000 de dónde salieron?", que es lo que se pregunta tres semanas después.
//
// ─── Esto NO mueve plata ────────────────────────────────────────────────────
//
// Un renglón acá no escribe nada en `Movimientos` ni toca ninguna caja. La
// plata que se movió de verdad ya está en Movimientos: la regla es que el gasto
// lleva SIEMPRE lo que salió de la caja (los $120.000), no lo que vale la
// mercadería. Ver el comentario de la ruta de recibir en server.js — de esa
// invariante dependen el arqueo y la fila de ajuste del cierre.
//
// La consecuencia, dicha en voz alta: mientras un saldo esté vivo, el gasto del
// mes está corrido por ese monto. Se endereza solo cuando el saldo se usa,
// porque ahí el pago siguiente es más chico por la misma plata.
//
// Persistencia: hoja "Proveedores Saldos" en la planilla de COMPARACIÓN
// PROVEEDORES, creada sola al primer uso.
//
//   A ID | B Fecha | C Proveedor | D Monto | E Motivo | F Detalle |
//   G PedidoID | H Usuario | I Actualizado

const { google } = require('googleapis');
const NodeCache = require('node-cache');
const { parseMonto, centavos } = require('./monto');

const cache = new NodeCache({ stdTTL: 60 });
const CACHE_KEY = 'saldos';

// ═══════════════════════════════════════════════════════════════════════════
// La planilla, y por qué acá NO hay fallback
// ═══════════════════════════════════════════════════════════════════════════
//
// Los saldos van con los proveedores, en la planilla de Comparación Proveedores
// donde ya vive `Compras`. Decisión del dueño (26/08/2026).
//
// `src/proveedores.js` cae a SPREADSHEET_ID cuando la variable no está, y eso
// acá sería una trampa: sin la variable —el .env local no la tiene— la hoja se
// crearía sola en la planilla de GESTIÓN, que es la que no hay que ensuciar, y
// nadie se enteraría hasta encontrarla ahí. Sin variable el módulo se apaga y lo
// dice, que es exactamente lo que hace NOMINA_SHEET_ID a propósito.
const SHEET_ID = process.env.PROVEEDORES_SHEET_ID || null;
const HOJA = process.env.PROVEEDORES_SALDOS_SHEET || 'Proveedores Saldos';
const HEADER = ['ID', 'Fecha', 'Proveedor', 'Monto', 'Motivo', 'Detalle',
                'PedidoID', 'Usuario', 'Actualizado'];
const ULTIMA_COL = 'I';
const TZ = 'America/Argentina/Buenos_Aires';

// Por qué la plata no cerró. Lista corta a propósito: con veinte opciones nadie
// distingue dos, y todo termina en "otros".
//
//   vuelto          no había cambio y se pagó de más o de menos
//   no-vino         se descontó algo que no trajeron
//   mal-estado      se descontó algo que se rechazó por calidad
//   precio-distinto cobró un importe distinto del acordado
//   uso             se aplicó un saldo que ya existía (lo cancela)
//   ajuste          corrección a mano
//   otros           lo demás
const MOTIVOS = ['vuelto', 'no-vino', 'mal-estado', 'precio-distinto', 'uso', 'ajuste', 'otros'];
const MOTIVO_DEFAULT = 'otros';

const DETALLE_MAX = 300;

// ─── Puras ──────────────────────────────────────────────────────────────────

const _txt = v => (v == null ? '' : String(v)).trim();

const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** Texto comparable: sin mayúsculas, sin tildes, sin espacios de más. Es el
 *  mismo criterio que usa proveedores-config para machear la ficha. */
const norm = v => _txt(v).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

/** Un número tipeado con puntos, comas o un "$" adelante, con su signo.
 *  La copia que vivía acá borraba TODOS los puntos, así que "$3.000,50" salía
 *  bien y "$3000.50" salía 300050. Una sola regla, en `monto.js`. */
const _numero = parseMonto;

const _redondear = centavos;

const normalizarMotivo = v => {
  const m = norm(v);
  return MOTIVOS.find(x => x === m) || MOTIVO_DEFAULT;
};

/**
 * El saldo de un proveedor: la suma de sus renglones, con signo.
 *
 * Puro y exportado para poder probarlo sin planilla. Devuelve 0 tanto para un
 * proveedor sin renglones como para uno cuyos renglones se cancelan — y son la
 * misma cosa a los efectos de esta libreta: no hay nada pendiente.
 */
function saldoEn(movimientos, proveedor) {
  const clave = norm(proveedor);
  if (!clave) return 0;
  return _redondear((movimientos || [])
    .filter(m => norm(m.proveedor) === clave)
    .reduce((s, m) => s + (Number(m.monto) || 0), 0));
}

/**
 * Todos los proveedores con saldo distinto de cero, del más grande al más chico
 * en valor absoluto.
 *
 * Los que dan cero NO se listan: un proveedor cuyo saldo se canceló no tiene
 * nada pendiente, y mostrarlo en una lista de pendientes la llena de ruido. Su
 * historia sigue estando entera en la hoja.
 */
function resumen(movimientos) {
  const porProveedor = new Map();
  for (const m of (movimientos || [])) {
    const clave = norm(m.proveedor);
    if (!clave) continue;
    const prev = porProveedor.get(clave)
      || { proveedor: m.proveedor, saldo: 0, movimientos: 0, ultimo: '' };
    prev.saldo += Number(m.monto) || 0;
    prev.movimientos += 1;
    if ((m.fecha || '') > prev.ultimo) prev.ultimo = m.fecha || '';
    porProveedor.set(clave, prev);
  }
  return [...porProveedor.values()]
    .map(p => ({ ...p, saldo: _redondear(p.saldo) }))
    .filter(p => Math.abs(p.saldo) >= 0.01)
    .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
}

/** La historia de un proveedor, lo más nuevo arriba. */
function historiaEn(movimientos, proveedor) {
  const clave = norm(proveedor);
  if (!clave) return [];
  return (movimientos || [])
    .filter(m => norm(m.proveedor) === clave)
    .sort((a, b) => (b.actualizado || b.fecha || '').localeCompare(a.actualizado || a.fecha || ''));
}

// ─── I/O ────────────────────────────────────────────────────────────────────

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
    // Todavía no existe: no hay saldos, y no es un error. Se crea al pasar para
    // que la planilla se explique sola aunque nunca se haya anotado ninguno.
    await _ensureHoja(api).catch(() => {});
    return [];
  }
  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] || [];
    if (!_txt(f[0]) || !_txt(f[2])) continue;   // sin id o sin proveedor no se puede ubicar
    out.push({
      id: _txt(f[0]),
      fecha: _txt(f[1]),
      proveedor: _txt(f[2]),
      monto: _numero(f[3]),
      motivo: normalizarMotivo(f[4]),
      detalle: _txt(f[5]),
      pedidoId: _txt(f[6]),
      usuario: _txt(f[7]),
      actualizado: _txt(f[8]),
      rowIndex: i + 1,
    });
  }
  return out;
}

async function listar() {
  if (!configurada()) return [];
  const hit = cache.get(CACHE_KEY);
  if (hit) return hit;
  const val = await _leer(_sheets());
  cache.set(CACHE_KEY, val);
  return val;
}

/** El saldo de un proveedor, leyendo la planilla. 0 si no está configurada. */
async function saldoDe(proveedor) {
  return saldoEn(await listar(), proveedor);
}

/** Todos los que tienen algo pendiente. */
async function listarResumen() {
  return resumen(await listar());
}

/** La historia de uno, con su saldo. */
async function historiaDe(proveedor) {
  const movs = await listar();
  return {
    proveedor: _txt(proveedor),
    saldo: saldoEn(movs, proveedor),
    movimientos: historiaEn(movs, proveedor).map(({ rowIndex, ...rest }) => rest),
  };
}

/**
 * Anotar un renglón de saldo. **No lanza.**
 *
 * Lo llaman rutas que ya hicieron el trabajo de verdad —la fila del libro
 * escrita, el pedido marcado recibido— y una recepción no puede fallar porque
 * no se pudo dejar una nota. Devuelve `{ok:false}` con el motivo y la pantalla
 * de quien recibió lo cuenta, que es la única forma de que alguien lo anote de
 * palabra en vez de darlo por hecho. Misma regla que src/avisos.js.
 *
 * Un monto en cero se rechaza: un renglón que no mueve el saldo no dice nada y
 * ensucia la historia, que es lo único que este archivo tiene para ofrecer.
 */
async function registrar({ proveedor, monto, motivo, detalle = '', pedidoId = '', usuario = '' } = {}) {
  try {
    if (!configurada()) {
      return { ok: false, error: 'Los saldos no están configurados en el servidor (falta PROVEEDORES_SHEET_ID).' };
    }
    const nombre = _txt(proveedor);
    if (!nombre) return { ok: false, error: 'Un saldo sin proveedor no es de nadie' };
    const m = _redondear(monto);
    if (!m) return { ok: false, error: 'Un saldo de $0 no cambia nada' };

    const fila = {
      id: `sal${Date.now()}`,
      fecha: hoyAR(),
      proveedor: nombre,
      monto: m,
      motivo: normalizarMotivo(motivo),
      detalle: _txt(detalle).slice(0, DETALLE_MAX),
      pedidoId: _txt(pedidoId),
      usuario: _txt(usuario),
      actualizado: new Date().toISOString(),
    };

    const api = _sheets();
    await _ensureHoja(api);
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${HOJA}!A:${ULTIMA_COL}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[fila.id, fila.fecha, fila.proveedor, fila.monto, fila.motivo,
                  fila.detalle, fila.pedidoId, fila.usuario, fila.actualizado]],
      },
    });
    cache.del(CACHE_KEY);
    return { ok: true, movimiento: fila, saldo: await saldoDe(nombre) };
  } catch (e) {
    console.error(`Saldos: no se pudo anotar el de ${proveedor} (${e.message})`);
    return { ok: false, error: e.message };
  }
}

function clearCache() { cache.del(CACHE_KEY); }

module.exports = {
  configurada, listar, saldoDe, listarResumen, historiaDe, registrar, clearCache,
  // Puras
  saldoEn, resumen, historiaEn, norm, normalizarMotivo,
  MOTIVOS, HOJA,
};
