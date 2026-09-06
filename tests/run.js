// Corredor de las suites. `npm test`.
//
// Descubre todo tests/*.test.js, corre cada uno y sale con código != 0 si algo
// falla, para que sirva igual desde una consola que desde un hook.
//
// Una suite puede devolver una promesa: se espera. Es lo que permite ejercitar
// las funciones async sin meter un framework para eso solo.

const fs = require('fs');
const path = require('path');
const { Contador } = require('./_harness');

const dir = __dirname;
const suites = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();

async function main() {
  let totalPasaron = 0;
  const totalFallaron = [];

  for (const archivo of suites) {
    const suite = require(path.join(dir, archivo));
    const t = new Contador(suite.nombre || archivo);
    try {
      await suite.run(t);
    } catch (e) {
      t.fallaron.push(`la suite tiró: ${e.stack}`);
    }
    const estado = t.fallaron.length ? '✗' : '✓';
    console.log(`${estado} ${t.nombre} — ${t.pasaron} ok, ${t.fallaron.length} fallo(s)`);
    for (const f of t.fallaron) console.log(`    · ${f}`);
    totalPasaron += t.pasaron;
    totalFallaron.push(...t.fallaron.map(f => `[${t.nombre}] ${f}`));
  }

  console.log(`\n${totalPasaron} afirmaciones ok, ${totalFallaron.length} fallo(s), ${suites.length} suite(s).`);
  process.exit(totalFallaron.length ? 1 : 0);
}

main();
