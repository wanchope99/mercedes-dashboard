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

const AGUINALDO_JUNIO_PCT = parseFloat(process.env.AGUINALDO_JUNIO_PCT || '0.5');
const AGUINALDO_DICIEMBRE_PCT = parseFloat(process.env.AGUINALDO_DICIEMBRE_PCT || '0.5');

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
  let personalMensual = 0;
  for (let i = ORDEN_MESES.length - 1; i >= 0; i--) {
    const mes = ORDEN_MESES[i];
    // tomar el último mes cuya masa salarial sea "completa" (>= 60% del máximo)
    if (personalPorMes[mes]) {
      const max = Math.max(...Object.values(personalPorMes));
      if (personalPorMes[mes] >= max * 0.6) { personalMensual = personalPorMes[mes]; break; }
    }
  }
  if (!personalMensual) personalMensual = Math.max(0, ...Object.values(personalPorMes));

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
    if (mesNombre === 'Junio') aguinaldo = personal * AGUINALDO_JUNIO_PCT;
    if (mesNombre === 'Diciembre') aguinaldo = personal * AGUINALDO_DICIEMBRE_PCT;

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
      aguinaldoJunioPct: AGUINALDO_JUNIO_PCT,
      aguinaldoDiciembrePct: AGUINALDO_DICIEMBRE_PCT,
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
//   D. Personal + Alquiler + Fijos operativos (electricidad, gas, agua, ABL,
//      internet, contaduría, software) → Subtotal fijos
//   E. Extraordinarios + Financieros + Fiscales
//   F. Total costos → Resultado neto (ARS y %)
//   G. Inversión total → Payback (meses)
const CALC_DEFAULTS = {
  serviciosPorMes: 21,
  ingresoPorNoche: 1650000,
  pctCMV: 38,                 // % sobre ingresos
  costoPersonal: 11300000,
  alquiler: 930000,
  fijosOperativos: {
    electricidad: 500000, gas: 40000, agua: 80000, abl: 15000,
    internet: 25000, contaduria: 250000, software: 120000,
  },
  // NOTA del modelo original (Excel): el "Subtotal Costos Fijos Operativos" que
  // muestra el Excel (1.960.000) INCLUYE el alquiler (1.030.000 líneas + 930.000
  // alquiler). Acá los mantenemos separados: operativos = 1.030.000 y alquiler
  // aparte = 930.000. El TOTAL de costos y el resultado neto coinciden exacto.
  costosExtraordinarios: 1500000,
  costosFinancieros: 1178100,
  costosFiscales: 0,
  inversionTotalARS: 89400000,
};

function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }

function calcularCalculadora(input = {}) {
  const i = { ...CALC_DEFAULTS, ...input };
  // Permitir override parcial del objeto de fijos operativos
  const fo = { ...CALC_DEFAULTS.fijosOperativos, ...(input.fijosOperativos || {}) };

  const ingresoMensual = num(i.serviciosPorMes) * num(i.ingresoPorNoche);

  // C. Costos variables (CMV) — % sobre ingresos
  const cmv = ingresoMensual * (num(i.pctCMV) / 100);

  // D. Costos fijos
  const subtotalFijosOperativos = Object.values(fo).reduce((s, x) => s + num(x), 0);
  const costoPersonal = num(i.costoPersonal);
  const alquiler = num(i.alquiler);
  const subtotalFijos = costoPersonal + alquiler + subtotalFijosOperativos;

  // E. Extraordinarios / financieros / fiscales
  const extFinFis = num(i.costosExtraordinarios) + num(i.costosFinancieros) + num(i.costosFiscales);

  // F. Resultado
  const totalCostos = cmv + subtotalFijos + extFinFis;
  const resultadoNeto = ingresoMensual - totalCostos;
  const pct = (x) => ingresoMensual > 0 ? Math.round((x / ingresoMensual) * 1000) / 10 : 0;

  // G. Payback
  const inversion = num(i.inversionTotalARS);
  const payback = resultadoNeto > 0 ? Math.round((inversion / resultadoNeto) * 10) / 10 : null;

  return {
    inputs: { ...i, fijosOperativos: fo },
    ingresoMensual,
    costosVariables: { cmv, pct: pct(cmv) },
    costosFijos: {
      personal: costoPersonal, pctPersonal: pct(costoPersonal),
      alquiler, pctAlquiler: pct(alquiler),
      operativos: fo, subtotalOperativos: subtotalFijosOperativos, pctOperativos: pct(subtotalFijosOperativos),
      subtotal: subtotalFijos, pctSubtotal: pct(subtotalFijos),
    },
    extraordinarios: {
      extraordinarios: num(i.costosExtraordinarios),
      financieros: num(i.costosFinancieros),
      fiscales: num(i.costosFiscales),
      subtotal: extFinFis, pct: pct(extFinFis),
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

  const delMes = (movimientos || []).filter(m =>
    !m.esCambio && !m.esFondeo && !m.esCuota &&
    m.fecha >= primerDia && m.fecha <= hoy);

  // Acumulados diarios reales
  const ingresoPorDia = new Array(diasMes + 1).fill(0);
  const gastoPorDia = new Array(diasMes + 1).fill(0);
  let ingresoReal = 0, gastoReal = 0;
  let diasConServicio = new Set();
  let fijosYaRegistrados = 0;

  for (const m of delMes) {
    const d = m.fecha.getDate();
    if (m.tipo === 'Ingreso') {
      ingresoPorDia[d] += m.entradaTotal; ingresoReal += m.entradaTotal;
      if (m.proveedor === 'Servicio') diasConServicio.add(d);
    } else if (m.tipo === 'Gasto') {
      const monto = (m.pagado || m.esCompraEnCuotas) ? m.salidaTotal : m.salidaTotal;
      gastoPorDia[d] += monto; gastoReal += monto;
      if (m.grupo === 'Personal' || m.categoria === 'Alquiler' || m.grupo === 'Operativos') {
        fijosYaRegistrados += monto;
      }
    }
  }

  // Ritmo diario observado (sobre días transcurridos)
  const ingresoDiario = diaHoy > 0 ? ingresoReal / diaHoy : 0;
  const gastoDiario = diaHoy > 0 ? gastoReal / diaHoy : 0;
  const diasRestantes = diasMes - diaHoy;

  // Variables personalizadas que aplican al mes en curso (monto mensual completo).
  let varIngresoMes = 0, varGastoMes = 0;
  const varDetalle = [];
  for (const v of (variables || [])) {
    if (!Array.isArray(v.meses) || !v.meses.includes(mesNombre)) continue;
    const monto = Number(v.monto) || 0;
    if (v.tipo === 'ingreso') varIngresoMes += monto; else varGastoMes += monto;
    varDetalle.push({ nombre: v.nombre, tipo: v.tipo, monto });
  }

  // Forecast: ritmo diario hasta fin de mes + variables del mes (monto completo).
  const ingresoForecast = ingresoReal + ingresoDiario * diasRestantes + varIngresoMes;
  const gastoForecast = gastoReal + gastoDiario * diasRestantes + varGastoMes;

  // Series acumuladas para el gráfico
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
      ingresoForecast: esFuturo ? Math.round(ingresoReal + ingresoDiario * (d - diaHoy) + (diasRestantes>0 ? varIngresoMes * ((d - diaHoy)/diasRestantes) : 0)) : Math.round(accIng),
      gastoForecast: esFuturo ? Math.round(gastoReal + gastoDiario * (d - diaHoy) + (diasRestantes>0 ? varGastoMes * ((d - diaHoy)/diasRestantes) : 0)) : Math.round(accGas),
    });
  }

  return {
    mes: mesNombre, anio, diasMes, diaHoy, diasRestantes,
    diasConServicio: diasConServicio.size,
    ingresoReal: Math.round(ingresoReal),
    gastoReal: Math.round(gastoReal),
    resultadoReal: Math.round(ingresoReal - gastoReal),
    ingresoForecast: Math.round(ingresoForecast),
    gastoForecast: Math.round(gastoForecast),
    resultadoForecast: Math.round(ingresoForecast - gastoForecast),
    ingresoDiario: Math.round(ingresoDiario),
    gastoDiario: Math.round(gastoDiario),
    variablesMes: varDetalle,
    serie,
  };
}

module.exports = { proyectar, calcularBaselines, calcularCalculadora, proyeccionMes, CALC_DEFAULTS, ORDEN_MESES };
