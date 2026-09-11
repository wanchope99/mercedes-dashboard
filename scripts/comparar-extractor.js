#!/usr/bin/env node
// ─── El experimento que decide si el extractor baja a Haiku ────────────────────
//
// Corre las CUATRO combinaciones —Opus y Haiku, cada uno con la foto grande y
// con la chica— sobre las mismas facturas reales, y las compara campo por campo.
// Es la palanca A del análisis de costos del 9/9: leer facturas es el 60% del
// costo por cliente y la única línea que crece con el uso.
//
// POR QUÉ ESTE SCRIPT Y NO CAMBIAR LA VARIABLE Y VER QUÉ PASA. El error que
// importa no es el que se ve: es un total mal leído con confianza alta, que se
// escribe solo en el libro y nadie mira. La app ya está preparada para que el
// modelo DUDE —todo lo que baja de PROVEEDORES_UMBRAL_CONFIANZA (0,6) se
// convierte en una pregunta al que sacó la foto— así que un modelo peor degrada
// en más preguntas, no en datos mal cargados. Lo que hay que medir es
// exactamente esa distinción, y no se ve mirando una factura prolija.
//
// EL CRITERIO, ESCRITO ACÁ PARA QUE LO APLIQUE EL SCRIPT Y NO EL HUMANO:
//   · se cambia si Haiku+chica no se equivoca MÁS que Opus+grande en total y
//     proveedor;
//   · preguntar más NO cuenta como equivocarse (es lo que la app ya espera);
//   · un total mal escrito CON confianza alta, aunque sea una vez de veinte,
//     lo VETA.
//
// LA VERDAD CONOCIDA ES OPCIONAL, Y ESO ES DELIBERADO. Con --verdad se compara
// contra lo que quedó en la planilla. Sin ella se compara cada corrida contra
// las otras tres: donde las cuatro coinciden no hace falta que nadie mire, y
// donde discrepan el script imprime las cuatro lecturas para que una persona
// decida sólo esas. Eso baja el trabajo manual de 20 facturas a las contadas
// que estén en disputa.
//
// USO
//   node scripts/comparar-extractor.js --fotos ./facturas [opciones]
//
//   --fotos <carpeta>    Carpeta con las imágenes (.jpg .jpeg .png .webp).
//   --modelos a,b        Default: claude-opus-4-6,claude-haiku-4-5
//   --px <n>             Lado largo de la foto chica. Default 1280 (el tamaño
//                        que Telegram ya tiene generado, ver bot.py).
//   --verdad <json>      { "IMG_001.jpg": { "total": 110500, "proveedor": "...",
//                          "renglones": 7 }, ... }  — todos los campos opcionales.
//   --salida <carpeta>   Dónde dejar el detalle crudo. Default: ./_experimento
//   --dry                No llama al modelo: sólo achica, mide e informa el
//                        costo estimado. Sirve para ver qué va a gastar antes
//                        de gastarlo, y para probar el script sin clave.
//
// REQUIERE ANTHROPIC_API_KEY (salvo con --dry).

// El .env de la raíz, igual que server.js: la clave vive ahí y no en el entorno
// de la terminal. Va antes de requerir el extractor, que lee env al cargarse.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const extractor = require('../src/extractor');

// USD por millón de tokens. Es lo único de este script que caduca solo.
const PRECIOS = {
  'claude-opus-4-6':  { entrada: 5, salida: 25 },
  'claude-opus-5':    { entrada: 5, salida: 25 },
  'claude-sonnet-5':  { entrada: 2, salida: 10 },
  'claude-haiku-4-5': { entrada: 1, salida: 5 },
};

const UMBRAL = parseFloat(process.env.PROVEEDORES_UMBRAL_CONFIANZA || '0.6');
const EXTENSIONES = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIMES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// ─── Argumentos ────────────────────────────────────────────────────────────────
function args(argv) {
  const o = { modelos: 'claude-opus-4-6,claude-haiku-4-5', px: '1280', salida: '_experimento' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') { o.dry = true; continue; }
    if (a.startsWith('--')) { o[a.slice(2)] = argv[++i]; continue; }
  }
  return o;
}

// ─── Achicar ───────────────────────────────────────────────────────────────────
//
// Se apoya en PowerShell + System.Drawing, que es lo que hay en esta máquina sin
// instalar nada. La alternativa era agregar `sharp` al package.json: una
// dependencia nativa que Railway también instalaría, para un script que se corre
// una tarde. Ver el encabezado de achicar-foto.ps1 por la limitación.
function achicar(entrada, salida, px) {
  if (process.platform !== 'win32') {
    throw new Error(
      'El achicado usa PowerShell/System.Drawing y esta máquina no es Windows.\n' +
      'Alternativas: `magick entrada -resize ' + px + 'x' + px + ' salida` o `sips -Z ' + px + '`,\n' +
      'y después correr con las dos carpetas ya armadas.'
    );
  }
  const ps1 = path.join(__dirname, 'achicar-foto.ps1');
  return execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-Entrada', entrada, '-Salida', salida, '-LadoLargo', String(px),
  ], { encoding: 'utf8' }).trim();
}

// Dimensiones sin librerías: alcanza con leer la cabecera del archivo.
// JPEG: se recorren los marcadores hasta un SOFn. PNG: están en el IHDR.
function dimensiones(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const marca = buf[i + 1];
      // SOF0..SOF15, salteando los que no llevan dimensiones (DHT, JPG, DAC).
      if (marca >= 0xC0 && marca <= 0xCF && marca !== 0xC4 && marca !== 0xC8 && marca !== 0xCC) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// La API escala cualquier imagen para que ningún lado pase de 1568 px, así que
// una foto de 3000 px no cuesta más que una de 1568. Esto es justamente por qué
// la palanca de la foto chica sólo rinde si se baja POR DEBAJO de ese techo.
const TECHO_API = 1568;
function tokensDeImagen(dim) {
  if (!dim) return null;
  const mayor = Math.max(dim.w, dim.h);
  const e = mayor > TECHO_API ? TECHO_API / mayor : 1;
  return Math.round((dim.w * e) * (dim.h * e) / 750);
}

// ─── Una llamada ───────────────────────────────────────────────────────────────
//
// Usa los prompts EXPORTADOS del extractor, no una copia: lo que se mide tiene
// que ser lo que corre en producción, y un prompt duplicado se despega el día
// que alguien toca uno de los dos. Lo que no se reusa es `extraerCabecera`,
// porque no devuelve el `usage` — y sin el `usage` el costo sería otra
// estimación, que es lo que este script existe para dejar de hacer.
async function llamar(cliente, modelo, prompt, base64, mime, maxTokens) {
  const t0 = Date.now();
  const resp = await cliente.messages.create({
    model: modelo,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  const ms = Date.now() - t0;
  let raw = (resp.content[0] && resp.content[0].text || '').trim();
  if (raw.startsWith('```')) raw = raw.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  let parsed = null, errorJson = null;
  try { parsed = JSON.parse(raw); } catch (e) { errorJson = raw.slice(0, 300); }
  return { parsed, errorJson, raw, ms, usage: resp.usage, stop: resp.stop_reason };
}

function costo(modelo, usos) {
  const p = PRECIOS[modelo];
  if (!p) return null;
  const ent = usos.reduce((s, u) => s + ((u && u.input_tokens) || 0), 0);
  const sal = usos.reduce((s, u) => s + ((u && u.output_tokens) || 0), 0);
  return { entrada: ent, salida: sal, usd: (ent * p.entrada + sal * p.salida) / 1e6 };
}

// ─── Una combinación sobre una factura ─────────────────────────────────────────
//
// Cabecera y renglones en paralelo, igual que el circuito real del bot: las dos
// mandan la foto entera, que es por qué la imagen se paga DOS veces por factura.
async function corrida(cliente, modelo, base64, mime) {
  const [cab, items] = await Promise.all([
    llamar(cliente, modelo, extractor.buildPromptCabecera(), base64, mime, 420),
    llamar(cliente, modelo, extractor.buildPromptItems(), base64, mime, 3000),
  ]);

  const f = (cab.parsed && typeof cab.parsed === 'object' && !Array.isArray(cab.parsed)) ? cab.parsed : {};
  const conf = f.confianza || {};
  const lineas = Array.isArray(items.parsed)
    ? items.parsed
    : (Array.isArray(items.parsed && items.parsed.items) ? items.parsed.items : []);

  return {
    total: Number(f.total_factura) || 0,
    proveedor: String(f.proveedor || '').trim(),
    letra: extractor.normalizarComprobante(f.tipo_comprobante),
    fecha: String(f.fecha || ''),
    fechaTexto: String(f.fecha_texto || ''),
    renglones: lineas.length,
    confTotal: Number(conf.total_factura) || 0,
    confProveedor: Number(conf.proveedor) || 0,
    // Cuántos campos caen bajo el umbral = cuántas veces la app va a preguntar.
    preguntas: ['proveedor', 'fecha', 'forma_de_pago', 'total_factura', 'tipo_comprobante']
      .filter(k => (Number(conf[k]) || 0) < UMBRAL),
    errorJson: cab.errorJson || items.errorJson || null,
    truncado: cab.stop === 'max_tokens' || items.stop === 'max_tokens',
    ms: Math.max(cab.ms, items.ms),
    costo: costo(modelo, [cab.usage, items.usage]),
    // Separado por llamada, porque las dos mitades no cuestan lo mismo: las dos
    // mandan la foto entera, pero la cabecera son ~120 tokens de salida y los
    // renglones ~114 POR renglón. Sin esto no se puede decidir si conviene
    // partir los modelos —una mitad en Haiku, la otra en Opus— ni cuánto rinde.
    costoCabecera: costo(modelo, [cab.usage]),
    costoItems: costo(modelo, [items.usage]),
    crudo: { cabecera: cab.raw, items: items.raw },
  };
}

// ─── Comparación ───────────────────────────────────────────────────────────────
//
// El total se compara con tolerancia de un peso: dos lecturas que difieren en el
// redondeo del centavo son la misma lectura. El proveedor se normaliza (sin
// acentos, sin puntuación, sin "S.A."/"SRL") porque "Láctea El Puente S.A." y
// "LACTEA EL PUENTE SA" son el mismo proveedor y el nombre exacto no es lo que
// se está midiendo: lo que importa es si identificó a QUIÉN le compró.
function normProv(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\b(S\.?A\.?S?|S\.?R\.?L\.?|SOCIEDAD ANONIMA)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
const mismoTotal = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) <= 1;

function fmtUSD(n) { return n == null ? '—' : '$' + n.toFixed(4); }
function fmtNum(n) { return Number(n || 0).toLocaleString('es-AR'); }

// ─── Principal ─────────────────────────────────────────────────────────────────
async function main() {
  const o = args(process.argv);
  if (!o.fotos) {
    console.error('Falta --fotos <carpeta>. Ver el encabezado del archivo.');
    process.exit(1);
  }
  const modelos = o.modelos.split(',').map(s => s.trim()).filter(Boolean);
  const px = parseInt(o.px, 10);
  const salida = path.resolve(o.salida);
  const chicas = path.join(salida, 'chicas');
  fs.mkdirSync(chicas, { recursive: true });

  const verdad = o.verdad ? JSON.parse(fs.readFileSync(o.verdad, 'utf8')) : {};

  const fotos = fs.readdirSync(o.fotos)
    .filter(f => EXTENSIONES.has(path.extname(f).toLowerCase()))
    .sort();
  if (!fotos.length) { console.error('No hay imágenes en ' + o.fotos); process.exit(1); }

  const desconocidos = modelos.filter(m => !PRECIOS[m]);
  if (desconocidos.length) {
    console.log('⚠️  Sin precio cargado para: ' + desconocidos.join(', ') + ' — el costo va a salir vacío.\n');
  }

  console.log(fotos.length + ' facturas · ' + modelos.length + ' modelos × 2 tamaños = '
    + (fotos.length * modelos.length * 2) + ' corridas (' + (fotos.length * modelos.length * 4) + ' llamadas)');
  console.log('Foto chica: lado largo ' + px + ' px · umbral de confianza ' + UMBRAL + '\n');

  // ── Paso 1: achicar y pesar. Se hace entero antes de llamar al modelo para
  // poder mostrar el costo estimado y frenar si no cierra.
  const entradas = [];
  for (const nombre of fotos) {
    const rutaG = path.resolve(o.fotos, nombre);
    const rutaC = path.join(chicas, nombre.replace(/\.[^.]+$/, '') + '.jpg');
    let nota = '';
    try { nota = achicar(rutaG, rutaC, px); }
    catch (e) { console.error('\n' + e.message + '\n'); process.exit(1); }

    const bufG = fs.readFileSync(rutaG);
    const bufC = fs.readFileSync(rutaC);
    const dimG = dimensiones(bufG), dimC = dimensiones(bufC);
    const e = {
      nombre,
      grande: { buf: bufG, mime: MIMES[path.extname(nombre).toLowerCase()], dim: dimG, tk: tokensDeImagen(dimG) },
      chica:  { buf: bufC, mime: 'image/jpeg', dim: dimC, tk: tokensDeImagen(dimC) },
    };
    entradas.push(e);
    // Los nombres que exporta Telegram son largos (photo_5039618156325964887_w),
    // así que la columna se dimensiona con el más largo de la tanda en vez de
    // un ancho fijo: con 28 fijos las columnas se pegaban y la tabla no se leía.
    const ancho = Math.max(...fotos.map(f => f.length)) + 2;
    console.log('  ' + nombre.padEnd(ancho) + nota.padEnd(24) + e.grande.tk + ' → ' + e.chica.tk + ' tokens de imagen');
  }

  const tkG = entradas.reduce((s, e) => s + e.grande.tk, 0);
  const tkC = entradas.reduce((s, e) => s + e.chica.tk, 0);
  console.log('\nTokens de imagen, sumados: grande ' + fmtNum(tkG) + ' · chica ' + fmtNum(tkC)
    + ' (' + Math.round((1 - tkC / tkG) * 100) + '% menos)');
  console.log('Cada factura manda la foto dos veces (cabecera + renglones), así que esto se paga ×2.\n');

  if (o.dry) {
    // Estimación: imagen ×2 + prompts + salida típica (82 de cabecera, ~114 por
    // renglón). Es la cuenta del análisis del 9/9; la corrida real la reemplaza.
    const tkPrompt = Math.round((extractor.buildPromptCabecera().length + extractor.buildPromptItems().length) / 3.6);
    const salidaEst = entradas.length * (82 + 114 * 7);
    for (const m of modelos) {
      const p = PRECIOS[m]; if (!p) continue;
      for (const par of [['grande', tkG], ['chica', tkC]]) {
        const ent = par[1] * 2 + tkPrompt * entradas.length;
        console.log('  ' + m.padEnd(18) + par[0].padEnd(8) + '≈ '
          + fmtUSD((ent * p.entrada + salidaEst * p.salida) / 1e6) + ' las ' + entradas.length + ' facturas');
      }
    }
    console.log('\n(--dry: no se llamó al modelo. Sacá --dry para correr de verdad.)');
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY. Cargala en .env o en el entorno, o corré con --dry.');
    process.exit(1);
  }
  const cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ── Paso 2: las corridas.
  const combos = [];
  for (const m of modelos) for (const tam of ['grande', 'chica']) combos.push({ modelo: m, tam, id: m + ' · ' + tam });

  const resultados = [];
  for (const e of entradas) {
    const fila = { nombre: e.nombre, corridas: {} };
    for (const c of combos) {
      const v = e[c.tam];
      process.stdout.write('  ' + e.nombre + ' · ' + c.id + ' … ');
      try {
        const r = await corrida(cliente, c.modelo, v.buf.toString('base64'), v.mime);
        fila.corridas[c.id] = r;
        console.log('$' + fmtNum(r.total) + ' · ' + r.proveedor.slice(0, 22) + ' · ' + r.renglones
          + ' reng · ' + (r.ms / 1000).toFixed(1) + 's · ' + fmtUSD(r.costo && r.costo.usd));
      } catch (err) {
        console.log('ERROR: ' + err.message);
        fila.corridas[c.id] = { error: err.message, preguntas: [], costo: null };
      }
    }
    resultados.push(fila);
  }

  // ── Paso 3: el informe.
  fs.writeFileSync(path.join(salida, 'crudo.json'), JSON.stringify({ combos, resultados, verdad }, null, 2));

  console.log('\n' + '─'.repeat(78));
  console.log('POR FACTURA — sólo se imprime el detalle donde las corridas NO coinciden');
  console.log('─'.repeat(78));

  const enDisputa = [];
  for (const f of resultados) {
    const vs = combos.map(c => f.corridas[c.id]).filter(r => r && !r.error);
    if (!vs.length) continue;
    const coincideTotal = vs.every(r => mismoTotal(r.total, vs[0].total));
    const coincideProv = vs.every(r => normProv(r.proveedor) === normProv(vs[0].proveedor));
    const coincideReng = vs.every(r => r.renglones === vs[0].renglones);
    const v = verdad[f.nombre];

    if (coincideTotal && coincideProv && coincideReng && !v) continue;
    enDisputa.push(f.nombre);
    console.log('\n' + f.nombre + (v
      ? '   (verdad: $' + fmtNum(v.total) + ' · ' + (v.proveedor || '—') + ' · ' + (v.renglones == null ? '—' : v.renglones) + ' reng)'
      : ''));
    for (const c of combos) {
      const r = f.corridas[c.id];
      if (!r) continue;
      if (r.error) { console.log('  ' + c.id.padEnd(30) + 'ERROR ' + r.error); continue; }
      const marcas = [];
      if (!coincideTotal) marcas.push('total ' + (r.confTotal >= UMBRAL ? 'afirmado' : 'dudado') + ' (' + r.confTotal + ')');
      if (!coincideProv) marcas.push('prov ' + (r.confProveedor >= UMBRAL ? 'afirmado' : 'dudado') + ' (' + r.confProveedor + ')');
      console.log('  ' + c.id.padEnd(30) + ('$' + fmtNum(r.total)).padStart(13) + ' · '
        + (r.proveedor || '—').slice(0, 24).padEnd(24) + ' · ' + String(r.renglones).padStart(2) + ' reng'
        + (marcas.length ? '   ← ' + marcas.join(', ') : ''));
    }
  }
  if (!enDisputa.length) console.log('\nNinguna. Las cuatro corridas leyeron lo mismo en todas las facturas.');

  console.log('\n' + '─'.repeat(78));
  console.log('RESUMEN POR COMBINACIÓN');
  console.log('─'.repeat(78));
  console.log('combinación'.padEnd(30) + 'errores'.padEnd(10) + 'VETOS'.padEnd(8) + 'preguntas'.padEnd(11) + 'seg'.padEnd(7) + 'USD');

  const refId = combos[0].id; // Opus + grande: la línea de base contra la que se juzga.
  const resumen = [];
  for (const c of combos) {
    let errTotal = 0, errProv = 0, vetos = 0, preguntas = 0, ms = 0, usd = 0, fallas = 0;
    const detalleVetos = [];
    for (const f of resultados) {
      const r = f.corridas[c.id];
      if (!r || r.error) { fallas++; continue; }
      preguntas += r.preguntas.length;
      ms += r.ms;
      usd += (r.costo && r.costo.usd) || 0;
      // La referencia: la verdad si la hay, si no la corrida base.
      const base = f.corridas[refId];
      const ref = verdad[f.nombre] || (base && !base.error ? base : null);
      if (!ref) continue;
      if (ref.total != null && !mismoTotal(r.total, ref.total)) {
        errTotal++;
        // El único resultado que veta: total distinto Y confianza alta.
        if (r.confTotal >= UMBRAL) {
          vetos++;
          detalleVetos.push(f.nombre + ': leyó $' + fmtNum(r.total) + ' (conf ' + r.confTotal + ') vs $' + fmtNum(ref.total));
        }
      }
      if (ref.proveedor && normProv(r.proveedor) !== normProv(ref.proveedor)) errProv++;
    }
    resumen.push({ id: c.id, errTotal, errProv, vetos, preguntas, ms, usd, fallas, detalleVetos });
    console.log(
      c.id.padEnd(30) +
      (errTotal + 't/' + errProv + 'p').padEnd(10) +
      String(vetos).padEnd(8) +
      String(preguntas).padEnd(11) +
      (ms / 1000 / resultados.length).toFixed(1).padEnd(7) +
      fmtUSD(usd) + (fallas ? '   (' + fallas + ' fallaron)' : '')
    );
  }

  console.log('\n  errores = lecturas distintas de la referencia (t=total, p=proveedor).');
  console.log(Object.keys(verdad).length
    ? '  Referencia: el archivo --verdad.'
    : '  Referencia: "' + refId + '" (no se pasó --verdad). Las diferencias son DESACUERDOS,\n'
      + '  no errores probados: hay que mirar las facturas en disputa y decidir quién tiene razón.');
  console.log('  preguntas = campos bajo el umbral, sumados. MÁS PREGUNTAS NO ES PEOR.');
  console.log('  VETOS = total distinto afirmado con confianza alta. Uno solo alcanza para no cambiar.\n');

  const base = resumen[0];
  const candidato = resumen.find(r => r.id !== base.id && /haiku/i.test(r.id) && /chica/.test(r.id)) || resumen[resumen.length - 1];
  console.log('─'.repeat(78));
  console.log('EL CRITERIO, APLICADO');
  console.log('─'.repeat(78));
  if (candidato.vetos > 0) {
    console.log('❌ NO se cambia. ' + candidato.id + ' escribió ' + candidato.vetos + ' total(es) mal con confianza alta:');
    candidato.detalleVetos.forEach(d => console.log('     ' + d));
  } else if (candidato.errTotal + candidato.errProv <= base.errTotal + base.errProv) {
    const ahorro = base.usd > 0 ? Math.round((1 - candidato.usd / base.usd) * 100) : 0;
    console.log('✅ Se puede cambiar. ' + candidato.id + ' no se equivoca más que ' + base.id);
    console.log('   (' + (candidato.errTotal + candidato.errProv) + ' vs ' + (base.errTotal + base.errProv)
      + '), pregunta ' + candidato.preguntas + ' veces contra ' + base.preguntas + ',');
    console.log('   y cuesta ' + ahorro + '% menos sobre esta muestra.');
  } else {
    console.log('⚠️  Se equivoca más, pero sin vetos: ' + (candidato.errTotal + candidato.errProv)
      + ' vs ' + (base.errTotal + base.errProv) + '.');
    console.log('   Mirá el detalle de arriba: si todo lo que cambió fue que preguntó, se cambia igual.');
  }
  console.log('\nDetalle crudo en ' + path.join(salida, 'crudo.json'));
}

main().catch(e => { console.error(e); process.exit(1); });
