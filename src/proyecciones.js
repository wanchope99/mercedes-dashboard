// ─── Proyecciones del negocio ───────────────────────────────────────────────────
// Proyecta ingresos/gastos a N meses a partir de los datos reales de Movimientos.
//
// Supuestos (transparentes, se devuelven en la respuesta):
//  · Ingresos: promedio por día de servicio de los últimos 28 días × días de
//    servicio estimados por mes (frecuencia observada en esos 28 días).
//  · Costo variable (Mercadería + Insumos): % promedio sobre ingresos de los
//    últimos 28 días, aplicado al ingreso proyectado.
//  · Personal: masa salarial del último mes completo con sueldos cargados.
//  · Alquiler: último alquiler registrado.
//  · Operativos + Impuestos: promedio diario de los últimos 28 días × 30.44
//    (excluye alquiler, que va aparte).
//  · Equipamiento / inversión y cuotas: EXCLUIDOS (no son gasto recurrente).
//  · Aguinaldos: Junio = 50% de la masa salarial · Diciembre = 50% (configurable
//    via env AGUINALDO_JUNIO_PCT / AGUINALDO_DICIEMBRE_PCT).
//  · Variables personalizadas: definidas por el usuario desde la app (hoja
//    "Proyeccion Variables"): gasto o ingreso mensual, meses elegidos,
//    "se repite cada año" o "una sola vez".

const ORDEN_MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Aguinaldo: MONTO FIJO en ARS por mes (no un % del personal). Lo que efectivamente
// se paga de SAC ese mes. Configurable por env.
const AGUINALDO_JUNIO_ARS = parseFloat(process.env.AGUINALDO_JUNIO_ARS || '1000000');
const AGUINALDO_DICIEMBRE_ARS = parseFloat(process.env.AGUINALDO_DICIEMBRE_ARS || '1000000');

// Personal esperado de un mes completo. Si el mes de referencia (el anterior con
// sueldos) queda por debajo del UMBRAL, se asume incompleto y se usa el DEFAULT.
// Ambos configurables por env.
const PERSONAL_MENSUAL_DEFAULT = parseFloat(process.env.PERSONAL_MENSUAL_DEFAULT || '11300000');
const PERSONAL_UMBRAL_MIN = parseFloat(process.env.PERSONAL_UMBRAL_MIN || '10000000');

const DIA_MS = 86_400_000;
const DIAS_VENTANA = 28;          // ventana de observación para los baselines
const DIAS_MES_PROM = 30.44;

// ─── Baselines a partir de movimientos reales ──────────────────────────────────
function calcularBaselines(movimientos, hoy = new Date()) {
  const corte = new Date(hoy.getTime() - DIAS_VENTANA * DIA_MS);
  const enVentana = movimientos.filter(m =>
    !m.esCambio && !m.esFondeo && m.fecha >= corte && m.fecha <= hoy);

  // Ingresos por día de servicio
  const porDia = {};
  let ingresos28 = 0;
  for (const m of enVentana) {
    if (m.tipo !== 'Ingreso' || m.proveedor !== 'Servicio') continue;
    const k = m.fecha.toISOString().slice(0, 10);
    porDia[k] = (porDia[k] || 0) + m.entradaTotal;
    ingresos28 += m.entradaTotal;
  }
  const diasServicio28 = Object.keys(porDia).length;
  const ingresoPorDiaServicio = diasServicio28 > 0 ? ingresos28 / diasServicio28 : 0;
  const diasServicioMes = diasServicio28 * (DIAS_MES_PROM / DIAS_VENTANA);
  const ingresoMensual = ingresoPorDiaServicio * diasServicioMes;

  // Costo variable: Mercadería + Insumos como % de los ingresos de la ventana
  let costoVar28 = 0, operativos28 = 0;
  for (const m of enVentana) {
    if (m.tipo !== 'Gasto' || m.esCuota || m.esCompraEnCuotas) continue;
    if (m.grupo === 'Mercaderia' || m.grupo === 'Insumos') costoVar28 += m.salidaTotal;
    else if ((m.grupo === 'Operativos' || m.grupo === 'Impuestos') && m.categoria !== 'Alquiler') {
      operativos28 += m.salidaTotal;
    }
  }
  const pctCostoVariable = ingresos28 > 0 ? Math.min(costoVar28 / ingresos28, 1) : 0;
  const operativosMensual = (operativos28 / DIAS_VENTANA) * DIAS_MES_PROM;

  // Personal: masa salarial del último mes (por nombre de mes) con sueldos
  const personalPorMes = {};
  for (const m of movimientos) {
    if (m.tipo === 'Gasto' && m.grupo === 'Personal' && m.mes) {
      personalPorMes[m.mes] = (personalPorMes[m.mes] || 0) + m.salidaTotal;
    }
  }
  // Referencia: la masa salarial del mes ANTERIOR al actual (último mes cerrado).
  // Si ese valor está por debajo del umbral (mes incompleto o sin cargar los sueldos
  // grandes), se asume que falta data y se usa el personal esperado por defecto.
  const mesActualIdx0 = hoy.getMonth();
  let personalRef = 0;
  for (let k = 1; k <= ORDEN_MESES.length; k++) {
    const idx = (mesActualIdx0 - k + 12) % 12;
    const mes = ORDEN_MESES[idx];
    if (personalPorMes[mes]) { personalRef = personalPorMes[mes]; break; }
  }
  // Fallback: si no hubo ningún mes anterior con personal, tomar el máximo cargado.
  if (!personalRef) personalRef = Math.max(0, ...Object.values(personalPorMes));
  // Piso: si la referencia es baja, defaultear al personal esperado de un mes completo.
  const personalMensual = personalRef < PERSONAL_UMBRAL_MIN ? PERSONAL_MENSUAL_DEFAULT : personalRef;

  // Alquiler: último registrado
  let alquilerMensual = 0, alquilerFecha = null;
  for (const m of movimientos) {
    if (m.tipo === 'Gasto' && m.categoria === 'Alquiler' && m.salidaTotal > 0) {
      if (!alquilerFecha || m.fecha > alquilerFecha) { alquilerFecha = m.fecha; alquilerMensual = m.salidaTotal; }
    }
  }

  return {
    ventanaDias: DIAS_VENTANA,
    diasServicio28, ingresoPorDiaServicio, diasServicioMes, ingresoMensual,
    pctCostoVariable, operativosMensual, personalMensual, alquilerMensual,
  };
}

// ─── Proyección a N meses ───────────────────────────────────────────────────────
// variables: [{ id, nombre, tipo: 'gasto'|'ingreso', monto, meses: ['Junio',...], repite: bool }]
function proyectar({ movimientos, resumen, variables = [], hoy = new Date(), horizonte = 12 }) {
  const base = calcularBaselines(movimientos, hoy);
  const mesActualIdx = hoy.getMonth();
  const anioActual = hoy.getFullYear();
  const mesActualNombre = ORDEN_MESES[mesActualIdx];

  // Histórico: meses del resumen anteriores al mes en curso (el actual se proyecta)
  const historico = (resumen || [])
    .filter(r => r.mes && ORDEN_MESES.includes(r.mes) && r.mes !== mesActualNombre)
    .sort((a, b) => ORDEN_MESES.indexOf(a.mes) - ORDEN_MESES.indexOf(b.mes))
    .map(r => ({
      mes: r.mes, anio: anioActual, label: `${r.mes.slice(0, 3)} ${anioActual}`,
      ingresos: r.ingresos.total, gastos: r.gastos.total,
      resultado: r.ingresos.total - r.gastos.total,
      real: true,
    }));

  // Variables "una sola vez": se aplican solo la PRIMERA vez que aparece cada mes tildado
  const unaVezAplicada = {};   // id -> Set(mesNombre)

  const proyeccion = [];
  let acumulado = 0;
  for (let i = 0; i < horizonte; i++) {
    const d = new Date(anioActual, mesActualIdx + i, 1);
    const mesNombre = ORDEN_MESES[d.getMonth()];
    const anio = d.getFullYear();

    const ingresosBase = base.ingresoMensual;
    const costoVariable = ingresosBase * base.pctCostoVariable;
    const personal = base.personalMensual;
    const alquiler = base.alquilerMensual;
    const operativos = base.operativosMensual;

    let aguinaldo = 0;
    if (mesNombre === 'Junio') aguinaldo = AGUINALDO_JUNIO_ARS;
    if (mesNombre === 'Diciembre') aguinaldo = AGUINALDO_DICIEMBRE_ARS;

    // Variables personalizadas
    let varGastos = 0, varIngresos = 0;
    const varDetalle = [];
    for (const v of variables) {
      if (!Array.isArray(v.meses) || !v.meses.includes(mesNombre)) continue;
      if (!v.repite) {
        const set = (unaVezAplicada[v.id] = unaVezAplicada[v.id] || new Set());
        if (set.has(mesNombre)) continue;
        set.add(mesNombre);
      }
      const monto = Number(v.monto) || 0;
      if (v.tipo === 'ingreso') varIngresos += monto; else varGastos += monto;
      varDetalle.push({ id: v.id, nombre: v.nombre, tipo: v.tipo, monto });
    }

    const ingresos = ingresosBase + varIngresos;
    const gastos = costoVariable + personal + alquiler + operativos + aguinaldo + varGastos;
    const resultado = ingresos - gastos;
    acumulado += resultado;

    proyeccion.push({
      mes: mesNombre, anio, label: `${mesNombre.slice(0, 3)} ${anio}`,
      ingresos, gastos, resultado, acumulado,
      desglose: { ingresosBase, varIngresos, costoVariable, personal, alquiler, operativos, aguinaldo, varGastos },
      variables: varDetalle,
      real: false,
    });
  }

  return {
    historico,
    proyeccion,
    supuestos: {
      ...base,
      aguinaldoJunioARS: AGUINALDO_JUNIO_ARS,
      aguinaldoDiciembreARS: AGUINALDO_DICIEMBRE_ARS,
      generado: hoy.toISOString(),
    },
  };
}

// ─── Calculadora P&L (réplica de Calculadora.xlsx, inputs editables) ─────────────
// Reproduce el modelo del Excel: a partir de supuestos operativos y costos, calcula
// ingreso mensual, costos variables (CMV), fijos, extraordinarios, resultado neto y
// payback. Todos los inputs tienen default tomado del Excel; el front los puede
// pisar uno por uno.
//
// Estructura del Excel:
//   A. Servicios/mes (noches) · Ingreso por noche → Ingreso mensual total
//   C. % CMV → Costo variable
//   D. Personal + Costos Fijos (alquiler + electricidad, gas, agua, ABL,
//      internet, contaduría, software) → Subtotal fijos
//   E. Financieros, Fiscales, Extraordinarios (3 líneas separadas — mismo
//      agrupamiento que usa el dashboard con datos reales, ver LEAF_MATCH en
//      server.js)
//   F. Total costos → Resultado neto (ARS y %)
//   G. Inversión total → Payback (meses)
const CALC_DEFAULTS = {
  serviciosPorMes: 21,
  ingresoPorNoche: 1650000,
  pctCMV: 38,                 // % sobre ingresos
  costoPersonal: 11300000,
  // "Costos Fijos" incluye el alquiler (antes un input aparte) + los operativos
  // (electricidad, gas, ...) — igual que el agrupamiento real: Fijos → {Alquiler,
  // Servicios}. El front hoy manda un total único (número o {total}); el objeto
  // detallado queda listo para una futura pantalla de "configuración avanzada"
  // que desglose cada línea (ver resolverPolimorfico).
  costosFijos: {
    alquiler: 930000,
    electricidad: 500000, gas: 40000, agua: 80000, abl: 15000,
    internet: 25000, contaduria: 250000, software: 120000,
  },
  costosExtraordinarios: 1500000,
  costosFinancieros: 1178100,
  pctFinancieros: null,       // se recalcula si modoFinancieros === 'pct'
  modoFinancieros: 'ars',     // 'ars' | 'pct' — cuál de los dos es la fuente de verdad
  costosFiscales: 0,
  pctFiscales: null,
  modoFiscales: 'ars',
  inversionTotalARS: 89400000,
};

function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }

// Acepta un número plano, { total }, o un objeto detallado (electricidad, gas, ...)
// y devuelve { detalle, total }. Usado hoy solo para costosFijos; queda genérico
// para cuando se sume una pantalla de desglose por línea.
function resolverPolimorfico(inputVal, defaults) {
  if (typeof inputVal === 'number') {
    const total = num(inputVal);
    return { detalle: { total }, total };
  }
  if (inputVal && typeof inputVal === 'object' && inputVal.total != null && Object.keys(inputVal).length === 1) {
    const total = num(inputVal.total);
    return { detalle: { total }, total };
  }
  if (inputVal && typeof inputVal === 'object') {
    const detalle = { ...defaults, ...inputVal };
    return { detalle, total: Object.values(detalle).reduce((s, x) => s + num(x), 0) };
  }
  const detalle = { ...defaults };
  return { detalle, total: Object.values(detalle).reduce((s, x) => s + num(x), 0) };
}

// Par ARS/% bidireccional: según `modo`, uno de los dos es la fuente de verdad y
// el otro se deriva a partir del ingreso mensual. `pctPrecision` en 2 decimales
// porque Financieros/Fiscales pueden ser una fracción chica del ingreso.
function resolverArsPct(arsInput, pctInput, modo, ingresoMensual, pctPrecision = 2) {
  const mult = Math.pow(10, pctPrecision);
  const pctDe = (x) => ingresoMensual > 0 ? Math.round((x / ingresoMensual) * 100 * mult) / mult : 0;
  if (modo === 'pct') {
    const p = num(pctInput);
    return { ars: ingresoMensual * (p / 100), pct: p };
  }
  const ars = num(arsInput);
  return { ars, pct: pctDe(ars) };
}

function calcularCalculadora(input = {}) {
  const i = { ...CALC_DEFAULTS, ...input };

  const { detalle: cf, total: subtotalCostosFijos } =
    resolverPolimorfico(input.costosFijos, CALC_DEFAULTS.costosFijos);

  const ingresoMensual = num(i.serviciosPorMes) * num(i.ingresoPorNoche);

  // C. Costos variables (CMV) — % sobre ingresos
  const cmv = ingresoMensual * (num(i.pctCMV) / 100);
  const costoPersonal = num(i.costoPersonal);
  const subtotalFijos = costoPersonal + subtotalCostosFijos;

  // E. Financieros / Fiscales — bidireccional ARS↔%. Extraordinarios sigue
  // siendo un monto ARS único (no se pidió modo dual para esta línea).
  const modoFinancieros = i.modoFinancieros === 'pct' ? 'pct' : 'ars';
  const modoFiscales = i.modoFiscales === 'pct' ? 'pct' : 'ars';
  const financieros = resolverArsPct(i.costosFinancieros, i.pctFinancieros, modoFinancieros, ingresoMensual);
  const fiscales = resolverArsPct(i.costosFiscales, i.pctFiscales, modoFiscales, ingresoMensual);
  const extraordinariosArs = num(i.costosExtraordinarios);

  const extFinFis = extraordinariosArs + financieros.ars + fiscales.ars;

  // F. Resultado
  const totalCostos = cmv + subtotalFijos + extFinFis;
  const resultadoNeto = ingresoMensual - totalCostos;
  const pct = (x) => ingresoMensual > 0 ? Math.round((x / ingresoMensual) * 1000) / 10 : 0;
  const pct2 = (x) => ingresoMensual > 0 ? Math.round((x / ingresoMensual) * 10000) / 100 : 0;

  // G. Payback
  const inversion = num(i.inversionTotalARS);
  const payback = resultadoNeto > 0 ? Math.round((inversion / resultadoNeto) * 10) / 10 : null;

  return {
    inputs: { ...i, costosFijos: cf },
    ingresoMensual,
    costosVariables: { cmv, pct: pct(cmv) },
    costosFijos: {
      personal: costoPersonal, pctPersonal: pct(costoPersonal),
      fijos: cf, subtotalFijos: subtotalCostosFijos, pctFijos: pct(subtotalCostosFijos),
      subtotal: subtotalFijos, pctSubtotal: pct(subtotalFijos),
    },
    extraordinarios: {
      fiscales: fiscales.ars, pctFiscales: pct2(fiscales.ars), modoFiscales,
      financieros: financieros.ars, pctFinancieros: pct2(financieros.ars), modoFinancieros,
      extraordinarios: extraordinariosArs, pctExtraordinarios: pct2(extraordinariosArs),
      subtotal: extFinFis, pctSubtotal: pct(extFinFis),
    },
    totalCostos, pctTotalCostos: pct(totalCostos),
    resultadoNeto, pctResultadoNeto: pct(resultadoNeto),
    inversionTotalARS: inversion,
    paybackMeses: payback,
  };
}

// ─── Proyección del MES en curso (estilo Azure: real acumulado + forecast) ───────
// Toma SOLO el mes actual. Acumula ingresos y gastos REALES registrados hasta hoy
// y proyecta linealmente hasta fin de mes según el ritmo diario observado, sumando
// además los costos fijos del mes (alquiler, personal, servicios) que quizá aún no
// se registraron. Devuelve series diarias para el gráfico acumulado.
function proyeccionMes({ movimientos, variables = [], hoy = new Date() }) {
  const anio = hoy.getFullYear();
  const mesIdx = hoy.getMonth();
  const mesNombre = ORDEN_MESES[mesIdx];
  const primerDia = new Date(anio, mesIdx, 1);
  const ultimoDia = new Date(anio, mesIdx + 1, 0);
  const diasMes = ultimoDia.getDate();
  const diaHoy = hoy.getDate();
  const diasRestantes = Math.max(0, diasMes - diaHoy);

  // Baseline estable de los ultimos 28 dias (ingreso por dia de servicio, % costo
  // variable, operativos, personal, alquiler). Esto NO se sesga por el dia del mes.
  const base = calcularBaselines(movimientos, hoy);

  const delMes = (movimientos || []).filter(m =>
    !m.esCambio && !m.esFondeo && !m.esCuota &&
    m.fecha >= primerDia && m.fecha <= hoy);

  // Acumulados diarios reales + deteccion de costos fijos YA registrados este mes.
  const ingresoPorDia = new Array(diasMes + 1).fill(0);
  const gastoPorDia = new Array(diasMes + 1).fill(0);
  let ingresoReal = 0, gastoReal = 0;
  let diasConServicio = new Set();
  let personalRegistrado = 0, alquilerRegistrado = 0, costoVarRegistrado = 0;

  for (const m of delMes) {
    const d = m.fecha.getDate();
    if (m.tipo === 'Ingreso') {
      ingresoPorDia[d] += m.entradaTotal; ingresoReal += m.entradaTotal;
      if (m.proveedor === 'Servicio') diasConServicio.add(d);
    } else if (m.tipo === 'Gasto') {
      const monto = m.salidaTotal;
      gastoPorDia[d] += monto; gastoReal += monto;
      if (m.grupo === 'Personal') personalRegistrado += monto;
      else if (m.categoria === 'Alquiler') alquilerRegistrado += monto;
      if (m.grupo === 'Mercaderia' || m.grupo === 'Insumos') costoVarRegistrado += monto;
    }
  }

  // ── Forecast de los dias que faltan, POR DIAS DE SERVICIO (no por ritmo diario) ──
  // Cuantos dias de servicio quedan: frecuencia observada (dias serv / dia del mes)
  // aplicada a los dias restantes. Cada dia de servicio aporta el ingreso promedio
  // por servicio de los ultimos 28 dias, y su costo variable asociado.
  const frecServicio = diaHoy > 0 ? (diasConServicio.size / diaHoy) : (base.diasServicioMes / DIAS_MES_PROM);
  const diasServicioRestantes = frecServicio * diasRestantes;
  const ingresoPorServicio = base.ingresoPorDiaServicio || 0;

  const ingresoFuturoServicios = diasServicioRestantes * ingresoPorServicio;
  const costoVarFuturo = ingresoFuturoServicios * base.pctCostoVariable;
  // Operativos (no alquiler): prorratea el baseline mensual por los dias que faltan.
  const operativosFuturo = (base.operativosMensual / DIAS_MES_PROM) * diasRestantes;

  // ── Costos fijos del mes SIN doble conteo ──
  // Si el fijo ya esta registrado en lo real, NO se vuelve a sumar. Si falta, se
  // completa con la variable custom que matchee por nombre, o con el baseline.
  const norm = s => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const esPersonalVar = n => /sueldo|personal|salario|nomina|jornal/.test(norm(n));
  const esAlquilerVar = n => /alquiler|renta|locacion/.test(norm(n));

  // Variables custom del mes, separadas por tipo y por si "reemplazan" un fijo.
  let varIngresoMes = 0, varGastoOtros = 0;
  let varPersonal = 0, varAlquiler = 0;
  const varDetalle = [];
  for (const v of (variables || [])) {
    if (!Array.isArray(v.meses) || !v.meses.includes(mesNombre)) continue;
    const monto = Number(v.monto) || 0;
    if (v.tipo === 'ingreso') { varIngresoMes += monto; varDetalle.push({ nombre: v.nombre, tipo: 'ingreso', monto }); continue; }
    if (esPersonalVar(v.nombre)) { varPersonal += monto; varDetalle.push({ nombre: v.nombre, tipo: 'gasto', concepto: 'personal', monto }); }
    else if (esAlquilerVar(v.nombre)) { varAlquiler += monto; varDetalle.push({ nombre: v.nombre, tipo: 'gasto', concepto: 'alquiler', monto }); }
    else { varGastoOtros += monto; varDetalle.push({ nombre: v.nombre, tipo: 'gasto', monto }); }
  }

  // Personal del mes: lo ya registrado + lo que falte para llegar al objetivo
  // (variable custom si existe; si no, baseline). Nunca menos que lo ya pagado.
  const objetivoPersonal = varPersonal > 0 ? varPersonal : base.personalMensual;
  const personalFaltante = Math.max(0, objetivoPersonal - personalRegistrado);
  const objetivoAlquiler = varAlquiler > 0 ? varAlquiler : base.alquilerMensual;
  const alquilerFaltante = Math.max(0, objetivoAlquiler - alquilerRegistrado);

  // Aguinaldo (Junio/Diciembre) sobre el objetivo de personal.
  let aguinaldo = 0;
  if (mesNombre === 'Junio') aguinaldo = AGUINALDO_JUNIO_ARS;
  if (mesNombre === 'Diciembre') aguinaldo = AGUINALDO_DICIEMBRE_ARS;

  // ── Totales forecast ──
  const ingresoForecast = ingresoReal + ingresoFuturoServicios + varIngresoMes;
  const gastoForecast = gastoReal
    + costoVarFuturo + operativosFuturo
    + personalFaltante + alquilerFaltante + aguinaldo + varGastoOtros;

  // Reparto del gasto futuro por dia (para la serie del grafico): el gasto que falta
  // se distribuye parejo en los dias restantes (visualmente suave, sin saltos).
  const gastoFuturoTotal = costoVarFuturo + operativosFuturo + personalFaltante + alquilerFaltante + aguinaldo + varGastoOtros;
  const ingresoFuturoTotal = ingresoFuturoServicios + varIngresoMes;
  const gastoFuturoPorDia = diasRestantes > 0 ? gastoFuturoTotal / diasRestantes : 0;
  const ingresoFuturoPorDia = diasRestantes > 0 ? ingresoFuturoTotal / diasRestantes : 0;

  const serie = [];
  let accIng = 0, accGas = 0;
  for (let d = 1; d <= diasMes; d++) {
    const esFuturo = d > diaHoy;
    if (!esFuturo) { accIng += ingresoPorDia[d]; accGas += gastoPorDia[d]; }
    serie.push({
      dia: d,
      fecha: `${anio}-${String(mesIdx+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
      ingresoReal: esFuturo ? null : Math.round(accIng),
      gastoReal: esFuturo ? null : Math.round(accGas),
      ingresoForecast: esFuturo ? Math.round(ingresoReal + ingresoFuturoPorDia * (d - diaHoy)) : Math.round(accIng),
      gastoForecast: esFuturo ? Math.round(gastoReal + gastoFuturoPorDia * (d - diaHoy)) : Math.round(accGas),
    });
  }

  return {
    mes: mesNombre, anio, diasMes, diaHoy, diasRestantes,
    diasConServicio: diasConServicio.size,
    diasServicioRestantes: Math.round(diasServicioRestantes * 10) / 10,
    ingresoReal: Math.round(ingresoReal),
    gastoReal: Math.round(gastoReal),
    resultadoReal: Math.round(ingresoReal - gastoReal),
    ingresoForecast: Math.round(ingresoForecast),
    gastoForecast: Math.round(gastoForecast),
    resultadoForecast: Math.round(ingresoForecast - gastoForecast),
    ingresoDiario: Math.round(diaHoy > 0 ? ingresoReal / diaHoy : 0),
    gastoDiario: Math.round(diaHoy > 0 ? gastoReal / diaHoy : 0),
    ingresoPorServicio: Math.round(ingresoPorServicio),
    variablesMes: varDetalle,
    // Transparencia: de donde sale el forecast
    forecastDetalle: {
      personalRegistrado: Math.round(personalRegistrado),
      personalFaltante: Math.round(personalFaltante),
      objetivoPersonal: Math.round(objetivoPersonal),
      alquilerRegistrado: Math.round(alquilerRegistrado),
      alquilerFaltante: Math.round(alquilerFaltante),
      costoVarRegistrado: Math.round(costoVarRegistrado),
      costoVarFuturo: Math.round(costoVarFuturo),
      operativosFuturo: Math.round(operativosFuturo),
      ingresoFuturoServicios: Math.round(ingresoFuturoServicios),
      aguinaldo: Math.round(aguinaldo),
    },
    serie,
  };
}

module.exports = { proyectar, calcularBaselines, calcularCalculadora, proyeccionMes, CALC_DEFAULTS, ORDEN_MESES };
