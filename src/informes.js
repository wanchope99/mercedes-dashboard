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

const notasMod = require('./informes-notas');

// Las notas nunca deben tumbar un informe: si la hoja no se puede leer, el
// informe sale sin el feedback, que es peor que con él pero muchísimo mejor que
// no salir. Distinto de la lista de informes previos, donde no poder leer sí
// obliga a frenar (ahí el riesgo es duplicar).
async function notasDelAgente(tipo) {
  try { return await notasMod.listarNotas({ tipo }); }
  catch (e) { console.error(`Informes: no se pudieron leer las notas (${e.message}) — el informe sale sin ellas`); return []; }
}

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
          // Estos dos no son para leer: son para que el dueño pueda marcar
          // "esto cambió para siempre" con un solo clic, sin tener que volver a
          // escribir a mano de qué proveedor habla el hallazgo ni desde cuándo.
          // Ver informes-notas.js y el bloque de feedback en index.html.
          concepto: {
            type: 'string',
            description: 'El proveedor o entidad concreta de la que habla el hallazgo, copiado TAL CUAL de la señal (ej: "ARCA"). String vacío si el hallazgo no es sobre uno solo.',
          },
          desdeISO: {
            type: 'string',
            description: 'AAAA-MM-DD del movimiento que dispara el hallazgo, copiado tal cual de la señal. String vacío si no hay una fecha única.',
          },
        },
        required: ['titulo', 'severidad', 'quePasa', 'porQueImporta', 'confianza', 'referencias', 'concepto', 'desdeISO'],
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
- Los campos "concepto" y "desdeISO" de cada hallazgo NO se muestran: los usa la app para que el dueño pueda marcar un cambio permanente con un solo clic. Copiá el nombre del proveedor y la fecha TAL CUAL vienen en la señal, sin reformatear ni deducir. Si el hallazgo no es sobre un proveedor único o no tiene una fecha única, dejalos en string vacío — es preferible vacío que inventado.
- Si los datos no alcanzan para responder algo, decilo derecho en vez de estirar la interpretación.
- Escribí corto y en español rioplatense. Sin relleno, sin repetir el dato en la explicación.

Contexto del negocio, que cambia cómo se lee todo:
- Argentina con inflación de ~1,9% mensual. Que algo suba en pesos es lo normal, no un hallazgo. Las señales ya vienen comparadas contra la mediana móvil de las semanas previas, que absorbe la inflación: lo que te llega ya se despegó de esa deriva.
- El bar abre de noche y cierra los lunes. Un martes flojo no es una anomalía; compará cada día contra el mismo día de semana.
- Las compras en cuotas figuran una sola vez, en el mes de la compra.
- Los movimientos entre cajas propias no son ni ingreso ni gasto y no te llegan.

Si te llega un bloque "LO QUE VOS MISMO DIJISTE", es tu informe anterior. Leelo
ANTES de decidir qué contar, y usalo así:
- Lo que ya contaste no vuelve a contarse como si fuera nuevo. Si algo sigue
  igual, lo que importa es que SIGUE: "tercera semana seguida" es información,
  repetir el mismo hallazgo no lo es.
- Si algo que marcaste como alto ya no aparece, decilo en una línea. Que un
  problema se haya arreglado vale tanto como que haya aparecido, y si lo callás
  el dueño no sabe si se resolvió o si dejaste de mirarlo.
- Si esta vez leés los mismos datos distinto que la vez pasada, decilo y explicá
  por qué. No te contradigas en silencio.
- NO son datos de este período: no cites sus cifras como si fueran de ahora, y
  no las mezcles con las señales que te llegaron.
- Si no te llega ese bloque, es el primer informe de su tipo: no inventes que
  hubo uno anterior.

Si te llega un bloque "LO QUE YA TE DIJERON LOS DUEÑOS", son notas que ellos
escribieron sobre informes anteriores. Valen más que tu lectura de los números:
- Si te explicaron por qué algo es normal, NO lo vuelvas a levantar como hallazgo
  salvo que la magnitud haya cambiado de verdad respecto de lo que te contaron.
  Repetir algo que ya te dijeron que es normal es la forma más rápida de que
  dejen de leer el informe.
- Si dos personas dicen cosas distintas sobre lo mismo, decilo en vez de elegir
  una en silencio.
- Son explicaciones, no números: seguís sin poder calcular nada con ellas.
- Tienen fecha. El negocio cambia: una explicación vieja puede haber dejado de
  ser cierta, y si la nota ya no alcanza para explicar lo que ves, decilo.`;

// ─── El contexto operativo ──────────────────────────────────────────────────
//
// Lo que ya sabemos del negocio y hace que un número raro no sea raro. Vive en
// un .md al lado de este archivo, y no dentro de SISTEMA_COMUN, para que se
// pueda corregir sin tocar código ni volver a razonar sobre template literals.
//
// Va en el prompt de SISTEMA y no en el payload: es contexto estable, no datos
// de este período. Se lee en cada corrida (son diez por mes: cachearlo sólo
// serviría para que un cambio no tenga efecto hasta el próximo deploy).
const RUTA_CONTEXTO = require('path').join(__dirname, 'contexto-operativo.md');

function contextoOperativo() {
  try {
    const texto = require('fs').readFileSync(RUTA_CONTEXTO, 'utf8')
      // Se le saca el encabezado explicativo: las instrucciones de mantenimiento
      // son para quien edita el archivo, no para el modelo.
      .split(/^---$/m).slice(1).join('---').trim();
    if (!texto) return '';
    return `\n\nLO QUE YA SABEMOS DEL NEGOCIO (no lo descubras de nuevo ni lo presentes como hallazgo):\n\n${texto}`;
  } catch (e) {
    // Sin contexto el informe sale igual, sólo que más ingenuo. Nunca vale
    // perder la corrida por esto.
    console.error(`Informes: no se pudo leer contexto-operativo.md (${e.message}) — el informe sale sin él`);
    return '';
  }
}

// ─── La llamada ─────────────────────────────────────────────────────────────
async function interpretar({ sistema, payload }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY');
  const client = new Anthropic({ apiKey });

  const base = {
    model: MODELO,
    max_tokens: 16000,
    system: `${SISTEMA_COMUN}${contextoOperativo()}\n\n${sistema}`,
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

// La hoja todavía no existe: es el estado normal antes del primer informe, no
// una falla. Google contesta 400 "Unable to parse range" cuando el rango apunta
// a una pestaña que no está.
const esHojaInexistente = e => /unable to parse range/i.test(e.message || '');

// `estricto` distingue "no hay informes" de "no pude leer". Para mostrar la
// pantalla da igual (una lista vacía es una lista vacía), pero para decidir si
// hay que generar uno NO da igual: tragarse un error de Google ahí significaría
// creer que el informe de la semana no existe y generarlo de nuevo — una fila
// duplicada y una llamada al modelo al pedo. Con el catch-up de arranque eso
// pasaría en cada reinicio mientras Google esté caído, no una vez por semana.
async function listarInformes({ limite = 40, tipo, estricto = false } = {}) {
  if (!SPREADSHEET_ID) throw new Error('Falta SPREADSHEET_ID');
  let filas = [];
  try {
    const r = await _sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${HOJA}!A:K` });
    filas = r.data.values || [];
  } catch (e) {
    if (estricto && !esHojaInexistente(e)) throw e;
    return [];
  }

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

// ─── Lo que todavía no vio ──────────────────────────────────────────────────
// El aviso del domingo pregunta acá. Devuelve el ÚLTIMO informe de cada tipo, y
// sólo si el usuario no lo marcó leído.
//
// La condición sale del servidor y no de localStorage a propósito: el informe se
// lee tanto en el teléfono como en la computadora, y con localStorage cerrarlo
// en uno no lo cerraría en el otro. La columna `Leidos` ya existía para esto.
//
// Sólo el último de cada tipo: un informe viejo sin leer deja de molestar solo
// cuando llega el de la semana siguiente y lo reemplaza. Así el aviso nunca
// acumula atrasos ni se convierte en una pila que se cierra sin mirar.
async function pendientesPara(usuario) {
  if (!usuario) throw new Error('Falta el usuario');
  const todos = await listarInformes({ limite: 60 });
  // listarInformes ya viene ordenado del más nuevo al más viejo.
  return TIPOS
    .map(tipo => todos.find(i => i.tipo === tipo))
    .filter(inf => inf && !inf.leidos.includes(usuario));
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

// ─── Lo que dijo la vez pasada ──────────────────────────────────────────────
//
// Hasta el 9 de agosto de 2026 cada corrida arrancaba de cero: el agente no
// tenía forma de saber qué había dicho la semana anterior. Podía repetir el
// mismo hallazgo palabra por palabra sin enterarse, y sobre todo no podía decir
// lo único que un lector semanal quiere saber: si esto sigue pasando o si se
// arregló. Un hallazgo que va tres semanas seguidas es una historia distinta de
// tres hallazgos sueltos iguales.
//
// Van los últimos INFORMES_DE_CONTEXTO, no sólo el anterior, porque "tercera
// semana consecutiva" necesita más de una vuelta de memoria.
const INFORMES_DE_CONTEXTO = Number(process.env.INFORMES_CONTEXTO_PREVIOS || 2);

function bloqueInformeAnterior(previos, periodoActual) {
  const anteriores = (previos || [])
    .filter(i => i.periodo !== periodoActual)
    .slice(0, INFORMES_DE_CONTEXTO);
  if (!anteriores.length) return '';

  const partes = anteriores.map((i, idx) => {
    const cual = idx === 0 ? 'EL ANTERIOR' : `${idx + 1} INFORMES ATRÁS`;
    const hallazgos = (i.hallazgos || []).length
      ? i.hallazgos.map(h => `  · [${h.severidad}] ${h.titulo} — ${h.quePasa}`).join('\n')
      : '  · (sin hallazgos: esa vez no hubo nada que marcar)';
    return [`--- ${cual} (${i.periodo}) ---`, `Titular: ${i.titular}`,
            i.resumen ? `Resumen: ${i.resumen}` : null, 'Hallazgos:', hallazgos]
      .filter(Boolean).join('\n');
  });

  return ['', '', 'LO QUE VOS MISMO DIJISTE LA(S) VEZ(CES) PASADA(S):',
    '(Es tu informe anterior, NO son datos de este período. No cites sus números como si fueran de ahora.)',
    '', ...partes].join('\n');
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

  // Una sola lectura sirve para las dos cosas: chequear si el período ya está
  // hecho y saber qué dijo el informe anterior.
  //
  // estricto: si la planilla no se puede leer, frenamos acá. Generar "por las
  // dudas" duplicaría el informe de la semana.
  const previos = await listarInformes({ limite: 200, tipo, estricto: true });
  if (!forzar) {
    const yaEsta = previos.find(i => i.periodo === periodo);
    if (yaEsta) return { ...yaEsta, yaExistia: true };
  }

  // Las notas se leen UNA vez y van a los dos lados: el analista usa los
  // escalones (dato, para el código) y el modelo recibe el texto (criterio).
  // Ver src/informes-notas.js.
  const notas = await notasDelAgente(tipo);
  const { payload, senales } = await analista.analizar({ hasta: corte, notas });
  const informe = await interpretar({
    sistema: analista.SISTEMA,
    payload: payload
      + bloqueInformeAnterior(previos, periodo)
      + notasMod.bloqueParaModelo(notas, { ahora: corte }),
  });

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
  generarInforme, listarInformes, marcarLeido, pendientesPara, interpretar,
  // Exportadas para poder ejercitarlas sin llamar al modelo.
  bloqueInformeAnterior, contextoOperativo,
  ANALISTAS, TIPOS, HOJA, MODELO, ESQUEMA, SISTEMA_COMUN,
  // utilidades que usan los analistas
  mediana, mad, escalaDe, norm, diaISO, diasEntre, DIAS_SEMANA,
};
