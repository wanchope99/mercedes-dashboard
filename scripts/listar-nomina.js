#!/usr/bin/env node
// ─── Quién está en la nómina, y con qué ──────────────────────────────────────
//
// Existe por una razón puntual: el 12/09/2026 afirmé que una persona no estaba
// en la nómina **sin poder leerla**, porque en la máquina donde se desarrolla
// este repo no hay credenciales de Google. Era una deducción presentada como un
// hecho, y sobre la nómina no se deduce.
//
// Esto no calcula nada nuevo: usa `getEmpleados()` y `getCostos()`, las mismas
// funciones que alimentan la pantalla de Nómina y el punto de equilibrio. Si lo
// que imprime no coincide con lo que dice la app, el problema es de lectura y no
// de este script.
//
// Sólo lee. No escribe una celda.
//
//     node scripts/listar-nomina.js
//
// Necesita `NOMINA_SHEET_ID` y credenciales de Google
// (`GOOGLE_CREDENTIALS_JSON` o un `credentials.json` en la raíz).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const nomina = require('../src/nomina');

const plata = n => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const fecha = iso => (iso ? iso.split('-').reverse().join('/') : '—');

async function main() {
  if (!process.env.NOMINA_SHEET_ID) {
    console.error('Falta NOMINA_SHEET_ID: sin esa variable la nómina no existe para la app.');
    process.exit(1);
  }
  // Se avisa ACÁ y no se deja reventar abajo: sin credenciales el error que sale
  // es un stack de "Cannot find module credentials.json", que no le dice a nadie
  // que lo que falta es una llave de Google. Es exactamente el error que hay que
  // entender de una, porque la máquina de desarrollo no las tiene.
  const hayCredenciales = process.env.GOOGLE_CREDENTIALS_JSON
    || require('fs').existsSync(require('path').join(__dirname, '..', 'credentials.json'));
  if (!hayCredenciales) {
    console.error('\nNo hay credenciales de Google en esta máquina, así que la nómina no se puede leer.');
    console.error('Corré esto donde estén: o con GOOGLE_CREDENTIALS_JSON en el entorno, o con');
    console.error('un credentials.json en la raíz del repo.\n');
    process.exit(1);
  }

  const [empleados, costos] = await Promise.all([nomina.getEmpleados(), nomina.getCostos()]);
  const porNombre = new Map(costos.map(c => [String(c.nombre || '').trim().toLowerCase(), c]));

  console.log(`\nHoja "${nomina.HOJA_EMPLEADOS}" — ${empleados.length} persona(s)\n`);

  const anchoN = Math.max(8, ...empleados.map(e => e.nombre.length));
  console.log(
    'NOMBRE'.padEnd(anchoN) + '  ' +
    'INGRESO'.padEnd(11) + 'SUELDO NETO'.padStart(13) + 'EN BLANCO'.padStart(13) + '  ' + 'NOTAS'
  );
  console.log('─'.repeat(anchoN + 55));

  for (const e of empleados) {
    const notas = [];
    if (e.esSocio) notas.push('socio');
    if (!(e.enBlancoNetoARS > 0) && !e.esSocio) notas.push('sin parte registrada');
    if (e.faltan && e.faltan.length) notas.push('⚠ falta ' + e.faltan.join(' y '));
    if (!porNombre.has(e.nombre.trim().toLowerCase())) notas.push('sin fila en "' + nomina.HOJA_COSTOS + '"');

    console.log(
      e.nombre.padEnd(anchoN) + '  ' +
      fecha(e.ingresoISO).padEnd(11) +
      plata(e.sueldoActualARS).padStart(13) +
      plata(e.enBlancoNetoARS).padStart(13) + '  ' +
      notas.join(' · ')
    );
  }

  // Los que están en la hoja de costos y NO en la de empleados. Es el caso que
  // rompe el join —las dos hojas se unen POR NOMBRE— y el que hace que alguien
  // exista a medias en el sistema.
  const nombresEmp = new Set(empleados.map(e => e.nombre.trim().toLowerCase()));
  const huerfanos = costos.filter(c => !nombresEmp.has(String(c.nombre || '').trim().toLowerCase()));
  if (huerfanos.length) {
    console.log(`\n⚠ ${huerfanos.length} en "${nomina.HOJA_COSTOS}" que NO están en "${nomina.HOJA_EMPLEADOS}":`);
    console.log('  (las dos hojas se unen por NOMBRE, así que una diferencia de tipeo los parte en dos)');
    for (const c of huerfanos) console.log('   · ' + c.nombre);
  }

  // El total es lo que llega al punto de equilibrio. Se imprime acá para poder
  // cruzarlo contra lo que muestra la pantalla sin abrirla.
  const incompletos = empleados.filter(e => e.faltan && e.faltan.length).length;
  console.log(`\nTotal de sueldos netos cargados: $${plata(empleados.reduce((s, e) => s + (e.sueldoActualARS || 0), 0))}`);
  if (incompletos) {
    console.log(`⚠ ${incompletos} fila(s) incompleta(s): ese total está POR DEBAJO de la realidad,`);
    console.log('  y el punto de equilibrio también.');
  }
  console.log('');
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1); });
