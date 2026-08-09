// ─── Tareas programadas ─────────────────────────────────────────────────────
// Primer cron real de este proyecto (todo lo demás es "lazy": se dispara como
// efecto secundario de un request). El snapshot diario de stock de Bebidas
// necesita una serie SIN huecos (ver src/stock-bebidas.js), así que no alcanza
// con esperar a que alguien abra el dashboard ese día.

const cron = require('node-cron');
const stockBebidas = require('./stock-bebidas');
const informes = require('./informes');

// 09:00 hora Argentina, todos los días, antes del servicio.
const STOCK_BEBIDAS_CRON = process.env.STOCK_BEBIDAS_CRON || '0 9 * * *';

const TZ_AR = 'America/Argentina/Buenos_Aires';

// Los dos informes semanales salen los domingos a las 10. Van separados por
// quince minutos y no juntos: cada uno lee una fuente distinta (planilla y
// Fudo) y hace su propia llamada al modelo, así que solaparlos sólo agrega
// contención para ahorrar un cuarto de hora que a nadie le importa.
// El balance ejecutivo sale el día 1 y mira el mes que cerró.
//
// La cadencia se declara UNA sola vez y de acá salen las dos cosas: la expresión
// que la programa y el cálculo de la última corrida que debió haber pasado (ver
// `ultimaCorrida`). Escritas por separado, cambiar un horario dejaría al
// catch-up recuperando el período equivocado sin que nada avise.
const CADENCIAS = {
  movimientos: { dow: 0, hora: 10, minuto: 0 },
  servicios:   { dow: 0, hora: 10, minuto: 15 },
  mensual:     { dia: 1, hora: 10, minuto: 30 },
};

const expresionDe = c => (c.dow !== undefined
  ? `${c.minuto} ${c.hora} * * ${c.dow}`
  : `${c.minuto} ${c.hora} ${c.dia} * *`);

// Override por variable de entorno. Si está, se programa con ella pero se
// desactiva el catch-up de ese informe: de una expresión arbitraria no podemos
// deducir cuándo fue la última corrida, y recuperar el período equivocado es
// peor que no recuperar nada.
const ENV_CRON = {
  movimientos: process.env.INFORME_MOVIMIENTOS_CRON,
  servicios: process.env.INFORME_SERVICIOS_CRON,
  mensual: process.env.INFORME_MENSUAL_CRON,
};

// ─── El reloj de pared argentino ────────────────────────────────────────────
// Argentina no tiene horario de verano, pero derivar el desfasaje en vez de
// asumir -3 hace que esto no dependa de que eso siga siendo cierto.
const paredAR = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: TZ_AR }));

// El desfasaje se deriva del MISMO instante de referencia que se está mirando,
// no de `new Date()`: si no, la función ignora el `ahora` que recibe y no se
// puede ejercitar con un reloj puesto a mano. Los dos lados se truncan al
// segundo porque toLocaleString no devuelve milisegundos — sin eso la corrida
// recuperada quedaba unos cientos de milisegundos en el futuro.
function instanteDePared(pared, ref = new Date()) {
  const refSegundos = Math.floor(ref.getTime() / 1000) * 1000;
  return new Date(pared.getTime() + (refSegundos - paredAR(ref).getTime()));
}

// El instante en que la cadencia disparó por última vez. Se le pasa como `hasta`
// a generarInforme para que el período y la ventana de análisis sean EXACTAMENTE
// los que habría producido la corrida perdida — no los de hoy.
function ultimaCorrida(c, ahora = new Date()) {
  const pared = paredAR(ahora);
  const obj = new Date(pared);
  obj.setHours(c.hora, c.minuto, 0, 0);
  if (c.dow !== undefined) {
    obj.setDate(obj.getDate() - ((obj.getDay() - c.dow + 7) % 7));
    if (obj > pared) obj.setDate(obj.getDate() - 7);
  } else {
    obj.setDate(c.dia);
    if (obj > pared) obj.setMonth(obj.getMonth() - 1);
  }
  return instanteDePared(obj, ahora);
}

function iniciarCron() {
  cron.schedule(STOCK_BEBIDAS_CRON, async () => {
    try {
      await stockBebidas.tomarSnapshot();
    } catch (e) {
      console.error('Cron Stock Bebidas: error tomando snapshot:', e.message);
    }
  }, { timezone: TZ_AR, name: 'stock-bebidas-diario', noOverlap: true });

  console.log(`Cron: snapshot diario de Stock Bebidas programado (${STOCK_BEBIDAS_CRON} ${TZ_AR})`);

  // Informes automáticos.
  const programarInforme = (tipo, expresion) => {
    cron.schedule(expresion, async () => {
      try {
        const r = await informes.generarInforme(tipo);
        console.log(`Cron: informe ${tipo} de ${r.periodo} — ${(r.hallazgos || []).length} hallazgos${r.yaExistia ? ' (ya existía)' : ''}`);
      } catch (e) {
        console.error(`Cron Informe ${tipo}: error generando el informe:`, e.message);
      }
    }, { timezone: TZ_AR, name: `informe-${tipo}`, noOverlap: true });
    console.log(`Cron: informe ${tipo} programado (${expresion} ${TZ_AR})`);
  };

  for (const [tipo, c] of Object.entries(CADENCIAS)) {
    programarInforme(tipo, ENV_CRON[tipo] || expresionDe(c));
  }

  // Catch-up de los informes. Hasta el 9 de agosto acá no había ninguno, con el
  // argumento de que una semana sin informe es una semana sin informe. Eso valía
  // mientras el informe fuera algo pasivo que se iba a mirar; ahora que salta
  // como aviso, una corrida perdida es un domingo en el que el aviso no aparece
  // y nadie se entera de por qué. Railway reinicia el contenedor en cada deploy:
  // si eso cae sobre las 10 de un domingo, el informe se perdía para siempre.
  //
  // No gasta llamadas al modelo de más: generarInforme es idempotente por
  // (tipo, período) y lo primero que hace es leer la hoja. En un arranque normal
  // esto son tres lecturas y nada más.
  (async () => {
    for (const [tipo, c] of Object.entries(CADENCIAS)) {
      if (ENV_CRON[tipo]) {
        console.log(`Cron: catch-up de ${tipo} desactivado (horario propio por variable de entorno)`);
        continue;
      }
      try {
        const cuando = ultimaCorrida(c);
        const r = await informes.generarInforme(tipo, { hasta: cuando });
        if (r.yaExistia) console.log(`Cron: catch-up ${tipo} — ${r.periodo} ya estaba, nada que hacer`);
        else console.log(`Cron: catch-up ${tipo} — se recuperó ${r.periodo} (la corrida del ${cuando.toISOString()} no había salido)`);
      } catch (e) {
        console.error(`Cron: catch-up ${tipo} falló:`, e.message);
      }
    }
  })();

  // Catch-up de arranque: si el último snapshot guardado no es de hoy (deploy/
  // restart se comió la corrida programada), tomamos uno ahora para no dejar
  // un hueco en la serie diaria.
  (async () => {
    try {
      const ultima = await stockBebidas.ultimaFechaSnapshot();
      const hoy = stockBebidas.hoyISO();
      if (ultima !== hoy) {
        console.log(`Cron: catch-up de arranque — último snapshot ${ultima || '(ninguno)'}, tomando el de hoy (${hoy})`);
        await stockBebidas.tomarSnapshot();
      }
    } catch (e) {
      console.error('Cron: error en catch-up de arranque:', e.message);
    }
  })();
}

// ultimaCorrida y expresionDe se exportan para poder ejercitarlas sin arrancar
// nada: son las dos piezas puras de las que depende que el catch-up recupere el
// período correcto.
module.exports = { iniciarCron, ultimaCorrida, expresionDe, CADENCIAS };
