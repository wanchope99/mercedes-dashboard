// Las hojas de Pedidos se mudan a la planilla de Proveedores.
//
// Decisión de Gonzalo (07/09/2026): `Pedidos`, `Pedidos Semanal` y `Pedidos
// Items` dejan la planilla de Gestión —donde estaban al lado de Movimientos y
// Cajas, que es plata— y pasan a la de Proveedores, donde ya viven `Compras`,
// `Facturas` y `Proveedores Saldos`. Un pedido describe a un proveedor: qué
// trae, qué día y por cuánto.
//
// Apuntar el código a la planilla nueva no mueve una sola fila: las hojas se
// crearían vacías allá y todo lo cargado quedaría del otro lado, invisible. Por
// eso hay una migración, y por eso se prueba de verdad — con la API de Google
// simulada, sin tocar ninguna planilla.
//
// Lo que se protege son las tres reglas, que son todas sobre no perder nada:
// copia y nunca borra, se puede correr de nuevo sin duplicar, y `dryRun` es el
// default.

const path = require('path');

// ─── La planilla de mentira ────────────────────────────────────────────────
// Dos libros con hojas y filas, y un cliente que se comporta como el de Google
// para las cuatro llamadas que usa el módulo.
function planillaFalsa(libros) {
  const llamadas = { appends: [], addSheet: [] };
  const api = {
    spreadsheets: {
      async batchUpdate({ spreadsheetId, requestBody }) {
        const req = requestBody.requests[0];
        const titulo = req.addSheet.properties.title;
        const libro = libros[spreadsheetId];
        if (libro[titulo]) { const e = new Error('already exists'); throw e; }
        libro[titulo] = [];
        llamadas.addSheet.push({ spreadsheetId, titulo });
      },
      values: {
        async get({ spreadsheetId, range }) {
          const hoja = range.split('!')[0];
          const libro = libros[spreadsheetId];
          if (!libro || !libro[hoja]) throw new Error('Unable to parse range: ' + range);
          return { data: { values: libro[hoja] } };
        },
        async append({ spreadsheetId, range, requestBody }) {
          const hoja = range.split('!')[0];
          libros[spreadsheetId][hoja].push(...requestBody.values);
          llamadas.appends.push({ spreadsheetId, hoja, filas: requestBody.values.length });
        },
        async update({ spreadsheetId, range, requestBody }) {
          const hoja = range.split('!')[0];
          libros[spreadsheetId][hoja][0] = requestBody.values[0];
        },
      },
    },
  };
  return { api, llamadas };
}

// Carga el módulo con las variables puestas y el cliente de Sheets pisado.
//
// El stub NO se puede restaurar al terminar de cargar: `_sheets()` arma el
// cliente en cada llamada, no al importar, así que tiene que seguir en pie
// mientras corre la migración. Lo restaura `run` al final, en su `finally`.
const googleapis = require('googleapis');
const { envFalso } = require('./_harness');

function cargarPedidos({ nueva, vieja, api }) {
  delete require.cache[require.resolve('../src/pedidos.js')];
  process.env.PROVEEDORES_SHEET_ID = nueva;
  process.env.SPREADSHEET_ID = vieja;
  googleapis.google.sheets = () => api;
  return require('../src/pedidos.js');
}

// Una fila de la hoja Pedidos: sólo importa la columna A (el id).
const fila = (id, prov) => [id, '2026-09-08', prov, '', '', '', 'pendiente', '', '', 'no'];

function run(t) {
  envFalso();
  const entorno = { ...process.env };
  const sheetsOriginal = googleapis.google.sheets;
  // Todo lo de acá abajo devuelve una promesa encadenada; el harness la espera.
  // La restauración va en el `finally` del final, no antes: el cliente falso
  // tiene que seguir en pie mientras corre la migración.
  return correr(t).finally(() => {
    googleapis.google.sheets = sheetsOriginal;
    delete require.cache[require.resolve('../src/pedidos.js')];
    for (const k of Object.keys(process.env)) if (!(k in entorno)) delete process.env[k];
    Object.assign(process.env, entorno);
  });
}

function correr(t) {
  // ── El caso normal: hay filas viejas y la planilla nueva está vacía ───────
  const libros = {
    VIEJA: {
      'Pedidos': [['ID', 'Fecha'], fila('ped1', 'Thames'), fila('ped2', 'Yerson')],
      'Pedidos Semanal': [['ID', 'Dia'], ['sem1', 'jueves']],
      'Pedidos Items': [['ID', 'PedidoID'], ['it1', 'ped1'], ['it2', 'ped1']],
    },
    NUEVA: {},
  };
  const { api, llamadas } = planillaFalsa(libros);
  const pedidos = cargarPedidos({ nueva: 'NUEVA', vieja: 'VIEJA', api });

  // 1. dryRun es el default y NO escribe nada.
  return pedidos.migrarDesdeGestion().then(plan => {
    t.eq(plan.dryRun, true, 'sin decir nada, es una prueba en seco');
    t.eq(plan.total, 5, 'cuenta las 5 filas que habría que traer (2 + 1 + 2)');
    t.eq(llamadas.appends.length, 0, 'en seco NO escribe una sola fila');
    t.eq(libros.NUEVA['Pedidos'].length, 1, 'la hoja nueva sólo tiene su encabezado');

    // 2. Aplicado: trae todo.
    return pedidos.migrarDesdeGestion({ dryRun: false });
  }).then(r => {
    t.eq(r.total, 5, 'trae las 5');
    t.eq(libros.NUEVA['Pedidos'].length, 3, 'Pedidos: encabezado + 2 filas');
    t.eq(libros.NUEVA['Pedidos Semanal'].length, 2, 'Semanal: encabezado + 1');
    t.eq(libros.NUEVA['Pedidos Items'].length, 3, 'Items: encabezado + 2');

    // LO QUE NO PASÓ: la planilla vieja sigue entera. Es la regla que protege
    // todo el historial de pedidos de un bug en esta función.
    t.eq(libros.VIEJA['Pedidos'].length, 3, 'la hoja vieja NO se tocó');
    t.eq(libros.VIEJA['Pedidos Items'].length, 3, 'ni la de items');

    // 3. Correrla de nuevo no duplica: los ids ya están del otro lado.
    return pedidos.migrarDesdeGestion({ dryRun: false });
  }).then(r => {
    t.eq(r.total, 0, 'la segunda corrida no trae nada');
    t.eq(libros.NUEVA['Pedidos'].length, 3, 'y no duplicó ninguna fila');
    t.eq(r.detalle[0].yaEstaban, 2, 'las cuenta como "ya estaban"');

    // 4. Una corrida a medias se termina corriéndola otra vez. Es el caso real:
    //    se corta la red, se acaba la cuota de la API, alguien cierra la
    //    pestaña. Sin esto habría que resolverlo a mano fila por fila.
    libros.VIEJA['Pedidos'].push(fila('ped3', 'CCU'));
    return pedidos.migrarDesdeGestion({ dryRun: false });
  }).then(r => {
    t.eq(r.total, 1, 'una fila nueva del otro lado se trae sola');
    t.eq(libros.NUEVA['Pedidos'].length, 4, 'y queda una sola vez');

    // 5. La hoja vieja ya borrada: no es un error, es la mudanza terminada.
    delete libros.VIEJA['Pedidos'];
    return pedidos.migrarDesdeGestion();
  }).then(r => {
    t.eq(r.total, 0, 'sin hoja vieja no hay nada que traer');
    t.ok(r.detalle.some(d => d.nota === 'no existe en la planilla vieja'),
      'y lo dice, en vez de fallar: es el estado final esperado');

    // ── Los dos rechazos ────────────────────────────────────────────────────
    const l2 = { IGUAL: { 'Pedidos': [['ID']] } };
    const p2 = cargarPedidos({ nueva: 'IGUAL', vieja: 'IGUAL', api: planillaFalsa(l2).api });
    return p2.migrarDesdeGestion().then(
      () => t.ok(false, 'con las dos variables iguales tiene que rechazar'),
      e => t.ok(/misma planilla/.test(e.message), 'rechaza si las dos variables apuntan al mismo lado'));
  }).then(() => {
    const p3 = cargarPedidos({ nueva: '', vieja: 'VIEJA', api: planillaFalsa({}).api });
    return p3.migrarDesdeGestion().then(
      () => t.ok(false, 'sin PROVEEDORES_SHEET_ID tiene que rechazar'),
      e => t.ok(/PROVEEDORES_SHEET_ID/.test(e.message),
        'sin la planilla nueva configurada, lo dice por su nombre'));
  });
}

module.exports = { nombre: 'La mudanza de las hojas de Pedidos', run };
