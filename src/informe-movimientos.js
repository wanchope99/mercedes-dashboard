// ─── Analista: la plata (hoja Movimientos + hoja Compras), semanal ──────────
//
// Corre los domingos y mira los últimos 7 días. Detecta lo que no se ve mirando
// totales: una factura fuera de escala, una carga repetida, una categoría que se
// despegó de su propia serie, un precio unitario que se movió, un proveedor que
// cobra más caro lo mismo.
//
// QUÉ NO MIRA, Y POR QUÉ NO (16/8/2026):
//
// · LOS COSTOS DE CADENCIA MENSUAL — sueldos y cargas, alquiler, servicios,
//   impuestos. Se pagan una vez por mes, así que la serie semanal de esas
//   categorías es un diente de sierra: la semana en que se pagan aparece
//   "disparada" y las otras tres aparecen "faltando datos". Decir un día 16 que
//   falta cargar los sueldos no es un hallazgo, es un artefacto del calendario.
//   Esos costos se juzgan donde se pueden juzgar: en el balance mensual, que
//   ahora los mira concepto por concepto (ver informe-mensual.js). Siguen
//   contando en los totales de plata de la semana —la plata salió— pero no
//   generan señales.
//
// · "EL PROVEEDOR X NO APARECE" A SECAS. El dueño sabe a quién le compra y a
//   quién dejó de comprarle; enterarse de eso por un informe no le agrega nada.
//   Lo que sí agrega es el IMPACTO: qué pasó con el costo de esa categoría, con
//   la frecuencia de entrega y con el precio unitario de los productos desde que
//   cambió. Por eso la ausencia sola no se emite nunca: sólo se emite cuando ya
//   hay período suficiente para medir qué cambió.
//
// Todo lo de este archivo es puro: entran los movimientos y las compras, salen
// contexto y señales. Se puede correr con datos inventados y verificar cada
// número a mano.

const {
  mediana, escalaDe, norm, diaISO, diasEntre, redondear, mesPlanillaDe,
  DIAS_VENTANA, SEMANAS_REFERENCIA,
} = require('./informes-util');

const TIPO = 'movimientos';
const TITULO = 'La plata de la semana';

const MIN_APARICIONES = 4;    // menos que esto no es historia, es anécdota
const UMBRAL_DESVIO = 4;
// Piso de materialidad: por debajo no vale la atención de nadie, por más raro
// que sea estadísticamente. Sin piso, el informe se llena de envíos de $4.000.
const PISO_MATERIAL = 25000;

// Los costos que se pagan una vez por mes. Se los saca del análisis semanal
// completo: no generan señales aunque se disparen, porque en una serie semanal
// un cargo mensual siempre parece disparado o siempre parece faltante.
// `Fijos` son alquiler y servicios; `Fiscales`, impuestos y honorarios.
const SUPERGRUPOS_MENSUALES = new Set(['Personal', 'Fijos', 'Fiscales']);
const esCadenciaMensual = m => SUPERGRUPOS_MENSUALES.has(m.superGrupo);

// Un cambio de precio de menos de esto es inflación, no una decisión de nadie:
// a ~1,9% mensual, dos meses de deriva son ~4%. El umbral está bien por encima.
const UMBRAL_PRECIO_PCT = 12;
const UMBRAL_BRECHA_PROVEEDOR_PCT = 10;

const pct1 = n => Number((n || 0).toFixed(1));
const variacionPct = (ahora, antes) => (antes > 0 ? pct1(((ahora - antes) / antes) * 100) : null);

function analizarMovimientos(movimientos, { hasta, escalones } = {}) {
  const corte = hasta ? new Date(hasta) : new Date();
  corte.setHours(23, 59, 59, 999);

  // Misma regla que el resto de la app: los cambios entre cajas y los fondeos
  // no son resultado, y las filas de cuota no se suman porque la fila madre ya
  // lleva el total de la compra.
  const operativos = movimientos.filter(m => m.fecha && !m.esCambio && !m.esFondeo && !m.esCuota && m.fecha <= corte);
  const gastosTodos = operativos.filter(m => m.tipo === 'Gasto' && (m.salidaTotal || 0) > 0);
  const ingresos = operativos.filter(m => m.tipo === 'Ingreso' && (m.entradaTotal || 0) > 0);

  // Lo que el análisis semanal mira de verdad: el gasto que se decide semana a
  // semana. Los mensuales quedan afuera de todas las señales.
  const gastos = gastosTodos.filter(g => !esCadenciaMensual(g));

  const desdeVentana = new Date(corte.getTime() - DIAS_VENTANA * 86400000);
  const enVentana = m => m.fecha > desdeVentana;

  const senales = [];
  const agregar = (tipo, s) => senales.push({ tipo, ...s });

  const porProveedor = new Map();
  for (const g of gastos) {
    const k = norm(g.proveedor);
    if (!k) continue;
    if (!porProveedor.has(k)) porProveedor.set(k, []);
    porProveedor.get(k).push(g);
  }

  // ── A. Monto muy fuera de lo que ese proveedor suele cobrar ──────────────
  // Agarra tanto el precio que se disparó como el error de tipeo por orden de
  // magnitud — la comisión de $1.285.499 de julio habría entrado por acá.
  for (const [clave, filas] of porProveedor) {
    // Escalón: si el dueño avisó que este proveedor cambió de nivel (más
    // empleados, un aumento, otras condiciones), la historia previa al cambio
    // deja de ser comparable y se descarta. Sin esto, el nivel nuevo se marca
    // como atípico cada semana hasta que la mitad de las filas históricas estén
    // en el nivel nuevo y la mediana se mueva sola. Ver src/informes-notas.js.
    const escalon = escalones && escalones.get(clave);
    const previas = filas.filter(f => !enVentana(f) && (!escalon || f.fecha >= escalon.desde));
    const historia = previas.map(f => f.salidaTotal);
    // Con menos de MIN_APARICIONES después del escalón todavía no hay con qué
    // comparar. Se calla, que es lo correcto: comparar contra el nivel viejo es
    // exactamente lo que el dueño pidió que dejara de hacer.
    if (historia.length < MIN_APARICIONES) continue;
    const med = mediana(historia);
    const escala = escalaDe(historia, med);
    if (!(escala > 0)) continue;
    for (const f of filas.filter(enVentana)) {
      if (Math.abs(f.salidaTotal - med) / escala < UMBRAL_DESVIO) continue;
      if (Math.abs(f.salidaTotal - med) < PISO_MATERIAL) continue;
      agregar('monto_atipico', {
        fila: f.rowIndex, fecha: diaISO(f.fecha), proveedor: f.proveedor,
        categoria: f.categoria, descripcion: f.descripcion,
        montoARS: redondear(f.salidaTotal), habitualARS: redondear(med),
        veces: Number((f.salidaTotal / (med || 1)).toFixed(1)),
        aparicionesPrevias: historia.length,
      });
    }
  }

  // ── B. Cambió el proveedor: qué pasó con el costo y con la entrega ───────
  //
  // Que un proveedor deje de aparecer NO se informa: el dueño ya lo sabe, lo
  // decidió él. Lo que se informa es qué cambió desde entonces, medido sobre la
  // categoría entera, que es donde el reemplazo se ve:
  //
  //   · COSTO: cuánto se gasta por semana en esa categoría, antes y después.
  //   · ENTREGA: cuántas compras por semana entran, antes y después (menos
  //     entregas de más plata cada una es otra operación: más stock parado, más
  //     riesgo de faltante).
  //   · QUIÉN: qué proveedores de la misma categoría crecieron en su lugar.
  //
  // Si todavía no pasó tiempo suficiente desde el cambio, no se dice nada: una
  // semana no alcanza para medir un reemplazo, y opinar antes es peor que
  // callarse.
  const DIAS_MINIMOS_DESPUES = 14;
  const VENTANA_ANTES = 56;
  const desde120 = new Date(corte.getTime() - 120 * 86400000);

  const porCategoriaFilas = new Map();
  for (const g of gastos) {
    const k = g.categoria || 'Sin categoría';
    if (!porCategoriaFilas.has(k)) porCategoriaFilas.set(k, []);
    porCategoriaFilas.get(k).push(g);
  }

  for (const [, filas] of porProveedor) {
    const recientes = filas.filter(f => f.fecha > desde120).sort((a, b) => a.fecha - b.fecha);
    // Cinco y no cuatro: con cuatro compras juntas en una semana un proveedor
    // puntual parece "semanal" y después figura ausente para siempre.
    if (recientes.length < 5) continue;
    if (mediana(recientes.map(f => f.salidaTotal)) < PISO_MATERIAL) continue;
    const huecos = [];
    for (let i = 1; i < recientes.length; i++) huecos.push(diasEntre(recientes[i - 1].fecha, recientes[i].fecha));
    const huecoTipico = mediana(huecos);
    if (!(huecoTipico > 0) || huecoTipico > 21) continue;
    const ultima = recientes[recientes.length - 1];
    const silencio = diasEntre(ultima.fecha, corte);
    if (silencio < Math.max(2.5 * huecoTipico, huecoTipico + 10)) continue;
    // Pasados dos meses ya no es un cambio reciente, es historia.
    if (silencio > 60) continue;
    if (silencio < DIAS_MINIMOS_DESPUES) continue;

    const categoria = ultima.categoria || 'Sin categoría';
    const deLaCategoria = porCategoriaFilas.get(categoria) || [];
    const inicioAntes = new Date(ultima.fecha.getTime() - VENTANA_ANTES * 86400000);
    const antes = deLaCategoria.filter(f => f.fecha > inicioAntes && f.fecha <= ultima.fecha);
    const despues = deLaCategoria.filter(f => f.fecha > ultima.fecha);
    const semanasAntes = VENTANA_ANTES / 7;
    const semanasDespues = silencio / 7;
    if (!antes.length || semanasDespues <= 0) continue;

    const totalAntes = antes.reduce((s, f) => s + f.salidaTotal, 0);
    const totalDespues = despues.reduce((s, f) => s + f.salidaTotal, 0);
    const gastoSemAntes = totalAntes / semanasAntes;
    const gastoSemDespues = totalDespues / semanasDespues;
    // Si la categoría entera mueve poco, el reemplazo no le cambia la vida a
    // nadie y el hallazgo sería una curiosidad.
    if (Math.max(gastoSemAntes, gastoSemDespues) < PISO_MATERIAL * 2) continue;

    const porProvDespues = new Map();
    for (const f of despues) {
      const k = f.proveedor || 'Sin proveedor';
      porProvDespues.set(k, (porProvDespues.get(k) || 0) + f.salidaTotal);
    }
    const porProvAntes = new Map();
    for (const f of antes) {
      const k = f.proveedor || 'Sin proveedor';
      porProvAntes.set(k, (porProvAntes.get(k) || 0) + f.salidaTotal);
    }
    const tomaron = [...porProvDespues.entries()]
      .map(([proveedor, monto]) => ({
        proveedor,
        gastoSemanalDespuesARS: redondear(monto / semanasDespues),
        gastoSemanalAntesARS: redondear((porProvAntes.get(proveedor) || 0) / semanasAntes),
      }))
      .filter(p => norm(p.proveedor) !== norm(ultima.proveedor))
      .sort((a, b) => (b.gastoSemanalDespuesARS - b.gastoSemanalAntesARS) - (a.gastoSemanalDespuesARS - a.gastoSemanalAntesARS))
      .slice(0, 3);

    agregar('cambio_de_proveedor', {
      proveedorQueSalio: ultima.proveedor, categoria,
      desdeISO: diaISO(ultima.fecha), diasDesdeElCambio: silencio,
      costoSemanalCategoriaAntesARS: redondear(gastoSemAntes),
      costoSemanalCategoriaDespuesARS: redondear(gastoSemDespues),
      variacionCostoPct: variacionPct(gastoSemDespues, gastoSemAntes),
      entregasPorSemanaAntes: Number((antes.length / semanasAntes).toFixed(1)),
      entregasPorSemanaDespues: Number((despues.length / semanasDespues).toFixed(1)),
      montoPromedioPorEntregaAntesARS: antes.length ? redondear(totalAntes / antes.length) : 0,
      montoPromedioPorEntregaDespuesARS: despues.length ? redondear(totalDespues / despues.length) : 0,
      quienesTomaronElVolumen: tomaron,
    });
  }

  // ── C. Duplicado probable ────────────────────────────────────────────────
  // Este sí mira TODO, incluidos los costos mensuales: no es un análisis de
  // nivel de gasto sino la detección de un error de carga, y un sueldo o un VEP
  // pagado dos veces es plata que se fue dos veces. Se compara contra la
  // cadencia propia del proveedor: Acequia trae pan cada 7 días por $90.000
  // siempre. Dos filas iguales a 7 días ahí no son un duplicado, son el pedido
  // semanal.
  const porProveedorTodos = new Map();
  for (const g of gastosTodos) {
    const k = norm(g.proveedor);
    if (!k) continue;
    if (!porProveedorTodos.has(k)) porProveedorTodos.set(k, []);
    porProveedorTodos.get(k).push(g);
  }
  const cadencia = new Map();
  for (const [k, filas] of porProveedorTodos) {
    const orden = [...filas].sort((a, b) => a.fecha - b.fecha);
    const huecos = [];
    for (let i = 1; i < orden.length; i++) huecos.push(diasEntre(orden[i - 1].fecha, orden[i].fecha));
    if (huecos.length >= 3) cadencia.set(k, mediana(huecos));
  }
  const desde30 = new Date(corte.getTime() - 30 * 86400000);
  const cand = gastosTodos.filter(g => g.fecha > desde30 && g.salidaTotal >= PISO_MATERIAL);
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i], b = cand[j];
      const k = norm(a.proveedor);
      if (k !== norm(b.proveedor) || !k) continue;
      if (Math.abs(a.salidaTotal - b.salidaTotal) > 1) continue;
      const dias = Math.abs(diasEntre(a.fecha, b.fecha));
      if (dias > 3) continue;
      const suHueco = cadencia.get(k);
      if (suHueco && dias >= suHueco * 0.5) continue;
      agregar('duplicado_probable', {
        proveedor: a.proveedor, montoARS: redondear(a.salidaTotal), diasDeDiferencia: dias,
        filas: [a.rowIndex, b.rowIndex], fechas: [diaISO(a.fecha), diaISO(b.fecha)],
        descripciones: [a.descripcion, b.descripcion],
      });
    }
  }

  // ── D. Categoría que se despegó de su propia serie ───────────────────────
  // Sólo categorías de gasto variable: ver el encabezado del archivo.
  const semanaDe = f => Math.floor(diasEntre(f, corte) / 7);
  const porCategoria = new Map();
  for (const g of gastos) {
    const sem = semanaDe(g.fecha);
    if (sem < 0 || sem > SEMANAS_REFERENCIA) continue;
    const k = g.categoria || 'Sin categoría';
    if (!porCategoria.has(k)) porCategoria.set(k, new Map());
    const serie = porCategoria.get(k);
    serie.set(sem, (serie.get(sem) || 0) + g.salidaTotal);
  }
  for (const [categoria, serie] of porCategoria) {
    const actual = serie.get(0) || 0;
    const previas = [];
    for (let s = 1; s <= SEMANAS_REFERENCIA; s++) previas.push(serie.get(s) || 0);
    if (previas.filter(x => x > 0).length < 4) continue;
    const med = mediana(previas);
    const escala = escalaDe(previas, med);
    if (!(escala > 0)) continue;
    if (Math.abs((actual - med) / escala) < 3) continue;
    if (Math.abs(actual - med) < PISO_MATERIAL * 2) continue;
    agregar('categoria_desviada', {
      categoria, direccion: actual > med ? 'arriba' : 'abajo',
      semanaARS: redondear(actual), habitualSemanalARS: redondear(med),
      diferenciaARS: redondear(actual - med),
    });
  }

  // ── E. Filas a las que les falta algo, en UNA sola señal ─────────────────
  //
  // La carga incompleta es una tarea de dos minutos, no un análisis: siete
  // hallazgos separados por siete filas sin categoría empujaban fuera del
  // informe todo lo que sí requería pensar. Va una sola señal con el detalle
  // adentro, y sólo por filas materiales — que a una fila de $3.000 le falte la
  // categoría no justifica ocupar un renglón del informe.
  //
  // Los costos mensuales quedan afuera: avisar un día 16 que "falta cargar el
  // sueldo" es informar sobre un pago que todavía no ocurrió.
  const incompletas = [];
  for (const m of operativos.filter(f => enVentana(f) && !esCadenciaMensual(f))) {
    const monto = m.salidaTotal || m.entradaTotal || 0;
    if (monto < PISO_MATERIAL) continue;
    const faltan = [];
    if (!(m.categoria || '').trim()) faltan.push('categoría');
    if (m.tipo === 'Gasto' && !(m.proveedor || '').trim()) faltan.push('proveedor');
    // El medio de pago sólo se exige si YA se pagó: una compra en "A Pagar" no
    // salió de ninguna caja todavía. Sin esta condición, cada factura pendiente
    // era un hallazgo repetido.
    if (norm(m.estado) === 'pagado' && !(m.medioPago || '').trim()) faltan.push('medio de pago');
    if (!faltan.length) continue;
    incompletas.push({
      fila: m.rowIndex, fecha: diaISO(m.fecha), tipoMovimiento: m.tipo,
      proveedor: m.proveedor, descripcion: m.descripcion,
      montoARS: redondear(monto), leFalta: faltan,
    });
  }
  if (incompletas.length) {
    agregar('carga_incompleta', {
      filas: incompletas.length,
      montoInvolucradoARS: redondear(incompletas.reduce((s, f) => s + f.montoARS, 0)),
      detalle: incompletas,
    });
  }

  // ── Contexto del mes ─────────────────────────────────────────────────────
  // Los totales del mes se agrupan por la COLUMNA MES, igual que el Dashboard,
  // no por la fecha. `Fecha` dice cuándo se movió la plata y `Mes` a qué mes
  // pertenece el gasto: en cuotas y pagos diferidos son distintos a propósito.
  // Si el informe agrupara por fecha diría un resultado y la pantalla otro, que
  // es exactamente lo que esta app evita en todos lados.
  const anioActual = corte.getFullYear(), diaDelMes = corte.getDate();
  const nombreMes = mesPlanillaDe(corte);
  const mesPrevio = new Date(anioActual, corte.getMonth() - 1, 1);
  const nombreMesPrevio = mesPlanillaDe(mesPrevio);

  const delMes = m => m.mes === nombreMes;
  const gastoMes = gastosTodos.filter(delMes).reduce((s, g) => s + g.salidaTotal, 0);
  const ingresoMes = ingresos.filter(delMes).reduce((s, m) => s + m.entradaTotal, 0);

  // Mismo corte del mes anterior: comparar un mes a medio andar contra uno
  // completo daría siempre "vamos peor", que es ruido garantizado. El recorte
  // por día usa la fecha, así que en las filas donde Mes y Fecha difieren esto
  // es aproximado — sirve para ver el ritmo, no para cerrar el mes.
  const hastaElMismoDia = m => m.mes === nombreMesPrevio && m.fecha.getDate() <= diaDelMes;

  const porGrupo = {};
  for (const g of gastosTodos.filter(delMes)) {
    const k = g.superGrupo || 'Otros';
    porGrupo[k] = redondear((porGrupo[k] || 0) + g.salidaTotal);
  }

  const gastoSemanaVariable = gastos.filter(enVentana).reduce((s, g) => s + g.salidaTotal, 0);
  const gastoSemanaMensuales = gastosTodos.filter(g => enVentana(g) && esCadenciaMensual(g))
    .reduce((s, g) => s + g.salidaTotal, 0);
  const topSemana = [...gastos.filter(enVentana)]
    .sort((a, b) => b.salidaTotal - a.salidaTotal).slice(0, 8)
    .map(g => ({ fila: g.rowIndex, fecha: diaISO(g.fecha), proveedor: g.proveedor,
                 categoria: g.categoria, montoARS: redondear(g.salidaTotal) }));

  // Concentración: qué parte del gasto variable de la semana se fue en un solo
  // proveedor. Un número chico que dice bastante sobre el poder de negociación.
  const concentracion = (() => {
    const m = new Map();
    for (const g of gastos.filter(enVentana)) m.set(g.proveedor || 'Sin proveedor', (m.get(g.proveedor || 'Sin proveedor') || 0) + g.salidaTotal);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([proveedor, monto]) => ({
        proveedor, montoARS: redondear(monto),
        pctDelGastoVariable: gastoSemanaVariable > 0 ? pct1((monto / gastoSemanaVariable) * 100) : null,
      }));
  })();

  return {
    corte: diaISO(corte),
    contexto: {
      semana: {
        desde: diaISO(desdeVentana), hasta: diaISO(corte),
        gastoVariableARS: redondear(gastoSemanaVariable),
        gastoDeCadenciaMensualARS: redondear(gastoSemanaMensuales),
        gastosARS: redondear(gastoSemanaVariable + gastoSemanaMensuales),
        ingresosARS: redondear(ingresos.filter(enVentana).reduce((s, m) => s + m.entradaTotal, 0)),
        nota: 'El análisis semanal mira sólo el gasto variable. Sueldos, alquiler, servicios e '
          + 'impuestos se pagan una vez por mes y se juzgan en el balance mensual, no acá.',
      },
      mes: { nombre: nombreMes, ingresosARS: redondear(ingresoMes), gastosARS: redondear(gastoMes),
             resultadoARS: redondear(ingresoMes - gastoMes), diaDelMes,
             nota: 'Agrupado por la columna Mes de la planilla, igual que el Dashboard.' },
      mesAnteriorAlMismoDia: {
        ingresosARS: redondear(ingresos.filter(hastaElMismoDia).reduce((s, m) => s + m.entradaTotal, 0)),
        gastosARS: redondear(gastosTodos.filter(hastaElMismoDia).reduce((s, g) => s + g.salidaTotal, 0)),
      },
      gastoDelMesPorGrupo: porGrupo,
      mayoresGastosDeLaSemana: topSemana,
      mayoresProveedoresDeLaSemana: concentracion,
      filasAnalizadas: operativos.length,
    },
    senales,
  };
}

// ─── El precio, que es la otra mitad de la historia ─────────────────────────
//
// La hoja Movimientos dice cuánto se pagó; la hoja Compras dice cuánto se pagó
// POR UNIDAD. Son preguntas distintas y la segunda es la que se puede accionar:
// "la carne salió $180.000" no se negocia, "el kilo pasó de $9.800 a $11.400" sí.
//
// El precio unitario se recalcula desde el total de la línea (que ya incluye
// descuento, IVA y otros impuestos) dividido por la cantidad NORMALIZADA a
// unidad base — el mismo factor que usa src/unidades.js para que una caja x6 y
// una botella suelta sean comparables. Usar la columna "Precio Unit." tal cual
// mezclaría filas con IVA incluido y sin incluir.
function precioUnitario(c) {
  const cantidad = Number(c.cantidad);
  if (!(cantidad > 0)) return null;
  const total = [c.totalFinal, c.totalConIva, c.total, c.subtotal]
    .find(x => typeof x === 'number' && x > 0);
  if (total) return total / cantidad;
  return typeof c.precioUnit === 'number' && c.precioUnit > 0 ? c.precioUnit : null;
}

const ES_NO = v => /^(n|no)$/i.test((v || '').toString().trim());

function analizarCompras(compras, { hasta } = {}) {
  const corte = hasta ? new Date(hasta) : new Date();
  const hastaISO = diaISO(corte);
  const desdeVentanaISO = diaISO(new Date(corte.getTime() - DIAS_VENTANA * 86400000));
  const desdeRefISO = diaISO(new Date(corte.getTime() - (SEMANAS_REFERENCIA + 1) * 7 * 86400000));

  const filas = (compras || [])
    .filter(c => c && c.fecha && c.fecha <= hastaISO && c.fecha > desdeRefISO && (c.producto || '').trim())
    .map(c => ({ ...c, _precio: precioUnitario(c) }))
    .filter(c => c._precio > 0);

  const senales = [];
  const agregar = (tipo, s) => senales.push({ tipo, ...s });

  const enSemana = c => c.fecha > desdeVentanaISO;
  // Producto Y unidad: dos filas del mismo producto medidas en unidades
  // distintas (botella y litro) tienen precios que no se pueden comparar, y
  // mezclarlas inventaría un salto de precio que nadie pagó. Partir de más
  // equivale a callarse en las dudosas, que es el error correcto.
  const clave = c => `${norm(c.producto)}·${norm(c.unidad)}`;

  const porProducto = new Map();
  for (const c of filas) {
    const k = clave(c);
    if (!porProducto.has(k)) porProducto.set(k, []);
    porProducto.get(k).push(c);
  }

  // ── Precio unitario que se movió ─────────────────────────────────────────
  for (const [, lista] of porProducto) {
    const deLaSemana = lista.filter(enSemana);
    const previas = lista.filter(c => !enSemana(c));
    if (!deLaSemana.length || previas.length < 3) continue;

    const gastoSemana = deLaSemana.reduce((s, c) => s + (c._precio * (c.cantidad || 0)), 0);
    if (gastoSemana < PISO_MATERIAL) continue;

    const ahora = mediana(deLaSemana.map(c => c._precio));
    const antes = mediana(previas.map(c => c._precio));
    if (!(antes > 0)) continue;
    const varPct = ((ahora - antes) / antes) * 100;
    if (Math.abs(varPct) < UMBRAL_PRECIO_PCT) continue;

    const provAhora = [...new Set(deLaSemana.map(c => c.proveedor).filter(Boolean))];
    const provAntes = [...new Set(previas.map(c => c.proveedor).filter(Boolean))];
    agregar('precio_unitario_movido', {
      producto: deLaSemana[0].producto, categoria: deLaSemana[0].categoria,
      unidad: deLaSemana[0].unidad || null,
      direccion: varPct > 0 ? 'arriba' : 'abajo',
      precioAhoraARS: redondear(ahora), precioHabitualARS: redondear(antes),
      variacionPct: pct1(varPct),
      comprasComparadas: previas.length,
      proveedorAhora: provAhora, proveedorHabitual: provAntes,
      cambioDeProveedor: provAhora.length > 0 && provAhora.every(p => !provAntes.some(q => norm(p) === norm(q))),
      gastoDeLaSemanaARS: redondear(gastoSemana),
      // Lo que cuesta al ritmo actual de compra, para que la diferencia se lea
      // en plata y no sólo en porcentaje.
      impactoSemanalARS: redondear((ahora - antes) * deLaSemana.reduce((s, c) => s + (c.cantidad || 0), 0)),
    });
  }

  // ── El mismo producto, dos proveedores, dos precios ──────────────────────
  // Sólo cuando los dos siguen vigentes (los dos compraron en las últimas
  // semanas): comparar contra un proveedor al que ya no se le compra es
  // arqueología.
  for (const [, lista] of porProducto) {
    const porProv = new Map();
    for (const c of lista) {
      const k = norm(c.proveedor);
      if (!k) continue;
      if (!porProv.has(k)) porProv.set(k, []);
      porProv.get(k).push(c);
    }
    if (porProv.size < 2) continue;
    const resumen = [...porProv.values()]
      .filter(cs => cs.length >= 2)
      .map(cs => ({
        proveedor: cs[0].proveedor,
        precioARS: mediana(cs.map(c => c._precio)),
        compras: cs.length,
        ultimaFecha: cs.map(c => c.fecha).sort().pop(),
        unidades: cs.reduce((s, c) => s + (c.cantidad || 0), 0),
      }))
      .sort((a, b) => a.precioARS - b.precioARS);
    if (resumen.length < 2) continue;

    const barato = resumen[0], caro = resumen[resumen.length - 1];
    const brecha = ((caro.precioARS - barato.precioARS) / barato.precioARS) * 100;
    if (brecha < UMBRAL_BRECHA_PROVEEDOR_PCT) continue;
    // Los dos tienen que estar vigentes: si al más barato no se le compra hace
    // un mes, puede haber una razón que el precio no cuenta.
    const vigente = f => f > diaISO(new Date(corte.getTime() - 35 * 86400000));
    if (!vigente(barato.ultimaFecha) || !vigente(caro.ultimaFecha)) continue;
    const ahorro = (caro.precioARS - barato.precioARS) * caro.unidades;
    if (ahorro < PISO_MATERIAL) continue;

    agregar('brecha_entre_proveedores', {
      producto: lista[0].producto, categoria: lista[0].categoria, unidad: lista[0].unidad || null,
      masBarato: { proveedor: barato.proveedor, precioARS: redondear(barato.precioARS), compras: barato.compras },
      masCaro: { proveedor: caro.proveedor, precioARS: redondear(caro.precioARS), compras: caro.compras },
      brechaPct: pct1(brecha),
      ahorroEnLoCompradoARS: redondear(ahorro),
      periodo: `${desdeRefISO} a ${hastaISO}`,
    });
  }

  // ── Entregas con problema ────────────────────────────────────────────────
  // La columna "Entrega OK?" se carga en Sí por defecto, así que un "No" es
  // alguien marcándolo a mano: cuando aparece, importa. Si no aparece ninguno,
  // no se emite nada — que es lo normal y no hace falta decirlo.
  const conProblema = filas.filter(c => enSemana(c) && ES_NO(c.entregaOk));
  if (conProblema.length) {
    const porProv = new Map();
    for (const c of conProblema) {
      const k = c.proveedor || 'Sin proveedor';
      const v = porProv.get(k) || { proveedor: k, casos: 0, productos: [] };
      v.casos++; if (v.productos.length < 5) v.productos.push(c.producto);
      porProv.set(k, v);
    }
    agregar('entregas_con_problema', {
      casos: conProblema.length,
      proveedores: [...porProv.values()].sort((a, b) => b.casos - a.casos),
    });
  }

  // ── Contexto: la foto de precios, esté o no movida ───────────────────────
  const movimientoPrecios = [];
  for (const [, lista] of porProducto) {
    const deLaSemana = lista.filter(enSemana);
    const previas = lista.filter(c => !enSemana(c));
    if (!deLaSemana.length || previas.length < 2) continue;
    const ahora = mediana(deLaSemana.map(c => c._precio));
    const antes = mediana(previas.map(c => c._precio));
    if (!(antes > 0)) continue;
    const gasto = deLaSemana.reduce((s, c) => s + c._precio * (c.cantidad || 0), 0);
    if (gasto < PISO_MATERIAL / 2) continue;
    movimientoPrecios.push({
      producto: deLaSemana[0].producto,
      // Todos los proveedores de la semana, no el de la primera fila: el precio
      // es la mediana de lo que se pagó, y atribuírselo a uno solo cuando
      // compraron dos sería una afirmación falsa sobre quién cobra qué.
      proveedores: [...new Set(deLaSemana.map(c => c.proveedor).filter(Boolean))],
      precioAhoraARS: redondear(ahora), precioHabitualARS: redondear(antes),
      variacionPct: pct1(((ahora - antes) / antes) * 100),
      gastoDeLaSemanaARS: redondear(gasto),
    });
  }
  movimientoPrecios.sort((a, b) => Math.abs(b.variacionPct) - Math.abs(a.variacionPct));

  return {
    senales,
    contexto: {
      periodo: `${desdeRefISO} a ${hastaISO}`,
      comprasDeLaSemana: filas.filter(enSemana).length,
      productosDistintosDeLaSemana: new Set(filas.filter(enSemana).map(clave)).size,
      preciosQueMasSeMovieron: movimientoPrecios.slice(0, 12),
      nota: 'Precio por unidad base (una caja x6 ya viene dividida en 6), calculado desde el total '
        + 'de la línea con descuento e impuestos incluidos. Sale de la hoja Compras, que sólo tiene '
        + 'lo que pasó por el bot de facturas: no cubre todas las compras del bar.',
    },
  };
}

const SISTEMA = `Este informe es SEMANAL y mira la PLATA: la hoja de movimientos y la hoja de compras del bar.

Te llegan señales de estos tipos, ya calculadas:
- precio_unitario_movido: lo que se paga por unidad de un producto se despegó de lo habitual.
- brecha_entre_proveedores: el mismo producto, dos proveedores vigentes y dos precios distintos.
- cambio_de_proveedor: se dejó de comprarle a alguien, y esto es lo que pasó DESPUÉS con el costo y con la frecuencia de entrega de esa categoría.
- monto_atipico: una factura muy fuera de lo que ese proveedor suele cobrar.
- duplicado_probable: dos filas casi idénticas y muy juntas para ese proveedor.
- categoria_desviada: una categoría de gasto variable despegada de su propia serie semanal.
- entregas_con_problema: entregas marcadas como no conformes.
- carga_incompleta: viene UNA sola señal con todas las filas a las que les falta un dato.

Cómo leerlas:
- El precio por unidad es lo más accionable que tenés: se puede negociar, se puede cambiar de proveedor, se puede cambiar la receta. Cuando lo tengas, decí también cuánta plata representa al ritmo de compra actual, que ya viene calculada.
- Con ~1,9% de inflación mensual, que un precio suba es lo normal. Los umbrales ya están puestos muy por encima de esa deriva: lo que te llega ya se despegó de la inflación. No lo expliques por inflación.
- Un cambio de proveedor se juzga por el resultado, no por el cambio: si el costo por semana bajó y las entregas siguen iguales, salió bien y hay que decirlo. Si bajó el costo pero se entrega la mitad de seguido, es otra conversación.
- carga_incompleta es una tarea, no un análisis: una línea, sin dramatismo, y seguí con lo que importa.

NO analices sueldos, cargas sociales, alquiler, servicios ni impuestos. Son costos MENSUALES: en una semana suelta o aparecen enteros o no aparecen, y las dos cosas son artefactos del calendario, no información. No digas que "faltan cargar" — se pagan una vez por mes y se analizan en el balance mensual, que los mira concepto por concepto. Si ves esos importes en los totales, es porque la plata efectivamente salió esa semana; están ahí para que los totales cierren, no para opinar sobre ellos.

TAMPOCO informes que un proveedor dejó de aparecer, a secas. El dueño sabe a quién le compra: enterarse de eso no le agrega nada. Lo que vale es el impacto, y eso ya viene medido en cambio_de_proveedor.

PUEDE NO HABER NADA que valga la pena, y en ese caso devolvé la lista de hallazgos vacía. Es una respuesta correcta y esperada, no un fracaso. No infles el informe para tener algo que mostrar.

Dejá el campo "resumen" como string vacío: es sólo para el balance mensual.

Terminá con una sola frase: lo más importante que sugieren estos datos que habría que hacer.`;

// El período es la semana que cierra en el corte. Es la clave de idempotencia:
// dos corridas del mismo domingo no generan dos informes.
const periodoDe = (corte) => {
  const desde = new Date(corte.getTime() - DIAS_VENTANA * 86400000);
  return `semana ${diaISO(desde)} a ${diaISO(corte)}`;
};

async function analizar({ hasta, notas } = {}) {
  const { getMovimientos } = require('./sheets');
  const { escalonesDe } = require('./informes-notas');
  const a = analizarMovimientos(await getMovimientos(), { hasta, escalones: escalonesDe(notas) });

  // La hoja Compras vive en otra planilla y sólo tiene lo que pasó por el bot de
  // facturas. Si no se puede leer, el informe sale sin el análisis de precios en
  // vez de no salir: es media historia, no la historia.
  let compras = { senales: [], contexto: null };
  try {
    const { getCompras } = require('./proveedores');
    compras = analizarCompras(await getCompras(), { hasta: hasta ? new Date(hasta) : new Date() });
  } catch (e) {
    console.error(`Informes: no se pudo analizar la hoja Compras (${e.message}) — el informe sale sin precios`);
  }

  const senales = [...compras.senales, ...a.senales];
  const payload = [
    `Semana analizada: ${a.contexto.semana.desde} a ${a.contexto.semana.hasta}`, '',
    'CONTEXTO:', JSON.stringify(a.contexto, null, 1), '',
    ...(compras.contexto ? ['PRECIOS DE COMPRA:', JSON.stringify(compras.contexto, null, 1), ''] : []),
    `SEÑALES DETECTADAS (${senales.length}):`,
    senales.length ? JSON.stringify(senales, null, 1) : '(ninguna)',
  ].join('\n');
  return { payload, senales: senales.length, analisis: { ...a, compras } };
}

module.exports = {
  TIPO, TITULO, SISTEMA, analizar, periodoDe,
  analizarMovimientos, analizarCompras, precioUnitario,
  esCadenciaMensual, SUPERGRUPOS_MENSUALES, PISO_MATERIAL,
};
