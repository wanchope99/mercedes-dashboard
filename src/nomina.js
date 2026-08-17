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
// 1. ES DE SÓLO LECTURA. La planilla es de los dueños y se sigue editando ahí.
//    Este archivo no crea hojas, no hace append y no actualiza una celda. Si
//    algún día la app tiene que escribir, es una decisión de producto que hay
//    que tomar aparte — no un detalle de implementación.
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
// El socio es el caso especial y sale solo del mismo modelo: con "en blanco
// neto" en 0 no hay parte registrada, así que no hay cargas ni provisiones y su
// sueldo pasa entero al costo del mes. Confirmado por el dueño el 17/8/2026.
//
// Hojas mensuales `AAAAMM` — el registro de lo que se pagó ese mes:
//   A Trabajador · B Sueldo · C Feriado · D Sueldo Total · E Aguinaldo Total
//   F TOTAL sueldo+SAC · G Sueldo Transferencia · H Aguinaldo Transferencia
//   I Total transferencia · J Consumos Mes · K Efectivo
//   feriado = sueldo / 25 por cada feriado trabajado
//   SAC     = (sueldo total / 2) × (días trabajados en el semestre / 180)
//
// Las hojas mensuales se leen, no se escriben, y su formato NO es estable: la
// primera (202605) tiene otras columnas que las demás. Cuando una hoja no
// matchea el layout conocido se devuelve `null` en vez de adivinar.

const { google } = require('googleapis');
const NodeCache = require('node-cache');

// Sin fallback a SPREADSHEET_ID — ver punto 2 del encabezado.
const SHEET_ID = process.env.NOMINA_SHEET_ID || null;
const HOJA_EMPLEADOS = process.env.NOMINA_HOJA || 'Nómina';
const HOJA_COSTOS = process.env.NOMINA_HOJA_COSTOS || 'Costos laborales';

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

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

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
// celda tipeada a mano puede llegar como "$1.700.000". Se acepta cualquiera de
// las dos: el formato argentino usa el punto como separador de miles.
function parseImporte(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
  const s = String(valor == null ? '' : valor).replace(/[$\s]/g, '');
  if (!s) return 0;
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  let limpio;
  if (coma !== -1 && punto !== -1) limpio = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (coma !== -1) limpio = s.slice(coma + 1).length === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  else limpio = s;
  const n = parseFloat(limpio);
  return Number.isFinite(n) ? n : 0;
}

const norm = s => (s || '').toString().trim().toLowerCase();

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
      nombre,
      ingreso,
      ingresoISO: diaISO(ingreso),
      sueldoActualARS: sueldoActual,
      enBlancoNetoARS: enBlancoNeto,
      // Sin parte registrada no hay cargas ni provisiones: es el caso del socio.
      esSocio: sueldoActual > 0 && enBlancoNeto === 0,
      completo: faltan.length === 0,
      leFalta: faltan,
    });
  }
  return out;
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
function costoDeEmpleado(empleado, { factorCostoLaboral = FACTOR_COSTO_LABORAL, factorBruto = FACTOR_BRUTO } = {}) {
  const neto = empleado.sueldoActualARS || 0;
  const remunerativo = empleado.enBlancoNetoARS || 0;
  const noRemunerativo = Math.max(0, neto - remunerativo);

  if (empleado.esSocio || remunerativo === 0) {
    // Sin parte registrada no hay recibo, ni cargas, ni vacaciones, ni SAC: el
    // sueldo pasa entero al costo del mes.
    return {
      nombre: empleado.nombre,
      netoRemunerativoARS: 0, netoNoRemunerativoARS: neto,
      brutoPorReciboARS: 0, costoLaboralARS: 0,
      costoLaboralMasNoRemARS: neto,
      prorrateoVacacionesARS: 0, prorrateoAguinaldoARS: 0,
      cargasARS: 0,
      costoTotalMensualARS: neto,
      esSocio: true,
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
  };
}

// Feriado trabajado: un día de sueldo sobre 25 días laborables, por feriado.
//
// Dos detalles que salen de comparar contra las hojas mensuales reales:
//
// · El socio NO cobra feriado. En las tres hojas mensuales su columna Feriado
//   está en cero, y es coherente con el resto de su trato: cobra su sueldo y
//   nada más.
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
// diferencia es cuántos feriados se trabajaron, que es un dato del mes y entra
// por parámetro.
function calcularMes({ empleados, mesId, feriados = 0, costos = null } = {}) {
  if (!esMesIdValido(mesId)) throw new Error(`Mes inválido: ${mesId} (se espera AAAAMM)`);
  const { anio, mes } = parseMesId(mesId);
  const finDeMes = new Date(anio, mes, 0);

  const porCosto = new Map((costos || []).map(c => [norm(c.nombre), c]));

  const porEmpleado = (empleados || [])
    .filter(e => e.completo && vigenteEn(e, finDeMes))
    .map(e => {
      // La hoja de costos manda cuando existe: tiene valores pisados a mano que
      // son la verdad de hoy. La regla se calcula igual, para poder mostrar
      // dónde dejaron de coincidir.
      const regla = costoDeEmpleado(e);
      const cargado = porCosto.get(norm(e.nombre)) || null;
      const feriadoARS = importeFeriado(e, feriados, { costo: cargado });
      const sueldoTotalARS = (e.sueldoActualARS || 0) + feriadoARS;
      const sacARS = e.esSocio ? 0 : sacDelMes(e, mesId, { sueldoTotalARS });
      const costoBase = cargado ? cargado.costoTotalMensualARS : regla.costoTotalMensualARS;
      return {
        id: e.id, nombre: e.nombre, esSocio: e.esSocio,
        sueldoARS: e.sueldoActualARS,
        feriadoARS,
        sueldoTotalARS,
        sacARS,
        // Lo que la persona cobra en la mano ese mes.
        aCobrarARS: sueldoTotalARS + sacARS,
        // Lo que le cuesta al bar ese mes, con cargas y provisiones.
        costoTotalARS: costoBase + feriadoARS,
        cargasARS: cargado ? cargado.costoLaboralARS - cargado.netoRemunerativoARS : regla.cargasARS,
        provisionesARS: cargado
          ? cargado.prorrateoVacacionesARS + cargado.prorrateoAguinaldoARS
          : regla.prorrateoVacacionesARS + regla.prorrateoAguinaldoARS,
        origen: cargado ? 'planilla' : 'regla',
        difContraLaReglaARS: cargado ? cargado.costoTotalMensualARS - regla.costoTotalMensualARS : 0,
      };
    });

  const suma = campo => porEmpleado.reduce((s, e) => s + (e[campo] || 0), 0);
  const incompletos = (empleados || []).filter(e => !e.completo);

  return {
    mesId, anio, mes: MESES[mes - 1], esMesDeSAC: MESES_SAC.includes(mes), feriados,
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

const calcularRango = ({ empleados, costos, desdeMesId, meses = 12, feriados = 0 }) => {
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
function resumenCostoLaboral({ empleados, costos } = {}) {
  const completos = (empleados || []).filter(e => e.completo);
  const porCosto = new Map((costos || []).map(c => [norm(c.nombre), c]));

  let neto = 0, cargas = 0, provisiones = 0, aguinaldo = 0, total = 0;
  const detalle = [];
  for (const e of completos) {
    const regla = costoDeEmpleado(e);
    const cargado = porCosto.get(norm(e.nombre));
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
      // Cuánto se despegó la planilla de la regla en esta fila. Al 17/8/2026 hay
      // dos filas con el costo laboral pisado a mano; la planilla manda, pero la
      // diferencia se muestra en vez de quedar escondida.
      difContraLaReglaARS: cargado ? cargado.costoTotalMensualARS - regla.costoTotalMensualARS : 0,
    });
  }

  const incompletos = (empleados || []).filter(e => !e.completo)
    .map(e => ({ nombre: e.nombre, leFalta: e.leFalta }));

  return {
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
  };
}

// ─── I/O ────────────────────────────────────────────────────────────────────
function _sheets() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] }),
  });
}

const configurada = () => Boolean(SHEET_ID);

// UNFORMATTED_VALUE a propósito: las fechas llegan como serial y los importes
// como número, sin el "$" ni los separadores de miles del formato.
async function _leer(hoja, rango = 'A1:N100') {
  if (!configurada()) throw new Error('Falta NOMINA_SHEET_ID');
  const r = await _sheets().spreadsheets.values.get({
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
  // Puras — se pueden ejercitar sin red
  parsearEmpleados, parsearCostos, costoDeEmpleado, calcularMes, calcularRango,
  resumenCostoLaboral, importeFeriado, sacDelMes, diasEnElSemestre,
  dotacionEn, vigenteEn, cambiosDeDotacion,
  mesIdDe, parseMesId, mesIdSuma, nombreMesDe, esMesIdValido, parseFecha, parseImporte,
  // Constantes
  FACTOR_BRUTO, FACTOR_COSTO_LABORAL, MESES_SAC, DIAS_LABORABLES_MES,
  HOJA_EMPLEADOS, HOJA_COSTOS,
};
