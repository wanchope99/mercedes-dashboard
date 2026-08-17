// ─── Analista: el salón (Fudo), semanal ─────────────────────────────────────
//
// Corre los domingos y mira los servicios de la semana. La plata la mira el
// otro agente; este mira lo que pasó en el salón: cuánta gente vino, cómo vino
// (mesas chicas o grandes), qué se vendió y qué se dejó de vender.
//
// LA COMPARACIÓN ES POR DÍA DE SEMANA, siempre. En un bar un sábado no se
// compara con un martes: el mismo número de cubiertos es récord un martes y
// desastre un sábado. Cada día se mide contra los mismos días de las últimas
// 8 semanas. Comparar contra el promedio general sería ruido garantizado.
//
// QUÉ NO MIRA, Y POR QUÉ NO:
//
// · HORARIOS. Se sacaron el 16/8/2026. Dos razones y cada una alcanza: la
//   apertura que informa Fudo es el momento en que se abrió la PRIMERA mesa, no
//   cuando abrió el bar —una mesa cargada a las 15:30 para probar algo movía la
//   "apertura" tres horas—, y esos timestamps vienen en UTC mientras el resto
//   del análisis razona en hora argentina, así que la comparación arrastraba
//   husos mezclados. Y por encima de todo: a qué hora se abrió no le cambia una
//   decisión a nadie. Un hallazgo que no cambia una decisión es ruido, y el
//   ruido hace que la semana que sí hay algo tampoco se lea.
//
// · LOS DÍAS QUE NO FUERON SERVICIO NORMAL. Ver src/informes-excepciones.js.
//   No entran ni como día analizado ni como referencia.
//
// Todo lo de este archivo es puro salvo la lectura de Fudo.

const {
  mediana, escalaDe, norm, diaISO, redondear,
  DIAS_SEMANA, DIAS_VENTANA, SEMANAS_REFERENCIA,
} = require('./informes-util');
const { separarExcepciones, esDiaExcluido } = require('./informes-excepciones');

const TIPO = 'servicios';
const TITULO = 'El salón de la semana';

// ─── Control de facturación (12 ago 2026) ───────────────────────────────────
// Los medios que liquidan por Galicia: dejan rastro bancario y exigen comprobante.
// Mercado Pago y Efectivo quedan afuera por decisión del dueño — no son medios
// que se facturen habitualmente acá.
const MEDIOS_BANCARIZADOS = ['tarj. crédito', 'tarj. débito', 'qr'];
const esBancarizado = nombre => {
  const n = norm(nombre);
  if (n.includes('mercado')) return false;   // Mercado Pago va aparte, no entra
  return MEDIOS_BANCARIZADOS.some(m => n === m)
      || n.includes('crédito') || n.includes('credito')
      || n.includes('débito') || n.includes('debito')
      || n === 'qr' || n.startsWith('qr ');
};

const UMBRAL_DESVIO = 2.5;      // más bajo que en plata: acá la serie es más ruidosa
const MIN_REFERENCIA = 3;       // mínimo de días comparables para opinar
const PISO_PLATA = 150000;      // desvíos de ingreso menores no mueven la aguja
const PISO_UNIDADES = 8;

// Productos: un plato que pasó de 3 a 6 unidades duplicó y no significa nada.
// Para hablar de un producto hace falta que mueva volumen o plata de verdad.
const PISO_UNIDADES_PRODUCTO = 6;
const PISO_PLATA_PRODUCTO = 60000;
// Cuántos productos como máximo se marcan para cada lado. Sin tope, una semana
// distinta emite cuarenta señales de producto y entierra todo lo demás.
const MAX_PRODUCTOS_POR_LADO = 5;

// Un servicio termina de madrugada del día siguiente, así que el día en curso
// nunca está cerrado cuando el informe corre a la mañana: se analiza hasta ayer.
const corteEfectivo = d => new Date(new Date(d).getTime() - 86400000);

const pct1 = n => Number((n || 0).toFixed(1));
const variacionPct = (ahora, antes) => (antes > 0 ? pct1(((ahora - antes) / antes) * 100) : null);

// El detalle de Fudo guarda los productos de una categoría como array; algún
// snapshot viejo los guardó como objeto indexado por nombre. Se normalizan acá
// para no depender de cuál de las dos formas llegó.
//
// Esto arregla además un error que hacía inútil todo el análisis por producto:
// recorrer el array con Object.entries() devuelve "0", "1", "2"… como nombre, y
// los productos terminaban sumados por su POSICIÓN en la lista de cada día. El
// producto más vendido de la semana era la suma del primer producto de cada
// noche, que no es nada.
function productosDe(categoria) {
  const raw = (categoria && categoria.productos) || {};
  const lista = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([nombre, p]) => ({ ...(p || {}), nombre: (p && p.nombre) || nombre }));
  return lista.filter(p => p && (p.nombre || '').toString().trim());
}

function analizarServicios(dias, { hasta, mesas } = {}) {
  // El corte es el ÚLTIMO DÍA CON SERVICIO TERMINADO, no el día en que corre.
  // El agente sale los domingos a las 10 de la mañana: el servicio del domingo
  // todavía no pasó, y contarlo hacía dos cosas mal — bajaba el promedio de la
  // semana con un día en cero y marcaba "no abrió" un día que todavía no
  // empezó.
  const corte = corteEfectivo(hasta ? new Date(hasta) : new Date());
  corte.setHours(23, 59, 59, 999);
  const desdeVentana = new Date(corte.getTime() - DIAS_VENTANA * 86400000);
  const desdeRef = new Date(corte.getTime() - (SEMANAS_REFERENCIA + 1) * 7 * 86400000);

  // Los días que no fueron un servicio normal se sacan ANTES de cualquier
  // cuenta: si entraran, no sólo aparecerían como hallazgo sino que quedarían
  // dentro de la mediana contra la que se compara todo el resto.
  const { dias: comparables, excluidos } = separarExcepciones(dias);

  const fechaDe = d => { const [y, m, x] = (d.fecha || '').split('-').map(Number); return new Date(y, m - 1, x); };
  const validos = (comparables || []).filter(d => d && d.fecha && d.encontrado !== false && (d.pax > 0 || d.total > 0));
  const conFecha = validos.map(d => ({ ...d, _f: fechaDe(d) })).filter(d => d._f <= corte && d._f > desdeRef);

  const semana = conFecha.filter(d => d._f > desdeVentana).sort((a, b) => a._f - b._f);
  const previos = conFecha.filter(d => d._f <= desdeVentana);

  const senales = [];
  const agregar = (tipo, s) => senales.push({ tipo, ...s });

  // Referencia por día de semana: la clave de todo este analista.
  const refDia = new Map();   // 0..6 -> [dias]
  for (const d of previos) {
    const k = d._f.getDay();
    if (!refDia.has(k)) refDia.set(k, []);
    refDia.get(k).push(d);
  }

  const comparar = (dia, campo) => {
    const ref = (refDia.get(dia._f.getDay()) || []).map(d => d[campo] || 0).filter(x => x > 0);
    if (ref.length < MIN_REFERENCIA) return null;
    const med = mediana(ref);
    const escala = escalaDe(ref, med);
    if (!(escala > 0)) return null;
    return { med, desvio: (dia[campo] - med) / escala, muestras: ref.length };
  };

  // Cuántas semanas cubre la referencia. Va por el LAPSO de fechas, no por el
  // número de días abiertos: dividir días-previos por días-de-esta-semana daba
  // 12 en vez de 8 y subestimaba a la mitad todos los promedios semanales, con
  // lo cual cualquier categoría parecía haber subido.
  const semanasPrevias = (() => {
    if (!previos.length) return 1;
    const fechas = previos.map(d => d._f.getTime());
    return Math.max(1, Math.round(((Math.max(...fechas) - Math.min(...fechas)) / 86400000 + 1) / 7));
  })();

  // ── A. Noche muy por encima o por debajo de ese día de semana ────────────
  for (const d of semana) {
    const nombreDia = DIAS_SEMANA[d._f.getDay()];
    for (const [campo, etiqueta, piso] of [['total', 'ingresos', PISO_PLATA], ['pax', 'cubiertos', 4]]) {
      const c = comparar(d, campo);
      if (!c || Math.abs(c.desvio) < UMBRAL_DESVIO) continue;
      if (Math.abs(d[campo] - c.med) < piso) continue;
      agregar('dia_fuera_de_serie', {
        fecha: d.fecha, diaSemana: nombreDia, metrica: etiqueta,
        direccion: d[campo] > c.med ? 'arriba' : 'abajo',
        valor: redondear(d[campo]), habitualEseDia: redondear(c.med),
        diasComparados: c.muestras,
      });
    }
  }

  // ── B. Gasto por persona ─────────────────────────────────────────────────
  // El ticket promedio es lo que más dice de la carta y del salón: si baja con
  // los cubiertos estables, se está vendiendo distinto, no menos.
  for (const d of semana) {
    const c = comparar(d, 'ticketPromedio');
    if (!c || Math.abs(c.desvio) < UMBRAL_DESVIO) continue;
    if (Math.abs(d.ticketPromedio - c.med) < 3000) continue;
    agregar('ticket_fuera_de_serie', {
      fecha: d.fecha, diaSemana: DIAS_SEMANA[d._f.getDay()],
      direccion: d.ticketPromedio > c.med ? 'arriba' : 'abajo',
      ticketARS: redondear(d.ticketPromedio), habitualEseDiaARS: redondear(c.med),
      pax: d.pax, diasComparados: c.muestras,
    });
  }

  // ── C. Mix comida / bebida ───────────────────────────────────────────────
  const mixSemana = semana.reduce((s, d) => ({ comida: s.comida + (d.comida || 0), bebida: s.bebida + (d.bebida || 0) }), { comida: 0, bebida: 0 });
  const mixPrevio = previos.reduce((s, d) => ({ comida: s.comida + (d.comida || 0), bebida: s.bebida + (d.bebida || 0) }), { comida: 0, bebida: 0 });
  const pct = m => (m.comida + m.bebida > 0 ? (m.bebida / (m.comida + m.bebida)) * 100 : 0);
  if (mixSemana.comida + mixSemana.bebida > 0 && mixPrevio.comida + mixPrevio.bebida > 0) {
    const ahora = pct(mixSemana), antes = pct(mixPrevio);
    if (Math.abs(ahora - antes) >= 6) {
      agregar('mix_cambio', {
        pctBebidaSemana: pct1(ahora), pctBebidaHabitual: pct1(antes),
        direccion: ahora > antes ? 'más bebida' : 'más comida',
      });
    }
  }

  // ── D. Categorías: qué se vendió distinto ────────────────────────────────
  const acum = (lista) => {
    const m = new Map();
    for (const d of lista) for (const c of (d.categorias || [])) {
      const k = c.categoria || 'Sin categoría';
      const v = m.get(k) || { categoria: k, grupo: c.grupo, monto: 0, unidades: 0, dias: 0 };
      v.monto += c.monto || 0; v.unidades += c.unidades || 0; v.dias++;
      m.set(k, v);
    }
    return m;
  };
  const catSemana = acum(semana);
  const catPrevias = acum(previos);

  for (const [k, v] of catSemana) {
    const p = catPrevias.get(k);
    if (!p) {
      if (v.unidades >= PISO_UNIDADES) {
        agregar('categoria_nueva', { categoria: k, grupo: v.grupo, unidades: Math.round(v.unidades), montoARS: redondear(v.monto) });
      }
      continue;
    }
    const habitualSemanal = p.unidades / semanasPrevias;
    if (habitualSemanal < PISO_UNIDADES && v.unidades < PISO_UNIDADES) continue;
    const ratio = v.unidades / (habitualSemanal || 1);
    if (ratio > 0.6 && ratio < 1.7) continue;
    agregar('categoria_movida', {
      categoria: k, grupo: v.grupo, direccion: ratio > 1 ? 'arriba' : 'abajo',
      unidadesSemana: Math.round(v.unidades), habitualSemanal: Math.round(habitualSemanal),
      montoSemanaARS: redondear(v.monto),
    });
  }
  for (const [k, p] of catPrevias) {
    if (catSemana.has(k)) continue;
    if (p.unidades / semanasPrevias < PISO_UNIDADES) continue;
    agregar('categoria_sin_ventas', { categoria: k, grupo: p.grupo, habitualSemanal: Math.round(p.unidades / semanasPrevias) });
  }

  // ── E. Producto por producto: qué salió más y qué salió menos ────────────
  // La categoría dice "se vendió menos carne"; el producto dice cuál. Esa es la
  // diferencia entre un dato y algo que se puede hacer: un plato se saca de la
  // carta, se cambia de precio o se pone en la pizarra — una categoría no.
  //
  // La comparación es contra el promedio SEMANAL de ese producto en las 8
  // semanas previas, no contra la semana pasada: una sola semana como vara
  // convierte cualquier oscilación normal en una tendencia.
  const acumProductos = (lista) => {
    const m = new Map();
    for (const d of lista) for (const c of (d.categorias || [])) {
      for (const p of productosDe(c)) {
        const k = p.nombre.trim();
        const v = m.get(k) || { nombre: k, categoria: c.categoria || 'Sin categoría', grupo: c.grupo, unidades: 0, monto: 0, dias: 0 };
        v.unidades += p.unidades || 0;
        v.monto += p.monto || 0;
        v.dias++;
        m.set(k, v);
      }
    }
    return m;
  };
  const prodSemana = acumProductos(semana);
  const prodPrevios = acumProductos(previos);

  // Se calcula el movimiento de TODOS y después se marcan sólo los más grandes
  // de cada lado. Así lo que llega es "los cinco que más subieron y los cinco
  // que más bajaron", que es la lectura que sirve, y no una lista de treinta.
  const movimientosProducto = [];
  for (const [k, v] of prodSemana) {
    const p = prodPrevios.get(k);
    const habitualUnidades = p ? p.unidades / semanasPrevias : 0;
    const habitualARS = p ? p.monto / semanasPrevias : 0;
    if (!p) {
      if (v.unidades >= PISO_UNIDADES_PRODUCTO || v.monto >= PISO_PLATA_PRODUCTO) {
        agregar('producto_nuevo', {
          producto: k, categoria: v.categoria,
          unidadesSemana: Math.round(v.unidades), montoSemanaARS: redondear(v.monto),
        });
      }
      continue;
    }
    // Material por volumen o por plata, antes y ahora: sin esto entran los
    // productos que se venden de a uno cada tanto.
    const material = Math.max(v.unidades, habitualUnidades) >= PISO_UNIDADES_PRODUCTO
      || Math.max(v.monto, habitualARS) >= PISO_PLATA_PRODUCTO;
    if (!material) continue;
    const ratio = v.unidades / (habitualUnidades || 1);
    if (ratio > 0.65 && ratio < 1.6) continue;
    movimientosProducto.push({
      producto: k, categoria: v.categoria,
      direccion: ratio > 1 ? 'arriba' : 'abajo',
      unidadesSemana: Math.round(v.unidades), habitualSemanal: Math.round(habitualUnidades),
      montoSemanaARS: redondear(v.monto), habitualSemanalARS: redondear(habitualARS),
      diferenciaARS: redondear(v.monto - habitualARS),
      variacionPct: variacionPct(v.unidades, habitualUnidades),
    });
  }
  const porImpacto = (a, b) => Math.abs(b.diferenciaARS) - Math.abs(a.diferenciaARS);
  for (const m of movimientosProducto.filter(x => x.direccion === 'arriba').sort(porImpacto).slice(0, MAX_PRODUCTOS_POR_LADO)) agregar('producto_movido', m);
  for (const m of movimientosProducto.filter(x => x.direccion === 'abajo').sort(porImpacto).slice(0, MAX_PRODUCTOS_POR_LADO)) agregar('producto_movido', m);

  // Un producto que se vendía todas las semanas y esta semana no salió una sola
  // vez. Suele ser una de dos cosas y las dos importan: se acabó y nadie avisó,
  // o dejó de gustar.
  const frenados = [];
  for (const [k, p] of prodPrevios) {
    if (prodSemana.has(k)) continue;
    const habitual = p.unidades / semanasPrevias;
    if (habitual < PISO_UNIDADES_PRODUCTO && p.monto / semanasPrevias < PISO_PLATA_PRODUCTO) continue;
    // Que haya aparecido en pocos días de la referencia significa que nunca fue
    // habitual: era un producto de ocasión y su ausencia no es noticia.
    if (p.dias < 4) continue;
    frenados.push({
      producto: k, categoria: p.categoria,
      habitualSemanal: Math.round(habitual), habitualSemanalARS: redondear(p.monto / semanasPrevias),
    });
  }
  for (const f of frenados.sort((a, b) => b.habitualSemanalARS - a.habitualSemanalARS).slice(0, MAX_PRODUCTOS_POR_LADO)) {
    agregar('producto_sin_ventas', f);
  }

  // ── F. Cómo se reparte la semana entre los días ─────────────────────────
  // Otra pregunta que el día-contra-su-mediana no contesta: si un día de la
  // semana se está moviendo de forma sostenida. Se comparan las últimas N
  // apariciones de ese día contra las N anteriores — un mes contra el mes
  // previo, aproximadamente. A ~1,9% de inflación mensual el arrastre en pesos
  // es de un par de puntos, muy por debajo del umbral de 20%.
  const porDow = new Map();
  for (const d of [...conFecha].sort((a, b) => b._f - a._f)) {
    const k = d._f.getDay();
    if (!porDow.has(k)) porDow.set(k, []);
    porDow.get(k).push(d);
  }
  const tendenciaDia = [];
  for (const [dow, serie] of porDow) {
    const n = Math.min(4, Math.floor(serie.length / 2));
    if (n < 3) continue;
    const recientes = serie.slice(0, n);
    const anteriores = serie.slice(n, n * 2);
    const medAhora = mediana(recientes.map(d => d.total || 0));
    const medAntes = mediana(anteriores.map(d => d.total || 0));
    if (!(medAntes > 0) || !(medAhora > 0)) continue;
    const varPct = ((medAhora - medAntes) / medAntes) * 100;
    if (Math.abs(varPct) < 20) continue;
    if (Math.abs(medAhora - medAntes) < PISO_PLATA) continue;
    tendenciaDia.push({
      diaSemana: DIAS_SEMANA[dow], direccion: varPct > 0 ? 'arriba' : 'abajo',
      ingresoTipicoAhoraARS: redondear(medAhora), ingresoTipicoAntesARS: redondear(medAntes),
      variacionPct: pct1(varPct),
      paxTipicoAhora: Math.round(mediana(recientes.map(d => d.pax || 0))),
      paxTipicoAntes: Math.round(mediana(anteriores.map(d => d.pax || 0))),
      semanasComparadas: n, desde: recientes[recientes.length - 1].fecha, hasta: recientes[0].fecha,
    });
  }
  for (const t of tendenciaDia.sort((a, b) => Math.abs(b.variacionPct) - Math.abs(a.variacionPct))) {
    agregar('dia_semana_tendencia', t);
  }

  // ── G. Mesas chicas y mesas grandes ─────────────────────────────────────
  // 60 cubiertos en 30 mesas de dos y 60 cubiertos en 10 mesas de seis son dos
  // noches distintas: otro ritmo de cocina, otro consumo y otro ticket. Los
  // cubiertos solos no las distinguen.
  const fechasSemana = new Set(semana.map(d => d.fecha));
  const fechasPrevias = new Set(previos.map(d => d.fecha));
  const acumMesas = (lista) => {
    const base = { mesas: 0, mesasConPax: 0, pax: 0, totalARS: 0, porTamano: {} };
    for (const m of lista) {
      base.mesas += m.mesas || 0;
      base.mesasConPax += m.mesasConPax || 0;
      base.pax += m.pax || 0;
      base.totalARS += m.totalARS || 0;
      for (const [k, v] of Object.entries(m.porTamano || {})) {
        const t = base.porTamano[k] || (base.porTamano[k] = { mesas: 0, pax: 0, totalARS: 0 });
        t.mesas += v.mesas || 0; t.pax += v.pax || 0; t.totalARS += v.totalARS || 0;
      }
    }
    return base;
  };
  const mesasLista = (mesas || []).filter(m => m && m.fecha && !esDiaExcluido(m.fecha));
  const mesasSemana = acumMesas(mesasLista.filter(m => fechasSemana.has(m.fecha)));
  const mesasPrevias = acumMesas(mesasLista.filter(m => fechasPrevias.has(m.fecha)));

  const repartoMesas = (acc, semanas = 1) => {
    if (!acc.mesasConPax) return null;
    return {
      mesas: acc.mesas,
      mesasConPaxCargado: acc.mesasConPax,
      pctMesasConPaxCargado: acc.mesas > 0 ? pct1((acc.mesasConPax / acc.mesas) * 100) : 0,
      paxPromedioPorMesa: Number((acc.pax / acc.mesasConPax).toFixed(2)),
      ticketPorMesaARS: redondear(acc.totalARS / (acc.mesas || 1)),
      mesasPorSemana: Math.round(acc.mesasConPax / semanas),
      porTamano: Object.entries(acc.porTamano)
        .filter(([, v]) => v.mesas > 0)
        .map(([tramo, v]) => ({
          tramo, mesas: v.mesas,
          pctDeLasMesas: pct1((v.mesas / acc.mesasConPax) * 100),
          ingresosARS: redondear(v.totalARS),
          pctDeLosIngresos: acc.totalARS > 0 ? pct1((v.totalARS / acc.totalARS) * 100) : null,
          ticketPorMesaARS: redondear(v.totalARS / v.mesas),
        })),
    };
  };
  const mesasSemanaResumen = repartoMesas(mesasSemana);
  const mesasHabitual = repartoMesas(mesasPrevias, semanasPrevias);

  // Grande = 5 o más. Es el corte que cambia la operación: a partir de ahí la
  // mesa se junta, come distinto y ocupa el salón otro rato.
  const pctGrandes = r => (r ? r.porTamano.filter(t => t.tramo === '5-6' || t.tramo === '7 o más')
    .reduce((s, t) => s + t.pctDeLasMesas, 0) : null);
  if (mesasSemanaResumen && mesasHabitual
      && mesasSemana.mesasConPax >= 20 && mesasPrevias.mesasConPax >= 60) {
    const ahora = pctGrandes(mesasSemanaResumen), antes = pctGrandes(mesasHabitual);
    if (Math.abs(ahora - antes) >= 5) {
      agregar('mesas_mix_cambio', {
        direccion: ahora > antes ? 'más mesas grandes' : 'más mesas chicas',
        pctMesasGrandesSemana: pct1(ahora), pctMesasGrandesHabitual: pct1(antes),
        paxPromedioPorMesaSemana: mesasSemanaResumen.paxPromedioPorMesa,
        paxPromedioPorMesaHabitual: mesasHabitual.paxPromedioPorMesa,
        ticketPorMesaSemanaARS: mesasSemanaResumen.ticketPorMesaARS,
        ticketPorMesaHabitualARS: mesasHabitual.ticketPorMesaARS,
        mesasConPaxCargadoSemana: mesasSemana.mesasConPax,
        pctCoberturaDelDato: mesasSemanaResumen.pctMesasConPaxCargado,
      });
    }
  }

  // ── H. Días sin servicio ─────────────────────────────────────────────────
  const abiertos = new Set(semana.map(d => d.fecha));
  const cerrados = [];
  for (let i = 0; i < DIAS_VENTANA; i++) {
    const d = new Date(corte.getTime() - i * 86400000);
    const k = diaISO(d);
    if (abiertos.has(k)) continue;
    // Un día excluido no está "sin servicio": está fuera del análisis. Marcarlo
    // como cerrado sería volver a meterlo por la ventana.
    if (esDiaExcluido(k)) continue;
    const dow = d.getDay();
    if (dow === 1) continue;   // los lunes cierra: no es noticia
    const ref = refDia.get(dow) || [];
    if (ref.length < MIN_REFERENCIA) continue;
    cerrados.push({ fecha: k, diaSemana: DIAS_SEMANA[dow], sueleAbrirEseDia: ref.length });
  }
  for (const c of cerrados) agregar('dia_sin_servicio', c);

  // ── Contexto ─────────────────────────────────────────────────────────────
  const sum = (a, f) => a.reduce((s, d) => s + (d[f] || 0), 0);

  const topProductos = [...prodSemana.values()]
    .sort((a, b) => b.monto - a.monto).slice(0, 12)
    .map(p => ({ nombre: p.nombre, categoria: p.categoria, unidades: Math.round(p.unidades), montoARS: redondear(p.monto) }));

  // La foto de "qué salió más y qué salió menos" va SIEMPRE al contexto, sea o
  // no señal. Es la pregunta que el dueño hace todas las semanas, y merece una
  // respuesta aunque ningún producto haya cruzado un umbral estadístico.
  const comparativaProductos = (() => {
    const filas = [];
    for (const [k, v] of prodSemana) {
      const p = prodPrevios.get(k);
      const habitualARS = p ? p.monto / semanasPrevias : 0;
      const habitualUnidades = p ? p.unidades / semanasPrevias : 0;
      if (Math.max(v.monto, habitualARS) < PISO_PLATA_PRODUCTO
        && Math.max(v.unidades, habitualUnidades) < PISO_UNIDADES_PRODUCTO) continue;
      filas.push({
        producto: k, categoria: v.categoria,
        unidadesSemana: Math.round(v.unidades), habitualSemanal: Math.round(habitualUnidades),
        montoSemanaARS: redondear(v.monto), diferenciaARS: redondear(v.monto - habitualARS),
        variacionPct: variacionPct(v.unidades, habitualUnidades),
      });
    }
    // Se parte por el signo y no por la posición: con pocos productos, cortar
    // "los 8 primeros y los 8 últimos" haría aparecer al mismo producto en las
    // dos listas.
    const orden = [...filas].sort((a, b) => b.diferenciaARS - a.diferenciaARS);
    return {
      subieron: orden.filter(f => f.diferenciaARS > 0).slice(0, 8),
      bajaron: orden.filter(f => f.diferenciaARS < 0).slice(-8).reverse(),
    };
  })();

  // Comportamiento por día de semana: cuánto aporta cada día y con qué ticket.
  // Es el bloque que contesta "¿los jueves valen la pena?".
  const porDiaSemanaResumen = (() => {
    const out = {};
    const ingresoSemanaTotal = sum(semana, 'total');
    for (const [dow, serie] of [...porDow.entries()].sort((a, b) => a[0] - b[0])) {
      const deLaSemana = serie.filter(d => d._f > desdeVentana);
      const dePrevios = serie.filter(d => d._f <= desdeVentana);
      if (!dePrevios.length && !deLaSemana.length) continue;
      const medIngreso = mediana(dePrevios.map(d => d.total || 0));
      out[DIAS_SEMANA[dow]] = {
        estaSemana: deLaSemana.length ? {
          fecha: deLaSemana[0].fecha, pax: deLaSemana[0].pax, ingresosARS: redondear(deLaSemana[0].total),
          ticketARS: redondear(deLaSemana[0].ticketPromedio),
          pctDelIngresoDeLaSemana: ingresoSemanaTotal > 0 ? pct1(((deLaSemana[0].total || 0) / ingresoSemanaTotal) * 100) : null,
        } : null,
        habitual: dePrevios.length ? {
          diasComparados: dePrevios.length,
          paxTipico: Math.round(mediana(dePrevios.map(d => d.pax || 0))),
          ingresoTipicoARS: redondear(medIngreso),
          ticketTipicoARS: redondear(mediana(dePrevios.map(d => d.ticketPromedio || 0))),
        } : null,
      };
    }
    return out;
  })();

  // ── Control de facturación de la semana ──────────────────────────────────
  // NO detecta qué falta facturar: la API de Fudo no expone el estado fiscal de
  // una venta (probado el 12/08/2026 — no hay recurso de comprobantes, y dos
  // ventas con estado fiscal distinto devuelven exactamente los mismos campos).
  // Lo que sí puede hacer, y es lo útil, es decir CUÁNTO entró por medios que
  // obligan a facturar, noche por noche. Eso convierte "revisá la facturación"
  // en una lista de montos concretos para cotejar contra Fudo.
  const controlFacturacion = (() => {
    const porDia = semana.map(d => {
      const medios = d.mediosPago || {};
      const bruto = Object.entries(medios)
        .filter(([nombre]) => esBancarizado(nombre))
        .reduce((s, [, monto]) => s + (monto || 0), 0);
      // Los montos de mediosPago incluyen la propina, que se cobra por encima
      // del total y no es base imponible. Se prorratea fuera para que la cifra
      // sea la que tiene que tener comprobante y no una mayor.
      const cobrado = (d.total || 0) + (d.propinas || 0);
      const neto = cobrado > 0 ? bruto * ((d.total || 0) / cobrado) : bruto;
      return {
        fecha: d.fecha,
        diaSemana: DIAS_SEMANA[d._f.getDay()],
        bancarizadoARS: redondear(neto),
        ventas: d.ventas || 0,
      };
    }).filter(d => d.bancarizadoARS > 0);

    return {
      desde: diaISO(desdeVentana),
      hasta: diaISO(corte),
      totalARS: redondear(porDia.reduce((s, d) => s + d.bancarizadoARS, 0)),
      dias: porDia,
    };
  })();

  return {
    corte: diaISO(corte),
    controlFacturacion,
    contexto: {
      semana: {
        desde: diaISO(desdeVentana), hasta: diaISO(corte), diasAbiertos: semana.length,
        pax: sum(semana, 'pax'), ventas: sum(semana, 'ventas'), ingresosARS: redondear(sum(semana, 'total')),
        ticketPromedioARS: sum(semana, 'pax') > 0 ? redondear(sum(semana, 'total') / sum(semana, 'pax')) : 0,
        comidaARS: redondear(sum(semana, 'comida')), bebidaARS: redondear(sum(semana, 'bebida')),
      },
      porDia: semana.map(d => ({
        fecha: d.fecha, diaSemana: DIAS_SEMANA[d._f.getDay()],
        pax: d.pax, ventas: d.ventas, ingresosARS: redondear(d.total),
        ticketARS: redondear(d.ticketPromedio), pctBebida: pct1(d.pctBebida || 0),
      })),
      referenciaSemanalPrevia: {
        semanasComparadas: semanasPrevias, diasAbiertos: previos.length,
        paxPorSemana: Math.round(sum(previos, 'pax') / semanasPrevias),
        ingresosPorSemanaARS: redondear(sum(previos, 'total') / semanasPrevias),
      },
      comportamientoPorDiaDeSemana: porDiaSemanaResumen,
      mesasDeLaSemana: mesasSemanaResumen,
      mesasHabituales: mesasHabitual,
      categoriasDeLaSemana: [...catSemana.values()]
        .sort((a, b) => b.monto - a.monto).slice(0, 14)
        .map(c => ({ categoria: c.categoria, grupo: c.grupo, unidades: Math.round(c.unidades), montoARS: redondear(c.monto) })),
      productosMasVendidos: topProductos,
      productosQueMasSubieron: comparativaProductos.subieron,
      productosQueMasBajaron: comparativaProductos.bajaron,
      diasNoComparables: excluidos,
    },
    senales,
  };
}

const SISTEMA = `Este informe es SEMANAL y mira el SALÓN: los servicios que registra Fudo (el sistema de punto de venta). La plata y los proveedores los mira otro informe — no hables de gastos acá.

Lo que el dueño quiere saber, en este orden: qué se vendió más y qué se vendió menos, cómo vino la gente (cuántas mesas y de qué tamaño), cuánto gastó cada uno y qué días de la semana están rindiendo.

Te llegan señales de estos tipos, ya calculadas:
- producto_movido / producto_nuevo / producto_sin_ventas: qué producto se despegó de su propio promedio semanal.
- categoria_movida / categoria_nueva / categoria_sin_ventas: lo mismo a nivel categoría.
- mesas_mix_cambio: cambió el reparto entre mesas chicas y mesas grandes.
- dia_semana_tendencia: un día de la semana que se viene moviendo de forma sostenida (últimas semanas contra las anteriores).
- dia_fuera_de_serie: una noche con ingresos o cubiertos muy lejos de lo habitual PARA ESE DÍA DE SEMANA.
- ticket_fuera_de_serie: el gasto por persona se despegó de lo habitual de ese día.
- mix_cambio: cambió el reparto entre comida y bebida.
- dia_sin_servicio: un día que suele abrir y no abrió.

Cómo leerlas:
- Todas las comparaciones ya están hechas contra el MISMO DÍA DE SEMANA o contra el propio promedio semanal del producto. No vuelvas a corregir por eso ni compares un martes con un sábado.
- Un producto que sube mientras otro de la misma categoría baja es UNA historia (se cambió de preferencia), no dos. Contala junta y decí qué se hace con eso: sacarlo de la carta, cambiarle el precio, ponerlo en la pizarra.
- Cubiertos e ingresos se mueven juntos casi siempre. Cuando NO se mueven juntos —vino la misma gente pero gastó distinto, o vino menos gente y se facturó igual— eso sí es un hallazgo, y vale más que cualquiera de los dos por separado.
- Las mesas dicen algo que los cubiertos solos no: 60 cubiertos en 30 mesas de dos y 60 en 10 mesas de seis son dos noches distintas. Si el dato de comensales por mesa cubre poco (viene el porcentaje), decilo al opinar.
- Una noche floja aislada no es una tendencia. Dos o tres del mismo signo, sí; y una señal de dia_semana_tendencia ya viene siendo eso.

En el contexto tenés SIEMPRE, aunque no haya señales, los productos que más subieron y los que más bajaron, el comportamiento de cada día de la semana y el reparto de mesas por tamaño. Ese material es el corazón del informe: úsalo para decir algo útil incluso en una semana tranquila. Un informe que sólo dice "no pasó nada" está desperdiciando datos que ya están calculados.

PUEDE NO HABER NADA ANÓMALO, y eso está bien: en ese caso no inventes una anomalía. Pero sí decí qué está mostrando el salón esta semana — qué se está vendiendo, cómo viene la gente, qué día rinde — que es distinto de inflar el informe con problemas que no existen.

Si te llega "diasNoComparables", son días que quedaron FUERA del análisis a propósito (eventos puntuales que no se repiten). No los menciones, no los uses como referencia y no los cuentes como días cerrados.

NO analices horarios de apertura ni de cierre: ese dato ya no te llega porque no era confiable (marca cuándo se abrió la primera mesa, no cuándo abrió el bar) y no le cambia una decisión a nadie.

SOBRE EL CONTROL DE FACTURACIÓN: al final del payload te llega un bloque con lo cobrado por tarjeta y QR de la semana. Es un RECORDATORIO que ya está escrito y se agrega solo, aparte de tus hallazgos — NO lo repitas, no lo menciones en el titular y no lo cuentes como un hallazgo tuyo. Tampoco saques conclusiones sobre si se facturó o no: no tenés ese dato, la API de Fudo no lo informa.

Dejá el campo "resumen" como string vacío: es sólo para el balance mensual.

Terminá con una sola frase: lo más importante que sugieren estos datos que habría que hacer.`;

const periodoDe = (corte) => {
  const fin = corteEfectivo(corte);
  const desde = new Date(fin.getTime() - DIAS_VENTANA * 86400000);
  return `semana ${diaISO(desde)} a ${diaISO(fin)}`;
};

// ─── El recordatorio de facturación, escrito por código ─────────────────────
//
// Va como `hallazgoFijo` marcado con esRecordatorio y no como una señal más
// porque NO es un hallazgo: es un control que tiene que aparecer todas las
// semanas, haya pasado algo o no. Si dependiera del modelo, el mismo prompt que
// le dice "puede no haber nada que valga la pena" lo haría desaparecer la
// primera semana tranquila.
//
// `esRecordatorio` es lo que lo mantiene en su lugar (16/8/2026). Antes salía
// como el primer hallazgo del informe, con severidad alta, todas las semanas:
// eso pintaba de rojo un informe que podía no tener ningún problema y ocupaba
// el lugar del análisis con una tarea repetida. Ahora la app lo muestra abajo,
// como recordatorio, y no cuenta ni para la severidad ni para "hay hallazgos".
//
// Devuelve null sólo si no hubo un peso bancarizado en toda la semana: ahí no hay
// nada que revisar y el recordatorio sería ruido.
function hallazgoFacturacion(control) {
  if (!control || !(control.totalARS > 0)) return null;

  const fmtARS = n => '$' + Math.round(n).toLocaleString('es-AR');
  const lineas = control.dias
    .map(d => `${d.diaSemana} ${d.fecha.slice(8, 10)}/${d.fecha.slice(5, 7)}: ${fmtARS(d.bancarizadoARS)}`)
    .join(' · ');

  return {
    titulo: 'Control semanal de facturación',
    esRecordatorio: true,
    severidad: 'media',
    quePasa: `Entraron ${fmtARS(control.totalARS)} por tarjeta y QR: ${lineas}. `
      + 'Hay que confirmar en Fudo que esos montos tienen comprobante.',
    porQueImporta: 'La app no puede chequearlo sola: la API de Fudo no informa si una venta se facturó. '
      + 'Sale todas las semanas y no significa que falte facturar algo.',
    confianza: 'alta',
    referencias: control.dias.map(d => d.fecha),
    concepto: '',
    desdeISO: '',
  };
}

async function analizar({ hasta } = {}) {
  const fudo = require('./fudo');
  const corte = hasta ? new Date(hasta) : new Date();
  const desde = new Date(corte.getTime() - (SEMANAS_REFERENCIA + 1) * 7 * 86400000);
  const rango = { desde: diaISO(desde), hasta: diaISO(corte) };
  const dias = await fudo.getDetallesTodos(rango);

  // Las mesas se piden aparte porque salen de las ventas crudas y no del
  // detalle diario (ver getMesasPorDia). Si esa lectura falla, el informe sale
  // sin el bloque de mesas en vez de no salir: es una parte del análisis, no el
  // análisis.
  let mesas = [];
  try {
    mesas = await fudo.getMesasPorDia(rango);
  } catch (e) {
    console.error(`Informes: no se pudo leer el tamaño de mesa (${e.message}) — el informe sale sin ese bloque`);
  }

  const a = analizarServicios(dias, { hasta: corte, mesas });
  const payload = [
    `Semana analizada: ${a.contexto.semana.desde} a ${a.contexto.semana.hasta}`, '',
    'CONTEXTO:', JSON.stringify(a.contexto, null, 1), '',
    `SEÑALES DETECTADAS (${a.senales.length}):`,
    a.senales.length ? JSON.stringify(a.senales, null, 1) : '(ninguna)',
    '',
    'CONTROL DE FACTURACIÓN (recordatorio ya redactado, se agrega solo y aparte — NO lo repitas):',
    JSON.stringify(a.controlFacturacion, null, 1),
  ].join('\n');
  const fijo = hallazgoFacturacion(a.controlFacturacion);
  return {
    payload,
    senales: a.senales.length,
    analisis: a,
    hallazgosFijos: fijo ? [fijo] : [],
  };
}

module.exports = {
  TIPO, TITULO, SISTEMA, analizar, periodoDe, analizarServicios,
  hallazgoFacturacion, esBancarizado, productosDe,
};
