// Qué paquetes tiene derecho a traer este repo.
//
// El 12/09/2026 se cambió `googleapis` —el paquete monolítico de Google, con los
// clientes de 294 APIs— por `@googleapis/sheets`, que trae una. De esas 294 este
// repo usaba exactamente dos cosas: `google.sheets` (47 usos) y `google.auth`
// (29). Adentro de los 112 MB del paquete grande, la carpeta de Sheets pesa
// 281 KB.
//
// Medido acá mismo: 461 ms → 59 ms de arranque, +91 MB → +19 MB de RSS, y
// `node_modules` de 132 MB a 30 MB.
//
// POR QUÉ ESTO NECESITA UNA PRUEBA. El cambio es una línea por archivo y la
// vuelta atrás también: alcanza con que alguien escriba `require('googleapis')`
// en un archivo nuevo —o que un merge lo reviva— para volver a arrastrar 100 MB
// y medio segundo de arranque. **Y la app se vería exactamente igual**: mismo
// comportamiento, mismas pruebas verdes, sólo más lenta y más gorda. Un costo
// que no se ve es un costo que vuelve.
//
// Es de texto porque lo que se cuida es qué dice el código, no qué hace: no hay
// forma de "ejecutar" una dependencia que no debería estar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// Los paquetes que NO pueden volver, con el motivo. Si algún día uno se
// justifica de nuevo, se saca de acá a propósito y no por accidente.
const PROHIBIDOS = {
  googleapis: 'trae los clientes de 294 APIs para usar Sheets; va @googleapis/sheets',
};

function archivosJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function run(t) {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  // 1. Ninguno de los prohibidos está declarado.
  for (const [nombre, motivo] of Object.entries(PROHIBIDOS)) {
    t.ok(!deps[nombre], `package.json no declara "${nombre}": ${motivo}`);
  }

  // 2. Y ninguno se requiere desde el código, que es por donde volvería: un
  //    `require` de un paquete que no está declarado igual funciona mientras
  //    quede en node_modules como dependencia transitiva de otro.
  // Esta suite se excluye a sí misma: nombra los paquetes prohibidos y las dos
  // formas del import como texto, así que se encontraría sola. Es el mismo caso
  // que el `photo[-1]` de tests/bot-foto.test.js — una prueba que prohíbe
  // mencionar algo obliga a escribir el comentario en clave.
  const yo = path.join(RAIZ, 'tests', 'dependencias.test.js');
  const fuentes = [...archivosJs(path.join(RAIZ, 'src')),
    ...archivosJs(path.join(RAIZ, 'scripts')),
    ...archivosJs(path.join(RAIZ, 'tests'))]
    .filter(f => path.resolve(f) !== path.resolve(yo));
  t.ok(fuentes.length > 30, 'se encontraron los archivos del repo');

  for (const nombre of Object.keys(PROHIBIDOS)) {
    // `@googleapis/sheets` contiene la cadena "googleapis", así que se busca el
    // require exacto y no el nombre suelto.
    const re = new RegExp(`require\\(['"]${nombre}['"]\\)`);
    const culpables = fuentes.filter(f => re.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(RAIZ, f));
    t.eq(culpables, [], `nadie hace require('${nombre}')`);
  }

  // 3. El que SÍ va está declarado. Sin esto, el punto 1 se cumpliría también
  //    borrando los dos y dejando la app sin poder hablar con Google.
  t.ok(deps['@googleapis/sheets'], 'package.json declara @googleapis/sheets');

  // 4. Y se usa en todos lados. El repo tiene ~29 archivos que hablan con la
  //    planilla; si este número se desploma es que alguien encontró otra puerta.
  const conSheets = fuentes.filter(f =>
    /require\(['"]@googleapis\/sheets['"]\)/.test(fs.readFileSync(f, 'utf8')));
  t.ok(conSheets.length >= 25,
    `los módulos que hablan con la planilla importan @googleapis/sheets (son ${conSheets.length})`);

  // 5. La forma del import es la que hace que el cambio fuera de una línea: el
  //    paquete chico expone `auth` y `sheets` en la RAÍZ, así que se importa sin
  //    desestructurar y todo el resto del código sigue diciendo `google.sheets`
  //    y `google.auth`. Un `const { google } = require('@googleapis/sheets')`
  //    daría `undefined` y reventaría recién en la primera llamada a Google.
  const malImportados = conSheets.filter(f =>
    /const\s*\{[^}]*\}\s*=\s*require\(['"]@googleapis\/sheets['"]\)/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(RAIZ, f));
  t.eq(malImportados, [], 'se importa el módulo entero, no desestructurado');
}

module.exports = { nombre: 'Dependencias: qué paquetes puede traer el repo', run };
