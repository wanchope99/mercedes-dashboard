'use strict';

// ─── La fecha de una factura ─────────────────────────────────────────────────
//
// El 10/09/2026 una factura de Láctea El Puente entró al libro fechada el 9 de
// OCTUBRE. El papel decía "10/09/2026" y el modelo lo leyó como mes 10, día 09:
// el orden de Estados Unidos aplicado a un comprobante argentino. Nadie lo vio
// al confirmar porque el resumen escribe "10/9" y "9/10" con las mismas cifras,
// y porque hasta ese día la fecha era el único dato de la cabecera que no se
// miraba: el total se confirma, la letra se pregunta, la fecha entraba sola.
//
// Tres reglas, de la más segura a la más dudosa:
//
//   1. EL PAPEL MANDA. `fecha_texto` es la fecha tal cual está impresa. En
//      Argentina eso es DÍA/MES/AÑO y no hay segunda lectura, así que cuando el
//      texto y la fecha ISO no coinciden gana el texto. Esto NO se pregunta: no
//      es una suposición sobre lo que quiso decir el papel, es el formato del
//      país aplicado a lo que el papel dice.
//
//   2. NINGUNA FACTURA ES DEL FUTURO. Una compra que todavía no pasó no se
//      pagó, no se recibió y no descuenta IVA de este mes. Si la fecha leída es
//      posterior a hoy está mal leída —no hay caso legítimo— así que se
//      pregunta SIEMPRE, y se propone la fecha dada vuelta cuando esa sí cae en
//      el pasado.
//
//   3. UNA FACTURA SUELTA EN OTRO MES ES SOSPECHOSA. Las facturas se suben en
//      tandas: las del día, o el atraso de una semana. Cuando las últimas que
//      entraron son todas de septiembre y aparece una de otro mes, lo probable
//      no es el viaje en el tiempo sino el día y el mes dados vuelta. Se
//      pregunta, mostrando las dos lecturas.
//
// Las tres se aplican en ese orden y cada una sobre el resultado de la anterior.
// Lo que no se resuelve con certeza NO se corrige solo: vuelve como `duda` y lo
// contesta una persona. Este módulo no lee ni escribe nada y no habla con nadie.

const TZ = 'America/Argentina/Buenos_Aires';

/** Hoy en Argentina, 'YYYY-MM-DD'. La UTC ya está en mañana después de las 21. */
function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function bisiesto(a) { return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0; }

function diasDelMes(a, m) {
  return [31, bisiesto(a) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// 'YYYY-MM-DD' → { a, m, d }, o null si no es una fecha de calendario de verdad.
// El 31/02 no lo es: `new Date()` lo acepta y lo corre al 3 de marzo, que es
// exactamente la clase de error que este módulo existe para no cometer.
function partes(iso) {
  const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '').trim());
  if (!x) return null;
  const a = Number(x[1]), m = Number(x[2]), d = Number(x[3]);
  if (m < 1 || m > 12 || d < 1 || d > diasDelMes(a, m)) return null;
  return { a, m, d };
}

/** Arma un ISO sólo si el día existe en ese mes; si no, cadena vacía. */
function armar(a, m, d) {
  const iso = `${String(a).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return partes(iso) ? iso : '';
}

/** El mes de una fecha, 'YYYY-MM'. */
function mesDe(iso) {
  const p = partes(iso);
  return p ? `${p.a}-${String(p.m).padStart(2, '0')}` : '';
}

function mesAnterior(mes) {
  const x = /^(\d{4})-(\d{2})$/.exec(String(mes || ''));
  if (!x) return '';
  let a = Number(x[1]);
  let m = Number(x[2]) - 1;
  if (m === 0) { m = 12; a -= 1; }
  return `${a}-${String(m).padStart(2, '0')}`;
}

/**
 * La misma fecha con el día y el mes dados vuelta, o '' si no existe.
 *
 * Sólo hay vuelta posible cuando el día es 1..12: el 25/09 no se puede leer al
 * revés ni equivocándose, y por eso once de cada doce errores de este tipo son
 * imposibles. El 10/09 sí, y ése fue el que pasó.
 */
function invertirDiaMes(iso) {
  const p = partes(iso);
  if (!p || p.d > 12 || p.d === p.m) return '';
  return armar(p.a, p.d, p.m);
}

const MESES = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
  // Por si el papel viene en inglés: algún sistema de facturación lo hace.
  jan: 1, apr: 4, aug: 8, dec: 12,
};

// Los acentos combinantes, para que "diciembre" y "dicíembre" pesen igual.
function sinTilde(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function anioDe(txt) {
  const n = Number(txt);
  return String(txt).length === 2 ? 2000 + n : n;
}

/**
 * La fecha TAL CUAL está impresa en el papel → ISO, leída a la argentina.
 *
 * El único orden que se acepta para una fecha numérica es DÍA/MES/AÑO. No es
 * una preferencia: es cómo se emiten las facturas en el país, y el modelo ya
 * demostró que si se le deja elegir el orden, alguna vez elige mal.
 *
 * Devuelve '' cuando no reconoce la forma — quien llama se queda con lo que
 * haya leído el modelo, que es lo que pasaba antes de que esto existiera.
 */
function normalizarTexto(txt) {
  const s = sinTilde(String(txt == null ? '' : txt).trim().toLowerCase());
  if (!s) return '';

  // Ya viene en ISO: algunos sistemas imprimen así.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return armar(Number(m[1]), Number(m[2]), Number(m[3]));

  // dd/mm/aaaa, dd-mm-aa, dd.mm.aaaa — el caso normal.
  m = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2,4})/.exec(s);
  if (m) return armar(anioDe(m[3]), Number(m[2]), Number(m[1]));

  // "10 de septiembre de 2026", "10-sep-26", "10 sep 2026".
  m = /^(\d{1,2})\s*(?:de\s+)?[-/ ]?\s*([a-z]{3,10})\.?\s*(?:de\s+)?[-/ ]?\s*(\d{2,4})/.exec(s);
  if (m) {
    const mes = MESES[m[2].slice(0, 3)];
    if (mes) return armar(anioDe(m[3]), mes, Number(m[1]));
  }

  return '';
}

/** Los meses en los que una factura que entra hoy no llama la atención. */
function mesesEsperados(hoy, recientes = []) {
  const s = new Set();
  const mh = mesDe(hoy);
  // El mes corriente y el anterior son normales SIEMPRE, haya tanda o no: una
  // factura del 28 de agosto que se sube el 2 de septiembre no tiene nada raro.
  if (mh) { s.add(mh); s.add(mesAnterior(mh)); }
  // Y lo que se viene subiendo, que es lo que permite cargar un atraso viejo sin
  // que pregunte por cada una: la primera abre el mes y las demás pasan solas.
  for (const f of recientes) { const m = mesDe(f); if (m) s.add(m); }
  return s;
}

/**
 * Revisa la fecha leída de una factura.
 *
 *   fecha       la que devolvió el modelo, ISO
 *   fechaTexto  la fecha tal cual está impresa (opcional, pero es la buena)
 *   hoy         'YYYY-MM-DD' en Argentina
 *   recientes   fechas de las últimas facturas cargadas — la tanda
 *
 * Devuelve:
 *   fecha       la que hay que usar (ya corregida si la corrección era segura)
 *   original    la que vino, para poder contarlo
 *   corregida   se cambió sin preguntar (sólo puede pasar por la regla 1)
 *   motivo      por qué se cambió, o por qué se duda
 *   duda        null, o la pregunta para que la conteste una persona
 */
function revisar({ fecha, fechaTexto, hoy, recientes = [] } = {}) {
  const dia = partes(hoy) ? String(hoy).slice(0, 10) : hoyAR();
  const original = partes(fecha) ? String(fecha).slice(0, 10) : '';

  // ── Regla 1: el papel manda ───────────────────────────────────────────────
  const delPapel = normalizarTexto(fechaTexto);
  let f = original;
  let corregida = false;
  let motivo = '';
  if (delPapel && delPapel !== original) {
    f = delPapel;
    corregida = !!original;      // sin ISO previo no hay nada que corregir
    motivo = original ? 'orden-dd-mm' : '';
  }

  if (!f) {
    // Sin fecha no hay nada que revisar. Quien llama decide con qué rellenarla
    // —hoy, históricamente—: este módulo no inventa fechas.
    return { fecha: '', original, corregida: false, motivo: 'sin-fecha', duda: null };
  }

  const invertida = invertirDiaMes(f);

  // ── Regla 2: ninguna factura es del futuro ────────────────────────────────
  if (f > dia) {
    const sirve = !!invertida && invertida <= dia;
    // `hoy` va como segunda opción y sin repetirse: una factura leída como del
    // futuro muchas veces es la de hoy con el día y el mes cruzados, y entonces
    // las dos opciones son la misma.
    const opciones = [...new Set([...(sirve ? [invertida] : []), dia])];
    return {
      fecha: f,
      original,
      corregida,
      motivo: sirve ? 'futura-invertida' : 'futura',
      duda: {
        campo: 'fecha',
        sugerido: sirve ? invertida : '',
        fuente: sirve ? 'futura-invertida' : 'futura',
        opciones,
        pregunta: sirve
          ? `⚠️ Leí *${humana(f)}*, que todavía no pasó. Con el día y el mes al derecho `
            + `sería *${humana(invertida)}*. ¿Cuál es?`
          : `⚠️ Leí *${humana(f)}*, que todavía no pasó. ¿Qué fecha tiene la factura?`,
      },
    };
  }

  // ── Regla 3: sola en otro mes ─────────────────────────────────────────────
  const esperados = mesesEsperados(dia, recientes);
  if (!esperados.has(mesDe(f))) {
    const sirve = !!invertida && invertida <= dia && esperados.has(mesDe(invertida));
    const opciones = [...new Set([...(sirve ? [invertida] : []), f])];
    const tanda = [...new Set(recientes.map(mesDe).filter(Boolean))].sort().map(nombreMes);
    const contexto = tanda.length
      ? ` Las últimas que subiste son de ${tanda.slice(0, 3).join(' y ')}.`
      : '';
    return {
      fecha: f,
      original,
      corregida,
      motivo: 'mes-fuera-del-lote',
      duda: {
        campo: 'fecha',
        sugerido: sirve ? invertida : f,
        fuente: 'mes-fuera-del-lote',
        opciones,
        pregunta: sirve
          ? `🤔 Leí *${humana(f)}*.${contexto} Dada vuelta sería *${humana(invertida)}*. ¿Cuál es?`
          : `🤔 Leí *${humana(f)}*.${contexto} ¿Es correcta?`,
      },
    };
  }

  return { fecha: f, original, corregida, motivo, duda: null };
}

const NOMBRES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 'YYYY-MM' → 'septiembre' (con el año si no es el corriente). */
function nombreMes(mes) {
  const x = /^(\d{4})-(\d{2})$/.exec(String(mes || ''));
  if (!x) return String(mes || '');
  const n = NOMBRES[Number(x[2]) - 1] || x[2];
  return Number(x[1]) === Number(hoyAR().slice(0, 4)) ? n : `${n} de ${x[1]}`;
}

/**
 * '2026-10-09' → '9 de octubre de 2026'.
 *
 * El año va SIEMPRE y el mes con todas las letras: "9/10" y "10/9" se leen
 * igual de rápido y son la misma cifra dos veces, que es justamente por qué el
 * error del 10 de septiembre pasó la confirmación sin que nadie lo viera.
 */
function humana(iso) {
  const p = partes(iso);
  if (!p) return String(iso || '');
  return `${p.d} de ${NOMBRES[p.m - 1]} de ${p.a}`;
}

module.exports = {
  revisar, normalizarTexto, invertirDiaMes, mesesEsperados,
  hoyAR, mesDe, mesAnterior, humana, nombreMes, partes, armar, TZ,
};
