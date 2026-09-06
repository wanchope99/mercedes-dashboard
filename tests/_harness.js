// Arnés mínimo para las suites de este repo.
//
// Por qué no hay framework: las verificaciones de cada sesión ya se venían
// escribiendo como scripts Node sueltos contra datos en memoria, sin tocar una
// planilla real. Lo único que faltaba era no tirarlas. Meter jest/vitest sería
// una dependencia y un build para correr afirmaciones que no los necesitan.
//
// Una suite exporta { nombre, run(t) } y usa t.ok / t.eq / t.throws.

class Contador {
  constructor(nombre) { this.nombre = nombre; this.pasaron = 0; this.fallaron = []; }

  ok(cond, desc) {
    if (cond) { this.pasaron++; return true; }
    this.fallaron.push(desc);
    return false;
  }

  eq(actual, esperado, desc) {
    const a = JSON.stringify(actual), e = JSON.stringify(esperado);
    if (a === e) { this.pasaron++; return true; }
    this.fallaron.push(`${desc}\n      esperado: ${e}\n      recibido: ${a}`);
    return false;
  }

  throws(fn, desc) {
    try { fn(); } catch (e) { this.pasaron++; return true; }
    this.fallaron.push(`${desc} (no tiró)`);
    return false;
  }
}

// Variables de entorno falsas: alcanzan para que los módulos carguen. Ninguna
// suite habla con Google ni con Fudo — si alguna lo intentara, fallaría acá, que
// es lo que se quiere.
function envFalso() {
  const vals = {
    SPREADSHEET_ID: 'test-sheet-id',
    PROVEEDORES_SHEET_ID: 'test-prov-id',
    NOMINA_SHEET_ID: 'test-nomina-id',
    STOCKS_SHEET_ID: 'test-stocks-id',
    GOOGLE_CREDENTIALS_JSON: JSON.stringify({ client_email: 'test@test', private_key: 'x' }),
    JWT_SECRET: 'test-secret',
    FUDO_API_KEY: 'test', FUDO_API_SECRET: 'test',
  };
  for (const [k, v] of Object.entries(vals)) if (!process.env[k]) process.env[k] = v;
}

module.exports = { Contador, envFalso };
