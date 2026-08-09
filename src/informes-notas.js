// ─── Notas al agente: el feedback de los dueños sobre lo que el informe dice ──
//
// Para qué está: el analista compara cada gasto contra la mediana histórica de
// ese proveedor, y cuando el negocio cambia de verdad esa comparación empieza a
// mentir. El VEP de ARCA de agosto de 2026 es el caso testigo: se pasó de 2
// empleados a 4, la carga se duplicó y el informe la marcó como monto atípico
// todas las semanas. Estadísticamente tenía razón; lo que no podía saber es que
// el nivel nuevo es el nuevo normal. Eso sólo lo sabe el dueño.
//
// Sin este canal ese hallazgo vuelve cada mes durante medio año, hasta que más
// de la mitad de las filas históricas de ARCA estén en el nivel nuevo y la
// mediana se mueva sola.
//
// Una nota tiene DOS partes, y van a lugares distintos a propósito — es el mismo
// reparto que ordena todo el sistema (el código calcula, el modelo interpreta):
//
//   · el TEXTO lo lee el modelo. Es criterio: por qué algo es normal, qué
//     contexto le falta. Es blando: baja la probabilidad de que lo repita.
//   · el ESCALÓN lo lee el CÓDIGO (ver informe-movimientos, sección A). Es un
//     dato: "este proveedor cambió de nivel tal día". El analista deja de
//     comparar contra lo de antes y el falso positivo desaparece de raíz, sin
//     depender de que el modelo se acuerde de ignorarlo.
//
// Cada nota queda firmada con quién la escribió. Hoy el informe lo lee sólo
// tincho, pero pablo va a leerlo más adelante y los dos pueden opinar distinto:
// cuando eso pase, el agente tiene que mostrar la contradicción en vez de elegir
// una en silencio.

const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.INFORMES_NOTAS_SHEET || 'Informes Notas';
const HEADER = ['Fecha', 'Usuario', 'Tipo', 'Periodo', 'Hallazgo', 'Veredicto', 'Texto', 'EscalonConcepto', 'EscalonDesde', 'Estado'];

const VEREDICTOS = ['sirve', 'normal', 'contexto'];

// Cuánto hacia atrás se le muestran las notas al modelo. Más que esto es
// contexto viejo que confunde más de lo que aclara: el negocio cambia, y una
// explicación de hace un año puede haber dejado de ser cierta. Los escalones NO
// caducan — son un hecho sobre una fecha, no una opinión.
const DIAS_VIGENCIA = Number(process.env.INFORMES_NOTAS_DIAS || 240);

const norm = s => (s || '').toString().trim().toLowerCase();
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function _sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }),
  });
}

// Misma distinción que en informes.js: "la hoja todavía no existe" es el estado
// normal antes de la primera nota, no una falla.
const esHojaInexistente = e => /unable to parse range/i.test(e.message || '');

async function _ensureHoja(api) {
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOJA } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A1:J1`,
      valueInputOption: 'RAW', requestBody: { values: [HEADER] },
    });
  } catch (e) { /* ya existía */ }
}

async function listarNotas({ tipo, incluirArchivadas = false, estricto = false } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  let filas = [];
  try {
    const r = await _sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:J` });
    filas = r.data.values || [];
  } catch (e) {
    if (estricto && !esHojaInexistente(e)) throw e;
    return [];
  }

  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || !f[0]) continue;
    const nota = {
      rowIndex: i + 1, fecha: f[0], usuario: f[1] || '', tipo: f[2] || '',
      periodo: f[3] || '', hallazgo: f[4] || '', veredicto: f[5] || 'contexto',
      texto: f[6] || '', escalonConcepto: f[7] || '', escalonDesde: f[8] || '',
      estado: f[9] || 'vigente',
    };
    // Una nota sin tipo es contexto general del negocio ("somos 4 empleados
    // desde agosto") y le llega a los tres agentes, no sólo al que la motivó.
    if (tipo && nota.tipo && nota.tipo !== tipo) continue;
    if (!incluirArchivadas && nota.estado === 'archivada') continue;
    out.push(nota);
  }
  return out.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
}

async function guardarNota({ usuario, tipo, periodo, hallazgo, veredicto, texto, escalonConcepto, escalonDesde }) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  if (!usuario) throw new Error('Falta el usuario');
  if (!VEREDICTOS.includes(veredicto)) throw new Error(`Veredicto inválido (${VEREDICTOS.join(' | ')})`);

  const t = (texto || '').toString().trim();
  const concepto = (escalonConcepto || '').toString().trim();
  const desde = (escalonDesde || '').toString().trim();

  // Un escalón sin las dos cosas no sirve: el código necesita saber a qué se
  // aplica y desde cuándo. Se rechaza en vez de guardarse a medias, porque una
  // nota que el analista ignora en silencio es peor que un error visible.
  if ((concepto && !desde) || (desde && !concepto)) {
    throw new Error('Para marcar un cambio permanente hacen falta el concepto y la fecha');
  }
  if (desde && !RE_FECHA.test(desde)) throw new Error('La fecha del cambio va como AAAA-MM-DD');

  // "Sirve" solo es un pulgar arriba y no necesita texto. Los otros dos existen
  // para explicar: sin explicación no le dejan nada al agente.
  if (veredicto !== 'sirve' && !t && !concepto) {
    throw new Error('Contá brevemente por qué, o marcá el cambio permanente: sin eso la nota no le sirve al agente');
  }

  const api = _sheets();
  await _ensureHoja(api);
  const fila = [
    new Date().toISOString(), usuario, tipo || '', periodo || '', hallazgo || '',
    veredicto, t, concepto, desde, 'vigente',
  ];
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:J`,
    valueInputOption: 'RAW', requestBody: { values: [fila] },
  });
  return { fecha: fila[0], usuario, tipo, periodo, hallazgo, veredicto, texto: t, escalonConcepto: concepto, escalonDesde: desde, estado: 'vigente' };
}

async function archivarNota(rowIndex) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const n = Number(rowIndex);
  if (!Number.isInteger(n) || n < 2) throw new Error('Fila inválida');
  await _sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!J${n}`,
    valueInputOption: 'RAW', requestBody: { values: [['archivada']] },
  });
  return { rowIndex: n, estado: 'archivada' };
}

// ─── Lo que consume el CÓDIGO ───────────────────────────────────────────────
// Los escalones no caducan: son un hecho sobre una fecha. Si el mismo concepto
// tiene varios, gana el más reciente — un segundo cambio reemplaza al primero.
function escalonesDe(notas) {
  const out = new Map();
  for (const n of notas || []) {
    if (!n.escalonConcepto || !RE_FECHA.test(n.escalonDesde || '')) continue;
    const k = norm(n.escalonConcepto);
    const desde = new Date(`${n.escalonDesde}T00:00:00`);
    if (isNaN(desde)) continue;
    const previo = out.get(k);
    if (!previo || desde > previo.desde) out.set(k, { concepto: n.escalonConcepto, desde, usuario: n.usuario, fecha: n.fecha });
  }
  return out;
}

// ─── Lo que lee el MODELO ───────────────────────────────────────────────────
// Sólo las notas con algo escrito: un pulgar arriba pelado no aporta nada al
// prompt, sirve para calibrar mirando la hoja. Se recortan por antigüedad y se
// muestra la fecha, para que el modelo pueda pesar una explicación vieja.
function bloqueParaModelo(notas, { ahora = new Date() } = {}) {
  const corte = new Date(ahora.getTime() - DIAS_VIGENCIA * 86400000);
  const utiles = (notas || [])
    .filter(n => (n.texto || '').trim() || n.escalonConcepto)
    .filter(n => !n.fecha || new Date(n.fecha) > corte);
  if (!utiles.length) return '';

  const lineas = utiles.map(n => {
    const partes = [`[${(n.fecha || '').slice(0, 10)}] ${n.usuario || 'alguien'}`];
    if (n.hallazgo) partes.push(`sobre "${n.hallazgo}"`);
    partes.push(n.veredicto === 'normal' ? '— ES NORMAL:' : n.veredicto === 'sirve' ? '— le sirvió:' : '—');
    if (n.texto) partes.push(n.texto);
    if (n.escalonConcepto) {
      partes.push(`(cambio permanente en "${n.escalonConcepto}" desde ${n.escalonDesde}: el análisis ya deja de comparar contra lo anterior)`);
    }
    return `- ${partes.join(' ')}`;
  });

  return ['', `LO QUE YA TE DIJERON LOS DUEÑOS (${utiles.length}):`, ...lineas].join('\n');
}

module.exports = {
  listarNotas, guardarNota, archivarNota, escalonesDe, bloqueParaModelo,
  HOJA, HEADER, VEREDICTOS, DIAS_VIGENCIA,
};
