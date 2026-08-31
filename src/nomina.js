// ─── Nómina: la fuente de verdad del costo laboral ──────────────────────────
//
// Hasta el 17/8/2026 la app no sabía cuánta gente trabajaba en el bar. El costo
// de personal era una constante (`PERSONAL_MENSUAL_DEFAULT = 11.300.000` en
// proyecciones.js) con un piso que descartaba cualquier valor menor a 10M — o
// sea que si alguien se iba, el sistema no se enteraba. Y el punto de
// equilibrio diario, que es el número que más se mira, se apoyaba entero en esa
// constante.
//
// Este módulo lee la nómina real y la deja disponible para el resto: punto de
// equilibrio, proyecciones y el contexto que leen los agentes.
//
// ─── Tres cosas que hay que saber antes de tocar esto ───────────────────────
//
// 1. CASI TODO ES DE SÓLO LECTURA, Y LA EXCEPCIÓN ES UNA SOLA.
//
//    `Nómina` y `Costos laborales` no se tocan nunca: son de los dueños, se
//    siguen editando ahí, y de ahí sale el costo laboral de toda la app.
//
//    Las hojas mensuales `AAAAMM` SÍ se escriben, desde el 24/08/2026. Es la
//    decisión de producto que este comentario decía que había que tomar aparte,
//    y se tomó: la liquidación del mes se arma desde la app en vez de a mano en
//    el Excel. La planilla sigue siendo la única verdad — la app escribe ahí,
//    no en una copia — y por eso no hay dos lugares con el sueldo del mes.
//
//    La escritura pide otro permiso de Google (`spreadsheets` en vez de
//    `spreadsheets.readonly`) y que la cuenta de servicio sea EDITORA de esa
//    planilla. Si es sólo lectora, leer sigue andando y guardar falla con el
//    403 de Google: es un permiso que se da en Drive, no en el código.
//
// 2. VIVE EN SU PROPIA PLANILLA Y NO HAY FALLBACK. `PROVEEDORES_SHEET_ID` cae a
//    `SPREADSHEET_ID` cuando no está definida; acá NO, a propósito: son sueldos
//    de gente real y el fallback significaría escribirlos donde los ve más
//    gente. Sin `NOMINA_SHEET_ID` la nómina simplemente no existe y todo el
//    resto degrada a lo que hacía antes.
//
// 3. LAS CARGAS SOCIALES SE CUENTAN UNA VEZ, Y DÓNDE ESTÁN NO ES OBVIO.
//    `fixedMensual` en proyecciones.js suma `personalMensual + fiscalesMensual
//    + …`. La sospecha razonable es que las cargas entren por `fiscalesMensual`
//    —los VEP de ARCA son categoría Fiscales— y que sumar el total de la nómina
//    las contaría dos veces.
//
//    Medido contra el libro el 17/8/2026, NO es así. Todo lo que hay en
//    Fiscales de los últimos meses es ARCA $137.949 en mayo y $65.535 en junio;
//    julio y agosto no tienen una sola fila. Contra $1,64M mensuales de cargas
//    que dice la nómina, eso no son las cargas: en la práctica se cargan dentro
//    de la categoría Personal. La cuenta cierra por ese lado — el Personal del
//    libro de julio fueron $11,08M contra $10,70M de neto + cargas de la
//    nómina, mientras que el neto solo son $9,06M.
//
//    Por eso `costoParaPuntoDeEquilibrioARS` es el costo COMPLETO. Igual el
//    resumen devuelve el número partido en tres —lo que cobra el trabajador,
//    las cargas y las provisiones— porque es lo que permite rehacer esta
//    verificación sin repetir la investigación.
//
//    QUÉ MIRAR SI ESTO CAMBIA: si algún día los VEP de ARCA empiezan a cargarse
//    como Fiscales, `fiscalesMensual` va a subir ~$1,6M/mes y ahí sí habría
//    doble conteo. La señal es esa: Fiscales dejando de ser calderilla.
//
// ─── Las reglas, copiadas de las fórmulas de la planilla ────────────────────
//
// Hoja `Nómina` — una fila por persona:
//   A Nombre · B Fecha ingreso · C Sueldo actual · D En blanco neto · E ALIAS/CBU
//   "Sueldo actual" es el neto total que recibe la persona. "En blanco neto" es
//   la parte de ese neto que va por recibo; el resto se paga por fuera.
//
// Hoja `Costos laborales` — una fila por persona, todo derivado de la anterior:
//   B Neto Remunerativo      = Nómina!D
//   C Neto No Remunerativo   = Nómina!C − Nómina!D
//   D Bruto x Recibo         = B × 1,2      (neto → bruto, aportes del trabajador)
//   E Costo laboral mensual  = B × 1,67     (bruto + cargas patronales)
//   F Costo laboral + no rem = E + C
//   G Prorrateo vacaciones   = F / 24       (medio sueldo al año, devengado)
//   H Prorrateo aguinaldo    = F / 12       (un sueldo al año, devengado)
//   I Costo total mensual    = F + G + H
//
// LA PLANILLA YA DEVENGA vacaciones y aguinaldo mes a mes. No es una decisión
// que tomamos acá: es cómo estaba hecha, y es la lectura correcta — el aguinaldo
// se gana todo el año y se paga dos veces, así que cada mes tiene que cargar su
// parte. Si sólo pesara en junio y diciembre, en junio ya sería tarde.
//
// Con "en blanco neto" en 0 no hay parte registrada, así que no hay cargas ni
// provisiones y el sueldo pasa entero al costo del mes. Confirmado por el dueño
// el 17/8/2026 para el socio, y desde el 30/08/2026 vale también para quien está
// en período de prueba y todavía cobra todo en efectivo.
//
// Que eso NO alcanza para saber quién es socio es la corrección del 30/08/2026:
// ver SOCIOS. El socio no cobra feriado ni aguinaldo; el de período de prueba
// sí, aunque hoy los dos tengan la misma fila.
//
// Hojas mensuales `AAAAMM` — la liquidación de ese mes:
//   A Trabajador · B Sueldo · C Feriado · D Sueldo Total · E Aguinaldo Total
//   F TOTAL sueldo+SAC · G Sueldo Transferencia · H Aguinaldo Transferencia
//   I Total transferencia · J Consumos Mes · K Efectivo
//
// Leído de las FÓRMULAS de la planilla el 24/08/2026, que es lo que hay que
// emular. Cuatro columnas son cuentas de la misma fila —D=B+C, F=D+E, I=G+H,
// K=D+E−G−H— y el resto se tipea a mano. De esas, dos tienen regla y la
// planilla no la usa:
//
//   · C Feriado = ('Costos laborales'!B+C)/25 por cada feriado trabajado. La
//     base es el neto COMPLETO de esa persona (remunerativo + no remunerativo),
//     no el sueldo de la hoja Nómina — ver importeFeriado. La cantidad de
//     feriados no está en ningún lado: viene multiplicada adentro de la fórmula
//     (junio son dos feriados y se ve como un /25 con el importe al doble).
//   · E Aguinaldo Total, en junio y diciembre. Los cuatro importes de 202606
//     coinciden al peso con lo que ya devuelve `sacDelMes`.
//   · G Sueldo Transferencia se tipea, pero es exactamente `Nómina!D` (el "en
//     blanco neto"). H Aguinaldo Transferencia no tiene regla que se pueda
//     derivar de nada de la planilla: es un importe que alguien decide.
//
// Y UNA QUE ESTÁ ROTA: J "Consumos Mes" es texto libre ("1 Coca: $2800 + 1 copa
// Imperial: $4800") y NINGUNA fórmula la usa. Los descuentos por consumo están
// tipeados a mano adentro de la fórmula de K ("=D5+E5-G5-H5-2800-4800"), así que
// corregir la nota no cambia el efectivo y nadie se entera. Por eso la app
// guarda el monto en una columna propia y lo mete en la fórmula de K: el número
// que se ve es el número que se resta.
//
// EL LAYOUT NO ES ESTABLE: la primera hoja (202605) tiene otras columnas.
// Cuando el encabezado no es el conocido se devuelve `null` en vez de adivinar,
// y esa hoja se lee solamente con los ojos.
//
// Pero SU REGLA sí está acá: 202605 fue el primer mes de todos y fue partido, y
// prorratea el sueldo por "Días trabajados" (columna D, tipeada a mano) sobre un
// 22 escrito fijo en la fórmula. Desde el 30/08/2026 la app hace esa misma
// cuenta para cualquier mes incompleto —el caso que la trajo de vuelta es un
// alta el 11/08— con el divisor corregido a los servicios reales del mes. Ver
// `serviciosDelMes` y `sueldoDelMes`.

const { google } = require('googleapis');
const NodeCache = require('node-cache');
const { parseMonto } = require('./monto');
const { diasDeServicioEntre, feriadosDelMes, feriadosDeServicioDelMes } = require('./calendario');

// Sin fallback a SPREADSHEET_ID — ver punto 2 del encabezado.
const SHEET_ID = process.env.NOMINA_SHEET_ID || null;
const HOJA_EMPLEADOS = process.env.NOMINA_HOJA || 'Nómina';
const HOJA_COSTOS = process.env.NOMINA_HOJA_COSTOS || 'Costos laborales';

// Lo único que la app agrega a la hoja `Nómina`: quién tocó esa fila y cuándo.
// Es la misma idea que la columna `Actualizado` de las hojas mensuales, y por la
// misma razón: un sueldo que cambia sin decir quién lo cambió no se audita.
const COL_NOMINA_ACTUALIZADO = 'Actualizado';

const cache = new NodeCache({ stdTTL: 300 });

// ─── Los factores de la planilla ────────────────────────────────────────────
// Configurables por env porque son parámetros del negocio, no del código: si
// cambian las cargas patronales, esto cambia sin tocar un archivo.
const FACTOR_BRUTO = Number(process.env.NOMINA_FACTOR_BRUTO || 1.2);
const FACTOR_COSTO_LABORAL = Number(process.env.NOMINA_FACTOR_COSTO_LABORAL || 1.67);
const MESES_VACACIONES = 24;   // medio sueldo al año → F/24 por mes
const MESES_AGUINALDO = 12;    // un sueldo al año → F/12 por mes
const DIAS_LABORABLES_MES = 25;  // divisor del feriado en las hojas mensuales
const DIAS_SEMESTRE = 180;
const MESES_SAC = [6, 12];

// ─── Quiénes son socios ─────────────────────────────────────────────────────
//
// SE DICE, NO SE DEDUCE. Hasta el 30/08/2026 esto salía de una inferencia —"no
// tiene parte registrada, entonces es socio"— y esa inferencia es falsa: alguien
// en período de prueba también cobra todo en efectivo y no es socio. El caso
// real es Priscila Olmos, que entró el 11/08/2026, y la inferencia le sacaba el
// feriado y el aguinaldo, que le corresponden.
//
// Ser socio y no tener parte registrada son dos cosas distintas y se usan para
// dos cosas distintas: de la primera depende si la persona cobra feriado y SAC;
// de la segunda, si hay cargas y provisiones. Se separan.
//
// Por variable de entorno y no en el código porque es un hecho del negocio que
// cambia sin que cambie nada más. Al 30/08/2026 los socios son Pablo y Tincho;
// acá va sólo Pablo porque Tincho no hace trabajo operativo y no está en la
// nómina. Cuando entre —en septiembre, cuando empiece a hacer servicios— hay
// que agregar su nombre EXACTO como figure en la hoja `Nómina`, con
// NOMINA_SOCIOS="Pablo Vergani, <su nombre>".
const SOCIOS = (process.env.NOMINA_SOCIOS || 'Pablo Vergani')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ─── Efectivizaciones: lo que la hoja todavía no dice ───────────────────────
//
// Que alguien tenga cargas, vacaciones y aguinaldo prorrateado lo decide su
// PARTE REGISTRADA ("en blanco neto"), que sale de la hoja `Nómina`. Quien cobra
// todo en efectivo tiene cero y su sueldo pasa entero al costo del mes.
//
// El problema es el momento: cuando alguien pasa a estar en blanco, ese número
// aparece en la hoja el día que alguien lo escribe, y hasta entonces su costo se
// lee como si siguiera cobrando todo en negro. El costo laboral queda por debajo
// de lo real y con él el punto de equilibrio, en silencio — que es exactamente
// el agujero que ya costó $1.400.000 por mes con una fila a medias.
//
// El caso real: Priscila Olmos entró el 11/08/2026 en período de prueba y
// arranca EFECTIVA en septiembre, como el resto. Decirlo acá hace que desde ese
// mes su costo tenga cargas y provisiones sin esperar a la planilla; y en cuanto
// la planilla tenga su parte registrada, ese número manda y esto se apaga solo.
//
//   NOMINA_EFECTIVOS="Priscila Olmos:2026-09"          se estima la parte en blanco
//   NOMINA_EFECTIVOS="Priscila Olmos:2026-09:700000"   o se dice cuál es
//
// Sin monto se usa la MISMA parte registrada que tiene el resto —la mediana de
// quienes ya la tienen—, que es literalmente lo que quiere decir "efectiva como
// todos". Es una estimación, viaja marcada como tal para que la pantalla lo diga,
// y no se usa en ningún lado donde se pague plata (ver `enBlancoPrevistoARS`).
const EFECTIVOS = (() => {
  const m = new Map();
  for (const item of String(process.env.NOMINA_EFECTIVOS || 'Priscila Olmos:2026-09').split(',')) {
    const partes = item.split(':').map(x => x.trim());
    const nombre = (partes[0] || '').toLowerCase();
    const mes = partes[1] || '';
    if (!nombre || !/^[0-9]{4}-[0-9]{2}$/.test(mes)) continue;
    const monto = partes[2] ? parseMonto(partes[2]) : 0;
    m.set(nombre, { mesId: mes.replace('-', ''), enBlancoARS: monto > 0 ? monto : null });
  }
  return m;
})();

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ─── La hoja mensual ────────────────────────────────────────────────────────
// El encabezado exacto de las hojas AAAAMM que la app entiende. Se compara
// entero: es lo que separa una hoja con este layout de 202605, que tiene otro.
const HEADER_MENSUAL = [
  'Trabajador/a', 'Sueldo', 'Feriado', 'Sueldo Total', 'Aguinaldo Total',
  'TOTAL sueldo + SAC', 'Sueldo Transferencia', 'Aguinaldo Transferencia',
  'Total transferencia', 'Consumos Mes', 'Efectivo',
];
const COL_MES = {
  nombre: 0, sueldo: 1, feriado: 2, sueldoTotal: 3, aguinaldo: 4, total: 5,
  sueldoTransf: 6, aguinaldoTransf: 7, totalTransf: 8, consumos: 9, efectivo: 10,
};

// Lo que la app agrega al final, sin pisar una sola columna de las de arriba.
//
// `Feriados` es la cantidad, que en la planilla no existe: está multiplicada
// adentro de la fórmula del importe, así que cambiarla obliga a editar una
// fórmula. `Consumos ARS` es el monto que J nunca fue. `Actualizado` dice quién
// guardó y cuándo, que es lo único que después contesta "¿esto lo tocó alguien
// o quedó de la vez pasada?".
// `Servicios` es cuántos días de los que el bar abre trabajó la persona ese mes.
// Sólo se aparta de los del mes cuando alguien entró (o se fue) empezado el mes.
//
// Es EDITABLE, y hace falta que lo sea: el calendario de `calendario.js` dice
// martes a sábado, y eso recién es verdad desde agosto de 2026. En junio el bar
// abría domingos y lunes y cerraba martes y miércoles (7 días fuera del patrón y
// 7 martes-a-sábado cerrados, medido contra Fudo el 30/08/2026); en julio quedó
// una sola excepción. Cualquier mes con una apertura o un cierre fuera de lo
// habitual necesita que este número se corrija a mano.
const COLS_APP_MES = {
  servicios: 'Servicios', feriados: 'Feriados', consumos: 'Consumos ARS', actualizado: 'Actualizado',
};

// ─── Puras: fechas y claves de mes ──────────────────────────────────────────
const dosDigitos = n => String(n).padStart(2, '0');
const mesIdDe = d => `${d.getFullYear()}${dosDigitos(d.getMonth() + 1)}`;
const parseMesId = id => ({ anio: Number(String(id).slice(0, 4)), mes: Number(String(id).slice(4, 6)) });
const nombreMesDe = id => MESES[parseMesId(id).mes - 1] || '';

function mesIdSuma(id, n) {
  const { anio, mes } = parseMesId(id);
  const d = new Date(anio, mes - 1 + n, 1);
  return mesIdDe(d);
}

const esMesIdValido = id => /^\d{4}(0[1-9]|1[0-2])$/.test(String(id || ''));

// Google Sheets cuenta los días desde el 30/12/1899. Las fechas de esta planilla
// llegan como serial y NO como texto, así que acá sí se lee el serial — es lo
// contrario de la hoja Movimientos, donde el serial guarda un error de tipeo y
// hay que leer el texto mostrado (ver el comentario de parseDate en sheets.js).
// La diferencia es que esta planilla se cargó bien desde el principio.
const EPOCH_SHEETS = Date.UTC(1899, 11, 30);
function fechaDeSerial(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(EPOCH_SHEETS + n * 86400000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Acepta el serial (lo normal) o un texto D/M/AA o AAAA-MM-DD, por si alguien
// tipea una fecha a mano en una fila nueva.
function parseFecha(valor) {
  if (valor == null || valor === '') return null;
  if (typeof valor === 'number') return fechaDeSerial(valor);
  const s = String(valor).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return fechaDeSerial(s);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let anio = Number(m[3]);
    if (anio < 100) anio += 2000;
    return new Date(anio, Number(m[2]) - 1, Number(m[1]));
  }
  return null;
}

const diaISO = d => (d ? `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}` : null);

// Los importes vienen como número cuando se pide UNFORMATTED_VALUE, pero una
// celda tipeada a mano puede llegar como "$1.700.000", y lo que edita la app
// llega como texto del navegador. Una sola regla para las tres cosas.
//
// La copia que vivía acá leía "$1.700.000" como 1,7 — sólo miraba el separador
// de más a la derecha y dejaba el resto para que `parseFloat` los cortara.
const parseImporte = parseMonto;

const norm = s => (s || '').toString().trim().toLowerCase();

// La fila de `Costos laborales` de alguien, o null si no existe o está a medias.
// Todo el módulo pregunta por acá: la planilla manda, pero una fila sin terminar
// no es lo que la planilla dice, es lo que a la planilla le falta.
const costoDe = (porCosto, nombre) => {
  const c = porCosto.get(norm(nombre));
  return c && c.completo ? c : null;
};

// Un cero ESCRITO no es lo mismo que una celda vacía, y en esta planilla la
// diferencia es plata: en junio la transferencia de dos personas dice 0 a
// propósito, y leer ese 0 como "no hay dato" haría que el default les invente
// una transferencia que nadie hizo. `parseImporte` devuelve 0 para las dos
// cosas, así que la ausencia se contesta antes de llamarlo.
const importeONull = v => (v == null || v === '' ? null : parseImporte(v));
const enteroONull = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

// 0 → A, 25 → Z, 26 → AA.
function colLetra(i) {
  let s = '', n = i;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

// ─── Puras: parseo de las hojas ─────────────────────────────────────────────

// Una fila con nombre pero sin sueldo NO se descarta en silencio: se devuelve
// marcada como incompleta. Es el caso real del 17/8/2026 — alguien ya trabajando
// y todavía sin cargar. Descartarla haría que el costo laboral quede bajo y el
// punto de equilibrio con ella, sin que nada lo diga.
function parsearEmpleados(filas) {
  const out = [];
  for (let i = 1; i < (filas || []).length; i++) {
    const f = filas[i] || [];
    const nombre = (f[0] || '').toString().trim();
    if (!nombre) continue;
    if (/^total$/i.test(nombre)) continue;
    const sueldoActual = parseImporte(f[2]);
    const enBlancoNeto = parseImporte(f[3]);
    const ingreso = parseFecha(f[1]);
    const faltan = [];
    if (!ingreso) faltan.push('fecha de ingreso');
    if (!(sueldoActual > 0)) faltan.push('sueldo');
    out.push({
      id: `emp-${i + 1}`,
      // En qué renglón de la hoja está. Viaja para poder mostrarlo, no para
      // escribir con él: el guardado relee y resuelve por nombre (ver
      // `guardarEmpleados`), porque una fila se mueve si alguien edita la
      // planilla mientras la pantalla está abierta.
      rowIndex: i + 1,
      nombre,
      ingreso,
      ingresoISO: diaISO(ingreso),
      sueldoActualARS: sueldoActual,
      enBlancoNetoARS: enBlancoNeto,
      // Por la lista, no por la hoja: ver SOCIOS. Que no tenga parte registrada
      // se lee de `enBlancoNetoARS` y decide otra cosa (las cargas), no ésta.
      esSocio: SOCIOS.includes(norm(nombre)),
      completo: faltan.length === 0,
      leFalta: faltan,
    });
  }
  return conEfectivizaciones(out);
}

// La parte registrada que le corresponde a quien se efectiviza y la hoja todavía
// no muestra. Orden: lo que se dijo en la variable; si no, la misma que tiene el
// resto; si no hay contra qué compararse, su sueldo entero — el peor caso para
// el costo, que es el que NO deja el número por debajo de lo real.
//
// Nunca pisa `enBlancoNetoARS`, y eso es deliberado: ese campo es el default de
// lo que se transfiere en la liquidación, o sea PLATA que se escribe en la
// planilla. Una estimación no entra por esa puerta. Viaja aparte y sólo la usa
// el costo.
function conEfectivizaciones(empleados) {
  if (!EFECTIVOS.size) return empleados;
  const registradas = empleados
    .map(e => e.enBlancoNetoARS || 0).filter(v => v > 0).sort((a, b) => a - b);
  const mediana = registradas.length ? registradas[Math.floor((registradas.length - 1) / 2)] : 0;
  return empleados.map(e => {
    const ef = EFECTIVOS.get(norm(e.nombre));
    if (!ef) return e;
    const previsto = ef.enBlancoARS != null ? ef.enBlancoARS : (mediana || e.sueldoActualARS || 0);
    return {
      ...e,
      efectivaDesdeMesId: ef.mesId,
      // Nunca más que su propio sueldo: la parte registrada es una porción de lo
      // que cobra, no algo que se le suma.
      enBlancoPrevistoARS: Math.min(previsto, e.sueldoActualARS || previsto),
      enBlancoPrevistoOrigen: ef.enBlancoARS != null ? 'dicho' : (mediana ? 'resto' : 'sueldo'),
    };
  });
}

// La parte registrada de una persona en un mes. La hoja manda siempre; la
// efectivización sólo contesta cuando la hoja todavía dice cero, y sólo desde el
// mes en que arranca. Sin mes no hay efectivización posible: no se sabe cuándo.
function parteRegistrada(empleado, mesId) {
  const enLaHoja = empleado.enBlancoNetoARS || 0;
  if (enLaHoja > 0) return { montoARS: enLaHoja, estimado: false };
  if (!empleado.efectivaDesdeMesId || !mesId || mesId < empleado.efectivaDesdeMesId) {
    return { montoARS: 0, estimado: false };
  }
  return { montoARS: empleado.enBlancoPrevistoARS || 0, estimado: true };
}

// La hoja de costos trae valores pisados a mano en algunas celdas (al 17/8/2026,
// el costo laboral de dos personas y el neto remunerativo de una). Se leen tal
// cual: la planilla manda sobre la fórmula. Lo que calcula este módulo sirve
// para los meses que todavía no existen y para detectar cuándo la planilla y la
// regla dejaron de coincidir.
function parsearCostos(filas) {
  const out = [];
  for (let i = 1; i < (filas || []).length; i++) {
    const f = filas[i] || [];
    const nombre = (f[0] || '').toString().trim();
    if (!nombre || /^total$/i.test(nombre)) continue;
    out.push({
      nombre,
      // Una fila a medias NO es un costo de cero, y la diferencia son millones.
      // El caso real (30/08/2026): Priscila Olmos tiene su fila con el sueldo en
      // C y las derivadas vacías, porque las fórmulas todavía no se arrastraron.
      // `parseImporte` devuelve 0 para una celda vacía igual que para un 0
      // escrito, así que su costo total se leía como CERO y su sueldo entero
      // desaparecía del costo laboral y del punto de equilibrio, en silencio.
      //
      // La celda que decide es la última, "Costo total mensual": si está vacía
      // la fila no está terminada y se usa la regla en su lugar. Un 0 ESCRITO sí
      // se respeta — es el caso de las columnas de Pablo, que valen cero de
      // verdad.
      completo: f[8] != null && f[8] !== '',
      netoRemunerativoARS: parseImporte(f[1]),
      netoNoRemunerativoARS: parseImporte(f[2]),
      brutoPorReciboARS: parseImporte(f[3]),
      costoLaboralARS: parseImporte(f[4]),
      costoLaboralMasNoRemARS: parseImporte(f[5]),
      prorrateoVacacionesARS: parseImporte(f[6]),
      prorrateoAguinaldoARS: parseImporte(f[7]),
      costoTotalMensualARS: parseImporte(f[8]),
    });
  }
  return out;
}

// ─── Puras: las reglas ──────────────────────────────────────────────────────

// El costo de una persona derivado SÓLO de su fila en `Nómina`. Es la regla, no
// el dato: sirve para proyectar y para contrastar contra lo que dice la hoja de
// costos.
function costoDeEmpleado(empleado, { mesId = null, factorCostoLaboral = FACTOR_COSTO_LABORAL, factorBruto = FACTOR_BRUTO } = {}) {
  const neto = empleado.sueldoActualARS || 0;
  // Con `mesId` entra la efectivización de quien todavía no figura en blanco en
  // la hoja; sin él, sólo lo que dice la hoja. Ver EFECTIVOS.
  const { montoARS: remunerativo, estimado } = parteRegistrada(empleado, mesId);
  const noRemunerativo = Math.max(0, neto - remunerativo);

  if (empleado.esSocio || remunerativo === 0) {
    // Sin parte registrada no hay recibo, ni cargas, ni vacaciones, ni SAC: el
    // sueldo pasa entero al costo del mes. Son DOS casos y no uno: el socio, y
    // quien todavía cobra todo en efectivo (un período de prueba). Acá dan lo
    // mismo —lo que se paga a ARCA es cero en los dos— y en el feriado y el
    // aguinaldo no: eso lo decide `esSocio`, que ya no se deduce de esta fila.
    return {
      nombre: empleado.nombre,
      netoRemunerativoARS: 0, netoNoRemunerativoARS: neto,
      brutoPorReciboARS: 0, costoLaboralARS: 0,
      costoLaboralMasNoRemARS: neto,
      prorrateoVacacionesARS: 0, prorrateoAguinaldoARS: 0,
      cargasARS: 0,
      costoTotalMensualARS: neto,
      esSocio: true,
      estimado: false,
    };
  }

  const bruto = remunerativo * factorBruto;
  const costoLaboral = remunerativo * factorCostoLaboral;
  const base = costoLaboral + noRemunerativo;
  const vacaciones = base / MESES_VACACIONES;
  const aguinaldo = base / MESES_AGUINALDO;
  return {
    nombre: empleado.nombre,
    netoRemunerativoARS: remunerativo,
    netoNoRemunerativoARS: noRemunerativo,
    brutoPorReciboARS: bruto,
    costoLaboralARS: costoLaboral,
    costoLaboralMasNoRemARS: base,
    prorrateoVacacionesARS: vacaciones,
    prorrateoAguinaldoARS: aguinaldo,
    // Todo lo que va a ARCA por esta persona: aportes del trabajador retenidos
    // más contribuciones patronales. Es costoLaboral − lo que la persona cobra
    // de la parte registrada.
    cargasARS: costoLaboral - remunerativo,
    costoTotalMensualARS: base + vacaciones + aguinaldo,
    esSocio: false,
    // La parte registrada no salió de la hoja sino de una efectivización dicha:
    // el número es el mejor disponible y la pantalla tiene que poder decirlo.
    estimado,
  };
}

// ─── El mes incompleto ──────────────────────────────────────────────────────
//
// Quien entra el 11 no trabajó el mes entero y no cobra el mes entero. La unidad
// es el SERVICIO —un día que el bar abre, martes a sábado; ver calendario.js— y
// no el día calendario: un alta un lunes y la misma alta un martes no valen lo
// mismo, porque el lunes el bar está cerrado.
//
// LA FORMA de la cuenta sale de la hoja 202605, que fue el primer mes de todos y
// fue partido:
//
//   H "Sueldo Total" = 'Nómina'!C / 22 * D    ·    D "Días trabajados", a mano
//
// Pero SÓLO la forma, y conviene saber por qué. Ese 22 está escrito fijo en la
// fórmula, y su D tampoco eran días de servicio: en mayo de 2026 el bar abrió
// nada más que 10 días —del 18 en adelante, de jueves a lunes— y sin embargo la
// hoja dice 14 y 11. Es una cuenta de días calendario desde que abrió el local,
// hecha a mano en un mes que no se parecía a ninguno de los que vinieron después.
//
// Acá la unidad es el SERVICIO y el divisor son los servicios REALES del mes, que
// es lo que pidió Gonzalo el 30/08/2026. Con un divisor fijo en 22, quien trabaje
// un agosto completo (21 servicios) cobraría 21/22 del sueldo; el error no se veía
// en mayo porque nadie trabajó el mes entero.
//
// El feriado NO se prorratea: es un importe por día trabajado, va aparte en su
// columna y ya se cuenta de a uno.
function serviciosDelMes(mesId) {
  const { anio, mes } = parseMesId(mesId);
  return diasDeServicioEntre(new Date(anio, mes - 1, 1), new Date(anio, mes, 0));
}

// Los servicios que le tocan a una persona en ese mes. Sin fecha de ingreso se
// devuelven los del mes entero: no saber cuándo entró no es lo mismo que saber
// que entró tarde, y descontarle plata por un dato que falta sería inventar en
// contra de la persona. La fila ya viaja marcada como incompleta.
function serviciosTrabajados(empleado, mesId) {
  const { anio, mes } = parseMesId(mesId);
  const inicio = new Date(anio, mes - 1, 1);
  const fin = new Date(anio, mes, 0);
  const ingreso = empleado && empleado.ingreso;
  if (!ingreso || ingreso <= inicio) return diasDeServicioEntre(inicio, fin);
  if (ingreso > fin) return 0;
  return diasDeServicioEntre(ingreso, fin);
}

// Los feriados del mes que se pagan: los que caen en un día que el bar abre.
//
// Es LA corrección del 31/8/2026. Hasta ese día la cantidad se tipeaba a mano y
// la pregunta que se contestaba era "¿hubo un feriado este mes?" — y la que hay
// que contestar es "¿hubo un feriado en un día de servicio?". El 17 de agosto de
// 2026 fue lunes: el bar estaba cerrado, nadie lo trabajó y agosto no tiene
// adicional que pagar, aunque el mes tenga un feriado en el almanaque.
function feriadosDeServicio(mesId) {
  const { anio, mes } = parseMesId(mesId);
  return feriadosDeServicioDelMes(anio, mes);
}

// Los que le tocan a una persona: los de servicio desde que entró. Quien empezó
// el 11 no trabajó el feriado del 4. Sin fecha de ingreso se cuentan todos, por
// la misma razón que en `serviciosTrabajados`: no saber cuándo entró no es saber
// que entró tarde, y descontar por un dato que falta sería inventar en contra de
// la persona.
function feriadosTrabajados(empleado, mesId) {
  const feriados = feriadosDeServicio(mesId);
  const ingreso = empleado && empleado.ingreso;
  if (!ingreso) return feriados.length;
  const desde = diaISO(ingreso);
  return feriados.filter(f => f.fecha >= desde).length;
}

// El sueldo del mes. El mes completo cobra el sueldo completo SIN pasar por la
// división: `base * (21/21)` no siempre da `base` exacto en punto flotante, y
// una diferencia de centavos en el sueldo de todos los meses de todo el mundo
// sería un ruido que nadie puede explicar.
function sueldoDelMes(empleado, mesId, { servicios = null } = {}) {
  const base = (empleado && empleado.sueldoActualARS) || 0;
  const total = serviciosDelMes(mesId);
  const trabajados = servicios != null ? servicios : serviciosTrabajados(empleado, mesId);
  if (!total || trabajados >= total) return base;
  if (trabajados <= 0) return 0;
  return base * (trabajados / total);
}

// Feriado trabajado: un día de sueldo sobre 25 días laborables, por feriado.
//
// Dos detalles que salen de comparar contra las hojas mensuales reales:
//
// · El socio NO cobra feriado. En las tres hojas mensuales su columna Feriado
//   está en cero, y es coherente con el resto de su trato: cobra su sueldo y
//   nada más. Quien no está registrado pero TAMPOCO es socio sí lo cobra: la
//   base es su sueldo de la hoja Nómina, porque no tiene fila en Costos
//   laborales — ver el aviso que devuelve `guardarLiquidacion`.
// · La base es el neto de la HOJA DE COSTOS (remunerativo + no remunerativo),
//   no el "sueldo actual" de la hoja Nómina. Normalmente son el mismo número
//   —uno se deriva del otro— pero cuando alguien pisa a mano el neto
//   remunerativo dejan de coincidir, y la planilla calcula el feriado con el
//   pisado. Es una diferencia de $246 en un caso real: chica, y justamente por
//   eso el tipo de cosa que después nadie encuentra.
function importeFeriado(empleado, cantidad = 1, { costo = null } = {}) {
  if (!cantidad || empleado.esSocio) return 0;
  const base = costo
    ? (costo.netoRemunerativoARS || 0) + (costo.netoNoRemunerativoARS || 0)
    : (empleado.sueldoActualARS || 0);
  return (base / DIAS_LABORABLES_MES) * cantidad;
}

// Días trabajados dentro del semestre que cierra en `mesId`. Es lo que prorratea
// el SAC de quien entró con el semestre empezado.
//
// Se cuentan los días TRANSCURRIDOS entre el ingreso y el cierre del semestre,
// sin sumar uno por el día de ingreso: es como lo cuenta la planilla (14/05 a
// 30/06 = 47 días, no 48) y cambiar el criterio movería el aguinaldo de todos.
function diasEnElSemestre(empleado, mesId) {
  const { anio, mes } = parseMesId(mesId);
  const inicioSemestre = new Date(anio, mes <= 6 ? 0 : 6, 1);
  const finSemestre = new Date(anio, mes, 0);   // último día del mes de pago
  const desde = empleado.ingreso && empleado.ingreso > inicioSemestre ? empleado.ingreso : inicioSemestre;
  if (desde > finSemestre) return 0;
  return Math.round((finSemestre - desde) / 86400000);
}

// SAC del mes: medio sueldo del mes, prorrateado por los días del semestre. Sólo
// en junio y diciembre; en cualquier otro mes es cero, porque el devengamiento
// mensual ya está en el prorrateo de la hoja de costos y sumar los dos sería
// contar el aguinaldo dos veces.
function sacDelMes(empleado, mesId, { sueldoTotalARS } = {}) {
  const { mes } = parseMesId(mesId);
  if (!MESES_SAC.includes(mes)) return 0;
  const base = sueldoTotalARS != null ? sueldoTotalARS : (empleado.sueldoActualARS || 0);
  const dias = Math.min(diasEnElSemestre(empleado, mesId), DIAS_SEMESTRE);
  if (dias <= 0) return 0;
  return (base / 2) * (dias / DIAS_SEMESTRE);
}

const vigenteEn = (empleado, fecha) => Boolean(empleado.ingreso && empleado.ingreso <= fecha);

const dotacionEn = (empleados, fecha) => (empleados || []).filter(e => vigenteEn(e, fecha));

// Altas agrupadas por fecha. La planilla no tiene columna de egreso: una baja se
// borra la fila, así que el historial que se puede afirmar es sólo el de altas.
// Decir más que eso sería inventar.
//
// Se agrupa porque cinco personas que entraron el mismo día son UN cambio de
// dotación, no cinco: listadas de a una parecen cinco eventos distintos y eso es
// exactamente lo que no hay que hacerle leer a un modelo.
function cambiosDeDotacion(empleados, { desde, hasta } = {}) {
  const porFecha = new Map();
  for (const e of (empleados || [])) {
    if (!e.ingreso) continue;
    if (desde && e.ingreso < desde) continue;
    if (hasta && e.ingreso > hasta) continue;
    if (!porFecha.has(e.ingresoISO)) porFecha.set(e.ingresoISO, []);
    porFecha.get(e.ingresoISO).push(e.nombre);
  }
  return [...porFecha.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fecha, nombres]) => ({ fecha, tipo: 'alta', personas: nombres.length, nombres }));
}

// ─── El cálculo de un mes ───────────────────────────────────────────────────
//
// Un mes pasado y uno futuro se calculan con el mismo código: la única
// diferencia es cuántos feriados se trabajaron, y eso ya no hay que decírselo:
// sale del calendario. `feriados` sigue existiendo para poder preguntar "¿y si
// se trabajan dos?", pero `null` —el default— significa "los que dice el
// almanaque", no cero.
function calcularMes({ empleados, mesId, feriados = null, costos = null } = {}) {
  if (!esMesIdValido(mesId)) throw new Error(`Mes inválido: ${mesId} (se espera AAAAMM)`);
  const { anio, mes } = parseMesId(mesId);
  const finDeMes = new Date(anio, mes, 0);
  const serviciosMes = serviciosDelMes(mesId);
  const feriadosMes = feriadosDelMes(anio, mes);

  const porCosto = new Map((costos || []).map(c => [norm(c.nombre), c]));

  const porEmpleado = (empleados || [])
    .filter(e => e.completo && vigenteEn(e, finDeMes))
    .map(e => {
      // La hoja de costos manda cuando existe: tiene valores pisados a mano que
      // son la verdad de hoy. La regla se calcula igual, para poder mostrar
      // dónde dejaron de coincidir.
      const regla = costoDeEmpleado(e, { mesId });
      const cargado = costoDe(porCosto, e.nombre);
      // Los que le tocan a esta persona, salvo que se haya pedido un número. El
      // socio no cobra feriado —su importe da cero— así que su cantidad es cero
      // y no un número al lado de un importe vacío.
      const feriadosPersona = e.esSocio ? 0 : (feriados == null ? feriadosTrabajados(e, mesId) : feriados);
      const feriadoARS = importeFeriado(e, feriadosPersona, { costo: cargado });
      // El mes en que alguien entra cuesta lo que trabajó, no un mes entero. La
      // proporción es la misma para el sueldo y para el costo con cargas: las
      // cargas y las provisiones se devengan sobre lo que se paga.
      const servicios = serviciosTrabajados(e, mesId);
      const parte = serviciosMes > 0 ? Math.min(1, servicios / serviciosMes) : 1;
      const sueldoARS = sueldoDelMes(e, mesId, { servicios });
      // El SAC se calcula sobre el sueldo COMPLETO a propósito. `sacDelMes` ya
      // prorratea por los días del semestre —que es donde entra que la persona
      // haya entrado tarde— y prorratear también la base contaría el mes partido
      // dos veces, dejando el aguinaldo por debajo.
      const sacBaseARS = (e.sueldoActualARS || 0) + feriadoARS;
      const sacARS = e.esSocio ? 0 : sacDelMes(e, mesId, { sueldoTotalARS: sacBaseARS });
      const costoBase = (cargado ? cargado.costoTotalMensualARS : regla.costoTotalMensualARS) * parte;
      return {
        id: e.id, nombre: e.nombre, esSocio: e.esSocio,
        sueldoARS,
        servicios, serviciosMes, mesIncompleto: servicios < serviciosMes,
        feriados: feriadosPersona, feriadoARS,
        sueldoTotalARS: sueldoARS + feriadoARS,
        sacARS,
        // Lo que la persona cobra en la mano ese mes.
        aCobrarARS: sueldoARS + feriadoARS + sacARS,
        // Lo que le cuesta al bar ese mes, con cargas y provisiones.
        costoTotalARS: costoBase + feriadoARS,
        cargasARS: (cargado ? cargado.costoLaboralARS - cargado.netoRemunerativoARS : regla.cargasARS) * parte,
        provisionesARS: (cargado
          ? cargado.prorrateoVacacionesARS + cargado.prorrateoAguinaldoARS
          : regla.prorrateoVacacionesARS + regla.prorrateoAguinaldoARS) * parte,
        origen: cargado ? 'planilla' : 'regla',
        difContraLaReglaARS: cargado ? cargado.costoTotalMensualARS - regla.costoTotalMensualARS : 0,
      };
    });

  const suma = campo => porEmpleado.reduce((s, e) => s + (e[campo] || 0), 0);
  const incompletos = (empleados || []).filter(e => !e.completo);

  return {
    mesId, anio, mes: MESES[mes - 1], esMesDeSAC: MESES_SAC.includes(mes),
    // Los que se pagan —los que caen con el bar abierto— y el detalle de TODOS
    // los del mes, para poder decir por qué uno no se paga en vez de mostrar un
    // cero sin explicación.
    feriados: feriados == null ? feriadosMes.filter(f => f.servicio).length : feriados,
    feriadosMes,
    serviciosMes,
    porEmpleado,
    totales: {
      dotacion: porEmpleado.length,
      sueldosARS: suma('sueldoARS'),
      feriadosARS: suma('feriadoARS'),
      sacARS: suma('sacARS'),
      aCobrarARS: suma('aCobrarARS'),
      cargasARS: suma('cargasARS'),
      provisionesARS: suma('provisionesARS'),
      costoTotalARS: suma('costoTotalARS'),
    },
    // Las filas de la nómina que todavía no se pueden calcular. Van adelante y
    // no escondidas: si falta cargar a alguien, el total está bajo y hay que
    // poder verlo sin hacer la cuenta.
    incompletos: incompletos.map(e => ({ nombre: e.nombre, leFalta: e.leFalta })),
    origen: 'calculado',
  };
}

// Cuánto aguinaldo se paga en cada mes de SAC de los próximos `meses` meses.
// Sale del mismo `calcularMes` que usa la pantalla, así que la proyección y lo
// que se ve en Nómina no pueden decir cosas distintas.
function sacDeLosProximosMeses({ empleados, costos, desde = new Date(), meses = 12 } = {}) {
  const out = {};
  const desdeId = mesIdDe(desde);
  for (let i = 0; i < meses; i++) {
    const mesId = mesIdSuma(desdeId, i);
    if (!MESES_SAC.includes(parseMesId(mesId).mes)) continue;
    const m = calcularMes({ empleados, costos, mesId });
    if (m.totales.sacARS > 0) out[mesId] = m.totales.sacARS;
  }
  return out;
}

// `feriados = null` es "los que dice el calendario en cada mes", que es lo que
// hace que la proyección no le ponga el mismo número a todos los meses: un
// diciembre con dos feriados abiertos no cuesta lo mismo que un agosto con uno
// que cayó lunes.
const calcularRango = ({ empleados, costos, desdeMesId, meses = 12, feriados = null }) => {
  const out = [];
  for (let i = 0; i < meses; i++) out.push(calcularMes({ empleados, costos, mesId: mesIdSuma(desdeMesId, i), feriados }));
  return out;
};

// ─── El costo laboral partido en tres ───────────────────────────────────────
//
// LA función de este módulo, y la que hay que leer entera antes de cambiarla.
// Devuelve el costo separado por DÓNDE CAE EN EL LIBRO, que es lo que permite
// verificar que nada se cuenta dos veces:
//
//   · netoTrabajadoresARS — lo que cobran las personas.
//   · cargasARS — lo que va a ARCA. En teoría es categoría Fiscales; en la
//     práctica se carga dentro de Personal (verificado el 17/8/2026 — ver el
//     punto 3 del encabezado del archivo).
//   · provisionesARS — vacaciones y aguinaldo devengados. No sale de ninguna
//     caja este mes y no está en ninguna fila del libro: si no lo aporta la
//     nómina, no lo aporta nadie.
//
// `costoParaPuntoDeEquilibrioARS` es la suma de los tres. Se llama distinto del
// total y no es un alias por pereza: si mañana las cargas empiezan a cargarse
// como Fiscales, este es el único número que hay que cambiar, y el que dice por
// qué.
// `mesId` decide qué efectivizaciones ya cuentan. Sin él se mira el mes que
// VIENE y no el corriente, a propósito: este número es la vara del punto de
// equilibrio, y una efectivización ya decidida que arranca el mes próximo no
// puede aparecer el día 1 como una sorpresa — el objetivo de la noche se fija
// antes. Un mes de anticipación y no más: algo que pasa dentro de un año no
// tiene por qué inflar el costo de hoy.
function resumenCostoLaboral({ empleados, costos, mesId = null } = {}) {
  const mes = mesId || mesIdSuma(mesIdDe(new Date()), 1);
  const completos = (empleados || []).filter(e => e.completo);
  const porCosto = new Map((costos || []).map(c => [norm(c.nombre), c]));

  let neto = 0, cargas = 0, provisiones = 0, aguinaldo = 0, total = 0;
  const detalle = [];
  // Quiénes tienen fila en 'Costos laborales' pero sin terminar. Su costo sale
  // de la regla y no de la planilla, que es lo correcto pero no es lo mismo: la
  // regla no conoce los valores pisados a mano. Se nombran.
  const aMedias = [];
  for (const e of completos) {
    const regla = costoDeEmpleado(e, { mesId: mes });
    const cargado = costoDe(porCosto, e.nombre);
    const enLaHoja = porCosto.get(norm(e.nombre));
    if (enLaHoja && !cargado) aMedias.push(e.nombre);
    const fuente = cargado || regla;
    const c = {
      netoARS: fuente.netoRemunerativoARS + fuente.netoNoRemunerativoARS,
      cargasARS: fuente.costoLaboralARS - fuente.netoRemunerativoARS,
      vacacionesARS: fuente.prorrateoVacacionesARS,
      aguinaldoARS: fuente.prorrateoAguinaldoARS,
      provisionesARS: fuente.prorrateoVacacionesARS + fuente.prorrateoAguinaldoARS,
      totalARS: fuente.costoTotalMensualARS,
    };
    neto += c.netoARS; cargas += c.cargasARS; provisiones += c.provisionesARS;
    aguinaldo += c.aguinaldoARS; total += c.totalARS;
    detalle.push({
      nombre: e.nombre, esSocio: e.esSocio, origen: cargado ? 'planilla' : 'regla', ...c,
      // Quien todavía no figura en blanco en la hoja y ya está efectivizado: su
      // costo tiene cargas y provisiones estimadas, y se dice desde cuándo.
      efectivaDesdeMesId: !cargado && regla.estimado ? e.efectivaDesdeMesId : null,
      estimado: Boolean(!cargado && regla.estimado),
      // Cuánto se despegó la planilla de la regla en esta fila. Al 17/8/2026 hay
      // dos filas con el costo laboral pisado a mano; la planilla manda, pero la
      // diferencia se muestra en vez de quedar escondida.
      difContraLaReglaARS: cargado ? cargado.costoTotalMensualARS - regla.costoTotalMensualARS : 0,
    });
  }

  const incompletos = (empleados || []).filter(e => !e.completo)
    .map(e => ({ nombre: e.nombre, leFalta: e.leFalta }));

  return {
    mesId: mes,
    dotacion: completos.length,
    netoTrabajadoresARS: neto,
    cargasARS: cargas,
    provisionesARS: provisiones,
    costoTotalMensualARS: total,
    // El costo completo MENOS el aguinaldo devengado, que viaja aparte en
    // `sacDevengadoMensualARS`. Los dos se suman del otro lado (fixedMensual):
    // partirlos así es lo que permite que el desglose del modal sume exacto en
    // vez de tener una fila que ya está adentro de otra. Si se devolviera el
    // total acá, el aguinaldo entraría dos veces.
    costoParaPuntoDeEquilibrioARS: total - aguinaldo,
    // El aguinaldo devengado por separado, que es lo que antes no estaba en el
    // costo fijo y dejaba el equilibrio de junio y diciembre por debajo.
    sacDevengadoMensualARS: aguinaldo,
    detalle,
    incompletos,
    costosAMedias: aMedias,
  };
}

// ─── La hoja mensual: leerla ────────────────────────────────────────────────
//
// Devuelve `null` si el encabezado no es el conocido. No es un error: es una
// hoja con otro layout (202605) y adivinar de qué columna sale el efectivo de
// alguien es exactamente lo que no hay que hacer con sueldos.
function parsearMesPlanilla(filas) {
  const cab = (filas || [])[0] || [];
  if (!HEADER_MENSUAL.every((h, i) => norm(cab[i]) === norm(h))) return null;

  const colDe = nombre => cab.findIndex(c => norm(c) === norm(nombre));
  const cols = {
    servicios: colDe(COLS_APP_MES.servicios),
    feriados: colDe(COLS_APP_MES.feriados),
    consumos: colDe(COLS_APP_MES.consumos),
    actualizado: colDe(COLS_APP_MES.actualizado),
  };

  const out = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] || [];
    const nombre = (f[COL_MES.nombre] || '').toString().trim();
    if (!nombre || /^total$/i.test(nombre)) continue;

    // J es texto libre en la planilla vieja y un número cuando alguien escribió
    // pesos ahí. Las dos lecturas se respetan: el texto queda como nota y el
    // número, como monto — pero sólo si la app todavía no tiene su columna.
    const jc = f[COL_MES.consumos];
    const consumosDeJ = typeof jc === 'number' ? jc : 0;
    const notaDeJ = typeof jc === 'number' ? '' : (jc == null ? '' : String(jc).trim());

    out.push({
      nombre,
      rowIndex: i + 1,
      sueldoARS: importeONull(f[COL_MES.sueldo]),
      feriadoARS: importeONull(f[COL_MES.feriado]),
      aguinaldoARS: importeONull(f[COL_MES.aguinaldo]),
      sueldoTransferenciaARS: importeONull(f[COL_MES.sueldoTransf]),
      aguinaldoTransferenciaARS: importeONull(f[COL_MES.aguinaldoTransf]),
      efectivoPlanillaARS: importeONull(f[COL_MES.efectivo]),
      consumosNota: notaDeJ,
      servicios: cols.servicios >= 0 ? enteroONull(f[cols.servicios]) : null,
      feriados: cols.feriados >= 0 ? enteroONull(f[cols.feriados]) : null,
      consumosARS: cols.consumos >= 0 ? importeONull(f[cols.consumos]) : (consumosDeJ || null),
      actualizado: cols.actualizado >= 0 ? String(f[cols.actualizado] || '').trim() : '',
    });
  }
  return { cols, filas: out };
}

// ─── La liquidación de un mes ───────────────────────────────────────────────
//
// Qué cobra cada uno este mes y cómo se le paga. Es `calcularMes` mirado desde
// el otro lado: aquél contesta cuánto le CUESTA al bar (cargas y provisiones
// incluidas), éste contesta cuánto se PAGA y de qué forma — que es la pregunta
// del día 1 de cada mes, con la plata sobre la mesa.
//
// LA PLANILLA MANDA SOBRE LA REGLA, celda por celda. Cada valor sale de la hoja
// del mes si está escrito ahí, y de la regla si no. No es una preferencia de
// estilo: es cómo esta planilla viene funcionando —hay importes pisados a mano
// que son la verdad de hoy— y romperlo haría que abrir la app cambie sueldos.
//
// Y "está escrito" incluye un CERO escrito. En junio a dos personas no se les
// transfirió nada y su celda dice 0; si el cero se tratara como vacío, el default
// ("en blanco neto") les inventaría una transferencia de $613.477 que nadie hizo.
// De ahí que el parser distinga null de 0 y esto pregunte por `!= null`.
function liquidacionDelMes({ empleados, costos, mesId, planilla = null } = {}) {
  if (!esMesIdValido(mesId)) throw new Error(`Mes inválido: ${mesId} (se espera AAAAMM)`);
  const { anio, mes } = parseMesId(mesId);
  const finDeMes = new Date(anio, mes, 0);
  const serviciosMes = serviciosDelMes(mesId);
  const feriadosMes = feriadosDelMes(anio, mes);

  const porCosto = new Map((costos || []).map(c => [norm(c.nombre), c]));
  const porFila = new Map(((planilla && planilla.filas) || []).map(f => [norm(f.nombre), f]));

  const porEmpleado = (empleados || [])
    .filter(e => e.completo && vigenteEn(e, finDeMes))
    .map(e => {
      const fila = porFila.get(norm(e.nombre)) || null;
      const costo = costoDe(porCosto, e.nombre);
      // Lo que vale UN feriado para esta persona. Es la unidad con la que se
      // multiplica y también con la que se deduce la cantidad de un importe viejo.
      const feriadoUnitarioARS = importeFeriado(e, 1, { costo });

      // Cuántos servicios trabajó. Manda la columna de la app; si no está, sale
      // del calendario y de la fecha de ingreso. Es editable porque el
      // calendario no sabe de una apertura extraordinaria ni de una ausencia.
      const serviciosSugeridos = serviciosTrabajados(e, mesId);
      const servicios = fila && fila.servicios != null ? fila.servicios : serviciosSugeridos;
      const mesIncompleto = servicios < serviciosMes;
      // Lo que le corresponde por esos servicios. No pisa a la planilla —acá
      // manda lo escrito, como en todo lo demás— pero viaja al lado para que la
      // pantalla pueda mostrar que no coinciden en vez de corregir en silencio.
      const sueldoSugeridoARS = sueldoDelMes(e, mesId, { servicios });

      const sueldoARS = fila && fila.sueldoARS != null ? fila.sueldoARS : sueldoSugeridoARS;

      // Lo que dice el calendario: los feriados del mes que caen con el bar
      // abierto, desde que la persona entró. Quien no cobra feriado —el socio,
      // cuyo importe unitario da cero— tiene sugerencia cero, así que no se le
      // reclama una diferencia contra algo que no cobra.
      const feriadosSugeridos = feriadoUnitarioARS > 0 ? feriadosTrabajados(e, mesId) : 0;

      // Cuántos feriados se trabajaron. Manda la columna de la app; si todavía no
      // existe se deduce del importe que ya tiene la planilla, y si no divide
      // entero se deja en null: el importe se respeta igual y la cantidad queda
      // dicha como desconocida en vez de redondeada a un número inventado.
      let feriados = fila ? fila.feriados : null;
      let feriadoARS;
      if (feriados != null) {
        feriadoARS = feriadoUnitarioARS * feriados;
      } else if (fila && fila.feriadoARS) {
        feriadoARS = fila.feriadoARS;
        if (feriadoUnitarioARS > 0) {
          const n = fila.feriadoARS / feriadoUnitarioARS;
          if (Math.abs(n - Math.round(n)) < 0.01) feriados = Math.round(n);
        }
      } else {
        // Nada escrito: manda el calendario. Antes era un cero fijo que había que
        // corregir a mano todos los meses —y en agosto de 2026 se corrigió para
        // el lado equivocado, cobrando un feriado que cayó con el bar cerrado.
        feriados = feriadosSugeridos;
        feriadoARS = feriadoUnitarioARS * feriados;
      }

      const sueldoTotalARS = sueldoARS + feriadoARS;
      // El SAC calculado usa el sueldo total de ESTE mes, que es como lo hace la
      // planilla: en junio los cuatro importes dan al peso.
      //
      // Con una excepción: la base es el sueldo COMPLETO, no el prorrateado.
      // `sacDelMes` ya prorratea por los días del semestre —ahí es donde entra
      // que la persona haya entrado tarde— y prorratear también la base contaría
      // el mes partido dos veces y dejaría el aguinaldo por debajo.
      const sacBaseARS = (e.sueldoActualARS || 0) + feriadoARS;
      const sacARS = fila && fila.aguinaldoARS != null
        ? fila.aguinaldoARS
        : (e.esSocio ? 0 : sacDelMes(e, mesId, { sueldoTotalARS: sacBaseARS }));
      const totalARS = sueldoTotalARS + sacARS;

      // Lo que va por banco. El default es el "en blanco neto" de la hoja Nómina,
      // que es de dónde salen los importes tipeados en la planilla.
      const sueldoTransferenciaARS = fila && fila.sueldoTransferenciaARS != null
        ? fila.sueldoTransferenciaARS
        : (e.enBlancoNetoARS || 0);
      // El aguinaldo por banco no tiene regla derivable: default 0 y se escribe.
      const aguinaldoTransferenciaARS = fila && fila.aguinaldoTransferenciaARS != null
        ? fila.aguinaldoTransferenciaARS : 0;
      const transferenciaARS = sueldoTransferenciaARS + aguinaldoTransferenciaARS;

      const consumosARS = fila && fila.consumosARS != null ? fila.consumosARS : 0;
      const efectivoARS = totalARS - transferenciaARS - consumosARS;

      return {
        id: e.id, nombre: e.nombre, esSocio: e.esSocio,
        sueldoARS,
        // El sueldo entero de la hoja Nómina, que es la base del prorrateo. La
        // pantalla lo necesita para rehacer la cuenta cuando se edita la
        // cantidad de servicios.
        sueldoBaseARS: e.sueldoActualARS || 0,
        servicios, serviciosSugeridos, serviciosMes, mesIncompleto,
        sueldoSugeridoARS,
        ingresoISO: e.ingresoISO,
        // Cuánto se despega el sueldo escrito del que sale de los servicios. En
        // la fila de alguien que entró a mitad de mes y quedó cargado con el mes
        // entero, es exactamente lo que está de más. No se corrige solo.
        difSueldoARS: sueldoARS - sueldoSugeridoARS,
        feriados, feriadoUnitarioARS, feriadoARS,
        // La sugerencia viaja al lado de lo escrito, nunca lo pisa: si la hoja
        // dice otra cosa, la pantalla lo muestra y decide una persona. Es lo
        // mismo que se hace con el sueldo de un mes incompleto.
        feriadosSugeridos, difFeriados: (feriados || 0) - feriadosSugeridos,
        sueldoTotalARS,
        sacARS,
        totalARS,
        sueldoTransferenciaARS, aguinaldoTransferenciaARS, transferenciaARS,
        consumosARS, consumosNota: (fila && fila.consumosNota) || '',
        efectivoARS,
        enPlanilla: Boolean(fila),
        actualizado: (fila && fila.actualizado) || '',
        // Cuánto se despega el efectivo de la app del que dice la hoja. En las
        // filas viejas da los consumos que estaban tipeados adentro de la fórmula
        // de K y que ninguna columna mostraba. No se corrige solo: se muestra.
        difEfectivoARS: fila && fila.efectivoPlanillaARS != null
          ? efectivoARS - fila.efectivoPlanillaARS : 0,
      };
    });

  const suma = campo => porEmpleado.reduce((s, e) => s + (e[campo] || 0), 0);
  // Filas que están en la hoja del mes y no en la nómina: alguien que se fue (la
  // planilla borra la fila al dar de baja) o un nombre mal escrito. Se nombran,
  // porque su plata está en la hoja y no en ningún total de acá.
  const enNomina = new Set((empleados || []).map(e => norm(e.nombre)));
  const sueltas = ((planilla && planilla.filas) || [])
    .filter(f => !enNomina.has(norm(f.nombre)))
    .map(f => ({ nombre: f.nombre, rowIndex: f.rowIndex }));

  return {
    mesId, anio, mes: MESES[mes - 1],
    esMesDeSAC: MESES_SAC.includes(mes),
    serviciosMes,
    // Todos los feriados del mes, con el día de la semana y si el bar abre. La
    // pantalla los nombra: un mes sin adicional tiene que poder explicar por qué.
    feriadosMes,
    hayPlanilla: Boolean(planilla),
    porEmpleado,
    totales: {
      dotacion: porEmpleado.length,
      sueldosARS: suma('sueldoARS'),
      feriadosARS: suma('feriadoARS'),
      sacARS: suma('sacARS'),
      totalARS: suma('totalARS'),
      transferenciaARS: suma('transferenciaARS'),
      consumosARS: suma('consumosARS'),
      efectivoARS: suma('efectivoARS'),
    },
    incompletos: (empleados || []).filter(e => !e.completo).map(e => ({ nombre: e.nombre, leFalta: e.leFalta })),
    filasSueltas: sueltas,
  };
}

// ─── I/O ────────────────────────────────────────────────────────────────────
// El permiso más chico que alcance: leer pide `readonly` y sólo el guardado de
// la liquidación pide escritura. Son sueldos de gente real — que la mayor parte
// del módulo no pueda escribir aunque quiera es una red, no una formalidad.
function _sheets({ escritura = false } = {}) {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  const scopes = [escritura
    ? 'https://www.googleapis.com/auth/spreadsheets'
    : 'https://www.googleapis.com/auth/spreadsheets.readonly'];
  return google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ credentials, scopes }) });
}

const configurada = () => Boolean(SHEET_ID);

// UNFORMATTED_VALUE a propósito: las fechas llegan como serial y los importes
// como número, sin el "$" ni los separadores de miles del formato.
async function _leer(hoja, rango = 'A1:N100') {
  return _leerCon(_sheets(), hoja, rango);
}

// El guardado relee con SU cliente: pedir dos veces las credenciales para leer y
// escribir en la misma operación es una llamada de más a Google por guardado.
async function _leerCon(api, hoja, rango = 'A1:N100') {
  if (!configurada()) throw new Error('Falta NOMINA_SHEET_ID');
  const r = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${hoja}!${rango}`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return r.data.values || [];
}

async function getEmpleados() {
  const hit = cache.get('empleados');
  if (hit) return hit;
  const out = parsearEmpleados(await _leer(HOJA_EMPLEADOS, 'A1:E100'));
  cache.set('empleados', out);
  return out;
}

async function getCostos() {
  const hit = cache.get('costos');
  if (hit) return hit;
  const out = parsearCostos(await _leer(HOJA_COSTOS, 'A1:I100'));
  cache.set('costos', out);
  return out;
}

// Lo que consume `proyecciones.js`. NUNCA tira: ante cualquier problema devuelve
// null y el llamador sigue con la heurística vieja. El null se cachea corto para
// que una planilla rota no cueste una llamada a Google por request — este dato
// se pide en cada carga de la sección Servicios.
async function getNominaParaBaselines() {
  if (!configurada()) return null;
  const hit = cache.get('baselines');
  if (hit !== undefined) return hit;
  try {
    const [empleados, costos] = await Promise.all([getEmpleados(), getCostos()]);
    const r = resumenCostoLaboral({ empleados, costos });
    const out = {
      costoLaboralMensualARS: r.costoParaPuntoDeEquilibrioARS,
      costoTotalMensualARS: r.costoTotalMensualARS,
      cargasARS: r.cargasARS,
      provisionesARS: r.provisionesARS,
      sacDevengadoMensualARS: r.sacDevengadoMensualARS,
      // Lo que se PAGA de aguinaldo en cada mes de SAC de los próximos doce
      // meses, ya prorrateado por antigüedad. No es el devengado por seis: en el
      // primer semestre de alguien que entró en mayo el SAC es una fracción, y
      // multiplicar por seis lo cuadruplicaba. Lo usa la proyección de caja.
      sacPorMes: sacDeLosProximosMeses({ empleados, costos }),
      dotacion: r.dotacion,
      incompletos: r.incompletos,
      mesId: mesIdDe(new Date()),
      fuente: 'nomina',
    };
    cache.set('baselines', out);
    return out;
  } catch (e) {
    console.error(`Nómina: no se pudo leer (${e.message}) — el costo laboral sale de la heurística vieja`);
    cache.set('baselines', null, 60);
    return null;
  }
}

// ─── La liquidación del mes: leer ───────────────────────────────────────────
//
// La hoja del mes NO se cachea. Todo lo demás acá vive cinco minutos en memoria
// porque cambia una vez por mes; esto es justamente lo que se está editando, y
// una liquidación que se guarda y vuelve mostrando lo de antes es peor que una
// llamada de más a Google.
async function getLiquidacion({ mesId } = {}) {
  const id = esMesIdValido(mesId) ? mesId : mesIdDe(new Date());
  const [empleados, costos] = await Promise.all([getEmpleados(), getCostos()]);
  let planilla = null, avisoHoja = '';
  try {
    planilla = parsearMesPlanilla(await _leer(id, 'A1:Z200'));
    if (!planilla) {
      avisoHoja = `La hoja ${id} existe pero tiene otro formato de columnas, así que no se lee `
        + `ni se escribe: lo de abajo está calculado desde la nómina. (La primera hoja, 202605, `
        + `es así: prorratea por días trabajados porque fue un mes partido.)`;
    }
  } catch (e) {
    // Que la hoja del mes todavía no exista es lo normal el día 1: se calcula
    // todo desde la nómina y se crea al guardar.
    if (!/Unable to parse range|not found/i.test(e.message)) throw e;
  }
  const liq = liquidacionDelMes({ empleados, costos, mesId: id, planilla });
  return { ...liq, hoja: id, avisoHoja, puedeEscribir: true };
}

// ─── La liquidación del mes: guardar ────────────────────────────────────────
//
// LA ÚNICA ESCRITURA DE ESTE MÓDULO. Lee lo que dice de esto el punto 1 del
// encabezado antes de tocarla.
//
// Tres decisiones que explican la forma del código:
//
// 1. SE ESCRIBE CELDA POR CELDA, no la fila entera. Un `values.update` sobre
//    A:N borraría cualquier columna intermedia que alguien haya agregado y que
//    nosotros no conocemos. Van todas en UN batchUpdate: es una sola llamada.
//
// 2. LAS CUENTAS DE LA MISMA FILA SE ESCRIBEN COMO FÓRMULA (D=B+C, F=D+E, I=G+H,
//    K=D+E−G−H−consumos). La planilla las tiene así y tiene que seguir viva
//    cuando alguien la abra en el Excel: si la app escribiera valores, editar el
//    sueldo ahí dejaría el total mintiendo. Son referencias a la MISMA fila, así
//    que ninguna puede terminar apuntando al renglón de otra persona.
//
//    El feriado (C) es la excepción y va como VALOR. Su fórmula mira a la hoja
//    'Costos laborales' por número de fila, y ese número sale de buscar a la
//    persona por nombre: si la búsqueda falla, la fórmula calcularía el feriado
//    de alguien con el sueldo de otro, en silencio. Un valor no puede hacer eso,
//    y la cantidad queda escrita en su columna para que la cuenta se pueda rehacer.
//
// 3. NO SE TOCA UNA FILA QUE NO SE PIDIÓ. Sólo se escriben las personas que
//    vienen en `cambios`; el resto de la hoja queda exactamente como estaba.
async function guardarLiquidacion({ mesId, cambios = [] } = {}, { usuario } = {}) {
  if (!configurada()) throw new Error('Falta NOMINA_SHEET_ID');
  if (!usuario) throw new Error('Falta el usuario');
  if (!esMesIdValido(mesId)) throw new Error(`Mes inválido: ${mesId} (se espera AAAAMM)`);
  if (!Array.isArray(cambios) || !cambios.length) throw new Error('No hay nada para guardar');

  const api = _sheets({ escritura: true });
  const [empleados, costos] = await Promise.all([getEmpleados(), getCostos()]);

  // La hoja del mes puede no existir todavía: el día 1 no existe ninguna. Se crea
  // con su encabezado y nada más — es la continuación de lo que se hacía a mano.
  await _asegurarHojaMensual(api, mesId);

  // Relectura fresca contra la que se resuelve todo: en qué fila está cada
  // persona y qué columnas propias ya existen. Nunca se confía en un rowIndex
  // que haya viajado al navegador.
  const filas = await _leerCon(api, mesId, 'A1:Z200');
  const planilla = parsearMesPlanilla(filas);
  if (!planilla) {
    throw new Error(`La hoja ${mesId} tiene otro formato de columnas y no se puede escribir sin `
      + `romperla. Revisala en la planilla: el encabezado tiene que ser el de los meses nuevos.`);
  }

  const cols = _resolverColumnasMes(filas, planilla.cols);
  const filasCostos = await _leer(HOJA_COSTOS, 'A1:A100');
  const rowCostoDe = nombre => {
    const i = (filasCostos || []).findIndex(f => norm((f || [])[0]) === norm(nombre));
    return i >= 0 ? i + 1 : null;
  };

  const liq = liquidacionDelMes({ empleados, costos, mesId, planilla });
  const porNombre = new Map(liq.porEmpleado.map(e => [norm(e.nombre), e]));
  const porFila = new Map(planilla.filas.map(f => [norm(f.nombre), f]));

  // Dónde va cada persona nueva. Se apila abajo de la última fila escrita, y el
  // contador es local: dos altas en el mismo guardado no pueden caer en la misma.
  let proxima = planilla.filas.reduce((m, f) => Math.max(m, f.rowIndex), 1) + 1;

  const data = [];
  const escritas = [];
  const ignorados = [];
  const ahora = new Date().toISOString();

  for (const c of cambios) {
    const nombre = (c && c.nombre || '').toString().trim();
    const base = porNombre.get(norm(nombre));
    if (!base) { ignorados.push({ nombre, motivo: 'no está en la nómina de este mes' }); continue; }

    // El cambio se aplica ARRIBA de lo que ya vale: mandar sólo el campo que se
    // tocó no puede borrar los otros cuatro.
    const num = (v, x) => (v == null || v === '' ? x : parseImporte(v));
    // Los servicios se escriben pero NO recalculan el sueldo acá: el sueldo
    // viene resuelto del navegador, que es donde se vio y se confirmó el número.
    // Recalcularlo de este lado podría cambiar un importe que la persona no
    // mandó — y el que manda es el que se estaba mirando en la pantalla.
    const servicios = c.servicios == null || c.servicios === ''
      ? (base.servicios == null ? null : base.servicios)
      : Math.max(0, enteroONull(c.servicios) || 0);
    const sueldoARS = num(c.sueldoARS, base.sueldoARS);
    const feriados = c.feriados == null || c.feriados === '' ? (base.feriados || 0) : Math.max(0, enteroONull(c.feriados) || 0);
    const feriadoARS = (base.feriadoUnitarioARS || 0) * feriados;
    const sacARS = num(c.sacARS, base.sacARS);
    const sueldoTransferenciaARS = num(c.sueldoTransferenciaARS, base.sueldoTransferenciaARS);
    const aguinaldoTransferenciaARS = num(c.aguinaldoTransferenciaARS, base.aguinaldoTransferenciaARS);
    const consumosARS = num(c.consumosARS, base.consumosARS);
    const consumosNota = c.consumosNota == null ? base.consumosNota : String(c.consumosNota).slice(0, 500);

    const fila = porFila.get(norm(nombre));
    const r = fila ? fila.rowIndex : proxima++;
    const cel = (col, valor) => data.push({ range: `${mesId}!${colLetra(col)}${r}`, values: [[valor]] });

    const rc = rowCostoDe(nombre);
    cel(COL_MES.nombre, base.nombre);
    cel(COL_MES.sueldo, sueldoARS);
    cel(COL_MES.feriado, feriadoARS);
    cel(COL_MES.sueldoTotal, `=B${r}+C${r}`);
    cel(COL_MES.aguinaldo, sacARS);
    cel(COL_MES.total, `=D${r}+E${r}`);
    cel(COL_MES.sueldoTransf, sueldoTransferenciaARS);
    cel(COL_MES.aguinaldoTransf, aguinaldoTransferenciaARS);
    cel(COL_MES.totalTransf, `=G${r}+H${r}`);
    cel(COL_MES.consumos, consumosNota);
    // Acá está el arreglo del bug de la planilla: el efectivo resta la columna
    // del monto de consumos en vez de un número tipeado adentro de la fórmula.
    cel(COL_MES.efectivo, `=D${r}+E${r}-G${r}-H${r}-${colLetra(cols.consumos)}${r}`);
    cel(cols.servicios, servicios == null ? '' : servicios);
    cel(cols.feriados, feriados);
    cel(cols.consumos, consumosARS);
    cel(cols.actualizado, `${usuario} · ${ahora}`);

    escritas.push({
      nombre: base.nombre, fila: r, esNueva: !fila,
      sueldoARS, servicios, feriados, feriadoARS, sacARS,
      totalARS: sueldoARS + feriadoARS + sacARS,
      transferenciaARS: sueldoTransferenciaARS + aguinaldoTransferenciaARS,
      consumosARS,
      efectivoARS: sueldoARS + feriadoARS + sacARS - sueldoTransferenciaARS - aguinaldoTransferenciaARS - consumosARS,
      // Sin fila en 'Costos laborales' el feriado no tiene de dónde salir más que
      // del sueldo de la hoja Nómina. Se dice: es la diferencia de $246 que
      // menciona importeFeriado, y en alguien recién cargado puede ser mayor.
      avisoFeriado: !rc && feriados > 0 ? 'no tiene fila en Costos laborales: el feriado salió del sueldo de la nómina' : '',
    });
  }

  if (!data.length) {
    const e = new Error('Ninguna de las personas que mandaste está en la nómina de este mes. No se escribió nada.');
    e.ignorados = ignorados;
    throw e;
  }

  // Los encabezados de las columnas propias, si se acaban de reclamar.
  for (const [clave, col] of Object.entries(cols)) {
    if (planilla.cols[clave] === col) continue;
    data.push({ range: `${mesId}!${colLetra(col)}1`, values: [[COLS_APP_MES[clave]]] });
  }

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  clearCache();
  return { mesId, escritas, ignorados, celdas: data.length };
}

// ─── La nómina: guardar ─────────────────────────────────────────────────────
//
// La SEGUNDA escritura del módulo. Hasta el 31/8/2026 esta planilla era de sólo
// lectura y eso estaba escrito como una decisión; la decisión cambió: la nómina
// se carga y se corrige desde la app o desde la planilla, indistinto, igual que
// Pagos. La planilla sigue siendo de los dueños y sigue viva — por eso valen acá
// las mismas cuatro reglas que en el cierre de cocina:
//
// 1. SE ESCRIBE CELDA POR CELDA. Sólo A, B, C y D, que son las que la app
//    entiende. Cualquier columna que alguien haya agregado a la derecha queda
//    intacta, y por eso no se usa un `values.update` de la fila entera.
// 2. SE RELEE ANTES DE ESCRIBIR y la identidad es el NOMBRE, no un número de
//    fila que viajó al navegador: si alguien ordenó la hoja mientras tanto, un
//    rowIndex viejo escribiría el sueldo de una persona en el renglón de otra.
// 3. SÓLO LAS PERSONAS QUE SE PIDIERON. El resto de la hoja queda como estaba.
// 4. NO BORRA NI RENOMBRA. Una baja se hace en la planilla, borrando la fila; y
//    el nombre es la clave que une esta hoja con `Costos laborales` y con las
//    hojas de cada mes, así que cambiarlo desde acá rompería en silencio el
//    historial de esa persona. Las dos cosas son deliberadas.
//
// La fecha se escribe en formato ISO (`2026-09-01`) a propósito: es el único que
// Google Sheets lee igual en cualquier configuración regional. Un "01/09/2026"
// puede entrar como 9 de enero, que es el error que en la otra planilla ya movió
// 432 filas de mes.
async function guardarEmpleados({ cambios = [] } = {}, { usuario } = {}) {
  if (!configurada()) throw new Error('Falta NOMINA_SHEET_ID');
  if (!usuario) throw new Error('Falta el usuario');
  if (!Array.isArray(cambios) || !cambios.length) throw new Error('No hay nada para guardar');

  const api = _sheets({ escritura: true });
  const filas = await _leerCon(api, HOJA_EMPLEADOS, 'A1:Z100');
  const actuales = parsearEmpleados(filas);
  const porNombre = new Map(actuales.map(e => [norm(e.nombre), e]));

  // La columna de la firma. Se reusa si ya existe por nombre; si no, se reclama
  // la primera que no tiene NADA en ninguna fila — el mismo criterio que en las
  // hojas mensuales, que es lo único que garantiza no pisarle una columna a
  // nadie. Un sueldo que cambia sin decir quién lo cambió no se puede auditar.
  const cab = (filas || [])[0] || [];
  let colFirma = cab.findIndex(c => norm(c) === norm(COL_NOMINA_ACTUALIZADO));
  const reclamada = colFirma < 0;
  if (reclamada) {
    let libre = 0;
    for (const f of (filas || [])) {
      for (let i = 0; i < (f || []).length; i++) if (f[i] !== '' && f[i] != null) libre = Math.max(libre, i + 1);
    }
    colFirma = Math.max(libre, 4);
  }

  // Dónde va una persona nueva: abajo de la última fila escrita. El contador es
  // local para que dos altas en el mismo guardado no caigan en la misma fila.
  let proxima = actuales.reduce((m, e) => Math.max(m, e.rowIndex), 1) + 1;

  const data = [];
  const escritas = [];
  const ahora = new Date().toISOString();
  const vistos = new Set();

  for (const c of (cambios || [])) {
    const nombre = ((c && c.nombre) || '').toString().trim();
    if (!nombre) throw new Error('Hay un cambio sin nombre: no se escribió nada.');
    if (vistos.has(norm(nombre))) throw new Error(`"${nombre}" viene dos veces en el mismo guardado.`);
    vistos.add(norm(nombre));

    const base = porNombre.get(norm(nombre));
    const esAlta = !base;
    if (esAlta && c.alta !== true) {
      throw new Error(`"${nombre}" no está en la nómina. Si es alguien nuevo, cargalo como alta; `
        + `si le erraste al nombre, corregilo en la planilla: desde acá no se renombra a nadie.`);
    }
    if (!esAlta && c.alta === true) throw new Error(`"${nombre}" ya está en la nómina.`);

    // Lo que no viene se queda como está: mandar sólo el campo que se tocó no
    // puede borrar los otros.
    const ingreso = c.ingresoISO == null || c.ingresoISO === ''
      ? (base ? base.ingresoISO : null)
      : diaISO(parseFecha(c.ingresoISO));
    const sueldoARS = c.sueldoActualARS == null || c.sueldoActualARS === ''
      ? (base ? base.sueldoActualARS : 0)
      : parseImporte(c.sueldoActualARS);
    const transferenciaARS = c.enBlancoNetoARS == null || c.enBlancoNetoARS === ''
      ? (base ? base.enBlancoNetoARS : 0)
      : parseImporte(c.enBlancoNetoARS);

    if (c.ingresoISO && !ingreso) throw new Error(`La fecha de ingreso de "${nombre}" no se entiende.`);
    if (esAlta && !ingreso) throw new Error(`Falta la fecha de ingreso de "${nombre}".`);
    if (!(sueldoARS > 0)) throw new Error(`El sueldo de "${nombre}" tiene que ser mayor que cero.`);
    if (transferenciaARS < 0) throw new Error(`Lo que va por transferencia de "${nombre}" no puede ser negativo.`);
    // La parte por transferencia es una PORCIÓN del sueldo, no algo que se suma:
    // si la supera, el costo con cargas saldría de una base que no existe.
    if (transferenciaARS > sueldoARS) {
      throw new Error(`Lo que va por transferencia de "${nombre}" (${Math.round(transferenciaARS)}) `
        + `no puede ser mayor que su sueldo (${Math.round(sueldoARS)}).`);
    }

    const r = base ? base.rowIndex : proxima++;
    const cel = (col, valor) => data.push({ range: `${HOJA_EMPLEADOS}!${colLetra(col)}${r}`, values: [[valor]] });
    cel(0, base ? base.nombre : nombre);   // el nombre de la hoja manda: acá no se renombra
    cel(1, ingreso || '');
    cel(2, sueldoARS);
    cel(3, transferenciaARS);
    cel(colFirma, `${usuario} · ${ahora}`);

    escritas.push({
      nombre: base ? base.nombre : nombre, fila: r, esAlta,
      ingresoISO: ingreso, sueldoActualARS: sueldoARS, enBlancoNetoARS: transferenciaARS,
      // Sin fila en 'Costos laborales' su costo sale de la regla y no de la
      // planilla. No es un error —la app ya lo calcula— pero se dice.
      aviso: esAlta ? 'todavía no tiene fila en Costos laborales: su costo sale de la regla' : '',
    });
  }

  if (reclamada) data.push({ range: `${HOJA_EMPLEADOS}!${colLetra(colFirma)}1`, values: [[COL_NOMINA_ACTUALIZADO]] });

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  clearCache();
  return { escritas, celdas: data.length };
}

// Qué columna usa cada cosa de la app, y cuáles hay que crear. Si ya existen por
// nombre se reusan; si no, se reclama la primera columna que no tiene NADA en
// ninguna fila. Reclamar sólo a partir de ahí es lo único que garantiza que no le
// pisemos una columna a nadie.
function _resolverColumnasMes(filas, yaExisten) {
  let libre = 0;
  for (const f of (filas || [])) {
    for (let i = 0; i < (f || []).length; i++) {
      if (f[i] !== '' && f[i] != null) libre = Math.max(libre, i + 1);
    }
  }
  libre = Math.max(libre, HEADER_MENSUAL.length);
  const out = {};
  for (const clave of ['servicios', 'feriados', 'consumos', 'actualizado']) {
    out[clave] = yaExisten[clave] >= 0 ? yaExisten[clave] : libre++;
  }
  return out;
}

// Crea la hoja del mes con su encabezado si todavía no existe. Es lo único
// estructural que la app hace en esta planilla, y solamente AGREGA: no mueve, no
// borra y no toca ninguna hoja que ya esté.
async function _asegurarHojaMensual(api, mesId) {
  const meta = await api.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const existe = (meta.data.sheets || []).some(h => h.properties.title === mesId);
  if (existe) return false;
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: mesId } } }] },
  });
  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${mesId}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER_MENSUAL] },
  });
  return true;
}

async function getNomina({ mesId } = {}) {
  const [empleados, costos] = await Promise.all([getEmpleados(), getCostos()]);
  const id = esMesIdValido(mesId) ? mesId : mesIdDe(new Date());
  return {
    empleados,
    costos,
    resumen: resumenCostoLaboral({ empleados, costos }),
    mes: calcularMes({ empleados, costos, mesId: id }),
  };
}

// ─── Lo que los agentes tienen que saber ────────────────────────────────────
//
// Va al prompt de sistema de los tres analistas, al lado de contexto-operativo.md.
// Reemplaza la línea que hasta hoy estaba escrita a mano ahí ("son 4 empleados
// más Pablo: 5 sueldos") y que había que acordarse de actualizar.
//
// NO lleva nombres ni sueldos individuales, a propósito: el agente necesita
// saber cuánta gente hay y en qué nivel está el costo para no marcar como raro
// un salto que ya está explicado. Quién cobra cuánto no le cambia ninguna
// lectura, y esto viaja a un modelo.
async function bloqueParaAgentes({ hasta } = {}) {
  if (!configurada()) return '';
  const corte = hasta ? new Date(hasta) : new Date();
  const [empleados, costos] = await Promise.all([getEmpleados(), getCostos()]);
  const r = resumenCostoLaboral({ empleados, costos });
  if (!r.dotacion) return '';

  const vigentes = dotacionEn(empleados.filter(e => e.completo), corte);
  const altas = cambiosDeDotacion(empleados, { hasta: corte })
    .map(c => `${c.fecha}: ${c.personas === 1 ? 'entró 1 persona' : `entraron ${c.personas} personas`}`);
  const fmt = n => '$' + Math.round(n).toLocaleString('es-AR');
  const proximoSAC = Object.entries(sacDeLosProximosMeses({ empleados, costos, desde: corte }))
    .sort((a, b) => a[0].localeCompare(b[0]))[0] || null;

  const lineas = [
    '', '',
    `DOTACIÓN Y COSTO LABORAL (generado desde la nómina al ${diaISO(corte)}):`,
    '(Es contexto estructural, no datos de este período. El costo esperado NO es lo que se gastó.)',
    '',
    `- Hoy trabajan ${vigentes.length} personas. El costo laboral es de ${fmt(r.costoTotalMensualARS)} por mes: `
      + `${fmt(r.netoTrabajadoresARS)} de sueldos, ${fmt(r.cargasARS)} de cargas y `
      + `${fmt(r.provisionesARS)} de vacaciones y aguinaldo que se devengan mes a mes.`,
    `- El aguinaldo se paga en junio y en diciembre. `
      + (proximoSAC
        ? `El próximo cae en ${nombreMesDe(proximoSAC[0])} de ${parseMesId(proximoSAC[0]).anio} y son unos ${fmt(proximoSAC[1])} por encima del sueldo del mes. `
        : '')
      + `En esos dos meses el gasto de personal sube, y eso es lo esperado: no es una anomalía.`,
  ];
  if (altas.length) lineas.push(`- Altas registradas: ${altas.join(' · ')}. Un salto del costo de personal en esas fechas está explicado por la dotación.`);
  if (r.incompletos.length) {
    lineas.push(`- OJO: ${r.incompletos.length} persona(s) ya trabajando y todavía sin cargar en la nómina. `
      + `El costo laboral real es MAYOR que el de arriba, así que no afirmes que el gasto de personal se pasó de lo esperado.`);
  }
  return lineas.join('\n');
}

async function getProyeccion({ meses = 12 } = {}) {
  const [empleados, costos] = await Promise.all([getEmpleados(), getCostos()]);
  return calcularRango({ empleados, costos, desdeMesId: mesIdDe(new Date()), meses });
}

function clearCache() { cache.flushAll(); }

module.exports = {
  // I/O
  getEmpleados, getCostos, getNomina, getProyeccion, getNominaParaBaselines,
  bloqueParaAgentes, clearCache, configurada,
  // I/O — la liquidación del mes, la única que escribe
  getLiquidacion, guardarLiquidacion, guardarEmpleados,
  // Puras — se pueden ejercitar sin red
  parsearEmpleados, parsearCostos, costoDeEmpleado, calcularMes, calcularRango,
  parsearMesPlanilla, liquidacionDelMes, colLetra, importeONull, enteroONull,
  HEADER_MENSUAL, COL_MES, COLS_APP_MES,
  resumenCostoLaboral, importeFeriado, sacDelMes, diasEnElSemestre,
  serviciosDelMes, serviciosTrabajados, sueldoDelMes, parteRegistrada,
  feriadosDeServicio, feriadosTrabajados,
  dotacionEn, vigenteEn, cambiosDeDotacion,
  mesIdDe, parseMesId, mesIdSuma, nombreMesDe, esMesIdValido, parseFecha, parseImporte,
  // Constantes
  FACTOR_BRUTO, FACTOR_COSTO_LABORAL, MESES_SAC, DIAS_LABORABLES_MES,
  HOJA_EMPLEADOS, HOJA_COSTOS,
};
