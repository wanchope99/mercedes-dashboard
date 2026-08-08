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

// Los dos informes semanales salen los domingos a las 10. Van separados por
// quince minutos y no juntos: cada uno lee una fuente distinta (planilla y
// Fudo) y hace su propia llamada al modelo, así que solaparlos sólo agrega
// contención para ahorrar un cuarto de hora que a nadie le importa.
const INFORME_MOVIMIENTOS_CRON = process.env.INFORME_MOVIMIENTOS_CRON || '0 10 * * 0';
const INFORME_SERVICIOS_CRON = process.env.INFORME_SERVICIOS_CRON || '15 10 * * 0';
// El balance ejecutivo sale el día 1 y mira el mes que cerró.
const INFORME_MENSUAL_CRON = process.env.INFORME_MENSUAL_CRON || '30 10 1 * *';
const TZ_AR = 'America/Argentina/Buenos_Aires';

function iniciarCron() {
  cron.schedule(STOCK_BEBIDAS_CRON, async () => {
    try {
      await stockBebidas.tomarSnapshot();
    } catch (e) {
      console.error('Cron Stock Bebidas: error tomando snapshot:', e.message);
    }
  }, { timezone: TZ_AR, name: 'stock-bebidas-diario', noOverlap: true });

  console.log(`Cron: snapshot diario de Stock Bebidas programado (${STOCK_BEBIDAS_CRON} ${TZ_AR})`);

  // Informes automáticos. A diferencia del snapshot de stock, acá NO hay
  // catch-up de arranque: el snapshot necesita una serie sin huecos, el informe
  // no — una semana sin informe es una semana sin informe, y disparar uno en
  // cada reinicio del server gastaría llamadas al modelo que nadie pidió.
  // generarInforme() además no regenera si ya existe el del período.
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

  programarInforme('movimientos', INFORME_MOVIMIENTOS_CRON);
  programarInforme('servicios', INFORME_SERVICIOS_CRON);
  programarInforme('mensual', INFORME_MENSUAL_CRON);

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

module.exports = { iniciarCron };
