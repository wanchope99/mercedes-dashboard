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

// Los "me sirvió" se acumulan todas las semanas y, sin tope, en unos meses son
// el bloque más largo del prompt: ahogarían justamente las explicaciones, que
// son las que evitan que el agente repita un falso positivo. Se priorizan los
// que tienen comentario (dicen POR QUÉ sirvió, que es lo que calibra) y del
// resto entran los más nuevos; los que quedan afuera se cuentan en una línea.
const MAX_UTILES = Number(process.env.INFORMES_NOTAS_UTILES_MAX || 15);

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

  // El escalón NO se le pide al usuario: sale del hallazgo, que ya trae el
  // proveedor y la fecha desde la señal que lo originó. Así que las dos partes
  // llegan juntas o no llega ninguna, y esto es una guarda contra un cliente
  // roto, no algo que alguien pueda tropezar escribiendo.
  //
  // Un escalón a medias se descarta en silencio en vez de rechazar la nota
  // entera: lo que el dueño escribió vale igual, y perderlo por un dato que ni
  // siquiera tipeó sería exactamente al revés.
  const escalonValido = !!(concepto && RE_FECHA.test(desde));
  if ((concepto || desde) && !escalonValido) {
    console.warn(`Notas: escalón incompleto descartado (concepto="${concepto}" desde="${desde}") — la nota se guarda igual`);
  }

  const api = _sheets();
  await _ensureHoja(api);
  const fila = [
    new Date().toISOString(), usuario, tipo || '', periodo || '', hallazgo || '',
    veredicto, t, escalonValido ? concepto : '', escalonValido ? desde : '', 'vigente',
  ];
  const r = await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:J`,
    valueInputOption: 'RAW', requestBody: { values: [fila] },
  });
  return {
    // La fila donde quedó, para poder sumarle un comentario después sin volver a
    // leer la hoja entera. El pulgar arriba se guarda de un toque y recién
    // entonces se ofrece contar por qué sirvió: sin esto, esa segunda mitad
    // tendría que ser una nota nueva y el mismo hecho quedaría en dos filas.
    rowIndex: _filaDe(r),
    fecha: fila[0], usuario, tipo, periodo, hallazgo, veredicto, texto: t,
    escalonConcepto: fila[7], escalonDesde: fila[8], estado: 'vigente',
  };
}

// append devuelve el rango que escribió ("'Informes Notas'!A42:J42"). Si algún
// día cambiara el formato, se devuelve null y lo único que se pierde es poder
// agregar el comentario — la nota ya quedó guardada, que es lo que importa.
function _filaDe(res) {
  const rango = res && res.data && res.data.updates && res.data.updates.updatedRange;
  const m = /![A-Z]+(\d+)/.exec(rango || '');
  return m ? Number(m[1]) : null;
}

// Sumarle el "por qué" a una nota que ya existe. Es AGREGAR, no editar: si la
// fila ya tiene texto se rechaza, así este camino no puede pisar lo que alguien
// escribió. El autor se compara contra el de la fila — una nota firmada que
// cualquiera pudiera completar no estaría firmada.
async function agregarTexto({ rowIndex, usuario, texto }) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const n = Number(rowIndex);
  if (!Number.isInteger(n) || n < 2) throw new Error('Fila inválida');
  const t = (texto || '').toString().trim();
  if (!t) throw new Error('No hay nada que agregar');

  const api = _sheets();
  const r = await api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A${n}:J${n}` });
  const fila = (r.data.values || [])[0];
  if (!fila || !fila[0]) throw new Error('Esa nota no existe');
  if (norm(fila[1]) !== norm(usuario)) throw new Error('Esa nota la escribió otra persona');
  if ((fila[6] || '').trim()) throw new Error('Esa nota ya tiene un comentario');

  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!G${n}`,
    valueInputOption: 'RAW', requestBody: { values: [[t]] },
  });
  return { rowIndex: n, texto: t };
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
//
// Esto NO es una lista de respuestas sueltas a comentarios sueltos, y la
// diferencia es la razón de ser del bloque. La primera versión era una tira
// cronológica de notas, y leída así cada una respondía a un hallazgo de una
// semana que ya pasó: el agente no aprendía un criterio, se enteraba de tres
// correcciones viejas. Acá el mismo material se ordena por LO QUE ENSEÑA, que
// es lo único que sirve para leer los datos de esta semana:
//
//   1. cómo se lee el negocio — lo que contaron sin que se los preguntaran;
//   2. lo que ya explicaron que es normal — AGRUPADO POR TEMA, no por fecha,
//      así "ARCA" es una sola cosa con su historia y no tres viñetas sueltas;
//   3. qué les sirvió — para calibrar qué vale la pena contar.
//
// El 3 es el más delicado y por eso va etiquetado tan fuerte: que a alguien le
// haya servido un hallazgo NO es motivo para volver a emitirlo. Sin esa aclaración
// el bloque empuja exactamente al error que toda la arquitectura evita — afirmar
// algo sin una señal que lo respalde.
//
// Entra toda nota que enseñe algo: la que tiene texto, la que tiene escalón, y
// también el "ya lo sé" pelado y el pulgar arriba pelado. Un "ya lo sabía" sin
// explicación sigue siendo la información más accionable que existe acá.
// Se recorta por antigüedad y se muestra la fecha, para que el modelo pueda
// pesar una explicación vieja.
function bloqueParaModelo(notas, { ahora = new Date() } = {}) {
  const corte = new Date(ahora.getTime() - DIAS_VIGENCIA * 86400000);
  const vigentes = (notas || [])
    .filter(n => (n.texto || '').trim() || n.escalonConcepto || n.hallazgo)
    .filter(n => !n.fecha || new Date(n.fecha) > corte)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  if (!vigentes.length) return '';

  const cuando = n => (n.fecha || '').slice(0, 10);
  const quien = n => n.usuario || 'alguien';
  const dice = n => (n.texto || '').trim();

  const secciones = [];

  // ── 1. Contexto que dieron por propia iniciativa ──────────────────────────
  const contexto = vigentes.filter(n => n.veredicto === 'contexto' && dice(n));
  if (contexto.length) {
    secciones.push(
      'CÓMO SE LEE EL NEGOCIO — te lo contaron ellos, sin que lo preguntaras:',
      ...contexto.map(n => `- [${cuando(n)}] ${quien(n)}: ${dice(n)}`),
      ''
    );
  }

  // ── 2. Lo que ya explicaron, agrupado por tema ────────────────────────────
  // La clave del grupo es el concepto del escalón cuando lo hay, porque es el
  // único identificador fuerte que existe (sale de la señal, no de un título
  // que el modelo redacta distinto cada semana). Sin escalón se agrupa por el
  // informe del que hablaban, que es lo más específico que se puede afirmar
  // sin adivinar de qué tema es la nota.
  const normales = vigentes.filter(n => n.veredicto === 'normal');
  if (normales.length) {
    // Los conceptos que ELLOS marcaron como escalón son los únicos nombres de
    // tema que existen con respaldo: salieron de la señal, no de un título que
    // el modelo redacta distinto cada semana. Una nota sin escalón que hable de
    // uno de esos conceptos se suma a ese tema en vez de abrir el suyo — si no,
    // "ARCA" queda partido en dos viñetas que se leen como dos temas y vuelve a
    // ser una lista de comentarios sueltos, que es lo que este bloque evita.
    //
    // Sólo se matchea contra conceptos que ya existen; acá tampoco se inventan
    // nombres. Gana el más largo, igual que en la inferencia del navegador.
    const conceptos = [...new Set(normales.filter(n => n.escalonConcepto).map(n => n.escalonConcepto))]
      .sort((a, b) => b.length - a.length);
    const temaDe = n => {
      if (n.escalonConcepto) return norm(n.escalonConcepto);
      const texto = norm(n.hallazgo);
      const hit = conceptos.find(c => norm(c).length > 2 && texto.includes(norm(c)));
      return hit ? norm(hit) : null;
    };

    const grupos = new Map();
    for (const n of normales) {
      const tema = temaDe(n);
      const clave = tema ? `c:${tema}` : n.tipo ? `t:${n.tipo}` : 'general';
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(n);
    }

    // Primero los temas con nombre propio: son hechos sobre un concepto
    // concreto. Después los cajones por informe, que son el resto.
    const ordenados = [...grupos.entries()]
      .sort((a, b) => (a[0].startsWith('c:') ? 0 : 1) - (b[0].startsWith('c:') ? 0 : 1))
      .map(([, g]) => g);

    const lineas = [];
    for (const grupo of ordenados) {
      // Las notas ya vienen de la más nueva a la más vieja: el escalón vigente
      // es el de la más reciente que lo tenga, igual que en escalonesDe().
      const conEscalon = grupo.find(n => n.escalonConcepto);
      lineas.push(conEscalon
        ? `· ${conEscalon.escalonConcepto} — marcado como cambio permanente desde ${conEscalon.escalonDesde}: el análisis ya no compara contra lo anterior a esa fecha.`
        : `· sobre el informe de ${grupo[0].tipo || 'siempre'}:`);
      for (const n of grupo) {
        const sobre = n.hallazgo ? ` sobre "${n.hallazgo}"` : '';
        lineas.push(dice(n)
          ? `    - [${cuando(n)}] ${quien(n)}${sobre}: ${dice(n)}`
          : `    - [${cuando(n)}] ${quien(n)}${sobre}: ya lo sabían. No hace falta que se los cuentes de nuevo.`);
      }
    }
    secciones.push('YA TE EXPLICARON QUE ESTO ES NORMAL:', ...lineas, '');
  }

  // ── 3. Qué les sirvió ─────────────────────────────────────────────────────
  const sirvieron = vigentes.filter(n => n.veredicto === 'sirve');
  if (sirvieron.length) {
    const conPorQue = sirvieron.filter(n => dice(n));
    const pelados = sirvieron.filter(n => !dice(n));
    const elegidos = [...conPorQue, ...pelados].slice(0, MAX_UTILES);
    const afuera = sirvieron.length - elegidos.length;

    secciones.push(
      'QUÉ LES SIRVIÓ — es para calibrar QUÉ TIPO de hallazgo vale la pena contarles.',
      'NO es un pedido de volver a emitir estos hallazgos, y nunca alcanza para afirmar',
      'algo que las señales de este período no digan:',
      ...elegidos.map(n => {
        const sobre = n.hallazgo ? ` "${n.hallazgo}"` : '';
        return dice(n)
          ? `- [${cuando(n)}] a ${quien(n)} le sirvió${sobre}, porque: ${dice(n)}`
          : `- [${cuando(n)}] a ${quien(n)} le sirvió${sobre}`;
      }),
      ...(afuera > 0 ? [`(y ${afuera} más que marcaron como útiles, sin comentario)`] : []),
      ''
    );
  }

  if (!secciones.length) return '';

  return ['',
    `LO QUE YA TE DIJERON LOS DUEÑOS (${vigentes.length} notas acumuladas):`,
    'No son datos de este período: son el criterio con el que tenés que leerlos.',
    '',
    ...secciones,
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = {
  listarNotas, guardarNota, agregarTexto, archivarNota, escalonesDe, bloqueParaModelo,
  HOJA, HEADER, VEREDICTOS, DIAS_VIGENCIA, MAX_UTILES,
};
