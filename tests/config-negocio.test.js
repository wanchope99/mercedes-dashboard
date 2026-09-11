// ─── Que la segunda instancia no le cambie nada a la primera ─────────────────
//
// El 09/09/2026 la app dejó de ser de un solo bar. La parametrización se hizo
// con una regla: **cada default es el de Mercedes**, así que una instancia sin
// ninguna variable nueva se comporta exactamente como antes.
//
// Esa regla no se puede verificar leyendo el código —son cuatro módulos y una
// derivación condicional— y el modo de fallar es el peor disponible: un medio de
// pago que deja de ser el nombre exacto de una caja no da ningún error, sólo
// deja de sumar en el SUMIFS de la hoja `Cajas`. Para siempre. Por eso las
// listas se pinnean acá, valor por valor y en orden.
//
// La segunda mitad ejercita el loader de cuentas por entorno corriendo el código
// REAL de server.js —extraído como texto, porque requerir server.js levanta el
// servidor—, que es el mismo truco que ya usan compra-sin-monto y recepcion.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const RUTA_CONFIG = path.join(RAIZ, 'src', 'config-negocio.js');

// Las variables que este archivo manipula. Se limpian antes de cada carga y se
// restauran después, para que una suite no le deje el entorno sucio a la
// siguiente — `npm test` corre todo en el mismo proceso.
const CLAVES = ['CAJAS', 'CAJA_EFECTIVO', 'CAJA_MP', 'CAJA_ECHEQ', 'NEGOCIO_ID',
  'NEGOCIO_NOMBRE', 'NEGOCIO_CIUDAD', 'MODULOS_OFF', 'MEDIOS_LIBRO', 'MEDIOS_PAGO',
  'CUENTAS_PROPINAS', 'CAJAS_FUERA_DEL_LIBRO', 'CAJA_POZO', 'CAJA_POZO_USD'];

// Recarga config-negocio con un entorno dado. Hay que sacarlo del cache de
// require: el módulo lee process.env una sola vez, al cargarse.
function cargarConfig(env) {
  const previo = {};
  for (const k of CLAVES) { previo[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env || {});
  for (const m of ['config-negocio', 'medios-pago']) {
    delete require.cache[require.resolve(path.join(RAIZ, 'src', m + '.js'))];
  }
  const cfg = require(RUTA_CONFIG);
  const medios = require(path.join(RAIZ, 'src', 'medios-pago.js'));
  for (const k of CLAVES) {
    if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k];
  }
  return { cfg, medios };
}

// El loader de cuentas de server.js, corrido de verdad. Se corta por texto entre
// dos anclas estables; si alguna se mueve, esto tira en vez de pasar en falso.
function cargarLoaderDeUsuarios() {
  const src = fs.readFileSync(path.join(RAIZ, 'src', 'server.js'), 'utf8');
  const desde = src.indexOf('const ROLES_VALIDOS =');
  const hasta = src.indexOf('// Se listan al arrancar');
  if (desde < 0 || hasta < 0 || hasta < desde) {
    throw new Error('no se encontró el bloque de USUARIOS en server.js');
  }
  const cuerpo = src.slice(desde, hasta);
  // `pablo` se precarga para poder verificar que una clave repetida no lo pisa.
  return new Function('process', 'console', `
    const USUARIOS = Object.create(null);
    function _registrarUsuario(clave, { password, rol, nombre }) {
      if (!password) return;
      USUARIOS[clave] = { password, rol, nombre };
    }
    USUARIOS.pablo = { password: 'x', rol: 'admin', nombre: 'Pablo' };
    ${cuerpo}
    return { USUARIOS, _declarados };
  `);
}


// `cajasDe` vive en public/index.html, que no tiene build ni módulos. Se saca
// como texto entre dos anclas y se corre de verdad, con NEGOCIO inyectado — el
// mismo truco que usan menu-compras y recepcion para el resto de ese archivo.
function cargarCajasDe() {
  const idx = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
  const desde = idx.indexOf('function cajasDe(modo) {');
  const hasta = idx.indexOf('// Inserta las cajas en cada select');
  if (desde < 0 || hasta < 0 || hasta < desde) {
    throw new Error('no se encontró cajasDe en index.html');
  }
  const fabrica = new Function('NEGOCIO', idx.slice(desde, hasta) + '\nreturn cajasDe;');
  return negocio => fabrica(negocio);
}

// Las nueve cajas de Mercedes, en el orden en que estaban escritas en
// medios-pago.js antes de que config-negocio.js existiera.
const CAJAS_MERCEDES = [
  'Efectivo Local', 'Efectivo Pablo', 'Efectivo Tincho',
  'Mercado Pago Tincho', 'Mercado Pago Pablo',
  'Galicia', 'USD Pablo', 'USD Tincho', 'MP Pablo USD',
];

function run(t) {
  // ── Sin ninguna variable: Mercedes tal cual estaba ──────────────────────────
  const { cfg, medios } = cargarConfig({});

  t.eq(cfg.CAJAS, CAJAS_MERCEDES, 'sin CAJAS, la lista es la de Mercedes y en orden');
  t.eq(medios.MEDIOS_CANONICOS, CAJAS_MERCEDES, 'medios-pago expone esa misma lista');
  t.eq(cfg.CAJA_EFECTIVO, 'Efectivo Local', 'la caja del arqueo en efectivo no se movió');
  t.eq(cfg.CAJA_MP, 'Mercado Pago Tincho', 'la caja del arqueo de Mercado Pago no se movió');
  t.eq(cfg.CAJA_POZO, 'Mercado Pago Pablo', 'el pozo sigue siendo la cuenta de siempre');
  t.eq(cfg.CAJA_POZO_USD, 'MP Pablo USD', 'el vault en dólares sigue siendo el de siempre');
  t.eq(cfg.CUENTAS_PROPINAS, ['Galicia', 'Brubank'], 'las cuentas de propinas no se movieron');
  t.eq(cfg.NEGOCIO_NOMBRE, 'Bar Mercedes', 'el nombre por defecto es el de Mercedes');
  t.ok(cfg.esMercedes(), 'sin NEGOCIO_ID la instancia es Mercedes');

  // El orden de MEDIOS_LIBRO es por uso real (215/201/176/58/22) y NO se deriva:
  // derivarlo reordenaría el desplegable que el encargado ve todas las noches.
  t.eq(cfg.MEDIOS_LIBRO,
    ['Mercado Pago Tincho', 'Galicia', 'Efectivo Local', 'Efectivo Pablo', 'Efectivo Tincho'],
    'MEDIOS_LIBRO mantiene su orden por uso real');
  t.eq(cfg.MEDIOS_PAGO,
    ['Efectivo Local', 'Mercado Pago Tincho', 'Galicia', 'Echeq', 'Otro'],
    'MEDIOS_PAGO mantiene su lista corta');

  // MEDIOS_COMPRA es MEDIOS_LIBRO más el pozo, EN ESE ORDEN. Desde el
  // 10/09/2026 también son los botones del bot de facturas, que hasta ese día
  // mostraba MEDIOS_LIBRO: si el orden se derivara de CAJAS, incorporar el pozo
  // habría reordenado en silencio los cinco botones que ya estaban.
  t.eq(cfg.MEDIOS_COMPRA,
    ['Mercado Pago Tincho', 'Galicia', 'Efectivo Local', 'Efectivo Pablo',
      'Efectivo Tincho', 'Mercado Pago Pablo'],
    'MEDIOS_COMPRA es el orden de MEDIOS_LIBRO con el pozo al final');

  // El gasto rápido sigue sin ofrecer el pozo, y las cajas en dólares no las
  // ofrece nadie. Las dos cosas son decisiones, no olvidos.
  t.ok(!cfg.MEDIOS_LIBRO.includes('Mercado Pago Pablo'), 'el pozo no se ofrece en el libro');
  t.ok(!cfg.MEDIOS_LIBRO.some(c => /USD/i.test(c)), 'ninguna caja en dólares se ofrece en el libro');
  t.ok(!cfg.MEDIOS_COMPRA.some(c => /USD/i.test(c)), 'ni una compra se paga en dólares');
  t.ok(!cfg.MEDIOS_PAGO.includes('Mercado Pago Pablo'),
    'la hoja Compras no cambió: MEDIOS_PAGO sigue siendo la lista corta de siempre');

  // Normalización: lo que ya andaba tiene que seguir andando igual.
  t.eq(medios.normalizarMedio('efectivo'), 'Efectivo Local', '"efectivo" pelado va al cajón del bar');
  t.eq(medios.normalizarMedio('mercado pago'), 'Mercado Pago Tincho', '"mercado pago" va a la operativa');
  t.eq(medios.normalizarMedio('GALICIA'), 'Galicia', 'la capitalización se corrige');
  t.eq(medios.normalizarMedio('echeq'), 'Galicia', 'un echeq sale del banco');
  t.eq(medios.normalizarMedio(''), '', 'vacío sigue siendo válido (fila madre de cuotas)');
  t.ok(medios.esLegacy('Legacy'), '"Legacy" sigue siendo legacy');
  t.ok(!medios.esLegacy('Efectivo Local'), 'una caja real no es legacy');

  // ── Con CAJAS seteada: otra instancia ───────────────────────────────────────
  const otro = cargarConfig({
    CAJAS: 'Efectivo Local,Mercado Pago Pulpo,Santander,USD Pulpo',
    NEGOCIO_ID: 'pulperia',
    NEGOCIO_NOMBRE: 'Pulpería Soler',
    MODULOS_OFF: 'propinas,arqueo,plan',
  });

  t.eq(otro.cfg.CAJAS.length, 4, 'la lista es la que se declaró');
  t.eq(otro.cfg.CAJA_EFECTIVO, 'Efectivo Local', 'la caja de efectivo se deriva de la lista');
  t.eq(otro.cfg.CAJA_MP, 'Mercado Pago Pulpo', 'la caja de Mercado Pago se deriva de la lista');
  t.ok(!otro.cfg.esMercedes(), 'con otro NEGOCIO_ID la instancia no es Mercedes');
  t.eq(otro.cfg.MEDIOS_LIBRO, ['Efectivo Local', 'Mercado Pago Pulpo', 'Santander'],
    'la caja en dólares queda fuera del libro también acá');
  t.eq(otro.cfg.MEDIOS_PAGO,
    ['Efectivo Local', 'Mercado Pago Pulpo', 'Santander', 'Echeq', 'Otro'],
    'MEDIOS_PAGO se deriva agregando Echeq y Otro');

  // Sin una caja que se llame Galicia, el echeq NO se traduce: mandarlo a una
  // caja inexistente escribiría en Movimientos un medio que ningún SUMIFS suma.
  t.eq(otro.medios.CAJA_ECHEQ, '', 'sin banco declarado no hay destino para el echeq');
  t.eq(otro.medios.normalizarMedio('echeq'), 'echeq', 'el echeq se deja tal cual y se ve como legacy');

  t.ok(!otro.cfg.moduloActivo('propinas'), 'un módulo en MODULOS_OFF queda apagado');
  t.ok(!otro.cfg.moduloActivo('ARQUEO'), 'la comparación de módulos no distingue mayúsculas');
  t.ok(otro.cfg.moduloActivo('pagos'), 'un módulo que no está en la lista queda activo');

  // El navegador recibe la configuración, sin secretos.
  const paraWeb = JSON.stringify(otro.cfg.paraElNavegador());
  t.ok(paraWeb.includes('Mercado Pago Pulpo'), 'las cajas viajan al navegador');
  t.ok(!/password|secret|token|jwt/i.test(paraWeb), 'no viaja ningún secreto al navegador');

  // Volver a cargar sin nada tiene que devolver Mercedes: si el entorno quedara
  // sucio, las suites que corren después verían las cajas de otro negocio.
  t.eq(cargarConfig({}).cfg.CAJAS, CAJAS_MERCEDES, 'el entorno queda limpio para la suite siguiente');


  // ── Los desplegables de caja del navegador ─────────────────────────────────
  //
  // Hasta el 09/09/2026 estas listas estaban escritas a mano en el HTML. Se
  // pinnean acá los MIEMBROS de cada una contra lo que decía cada select, porque
  // ofrecer una caja de más —o de menos— en el formulario de compra es escribir
  // en Movimientos un medio que la hoja Cajas no suma, o no poder registrar un
  // gasto que sí existe. El orden sí cambió a propósito: ahora los cuatro
  // desplegables comparten el orden de la lista de cajas, que antes no compartían.
  const cajasDe = cargarCajasDe()(cargarConfig({}).cfg.paraElNavegador());
  const juntos = xs => xs.slice().sort();

  t.eq(juntos(cajasDe('compra')),
    juntos(['Efectivo Local', 'Efectivo Pablo', 'Efectivo Tincho', 'Galicia',
      'Mercado Pago Tincho', 'Mercado Pago Pablo']),
    'Nueva compra ofrece las mismas seis cajas que ofrecía escrito a mano');
  t.eq(juntos(cajasDe('libro')),
    juntos(['Efectivo Local', 'Efectivo Tincho', 'Efectivo Pablo',
      'Mercado Pago Tincho', 'Galicia']),
    'el gasto rápido ofrece las mismas cinco de siempre');
  t.eq(juntos(cajasDe('filtro')),
    juntos(['Efectivo Local', 'Efectivo Pablo', 'Efectivo Tincho', 'Galicia']),
    'el filtro de Pagos no lista las cuentas que ya cubre el grupo Mercado Pago');
  t.eq(cajasDe('propinas'), ['Galicia', 'Brubank'], 'propinas ofrece sus dos cuentas');

  // La primera opción es la que queda elegida por defecto en los selects que no
  // tienen una opción vacía adelante. Era Efectivo Local y tiene que seguir siéndolo.
  t.eq(cajasDe('compra')[0], 'Efectivo Local', 'Nueva compra sigue abriendo en Efectivo Local');
  t.eq(cajasDe('libro')[0], 'Efectivo Local', 'el gasto rápido sigue abriendo en Efectivo Local');

  // Ninguna caja en dólares llega a un formulario que escribe en Movimientos.
  t.ok(!cajasDe('compra').some(c => /USD/i.test(c)), 'ninguna caja en dólares en Nueva compra');
  t.ok(!cajasDe('libro').some(c => /USD/i.test(c)), 'ninguna caja en dólares en el gasto rápido');

  // La etiqueta del grupo se deriva y tiene que salir con el texto que estaba
  // escrito a mano en el HTML, letra por letra.
  t.eq(cargarConfig({}).cfg.paraElNavegador().grupos,
    [{ valor: 'Mercado Pago', label: 'Mercado Pago (Tincho y Pablo)' }],
    'el grupo del filtro conserva su etiqueta exacta');

  // Otra instancia: sin dos cuentas del mismo prefijo no hay grupo que ofrecer.
  const otroWeb = cargarConfig({
    CAJAS: 'Efectivo Local,Mercado Pago Pulpo,Santander', NEGOCIO_ID: 'pulperia',
  }).cfg.paraElNavegador();
  t.eq(otroWeb.grupos, [], 'con una sola cuenta de Mercado Pago no se agrupa nada');
  const cajasOtro = cargarCajasDe()(otroWeb);
  t.eq(cajasOtro('compra'), ['Efectivo Local', 'Mercado Pago Pulpo', 'Santander'],
    'otra instancia ofrece sus propias cajas');
  t.eq(cajasOtro('propinas'), [], 'sin cuentas de propinas declaradas no se ofrece ninguna');

  // Sin configuración cargada, cajasDe no devuelve nada y el HTML queda como está.
  t.eq(cargarCajasDe()(null)('compra'), null, 'sin config no se toca ningún desplegable');

  // ── El loader de cuentas por entorno ────────────────────────────────────────
  const loader = cargarLoaderDeUsuarios();
  const correr = env => loader({ env }, { warn() {}, error() {}, log() {} });

  const nada = correr({});
  t.eq(Object.keys(nada.USUARIOS), ['pablo'], 'sin USUARIOS no se agrega ninguna cuenta');

  const ok = correr({ USUARIOS: 'pulpo:admin:Pulpo', USUARIO_PULPO_PASSWORD: 'secreta' });
  t.eq(ok.USUARIOS.pulpo, { password: 'secreta', rol: 'admin', nombre: 'Pulpo' },
    'una cuenta declarada se crea con su rol y su nombre');

  const sinPass = correr({ USUARIOS: 'pulpo:admin:Pulpo' });
  t.ok(!sinPass.USUARIOS.pulpo, 'sin su variable de contraseña, la cuenta no existe');

  const sinNombre = correr({ USUARIOS: 'pulpo:encargado', USUARIO_PULPO_PASSWORD: 'x' });
  t.eq(sinNombre.USUARIOS.pulpo.nombre, 'Pulpo', 'sin nombre se usa la clave capitalizada');
  t.eq(sinNombre.USUARIOS.pulpo.rol, 'encargado', 'el rol declarado se respeta');

  // Un rol inválido se rechaza en vez de asumirse: asumir `encargado` daría
  // menos permisos de los que se quisieron dar y asumir `admin` daría de más,
  // y la segunda es la que no se puede deshacer.
  const rolMalo = correr({ USUARIOS: 'pulpo:jefe:Pulpo', USUARIO_PULPO_PASSWORD: 'x' });
  t.ok(!rolMalo.USUARIOS.pulpo, 'un rol que no existe no crea la cuenta');

  const sinRol = correr({ USUARIOS: 'pulpo', USUARIO_PULPO_PASSWORD: 'x' });
  t.ok(!sinRol.USUARIOS.pulpo, 'sin rol declarado no se crea la cuenta');

  // Una clave repetida no puede cambiar quién es 'pablo'.
  const choque = correr({ USUARIOS: 'pablo:encargado:Otro', USUARIO_PABLO_PASSWORD: 'y' });
  t.eq(choque.USUARIOS.pablo, { password: 'x', rol: 'admin', nombre: 'Pablo' },
    'una cuenta ya existente no se pisa desde USUARIOS');

  const varias = correr({
    USUARIOS: 'pulpo:admin:Pulpo, barra:encargado:La Barra ',
    USUARIO_PULPO_PASSWORD: 'a', USUARIO_BARRA_PASSWORD: 'b',
  });
  t.eq(Object.keys(varias.USUARIOS).sort(), ['barra', 'pablo', 'pulpo'],
    'se pueden declarar varias cuentas separadas por coma');
  t.eq(varias.USUARIOS.barra.nombre, 'La Barra', 'los espacios alrededor se recortan');
  t.eq(varias._declarados, [['pulpo', 'USUARIO_PULPO_PASSWORD'], ['barra', 'USUARIO_BARRA_PASSWORD']],
    'las cuentas declaradas entran al log de arranque con su variable');

  // ── Devolver el caché de require a Mercedes ────────────────────────────────
  //
  // `cargarConfig` limpia el ENTORNO al salir, pero el módulo que queda en el
  // caché de require es el de la última carga — acá, el de Pulpería. Cualquier
  // suite que después haga `require('../src/config-negocio')` recibiría las
  // cajas del otro bar, y eso no da error: da afirmaciones que fallan por algo
  // que no tiene nada que ver con lo que estaban probando. Lo encontró
  // `recepcion.test.js` el 10/09/2026, que es la primera que lo requiere.
  cargarConfig({});
  t.eq(require(RUTA_CONFIG).CAJAS, CAJAS_MERCEDES,
    'la suite deja Mercedes cargado en el caché de require, no la otra instancia');
}

module.exports = { nombre: 'La app corre para más de un negocio', run };
