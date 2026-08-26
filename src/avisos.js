// ─── Avisos — lo que pasó y alguien tiene que enterarse ─────────────────────
//
// La campanita de `src/notificaciones.js` DERIVA todo: mira los pagos, los
// pedidos y la checklist, y saca conclusiones. Eso alcanza mientras la
// conclusión siga siendo verdad cuando uno la mira — "5 pagos vencidos" se
// puede recalcular a las tres de la tarde y sigue diciendo lo mismo.
//
// Hay cosas que no. "Juan recibió a Thames y pagó $14.700 más de lo que decía
// la compra" es un HECHO DE UN MOMENTO: una vez que el pedido quedó recibido y
// la fila escrita, la planilla ya no guarda en ningún lado que hubo una
// diferencia — el monto viejo se pisó. Derivarlo después es imposible. Si no se
// anota cuando pasa, no se anota nunca.
//
// Ese es todo el trabajo de este módulo: una libreta de eventos con
// destinatario. No calcula nada, no opina, no vuelve a leer la planilla. Alguien
// llama a `registrar` en el momento en que pasa la cosa, y la campanita de esas
// personas lo levanta.
//
// ─── Por qué tiene destinatario y las otras notificaciones no ───────────────
//
// Las demás fuentes se filtran por ROL (`VISIBLE_PARA` en notificaciones.js):
// las de plata sólo las ven los admin. Acá no alcanza. Los tres logins de admin
// —`admin`, `pablo` y `tincho`— tienen exactamente los mismos permisos, así que
// el rol no distingue a nadie: es el mismo problema que ya tenía el informe
// diario, que se resolvió mirando `usuario` en vez de `rol`.
//
// Y hace falta distinguir porque un aviso de éstos es una pregunta dirigida
// ("¿por qué se pagó de más?"), no un estado del bar. Mandársela a los seis
// usuarios sería mandársela también a quien la provocó, y a la cocina, que no
// tiene nada que hacer con eso.
//
// El destinatario se guarda EN LA FILA y no se decide al leer. Un aviso escrito
// hoy tiene que seguir diciendo a quién iba dentro de un año, aunque para
// entonces la lista de dueños haya cambiado.
//
// ─── Es un EVENTO, con todo lo que eso implica ──────────────────────────────
//
// Se apaga al abrir la campanita, como los de Mantenimiento (ver la distinción
// estado/evento en notificaciones.js). Pasó una vez, se ve una vez. Lo que NO
// se hace es borrar la fila: la hoja queda como registro de que el hecho
// ocurrió y de que se avisó, que es justamente para lo que existe.
//
// Persistencia: una hoja en SPREADSHEET_ID, creada sola al primer uso, igual
// que Mantenimiento y Pedidos. Sin base de datos, como todo el resto.
//
//   Hoja "Avisos" — un aviso, ya emitido:
//     A ID | B Cuando | C Tipo | D Titulo | E Detalle | F Para |
//     G Severidad | H Quien | I Ir
//
// `Cuando` es ISO completo (con hora) y no una fecha: es lo que se compara
// contra la marca de "visto hasta" para saber si es nuevo, y esa marca se
// guarda con toISOString(). `Para` son usuarios separados por `|`.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 60 });
const CACHE_KEY = 'avisos';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.AVISOS_SHEET || 'Avisos';
const HEADER = ['ID', 'Cuando', 'Tipo', 'Titulo', 'Detalle', 'Para', 'Severidad', 'Quien', 'Ir'];
const ULTIMA_COL = 'I';

// Los dueños. Es la lista a la que van los avisos de plata, y son los tres
// logins de rol admin (ver el registro de usuarios en server.js).
//
// Por variable de entorno para poder cambiarla sin tocar código, igual que
// INFORMES_DESTINATARIO. Se normaliza a minúsculas porque es lo que trae el JWT.
const DUENOS = (process.env.AVISOS_DUENOS || 'admin,pablo,tincho')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Cuánto para atrás mira la campanita.
//
// Existe por el usuario que nunca abrió el panel: sin marca de "visto hasta",
// todo aviso que alguna vez se escribió sería nuevo, y el badge arrancaría en
// el total histórico. Quince días es más que suficiente para algo que se mira
// todos los días, y deja la hoja entera como registro para el que la abra.
const VENTANA_DIAS = 15;

// Una campanita con veinte líneas es una lista, y una lista no se lee. Mismo
// número que MAX_POR_FUENTE en notificaciones.js y por la misma razón.
const MAX = 8;

const TITULO_MAX = 140;
const DETALLE_MAX = 500;

// ─── Puras ──────────────────────────────────────────────────────────────────

const _txt = v => (v == null ? '' : String(v)).trim();

const _lista = v => _txt(v).split('|').map(x => x.trim().toLowerCase()).filter(Boolean);

/**
 * Los avisos que le tocan a esta persona y todavía no vio.
 *
 * Tres cortes, y el orden importa poco porque son independientes: que sea para
 * mí, que sea de los últimos días, y que sea posterior a la última vez que
 * abrí el panel.
 *
 * `vistoHasta` vacío —nunca abrió la campanita— NO muestra todo lo que existió:
 * para eso está la ventana. Ver VENTANA_DIAS.
 */
function paraUsuario(avisos, { usuario, vistoHasta, ahora = new Date() } = {}) {
  const quien = _txt(usuario).toLowerCase();
  if (!quien) return [];
  const desde = new Date(ahora.getTime() - VENTANA_DIAS * 86400000).toISOString();
  return (avisos || [])
    .filter(a => a.cuando
      && a.cuando >= desde
      && (!vistoHasta || a.cuando > vistoHasta)
      && a.para.includes(quien))
    .sort((a, b) => (b.cuando || '').localeCompare(a.cuando || ''))
    .slice(0, MAX);
}

// ─── I/O ────────────────────────────────────────────────────────────────────

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
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOJA } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
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
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:${ULTIMA_COL}`,
    });
    filas = r.data.values || [];
  } catch (e) {
    // La hoja todavía no existe: no hay avisos, y no es un error. Se crea acá
    // para que la primera lectura la deje lista y la planilla se explique sola
    // aunque nunca se haya emitido ninguno.
    await _ensureHoja(api).catch(() => {});
    return [];
  }
  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] || [];
    if (!_txt(f[0])) continue;
    out.push({
      id: _txt(f[0]),
      cuando: _txt(f[1]),
      tipo: _txt(f[2]),
      titulo: _txt(f[3]),
      detalle: _txt(f[4]),
      para: _lista(f[5]),
      severidad: _txt(f[6]) || 'media',
      quien: _txt(f[7]),
      ir: _txt(f[8]),
    });
  }
  return out;
}

async function listar() {
  if (!SPREADSHEET_ID) return [];
  const hit = cache.get(CACHE_KEY);
  if (hit) return hit;
  const val = await _leer(_sheets());
  cache.set(CACHE_KEY, val);
  return val;
}

/**
 * Anotar que pasó algo.
 *
 * NO lanza. Lo llaman rutas que ya hicieron el trabajo de verdad —escribir en
 * Movimientos, marcar el pedido recibido— y que no pueden fallar porque no se
 * pudo dejar una nota: la mercadería llegó igual y la plata salió igual. El
 * resultado se devuelve para que la ruta lo pueda contar ({ok:false} incluido),
 * y así un aviso que no se pudo escribir se ve en la pantalla del que recibió
 * en vez de perderse en un log que nadie lee.
 */
async function registrar({ tipo, titulo, detalle = '', para = DUENOS, severidad = 'alta', quien = '', ir = '' } = {}) {
  try {
    if (!SPREADSHEET_ID) return { ok: false, error: 'Falta SPREADSHEET_ID' };
    const destinatarios = (Array.isArray(para) ? para : _lista(para))
      .map(x => _txt(x).toLowerCase()).filter(Boolean);
    if (!destinatarios.length) return { ok: false, error: 'Un aviso sin destinatario no se le muestra a nadie' };
    const t = _txt(titulo).slice(0, TITULO_MAX);
    if (!t) return { ok: false, error: 'Falta el título del aviso' };

    const aviso = {
      id: `av${Date.now()}`,
      cuando: new Date().toISOString(),
      tipo: _txt(tipo) || 'general',
      titulo: t,
      detalle: _txt(detalle).slice(0, DETALLE_MAX),
      para: destinatarios,
      severidad: _txt(severidad) || 'alta',
      quien: _txt(quien),
      ir: _txt(ir),
    };

    const api = _sheets();
    await _ensureHoja(api);
    await api.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA}!A:${ULTIMA_COL}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[aviso.id, aviso.cuando, aviso.tipo, aviso.titulo, aviso.detalle,
                  aviso.para.join('|'), aviso.severidad, aviso.quien, aviso.ir]],
      },
    });
    cache.del(CACHE_KEY);
    return { ok: true, aviso, para: aviso.para };
  } catch (e) {
    console.error(`Avisos: no se pudo registrar "${titulo}" (${e.message})`);
    return { ok: false, error: e.message };
  }
}

function clearCache() { cache.del(CACHE_KEY); }

module.exports = {
  registrar, listar, clearCache,
  // Puras
  paraUsuario,
  DUENOS, HOJA, VENTANA_DIAS, MAX,
};
