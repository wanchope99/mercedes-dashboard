// ─── Informes automáticos: núcleo ───────────────────────────────────────────
//
// Tres agentes que miran los datos solos y dejan un informe corto en la app:
//
//   · movimientos (semanal, domingos)  — la plata: qué se gastó y qué llama la atención
//   · servicios   (semanal, domingos)  — el salón: pax, ingresos, qué se vendió, horarios
//   · mensual     (día 1)              — balance ejecutivo del mes cerrado
//
// Los tres comparten la misma forma: un ANALISTA (código puro) calcula todo y
// produce señales con sus números exactos; después el modelo interpreta esas
// señales ya calculadas. El modelo nunca ve los datos crudos y nunca calcula
// un número — sólo puede citar los que se le pasan. Un número inventado en un
// informe de plata es peor que no tener informe.
//
// Cada analista vive en su propio archivo y exporta { TIPO, TITULO, analizar,
// SISTEMA, periodoDe }. Agregar un cuarto agente es agregar un archivo y una
// línea en ANALISTAS: nada más de este núcleo cambia.
//
// Persistencia: hoja "Informes" en SPREADSHEET_ID, creada al primer uso.
// Todos los analistas son de SÓLO LECTURA: ningún informe escribe en el libro.

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const HOJA = process.env.INFORMES_SHEET || 'Informes';
const HEADER = ['Fecha', 'Tipo', 'Periodo', 'Titular', 'Resumen', 'Hallazgos', 'Accion', 'Severidad', 'Leidos', 'Generado', 'Modelo'];

// El modelo más capaz. Esto corre unas diez veces por mes sobre payloads chicos:
// el costo es de centavos y no hay razón para resignar criterio.
const MODELO = process.env.INFORMES_MODEL || 'claude-opus-5';

const ANALISTAS = {
  movimientos: require('./informe-movimientos'),
  servicios: require('./informe-servicios'),
  mensual: require('./informe-mensual'),
};

const TIPOS = Object.keys(ANALISTAS);

// ─── Utilidades compartidas por los analistas ───────────────────────────────
// Mediana y MAD en vez de promedio y desvío: un solo mes con una compra grande
// arrastra el promedio y después nada parece raro. La mediana no se mueve por
// un outlier, que es justo lo que queremos detectar.
function mediana(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(xs, med) {
  if (!xs.length) return 0;
  // 1.4826 lleva la MAD a la escala de un desvío estándar, para que "4 desvíos"
  // signifique lo mismo que significaría con uno normal.
  return 1.4826 * mediana(xs.map(x => Math.abs(x - med)));
}

// Escala de comparación. Si la MAD es cero (la serie es idéntica siempre)
// cualquier cambio es señal, pero hace falta un mínimo para no marcar $1.
const escalaDe = (xs, med) => { const m = mad(xs, med); return m > 0 ? m : Math.abs(med) * 0.25; };

const norm = s => (s || '').toString().trim().toLowerCase();
const diaISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const diasEntre = (a, b) => Math.round((b - a) / 86400000);
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ─── El esquema de salida, uno solo para los tres ───────────────────────────
// Un solo esquema significa una sola pantalla que los muestra. El mensual usa
// además `resumen`, que los semanales dejan vacío.
const ESQUEMA = {
  type: 'object',
  properties: {
    titular: { type: 'string', description: 'Una línea. Si no hay nada que decir, decilo en una línea.' },
    hayHallazgos: { type: 'boolean' },
    resumen: { type: 'string', description: 'Sólo el balance mensual lo usa: dos o tres frases de panorama. En los semanales, string vacío.' },
    hallazgos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          severidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
          quePasa: { type: 'string' },
          porQueImporta: { type: 'string' },
          confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
          referencias: { type: 'array', items: { type: 'string' }, description: 'Filas, fechas o categorías que lo respaldan' },
        },
        required: ['titulo', 'severidad', 'quePasa', 'porQueImporta', 'confianza', 'referencias'],
        additionalProperties: false,
      },
    },
    loQueHariaHoy: { type: 'string', description: 'Una sola frase.' },
  },
  required: ['titular', 'hayHallazgos', 'resumen', 'hallazgos', 'loQueHariaHoy'],
  additionalProperties: false,
};

// Reglas que valen para los tres agentes. Lo propio de cada uno va en su archivo.
const SISTEMA_COMUN = `Sos el analista de datos del bar Mercedes (Buenos Aires). Escribís para los dueños.

Tu trabajo es decir qué está diciendo la información, no describirla.

Cómo trabajar:
1. Te llegan DATOS y SEÑALES ya calculados por código. Todos los números están hechos.
2. Para cada señal preguntate: ¿esto es interesante o es obvio? Sacá lo obvio.
3. Si dos señales son la misma historia, contala una sola vez.
4. Ordená por importancia — por lo que le cambia la decisión al dueño, no por el orden en que te llegaron.
5. Si un número sorprende, explicá por qué sorprende.

Reglas:
- NO calcules ni estimes ningún número. Usá solamente los que te llegan, tal cual. Si para decir algo necesitás un número que no tenés, decí que no lo podés afirmar.
- Nunca describas lo que contienen los datos. Interpretá lo que significan.
- Si los datos no alcanzan para responder algo, decilo derecho en vez de estirar la interpretación.
- Escribí corto y en español rioplatense. Sin relleno, sin repetir el dato en la explicación.

Contexto del negocio, que cambia cómo se lee todo:
- Argentina con inflación de ~1,9% mensual. Que algo suba en pesos es lo normal, no un hallazgo. Las señales ya vienen comparadas contra la mediana móvil de las semanas previas, que absorbe la inflación: lo que te llega ya se despegó de esa deriva.
- El bar abre de noche y cierra los lunes. Un martes flojo no es una anomalía; compará cada día contra el mismo día de semana.
- Las compras en cuotas figuran una sola vez, en el mes de la compra.
- Los movimientos entre cajas propias no son ni ingreso ni gasto y no te llegan.`;

// ─── La llamada ─────────────────────────────────────────────────────────────
async function interpretar({ sistema, payload }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY');
  const client = new Anthropic({ apiKey });

  const base = {
    model: MODELO,
    max_tokens: 16000,
    system: `${SISTEMA_COMUN}\n\n${sistema}`,
    messages: [{ role: 'user', content: payload }],
    output_config: { effort: 'high', format: { type: 'json_schema', schema: ESQUEMA } },
  };

  // Los clasificadores pueden rechazar un pedido; con `fallbacks` el reintento
  // lo resuelve el servidor. Va envuelto porque esto corre solo: si algún día
  // la bandera beta deja de estar, el informe sale igual en vez de no salir.
  let resp;
  try {
    resp = await client.beta.messages.create({
      ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    });
  } catch (e) {
    resp = await client.messages.create(base);
  }

  if (resp.stop_reason === 'refusal') throw new Error('El modelo no procesó el pedido');
  const texto = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { ...JSON.parse(texto), modelo: resp.model, uso: resp.usage };
}

// ─── Persistencia ───────────────────────────────────────────────────────────
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
      spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A1:K1`,
      valueInputOption: 'RAW', requestBody: { values: [HEADER] },
    });
  } catch (e) { /* ya existía */ }
}

const severidadMaxima = h => {
  const orden = { alta: 3, media: 2, baja: 1 };
  return (h || []).reduce((peor, x) => (orden[x.severidad] > orden[peor] ? x.severidad : peor), 'baja');
};

async function listarInformes({ limite = 40, tipo } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  let filas = [];
  try {
    const r = await _sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:K` });
    filas = r.data.values || [];
  } catch (e) { return []; }

  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || !f[0]) continue;
    let hallazgos = [];
    try { hallazgos = JSON.parse(f[5] || '[]'); } catch (e) { hallazgos = []; }
    const inf = {
      rowIndex: i + 1, fecha: f[0], tipo: f[1] || 'movimientos', periodo: f[2] || '',
      titular: f[3] || '', resumen: f[4] || '', hallazgos, loQueHariaHoy: f[6] || '',
      severidad: f[7] || 'baja',
      leidos: (f[8] || '').split(',').map(s => s.trim()).filter(Boolean),
      generado: f[9] || '', modelo: f[10] || '',
      titulo: (ANALISTAS[f[1]] || {}).TITULO || f[1] || 'Informe',
    };
    if (tipo && inf.tipo !== tipo) continue;
    out.push(inf);
  }
  return out.sort((a, b) => (b.generado || b.fecha || '').localeCompare(a.generado || a.fecha || '')).slice(0, limite);
}

async function marcarLeido({ tipo, periodo, usuario }) {
  if (!usuario) throw new Error('Falta el usuario');
  const informes = await listarInformes({ limite: 500 });
  const inf = informes.find(i => i.tipo === tipo && i.periodo === periodo);
  if (!inf) throw new Error('No hay informe para ese período');
  if (inf.leidos.includes(usuario)) return inf;
  const leidos = [...inf.leidos, usuario];
  await _sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!I${inf.rowIndex}`,
    valueInputOption: 'RAW', requestBody: { values: [[leidos.join(', ')]] },
  });
  return { ...inf, leidos };
}

// ─── Generar ────────────────────────────────────────────────────────────────
// Idempotente por (tipo, período): si ya existe el informe de esa semana o de
// ese mes no se regenera, así un reinicio del server no dispara una segunda
// llamada al modelo.
async function generarInforme(tipo, { hasta, forzar = false } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  const analista = ANALISTAS[tipo];
  if (!analista) throw new Error(`Tipo de informe desconocido: ${tipo} (${TIPOS.join(' | ')})`);

  const corte = hasta ? new Date(hasta) : new Date();
  const periodo = analista.periodoDe(corte);

  if (!forzar) {
    const previos = await listarInformes({ limite: 200, tipo });
    const yaEsta = previos.find(i => i.periodo === periodo);
    if (yaEsta) return { ...yaEsta, yaExistia: true };
  }

  const { payload, senales } = await analista.analizar({ hasta: corte });
  const informe = await interpretar({ sistema: analista.SISTEMA, payload });

  const api = _sheets();
  await _ensureHoja(api);
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:K`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        diaISO(corte), tipo, periodo, informe.titular, informe.resumen || '',
        JSON.stringify(informe.hallazgos || []), informe.loQueHariaHoy,
        severidadMaxima(informe.hallazgos), '', new Date().toISOString(), informe.modelo || MODELO,
      ]],
    },
  });

  return {
    fecha: diaISO(corte), tipo, periodo, titulo: analista.TITULO, ...informe,
    leidos: [], severidad: severidadMaxima(informe.hallazgos), senales,
  };
}

module.exports = {
  generarInforme, listarInformes, marcarLeido, interpretar,
  ANALISTAS, TIPOS, HOJA, MODELO, ESQUEMA, SISTEMA_COMUN,
  // utilidades que usan los analistas
  mediana, mad, escalaDe, norm, diaISO, diasEntre, DIAS_SEMANA,
};
