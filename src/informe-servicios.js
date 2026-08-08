// ─── Analista: el salón (Fudo), semanal ─────────────────────────────────────
//
// Corre los domingos y mira los servicios de la semana. La plata la mira el
// otro agente; este mira lo que pasó en el salón: cuánta gente vino, cuánto
// gastó cada uno, qué se vendió y a qué hora se trabajó.
//
// LA COMPARACIÓN ES POR DÍA DE SEMANA, siempre. En un bar un sábado no se
// compara con un martes: el mismo número de cubiertos es récord un martes y
// desastre un sábado. Cada día se mide contra los mismos días de las últimas
// 8 semanas. Comparar contra el promedio general sería ruido garantizado.
//
// Todo lo de este archivo es puro salvo la lectura de Fudo.

const {
  mediana, escalaDe, norm, diaISO, redondear,
  DIAS_SEMANA, DIAS_VENTANA, SEMANAS_REFERENCIA,
} = require('./informes-util');

const TIPO = 'servicios';
const TITULO = 'El salón de la semana';

const UMBRAL_DESVIO = 2.5;      // más bajo que en plata: acá la serie es más ruidosa
const MIN_REFERENCIA = 3;       // mínimo de días comparables para opinar
const PISO_PLATA = 150000;      // desvíos de ingreso menores no mueven la aguja
const PISO_UNIDADES = 8;

// Fudo entrega apertura y cierre en UTC. Argentina es UTC-3 todo el año.
const HORA_AR = iso => {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() - 3 * 3600000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};
const comoHora = h => (h == null ? null
  : `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`);

// Un servicio termina de madrugada del día siguiente, así que el día en curso
// nunca está cerrado cuando el informe corre a la mañana: se analiza hasta ayer.
const corteEfectivo = d => new Date(new Date(d).getTime() - 86400000);

function analizarServicios(dias, { hasta } = {}) {
  // El corte es el ÚLTIMO DÍA CON SERVICIO TERMINADO, no el día en que corre.
  // El agente sale los domingos a las 10 de la mañana: el servicio del domingo
  // todavía no pasó, y contarlo hacía dos cosas mal — bajaba el promedio de la
  // semana con un día en cero y marcaba "no abrió" un día que todavía no
  // empezó.
  const corte = corteEfectivo(hasta ? new Date(hasta) : new Date());
  corte.setHours(23, 59, 59, 999);
  const desdeVentana = new Date(corte.getTime() - DIAS_VENTANA * 86400000);
  const desdeRef = new Date(corte.getTime() - (SEMANAS_REFERENCIA + 1) * 7 * 86400000);

  const fechaDe = d => { const [y, m, x] = (d.fecha || '').split('-').map(Number); return new Date(y, m - 1, x); };
  const validos = (dias || []).filter(d => d && d.fecha && d.encontrado !== false && (d.pax > 0 || d.total > 0));
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
        pctBebidaSemana: Number(ahora.toFixed(1)), pctBebidaHabitual: Number(antes.toFixed(1)),
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
  // Cuántas semanas cubre la referencia. Va por el LAPSO de fechas, no por el
  // número de días abiertos: dividir días-previos por días-de-esta-semana daba
  // 12 en vez de 8 y subestimaba a la mitad todos los promedios semanales, con
  // lo cual cualquier categoría parecía haber subido.
  const semanasPrevias = (() => {
    if (!previos.length) return 1;
    const fechas = previos.map(d => d._f.getTime());
    return Math.max(1, Math.round(((Math.max(...fechas) - Math.min(...fechas)) / 86400000 + 1) / 7));
  })();

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

  // ── E. Horarios ──────────────────────────────────────────────────────────
  // Apertura, cierre y duración del servicio. Un cierre sistemáticamente más
  // temprano con los mismos cubiertos es otra cosa que un cierre más temprano
  // porque no vino nadie — por eso van los cubiertos al lado.
  const durRef = previos.map(d => {
    const a = HORA_AR(d.apertura), c = HORA_AR(d.cierre);
    return a != null && c != null ? (c < a ? c + 24 - a : c - a) : null;
  }).filter(x => x != null && x > 0 && x < 14);
  const medDur = mediana(durRef), escDur = escalaDe(durRef, medDur);
  const aperRef = previos.map(d => HORA_AR(d.apertura)).filter(x => x != null);
  const medAper = mediana(aperRef), escAper = escalaDe(aperRef, medAper);

  for (const d of semana) {
    const a = HORA_AR(d.apertura), c = HORA_AR(d.cierre);
    if (a == null || c == null) continue;
    const dur = c < a ? c + 24 - a : c - a;
    if (durRef.length >= MIN_REFERENCIA && escDur > 0 && Math.abs((dur - medDur) / escDur) >= UMBRAL_DESVIO && Math.abs(dur - medDur) >= 1) {
      agregar('duracion_distinta', {
        fecha: d.fecha, diaSemana: DIAS_SEMANA[d._f.getDay()],
        abrio: comoHora(a), cerro: comoHora(c),
        horasDeServicio: Number(dur.toFixed(1)), habitualHoras: Number(medDur.toFixed(1)),
        pax: d.pax, ingresosARS: redondear(d.total),
      });
    }
    if (aperRef.length >= MIN_REFERENCIA && escAper > 0 && Math.abs((a - medAper) / escAper) >= UMBRAL_DESVIO && Math.abs(a - medAper) >= 0.75) {
      agregar('apertura_distinta', {
        fecha: d.fecha, diaSemana: DIAS_SEMANA[d._f.getDay()],
        abrio: comoHora(a), habitualAbre: comoHora(medAper), pax: d.pax,
      });
    }
  }

  // ── F. Días sin servicio ─────────────────────────────────────────────────
  const abiertos = new Set(semana.map(d => d.fecha));
  const cerrados = [];
  for (let i = 0; i < DIAS_VENTANA; i++) {
    const d = new Date(corte.getTime() - i * 86400000);
    const k = diaISO(d);
    if (abiertos.has(k)) continue;
    const dow = d.getDay();
    if (dow === 1) continue;   // los lunes cierra: no es noticia
    const ref = refDia.get(dow) || [];
    if (ref.length < MIN_REFERENCIA) continue;
    cerrados.push({ fecha: k, diaSemana: DIAS_SEMANA[dow], sueleAbrirEseDia: ref.length });
  }
  for (const c of cerrados) agregar('dia_sin_servicio', c);

  // ── Contexto ─────────────────────────────────────────────────────────────
  const sum = (a, f) => a.reduce((s, d) => s + (d[f] || 0), 0);
  const topProductos = (() => {
    const m = new Map();
    for (const d of semana) for (const c of (d.categorias || [])) {
      for (const [nombre, p] of Object.entries(c.productos || {})) {
        const v = m.get(nombre) || { nombre, categoria: c.categoria, unidades: 0, montoARS: 0 };
        v.unidades += p.unidades || 0; v.montoARS += p.monto || 0;
        m.set(nombre, v);
      }
    }
    return [...m.values()].sort((a, b) => b.montoARS - a.montoARS).slice(0, 12)
      .map(p => ({ ...p, unidades: Math.round(p.unidades), montoARS: redondear(p.montoARS) }));
  })();

  return {
    corte: diaISO(corte),
    contexto: {
      semana: {
        desde: diaISO(desdeVentana), hasta: diaISO(corte), diasAbiertos: semana.length,
        pax: sum(semana, 'pax'), ventas: sum(semana, 'ventas'), ingresosARS: redondear(sum(semana, 'total')),
        ticketPromedioARS: sum(semana, 'pax') > 0 ? redondear(sum(semana, 'total') / sum(semana, 'pax')) : 0,
        comidaARS: redondear(sum(semana, 'comida')), bebidaARS: redondear(sum(semana, 'bebida')),
      },
      porDia: semana.map(d => ({
        fecha: d.fecha, diaSemana: DIAS_SEMANA[d._f.getDay()], turno: d.turno || 'cena',
        pax: d.pax, ventas: d.ventas, ingresosARS: redondear(d.total),
        ticketARS: redondear(d.ticketPromedio), pctBebida: Number((d.pctBebida || 0).toFixed(1)),
        abrio: comoHora(HORA_AR(d.apertura)), cerro: comoHora(HORA_AR(d.cierre)),
      })),
      referenciaSemanalPrevia: {
        semanasComparadas: semanasPrevias, diasAbiertos: previos.length,
        paxPorSemana: Math.round(sum(previos, 'pax') / semanasPrevias),
        ingresosPorSemanaARS: redondear(sum(previos, 'total') / semanasPrevias),
      },
      categoriasDeLaSemana: [...catSemana.values()]
        .sort((a, b) => b.monto - a.monto).slice(0, 14)
        .map(c => ({ categoria: c.categoria, grupo: c.grupo, unidades: Math.round(c.unidades), montoARS: redondear(c.monto) })),
      productosMasVendidos: topProductos,
    },
    senales,
  };
}

const SISTEMA = `Este informe es SEMANAL y mira el SALÓN: los servicios que registra Fudo (el sistema de punto de venta). La plata y los proveedores los mira otro informe — no hables de gastos acá.

Los KPI que importan, en este orden: cuánta gente vino (pax), cuánto ingresó, qué se vendió (categorías y productos) y a qué hora se trabajó.

Te llegan señales de estos tipos, ya calculadas:
- dia_fuera_de_serie: una noche con ingresos o cubiertos muy lejos de lo habitual PARA ESE DÍA DE SEMANA.
- ticket_fuera_de_serie: el gasto por persona se despegó de lo habitual de ese día.
- mix_cambio: cambió el reparto entre comida y bebida.
- categoria_movida / categoria_nueva / categoria_sin_ventas: qué se vendió distinto.
- duracion_distinta / apertura_distinta: se abrió o se cerró fuera de lo habitual.
- dia_sin_servicio: un día que suele abrir y no abrió.

Cómo leerlas:
- Todas las comparaciones ya están hechas contra el MISMO DÍA DE SEMANA. No vuelvas a corregir por eso ni compares un martes con un sábado.
- Cubiertos e ingresos se mueven juntos casi siempre. Cuando NO se mueven juntos —vino la misma gente pero gastó distinto, o vino menos gente y se facturó igual— eso sí es un hallazgo, y vale más que cualquiera de los dos por separado.
- Una noche floja aislada no es una tendencia. Dos o tres del mismo signo, sí.
- Los horarios importan por lo que implican: cerrar antes con la misma gente adentro no es lo mismo que cerrar antes porque se vació el salón.

PUEDE NO HABER NADA que valga la pena, y en ese caso devolvé la lista de hallazgos vacía. Es una respuesta correcta y esperada, no un fracaso. No infles el informe para tener algo que mostrar.

Dejá el campo "resumen" como string vacío: es sólo para el balance mensual.

Terminá con una sola frase: lo más importante que sugieren estos datos que habría que hacer.`;

const periodoDe = (corte) => {
  const fin = corteEfectivo(corte);
  const desde = new Date(fin.getTime() - DIAS_VENTANA * 86400000);
  return `semana ${diaISO(desde)} a ${diaISO(fin)}`;
};

async function analizar({ hasta } = {}) {
  const fudo = require('./fudo');
  const corte = hasta ? new Date(hasta) : new Date();
  const desde = new Date(corte.getTime() - (SEMANAS_REFERENCIA + 1) * 7 * 86400000);
  const dias = await fudo.getDetallesTodos({ desde: diaISO(desde), hasta: diaISO(corte) });
  const a = analizarServicios(dias, { hasta: corte });
  const payload = [
    `Semana analizada: ${a.contexto.semana.desde} a ${a.contexto.semana.hasta}`, '',
    'CONTEXTO:', JSON.stringify(a.contexto, null, 1), '',
    `SEÑALES DETECTADAS (${a.senales.length}):`,
    a.senales.length ? JSON.stringify(a.senales, null, 1) : '(ninguna)',
  ].join('\n');
  return { payload, senales: a.senales.length, analisis: a };
}

module.exports = { TIPO, TITULO, SISTEMA, analizar, periodoDe, analizarServicios, HORA_AR };
