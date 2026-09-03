// ─── Config por proveedor (medio de pago habitual + criterio de IVA) ────────────
//
// El medio de pago y el criterio "con/sin IVA" son atributos del PROVEEDOR, no de
// cada producto. Se guardan en la hoja "Proveedores" de la planilla Gestion
// Mercedes (SPREADSHEET_ID), que ya tiene: A Proveedor · B Plazo · C Medio de Pago
// · D Datos para pagar · E Comentarios. Le sumamos una columna para el IVA.
//
// IVA del proveedor: "con" (le pagamos con IVA / nos discrimina IVA) o "sin".
// Se usa para decidir qué precio compara el gráfico a lo largo del tiempo.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 120 });

// La hoja Proveedores vive en la planilla de GESTIÓN (no en la de comparación).
const GESTION_SHEET_ID = process.env.SPREADSHEET_ID;
const PROVEEDORES_HOJA = process.env.PROVEEDORES_HOJA_CONFIG || 'Proveedores';
// Columna donde guardamos el criterio de IVA (header "IVA"). Si no existe, se crea.
const IVA_HEADER = 'IVA';

function sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function norm(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Lee la hoja Proveedores → { nombreLower: { nombre, plazoDias, medioPago, iva, rowIndex } }
// iva: 'con' | 'sin' | null
async function leerConfig() {
  const cached = cache.get('prov_config');
  if (cached) return cached;
  if (!GESTION_SHEET_ID) return { byNombre: {}, ivaColLetter: null, headerRow: 1 };

  const api = sheets();
  let rows = [];
  try {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z`,
    });
    rows = res.data.values || [];
  } catch (e) { return { byNombre: {}, ivaColLetter: null, headerRow: 1 }; }

  // Encontrar fila de encabezado (la que tiene "Proveedor" en A)
  let hIdx = rows.findIndex(r => norm(r && r[0]) === 'proveedor');
  if (hIdx === -1) hIdx = 0;
  const header = (rows[hIdx] || []).map(norm);
  const idxNombre = 0;
  const idxPlazo = header.findIndex(h => h.includes('plazo'));
  const idxMedio = header.findIndex(h => h.includes('medio') || h.includes('forma'));
  let idxIva = header.findIndex(h => h === 'iva' || (h.includes('iva') && !h.includes('deducible') && !h.includes('incluido')));
  // Columnas fiscales nuevas (memoria por proveedor)
  const idxDeducible = header.findIndex(h => h.includes('deducible'));
  const idxDescIncl = header.findIndex(h => h.includes('descuento') && h.includes('incluido'));
  const idxIvaIncl  = header.findIndex(h => h.includes('iva') && h.includes('incluido'));
  // Categoría del GASTO (columna J de Movimientos), no la del producto. La crea
  // setAtributoProveedor la primera vez que alguien contesta la pregunta.
  const idxCatGasto = header.findIndex(h => h.includes('categoria') && h.includes('gasto'));
  // Cómo se le suele pagar a este proveedor: 'pagado' | 'al-recibir' | 'a-pagar'.
  // NO es un default que se escriba solo — es lo que el bot PROPONE en pantalla
  // para que se confirme de un toque. La diferencia importa: `pagoPrevisto` es
  // la intención de quien compra y escribir una que nadie dijo es lo que hace
  // que esa columna deje de ser creíble.
  const idxPagoHab = header.findIndex(h => h.includes('pago') && h.includes('habitual'));
  // De dónde salió la ficha fiscal. 'manual' es lo que cargó una persona y NO se
  // pisa nunca solo (la regla vive en fiscal-proveedores.js). Se lee acá para
  // que quien vaya a escribir pueda respetarla sin levantar el padrón entero.
  const idxFuenteFiscal = header.findIndex(h => h.includes('fuente') && h.includes('fiscal'));

  const ivaColLetter = idxIva >= 0 ? colLetter(idxIva) : null;
  const boolSN = v => { const x = norm(v); if (!x) return null; return (x.startsWith('s')||x==='si'||x==='sí'||x==='true') ? true : (x.startsWith('n')||x==='false' ? false : null); };

  const byNombre = {};
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[idxNombre]) continue;
    const nombre = r[idxNombre].toString().trim();
    if (!nombre) continue;
    const plazoRaw = idxPlazo >= 0 ? parseInt(String(r[idxPlazo] || '').replace(/[^0-9]/g, '')) : NaN;
    const ivaRaw = idxIva >= 0 ? norm(r[idxIva]) : '';
    let iva = null;
    if (ivaRaw.startsWith('con') || ivaRaw === 'si' || ivaRaw === 'sí' || ivaRaw.includes('c/iva')) iva = 'con';
    else if (ivaRaw.startsWith('sin') || ivaRaw === 'no' || ivaRaw.includes('s/iva')) iva = 'sin';
    byNombre[norm(nombre)] = {
      nombre,
      plazoDias: Number.isFinite(plazoRaw) ? plazoRaw : null,
      medioPago: idxMedio >= 0 ? (r[idxMedio] || '').toString().trim() : '',
      iva,
      ivaDeducible: idxDeducible >= 0 ? boolSN(r[idxDeducible]) : null,
      descuentoIncluido: idxDescIncl >= 0 ? boolSN(r[idxDescIncl]) : null,
      ivaIncluido: idxIvaIncl >= 0 ? boolSN(r[idxIvaIncl]) : null,
      categoriaGasto: idxCatGasto >= 0 ? (r[idxCatGasto] || '').toString().trim() : '',
      pagoHabitual: idxPagoHab >= 0 ? normPagoHabitual(r[idxPagoHab]) : null,
      fuenteFiscal: idxFuenteFiscal >= 0 ? (r[idxFuenteFiscal] || '').toString().trim() : '',
      rowIndex: i + 1,
    };
  }

  const out = { byNombre, ivaColLetter, idxIva, idxDeducible, idxDescIncl, idxIvaIncl, idxCatGasto, idxPagoHab, headerRow: hIdx + 1, headerLen: header.length };
  cache.set('prov_config', out);
  return out;
}

// Cualquier cosa que no sea uno de los tres valores vuelve null: "no se sabe",
// que es lo que hace que se pregunte en vez de proponer algo inventado.
function normPagoHabitual(v) {
  const s = norm(v);
  if (s === 'pagado' || s === 'al-recibir' || s === 'a-pagar') return s;
  return null;
}

function colLetter(idx0) {
  // 0 → A, 1 → B, ...
  let n = idx0, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Devuelve la config de un proveedor (o null si no está cargado).
async function getProveedor(nombre) {
  const cfg = await leerConfig();
  return cfg.byNombre[norm(nombre)] || null;
}

// Setea el criterio de IVA de un proveedor ('con'|'sin'). Si el proveedor no
// existe como fila, lo agrega. Si no existe la columna IVA, la crea en el header.
async function setIvaProveedor(nombre, iva) {
  if (!GESTION_SHEET_ID) return;
  const api = sheets();
  let cfg = await leerConfig();

  // Asegurar columna IVA
  let ivaCol = cfg.ivaColLetter;
  if (!ivaCol) {
    const newIdx = cfg.headerLen || 5;
    ivaCol = colLetter(newIdx);
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${ivaCol}${cfg.headerRow}`,
      valueInputOption: 'RAW', requestBody: { values: [[IVA_HEADER]] },
    });
    cache.del('prov_config');
    cfg = await leerConfig();
    ivaCol = cfg.ivaColLetter || ivaCol;
  }

  const valor = iva === 'con' ? 'Con IVA' : 'Sin IVA';
  const existente = cfg.byNombre[norm(nombre)];
  if (existente) {
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${ivaCol}${existente.rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [[valor]] },
    });
  } else {
    // Agregar fila nueva con nombre + IVA (en su columna)
    const row = [];
    row[0] = nombre;
    const ivaIdx = ivaCol.charCodeAt(0) - 65;
    row[ivaIdx] = valor;
    while (row.length <= ivaIdx) if (row.length < ivaIdx) row.push('');
    await api.spreadsheets.values.append({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!A:Z`,
      valueInputOption: 'RAW', requestBody: { values: [row] },
    });
  }
  cache.del('prov_config');
}

// Setea un atributo arbitrario de un proveedor por NOMBRE DE COLUMNA (header).
// Si la columna no existe, la crea al final del header. Si el proveedor no existe
// como fila, agrega una nueva. Devuelve sin romper si no hay GESTION_SHEET_ID.
async function setAtributoProveedor(nombre, headerNombre, valor) {
  if (!GESTION_SHEET_ID) return;
  const api = sheets();
  let cfg = await leerConfig();
  // Buscar la columna por header (case/acentos-insensible)
  const res0 = await api.spreadsheets.values.get({ spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z` });
  const rows0 = res0.data.values || [];
  let hIdx = rows0.findIndex(r => norm(r && r[0]) === 'proveedor'); if (hIdx === -1) hIdx = 0;
  const header = (rows0[hIdx] || []).map(norm);
  let colIdx = header.findIndex(h => h === norm(headerNombre));
  if (colIdx === -1) {
    colIdx = (rows0[hIdx] || []).length;  // primera columna libre del header
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${colLetter(colIdx)}${hIdx + 1}`,
      valueInputOption: 'RAW', requestBody: { values: [[headerNombre]] },
    });
  }
  const colL = colLetter(colIdx);
  const existente = cfg.byNombre[norm(nombre)];
  if (existente) {
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${PROVEEDORES_HOJA}!${colL}${existente.rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [[valor]] },
    });
  } else {
    const row = []; row[0] = nombre; row[colIdx] = valor;
    for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = '';
    await api.spreadsheets.values.append({
      spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z`,
      valueInputOption: 'RAW', requestBody: { values: [row] },
    });
  }
  cache.del('prov_config');
}

// ─── Guardar VARIOS atributos de un proveedor en una sola vuelta ──────────────
//
// Por qué existe: contra Google Sheets lo caro es la CANTIDAD de llamadas, no
// el tamaño. Medido el 12/08/2026: leer una sola celda tarda 611 ms y leer las
// 1.166 filas de Movimientos tarda 461 ms. Es todo latencia de ida y vuelta.
//
// Al confirmar una factura se guardaban seis atributos con seis llamadas a
// setAtributoProveedor, y cada una hacía su propia lectura A:Z más su escritura
// —y setMedioProveedor hacía una lectura extra encima—: unas 14 idas y vueltas,
// cerca de 4,5 segundos de la espera del usuario.
//
// Y lo peor: reescribía los mismos valores TODAS las veces. A partir de la
// segunda factura de un proveedor, esos seis valores ya son los que están en la
// hoja, así que eran 14 llamadas para no cambiar nada.
//
// Acá: UNA lectura, se descarta lo que no cambió, y UNA escritura con todo
// junto. Si no cambió nada, cero escrituras.
//
// `mapa` es { 'Nombre de la columna': valor }. Una columna que no existe se crea.
async function setAtributosProveedor(nombre, mapa = {}) {
  if (!GESTION_SHEET_ID || !nombre) return { escritas: 0, llamadas: 0 };
  const entradas = Object.entries(mapa).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entradas.length) return { escritas: 0, llamadas: 0 };

  const api = sheets();
  let llamadas = 1;
  const res0 = await api.spreadsheets.values.get({ spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z` });
  const rows0 = res0.data.values || [];
  let hIdx = rows0.findIndex(r => norm(r && r[0]) === 'proveedor'); if (hIdx === -1) hIdx = 0;
  const headerRaw = rows0[hIdx] || [];
  const header = headerRaw.map(norm);

  // Fila del proveedor (1-based). Si no está, se agrega entera al final.
  let filaIdx = -1;
  for (let i = hIdx + 1; i < rows0.length; i++) {
    if (rows0[i] && norm(rows0[i][0]) === norm(nombre)) { filaIdx = i; break; }
  }

  // Resolver la columna de cada atributo, creando las que falten.
  let proxLibre = headerRaw.length;
  const nuevasCols = [];
  const destino = [];
  for (const [col, valor] of entradas) {
    let idx = header.findIndex(h => h === norm(col));
    // "Medio de Pago" y "Forma de Pago" son la misma columna: en esta hoja se
    // llama de una u otra forma según quién la creó. Sin este alias se crearía
    // una columna duplicada y leerConfig seguiría leyendo la vieja.
    if (idx === -1 && (norm(col).includes('medio') || norm(col).includes('forma'))) {
      idx = header.findIndex(h => h.includes('medio') || h.includes('forma'));
    }
    if (idx === -1) {
      idx = proxLibre++;
      nuevasCols.push({ idx, nombre: col });
      header[idx] = norm(col);
    }
    destino.push({ idx, valor: String(valor) });
  }

  // Proveedor nuevo: una sola escritura con la fila completa.
  if (filaIdx === -1) {
    const row = [];
    row[0] = nombre;
    for (const d of destino) row[d.idx] = d.valor;
    for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = '';
    const data = nuevasCols.map(c => ({
      range: `${PROVEEDORES_HOJA}!${colLetter(c.idx)}${hIdx + 1}`, values: [[c.nombre]],
    }));
    if (data.length) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: GESTION_SHEET_ID, requestBody: { valueInputOption: 'RAW', data },
      });
      llamadas++;
    }
    await api.spreadsheets.values.append({
      spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z`,
      valueInputOption: 'RAW', requestBody: { values: [row] },
    });
    llamadas++;
    cache.del('prov_config');
    return { escritas: destino.length, llamadas, filaNueva: true };
  }

  // Proveedor existente: sólo lo que realmente cambia.
  const actual = rows0[filaIdx] || [];
  const data = nuevasCols.map(c => ({
    range: `${PROVEEDORES_HOJA}!${colLetter(c.idx)}${hIdx + 1}`, values: [[c.nombre]],
  }));
  let escritas = 0;
  for (const d of destino) {
    const previo = (actual[d.idx] ?? '').toString().trim();
    if (previo === d.valor) continue;          // ya está así: no se toca
    data.push({
      range: `${PROVEEDORES_HOJA}!${colLetter(d.idx)}${filaIdx + 1}`, values: [[d.valor]],
    });
    escritas++;
  }
  if (data.length) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: GESTION_SHEET_ID, requestBody: { valueInputOption: 'RAW', data },
    });
    llamadas++;
    cache.del('prov_config');
  }
  return { escritas, llamadas };
}

// ─── Borrar lo que el bot aprendió, para empezar de cero ────────────────────
//
// Decisión del dueño (02/09/2026): que a cada proveedor se le pregunte una vez
// todo el juego nuevo —pago, entrega, IVA— en vez de arrastrar respuestas que
// se dieron a otras preguntas.
//
// El caso que lo justifica solo es `IVA Deducible`. Esa columna contesta "¿esta
// factura sirve para descontar IVA?" bajo el régimen de HOY, donde el bar es
// monotributista y no descuenta IVA de nada: por eso hay proveedores en `N` que
// SÍ emiten factura A (ver el comentario largo en fiscal-proveedores.js). Bajo
// la regla nueva —deducible ⟺ factura A— ese dato no está incompleto, está al
// revés, y dejarlo es peor que no tenerlo.
//
// ─── Qué NO se toca, y por qué ──────────────────────────────────────────────
//
// Sólo se vacían las columnas que creó el bot. `Proveedor`, `Plazo`, `Datos para
// pagar` y `Comentarios` los cargó una persona. `Medio de Pago` también, y
// además la lee la sección Pagos cuando una fila no dice el medio: vaciarla
// rompería algo que no tiene nada que ver con el bot. Las fiscales (`CUIT`,
// `Condicion Fiscal`, `Comprobante Habitual`, `Alicuota IVA`) son relevamiento a
// mano —16 de 20 proveedores— y tampoco son conocimiento del bot.
const COLUMNAS_APRENDIZAJE = [
  'IVA', 'IVA Deducible', 'Descuento Incluido', 'IVA Incluido',
  'Categoria Gasto', 'Pago Habitual',
];

// Las columnas jamás se resuelven por letra: en esta hoja se fueron agregando a
// la derecha en el orden en que se preguntaron por primera vez, así que la letra
// depende del historial de cada instalación.
//
// Y para BORRAR se exige el nombre EXACTO, sin las heurísticas de `leerConfig`.
// Ahí `idxIva` acepta cualquier header que contenga "iva" y no diga "deducible"
// ni "incluido" — lo que incluye a `Alicuota IVA`, que es relevamiento fiscal y
// no se toca. Una heurística que de más es aceptable para leer y no lo es para
// vaciar.
async function resetAprendizaje({ dryRun = true } = {}) {
  if (!GESTION_SHEET_ID) return { ok: false, error: 'No hay SPREADSHEET_ID configurado.' };
  const api = sheets();

  const res0 = await api.spreadsheets.values.get({
    spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z`,
  });
  const rows = res0.data.values || [];
  if (!rows.length) return { ok: false, error: 'La hoja Proveedores está vacía.' };

  let hIdx = rows.findIndex(r => norm(r && r[0]) === 'proveedor');
  if (hIdx === -1) hIdx = 0;
  const headerRaw = rows[hIdx] || [];
  const header = headerRaw.map(norm);

  const columnas = [];
  const noEncontradas = [];
  for (const nombre of COLUMNAS_APRENDIZAJE) {
    const idx = header.findIndex(h => h === norm(nombre));
    if (idx === -1) { noEncontradas.push(nombre); continue; }
    columnas.push({ nombre: headerRaw[idx], idx, letra: colLetter(idx) });
  }

  // Qué celdas tienen algo escrito. Una celda vacía no se toca: escribirle un
  // vacío encima sería una llamada para no cambiar nada.
  const aVaciar = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const proveedor = (r[0] || '').toString().trim();
    if (!proveedor) continue;
    for (const c of columnas) {
      const valor = (r[c.idx] ?? '').toString().trim();
      if (!valor) continue;
      aVaciar.push({ proveedor, columna: c.nombre, valor, rango: `${PROVEEDORES_HOJA}!${c.letra}${i + 1}` });
    }
  }

  const plan = {
    ok: true, dryRun,
    columnas: columnas.map(c => c.nombre),
    columnasNoEncontradas: noEncontradas,
    // Lo que se deja explícitamente, para que se pueda leer en la respuesta y no
    // haya que confiar en que el código hace lo que dice el comentario.
    intactas: headerRaw.filter((h, i) => h && !columnas.some(c => c.idx === i)),
    proveedores: [...new Set(aVaciar.map(x => x.proveedor))].length,
    celdas: aVaciar.length,
    detalle: aVaciar,
    backup: '',
  };

  if (dryRun) return plan;
  if (!aVaciar.length) return { ...plan, message: 'No había nada aprendido para borrar.' };

  // ─── Backup ANTES de tocar nada ───────────────────────────────────────────
  // Se copia la hoja ENTERA y no sólo las columnas que se vacían: una copia
  // parcial no se puede restaurar sola, hay que saber a qué fila iba cada valor.
  // La fecha es la de ACÁ, no la UTC: a las 21:30 de un martes `toISOString()`
  // ya dice miércoles, y la hoja quedaría nombrada con el día de mañana. Es la
  // regla de zona horaria de toda la app.
  const hoyAR = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const nombreBackup = `Proveedores Backup ${hoyAR}`;
  try {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: GESTION_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: nombreBackup } } }] },
    });
  } catch (e) {
    // Ya existe (se corrió dos veces el mismo día): se sobrescribe con lo que
    // hay ahora, que sigue siendo el estado previo a ESTE borrado.
    if (!/already exists/i.test(e.message || '')) {
      return { ok: false, error: `No se pudo crear el backup (${e.message}). No se borró nada.` };
    }
  }
  try {
    await api.spreadsheets.values.update({
      spreadsheetId: GESTION_SHEET_ID,
      range: `${nombreBackup}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  } catch (e) {
    return { ok: false, error: `No se pudo escribir el backup (${e.message}). No se borró nada.` };
  }

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: GESTION_SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: aVaciar.map(x => ({ range: x.rango, values: [['']] })),
    },
  });
  cache.del('prov_config');

  return { ...plan, backup: nombreBackup, message: `Se vaciaron ${aVaciar.length} celdas. La copia quedó en "${nombreBackup}".` };
}

// El header real de la columna de medio de pago, que en esta hoja puede llamarse
// "Medio de Pago" o "Forma de Pago" según quién la creó.
function headerMedioDe(headerRaw) {
  const idx = (headerRaw || []).findIndex(h => { const n = norm(h); return n.includes('medio') || n.includes('forma'); });
  return idx >= 0 ? headerRaw[idx] : 'Medio de Pago';
}

// Helpers fiscales: guardan S/N por proveedor.
const _sn = b => b ? 'S' : 'N';
async function setIvaDeducible(nombre, b)       { return setAtributoProveedor(nombre, 'IVA Deducible', _sn(b)); }
async function setDescuentoIncluido(nombre, b)  { return setAtributoProveedor(nombre, 'Descuento Incluido', _sn(b)); }
async function setIvaIncluido(nombre, b)        { return setAtributoProveedor(nombre, 'IVA Incluido', _sn(b)); }

// Guarda el MEDIO DE PAGO habitual de un proveedor para no volver a preguntarlo.
// Escribe en la columna de medio existente (header con "medio" o "forma"); si no
// existe, crea "Medio de Pago". Reutiliza setAtributoProveedor para crear/actualizar.
async function setMedioProveedor(nombre, medio) {
  if (!GESTION_SHEET_ID || !nombre || !medio) return;
  // Detectar el header real del medio para que leerConfig() lo lea despues.
  let headerMedio = 'Medio de Pago';
  try {
    const api = sheets();
    const res0 = await api.spreadsheets.values.get({ spreadsheetId: GESTION_SHEET_ID, range: `${PROVEEDORES_HOJA}!A:Z` });
    const rows0 = res0.data.values || [];
    let hIdx = rows0.findIndex(r => norm(r && r[0]) === 'proveedor'); if (hIdx === -1) hIdx = 0;
    const headerRaw = rows0[hIdx] || [];
    const idx = headerRaw.findIndex(h => { const n = norm(h); return n.includes('medio') || n.includes('forma'); });
    if (idx >= 0) headerMedio = headerRaw[idx];  // usar el header existente tal cual
  } catch (e) { /* si falla la deteccion, usar el default */ }
  return setAtributoProveedor(nombre, headerMedio, medio);
}

function clearConfigCache() { cache.flushAll(); }

module.exports = { leerConfig, getProveedor, setIvaProveedor, setMedioProveedor, setAtributoProveedor, setIvaDeducible, setDescuentoIncluido, setIvaIncluido, clearConfigCache, norm,
  // Guarda varios atributos en UNA lectura + UNA escritura, salteando lo que no
  // cambió. Es lo que hay que usar cuando se guarda más de un atributo junto.
  setAtributosProveedor, headerMedioDe,
  // Borra lo que el bot aprendió, para empezar de cero. dryRun por default.
  resetAprendizaje, COLUMNAS_APRENDIZAJE };
