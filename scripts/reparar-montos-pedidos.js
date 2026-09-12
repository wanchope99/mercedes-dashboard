#!/usr/bin/env node
// ─── Reparar los importes que `_numero` multiplicó por cien ──────────────────
//
// Hasta el 12/09/2026 `src/pedidos.js` leía y escribía los importes con un
// lector propio que borraba todos los puntos. Un importe con centavos —y sólo
// los que tienen centavos— entraba a la hoja multiplicado por cien:
//
//     $402.000,07  se guardó como  40200007
//     $311.108,23                  31110823
//
// El código ya está arreglado (ahora usa `monto.js`, como todo el resto), pero
// las filas que se escribieron mal siguen mal. Esto las arregla.
//
// ─── Cómo decide, y por qué no adivina ──────────────────────────────────────
//
// Un importe corrompido es un número entero, y uno sano también: no se puede
// distinguir "$80.000" de "$800,00 escrito mal" mirando la celda. Así que el
// script NO mira la celda sola: **cruza contra el libro**.
//
// Cada pedido lleva su id en la columna A, y la fila de gasto que ese pedido
// escribió lleva el MISMO id en la columna H de `Movimientos`. El importe de
// esa fila lo escribió otro camino —`registrarGastoEnLibro`, que siempre usó
// `monto.js`— así que está bien. La regla es una:
//
//     si  pedido ≈ libro × 100  →  corrompido, se corrige al valor del libro
//     si  pedido ≈ libro        →  hay que MIRARLO (ver abajo)
//     si  no hay fila en el libro  →  NO SE DECIDE, se reporta
//
// El tercer caso no es una limitación a resolver después: es la respuesta
// honesta. Un pedido sin fila en el libro no tiene contra qué verificarse, y
// escribir un número adivinado en una planilla de plata es peor que dejar uno
// visiblemente raro que una persona va a mirar.
//
// ─── Y el segundo caso tampoco significa "sano" ─────────────────────────────
//
// Al recibir, el modal PRE-LLENA el monto con el `costoEstimado` del pedido, y
// en la salida simple —"llegó todo", "se paga después"— nadie tipea nada: el
// importe que viaja al servidor es ése. Si el pedido ya estaba inflado, **la
// fila del libro se escribió inflada también**.
//
// Cuando los dos coinciden, entonces, puede ser que los dos estén bien o que
// los dos estén mal, y NO hay forma de distinguirlo desde acá: un importe
// corrompido es un entero y uno sano también. Lo que sí se puede hacer es
// ponerlos a la vista ordenados de mayor a menor, porque en un bar un pedido de
// ocho millones se reconoce de un vistazo y uno de ochenta mil también.
//
// Por eso esta lista NO se corrige sola, ni siquiera con --aplicar: arreglarla
// significa tocar `Movimientos`, que es el libro, y eso lo decide una persona.
//
// ─── Uso ────────────────────────────────────────────────────────────────────
//
//     node scripts/reparar-montos-pedidos.js             muestra qué haría
//     node scripts/reparar-montos-pedidos.js --aplicar   lo hace
//
// `dryRun` es el default, como en `bootstrap-planillas.js` y en
// `reset-aprendizaje`: acá se escribe plata.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const google = require('@googleapis/sheets');
const { parseMonto, centavos } = require('../src/monto');

const HOJA_PEDIDOS = process.env.PEDIDOS_SHEET || 'Pedidos';
const ID_PEDIDOS = process.env.PROVEEDORES_SHEET_ID;
const ID_GESTION = process.env.SPREADSHEET_ID;

// Pedidos:      A id · E costoEstimado · K montoPagado
// Movimientos:  H ID Compra · O Salida ARS
const COL = { id: 0, fecha: 1, proveedor: 2, detalle: 3, costo: 4, montoPagado: 10 };
const MOV = { idCompra: 7, salida: 14 };
const LETRA = { costo: 'E', montoPagado: 'K' };

// Un peso de tolerancia sobre el valor inflado: es un centavo sobre el real.
const TOLERANCIA = 1;

function cliente() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../credentials.json');
  return google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({
      credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }),
  });
}

const plata = n => '$' + centavos(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });

async function main() {
  const aplicar = process.argv.includes('--aplicar');

  if (!ID_PEDIDOS) { console.error('Falta PROVEEDORES_SHEET_ID.'); process.exit(1); }
  if (!ID_GESTION) { console.error('Falta SPREADSHEET_ID (es donde está Movimientos).'); process.exit(1); }

  const api = cliente();

  const [resPed, resMov] = await Promise.all([
    api.spreadsheets.values.get({ spreadsheetId: ID_PEDIDOS, range: `${HOJA_PEDIDOS}!A:T` }),
    api.spreadsheets.values.get({ spreadsheetId: ID_GESTION, range: 'Movimientos!A:P' }),
  ]);

  const filasPed = resPed.data.values || [];
  const filasMov = resMov.data.values || [];

  // El libro, indexado por el id de compra. Una compra en cuotas comparte el id
  // entre la madre y las hijas: se toma la MADRE, que es la que lleva el total
  // (las cuotas no suman en ninguna agregación, ver el CLAUDE.md).
  const libro = new Map();
  for (const r of filasMov) {
    const id = String((r && r[MOV.idCompra]) || '').trim();
    if (!id) continue;
    const monto = parseMonto(r[MOV.salida]);
    if (!(monto > 0)) continue;
    const previo = libro.get(id);
    if (!previo || monto > previo) libro.set(id, monto);
  }

  console.log(`${filasPed.length - 1} filas en ${HOJA_PEDIDOS} · ${libro.size} ids de compra en el libro\n`);

  const corregir = [], sanos = [], sinLibro = [];

  for (let i = 1; i < filasPed.length; i++) {
    const r = filasPed[i] || [];
    const id = String(r[COL.id] || '').trim();
    if (!id) continue;
    const enLibro = libro.get(id);

    for (const campo of ['costo', 'montoPagado']) {
      const crudo = r[COL[campo]];
      const valor = parseMonto(crudo);
      if (!(valor > 0)) continue;

      const caso = {
        fila: i + 1, id, campo,
        proveedor: String(r[COL.proveedor] || ''),
        fecha: String(r[COL.fecha] || ''),
        valor, enLibro,
      };

      if (enLibro == null) { sinLibro.push(caso); continue; }
      if (Math.abs(valor - enLibro) <= 0.5) { sanos.push(caso); continue; }
      if (Math.abs(valor - enLibro * 100) <= TOLERANCIA) { corregir.push(caso); continue; }
      // Ni igual ni ×100: es otra cosa (un pago parcial, una corrección a mano).
      // No es de este bug y no se toca.
      sinLibro.push({ ...caso, otro: true });
    }
  }

  if (corregir.length) {
    console.log(`─── ${corregir.length} importe(s) corrompido(s), confirmados contra el libro ───\n`);
    for (const c of corregir) {
      console.log(`  fila ${String(c.fila).padStart(3)} · ${LETRA[c.campo]} · ${c.fecha} ${c.proveedor}`);
      console.log(`          dice ${plata(c.valor).padStart(16)}   →   ${plata(c.enLibro)}\n`);
    }
  } else {
    console.log('No hay importes corrompidos que el libro confirme. 🎉\n');
  }

  if (sanos.length) {
    // Ordenados de mayor a menor: es lo único que hace falta para que un
    // importe absurdo salte a la vista sin inventar ningún umbral.
    const orden = sanos.slice().sort((a, b) => b.valor - a.valor);
    const TOPE = 15;
    console.log(`─── ${sanos.length} donde el pedido y el libro COINCIDEN ───`);
    console.log('   Eso no prueba que estén bien: el modal de recibir pre-llena el monto con el');
    console.log('   del pedido, así que si estaba inflado, la fila del libro se escribió inflada');
    console.log('   también. Mirá los de arriba — si alguno es absurdo, están mal LOS DOS y la');
    console.log('   fila de Movimientos hay que corregirla a mano.\n');
    for (const c of orden.slice(0, TOPE)) {
      console.log(`  fila ${String(c.fila).padStart(3)} · ${LETRA[c.campo]} · ${c.fecha} ${c.proveedor.padEnd(24)} ${plata(c.valor).padStart(16)}`);
    }
    if (orden.length > TOPE) console.log(`  … y ${orden.length - TOPE} más, todos por debajo de ${plata(orden[TOPE].valor)}.`);
    console.log('');
  }

  if (sinLibro.length) {
    console.log(`─── ${sinLibro.length} que NO se pueden decidir acá ───`);
    console.log('   Sin fila en el libro con ese id, o con un importe que no es ni igual ni ×100.');
    console.log('   Se listan para mirarlos a mano; el script no los toca.\n');
    for (const c of sinLibro) {
      console.log(`  fila ${String(c.fila).padStart(3)} · ${LETRA[c.campo]} · ${c.fecha} ${c.proveedor}`
        + ` · dice ${plata(c.valor)}` + (c.enLibro != null ? ` · el libro dice ${plata(c.enLibro)}` : ' · sin fila en el libro'));
    }
    console.log('');
  }

  if (!aplicar) {
    console.log(corregir.length
      ? 'Esto fue en seco. Para escribirlo: node scripts/reparar-montos-pedidos.js --aplicar'
      : 'Esto fue en seco.');
    return;
  }
  if (!corregir.length) return;

  // Celda por celda, nunca la fila entera: cualquier otra columna puede tener
  // algo que este script no leyó.
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: ID_PEDIDOS,
    requestBody: {
      valueInputOption: 'RAW',
      data: corregir.map(c => ({
        range: `${HOJA_PEDIDOS}!${LETRA[c.campo]}${c.fila}`,
        values: [[c.enLibro]],
      })),
    },
  });
  console.log(`✅ ${corregir.length} celda(s) corregida(s).`);
  console.log('   Entrá a Compras › Pedidos y mirá que los importes ahora cierren.');
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1); });
