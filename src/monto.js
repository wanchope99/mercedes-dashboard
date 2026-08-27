'use strict';

// ─── Un solo lector de importes para todo el sistema ─────────────────────────
//
// Todo importe que tipea una persona o que la planilla devuelve como texto
// entra por acá. Antes había cinco versiones de esta función repartidas entre
// el server y el navegador, cada una con su criterio, y por eso el mismo
// "200000.93" entraba como veinte millones en una pantalla y como doscientos
// mil con noventa y tres centavos en otra.
//
// La regla, en orden:
//   · Se tira todo lo que no sea dígito, coma, punto o menos: el signo $, los
//     espacios (incluido el fino que mete es-AR) y cualquier adorno.
//   · Con los DOS separadores presentes manda el que está más a la derecha:
//     "93.926,67" y "93,926.67" son los mismos noventa y tres mil.
//   · Con UNO solo es de miles nada más que si TODO el número tiene forma de
//     agrupado — "200.000", "1.700.000", "1,234,567" — y decimal en cualquier
//     otro caso: "200000,93", "200000.93", "0,5", "12345,678".
//
// La ambigüedad de "200.930" se resuelve como miles A PROPÓSITO: escribir
// doscientos mil pesos es rutina y escribir mil pesos con centavos no lo es.
// Quien quiera esos centavos escribe "200,93" o "200.93", que no son ambiguos.
function parseMonto(valor) {
  // Un número ya es un número. Además evita que un 1e21 pase por el limpiador
  // de texto y salga convertido en 121.
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
  if (valor == null) return 0;

  const s = String(valor).trim().replace(/[^0-9.,-]/g, '');
  if (!s || s === '-') return 0;

  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');
  let decimal = null;                       // qué separador marca los centavos

  if (coma !== -1 && punto !== -1) {
    decimal = coma > punto ? ',' : '.';
  } else if (coma !== -1 || punto !== -1) {
    const sep = coma !== -1 ? ',' : '.';
    const agrupado = sep === ','
      ? /^\d{1,3}(,\d{3})+$/.test(s.replace(/^-/, ''))
      : /^\d{1,3}(\.\d{3})+$/.test(s.replace(/^-/, ''));
    if (!agrupado) decimal = sep;
  }

  let limpio;
  if (decimal) {
    const corte = s.lastIndexOf(decimal);
    limpio = s.slice(0, corte).replace(/[.,]/g, '') + '.' + s.slice(corte + 1).replace(/[.,]/g, '');
  } else {
    limpio = s.replace(/[.,]/g, '');
  }

  const n = parseFloat(limpio);
  return Number.isFinite(n) ? n : 0;
}

// Los centavos existen; el ruido de punto flotante no. Todo importe que se
// escribe en la planilla pasa por acá, así no se guardan cosas como
// 1356999,9999999999981 (el SUMIFS de Sheets las arrastra y las devuelve).
const centavos = n => Math.round((Number(n) || 0) * 100) / 100;

// Un importe tipeado, listo para escribir: leído con la regla de arriba y
// recortado a dos decimales.
const montoEntrante = v => centavos(parseMonto(v));

module.exports = { parseMonto, centavos, montoEntrante };
