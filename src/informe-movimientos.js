// ─── Analista: la plata (hoja Movimientos), semanal ─────────────────────────
//
// Corre los domingos y mira los últimos 7 días del libro. Detecta lo que no se
// ve mirando totales: una factura fuera de escala, un proveedor que dejó de
// venir, una carga repetida, una categoría que se despegó de su propia serie.
//
// Todo lo de este archivo es puro: entra la lista de movimientos, sale un
// objeto con contexto y señales. Se puede correr con datos inventados y
// verificar cada número a mano.

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

function analizarMovimientos(movimientos, { hasta, escalones } = {}) {
  const corte = hasta ? new Date(hasta) : new Date();
  corte.setHours(23, 59, 59, 999);

  // Misma regla que el resto de la app: los cambios entre cajas y los fondeos
  // no son resultado, y las filas de cuota no se suman porque la fila madre ya
  // lleva el total de la compra.
  const operativos = movimientos.filter(m => m.fecha && !m.esCambio && !m.esFondeo && !m.esCuota && m.fecha <= corte);
  const gastos = operativos.filter(m => m.tipo === 'Gasto' && (m.salidaTotal || 0) > 0);
  const ingresos = operativos.filter(m => m.tipo === 'Ingreso' && (m.entradaTotal || 0) > 0);

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
    // en el nivel nuevo y la mediana se mueva sola — medio año en un cargo
    // mensual. Ver src/informes-notas.js.
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

  // ── B. Proveedor habitual que dejó de aparecer ───────────────────────────
  const desde120 = new Date(corte.getTime() - 120 * 86400000);
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
    // Pasados dos meses ya no es un hallazgo, es historia: sin este techo el
    // informe arrastra los mismos proveedores todas las semanas.
    if (silencio > 60) continue;
    agregar('proveedor_ausente', {
      proveedor: ultima.proveedor, categoria: ultima.categoria,
      diasSinAparecer: silencio, cadaCuantosDiasSolia: Math.round(huecoTipico),
      ultimaFecha: diaISO(ultima.fecha), ultimoMontoARS: redondear(ultima.salidaTotal),
    });
  }

  // ── C. Duplicado probable ────────────────────────────────────────────────
  // Se compara contra la cadencia propia del proveedor: Acequia trae pan cada
  // 7 días por $90.000 siempre. Dos filas iguales a 7 días ahí no son un
  // duplicado, son el pedido semanal.
  const cadencia = new Map();
  for (const [k, filas] of porProveedor) {
    const orden = [...filas].sort((a, b) => a.fecha - b.fecha);
    const huecos = [];
    for (let i = 1; i < orden.length; i++) huecos.push(diasEntre(orden[i - 1].fecha, orden[i].fecha));
    if (huecos.length >= 3) cadencia.set(k, mediana(huecos));
  }
  const desde30 = new Date(corte.getTime() - 30 * 86400000);
  const cand = gastos.filter(g => g.fecha > desde30 && g.salidaTotal >= PISO_MATERIAL);
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

  // ── E. Filas a las que les falta algo ────────────────────────────────────
  for (const m of operativos.filter(enVentana)) {
    const faltan = [];
    if (!(m.categoria || '').trim()) faltan.push('categoría');
    if (m.tipo === 'Gasto' && !(m.proveedor || '').trim()) faltan.push('proveedor');
    // El medio de pago sólo se exige si YA se pagó: una compra en "A Pagar" no
    // salió de ninguna caja todavía. Sin esta condición, cada factura pendiente
    // era un hallazgo repetido.
    if (norm(m.estado) === 'pagado' && !(m.medioPago || '').trim()) faltan.push('medio de pago');
    if (!faltan.length) continue;
    agregar('fila_incompleta', {
      fila: m.rowIndex, fecha: diaISO(m.fecha), tipoMovimiento: m.tipo,
      proveedor: m.proveedor, descripcion: m.descripcion,
      montoARS: redondear(m.salidaTotal || m.entradaTotal || 0), leFalta: faltan,
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
  const gastoMes = gastos.filter(delMes).reduce((s, g) => s + g.salidaTotal, 0);
  const ingresoMes = ingresos.filter(delMes).reduce((s, m) => s + m.entradaTotal, 0);

  // Mismo corte del mes anterior: comparar un mes a medio andar contra uno
  // completo daría siempre "vamos peor", que es ruido garantizado. El recorte
  // por día usa la fecha, así que en las filas donde Mes y Fecha difieren esto
  // es aproximado — sirve para ver el ritmo, no para cerrar el mes.
  const hastaElMismoDia = m => m.mes === nombreMesPrevio && m.fecha.getDate() <= diaDelMes;

  const porGrupo = {};
  for (const g of gastos.filter(delMes)) {
    const k = g.superGrupo || 'Otros';
    porGrupo[k] = redondear((porGrupo[k] || 0) + g.salidaTotal);
  }

  const gastoSemana = gastos.filter(enVentana).reduce((s, g) => s + g.salidaTotal, 0);
  const topSemana = [...gastos.filter(enVentana)]
    .sort((a, b) => b.salidaTotal - a.salidaTotal).slice(0, 8)
    .map(g => ({ fila: g.rowIndex, fecha: diaISO(g.fecha), proveedor: g.proveedor,
                 categoria: g.categoria, montoARS: redondear(g.salidaTotal) }));

  return {
    corte: diaISO(corte),
    contexto: {
      semana: { desde: diaISO(desdeVentana), hasta: diaISO(corte), gastosARS: redondear(gastoSemana),
                ingresosARS: redondear(ingresos.filter(enVentana).reduce((s, m) => s + m.entradaTotal, 0)) },
      mes: { nombre: nombreMes, ingresosARS: redondear(ingresoMes), gastosARS: redondear(gastoMes),
             resultadoARS: redondear(ingresoMes - gastoMes), diaDelMes,
             nota: 'Agrupado por la columna Mes de la planilla, igual que el Dashboard.' },
      mesAnteriorAlMismoDia: {
        ingresosARS: redondear(ingresos.filter(hastaElMismoDia).reduce((s, m) => s + m.entradaTotal, 0)),
        gastosARS: redondear(gastos.filter(hastaElMismoDia).reduce((s, g) => s + g.salidaTotal, 0)),
      },
      gastoDelMesPorGrupo: porGrupo,
      mayoresGastosDeLaSemana: topSemana,
      filasAnalizadas: operativos.length,
    },
    senales,
  };
}

const SISTEMA = `Este informe es SEMANAL y mira la PLATA: la hoja de movimientos del bar.

Te llegan señales de estos tipos, ya calculadas:
- monto_atipico: una factura muy fuera de lo que ese proveedor suele cobrar.
- proveedor_ausente: un proveedor con cadencia regular que dejó de aparecer.
- duplicado_probable: dos filas casi idénticas y muy juntas para ese proveedor.
- categoria_desviada: una categoría de gasto despegada de su propia serie semanal.
- fila_incompleta: filas cargadas a las que les falta un dato.

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
  const payload = [
    `Semana analizada: ${a.contexto.semana.desde} a ${a.contexto.semana.hasta}`, '',
    'CONTEXTO:', JSON.stringify(a.contexto, null, 1), '',
    `SEÑALES DETECTADAS (${a.senales.length}):`,
    a.senales.length ? JSON.stringify(a.senales, null, 1) : '(ninguna)',
  ].join('\n');
  return { payload, senales: a.senales.length, analisis: a };
}

module.exports = { TIPO, TITULO, SISTEMA, analizar, periodoDe, analizarMovimientos, PISO_MATERIAL };
