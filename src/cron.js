// ─── Tareas programadas ─────────────────────────────────────────────────────
// Primer cron real de este proyecto (todo lo demás es "lazy": se dispara como
// efecto secundario de un request). El snapshot diario de stock de Bebidas
// necesita una serie SIN huecos (ver src/stock-bebidas.js), así que no alcanza
// con esperar a que alguien abra el dashboard ese día.

const cron = require('node-cron');
const stockBebidas = require('./stock-bebidas');

// 09:00 hora Argentina, todos los días, antes del servicio.
const STOCK_BEBIDAS_CRON = process.env.STOCK_BEBIDAS_CRON || '0 9 * * *';
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
