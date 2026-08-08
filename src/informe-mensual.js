// ─── Analista: balance ejecutivo del mes, mensual ───────────────────────────
//
// Corre el día 1 y mira el mes que acaba de cerrar. A diferencia de los dos
// semanales, este NO busca anomalías: busca el estado del negocio. Cruza las
// dos fuentes —la plata del libro y el salón de Fudo— porque las preguntas que
// importan a fin de mes están entre las dos: cuánto entró por cubierto, cuánto
// costó la mercadería contra lo que se vendió, si el resultado mejoró porque
// vino más gente o porque se gastó menos.
//
// Deliberadamente NO calcula CMV contable ni margen por producto: eso vive en
// la sección Costos, que cruza compras contra recetas. Acá el costo de
// mercadería es el gasto del mes en esas categorías sobre el ingreso del mes,
// que es una aproximación de gestión — y como tal se le pasa al modelo, para
// que no la presente como si fuera un margen real.

const {
  mediana, norm, diaISO, mesISO, redondear, MESES, DIAS_SEMANA, mesPlanillaDe,
} = require('./informes-util');

const TIPO = 'mensual';
const TITULO = 'Balance del mes';

// Categorías que se leen como costo de mercadería para el ratio de gestión.
const CATEGORIAS_MERCADERIA = ['mercaderia', 'mercadería', 'bebidas', 'bebida', 'insumos'];

function analizarMes(movimientos, dias, { mes } = {}) {
  // `mes` es el primer día del mes analizado.
  const inicio = new Date(mes.getFullYear(), mes.getMonth(), 1);
  const fin = new Date(mes.getFullYear(), mes.getMonth() + 1, 0, 23, 59, 59, 999);
  const inicioPrev = new Date(mes.getFullYear(), mes.getMonth() - 1, 1);
  const finPrev = new Date(mes.getFullYear(), mes.getMonth(), 0, 23, 59, 59, 999);

  const operativos = (movimientos || []).filter(m => m.fecha && !m.esCambio && !m.esFondeo && !m.esCuota);

  // Se agrupa por la COLUMNA MES, igual que el Dashboard y que todo el resto de
  // la app — no por la fecha. `Fecha` dice cuándo se movió la plata y `Mes` a
  // qué mes pertenece el gasto; en cuotas y pagos diferidos son distintos a
  // propósito. Agrupar por fecha daba otro resultado que el que ve el usuario
  // en pantalla: julio cerró en $12.826.657 y por fecha daba $9.596.477.
  const delMesPlanilla = (m, ref) => m.mes === mesPlanillaDe(ref);

  const resumenPlata = (ref) => {
    const dentro = operativos.filter(m => delMesPlanilla(m, ref));
    const gastos = dentro.filter(m => m.tipo === 'Gasto' && (m.salidaTotal || 0) > 0);
    const ingresos = dentro.filter(m => m.tipo === 'Ingreso' && (m.entradaTotal || 0) > 0);
    const totalIng = ingresos.reduce((s, m) => s + m.entradaTotal, 0);
    const totalGas = gastos.reduce((s, m) => s + m.salidaTotal, 0);
    const porGrupo = {};
    for (const g of gastos) {
      const k = g.superGrupo || 'Otros';
      porGrupo[k] = redondear((porGrupo[k] || 0) + g.salidaTotal);
    }
    const mercaderia = gastos
      .filter(g => CATEGORIAS_MERCADERIA.includes(norm(g.categoria)))
      .reduce((s, g) => s + g.salidaTotal, 0);
    return {
      ingresosARS: redondear(totalIng), gastosARS: redondear(totalGas),
      resultadoARS: redondear(totalIng - totalGas),
      margenPct: totalIng > 0 ? Number((((totalIng - totalGas) / totalIng) * 100).toFixed(1)) : null,
      gastoPorGrupo: porGrupo,
      mercaderiaARS: redondear(mercaderia),
      mercaderiaSobreIngresosPct: totalIng > 0 ? Number(((mercaderia / totalIng) * 100).toFixed(1)) : null,
      mayoresProveedores: (() => {
        const m = new Map();
        for (const g of gastos) m.set(g.proveedor || 'Sin proveedor', (m.get(g.proveedor || 'Sin proveedor') || 0) + g.salidaTotal);
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([proveedor, monto]) => ({ proveedor, montoARS: redondear(monto),
            pctDelGasto: totalGas > 0 ? Number(((monto / totalGas) * 100).toFixed(1)) : null }));
      })(),
    };
  };

  const fechaDe = d => { const [y, m, x] = (d.fecha || '').split('-').map(Number); return new Date(y, m - 1, x); };
  const validos = (dias || []).filter(d => d && d.fecha && d.encontrado !== false && (d.pax > 0 || d.total > 0))
    .map(d => ({ ...d, _f: fechaDe(d) }));

  const resumenSalon = (a, b) => {
    const dentro = validos.filter(d => d._f >= a && d._f <= b);
    const sum = f => dentro.reduce((s, d) => s + (d[f] || 0), 0);
    const pax = sum('pax'), total = sum('total');
    const porDiaSemana = {};
    for (const d of dentro) {
      const k = DIAS_SEMANA[d._f.getDay()];
      if (!porDiaSemana[k]) porDiaSemana[k] = { dias: 0, pax: 0, ingresosARS: 0 };
      porDiaSemana[k].dias++; porDiaSemana[k].pax += d.pax || 0;
      porDiaSemana[k].ingresosARS = redondear(porDiaSemana[k].ingresosARS + (d.total || 0));
    }
    for (const k of Object.keys(porDiaSemana)) {
      const v = porDiaSemana[k];
      v.paxPromedio = Math.round(v.pax / v.dias);
      v.ingresoPromedioARS = redondear(v.ingresosARS / v.dias);
    }
    const cats = new Map();
    for (const d of dentro) for (const c of (d.categorias || [])) {
      const k = c.categoria || 'Sin categoría';
      const v = cats.get(k) || { categoria: k, grupo: c.grupo, monto: 0, unidades: 0 };
      v.monto += c.monto || 0; v.unidades += c.unidades || 0;
      cats.set(k, v);
    }
    const ordenados = [...dentro].sort((x, y) => (y.total || 0) - (x.total || 0));
    return {
      diasAbiertos: dentro.length, pax, ventas: sum('ventas'),
      ingresosARS: redondear(total),
      ticketPromedioARS: pax > 0 ? redondear(total / pax) : 0,
      paxPromedioPorDia: dentro.length ? Math.round(pax / dentro.length) : 0,
      comidaARS: redondear(sum('comida')), bebidaARS: redondear(sum('bebida')),
      pctBebida: sum('comida') + sum('bebida') > 0
        ? Number(((sum('bebida') / (sum('comida') + sum('bebida'))) * 100).toFixed(1)) : null,
      medianaIngresoDiarioARS: redondear(mediana(dentro.map(d => d.total || 0))),
      mejorNoche: ordenados[0] ? { fecha: ordenados[0].fecha, diaSemana: DIAS_SEMANA[ordenados[0]._f.getDay()],
        pax: ordenados[0].pax, ingresosARS: redondear(ordenados[0].total) } : null,
      peorNoche: ordenados.length ? (() => { const p = ordenados[ordenados.length - 1];
        return { fecha: p.fecha, diaSemana: DIAS_SEMANA[p._f.getDay()], pax: p.pax, ingresosARS: redondear(p.total) }; })() : null,
      porDiaSemana,
      categorias: [...cats.values()].sort((a, b) => b.monto - a.monto).slice(0, 14)
        .map(c => ({ categoria: c.categoria, grupo: c.grupo, unidades: Math.round(c.unidades), montoARS: redondear(c.monto) })),
    };
  };

  const plata = resumenPlata(inicio);
  const plataPrev = resumenPlata(inicioPrev);
  const salon = resumenSalon(inicio, fin);
  const salonPrev = resumenSalon(inicioPrev, finPrev);

  // El puente entre las dos fuentes. No coinciden por construcción: Fudo dice
  // lo que se vendió, el libro dice qué plata entró (hay cobros diferidos,
  // ajustes de caja y diferencias de medio de pago). Se pasa la brecha con el
  // aviso puesto para que el modelo no la lea como un error.
  const puente = {
    ingresoLibroARS: plata.ingresosARS,
    ingresoFudoARS: salon.ingresosARS,
    diferenciaARS: redondear(plata.ingresosARS - salon.ingresosARS),
    nota: 'Las dos cifras responden preguntas distintas y nunca coinciden exactamente: Fudo dice qué se vendió, el libro dice qué plata entró. Una diferencia chica es normal.',
    gastoMercaderiaSobreVentaFudoPct: salon.ingresosARS > 0
      ? Number(((plata.mercaderiaARS / salon.ingresosARS) * 100).toFixed(1)) : null,
    ingresoPorCubiertoLibroARS: salon.pax > 0 ? redondear(plata.ingresosARS / salon.pax) : null,
  };

  return {
    mes: mesISO(inicio),
    mesNombre: `${MESES[inicio.getMonth()]} ${inicio.getFullYear()}`,
    plata, salon,
    mesAnterior: { plata: plataPrev, salon: salonPrev, mesNombre: `${MESES[inicioPrev.getMonth()]} ${inicioPrev.getFullYear()}` },
    puente,
  };
}

const SISTEMA = `Este informe es MENSUAL y es un BALANCE EJECUTIVO del mes que cerró. No es una lista de anomalías: los dos informes semanales ya se ocupan de eso. Acá el trabajo es distinto — decir cómo le fue al negocio y por qué.

Te llegan dos fuentes cruzadas del mes cerrado y del mes anterior:
- PLATA (libro de movimientos): ingresos, gastos por grupo, resultado, margen, mayores proveedores.
- SALÓN (Fudo): cubiertos, ingresos, ticket promedio, mix comida/bebida, mejor y peor noche, comportamiento por día de semana, categorías vendidas.
- PUENTE: los cruces entre las dos.

Qué tiene que responder el balance, en este orden:
1. Cómo cerró el mes y si eso es mejor o peor que el anterior.
2. POR QUÉ cerró así. Esta es la parte que importa: separá si el resultado se movió por volumen (vino más o menos gente), por precio (cada cubierto gastó distinto), o por costo (se gastó distinto en insumos). No es lo mismo y la decisión que sigue es otra en cada caso.
3. Qué se sostiene y qué se está moviendo: día de semana que rinde, mix que cambia, concentración en proveedores.
4. Lo que hay que vigilar el mes que viene.

Usá el campo "resumen": dos o tres frases de panorama, lo que le contarías al socio en el primer minuto. Después cada bloque del balance va como un hallazgo, con "severidad" leída como importancia para el negocio (alta = mueve la aguja) y no como gravedad de un problema. Acá "hayHallazgos" es siempre verdadero: un balance mensual siempre tiene contenido, aunque el mes haya sido tranquilo.

Cuidados:
- El ratio de mercadería sobre ingresos es una aproximación de gestión, NO un CMV contable: no cruza compras contra recetas ni contra stock. Si lo mencionás, decilo así.
- El ingreso del libro y el de Fudo no coinciden por construcción. No lo presentes como un descuadre salvo que la diferencia sea grande.
- Con inflación de ~1,9% mensual, comparar pesos contra pesos del mes anterior exagera cualquier mejora. Cuando compares importes, decilo; los datos por cubierto y los porcentajes no tienen ese problema y son mejores para comparar.

Terminá con una sola frase: lo más importante que sugiere este balance que habría que hacer.`;

// El período es el mes analizado. Corriendo el día 1, el mes que cerró es el
// anterior; corriendo a mano en cualquier fecha, también — nunca se informa
// sobre un mes a medio andar.
function mesAnalizado(corte) {
  const d = new Date(corte);
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

const periodoDe = (corte) => mesISO(mesAnalizado(corte));

async function analizar({ hasta } = {}) {
  const { getMovimientos } = require('./sheets');
  const fudo = require('./fudo');
  const corte = hasta ? new Date(hasta) : new Date();
  const mes = mesAnalizado(corte);
  // Se piden dos meses: el analizado y el anterior, para poder comparar.
  const desde = new Date(mes.getFullYear(), mes.getMonth() - 1, 1);
  const fin = new Date(mes.getFullYear(), mes.getMonth() + 1, 0);

  const [movs, dias] = await Promise.all([
    getMovimientos(),
    fudo.getDetallesTodos({ desde: diaISO(desde), hasta: diaISO(fin) }),
  ]);

  const a = analizarMes(movs, dias, { mes });
  const payload = [
    `Balance ejecutivo de ${a.mesNombre} (mes cerrado). Se compara contra ${a.mesAnterior.mesNombre}.`, '',
    'PLATA DEL MES (libro):', JSON.stringify(a.plata, null, 1), '',
    'SALÓN DEL MES (Fudo):', JSON.stringify(a.salon, null, 1), '',
    'CRUCE ENTRE LAS DOS FUENTES:', JSON.stringify(a.puente, null, 1), '',
    `MES ANTERIOR (${a.mesAnterior.mesNombre}):`, JSON.stringify(a.mesAnterior, null, 1),
  ].join('\n');
  return { payload, senales: 0, analisis: a };
}

module.exports = { TIPO, TITULO, SISTEMA, analizar, periodoDe, analizarMes, mesAnalizado };
