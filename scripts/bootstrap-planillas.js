#!/usr/bin/env node
// ─── Armar las planillas de una instancia nueva ──────────────────────────────
//
// La app crea sola 26 hojas al primer uso. Cinco NO, y son justamente las que la
// app no puede inventar porque contienen los datos del negocio o fórmulas que
// pertenecen a la planilla: `Movimientos`, `Cajas`, `Arqueo de Cajas`,
// `Proveedores` y `Compras`. Hasta el 09/09/2026 había que hacerlas a mano, con
// los encabezados exactos, y dos de esos cinco fallan de la peor manera si algo
// está mal escrito:
//
//   · `Movimientos` se detecta por CONTENIDO —la fila donde A dice "Fecha" y B
//     dice "Mes"—. Si no aparece, `getMovimientos()` tira y la app entera se cae.
//   · `Cajas` calcula cada saldo con un SUMIFS por texto EXACTO contra la columna
//     L de `Movimientos`. Sin esa fórmula todos los saldos dan cero, y eso no da
//     ningún error: se ve como un bar que no movió plata nunca.
//
// ─── DRY RUN POR DEFECTO ────────────────────────────────────────────────────
//
// No escribe nada hasta que se lo pide con `--aplicar`, mismo criterio que
// `reset-aprendizaje` y la migración de Pedidos. Primero imprime qué haría.
//
//   node scripts/bootstrap-planillas.js              (muestra el plan)
//   node scripts/bootstrap-planillas.js --aplicar    (lo hace)
//
// Lee la configuración del entorno, igual que la app: `SPREADSHEET_ID`,
// `PROVEEDORES_SHEET_ID`, `GOOGLE_CREDENTIALS_JSON` y `CAJAS`. Correrlo con el
// entorno de la instancia nueva —nunca con el de otra— es toda la ceremonia.
//
// ─── Es idempotente y NO pisa nada ──────────────────────────────────────────
//
// Una hoja que ya existe se deja como está y se dice. Una hoja que existe pero
// con otro encabezado se REPORTA y no se toca: reescribir el encabezado de una
// planilla con datos adentro correría el significado de cada columna sin mover
// un solo dato, que es la forma más cara de romper esto.

require('dotenv').config();
const google = require('@googleapis/sheets');
const negocio = require('../src/config-negocio');
const cats = require('../src/proveedores-categorias');

const APLICAR = process.argv.includes('--aplicar');

// ─── Lo que hay que crear ────────────────────────────────────────────────────

const HEADER_MOVIMIENTOS = [
  'Fecha', 'Mes', 'Tipo', 'Estado', 'Vencimiento', 'Cuotas', 'Extraordinario',
  'ID Compra', 'Proveedor', 'Categoría', 'Descripción', 'Medio de pago',
  'Entrada ARS', 'Entrada USD', 'Salida ARS', 'Salida USD',
  'TC USD',            // Q — el tipo de cambio al que se hizo la operación
  '', '',              // R y S — bloque de saldos propio de la planilla, no se tocan
  'Blue del dia',      // T — lo completa el sistema (tc-movimientos.js)
];

const HEADER_CAJAS = [
  'Caja', 'Alias', 'Moneda', 'Entradas', 'Salidas',
  'Saldo Calculado', 'Saldo Real', 'Cobro Pendiente', 'Diff',
];

const HEADER_PROVEEDORES = [
  'Proveedor', 'Plazo', 'Medio de Pago', 'Datos para pagar', 'Comentarios',
];

const HEADER_COMPRAS = [
  'Fecha', 'Proveedor', 'Categoría', 'Producto', 'Cantidad', 'Unidad',
  'Precio Unit. ($)', 'Subtotal', 'Descuento (%)', 'Descuento Incluido',
  'Total ($)', '% IVA', 'IVA Incluido', 'Total con IVA', 'Otro Impuesto ($)',
  'Total Final', 'Forma de Pago', 'Días de Crédito', 'Entrega OK?', 'Notas',
  'Cantidad Original', 'Unidad Original', 'Factor', 'Nombre Mostrar',
];

// `Arqueo de Cajas` no lleva encabezado acá: la app lo reescribe entero en cada
// cierre (ARQUEO_HEADERS, 26 columnas). Lo único que necesita es existir.
const PLAN = [
  { libro: 'gestion',     hoja: 'Movimientos',      header: HEADER_MOVIMIENTOS },
  { libro: 'gestion',     hoja: 'Cajas',            header: HEADER_CAJAS },
  { libro: 'gestion',     hoja: 'Arqueo de Cajas',  header: null },
  { libro: 'gestion',     hoja: 'Proveedores',      header: HEADER_PROVEEDORES },
  { libro: 'proveedores', hoja: 'Compras',          header: HEADER_COMPRAS },
];

// ─── Google ──────────────────────────────────────────────────────────────────

function credenciales() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  return require('../../credentials.json');
}

async function api() {
  const auth = new google.auth.GoogleAuth({
    credentials: credenciales(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

const log = (...a) => console.log(...a);
const paso = t => log('\n' + t);
const bien = t => log('  ✓ ' + t);
const nada = t => log('  · ' + t);
const ojo = t => log('  ⚠ ' + t);

function letraDeColumna(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

// El SUMIFS que hace que la hoja Cajas signifique algo. Suma la columna de
// entradas menos la de salidas de `Movimientos`, filtrando por el nombre de la
// caja como texto exacto contra la columna L (Medio de pago).
function formulaSaldo(filaHoja) {
  return '=SUMIFS(Movimientos!M:M;Movimientos!L:L;$A' + filaHoja + ')'
       + '-SUMIFS(Movimientos!O:O;Movimientos!L:L;$A' + filaHoja + ')';
}

// ─── El trabajo ──────────────────────────────────────────────────────────────

async function main() {
  const gestion = process.env.SPREADSHEET_ID;
  const proveedores = process.env.PROVEEDORES_SHEET_ID;

  log('─'.repeat(72));
  log(`Instancia : ${negocio.NEGOCIO_NOMBRE}  (NEGOCIO_ID=${negocio.NEGOCIO_ID})`);
  log(`Gestión   : ${gestion || '(FALTA SPREADSHEET_ID)'}`);
  log(`Proveedores: ${proveedores || '(FALTA PROVEEDORES_SHEET_ID)'}`);
  log(`Cajas     : ${negocio.CAJAS.join(' · ')}`);
  log(`Modo      : ${APLICAR ? 'APLICAR (escribe)' : 'simulación — nada se escribe'}`);
  log('─'.repeat(72));

  if (!gestion || !proveedores) {
    console.error('\nFaltan SPREADSHEET_ID y/o PROVEEDORES_SHEET_ID. Ninguna de las dos');
    console.error('cae a la otra: una planilla creada en el libro equivocado no avisa nunca.');
    process.exit(1);
  }
  if (gestion === proveedores) {
    console.error('\nSPREADSHEET_ID y PROVEEDORES_SHEET_ID apuntan al mismo libro.');
    console.error('Tienen que ser dos: es la separación que decidió el 07/09/2026.');
    process.exit(1);
  }

  const sheets = await api();
  const libros = { gestion, proveedores };

  // Qué hojas hay ya en cada libro, y de paso si la cuenta de servicio llega.
  const existentes = {};
  for (const [nombre, id] of Object.entries(libros)) {
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' });
      existentes[nombre] = meta.data.sheets.map(s => s.properties.title);
      bien(`Acceso al libro "${nombre}": ${existentes[nombre].length} hoja(s)`);
    } catch (e) {
      console.error(`\nNo se pudo abrir el libro "${nombre}" (${id}): ${e.message}`);
      console.error('Compartilo con la cuenta de servicio como EDITOR — Lector no alcanza:');
      console.error(`  ${credenciales().client_email}`);
      process.exit(1);
    }
  }

  // ── Las cinco hojas ────────────────────────────────────────────────────────
  paso('Hojas que la app NO crea sola:');
  const aCrear = [];
  for (const item of PLAN) {
    const yaEsta = existentes[item.libro].includes(item.hoja);
    if (yaEsta) {
      // Existe: se mira el encabezado y se reporta, pero no se toca.
      let cabecera = [];
      try {
        const r = await sheets.spreadsheets.values.get({
          spreadsheetId: libros[item.libro], range: `${item.hoja}!A1:X1`,
        });
        cabecera = (r.data.values && r.data.values[0]) || [];
      } catch { /* hoja vacía */ }
      if (!item.header) { nada(`${item.hoja} — ya existe`); continue; }
      const coincide = item.header.every((h, i) => !h || (cabecera[i] || '').toString().trim() === h);
      if (coincide) nada(`${item.hoja} — ya existe, con el encabezado esperado`);
      else ojo(`${item.hoja} — ya existe con OTRO encabezado. No se toca: reescribirlo `
             + `correría el significado de cada columna sin mover un dato. Revisalo a mano.`);
      continue;
    }
    aCrear.push(item);
    bien(`${item.hoja} — se crea en "${item.libro}"`
       + (item.header ? ` con ${item.header.length} columnas` : ' (sin encabezado: lo escribe la app)'));
  }

  // ── Las filas de la hoja Cajas ─────────────────────────────────────────────
  const creaCajas = aCrear.some(i => i.hoja === 'Cajas');
  if (creaCajas) {
    paso('Filas de la hoja Cajas, con su SUMIFS:');
    negocio.CAJAS.forEach((c, i) => {
      const fila = i + 2;
      const usd = /(^|\s)usd(\s|$)/i.test(c) ? 'USD' : 'ARS';
      bien(`${fila}: ${c}  [${usd}]  F${fila}=${formulaSaldo(fila)}`);
    });
  }

  // ── La validación de la columna J ──────────────────────────────────────────
  const creaMovs = aCrear.some(i => i.hoja === 'Movimientos');
  if (creaMovs) {
    paso('Validación de datos en Movimientos!J (Categoría):');
    nada(cats.CATEGORIAS_COLUMNA_J.join(' · '));
  }

  if (!aCrear.length) {
    log('\nNo hay nada que crear: las cinco hojas ya están.');
    return;
  }

  if (!APLICAR) {
    log('\n' + '─'.repeat(72));
    log('Simulación. Para hacerlo de verdad:  node scripts/bootstrap-planillas.js --aplicar');
    return;
  }

  // ── Escribir ───────────────────────────────────────────────────────────────
  paso('Escribiendo…');
  const idsDeHoja = {};
  for (const item of aCrear) {
    const r = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: libros[item.libro],
      requestBody: { requests: [{ addSheet: { properties: { title: item.hoja } } }] },
    });
    idsDeHoja[item.hoja] = r.data.replies[0].addSheet.properties.sheetId;
    bien(`hoja "${item.hoja}" creada`);

    if (item.header) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: libros[item.libro],
        range: `${item.hoja}!A1:${letraDeColumna(item.header.length - 1)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [item.header] },
      });
      bien(`encabezado de "${item.hoja}" escrito`);
    }
  }

  if (creaCajas) {
    const filas = negocio.CAJAS.map((c, i) => {
      const fila = i + 2;
      return [c, '', /(^|\s)usd(\s|$)/i.test(c) ? 'USD' : 'ARS', '', '', formulaSaldo(fila), '', '', ''];
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: gestion,
      range: `Cajas!A2:I${filas.length + 1}`,
      // USER_ENTERED y no RAW: es la única forma de que el SUMIFS entre como
      // fórmula y no como el texto de una fórmula.
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: filas },
    });
    bien(`${filas.length} caja(s) cargadas, con su saldo calculado`);
  }

  if (creaMovs) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: gestion,
      requestBody: {
        requests: [{
          setDataValidation: {
            range: {
              sheetId: idsDeHoja['Movimientos'],
              startRowIndex: 1, startColumnIndex: 9, endColumnIndex: 10,
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: cats.CATEGORIAS_COLUMNA_J.map(v => ({ userEnteredValue: v })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        }],
      },
    });
    bien('validación de categorías puesta en Movimientos!J');
  }

  log('\n' + '─'.repeat(72));
  log('Listo. Lo que sigue, y no lo hace este script:');
  log('  · cargar los proveedores en la hoja Proveedores (alcanza con la columna A);');
  log('  · arrancar la app una vez — las otras 26 hojas se crean solas al usarla.');
}

main().catch(e => { console.error('\nFalló:', e.message); process.exit(1); });
