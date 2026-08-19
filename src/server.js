require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const {
  getMovimientos, getResumenMensual, getActividadPorDia,
  getActividadPorDiaSemana, getCajas, getMovimientosCambio,
  getComprasEnCuotas,
  getMeses, getCategorias, clearCache, TC_FALLBACK,
} = require('./sheets');
const { getServicios, getServicioDetalle, getServicioDebug, resnapshotDia, resnapshotTodos, getDetallesTodos, getDetallesFrescos, getAgregadoProductos, getProductoDebug, getVentaDebugCrudo, clearFudoCache, fechaServicio: fechaServicioDe, fechaServicioHoy, probeStock, probeStockMovements, getVentasItems, getVentasConCosto } = require('./fudo');
const vinos = require('./vinos');
const { proyectar, calcularCalculadora, proyeccionMes, calcularBaselines } = require('./proyecciones');
const proveedoresRoutes = require('./proveedores-routes');
const prov = require('./proveedores');
const costos = require('./costos');
const costosProveedores = require('./costos-proveedores');
const cats = require('./proveedores-categorias');
const consumo = require('./consumo');
const cierres = require('./cierres');
const plan = require('./plan');
const tc = require('./tc');
const tcMovimientos = require('./tc-movimientos');
const roi = require('./roi');
const finanzas = require('./finanzas');
const informes = require('./informes');
const informesNotas = require('./informes-notas');
const propinas = require('./propinas');
const mantenimiento = require('./mantenimiento');
const pedidos = require('./pedidos');
const nomina = require('./nomina');
const cierreCocina = require('./cierre-cocina');
const notificaciones = require('./notificaciones');
const stockBebidas = require('./stock-bebidas');
const { iniciarCron } = require('./cron');
const { cargarEstadoCaja, guardarEstadoCaja } = require('./estado-caja');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Las fotos de facturas viajan en base64 dentro del JSON → subir el límite.
app.use(express.json({ limit: '25mb' }));

// Railway pone un proxy adelante, así que sin esto `req.ip` es SIEMPRE la IP del
// proxy: el límite de intentos de login contaría a todo el mundo en el mismo
// bucket y el primero que se equivoque diez veces deja afuera a los demás.
app.set('trust proxy', 1);

// ─── Config ───────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
// Sin default a propósito. El repositorio es público: un JWT_SECRET escrito acá
// no es una red de seguridad, es la llave publicada — con ella cualquiera se
// firma un token que diga `rol: admin` y entra sin necesitar ninguna contraseña.
// Por eso el server NO arranca sin esta variable: quedarse sin app avisa; quedar
// abierto con una llave conocida no avisa nunca.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error(
    'FALTA JWT_SECRET.\n' +
    'El server no arranca sin ella: es la clave con la que se firman los tokens de sesión.\n' +
    'Cargala en Railway (Settings -> Variables) o en el .env local. Un valor largo y aleatorio.'
  );
  process.exit(1);
}

// Usuarios: credenciales desde variables de entorno.
//
// ESTE REPOSITORIO ES PÚBLICO (ver .gitignore). Ninguna contraseña real va acá
// adentro: se configuran como variables de entorno en Railway. Los usuarios que
// no tienen su variable seteada simplemente NO existen — mejor que no poder
// entrar es que exista una cuenta cuya clave está publicada.
//
// `pablo` y `tincho` son cuentas propias con los mismos permisos que admin. Son
// separadas y no un login compartido porque el JWT lleva el `usuario`, que es lo
// que después permite mandarle notificaciones a cada uno por su lado.
//
// `charly`, `juan` y `ezequiel` son el personal: rol `encargado`. Cada uno con
// su cuenta por la misma razón —lo que se marca en Pedidos y en Mantenimiento
// queda firmado con el nombre de quien lo marcó, y con un login compartido eso
// sería una firma que no dice nada.
const USUARIOS = Object.create(null);

function _registrarUsuario(clave, { password, rol, nombre }) {
  if (!password) return;   // sin contraseña configurada, la cuenta no se crea
  USUARIOS[clave] = { password, rol, nombre };
}

_registrarUsuario('admin',  { password: process.env.ADMIN_PASSWORD,  rol: 'admin',     nombre: 'Administrador' });
_registrarUsuario('charly', { password: process.env.CHARLY_PASSWORD, rol: 'encargado', nombre: 'Charly' });
_registrarUsuario('pablo',  { password: process.env.PABLO_PASSWORD,  rol: 'admin',     nombre: 'Pablo' });
_registrarUsuario('tincho', { password: process.env.TINCHO_PASSWORD, rol: 'admin',     nombre: 'Tincho' });
_registrarUsuario('juan',   { password: process.env.JUAN_PASSWORD,   rol: 'encargado', nombre: 'Juan' });
_registrarUsuario('ezequiel', { password: process.env.EZEQUIEL_PASSWORD, rol: 'encargado', nombre: 'Ezequiel' });

// Se listan al arrancar (sin las claves). Una cuenta sin su variable no se crea,
// y eso desde afuera se ve igual que una contraseña mal tipeada: este log es la
// diferencia entre "me equivoqué al escribirla" y "esa cuenta no existe acá".
const _cuentas = Object.keys(USUARIOS);
if (!_cuentas.length) {
  console.error('NO HAY NINGUNA CUENTA HABILITADA. Cargá al menos ADMIN_PASSWORD; nadie puede entrar.');
} else {
  console.log(`Cuentas habilitadas: ${_cuentas.join(', ')}`);
  for (const [clave, envVar] of [
    ['admin', 'ADMIN_PASSWORD'], ['charly', 'CHARLY_PASSWORD'], ['pablo', 'PABLO_PASSWORD'],
    ['tincho', 'TINCHO_PASSWORD'], ['juan', 'JUAN_PASSWORD'], ['ezequiel', 'EZEQUIEL_PASSWORD'],
  ]) {
    if (!USUARIOS[clave]) console.warn(`  · "${clave}" deshabilitado: falta ${envVar}`);
  }
}

// ─── Límite de intentos de login ──────────────────────────────────────────────
//
// El login no tenía ningún freno: se podían probar contraseñas de a miles. Con
// la app en una URL pública, la fuerza de la clave era lo único que paraba a un
// script.
//
// Se cuentan sólo los intentos FALLIDOS, en dos cubetas a la vez:
//
//   · por IP + usuario — el freno real. 10 intentos cada 15 minutos.
//   · por usuario solo — 30 cada 15 minutos. Existe porque la IP se puede
//     falsificar: detrás de un proxy, `req.ip` sale del header X-Forwarded-For y
//     alguien que lo rote se renueva la cubeta de IP cada vez. La de usuario no
//     se puede esquivar, porque para probar una clave hay que nombrar la cuenta.
//
// Los 30 por usuario son deliberadamente holgados: es un número al que una
// persona real no llega tipeando mal, así que nadie deja afuera a Charly en
// medio del servicio a propósito. Un login correcto borra las dos cubetas.
//
// En memoria, como el resto del estado de esta app. Se pierde si el server
// reinicia — aceptable: reiniciar no es algo que un atacante pueda provocar.
const LOGIN_MAX_POR_IP = 10;
const LOGIN_MAX_POR_USUARIO = 30;
const LOGIN_VENTANA_MS = 15 * 60 * 1000;
const intentosLogin = new Map();

function _cubeta(clave) {
  const b = intentosLogin.get(clave);
  if (!b || Date.now() > b.hasta) return null;   // vencida = como si no existiera
  return b;
}

function _sumarFallo(clave) {
  const b = _cubeta(clave);
  if (b) b.fallos++;
  else intentosLogin.set(clave, { fallos: 1, hasta: Date.now() + LOGIN_VENTANA_MS });

  // Purga perezosa: sin esto el Map crece sin techo con cada IP que pruebe algo.
  if (intentosLogin.size > 5000) {
    const ahora = Date.now();
    for (const [k, v] of intentosLogin) if (ahora > v.hasta) intentosLogin.delete(k);
  }
}

// Estado de caja en memoria (persiste mientras el servidor esté corriendo)
let estadoCaja = {
  abierta: false,
  apertura: null,         // timestamp ISO
  encargado: null,
  efectivoInicial: null,
  mpInicial: null,
  galiciaInicial: null,
  gastosSesion: [],       // gastos registrados con la caja abierta (hielo, etc.)
};

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function getAuth() {
  const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : require('../../credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.rol !== 'admin') return res.status(403).json({ ok: false, error: 'Sin permisos' });
  next();
}

// El informe diario va a UNA persona, no a un rol. Es el primer permiso de esta
// app que mira quién es el usuario en vez de qué rol tiene: los tres logins de
// admin tienen exactamente los mismos permisos, así que el rol no alcanza para
// distinguirlos. Va por variable de entorno para poder cambiar el destinatario
// sin tocar código.
const INFORMES_DESTINATARIO = (process.env.INFORMES_DESTINATARIO || 'tincho').toLowerCase();

function soloDestinatarioInformes(req, res, next) {
  if (req.user?.usuario !== INFORMES_DESTINATARIO) {
    return res.status(403).json({ ok: false, error: 'Sin permisos' });
  }
  next();
}

// ─── Login ────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  const nombreUsuario = (usuario || '').toString().toLowerCase();
  const clavePorIp = `ip:${req.ip}|${nombreUsuario}`;
  const clavePorUsuario = `usr:${nombreUsuario}`;

  const porIp = _cubeta(clavePorIp);
  const porUsuario = _cubeta(clavePorUsuario);
  if ((porIp && porIp.fallos >= LOGIN_MAX_POR_IP) ||
      (porUsuario && porUsuario.fallos >= LOGIN_MAX_POR_USUARIO)) {
    const hasta = Math.max(porIp ? porIp.hasta : 0, porUsuario ? porUsuario.hasta : 0);
    const segundos = Math.max(1, Math.ceil((hasta - Date.now()) / 1000));
    const minutos = Math.ceil(segundos / 60);
    res.set('Retry-After', String(segundos));
    return res.status(429).json({
      ok: false,
      error: `Demasiados intentos fallidos. Probá de nuevo en ${minutos} minuto${minutos !== 1 ? 's' : ''}.`,
    });
  }

  const user = USUARIOS[nombreUsuario];
  // Se exige que la contraseña venga y no esté vacía. Sin este chequeo, un
  // usuario sin clave configurada más un body sin `password` comparaba
  // undefined contra undefined y dejaba entrar. USUARIOS además se crea sin
  // prototipo, así que pedir el usuario "constructor" no devuelve nada.
  if (!user || !user.password || typeof password !== 'string' || !password || user.password !== password) {
    _sumarFallo(clavePorIp);
    _sumarFallo(clavePorUsuario);
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  }

  // Entró bien: se borra lo acumulado para que equivocarse un par de veces antes
  // de acertar no deje al usuario a mitad de camino del bloqueo.
  intentosLogin.delete(clavePorIp);
  intentosLogin.delete(clavePorUsuario);
  const token = jwt.sign(
    { usuario: usuario.toLowerCase(), rol: user.rol, nombre: user.nombre },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  // `usuario` viaja al browser porque hay pantallas que se muestran por persona
  // y no por rol (el informe diario). El permiso real lo decide el servidor.
  res.json({ ok: true, token, usuario: nombreUsuario, rol: user.rol, nombre: user.nombre });
});

// Verificar token vigente
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ ok: true, usuario: req.user.usuario, rol: req.user.rol, nombre: req.user.nombre });
});

// ─── Filas de Movimientos que genera un cierre de caja ───────────────────────
// Regla de registración:
//  · Si hay datos de Fudo: por cada caja (Efectivo / MP) se registra el ingreso
//    según FUDO, y si lo contado difiere, una fila aparte por el DELTA
//    (Ingreso si sobra, Gasto si falta) con descripción explícita.
//    Así la planilla siempre matchea con Fudo y la diferencia queda a la vista.
//  · Sin datos de Fudo: se registra el delta contado (comportamiento anterior).
//  · Galicia: el ingreso se registra en BRUTO; la comisión del posnet (Bruto − Neto)
//    va como Gasto · Financieros. El neto queda como resultado, discriminado.
// gastosEfectivoSesion / gastosMPSesion: gastos YA registrados en Movimientos con la
// caja abierta (ej: hielo). Reducen el esperado y NO deben generar fila delta duplicada.
// ─── Zona horaria: TODA la app muestra horarios en Buenos Aires, Argentina ──────
const TZ_AR = 'America/Argentina/Buenos_Aires';
function fechaAR(d = new Date()) { return d.toLocaleDateString('es-AR', { timeZone: TZ_AR }); }
function horaAR(d = new Date()) { return d.toLocaleTimeString('es-AR', { timeZone: TZ_AR, hour: '2-digit', minute: '2-digit' }); }
function fechaHoraAR(d = new Date()) { return d.toLocaleString('es-AR', { timeZone: TZ_AR }); }

function buildFilasCierreServicio({ fechaServicio, mesServicio, descripcionServicio, deltaEfectivo, deltaMP, galiciaBruto, impuestos, fudo, gastosEfectivoSesion = 0, gastosMPSesion = 0 }) {
  const ingreso = (medio, monto, desc) => [
    fechaServicio, mesServicio, 'Ingreso', 'Pagado', '', '', '', '',
    'Servicio', 'Ingreso', desc || descripcionServicio,
    medio, monto, '', '', '',
  ];
  const gasto = (medio, monto, desc, categoria = 'Operativos') => [
    fechaServicio, mesServicio, 'Gasto', 'Pagado', '', '', '', '',
    'Servicio', categoria, desc,
    medio, '', '', monto, '',
  ];

  const rows = [];
  const fudoOk = fudo && fudo.encontrado;

  const registrarCaja = (medio, delta, fudoMonto, gastosSesion, etiqueta) => {
    if (fudoOk) {
      if (fudoMonto > 0) rows.push(ingreso(medio, fudoMonto));
      // El esperado del delta contado es: ventas Fudo − gastos pagados de la caja
      // durante el servicio (esos gastos ya tienen su propia fila en Movimientos).
      const diff = Math.round((delta - (fudoMonto - gastosSesion)) * 100) / 100;
      if (diff > 0.005) {
        rows.push(ingreso(medio, diff, `${descripcionServicio} delta ${etiqueta}`));
      } else if (diff < -0.005) {
        rows.push(gasto(medio, Math.abs(diff), `${descripcionServicio} delta ${etiqueta} (faltante)`));
      }
    } else if (delta > 0) {
      // Sin Fudo: delta + gastos de sesión = ingreso bruto del día por esa caja
      rows.push(ingreso(medio, delta + gastosSesion));
    }
  };

  // El medio se escribe con el nombre EXACTO de la caja: las fórmulas de la hoja
  // Cajas suman por texto exacto, así que un "Mercado Pago" a secas después del
  // rename a "Mercado Pago Tincho" sería plata que ninguna caja vuelve a sumar.
  registrarCaja(CAJA_EFECTIVO, deltaEfectivo, fudoOk ? (Number(fudo.efectivo) || 0) : 0, gastosEfectivoSesion, 'efectivo');
  registrarCaja(CAJA_MP, deltaMP, fudoOk ? (Number(fudo.mercadoPago) || 0) : 0, gastosMPSesion, 'mercado pago');

  // Galicia: ingreso BRUTO + impuestos (comisión del posnet) como gasto financiero
  // → resultado neto discriminado
  if (galiciaBruto > 0) rows.push(ingreso('Galicia', galiciaBruto));
  if (impuestos > 0) {
    rows.push(gasto('Galicia', impuestos, descripcionServicio, 'Financieros'));
  }
  return rows;
}

// ─── Cajas: resolución de filas por NOMBRE, no por número ─────────────────────
//
// Las filas de la hoja "Cajas" estaban hardcodeadas en el código (F8 = Efectivo
// Local, F2 = Mercado Pago). El 24/07/2026 se agregó "Mercado Pago Pablo" en la
// fila 3 y TODO lo de abajo se corrió una fila: F8 pasó a ser Efectivo Pablo.
// Con las filas fijas la app habría leído el saldo de OTRA caja al abrir y
// posteado un ajuste de efectivo de cientos de miles de pesos contra un esperado
// que no era el suyo — y habría pisado el saldo real de Efectivo Pablo al cerrar.
//
// Por eso ahora la fila se busca por el nombre de la columna A. Insertar, borrar
// o reordenar cajas en la planilla deja de romper el arqueo.
const CAJA_EFECTIVO = process.env.CAJA_EFECTIVO || 'Efectivo Local';
const CAJA_MP       = process.env.CAJA_MP       || 'Mercado Pago Tincho';

let _filasCajasCache = { at: 0, mapa: null };

async function filasCajas(sheets) {
  if (_filasCajasCache.mapa && Date.now() - _filasCajasCache.at < 60_000) {
    return _filasCajasCache.mapa;
  }
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Cajas!A:A',
  });
  const mapa = new Map();
  (r.data.values || []).forEach((row, i) => {
    const nombre = (row?.[0] || '').toString().trim();
    if (nombre && nombre.toLowerCase() !== 'caja') mapa.set(nombre.toLowerCase(), i + 1);
  });
  _filasCajasCache = { at: Date.now(), mapa };
  return mapa;
}

// Fila de una caja, o error explícito. Fallar acá es MUCHO mejor que caer a una
// fila por defecto: un número leído de la caja equivocada se convierte en un
// ajuste escrito en Movimientos que después nadie puede explicar.
async function filaCaja(sheets, nombre) {
  const mapa = await filasCajas(sheets);
  const fila = mapa.get(nombre.toLowerCase());
  if (!fila) {
    throw new Error(
      `No encontré la caja "${nombre}" en la hoja Cajas (columna A). ` +
      `Cajas disponibles: ${[...mapa.keys()].join(', ') || 'ninguna'}.`
    );
  }
  return fila;
}

// ─── Arqueo de Cajas ──────────────────────────────────────────────────────────

// Encabezados canónicos de la hoja "Arqueo de Cajas" (A1:X1). Deben coincidir EXACTO
// con el orden en que se escribe rowArqueo y en que lee /api/arqueo/historial. Se
// reescriben en cada cierre para que la planilla se autocorrija (ver POST cerrar).
//
// A–O son las columnas históricas: NO se reordenan ni se reinterpretan, porque las
// filas viejas ya están escritas con ese layout. Todo lo nuevo se agrega de P en
// adelante, así el historial anterior sigue leyéndose bien (queda vacío en P–V).
//
// P–V existen para que la cuenta del efectivo quede COMPLETA y auditable en la
// propia fila. Antes solo se guardaba el resultado (columna O) pero no sus términos:
// el esperado nunca se persistía y los gastos del turno no quedaban en ningún lado,
// así que la diferencia del turno era imposible de verificar a posteriori.
const ARQUEO_HEADERS = [
  'Fecha', 'Apertura', 'Cierre', 'Duración',
  'Efectivo Local Inicial', 'Mercado Pago Inicial', 'Galicia Inicial',
  'Efectivo Local Final', 'Mercado Pago Final', 'Galicia Final',
  'Diff Efectivo Local Inicial', 'Diff Mercado Pago Inicial',
  'Notas', 'Ingreso Fudo efectivo', 'Diferencia Efectivo Turno',
  // ─── Efectivo: la cuenta completa, término por término ───
  'Encargado Apertura',           // P
  'Encargado Cierre',             // Q
  'Efectivo Esperado Inicial',    // R — Saldo Calculado de la caja de efectivo al abrir
  'Gastos Efectivo Turno',        // S — gastos en efectivo con la caja abierta
  'Efectivo Esperado Cierre',     // T — R real inicial + Fudo − gastos
  'Saldo Calculado al Cerrar',    // U — Saldo Calculado de la caja de efectivo al cerrar
  'Ajuste Apertura Posteado',     // V — fila de ajuste escrita en Movimientos al abrir
  // ─── Control de facturación (12 ago 2026) ───
  // W y X existen para que la confirmación de facturación del cierre quede
  // REGISTRADA. Sin esto el checkbox sería sólo un click que no deja rastro: no
  // habría forma de saber después qué noches se confirmó ni sobre qué monto.
  'Facturación Confirmada',       // W — quién y cuándo confirmó haber facturado
  'Bancarizado del Turno',        // X — monto Galicia según Fudo sobre el que se confirmó
];

// Diferencias de efectivo por debajo de esto se ignoran (redondeo, no plata real).
const TOLERANCIA_AJUSTE_EFECTIVO = 1;

// Lee el "Saldo Calculado" (columna F) de una caja en este instante.
//
// OJO con qué es este número: F = SUMIFS(entradas de la caja) −
// SUMIFS(salidas de la caja con Estado="Pagado"), acumulado sobre TODA la
// historia de Movimientos. No es el saldo del turno. Cambia sin que se agregue
// ninguna fila: basta con editar una fila vieja (completarle el medio de pago, o
// pasarla de "A pagar" a "Pagado") para que se mueva hoy. Por eso lo persistimos
// en el arqueo: sin la foto del momento, la diferencia es imposible de reconstruir.
async function leerSaldoCalculado(sheets, nombreCaja) {
  const fila = await filaCaja(sheets, nombreCaja);
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Cajas!F${fila}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const v = r.data.values?.[0]?.[0];
  const n = typeof v === 'number' ? v : (parseFloat(String(v ?? '0').replace(/[^0-9.-]/g, '')) || 0);
  // Redondear a 2 decimales acá, en la fuente. El SUMIFS de la planilla arrastra
  // el error de punto flotante y devuelve cosas como 1356999,9999999999981: eso
  // se mostraba crudo en la pantalla de apertura y, peor, se guardaba así en las
  // columnas R y U del arqueo. Son centavos que no existen.
  return Math.round(n * 100) / 100;
}

const leerSaldoCalculadoEfectivo = sheets => leerSaldoCalculado(sheets, CAJA_EFECTIVO);

// Postea en Movimientos la diferencia entre el efectivo contado y el que la
// planilla creía tener, para que el Saldo Calculado vuelva a coincidir con la plata real.
//
// Sin esta fila el desvío no se corrige nunca: la app escribía el conteo real en
// el "Saldo Real" (columna G) y en la hoja de arqueo, pero el "Saldo Calculado"
// (columna F) sale sólo de Movimientos. Así, cada diferencia no explicada quedaba
// archivada en la columna K del arqueo y la columna F seguía arrastrándola para
// siempre. Al 21/07/2026 ese arrastre era $122.164,43.
//
// Queda como un gasto/ingreso normal y explícito: se ve en el ledger, suma al
// resultado del mes y es auditable (dice quién, cuándo y contra qué esperado).
async function postearAjusteEfectivo(sheets, { diferencia, esperado, contado, encargado, momento }) {
  const monto = Math.abs(Math.round(diferencia * 100) / 100);
  const ahora = new Date();
  const [anio, mesNum, dia] = fechaServicioDe(ahora.toISOString()).split('-').map(Number);
  const fecha = `${String(dia).padStart(2, '0')}/${String(mesNum).padStart(2, '0')}/${String(anio).slice(-2)}`;
  const mesesNombres = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const sobra = diferencia > 0;
  const descripcion =
    `Ajuste de caja ${momento} — ${sobra ? 'sobrante' : 'faltante'} de ${fmtARS(monto)}. ` +
    `Contado ${fmtARS(contado)} vs esperado ${fmtARS(esperado)}. ` +
    `${encargado || 'sin usuario'} · ${fechaHoraAR(ahora)}`;

  // A:Fecha B:Mes C:Tipo D:Estado E:Venc F:Cuotas G:Extraord H:ID I:Proveedor
  // J:Categoría K:Descripción L:Medio M:EntradaARS N:EntradaUSD O:SalidaARS P:SalidaUSD
  //
  // Categoría = "Otros": la hoja Movimientos tiene una lista de validación en la
  // columna J y "Ajuste de Caja" NO está en ella — escribirlo dejaba la celda en
  // rojo/inválida. El ajuste se identifica por el Proveedor (columna I), que sí es
  // texto libre. Para el dashboard no cambia nada: getSuperGrupo() manda todo lo
  // que no reconoce al superGrupo "Otros", que es donde ya venía cayendo.
  const row = [
    fecha, mesesNombres[mesNum - 1], sobra ? 'Ingreso' : 'Gasto', 'Pagado', '', '', '', '',
    'Ajuste de Caja', 'Otros', descripcion,
    CAJA_EFECTIVO,
    sobra ? monto : '', '', sobra ? '' : monto, '',
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:P',
    valueInputOption: 'USER_ENTERED', requestBody: { values: [row] },
  });
  return { monto, sobra, descripcion };
}

function fmtARS(n) {
  return '$' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

// GET /api/arqueo/estado — estado actual de la caja
app.get('/api/arqueo/estado', authMiddleware, (req, res) => {
  res.json({ ok: true, data: estadoCaja });
});

// GET /api/arqueo/historial — log de todos los arqueos para troubleshooting.
// Foco EFECTIVO. Diferencia del turno = contado al cerrar − (inicial + Fudo efvo − gastos).
app.get('/api/arqueo/historial', authMiddleware, adminOnly, async (req, res) => {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Arqueo de Cajas!A:X',
    });
    const rows = r.data.values || [];
    const num = v => {
      if (v == null || v === '') return 0;
      const n = parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : 0;
    };
    const opt = v => (v == null || v === '') ? null : num(v);
    let start = 0;
    if (rows.length && String(rows[0][0] || '').trim().toLowerCase() === 'fecha') start = 1;
    const arqueos = [];
    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [];
      if (!row[0]) continue;
      arqueos.push({
        rowIndex: i + 1,
        fecha: (row[0] || '').toString().trim(),
        apertura: (row[1] || '').toString().trim(),
        cierre: (row[2] || '').toString().trim(),
        duracion: (row[3] || '').toString().trim(),
        efectivoInicial: num(row[4]),
        mpInicial: num(row[5]),
        efectivoFinal: num(row[7]),
        mpFinal: num(row[8]),
        galiciaFinal: num(row[9]),
        diffAperturaEfectivo: num(row[10]),
        diffAperturaMP: num(row[11]),
        nota: (row[12] || '').toString().trim(),
        ingresoFudoEfectivo: (row[13] != null && row[13] !== '') ? num(row[13]) : null,
        difEfectivoTurno: (row[14] != null && row[14] !== '') ? num(row[14]) : null,
        // P–V: vacíos en los arqueos anteriores a este cambio → null, no 0, para no
        // mostrar ceros inventados en filas donde el dato nunca se registró.
        encargadoApertura: (row[15] || '').toString().trim(),
        encargadoCierre: (row[16] || '').toString().trim(),
        efectivoEsperadoInicial: opt(row[17]),
        gastosEfectivoTurno: opt(row[18]),
        efectivoEsperadoCierre: opt(row[19]),
        saldoCalculadoAlCerrar: opt(row[20]),
        ajusteApertura: opt(row[21]),
      });
    }
    // Continuidad entre turnos (referencial): efvo abierto vs cerrado el turno previo.
    for (let i = 0; i < arqueos.length; i++) {
      if (i === 0) { arqueos[i].diffContinuidadEfectivo = null; continue; }
      arqueos[i].diffContinuidadEfectivo = Math.round((arqueos[i].efectivoInicial - arqueos[i - 1].efectivoFinal) * 100) / 100;
    }
    arqueos.reverse();
    res.json({ ok: true, data: arqueos });
  } catch (err) {
    console.error('Error /api/arqueo/historial:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/arqueo/saldos-iniciales — saldos esperados (columna F de la hoja
// Cajas) de las DOS cajas que se arquean cada noche. La fila se busca por nombre:
// no asumir F2/F8, que se corrieron al agregarse Mercado Pago Pablo.
app.get('/api/arqueo/saldos-iniciales', authMiddleware, async (req, res) => {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    // Cada caja se resuelve por separado y un fallo NO tumba la pantalla de
    // apertura: si una caja se renombró, se muestra la otra y se avisa cuál falta.
    // El local tiene que poder abrir igual.
    const leer = async nombre => {
      try { return { valor: await leerSaldoCalculado(sheets, nombre), error: null }; }
      catch (e) { console.error(`No se pudo leer el saldo de "${nombre}":`, e.message); return { valor: 0, error: e.message }; }
    };
    const [efvo, mp] = await Promise.all([leer(CAJA_EFECTIVO), leer(CAJA_MP)]);
    res.json({
      ok: true,
      data: {
        efectivoEsperado: efvo.valor,
        mpEsperado: mp.valor,
        cajaEfectivo: CAJA_EFECTIVO,
        cajaMP: CAJA_MP,
        aviso: [efvo.error, mp.error].filter(Boolean).join(' · ') || null,
      },
    });
  } catch (err) {
    console.error('Error leyendo saldos iniciales:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/arqueo/abrir
//
// El esperado de EFECTIVO no se toma del body: se relee el Saldo Calculado acá, en el server.
// El valor que mandaba el cliente venía de cuando se cargó la pantalla y podía estar
// viejo — y ese saldo se mueve solo cuando alguien edita cualquier fila de Movimientos.
// Comparar contra un esperado viejo era, justamente, una de las formas de generar
// una diferencia que después nadie podía explicar.
app.post('/api/arqueo/abrir', authMiddleware, async (req, res) => {
  if (estadoCaja.abierta) {
    return res.status(400).json({ ok: false, error: 'La caja ya está abierta' });
  }
  // efectivo/mercadoPago = saldo REAL contado; mpEsperado = saldo del sheet
  const { efectivo, mercadoPago, mpEsperado } = req.body;
  if (efectivo === undefined || mercadoPago === undefined) {
    return res.status(400).json({ ok: false, error: 'Faltan valores de saldo inicial' });
  }

  const contado = Number(efectivo);
  let esperadoEfectivo = Number(req.body.efectivoEsperado || 0);
  let ajuste = null;
  let avisoAjuste = null;

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    esperadoEfectivo = await leerSaldoCalculadoEfectivo(sheets);

    const diferencia = Math.round((contado - esperadoEfectivo) * 100) / 100;
    if (Math.abs(diferencia) > TOLERANCIA_AJUSTE_EFECTIVO) {
      ajuste = await postearAjusteEfectivo(sheets, {
        diferencia, esperado: esperadoEfectivo, contado,
        encargado: req.user.nombre, momento: 'apertura',
      });
      clearCache();
    }
  } catch (err) {
    // Que falle el ajuste no puede impedir abrir la caja: el local tiene que operar.
    // Queda avisado en la respuesta y sin fila de ajuste (el desvío sigue vivo).
    console.error('No se pudo postear el ajuste de apertura:', err.message);
    avisoAjuste = 'No se pudo escribir el ajuste en la planilla: ' + err.message;
  }

  const diffEfectivo = Math.round((contado - esperadoEfectivo) * 100) / 100;
  const diffMP       = Number(mercadoPago) - Number(mpEsperado || 0);
  estadoCaja = {
    abierta: true,
    apertura: new Date().toISOString(),
    encargado: req.user.nombre,
    efectivoInicial: contado,
    mpInicial: Number(mercadoPago),
    efectivoEsperado: esperadoEfectivo,
    mpEsperado: Number(mpEsperado || 0),
    diffEfectivoInicial: diffEfectivo,
    diffMPInicial: diffMP,
    ajusteApertura: ajuste ? (ajuste.sobra ? ajuste.monto : -ajuste.monto) : 0,
    gastosSesion: [],
  };
  guardarEstadoCaja(estadoCaja); // respaldo en planilla, no bloquea la respuesta
  res.json({ ok: true, data: estadoCaja, diffEfectivo, diffMP, ajuste, avisoAjuste });
});

// POST /api/arqueo/cerrar
app.post('/api/arqueo/cerrar', authMiddleware, async (req, res) => {
  if (!estadoCaja.abierta) {
    return res.status(400).json({ ok: false, error: 'La caja no está abierta' });
  }
  // Guard contra doble cierre simultáneo
  if (estadoCaja.cerrando) {
    return res.status(400).json({ ok: false, error: 'El cierre ya está en proceso' });
  }
  estadoCaja.cerrando = true;

  // galicia = Total Bruto; galiciaNeto = Total Neto Acreditado
  // impuestos se calcula como Bruto - Neto
  // fudo = ingresos del día según Fudo { encontrado, efectivo, mercadoPago, galicia }
  const { efectivo, mercadoPago, galicia, galiciaNeto, fudo, nota, facturacionConfirmada } = req.body;
  if (efectivo === undefined || mercadoPago === undefined || galicia === undefined) {
    estadoCaja.cerrando = false;
    return res.status(400).json({ ok: false, error: 'Faltan valores de saldo final' });
  }

  // Control de facturación: el cierre no se escribe sin la confirmación explícita.
  // La regla vive ACÁ y no sólo en el botón deshabilitado del navegador porque un
  // control que se puede saltear con una request a mano no es un control. Ver
  // 04_decisiones/2026-08-12-control-de-facturacion-en-el-cierre.md.
  if (facturacionConfirmada !== true) {
    estadoCaja.cerrando = false;
    return res.status(400).json({
      ok: false,
      error: 'Falta confirmar que se emitieron las facturas de este servicio. No se cerró la caja.',
    });
  }

  const cierre = new Date();
  // La fecha del servicio corresponde al día de APERTURA de caja
  const apertura = new Date(estadoCaja.apertura);
  const duracionMs = cierre - apertura;
  const horas = Math.floor(duracionMs / 3_600_000);
  const minutos = Math.floor((duracionMs % 3_600_000) / 60_000);
  const duracionStr = `${horas}h ${minutos}m`;

  // Fecha del servicio = día de APERTURA del TURNO, con el mismo corte que Fudo
  // (16:00 hora AR). Así, aunque la caja se abra pasada la medianoche (ej: se
  // reabrió tras un redeploy), el servicio queda fechado en el día que abrió el
  // local. Ej: caja abierta 12/6 00:30 → servicio del 11/6.
  const [anioServ, mesServNum, diaServ] = fechaServicioDe(apertura.toISOString()).split('-').map(Number);
  const dd = String(diaServ).padStart(2, '0');
  const mm = String(mesServNum).padStart(2, '0');
  const yy = String(anioServ).slice(-2);
  const fechaServicio = `${dd}/${mm}/${yy}`;
  const mesesNombres = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const mesServicio = mesesNombres[mesServNum - 1];
  const descripcionServicio = `Servicio ${dd}/${mm}`;

  // Fechas para hoja Arqueo de Cajas — SIEMPRE en huso horario de Buenos Aires.
  const fechaStr = fechaAR(apertura);
  const aperturaStr = horaAR(apertura);
  const cierreStr = horaAR(cierre);

  // Impuestos = diferencia entre Bruto y Neto Acreditado
  const galiciaBruto = Number(galicia) || 0;
  const galiciaNetoVal = Number(galiciaNeto) || 0;
  // Avisos no fatales del cierre (ver paso 1b): el cierre igual se completa.
  let avisoCajas = null;
  let avisoGalicia = null;
  let impuestos = galiciaBruto > galiciaNetoVal ? galiciaBruto - galiciaNetoVal : 0;

  // Guarda contra el "Neto Acreditado" mal tipeado. El campo Neto se carga a mano
  // (el Bruto viene precargado de Fudo), así que un blanco o un dedazo se traduce
  // 1:1 en la comisión: el 28/07/2026 se cargó neto = 1 contra un bruto de
  // $1.285.500 y quedó un gasto Financieros de $1.285.499 — el servicio entero
  // contabilizado como comisión. Una comisión de posnet real anda en pocos puntos;
  // por encima de este techo no es una comisión cara, es un dato equivocado, así
  // que NO se escribe la fila de gasto (el ingreso bruto sí) y se avisa. Perder la
  // comisión de un día y cargarla después es infinitamente más barato que meter un
  // gasto falso del tamaño de la venta en el resultado del mes.
  const COMISION_GALICIA_TECHO = 0.5;
  if (impuestos > 0 && impuestos > galiciaBruto * COMISION_GALICIA_TECHO) {
    avisoGalicia =
      `No se registró la comisión de Galicia: el Neto Acreditado cargado (${fmtARS(galiciaNetoVal)}) ` +
      `daría una comisión de ${fmtARS(impuestos)} sobre un bruto de ${fmtARS(galiciaBruto)} ` +
      `(${Math.round((impuestos / galiciaBruto) * 100)}%), lo que no es posible. ` +
      `El ingreso bruto sí quedó registrado. Revisá el neto en Nave y cargá la comisión a mano.`;
    console.error('[cierre] ' + avisoGalicia);
    impuestos = 0;
  }

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. Escribir en Arqueo de Cajas
    // Columnas (este es el orden REAL en que se escribe y se lee — la fila de
    // encabezados de la planilla debe respetar exactamente este orden):
    //   A: Fecha                     — día del servicio (apertura), hora AR
    //   B: Apertura                  — hora de apertura de caja
    //   C: Cierre                    — hora de cierre
    //   D: Duración                  — "Xh Ym"
    //   E: Efectivo Local Inicial       — efectivo contado al abrir
    //   F: Mercado Pago Inicial         — saldo MP al abrir
    //   G: Galicia Inicial              — ya no se usa, siempre vacío
    //   H: Efectivo Local Final         — efectivo contado al cerrar
    //   I: Mercado Pago Final           — saldo MP al cerrar
    //   J: Galicia Final                — total BRUTO de tarjetas (Galicia)
    //   K: Diff Efectivo Local Inicial  — efectivo contado al abrir − esperado (hoja Cajas)
    //   L: Diff Mercado Pago Inicial    — MP contado al abrir − esperado (hoja Cajas)
    //   M: Notas                        — nota de cierre (opcional)
    //   N: Ingreso Fudo efectivo        — ventas en efectivo del turno según Fudo
    //   O: Diferencia Efectivo Turno    — H − (E + N − gastos efvo del turno):
    //                                  sobrante (+) o faltante (−) de caja del turno
    // Diferencia REAL del turno (efectivo): lo contado al cerrar vs lo esperado según
    // ventas de Fudo. Esperado = inicial + Fudo efectivo − gastos en efectivo del turno.
    const fudoEfectivo = (fudo && fudo.encontrado) ? (Number(fudo.efectivo) || 0) : 0;
    // Bancarizado del turno según Fudo (QR + Débito + Crédito, los tres que
    // liquidan por Galicia). Es el monto que EXIGE comprobante y sobre el que se
    // confirmó la facturación; queda en la columna X del arqueo.
    const fudoGalicia = (fudo && fudo.encontrado) ? (Number(fudo.galicia) || 0) : 0;
    const _gastosEfvoTurno = (estadoCaja.gastosSesion || []).filter(g => g.bucket === 'efectivo').reduce((a, g) => a + g.monto, 0);
    const _esperadoEfvo = (estadoCaja.efectivoInicial || 0) + fudoEfectivo - _gastosEfvoTurno;
    const difEfectivoTurno = Math.round((Number(efectivo) - _esperadoEfvo) * 100) / 100;

    // Foto del Saldo Calculado ANTES de escribir las filas del cierre. Comparada contra el
    // efectivo contado muestra cuánto se había despegado la planilla de la realidad
    // durante el turno, que es la información que faltaba para poder auditar.
    let saldoCalculadoAlCerrar = '';
    try { saldoCalculadoAlCerrar = await leerSaldoCalculadoEfectivo(sheets); }
    catch (e) { console.error('No se pudo leer el Saldo Calculado al cerrar:', e.message); }

    const rowArqueo = [
      fechaStr,
      aperturaStr,
      cierreStr,
      duracionStr,
      estadoCaja.efectivoInicial,
      estadoCaja.mpInicial,
      '',                                    // Galicia inicial ya no se usa
      Number(efectivo),
      Number(mercadoPago),
      galiciaBruto,
      estadoCaja.diffEfectivoInicial || 0,   // K: Diff Efectivo Local Inicial
      estadoCaja.diffMPInicial || 0,         // L: Diff Mercado Pago Inicial
      (nota || '').toString().trim(),        // M: Nota de cierre (cuando no cierra)
      fudoEfectivo,                          // N: Ingreso Fudo (efectivo) del turno
      difEfectivoTurno,                      // O: Diferencia de efectivo del turno
      // ─── P–V: la cuenta del efectivo, completa y verificable ───
      estadoCaja.encargado || '',            // P: quién abrió
      req.user.nombre || '',                 // Q: quién cerró
      estadoCaja.efectivoEsperado ?? '',     // R: Saldo Calculado al abrir
      _gastosEfvoTurno,                      // S: gastos en efectivo del turno
      _esperadoEfvo,                         // T: esperado al cierre = E + N − S
      saldoCalculadoAlCerrar,                // U: Saldo Calculado al cerrar
      estadoCaja.ajusteApertura || 0,        // V: ajuste posteado al abrir
      // W: quién confirmó la facturación y cuándo. Se guarda el nombre, no un "SI":
      // dentro de un mes la pregunta no va a ser si alguien tildó, va a ser quién.
      `${req.user.nombre || 'usuario'} · ${cierre.toISOString()}`,
      // X: el monto bancarizado del turno según Fudo, que es sobre lo que se
      // confirmó. Sin esto la confirmación no dice sobre qué plata se confirmó.
      fudoGalicia,
    ];
    // Escribimos en una fila absoluta calculada a partir de la columna A, NO con
    // values.append. append detecta automáticamente una "tabla" y agrega la fila
    // alineada al borde izquierdo de esa tabla: si queda cualquier bloque de datos
    // suelto a la derecha (p. ej. una fila que alguna vez cayó corrida), append se
    // "engancha" a ese bloque y sigue escribiendo en columnas equivocadas (N en
    // adelante) fila tras fila. Con update sobre A{n}:O{n} la fila siempre cae en
    // las columnas correctas, sin importar qué haya suelto a la derecha.
    const colA = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Arqueo de Cajas!A:A',
    });
    const proxFila = (colA.data.values || []).length + 1;
    // Reescribimos SIEMPRE la fila de encabezados (A1:O1) junto con el dato. Así la
    // planilla se autocorrige: si los títulos quedaron desordenados o falta alguno,
    // el próximo cierre los deja en el orden exacto en que el código escribe/lee.
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Arqueo de Cajas!A1:X1', values: [ARQUEO_HEADERS] },
          { range: `Arqueo de Cajas!A${proxFila}:X${proxFila}`, values: [rowArqueo] },
        ],
      },
    });

    // 1b. Actualizar "Saldo Real" (columna G) de las dos cajas arqueadas. Las
    // filas se resuelven por nombre — escribir en una fila fija acá significaba
    // pisar el saldo real de la caja de otra persona.
    //
    // NO puede tumbar el cierre: si el nombre de una caja no matchea (alguien la
    // renombró en la planilla), este paso se saltea y se avisa. La columna G es
    // informativa; lo que no se puede perder son las filas de Movimientos que
    // vienen en el paso 2, y abortar acá las dejaba sin escribir con el arqueo
    // ya guardado — el peor de los estados posibles.
    try {
      const [filaEfvo, filaMP] = await Promise.all([
        filaCaja(sheets, CAJA_EFECTIVO),
        filaCaja(sheets, CAJA_MP),
      ]);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `Cajas!G${filaMP}`,   values: [[Number(mercadoPago)]] },
            { range: `Cajas!G${filaEfvo}`, values: [[Number(efectivo)]] },
          ],
        },
      });
    } catch (e) {
      console.error('No se pudo actualizar el Saldo Real en la hoja Cajas:', e.message);
      avisoCajas = 'El cierre se guardó bien, pero no se pudo actualizar el "Saldo Real" en la hoja Cajas: ' + e.message;
    }

    // 2. Escribir en Movimientos — columnas A:P
    // A:Fecha, B:Mes, C:Tipo Movimiento, D:Estado, E:Vencimiento, F:Cuotas,
    // G:Extraodinario, H:ID Compra, I:Proveedor, J:Categoría, K:Descripción,
    // L:Medio de Pago, M:Monto Entrada ARS, N:Monto Entrada USD, O:Monto Salida ARS, P:Monto Salida USD
    const deltaEfectivo = Number(efectivo) - estadoCaja.efectivoInicial;
    const deltaMP       = Number(mercadoPago) - estadoCaja.mpInicial;
    // Gastos registrados durante la sesión (server-side, no se confía en el cliente)
    const gastosSesion = estadoCaja.gastosSesion || [];
    const gastosEfectivoSesion = gastosSesion.filter(g => g.bucket === 'efectivo').reduce((s, g) => s + g.monto, 0);
    const gastosMPSesion = gastosSesion.filter(g => g.bucket === 'mp').reduce((s, g) => s + g.monto, 0);
    const rowsMovimientos = buildFilasCierreServicio({
      fechaServicio, mesServicio, descripcionServicio,
      deltaEfectivo, deltaMP,
      galiciaBruto, impuestos,
      fudo,
      gastosEfectivoSesion, gastosMPSesion,
    });
    if (rowsMovimientos.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Movimientos!A:P',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsMovimientos },
      });
    }

    clearCache();
  } catch (err) {
    estadoCaja.cerrando = false;  // liberar lock en caso de error
    console.error('Error guardando arqueo:', err.message);
    return res.status(500).json({ ok: false, error: 'Error al guardar en la planilla: ' + err.message });
  }

  const resumen = {
    fecha: fechaStr,
    apertura: aperturaStr,
    cierre: cierreStr,
    duracion: duracionStr,
    encargado: estadoCaja.encargado,
    efectivoInicial: estadoCaja.efectivoInicial,
    mpInicial: estadoCaja.mpInicial,
    efectivoFinal: Number(efectivo),
    mpFinal: Number(mercadoPago),
    galiciaBruto,
    galiciaNeto: galiciaNetoVal,
    impuestosGalicia: impuestos,
    difEfectivo: Number(efectivo) - estadoCaja.efectivoInicial,
    difMP: Number(mercadoPago) - estadoCaja.mpInicial,
  };

  // Resetear estado
  estadoCaja = { abierta: false, apertura: null, encargado: null, efectivoInicial: null, mpInicial: null, gastosSesion: [] };
  guardarEstadoCaja(estadoCaja); // respaldo en planilla, no bloquea la respuesta

  res.json({ ok: true, data: resumen, avisoCajas, avisoGalicia });
});

// POST /api/gastos-rapidos — gasto pagado en el momento (ej: hielo al empezar
// el servicio). Accesible para el encargado. Si la caja está ABIERTA y el medio
// es una de las dos cajas arqueadas (CAJA_EFECTIVO / CAJA_MP), se anota en la
// sesión para descontarlo del esperado en el cierre.
app.post('/api/gastos-rapidos', authMiddleware, async (req, res) => {
  try {
    const { fecha, mes, proveedor, categoria, monto, descripcion, estado } = req.body;
    const medioPago = normalizarMedio(req.body.medioPago);
    if (!fecha || !proveedor || !monto) {
      return res.status(400).json({ ok: false, error: 'Fecha, proveedor y monto son obligatorios' });
    }
    const estadoRow = (estado || 'Pagado') === 'A pagar' ? 'A pagar' : 'Pagado';
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const row = [fecha, mes || '', 'Gasto', estadoRow, '', '', '', '', proveedor, categoria || 'Insumos', descripcion || '', medioPago || '', '', '', Number(monto), ''];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:P',
      valueInputOption: 'USER_ENTERED', requestBody: { values: [row] },
    });
    clearCache();

    // Si la caja está abierta y es un gasto YA PAGADO desde una caja arqueada,
    // anotarlo para el cierre (el esperado descuenta este efectivo que salió).
    let registradoEnSesion = false;
    const medioLower = (medioPago || '').toLowerCase();
    if (estadoCaja.abierta && estadoRow === 'Pagado') {
      // Match EXACTO contra las dos cajas que se arquean. Un `includes('mercado
      // pago')` acá metería los gastos de Mercado Pago Pablo (la cuenta del
      // recupero, que no se arquea) dentro del esperado del turno.
      const bucket = medioLower === CAJA_EFECTIVO.toLowerCase() ? 'efectivo'
        : medioLower === CAJA_MP.toLowerCase() ? 'mp' : null;
      if (bucket) {
        estadoCaja.gastosSesion = estadoCaja.gastosSesion || [];
        estadoCaja.gastosSesion.push({
          bucket, monto: Number(monto),
          descripcion: descripcion || proveedor,
          ts: new Date().toISOString(),
          usuario: req.user.nombre,
        });
        registradoEnSesion = true;
        guardarEstadoCaja(estadoCaja); // respaldo en planilla, no bloquea la respuesta
      }
    }
    res.json({ ok: true, message: 'Gasto registrado', registradoEnSesion });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── El gasto de una factura del bot, en el libro ───────────────────────────────
//
// El circuito de facturas escribía sólo en la hoja `Compras` (una fila por
// producto, analítica). Desde el 12/08/2026 escribe ADEMÁS una única fila de
// gasto en `Movimientos`, con el total de la factura: sacar una foto pasa a ser
// una forma de anotar un gasto, no sólo de registrar precios.
//
// Vive acá y no en proveedores-routes porque necesita tres cosas que son de este
// archivo: `normalizarMedio` (la única puerta a la columna L), `estadoCaja` (el
// arqueo en curso) y `clearCache`. Se le pasa a las rutas como dependencia.
//
// TRES COSAS QUE NO SE PUEDEN SALTEAR, y cada una arruina algo distinto:
//
//  1. El medio tiene que ser el nombre EXACTO de una caja. El Saldo Calculado es
//     un SUMIFS por texto; cualquier otra cosa es plata que ninguna caja resta
//     nunca, sin ningún error a la vista. Acá se RECHAZA en vez de escribir mal:
//     el bot puede volver a preguntar, la planilla no se puede arreglar sola.
//
//  2. Idempotencia. El bot puede reintentar (timeout de red, doble toque), y en
//     todo el resto del libro no existe ninguna protección contra duplicados. El
//     id de la factura va en la columna H y se relee antes de escribir. Es la
//     misma columna que agrupa cuotas, por eso `getComprasEnCuotas` aprende a
//     saltear las filas que no son ni cuota ni madre.
//
//  3. Si la caja está abierta y el gasto salió de una de las dos cajas que se
//     arquean, hay que anotarlo en la sesión. Si no, el cierre de esa noche lo
//     cuenta como plata faltante y Charly ve una diferencia que no existe.
const ISO_FECHA = /^(\d{4})-(\d{2})-(\d{2})/;

// La planilla escribe las fechas como DD/MM/AAAA; el extractor las lee en ISO.
function aFechaPlanilla(fecha) {
  const s = (fecha || '').toString().trim();
  const m = s.match(ISO_FECHA);
  if (m) return `${Number(m[3])}/${Number(m[2])}/${m[1]}`;
  return s;   // ya viene como DD/MM/AAAA
}

function mesDeCualquierFecha(fecha) {
  const s = (fecha || '').toString().trim();
  const m = s.match(ISO_FECHA);
  if (m) return MESES_NOMBRES[Number(m[2]) - 1] || '';
  return mesDeFecha(s);
}

// Construye la fila, o explica por qué no se puede. PURA a propósito: es el
// contrato con la planilla (16 posiciones exactas, ni 15 ni 17 — todo lo que
// pase de P pisa Q/R/S/T, que están ocupadas) y se puede ejercitar sin escribir.
function construirFilaGasto({
  facturaId, fecha, proveedor, categoria, monto, descripcion,
  medioPago, estado, vencimiento,
} = {}) {
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    return { ok: false, motivo: 'monto', error: 'El total del gasto tiene que ser un número mayor que cero.' };
  }
  if (!proveedor) return { ok: false, motivo: 'proveedor', error: 'Falta el proveedor.' };
  if (!facturaId) return { ok: false, motivo: 'id', error: 'Falta el identificador de la factura.' };

  const medio = normalizarMedio(medioPago);
  if (!medio || !MEDIOS_CANONICOS.includes(medio)) {
    return {
      ok: false, motivo: 'medio',
      error: `"${medioPago || '(vacío)'}" no es una caja del sistema. El gasto NO se escribió: `
        + `si se registrara así, ninguna caja lo restaría del saldo. Cajas válidas: ${MEDIOS_CANONICOS.join(', ')}.`,
    };
  }

  const fechaRow = aFechaPlanilla(fecha) || aFechaPlanilla(new Date().toISOString());
  const mes = mesDeCualquierFecha(fecha) || mesDeCualquierFecha(new Date().toISOString());
  const estadoRow = estado === 'A pagar' ? 'A pagar' : 'Pagado';
  const categoriaRow = cats.normalizarCategoriaGasto(categoria) || 'Otros';

  const row = [
    fechaRow,                              // A Fecha
    mes,                                   // B Mes
    'Gasto',                               // C Tipo Movimiento
    estadoRow,                             // D Estado
    estadoRow === 'A pagar' ? (aFechaPlanilla(vencimiento) || '') : '',  // E Vencimiento
    '',                                    // F Cuotas
    '',                                    // G Extraodinario
    facturaId,                             // H ID Compra — la clave de idempotencia
    proveedor,                             // I Proveedor
    categoriaRow,                          // J Categoría
    descripcion || `Factura ${proveedor}`, // K Descripción
    medio,                                 // L Medio de pago
    '', '',                                // M/N Entradas
    montoNum,                              // O Salida ARS
    '',                                    // P Salida USD
  ];
  return { ok: true, row, medio, montoNum, estadoRow, categoria: categoriaRow, fechaRow, mes };
}

async function registrarGastoEnLibro(datos = {}) {
  const armado = construirFilaGasto(datos);
  if (!armado.ok) return armado;
  const { row, medio, montoNum, estadoRow, categoria, fechaRow, mes } = armado;
  const { facturaId, proveedor, descripcion, usuario } = datos;

  // Idempotencia: si ya hay una fila con este id de factura, no se escribe otra.
  //
  // Se lee SÓLO la columna H, no el movimiento entero. Contra Sheets lo caro es
  // la cantidad de llamadas, no el tamaño: getMovimientos() son dos llamadas
  // (A:T y T:T) más parsear 1.166 filas × 20 columnas, para mirar una sola
  // columna. Una lectura de H:H hace lo mismo en una llamada y sin parseo.
  const sheetsApi = google.sheets({ version: 'v4', auth: getAuth() });
  try {
    const r = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!H:H',
    });
    const col = r.data.values || [];
    const fila = col.findIndex(x => (x && x[0] ? x[0].toString().trim() : '') === facturaId);
    if (fila >= 0) return { ok: true, yaExistia: true, fila: fila + 1 };
  } catch (e) {
    // Si no se puede leer, NO se escribe: el riesgo de duplicar un gasto es peor
    // que el de pedir que se reintente.
    return { ok: false, motivo: 'lectura', error: `No se pudo verificar si la factura ya estaba cargada (${e.message}). No se escribió nada.` };
  }

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:P',
    valueInputOption: 'USER_ENTERED', requestBody: { values: [row] },
  });
  clearCache();

  // Gasto pagado desde una caja arqueada con la caja abierta → a la sesión.
  let registradoEnSesion = false;
  if (estadoCaja.abierta && estadoRow === 'Pagado') {
    const low = medio.toLowerCase();
    const bucket = low === CAJA_EFECTIVO.toLowerCase() ? 'efectivo'
      : low === CAJA_MP.toLowerCase() ? 'mp' : null;
    if (bucket) {
      estadoCaja.gastosSesion = estadoCaja.gastosSesion || [];
      estadoCaja.gastosSesion.push({
        bucket, monto: montoNum,
        descripcion: descripcion || proveedor,
        ts: new Date().toISOString(),
        usuario: usuario || 'bot',
      });
      registradoEnSesion = true;
      guardarEstadoCaja(estadoCaja);
    }
  }

  return { ok: true, monto: montoNum, medio, categoria: categoria || 'Otros', estado: estadoRow, fecha: fechaRow, mes, registradoEnSesion };
}

// GET /api/arqueo/fudo-hoy — ventas del día de servicio en curso según Fudo,
// agrupadas en Efectivo / Mercado Pago / Otros. Para el control de cierre de caja.
app.get('/api/arqueo/fudo-hoy', authMiddleware, async (req, res) => {
  try {
    clearFudoCache(); // datos frescos: es el momento de la verdad del arqueo
    const fecha = fechaServicioHoy();
    const det = await getServicioDetalle(fecha);
    if (!det || !det.encontrado) {
      return res.json({ ok: true, data: { fecha, encontrado: false, efectivo: 0, mercadoPago: 0, galicia: 0, otros: 0, total: 0, mediosPago: {} } });
    }
    // Mapeo de medios de pago de Fudo a cajas internas:
    //   Galicia = QR + Tarjeta Débito + Tarjeta Crédito (los 3 liquidan vía Nave en Galicia)
    //   Mercado Pago = transferencias/dinero en cuenta MP · Efectivo = efectivo
    let efectivo = 0, mercadoPago = 0, galicia = 0, otros = 0;
    for (const [nombre, monto] of Object.entries(det.mediosPago || {})) {
      const n = nombre.toLowerCase();
      if (n.includes('efectivo')) efectivo += monto;
      else if (n.includes('qr') || n.includes('tarj') || n.includes('credito') || n.includes('crédito') || n.includes('debito') || n.includes('débito') || n.includes('visa') || n.includes('master')) galicia += monto;
      else if (n.includes('mercado') || n === 'mp') mercadoPago += monto;
      else otros += monto;
    }
    res.json({ ok: true, data: { fecha, encontrado: true, efectivo, mercadoPago, galicia, otros, total: det.total, mediosPago: det.mediosPago } });
  } catch (err) {
    console.error('Error /api/arqueo/fudo-hoy:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Healthcheck público (para Railway) ──────────────────────────────────────
// ─── Gestión de Vinos / bebida con alcohol: inventario + rotación ──────────────
//
// El encargado (Charly) también entra acá, pero sólo a la parte de CIRCULANTE:
// qué bebidas hay, cuánto se vende por semana y cuántos días dura el stock. Nada
// de plata — ni costo, ni precio, ni margen, ni plata inmovilizada.
//
// El recorte se hace ACÁ y no en la pantalla a propósito: ocultar las columnas en
// el HTML deja la respuesta completa a un F12 de distancia. Lo que el rol no puede
// ver, no sale del servidor.
function vinosSoloCirculante(data) {
  return {
    ventanaDias: data.ventanaDias, desde: data.desde, hasta: data.hasta,
    generado: data.generado,
    totales: {
      items: data.totales.items,
      stockTotal: data.totales.stockTotal,
      enQuiebre: data.totales.enQuiebre,
      porAgotarse: data.totales.porAgotarse,
      sobrestock: data.totales.sobrestock,
    },
    items: (data.items || []).map(it => ({
      id: it.id, nombre: it.nombre, categoria: it.categoria, esVino: it.esVino,
      stock: it.stock, minStock: it.minStock,
      vendidasVentana: it.vendidasVentana, porSemana: it.porSemana,
      diasCobertura: it.diasCobertura, alerta: it.alerta,
    })),
    porCategoria: (data.porCategoria || []).map(c => ({
      categoria: c.categoria, items: c.items, stock: c.stock,
    })),
  };
}

app.get('/api/vinos', authMiddleware, async (req, res) => {
  try {
    const { desde, hasta, soloVino } = req.query;
    const data = await vinos.analizarVinos({ desde, hasta, soloVino: soloVino === '1' || soloVino === 'true' });
    res.json({ ok: true, data: req.user.rol === 'admin' ? data : vinosSoloCirculante(data) });
  } catch (err) {
    console.error('Error /api/vinos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DIAGNÓSTICO temporal: descubrir si Fudo expone el stock. Borrar tras usar.
app.get('/api/fudo/probe-stock', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await probeStock() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, status: 'ok' }));

// ─── Filtro de fecha ──────────────────────────────────────────────────────────
function parseFiltro(query) {
  const { mes, desde, hasta } = query;
  if (mes) return { mes };
  if (desde && hasta) {
    return { fechaDesde: new Date(desde), fechaHasta: new Date(hasta + 'T23:59:59') };
  }
  return {};
}

// ─── Dashboard endpoints (solo admin) ────────────────────────────────────────
app.get('/api/meses', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getMeses() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/categorias', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getCategorias() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/resumen', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getResumenMensual(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Cierres mensuales (ARS + USD) ────────────────────────────────────────────
// Histórico de cómo cerró cada mes en pesos y en dólares (TC fijo del período).

app.get('/api/cierres', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await cierres.listCierres() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/cierres/cerrar', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, tcUsd, nota, recuperoARS, extraordinariaARS } = req.body || {};
    if (!mes) return res.status(400).json({ ok: false, error: 'Falta el mes' });
    const resumen = await getResumenMensual({ mes });
    const m = (resumen || [])[0];
    if (!m) return res.status(404).json({ ok: false, error: 'No hay datos para el mes ' + mes });
    const data = await cierres.cerrarMes({
      mes,
      tcUsd: Number(tcUsd) || undefined,
      ingresosARS: m.ingresos.total,
      gastosARS: m.gastos.total,
      resultadoARS: m.resultadoNeto,
      nota,
      recuperoARS: Number(recuperoARS) || 0,
      extraordinariaARS: Number(extraordinariaARS) || 0,
    });
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Ajusta (o asigna retroactivamente) el reparto recupero/extraordinaria de un cierre.
app.put('/api/cierres/recupero', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, recuperoARS, extraordinariaARS } = req.body || {};
    if (!mes) return res.status(400).json({ ok: false, error: 'Falta el mes' });
    const data = await cierres.ajustarRecupero({
      mes,
      recuperoARS: recuperoARS != null ? Number(recuperoARS) : undefined,
      extraordinariaARS: extraordinariaARS != null ? Number(extraordinariaARS) : undefined,
    });
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.put('/api/cierres/tc', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, tcUsd } = req.body || {};
    const data = await cierres.ajustarTC({ mes, tcUsd: Number(tcUsd) });
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cierres/tc-default', authMiddleware, adminOnly, (req, res) => {
  res.json({ ok: true, data: { tcDefault: cierres.TC_DEFAULT } });
});

// Dólar blue en vivo (dolarapi) para prellenar el TC y valuar la brecha de ROI.
app.get('/api/tc-online', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await tc.getDolarBlue() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Progreso de recupero de la inversión (USD 60k por defecto).
app.get('/api/roi', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await roi.resumenRecupero() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-diaria', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getActividadPorDia(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/actividad-semana', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getActividadPorDiaSemana(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cajas', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await getCajas() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/cajas/medios-huerfanos — plata que ninguna caja está sumando.
//
// Las fórmulas de la hoja Cajas hacen SUMIFS por texto EXACTO contra la columna L
// de Movimientos. Cualquier fila con un medio de pago que no sea el nombre exacto
// de una caja es plata real que el "Saldo Calculado" nunca suma ni resta, y no
// hay nada en la planilla que lo avise: el saldo simplemente queda mal, para
// siempre, sin ningún error a la vista.
//
// Ya pasó dos veces. En julio/2026 había 124 filas cargadas como "Efectivo" a
// secas, invisibles para Efectivo Local. Y al renombrar la caja "Mercado Pago" a
// "Mercado Pago Tincho" (24/07/2026), toda fila que hubiera quedado con el nombre
// viejo pasó a ser huérfana de la noche a la mañana.
//
// Esto lo detecta solo. Es sólo lectura: reporta, no corrige.
//
// Medios del sistema VIEJO que quedan fuera del control a propósito. No son un
// error a corregir: son historia anterior a que las cajas existieran, y ya se
// revisaron una por una.
//   · "Efectivo" (124 filas): entradas y salidas dan exactamente lo mismo
//     ($40.234.922), o sea que netean en cero y no mueven ningún saldo.
//   · "Legacy" (29 filas): asientos de arrastre del sistema anterior.
// Se listan acá para que el aviso hable sólo de plata realmente descolgada.
const MEDIOS_LEGACY = (process.env.MEDIOS_LEGACY || 'Efectivo,Legacy')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

app.get('/api/cajas/medios-huerfanos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [cajas, movimientos] = await Promise.all([getCajas(), getMovimientos()]);
    const nombres = new Set(cajas.map(c => (c.caja || '').trim().toLowerCase()).filter(Boolean));

    const porMedio = new Map();
    for (const m of movimientos) {
      const medio = (m.medioPago || '').trim();
      // Vacío es válido y frecuente: es la fila madre de una compra en cuotas,
      // que a propósito no toca ninguna caja hasta que se paga cada cuota.
      if (!medio) continue;
      if (nombres.has(medio.toLowerCase())) continue;
      if (MEDIOS_LEGACY.includes(medio.toLowerCase())) continue;
      const e = porMedio.get(medio) || { medio, filas: 0, entradas: 0, salidas: 0, ultimaFecha: null, ejemploFila: null };
      e.filas++;
      e.entradas += m.entradaTotal || 0;
      e.salidas += m.salidaTotal || 0;
      if (!e.ultimaFecha || m.fecha > e.ultimaFecha) e.ultimaFecha = m.fecha;
      if (!e.ejemploFila) e.ejemploFila = m.rowIndex;
      porMedio.set(medio, e);
    }

    const huerfanos = [...porMedio.values()]
      .map(h => ({ ...h, ultimaFecha: h.ultimaFecha ? h.ultimaFecha.toISOString().split('T')[0] : null }))
      .sort((a, b) => b.filas - a.filas);

    res.json({
      ok: true,
      data: {
        huerfanos,
        totalFilas: huerfanos.reduce((s, h) => s + h.filas, 0),
        cajas: cajas.map(c => c.caja),
      },
    });
  } catch (err) {
    console.error('Error /api/cajas/medios-huerfanos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/cambios', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getMovimientosCambio(parseFiltro(req.query)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/movimientos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { tipo, categoria, estado } = req.query;
    let movimientos = await getMovimientos();
    if (!req.query.todos) movimientos = movimientos.filter(m => !m.esCambio && !m.esFondeo);
    const filtro = parseFiltro(req.query);
    if (filtro.mes) movimientos = movimientos.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movimientos = movimientos.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    if (tipo) movimientos = movimientos.filter(m => m.tipo === tipo);
    if (categoria) movimientos = movimientos.filter(m => m.categoria === categoria);
    if (estado) movimientos = movimientos.filter(m => m.estado.toLowerCase() === estado.toLowerCase());
    const data = movimientos.map(m => ({ ...m, fecha: m.fecha.toISOString().split('T')[0] }));
    res.json({ ok: true, data, total: data.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/refresh', authMiddleware, adminOnly, (req, res) => {
  clearCache();
  res.json({ ok: true, message: 'Cache limpiado.' });
});

// ─── Pagos (solo admin) ───────────────────────────────────────────────────────
// calcUrgencia vive en src/urgencia.js: la comparten esta seccion y las
// notificaciones, y tienen que clasificar igual.
const { calcUrgencia } = require('./urgencia');

app.get('/api/pagos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sort = 'vencimiento', medioPago, q } = req.query;
    const todos = await getMovimientos();
    const comprasCuotas = await getComprasEnCuotas();
    // Las filas MADRE de compras en cuotas no son pagables: se pagan sus cuotas
    let pagos = todos.filter(m => m.tipo === 'Gasto' && !m.pagado && !m.esCambio && !m.esFondeo && !m.esCompraEnCuotas);
    // Enriquecer cuotas con info de la compra (total, restante, medio de pago heredado)
    pagos = pagos.map(p => {
      if (!p.esCuota || !p.cuotaId || !comprasCuotas[p.cuotaId]) return p;
      const info = comprasCuotas[p.cuotaId];
      return {
        ...p,
        // Heredar medio de pago de la compra para agrupar (ej: tarjeta Galicia)
        medioPago: p.medioPago || info.medioPago || '',
        cuotaLabel: `${p.cuotaNum}/${p.cuotasTotal || info.cuotasTotal || '?'}`,
        compraTotal: info.totalCompra,
        compraPagado: info.pagadoAcum,
        compraRestante: info.restante,
        compraCuotasPagadas: info.cuotasPagadas,
        compraCuotasTotal: info.cuotasTotal,
      };
    });
    if (medioPago) pagos = pagos.filter(p => (p.medioPago || '').toLowerCase().includes(medioPago.toLowerCase()));
    if (q) pagos = pagos.filter(p => (p.proveedor || '').toLowerCase().includes(q.toLowerCase()));
    pagos = pagos.map(p => ({ ...p, fecha: p.fecha.toISOString().split('T')[0], ...calcUrgencia(p.vencimiento) }));
    const ordenU = { vencido: 0, hoy: 1, urgente: 2, proximo: 3, ok: 4, 'sin-fecha': 5 };
    if (sort === 'vencimiento') pagos.sort((a, b) => (ordenU[a.urgencia]||5) - (ordenU[b.urgencia]||5) || (a.diasHastaVenc||999) - (b.diasHastaVenc||999));
    else if (sort === 'monto') pagos.sort((a, b) => (b.salidaTotal||0) - (a.salidaTotal||0));
    else if (sort === 'proveedor') pagos.sort((a, b) => (a.proveedor||'').localeCompare(b.proveedor||''));
    else if (sort === 'formapago') pagos.sort((a, b) => (a.medioPago||'').localeCompare(b.medioPago||''));
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const finSemana = new Date(hoy); finSemana.setDate(hoy.getDate() + 7);
    const summary = {
      total: pagos.length,
      totalARS: pagos.reduce((s, p) => s + (p.salidaARS||0), 0),
      totalUSD: pagos.reduce((s, p) => s + (p.salidaUSD||0), 0),
      vencidos: pagos.filter(p => p.urgencia === 'vencido').length,
      estaSemanaCant: pagos.filter(p => p.vencDate && new Date(p.vencDate+'T12:00:00') <= finSemana && p.urgencia !== 'vencido').length,
      estaSemanaARS: pagos.filter(p => p.vencDate && new Date(p.vencDate+'T12:00:00') <= finSemana && p.urgencia !== 'vencido').reduce((s,p) => s+(p.salidaARS||0), 0),
    };
    res.json({ ok: true, data: pagos, summary });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Suma meses a una fecha dd/mm/yyyy manteniendo el día (con clamp a fin de mes)
function addMonthsDDMM(fechaStr, meses) {
  const parts = (fechaStr || '').split('/').map(Number);
  if (parts.length !== 3) return fechaStr;
  let [d, m, y] = parts;
  if (y < 100) y += 2000;
  const target = new Date(y, m - 1 + meses, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${String(day).padStart(2,'0')}/${String(target.getMonth()+1).padStart(2,'0')}/${target.getFullYear()}`;
}

const MESES_NOMBRES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function mesDeFecha(fechaStr) {
  const parts = (fechaStr || '').split('/').map(Number);
  return parts.length === 3 ? MESES_NOMBRES[parts[1] - 1] || '' : '';
}

// Un Echeq sale de la cuenta Galicia: en Movimientos se registra como Galicia.
// Las fórmulas de la hoja Cajas matchean el medio de pago por texto EXACTO
// (SUMIFS(... L:L, "Efectivo Local")). Cualquier variante — "Efectivo" a secas,
// "contado", otra capitalización — es plata que sale del cajón y que el saldo
// calculado nunca resta. Al 21/07/2026 había 124 filas cargadas como "Efectivo"
// invisibles para F8. Normalizamos acá, en la única puerta de entrada.
//
// "Efectivo Pablo" y "Efectivo Tincho" son cajas DISTINTAS de "Efectivo Local":
// se respetan tal cual y no se pisan entre sí. Lo mismo desde el 24/07/2026 con
// "Mercado Pago Tincho" (la operativa del bar, la que se arquea) y "Mercado Pago
// Pablo" (donde se coloca la plata del recupero): un "Mercado Pago" a secas es
// ambiguo y ninguna de las dos lo suma, así que se resuelve a la operativa.
// Los nombres van EXACTAMENTE como figuran en la columna A de la hoja Cajas: el
// Saldo Calculado es un SUMIFS por texto exacto contra la columna L de
// Movimientos, así que una diferencia de una letra vuelve esa plata invisible
// para el saldo, para siempre y sin ningún error a la vista.
//
// `MP Pablo USD` (12/08/2026) se llama así y no "MP USD Pablo": es la caja donde
// se vaultea en dólares una parte del capital de recupero. Su moneda sale de la
// columna C de la hoja (USD), no de acá — getCajas() ya la lee.
// MEDIOS_CANONICOS y normalizarMedio viven en src/medios-pago.js: los usa
// tambien la lectura, para que la app no muestre un 'Efectivo' que ya no ofrece.
const { MEDIOS_CANONICOS, normalizarMedio } = require('./medios-pago');

// Creación de compras/pagos: accesible también para el encargado (botón "Nueva compra"),
// a diferencia del listado (GET) y el marcado de pagado, que permanecen solo admin.
app.post('/api/pagos', authMiddleware, async (req, res) => {
  try {
    const { fecha, mes, proveedor, categoria, salidaARS, vencimiento, descripcion, cuotas, estado } = req.body;
    const medioPago = normalizarMedio(req.body.medioPago);
    const estadoRow = estado === 'Pagado' ? 'Pagado' : 'A pagar';
    if (!fecha || !proveedor) return res.status(400).json({ ok: false, error: 'Fecha y proveedor son obligatorios' });
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const nCuotas = parseInt(cuotas) || 1;
    let values;

    if (nCuotas > 1) {
      // Compra en cuotas: fila madre (importe total, sin medio de pago → no toca cajas,
      // computa completa en el estado de resultados del mes de compra) + una fila por cuota.
      if (!vencimiento) return res.status(400).json({ ok: false, error: 'Para cuotas indicá el vencimiento de la primera cuota' });
      const total = Number(salidaARS) || 0;
      const montoCuota = Math.round(total / nCuotas);  // cuotas enteras (ARS)
      const cuotaId = `${proveedor}-${fecha}`.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
      const descBase = descripcion || proveedor;
      // El Mes (col B) de TODAS las filas de la compra es el de la compra, no el del
      // vencimiento de cada cuota: a nivel negocio el gasto se devengó entero cuando se
      // compró. La col A (Fecha) y la E (Vencimiento) son las que dicen qué día sale la
      // plata de la caja. Poner el mes del vencimiento partía una compra de agosto en
      // Agosto/Septiembre/Octubre e inventaba meses futuros en los filtros.
      const mesCompra = mes || mesDeFecha(fecha);
      // Fila madre: estado "En cuotas", medio de pago vacío, col F = total de cuotas, col H = ID
      values = [[fecha, mesCompra, 'Gasto', 'En cuotas', '', String(nCuotas), '', cuotaId, proveedor, categoria||'', `${descBase} — Total en ${nCuotas} cuotas`, '', '', '', total, '']];
      for (let i = 1; i <= nCuotas; i++) {
        const venc = addMonthsDDMM(vencimiento, i - 1);
        // Ajuste última cuota para que la suma cierre exacta con el total
        const monto = i === nCuotas ? total - montoCuota * (nCuotas - 1) : montoCuota;
        // Medio de pago vacío hasta que se pague (las fórmulas de Cajas suman por medio):
        // al marcarla Pagado se completa el medio. El mes NO se toca al pagar.
        values.push([venc, mesCompra, 'Gasto', 'A pagar', venc, `${i}/${nCuotas}`, '', cuotaId, proveedor, categoria||'', `${descBase} — Cuota ${i}/${nCuotas}${medioPago ? ' ('+medioPago+')' : ''}`, '', '', '', monto, '']);
      }
    } else {
      // Pagado: sin vencimiento (ya salió de caja) · A pagar: con vencimiento
      values = [[fecha, mes||'', 'Gasto', estadoRow, estadoRow === 'Pagado' ? '' : (vencimiento||''), '', '', '', proveedor, categoria||'', descripcion||'', medioPago||'', '', '', salidaARS||'', '']];
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Movimientos!A:P',
      valueInputOption: 'USER_ENTERED', requestBody: { values },
    });
    clearCache();
    res.json({ ok: true, message: nCuotas > 1 ? `Compra en ${nCuotas} cuotas registrada (${values.length} filas)` : 'Compra registrada correctamente' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Lee la hoja Proveedores → { nombreLower: { nombre, formaPago, datosParaPagar, comentarios, plazoDias } }
async function leerProveedoresSheet() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Proveedores!A:H' });
  const rows = response.data.values || [];
  if (rows.length < 2) return {};
  let headerIdx = rows.findIndex(r => r && (r[0]||'').toString().trim().toLowerCase() === 'proveedor');
  if (headerIdx === -1) headerIdx = 0;
  const header = rows[headerIdx].map(h => (h||'').toString().trim().toLowerCase());
  const idxNombre = header.indexOf('proveedor');
  const idxFormaPago = header.findIndex(h => h.includes('forma') || h.includes('pago'));
  const idxDatos = header.findIndex(h => h.includes('datos') || h.includes('banco') || h.includes('cbu') || h.includes('alias'));
  const idxComentarios = header.findIndex(h => h.includes('comentario') || h.includes('nota'));
  const idxPlazo = header.findIndex(h => h.includes('plazo'));
  const proveedores = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[idxNombre]) continue;
    const nombre = (row[idxNombre]||'').trim();
    if (!nombre) continue;
    const plazoRaw = idxPlazo >= 0 ? parseInt(String(row[idxPlazo] || '').replace(/[^0-9]/g, '')) : NaN;
    proveedores[nombre.toLowerCase()] = {
      nombre, formaPago: idxFormaPago >= 0 ? (row[idxFormaPago]||'') : '',
      datosParaPagar: idxDatos >= 0 ? (row[idxDatos]||'') : '',
      comentarios: idxComentarios >= 0 ? (row[idxComentarios]||'') : '',
      plazoDias: Number.isFinite(plazoRaw) ? plazoRaw : null,
    };
  }
  return proveedores;
}

/**
 * Pasa una fila "A pagar" de Movimientos a "Pagado" MODIFICANDO la fila que ya
 * existe (no agrega línea): Estado (col D) → Pagado, y Medio de pago (col L) si
 * vino uno. La fecha de registración original se conserva.
 *
 * Vive como función y no adentro del handler porque tiene DOS entradas: el
 * botón "Pagar" de la sección Pagos y el "recibido y pagado" de Pedidos. Las
 * dos tienen que hacer exactamente lo mismo — incluido el efecto sobre el
 * arqueo en curso, que es lo que se olvida al copiar y pegar.
 *
 * Devuelve `{ ok: false, status, error }` en vez de tirar cuando el problema es
 * del pedido (la fila ya no está, ya figura pagada, la planilla cambió): son
 * respuestas para el usuario, no fallas del servidor.
 */
/**
 * Releer una fila "A pagar" y comprobar que sigue siendo la que el usuario
 * eligió. Las filas de Movimientos SE MUEVEN cuando alguien edita la planilla a
 * mano (ver la sección Cajas del CLAUDE.md), así que un rowIndex que viajó por
 * la red no es una identidad: es una pista que hay que confirmar antes de
 * escribir sobre ella. Marcar la fila equivocada como Pagada es peor que fallar.
 *
 * Vive aparte porque lo necesitan dos caminos con efectos distintos:
 * marcarFilaPagada (que la escribe) y el "queda a cuenta" de Pedidos (que sólo
 * la vincula, sin tocar nada). Dos validaciones separadas se desincronizan.
 */
async function verificarFilaPendiente({ rowIndex, proveedor } = {}) {
  const idx = parseInt(rowIndex);
  if (!idx || idx < 2) return { ok: false, status: 400, error: 'Falta el registro a pagar' };
  const movs = await getMovimientos();
  const m = movs.find(x => x.rowIndex === idx);
  if (!m) return { ok: false, status: 404, error: 'No se encontró el registro. Refrescá la página e intentá de nuevo.' };
  if (m.pagado) return { ok: false, status: 400, error: `"${m.proveedor}" ya figura como Pagado.` };
  if (proveedor && m.proveedor && proveedor.trim().toLowerCase() !== m.proveedor.toLowerCase()) {
    return { ok: false, status: 409, error: 'La planilla cambió desde que abriste el modal. Refrescá e intentá de nuevo.' };
  }
  return { ok: true, m, idx };
}

async function marcarFilaPagada({ rowIndex, proveedor, medioPago, usuario, descripcionSesion } = {}) {
  const v = await verificarFilaPendiente({ rowIndex, proveedor });
  if (!v.ok) return v;
  const { m, idx } = v;

  const medio = normalizarMedio(medioPago);
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const data = [{ range: `Movimientos!D${idx}`, values: [['Pagado']] }];
  if (medio) data.push({ range: `Movimientos!L${idx}`, values: [[medio]] });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  clearCache();

  // Si la caja esta ABIERTA, este dinero YA salio de una caja arqueada al pagar
  // la cuenta pendiente. Se anota en la sesion para descontarlo del esperado en el
  // cierre (igual que /api/gastos-rapidos). Asi NO aparece como faltante en el arqueo.
  // Caso real: pagar a un proveedor "A pagar" con MP estando la caja abierta.
  let registradoEnSesion = false;
  const medioEfectivoPago = (medio || m.medioPago || '').toLowerCase();
  const montoSalida = Number(m.salidaTotal || m.salidaARS || 0);
  if (estadoCaja.abierta && montoSalida > 0) {
    // Match exacto: sólo las dos cajas que se arquean afectan el esperado del
    // turno. Mercado Pago Pablo es la cuenta del recupero y no se arquea.
    const bucket = medioEfectivoPago === CAJA_EFECTIVO.toLowerCase() ? 'efectivo'
      : medioEfectivoPago === CAJA_MP.toLowerCase() ? 'mp' : null;
    if (bucket) {
      estadoCaja.gastosSesion = estadoCaja.gastosSesion || [];
      estadoCaja.gastosSesion.push({
        bucket, monto: montoSalida,
        descripcion: descripcionSesion || `Pago pendiente: ${m.proveedor}`,
        ts: new Date().toISOString(),
        usuario: usuario || '',
      });
      registradoEnSesion = true;
      // Respaldo en planilla. Este era el único camino que empujaba a
      // gastosSesion sin guardarlo: un reinicio de Railway entre el pago y el
      // cierre borraba el descuento y la noche cerraba con un faltante que no
      // existía. Los otros tres caminos ya lo hacían.
      guardarEstadoCaja(estadoCaja);
    }
  }
  return { ok: true, proveedor: m.proveedor, monto: m.salidaARS, medio, registradoEnSesion, rowIndex: idx };
}

// POST /api/pagos/pagar — el botón "Pagar" de la sección Pagos.
app.post('/api/pagos/pagar', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rowIndex, proveedor, medioPago } = req.body;
    const r = await marcarFilaPagada({ rowIndex, proveedor, medioPago, usuario: req.user.nombre });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    res.json({ ok: true, message: `${r.proveedor} marcado como Pagado`, ...r });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/movimientos/tc-pendientes — filas en dólares que todavía se valúan al
// fallback. Alimenta el panel de Cajas: sin esta lista, encontrarlas obligaría a
// abrir día por día en el dashboard buscando el chip marcado.
//
// Sólo filas con tcRelevante: los cambios y fondeos quedan afuera porque su TC no
// mueve ningún número reportado (ver el comentario en sheets.js). Siguen siendo
// editables desde el detalle del día si alguna vez hace falta; lo que no hacen es
// pedirlo.
app.get('/api/movimientos/tc-pendientes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const movs = await getMovimientos();
    const pendientes = movs
      .filter(m => m.tcRelevante && !m.tcConfirmado)
      .map(m => {
        const usd = m.entradaUSD || m.salidaUSD;
        return {
          rowIndex: m.rowIndex,
          fecha: m.fecha.toISOString().split('T')[0],
          fechaStr: m.fechaStr,
          mes: m.mes,
          tipo: m.tipo,
          proveedor: m.proveedor,
          descripcion: m.descripcion,
          medioPago: m.medioPago,
          usd,
          esEntrada: m.entradaUSD > 0,
          tcUsd: m.tcUsd,                          // el fallback con el que se valúa hoy
          arsProvisorio: Math.round(usd * m.tcUsd),
        };
      })
      .sort((a, b) => b.fecha.localeCompare(a.fecha));   // lo más reciente primero
    res.json({
      ok: true,
      data: {
        pendientes,
        tcFallback: TC_FALLBACK,
        totalUSD: pendientes.reduce((s, p) => s + p.usd, 0),
      },
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/movimientos/completar-tc — completa el blue del día (columna T) de
// las filas que no lo tengan. Es lo mismo que corre el cron a las 09:05; existe
// como endpoint para poder forzarlo y, sobre todo, para poder MIRARLO antes.
//
// dryRun viene en true por defecto a propósito: esto toca mil filas de la
// planilla de la que sale toda la plata del negocio, así que ver qué haría tiene
// que ser el camino por defecto y escribir tiene que ser una decisión explícita.
app.post('/api/movimientos/completar-tc', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    const r = await tcMovimientos.completarTC({ dryRun, limite: Number(req.body?.limite) || 0 });
    if (!dryRun && r.escritas > 0) clearCache();   // la próxima lectura ve los TC nuevos
    res.json({ ok: true, data: r });
  } catch (err) {
    console.error('Error /api/movimientos/completar-tc:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/movimientos/:fila/tc — carga el tipo de cambio de UNA fila (columna Q).
//
// La columna Q está oculta en la planilla a propósito: el TC no es un dato que se
// mire, es uno que hay que poder cargar sin que estorbe. Por eso el único lugar
// donde se edita es acá, desde el detalle del día en la app. Si en vez de esto se
// dejara la columna a la vista, cargarla sería ir a buscar la fila a mano en 1.055
// filas de Movimientos.
//
// No se acepta un TC sobre una fila sin importe en dólares: sería un número
// colgado que no valúa nada y que la próxima lectura ignoraría igual.
app.put('/api/movimientos/:fila/tc', authMiddleware, adminOnly, async (req, res) => {
  try {
    const idx = parseInt(req.params.fila);
    if (!idx || idx < 3) return res.status(400).json({ ok: false, error: 'Fila inválida' });

    const tc = Number(req.body?.tc);
    if (!Number.isFinite(tc) || tc <= 0) {
      return res.status(400).json({ ok: false, error: 'El tipo de cambio tiene que ser un número mayor que cero' });
    }

    // Releer la fila: confirma que sigue siendo la que el usuario tenía en pantalla
    // y que efectivamente mueve dólares.
    const movs = await getMovimientos();
    const m = movs.find(x => x.rowIndex === idx);
    if (!m) return res.status(404).json({ ok: false, error: 'No se encontró esa fila. Refrescá la página e intentá de nuevo.' });
    if (!m.tieneUSD) {
      return res.status(400).json({ ok: false, error: `"${m.proveedor || 'Esa fila'}" no tiene importe en dólares, así que no lleva tipo de cambio.` });
    }

    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Movimientos!Q${idx}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[tc]] },
    });
    clearCache();

    const usd = m.entradaUSD || m.salidaUSD;
    res.json({
      ok: true,
      fila: idx,
      tc,
      usd,
      ars: Math.round(usd * tc),
      message: `USD ${usd} a $${tc.toLocaleString('es-AR')} = $${Math.round(usd * tc).toLocaleString('es-AR')}`,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Sin adminOnly: el formulario "Nueva compra" del encargado necesita esta
// referencia (plazo, forma de pago) para autocompletar, aunque no vea el listado de pagos.
app.get('/api/proveedores', authMiddleware, async (req, res) => {
  try {
    res.json({ ok: true, data: await leerProveedoresSheet() });
  } catch (err) { res.json({ ok: true, data: {} }); }
});

// Sugerencias para el alta de pagos: proveedores ya usados en Movimientos
// (con su última categoría y medio de pago) + los de la hoja Proveedores.
// Sin adminOnly por el mismo motivo que /api/proveedores arriba.
app.get('/api/proveedores-sugerencias', authMiddleware, async (req, res) => {
  try {
    const movs = await getMovimientos();
    const map = {};
    for (const m of movs) {
      if (m.tipo !== 'Gasto' || !m.proveedor || m.esCambio || m.esFondeo || m.esCuota || m.esCompraEnCuotas) continue;
      const key = m.proveedor.toLowerCase();
      const e = map[key] = map[key] || { nombre: m.proveedor, categoria: '', medioPago: '', plazoDias: null, usos: 0, _fc: null, _fm: null };
      e.usos++;
      if (m.categoria && (!e._fc || m.fecha > e._fc)) { e.categoria = m.categoria; e._fc = m.fecha; }
      if (m.medioPago && (!e._fm || m.fecha > e._fm)) { e.medioPago = m.medioPago; e._fm = m.fecha; }
    }
    let provSheet = {};
    try { provSheet = await leerProveedoresSheet(); } catch (e) {}
    for (const [key, p] of Object.entries(provSheet)) {
      const e = map[key] = map[key] || { nombre: p.nombre, categoria: '', medioPago: '', plazoDias: null, usos: 0 };
      if (!e.medioPago && p.formaPago) e.medioPago = p.formaPago;
      if (p.plazoDias != null) e.plazoDias = p.plazoDias;
    }
    const data = Object.values(map)
      .map(({ _fc, _fm, ...r }) => r)
      .sort((a, b) => b.usos - a.usos || a.nombre.localeCompare(b.nombre));
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Servicios (Fudo) — solo admin ──────────────────────────────────────────────
// Resumen de servicios por día (pax, total, comida vs bebida)
app.get('/api/servicios', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const data = await getServicios({ desde, hasta });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/servicios:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Detalle de un servicio (un día): productos por categoría + medios de pago
app.get('/api/servicios/:fecha', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await getServicioDetalle(req.params.fecha);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/servicios/:fecha:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Refrescar caché de Fudo manualmente
app.post('/api/servicios/refresh', authMiddleware, adminOnly, (req, res) => {
  clearFudoCache();
  res.json({ ok: true, message: 'Caché de Fudo limpiado.' });
});

// Diagnóstico: venta por venta de un día (total vs pagado, exclusiones, propinas)
app.get('/api/servicios/debug/:fecha', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await getServicioDebug(req.params.fecha);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/servicios/debug:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Rehacer TODOS los snapshots guardados con el cálculo actual (tras corregir la fórmula)
app.post('/api/servicios/resnapshot-todos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await resnapshotTodos();
    res.json({ ok: true, message: `Snapshots regenerados: ${data.regenerados}`, data });
  } catch (err) {
    console.error('Error /api/servicios/resnapshot-todos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Rehacer el snapshot guardado de un día (si se corrigió algo en Fudo a posteriori)
app.post('/api/servicios/resnapshot/:fecha', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await resnapshotDia(req.params.fecha);
    res.json({ ok: true, message: `Snapshot de ${req.params.fecha} actualizado`, data });
  } catch (err) {
    console.error('Error /api/servicios/resnapshot:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Proyecciones (solo admin) ────────────────────────────────────────────────
// Variables personalizadas en hoja "Proyeccion Variables":
// A ID · B Nombre · C Tipo (gasto/ingreso) · D Monto · E Meses (csv) · F Repite · G Creado
const VAR_SHEET = 'Proyeccion Variables';

async function ensureVarSheet(sheets) {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: VAR_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${VAR_SHEET}!A1:G1`, valueInputOption: 'RAW',
      requestBody: { values: [['ID', 'Nombre', 'Tipo', 'Monto', 'Meses', 'Repite', 'Creado']] },
    });
  } catch (e) {
    if (!String(e.message || '').toLowerCase().includes('already exists')) throw e;
  }
}

async function leerVariables() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  let rows = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${VAR_SHEET}!A:G` });
    rows = res.data.values || [];
  } catch (e) {
    await ensureVarSheet(sheets);
    return [];
  }
  const vars = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    vars.push({
      id: r[0],
      nombre: r[1] || 'Sin nombre',
      tipo: (r[2] || 'gasto').toLowerCase() === 'ingreso' ? 'ingreso' : 'gasto',
      monto: parseFloat(String(r[3] || '0').replace(/[^0-9.-]/g, '')) || 0,
      meses: (r[4] || '').split(',').map(s => s.trim()).filter(Boolean),
      repite: String(r[5] || '').toUpperCase() === 'TRUE',
      creado: r[6] || '',
      rowIndex: i + 1,
    });
  }
  return vars;
}

// Proyección completa (baselines + variables + aguinaldos)
app.get('/api/proyecciones', authMiddleware, adminOnly, async (req, res) => {
  try {
    const horizonte = Math.min(parseInt(req.query.meses) || 3, 24);
    // La nómina se inyecta desde acá y nunca hace fallar la respuesta: sin ella,
    // el costo laboral vuelve a la heurística de siempre. Ver src/nomina.js.
    const [movimientos, resumen, variables, planData, nominaBase] = await Promise.all([
      getMovimientos(), getResumenMensual({}), leerVariables(), plan.listPlan(),
      nomina.getNominaParaBaselines(),
    ]);
    // Incluir el Plan de Inversiones en la proyección: query param si viene, si no
    // el default guardado en la config del plan.
    const incluirPlan = req.query.incluirPlan != null
      ? (req.query.incluirPlan === '1' || req.query.incluirPlan === 'true')
      : !!planData.config.incluirEnProyeccion;
    const planGastos = incluirPlan ? await plan.planGastosProgramados() : [];
    const data = proyectar({ movimientos, resumen, variables, planGastos, horizonte, nomina: nominaBase });
    res.json({ ok: true, data: { ...data, variables, incluirPlan } });
  } catch (err) {
    console.error('Error /api/proyecciones:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Alta de variable personalizada
app.post('/api/proyecciones/variables', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nombre, tipo, monto, meses, repite } = req.body;
    if (!nombre || !monto) return res.status(400).json({ ok: false, error: 'Nombre y monto son obligatorios' });
    if (!Array.isArray(meses) || !meses.length) return res.status(400).json({ ok: false, error: 'Elegí al menos un mes' });
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureVarSheet(sheets);
    const id = `v${Date.now()}`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${VAR_SHEET}!A:G`, valueInputOption: 'RAW',
      requestBody: { values: [[id, nombre, tipo === 'ingreso' ? 'ingreso' : 'gasto', Number(monto), meses.join(','), repite ? 'TRUE' : 'FALSE', new Date().toISOString()]] },
    });
    res.json({ ok: true, id, message: 'Variable agregada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Baja de variable personalizada
app.delete('/api/proyecciones/variables/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const vars = await leerVariables();
    const v = vars.find(x => x.id === req.params.id);
    if (!v) return res.status(404).json({ ok: false, error: 'Variable no encontrada' });
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
    const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === VAR_SHEET);
    if (!sheet) return res.status(500).json({ ok: false, error: 'No existe la hoja de variables' });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ deleteDimension: { range: {
        sheetId: sheet.properties.sheetId, dimension: 'ROWS',
        startIndex: v.rowIndex - 1, endIndex: v.rowIndex,
      } } }] },
    });
    res.json({ ok: true, message: 'Variable eliminada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Plan de Inversiones — gastos extraordinarios planificados (solo admin) ───
app.get('/api/plan', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await plan.listPlan() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Gastos reales de Movimientos candidatos a vincularse con un ítem del plan.
// Se excluyen las filas de cuota (n/m): la fila madre ya lleva el importe total.
app.get('/api/plan/movimientos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const movs = await getMovimientos();
    const out = movs
      .filter(m => m.tipo === 'Gasto' && !m.esCuota && m.salidaTotal > 0)
      .map(m => ({
        fila: m.rowIndex,
        fecha: m.fechaStr,
        ts: m.fecha ? m.fecha.getTime() : 0,
        mesISO: m.fecha ? `${m.fecha.getFullYear()}-${String(m.fecha.getMonth() + 1).padStart(2, '0')}` : '',
        proveedor: m.proveedor,
        descripcion: m.descripcion,
        categoria: m.categoria,
        medioPago: m.medioPago,
        monto: Math.round(m.salidaTotal),
        esExtraordinario: m.esExtraordinario,
        esCompraEnCuotas: m.esCompraEnCuotas,
      }))
      .sort((a, b) => b.ts - a.ts || b.fila - a.fila);
    res.json({ ok: true, data: out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Resuelve el vínculo con Movimientos de un ítem del plan.
// fila > 0  → snapshot del gasto real (importe, referencia legible) + estado hecho
//             y mes objetivo = mes real del gasto.
// fila == 0 → desvincula (el ítem vuelve a valer por su costo estimado).
async function resolverVinculoPlan(body) {
  if (body.movimientoFila === undefined) return body;
  const fila = Math.round(Number(body.movimientoFila)) || 0;
  if (!fila) return { ...body, movimientoFila: 0, costoReal: 0, movimientoRef: '' };
  // Un gasto real no puede respaldar dos ítems del plan: sería contarlo dos veces.
  const { items } = await plan.listPlan();
  const ocupado = items.find(i => i.movimientoFila === fila && i.id !== body.id);
  if (ocupado) throw new Error(`La fila ${fila} ya está vinculada al ítem "${ocupado.nombre}"`);
  const movs = await getMovimientos();
  const m = movs.find(x => x.rowIndex === fila);
  if (!m) throw new Error(`La fila ${fila} de Movimientos no existe o no es un movimiento válido`);
  if (m.tipo !== 'Gasto' || m.salidaTotal <= 0) {
    throw new Error(`La fila ${fila} no es un gasto (tipo "${m.tipo || '—'}", sin salida)`);
  }
  const mesISO = m.fecha ? `${m.fecha.getFullYear()}-${String(m.fecha.getMonth() + 1).padStart(2, '0')}` : '';
  return {
    ...body,
    movimientoFila: fila,
    costoReal: Math.round(m.salidaTotal),
    movimientoRef: [m.fechaStr, m.proveedor, m.descripcion].filter(Boolean).join(' · ').slice(0, 180),
    estado: 'hecho',                                   // vinculado = ejecutado
    mesObjetivo: mesISO || body.mesObjetivo || '',     // el mes real manda
  };
}

// Alta o edición (upsert por id): también se usa para agendar mes, repriorizar,
// marcar hecho y vincular/desvincular con una fila real de Movimientos.
app.post('/api/plan/items', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nombre, costoEstimado } = req.body;
    if (!nombre) return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    if (costoEstimado == null || Number(costoEstimado) < 0) return res.status(400).json({ ok: false, error: 'Costo estimado inválido' });
    const guardado = await plan.guardarItem(await resolverVinculoPlan(req.body));
    res.json({ ok: true, data: guardado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/plan/items/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await plan.deleteItem(req.params.id); res.json({ ok: true, message: 'Ítem eliminado' }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Config: budgetPct | incluirEnProyeccion | override:YYYY-MM
app.put('/api/plan/config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { clave, valor } = req.body;
    if (!clave) return res.status(400).json({ ok: false, error: 'Falta clave' });
    await plan.guardarConfig(clave, valor);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Propinas — reparto semanal de las propinas digitales (solo admin) ───────
// Deliberadamente aislado del ledger: ninguno de estos endpoints escribe en
// Movimientos ni toca la hoja Cajas. La propina es plata de terceros que está
// de paso; meterla en el ledger movería el balance del bar. Ver src/propinas.js.
app.get('/api/propinas', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await propinas.listPropinas() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Calcula el plan de transferencias sin guardar nada. Es el endpoint que usa la
// pantalla mientras se tocan los saldos o se saca gente de la lista.
app.post('/api/propinas/calcular', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { saldoGalicia, saldoBrubank, personas, redondeo } = req.body;
    res.json({ ok: true, data: propinas.calcularReparto({ saldoGalicia, saldoBrubank, personas, redondeo }) });
  } catch (err) {
    // Los errores del cálculo son de validación (saldos en cero, sin gente, no
    // alcanza para la unidad de redondeo), no fallas del servidor.
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Guarda el reparto ya ejecutado. El plan se recalcula adentro a partir de los
// saldos y la gente: no se guardan los montos que mandó el navegador.
app.post('/api/propinas/repartos', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await propinas.guardarReparto(req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.delete('/api/propinas/repartos/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await propinas.deleteReparto(req.params.id); res.json({ ok: true, message: 'Reparto eliminado' }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Equipo: alta, edición (incluye renombrar vía nombreOriginal) y baja.
app.post('/api/propinas/personas', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await propinas.guardarPersona(req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.delete('/api/propinas/personas/:nombre', authMiddleware, adminOnly, async (req, res) => {
  try { await propinas.deletePersona(req.params.nombre); res.json({ ok: true, message: 'Persona eliminada' }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Nómina — el costo laboral, de sólo lectura ─────────────────────────────
// Son sueldos de gente real: TODO acá es adminOnly, el encargado no entra. Y la
// nómina por persona no sale de estas tres rutas — el resto del sistema (punto
// de equilibrio, proyecciones, agentes) recibe sólo totales y dotación.
// La planilla es de los dueños y este módulo no le escribe nada: ver src/nomina.js.
app.get('/api/nomina', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await nomina.getNomina({ mesId: req.query.mes }) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/nomina/mes/:mesId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [empleados, costos] = await Promise.all([nomina.getEmpleados(), nomina.getCostos()]);
    const feriados = Number(req.query.feriados) || 0;
    res.json({ ok: true, data: nomina.calcularMes({ empleados, costos, mesId: req.params.mesId, feriados }) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.get('/api/nomina/proyeccion', authMiddleware, adminOnly, async (req, res) => {
  try {
    const meses = Math.min(Math.max(parseInt(req.query.meses) || 12, 1), 24);
    res.json({ ok: true, data: await nomina.getProyeccion({ meses }) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Notificaciones — la campanita ──────────────────────────────────────────
// `authMiddleware` sin `adminOnly`: el encargado también tiene campanita. Lo
// que cambia es el contenido — las notificaciones de plata las filtra el módulo
// por rol, así que la campanita nunca es la puerta de atrás a algo que la app
// no le muestra. Ver src/notificaciones.js.
app.get('/api/notificaciones', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await notificaciones.getNotificaciones({ usuario: req.user.usuario, rol: req.user.rol }) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Abrir la campanita apaga los EVENTOS, no los estados. Quién marca sale del
// token: una marca de visto ajena no significaría nada.
app.post('/api/notificaciones/visto', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await notificaciones.marcarVisto(req.user.usuario) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Cierre de cocina — qué comprar y qué producir ──────────────────────────
// `authMiddleware` sin `adminOnly` a propósito: el encargado entra, porque la
// checklist de producción la lee toda la cocina. Lo que NO ve es Mercadería ni
// Insumos, y eso no lo decide el navegador — `estadoActual` arma la respuesta
// según el rol y esas dos solapas directamente no viajan. Ver src/cierre-cocina.js.
app.get('/api/cierre-cocina', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await cierreCocina.estadoActual({ rol: req.user.rol }) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Guardar la foto del servicio. Quién firma sale del token, nunca del body.
// El 409 es el caso de "ya hay un cierre para esta noche": no se pisa solo,
// hay que mandar `reemplazar` a propósito.
app.post('/api/cierre-cocina', authMiddleware, async (req, res) => {
  try {
    const data = await cierreCocina.guardarCierre(req.body, { usuario: req.user.nombre, rol: req.user.rol });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(err.code === 'YA_EXISTE' ? 409 : 400).json({ ok: false, error: err.message, cierre: err.cierre });
  }
});

app.get('/api/cierre-cocina/cierres', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await cierreCocina.listarCierres({ limite: Math.min(parseInt(req.query.limite) || 20, 100) }) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/cierre-cocina/cierres/:id', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await cierreCocina.detalleCierre(req.params.id) }); }
  catch (err) { res.status(404).json({ ok: false, error: err.message }); }
});

// ─── Mantenimiento — la libreta de lo que hay que arreglar ──────────────────
// A diferencia de casi todo lo demás, el ENCARGADO entra acá: es el que está en
// el salón cuando se quema la lámpara, y si tiene que avisar para que otro lo
// anote, no se anota. Puede leer, agregar y mover el estado de algo; no puede
// borrar ni reescribir lo que anotó otro (ver CAMPOS_ENCARGADO).
// Igual que Propinas, no escribe en Movimientos ni toca Cajas. Ver
// src/mantenimiento.js.
const CAMPOS_ENCARGADO = ['estado', 'notas'];

app.get('/api/mantenimiento', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await mantenimiento.listMantenimiento() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/mantenimiento', authMiddleware, async (req, res) => {
  try {
    // Quién lo reportó lo pone el server desde el token, no el navegador.
    const data = await mantenimiento.crearItem({ ...req.body, reportadoPor: req.user.nombre, origen: 'app' });
    res.json({ ok: true, data });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.put('/api/mantenimiento/:id', authMiddleware, async (req, res) => {
  try {
    const permitidos = req.user.rol === 'admin' ? null : CAMPOS_ENCARGADO;
    res.json({ ok: true, data: await mantenimiento.actualizarItem(req.params.id, req.body, permitidos) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Pedidos por día ────────────────────────────────────────────────────────
//
// Qué llega cada día, si hay que pagarlo y cuánto. Reemplaza el Google Doc
// "PEDIDOS X DIA". La pantalla la abre el encargado o el cocinero, así que
// TODO esto es accesible a los dos roles — sólo borrar es del admin, igual que
// en Mantenimiento.
//
// Las rutas viven acá y no en un archivo aparte por lo mismo que la ingesta de
// facturas (ver el comentario largo más arriba): necesitan tres cosas que son
// de este archivo — `marcarFilaPagada`, `registrarGastoEnLibro` y `getMovimientos`.
// `src/pedidos.js` no sabe nada de Movimientos y no tiene que saberlo.
//
// EL PERMISO NUEVO (15/08/2026): hasta hoy pasar una fila "A pagar" a "Pagado"
// era sólo del admin. Desde acá lo puede hacer el encargado, porque es el que
// está en la puerta cuando llega el proveedor y le paga en efectivo. Pagarlo y
// no registrarlo es peor que registrarlo: la alternativa real no era que lo
// hiciera un admin, era que no quedara anotado en ningún lado. Queda firmado
// con su nombre (columna H de la hoja Pedidos) y el monto sale del formulario,
// no de la fila, así que un pago parcial se ve.

app.get('/api/pedidos', authMiddleware, async (req, res) => {
  try {
    const dias = parseInt(req.query.dias);
    res.json({ ok: true, data: await pedidos.listPedidos({ dias: Number.isFinite(dias) ? dias : undefined }) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/pedidos', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await pedidos.crearPedido(req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.put('/api/pedidos/:id', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await pedidos.actualizarPedido(req.params.id, req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.delete('/api/pedidos/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await pedidos.borrarPedido(req.params.id); res.json({ ok: true, message: 'Pedido eliminado' }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Los tres botones de la pantalla de Pedidos, del lado del server. El cliente
// manda el nombre del modo y nada más: qué significa cada uno —qué estado deja
// en el pedido y con qué medio— se decide acá, porque es lo que termina en la
// planilla. `medioFijo` es el que no se pregunta: pagar en la puerta es siempre
// en efectivo del local.
const MODOS_RECIBIR = {
  efectivo: { pago: 'pagado', medioFijo: 'Efectivo Local' },
  cuenta:   { pago: 'a pagar' },
  aparte:   { pago: 'pagado' },
};

// ═══════════════════════════════════════════════════════════════════════════
// Qué fila de Movimientos le corresponde a un pedido que acaba de llegar
// ═══════════════════════════════════════════════════════════════════════════
//
// Quien toca esto es un cocinero o el encargado con el proveedor en la puerta.
// NO sabe qué hay cargado en la planilla, no tiene por qué saberlo, y pedirle
// que elija entre filas es pedirle que adivine — con el costo de que una
// elección distraída duplica una deuda o cierra la que no era.
//
// Así que decide el sistema. La pantalla pregunta lo mínimo (cuánto, y en el
// caso de "pago aparte" con qué medio) y ACÁ se resuelve contra qué fila va.
// Lo que el usuario recibe no es una pregunta sino un informe de lo que se
// hizo, al confirmar.
//
// Los tres modos buscan cosas distintas porque significan cosas distintas:
//
//   efectivo → se pagó en la puerta. Busca una fila "A pagar" del proveedor y
//              la CIERRA. Sin ventana de fechas: pagar en efectivo suele ser
//              justamente saldar lo que se venía debiendo, que puede ser de
//              hace semanas. Si no hay ninguna, escribe una fila Pagado.
//   cuenta   → llegó y queda debiendo. Busca una fila "A pagar" de ESTA entrega
//              y, si la encuentra, NO ESCRIBE NADA: la deuda ya estaba anotada.
//              Si no, escribe la fila "A pagar".
//   aparte   → el pago no pasó por la puerta (Mercado Libre, transferencia).
//              Busca una fila "Pagado" de ESTA entrega y, si la encuentra, no
//              escribe nada. Si no, escribe la fila Pagado.
//
// La VENTANA DE FECHAS es lo que separa "esta entrega" de "otra cosa del mismo
// proveedor". Sin ella, "pago aparte" con Mercado Libre engancharía cualquiera
// de las decenas de filas Pagado históricas y no escribiría la de hoy: el gasto
// desaparecería. Con ella, sólo cuenta lo cargado alrededor de la fecha del
// pedido, que es cuando se carga lo de una entrega.
const VENTANA_MATCH_DIAS = 7;

const _diasEntre = (a, b) => Math.round((a.getTime() - b.getTime()) / 86400000);

/**
 * De varios candidatos, cuál.
 *
 * El monto manda sobre la fecha: si el encargado dice que pagó $47.300 y hay una
 * fila de $47.300, es ésa y no hay más que discutir. Recién si eso no desempata
 * gana la más cercana a la fecha del pedido. Nunca se devuelve "no sé": con
 * candidatos siempre sale uno, y cuál salió va en el informe — un sistema que
 * se planta y pregunta es exactamente lo que esta pantalla no puede hacer.
 */
function _elegirCandidata(cands, monto, fechaRef) {
  if (!cands.length) return null;
  let pool = cands;
  if (monto > 0) {
    const exactas = pool.filter(c => Math.round(c.salidaARS || 0) === Math.round(monto));
    if (exactas.length) pool = exactas;
  }
  return pool.slice().sort((a, b) =>
    Math.abs(_diasEntre(a.fecha, fechaRef)) - Math.abs(_diasEntre(b.fecha, fechaRef))
    || a.rowIndex - b.rowIndex)[0];
}

/**
 * Qué se va a hacer con este pedido. No escribe nada: sólo decide.
 *
 * Está separado de la ejecución a propósito, porque lo corren los dos: la
 * ruta que ejecuta y el GET /plan que le muestra al usuario qué va a pasar
 * ANTES de confirmar. Una sola función, así la pantalla no puede prometer una
 * cosa y el server hacer otra.
 *
 * `accion`:
 *   'cerrar-fila'    → hay una "A pagar" y pasa a Pagado.
 *   'vincular-fila'  → ya está anotado como corresponde: NO se escribe nada.
 *   'crear-pagado'   → no había nada: se escribe una fila Pagado.
 *   'crear-a-pagar'  → no había nada: se escribe una fila "A pagar".
 */
async function planificarAsiento({ pedido, modo, monto = 0 }) {
  const nombre = (pedido.proveedor || '').trim().toLowerCase();
  const fechaRef = new Date(pedido.fecha + 'T12:00:00');
  const movs = await getMovimientos();
  const delProveedor = movs.filter(m =>
    m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCompraEnCuotas
    && (m.proveedor || '').toLowerCase() === nombre);

  const aPagar = delProveedor.filter(m => !m.pagado);
  const enVentana = arr => arr.filter(m =>
    Math.abs(_diasEntre(m.fecha, fechaRef)) <= VENTANA_MATCH_DIAS);

  const resumen = f => f && ({
    rowIndex: f.rowIndex,
    monto: f.salidaARS || 0,
    fecha: f.fechaStr || '',
    vencimiento: f.vencimiento || '',
    descripcion: f.descripcion || '',
    medioPago: f.medioPago || '',
  });

  if (modo === 'efectivo') {
    const f = _elegirCandidata(aPagar, monto, fechaRef);
    return f
      ? { accion: 'cerrar-fila', fila: resumen(f), otrasPendientes: aPagar.length - 1 }
      : { accion: 'crear-pagado', fila: null, otrasPendientes: 0 };
  }

  if (modo === 'cuenta') {
    const cands = enVentana(aPagar);
    const f = _elegirCandidata(cands, monto, fechaRef);
    return f
      ? { accion: 'vincular-fila', fila: resumen(f), otrasPendientes: aPagar.length - 1 }
      : { accion: 'crear-a-pagar', fila: null, otrasPendientes: aPagar.length };
  }

  // aparte: la fila que corresponde ya está Pagada. Ojo con lo que NO se hace
  // acá: si el proveedor tiene una "A pagar" abierta, no se la toca ni se la
  // cierra. Puede ser una deuda vieja que no tiene nada que ver con esta
  // entrega, y cerrarla sería dar por pagado algo que nadie pagó. Se avisa en
  // el informe y decide una persona, que es lo único honesto que se puede hacer
  // con una ambigüedad real.
  const pagadas = enVentana(delProveedor.filter(m => m.pagado));
  const f = _elegirCandidata(pagadas, monto, fechaRef);
  return f
    ? { accion: 'vincular-fila', fila: resumen(f), otrasPendientes: aPagar.length }
    : { accion: 'crear-pagado', fila: null, otrasPendientes: aPagar.length };
}
/**
 * POST /api/pedidos/:id/recibir — llegó la mercadería.
 *
 * `modo` es uno de los tres botones de la pantalla: 'efectivo', 'cuenta' o
 * 'aparte'. Contra qué fila de Movimientos va NO lo decide el cliente: lo
 * decide `planificarAsiento` acá adentro. Ver su comentario, que es donde está
 * la regla; esta ruta sólo ejecuta lo que aquél resolvió y cuenta qué pasó.
 *
 * El orden es LIBRO PRIMERO, hoja Pedidos después, y el pedido sólo se marca si
 * el asiento salió bien. Al revés, un fallo de Sheets en el medio dejaría un
 * pedido que dice "pagado" sin ninguna fila que lo respalde — exactamente el
 * agujero que esta pantalla viene a tapar.
 *
 * ─── Por qué el cliente ya no elige la fila ─────────────────────────────────
 *
 * Hasta el 2026-08-19 el modal listaba las cuentas pendientes del proveedor y
 * exigía elegir una. Eso funcionaba con los dueños y no funciona con quien de
 * verdad usa esto: un cocinero con el proveedor en la puerta, que no sabe qué
 * hay cargado en la planilla y no tiene por qué saberlo. Pedirle que elija es
 * pedirle que adivine, y una elección distraída duplica una deuda o cierra la
 * que no era. Ahora el sistema busca, actúa, y le dice qué hizo.
 *
 * Lo que sigue protegiendo contra duplicados:
 *
 *   1. El plan NUNCA escribe una fila nueva si encontró una que corresponde —
 *      ésa es toda su razón de ser, y ya no depende de que un humano lo elija.
 *   2. `registrarGastoEnLibro` es idempotente sobre la columna H con el id del
 *      pedido como clave, releída SIN caché. Un doble toque en un teléfono en
 *      el medio del servicio no puede escribir dos filas.
 *
 * Lo que NO garantiza, dicho en voz alta: `planificarAsiento` lee por
 * `getMovimientos()`, cacheado un par de minutos, así que una fila cargada hace
 * segundos desde otra sesión puede no verse todavía. Y ante varios candidatos
 * elige uno (monto exacto primero, después cercanía de fecha) en vez de
 * plantarse a preguntar — cuál eligió va en el informe, que es dónde una
 * persona lo puede revisar después sin tener que decidirlo en la puerta.
 */
app.post('/api/pedidos/:id/recibir', authMiddleware, async (req, res) => {
  try {
    const pedido = await pedidos.getPedido(req.params.id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'No se encontró ese pedido' });
    if (pedido.pago !== 'no') {
      return res.status(400).json({ ok: false, error: `Este pedido ya figura como "${pedido.pago}".` });
    }

    const modo = MODOS_RECIBIR[req.body.modo] ? req.body.modo : null;
    if (!modo) return res.status(400).json({ ok: false, error: 'Falta decir cómo se recibió.' });
    const { pago, medioFijo } = MODOS_RECIBIR[modo];
    let monto = Number(req.body.monto) || 0;
    const medioPago = medioFijo || (req.body.medioPago || '').toString();

    // Se decide contra qué fila va ANTES de tocar nada.
    const plan = await planificarAsiento({ pedido, modo, monto });
    let ref = '', asiento = null;

    if (plan.accion === 'vincular-fila') {
      // Ya está anotado como corresponde. No se escribe NADA en Movimientos: ni
      // el monto, ni el estado, ni el medio. Esa fila es de quien la cargó y
      // puede tener fórmulas, cuotas o un vencimiento negociado que acá no
      // conocemos.
      //
      // Y no se revalida el rowIndex antes de guardarlo, a diferencia de
      // 'cerrar-fila': acá no se escribe sobre esa fila, así que un índice que
      // envejeció no puede romper nada. `RefMovimiento` es informativo y nunca
      // se usa para volver a buscar la fila — las filas se mueven cuando
      // alguien edita la planilla a mano. Ver el encabezado de src/pedidos.js.
      ref = `fila ${plan.fila.rowIndex}`;
      monto = plan.fila.monto || monto;
      asiento = { ...plan, escribio: false };

    } else if (plan.accion === 'cerrar-fila') {
      const r = await marcarFilaPagada({
        rowIndex: plan.fila.rowIndex,
        proveedor: pedido.proveedor,
        medioPago,
        usuario: req.user.nombre,
        descripcionSesion: `Pedido recibido: ${pedido.proveedor}`,
      });
      if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
      ref = `fila ${r.rowIndex}`;
      monto = plan.fila.monto || monto;
      asiento = { ...plan, escribio: true, registradoEnSesion: r.registradoEnSesion };

    } else {
      if (monto <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'No hay ninguna fila cargada para este pedido, así que hay que escribir una. Poné cuánto es.',
        });
      }
      const r = await registrarGastoEnLibro({
        facturaId: pedido.id,
        fecha: pedido.fecha,
        proveedor: pedido.proveedor,
        categoria: req.body.categoria || 'Mercaderia',
        monto,
        descripcion: pedido.detalle || `Pedido ${pedido.proveedor}`,
        medioPago,
        estado: plan.accion === 'crear-a-pagar' ? 'A pagar' : 'Pagado',
        vencimiento: req.body.vencimiento || pedido.fecha,
        usuario: req.user.nombre,
      });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      ref = pedido.id;
      asiento = { ...plan, escribio: !r.yaExistia, yaEstaba: !!r.yaExistia, registradoEnSesion: r.registradoEnSesion };
    }

    const data = await pedidos.marcarRecibido(pedido.id, {
      pago, monto, medioPago, ref, usuario: req.user.nombre,
    });
    res.json({ ok: true, data, asiento });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/pedidos/:id/plan?modo=X&monto=Y — qué va a pasar si confirmás.
//
// Corre EXACTAMENTE la misma función que la ruta que escribe. Existe para que
// el modal pueda decir "se va a cerrar la fila de $47.300 del 14/8" en vez de
// una frase genérica, sin que el navegador tenga que reimplementar la regla —
// dos copias de esta decisión discreparían el día que una se toque.
//
// El plan es informativo y se puede quedar viejo: al confirmar se vuelve a
// planificar contra la planilla del momento, y lo que se informa al final es lo
// que de verdad pasó, no esto.
app.get('/api/pedidos/:id/plan', authMiddleware, async (req, res) => {
  try {
    const pedido = await pedidos.getPedido(req.params.id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'No se encontró ese pedido' });
    const modo = MODOS_RECIBIR[req.query.modo] ? req.query.modo : 'efectivo';
    const plan = await planificarAsiento({ pedido, modo, monto: Number(req.query.monto) || 0 });
    res.json({ ok: true, data: plan });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// ─── El cuadro semanal ──────────────────────────────────────────────────────
// La rutina fija ("los jueves entrega Barracas"). No crea filas de pedido: se
// muestra dentro de cada día como previsto. Ver el encabezado de pedidos.js.
app.get('/api/pedidos/semanal', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await pedidos.listSemanal() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/pedidos/semanal', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await pedidos.crearSemanal(req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// El drag & drop del cuadro es un PUT con { dia, orden }.
app.put('/api/pedidos/semanal/:id', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, data: await pedidos.actualizarSemanal(req.params.id, req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.delete('/api/pedidos/semanal/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await pedidos.borrarSemanal(req.params.id); res.json({ ok: true, message: 'Ítem eliminado del cuadro' }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Informe diario ─────────────────────────────────────────────────────────
// Va a una sola persona (INFORMES_DESTINATARIO). Ver src/informes.js.
app.get('/api/informes', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try { res.json({ ok: true, data: await informes.listarInformes({ limite: 30 }) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Lo que el destinatario todavía no vio. Lo consulta el aviso emergente al abrir
// la app, al volver a la pestaña y cada media hora. La respuesta normal es una
// lista vacía: sólo lee la hoja, nunca llama al modelo.
app.get('/api/informes/pendientes', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try { res.json({ ok: true, data: await informes.pendientesPara(req.user.usuario) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/informes/leido', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try {
    const { tipo, periodo } = req.body || {};
    res.json({ ok: true, data: await informes.marcarLeido({ tipo, periodo, usuario: req.user.usuario }) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Notas al agente ────────────────────────────────────────────────────────
// El feedback de los dueños sobre lo que el informe dice. Ver src/informes-notas.js.
app.get('/api/informes/notas', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try { res.json({ ok: true, data: await informesNotas.listarNotas({}) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/informes/notas', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try {
    const { tipo, periodo, hallazgo, veredicto, texto, escalonConcepto, escalonDesde } = req.body || {};
    // El usuario lo pone el servidor, nunca el body: la nota queda firmada con
    // quién entró, y más adelante pablo y tincho pueden opinar distinto sobre lo
    // mismo. Que el navegador pudiera elegir el autor haría inservible el dato.
    const data = await informesNotas.guardarNota({
      usuario: req.user.usuario, tipo, periodo, hallazgo, veredicto, texto, escalonConcepto, escalonDesde,
    });
    res.json({ ok: true, data });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Sumarle el "por qué" a un pulgar arriba ya guardado. Existe para que el 👍
// siga siendo UN toque: se guarda primero y recién ahí se ofrece contar por qué
// sirvió. El usuario sale de req.user por la misma razón que al crear la nota, y
// el módulo además verifica que la fila sea suya.
app.post('/api/informes/notas/:fila/texto', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try {
    const data = await informesNotas.agregarTexto({
      rowIndex: req.params.fila, usuario: req.user.usuario, texto: (req.body || {}).texto,
    });
    res.json({ ok: true, data });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.post('/api/informes/notas/:fila/archivar', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try { res.json({ ok: true, data: await informesNotas.archivarNota(req.params.fila) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Generar a mano: sirve para probar sin esperar al domingo, y para el balance
// de un mes viejo (`hasta` = cualquier día del mes SIGUIENTE al que se quiere
// analizar). Sin `forzar` no regenera un período ya hecho, así apretar el botón
// dos veces no gasta dos llamadas al modelo.
app.post('/api/informes/generar', authMiddleware, soloDestinatarioInformes, async (req, res) => {
  try {
    const { tipo, hasta, forzar } = req.body || {};
    if (!informes.TIPOS.includes(tipo)) {
      return res.status(400).json({ ok: false, error: `Tipo inválido (${informes.TIPOS.join(' | ')})` });
    }
    res.json({ ok: true, data: await informes.generarInforme(tipo, { hasta, forzar: !!forzar }) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/mantenimiento/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await mantenimiento.deleteItem(req.params.id); res.json({ ok: true, message: 'Arreglo eliminado' }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Entrada del bot de Telegram. Mismo esquema que /api/proveedores/ingest: token
// de servicio en el header X-Ingest-Token, o un usuario logueado.
// El token se comparte con el de proveedores porque es el mismo bot y la misma
// frontera de confianza — así no hay que configurar una variable nueva en
// Railway. MANTENIMIENTO_INGEST_TOKEN existe por si algún día se quieren separar.
function ingestAuthMantenimiento(req, res, next) {
  const svcToken = process.env.MANTENIMIENTO_INGEST_TOKEN || process.env.PROVEEDORES_INGEST_TOKEN;
  const provided = req.headers['x-ingest-token'] || (req.body && req.body.ingestToken);
  if (svcToken && provided && provided === svcToken) return next();
  return authMiddleware(req, res, next);
}

app.post('/api/mantenimiento/ingest', ingestAuthMantenimiento, async (req, res) => {
  try {
    const { titulo, sector, prioridad, notas, reportadoPor } = req.body || {};
    const data = await mantenimiento.crearItem({
      titulo, sector, prioridad, notas,
      // Con token de servicio no hay req.user: el nombre lo manda el bot.
      reportadoPor: req.user ? req.user.nombre : reportadoPor,
      origen: req.user ? 'app' : 'telegram',
    });
    res.json({ ok: true, data });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Lo que sigue abierto, para que el bot pueda contestar "qué falta arreglar".
app.get('/api/mantenimiento/pendientes', ingestAuthMantenimiento, async (req, res) => {
  try { res.json({ ok: true, data: await mantenimiento.pendientes() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Cambio de prioridad desde los botones que el bot manda apenas se anota algo.
app.put('/api/mantenimiento/ingest/:id', ingestAuthMantenimiento, async (req, res) => {
  try {
    const permitidos = req.user && req.user.rol !== 'admin' ? CAMPOS_ENCARGADO : null;
    res.json({ ok: true, data: await mantenimiento.actualizarItem(req.params.id, req.body, permitidos) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Finanzas — capital del recupero (solo admin) ───────────────────────────
// La plata del recupero se coloca en instrumentos en pesos en vez de quedar
// quieta. Los aportes mensuales salen del recupero real de cada cierre (roi.js)
// salvo que se hayan editado a mano. Ver src/finanzas.js.
app.get('/api/finanzas', authMiddleware, adminOnly, async (req, res) => {
  try {
    const r = await roi.resumenRecupero().catch(() => ({ porMes: [] }));
    res.json({ ok: true, data: await finanzas.resumenFinanzas(r.porMes || []) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Config: una clave suelta { clave, valor }. Ya no hay reparto entre buckets —
// el 100% del recupero va a Mercado Pago Pablo.
app.put('/api/finanzas/config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { clave, valor } = req.body;
    if (!clave) return res.status(400).json({ ok: false, error: 'Falta clave' });
    const n = Number(valor);
    if (clave !== 'mesInicio' && !(Number.isFinite(n) && n >= 0)) {
      return res.status(400).json({ ok: false, error: 'El valor tiene que ser un número positivo' });
    }
    await finanzas.guardarConfig(clave, valor);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Aporte de un mes. monto null/'' borra el override y el mes vuelve a tomar el
// recupero real del cierre.
app.put('/api/finanzas/aportes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mes, monto, notas } = req.body;
    const m = (monto === '' || monto == null) ? null : Number(monto);
    if (m != null && !(Number.isFinite(m) && m >= 0)) {
      return res.status(400).json({ ok: false, error: 'Monto inválido' });
    }
    res.json({ ok: true, data: await finanzas.guardarAporte(mes, m, notas) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Registro real de colocaciones/rescates: la pista de auditoría que separa el
// capital del recupero de la caja operativa del bar.
app.post('/api/finanzas/movimientos', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await finanzas.guardarMovimiento(req.body) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.delete('/api/finanzas/movimientos/:id', authMiddleware, adminOnly, async (req, res) => {
  try { await finanzas.borrarMovimiento(req.params.id); res.json({ ok: true, message: 'Movimiento eliminado' }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Servicios: agregado de productos multi-día (solo admin) ──────────────────
// Responde "¿se vendió más PARA COMER o PARA PICAR en general?" sobre un rango.
app.get('/api/servicios/agregado', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    res.json({ ok: true, data: await getAgregadoProductos({ desde, hasta }) });
  } catch (err) {
    console.error('Error /api/servicios/agregado:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnóstico CRUDO de una venta (items tal como vienen de Fudo)
app.get('/api/costos/venta-debug/:id', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok: true, data: await getVentaDebugCrudo(req.params.id) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Diagnóstico por producto (auditar ingreso de Fudo): /api/costos/producto-debug?nombre=Vermu&desde=&hasta=
app.get('/api/costos/producto-debug', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nombre, desde, hasta } = req.query;
    res.json({ ok: true, data: await getProductoDebug(nombre || '', { desde, hasta }) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Costos vs Ingresos por categoría (solo admin) ────────────────────────────
// Cruza el costo (hoja Compras, por ingrediente) con el ingreso (FUDO, mapeado por
// producto a su categoría de costo dominante).
app.get('/api/costos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    await costos.cargarOverrides().catch(() => {});
    await costos.cargarComposiciones().catch(() => {});
    const [compras, detallesFudo] = await Promise.all([
      prov.getCompras().catch(() => []),
      getDetallesFrescos({ desde, hasta }).catch(() => []),
    ]);
    const data = costos.costosVsIngresos({ compras, detallesFudo, desde, hasta });
    // Food cost por categoría (ratio 0..1) para estimar costo de cada plato.
    const fcPorCat = {};
    for (const fila of data.filas) {
      if (fila.ingreso > 0) fcPorCat[fila.categoria] = fila.costo / fila.ingreso;
    }
    data.porPlato = costos.detallePorPlato({ detallesFudo, foodCostPorCategoria: fcPorCat });
    data.composiciones = costos.listComposiciones();
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/costos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Override manual del mapeo producto FUDO → categoría de costo (persiste en Sheets)
app.post('/api/costos/override', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { producto, categoria } = req.body || {};
    if (!producto || !categoria) return res.status(400).json({ ok: false, error: 'Faltan producto y categoría' });
    if (!costos.CATEGORIAS_COSTO.includes(categoria)) return res.status(400).json({ ok: false, error: 'Categoría no válida' });
    await costos.setOverrideProducto(producto, categoria);
    res.json({ ok: true, message: `"${producto}" reasignado a ${categoria}` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Lista de categorías de costo disponibles (para el dropdown de recategorizar)
app.get('/api/costos/categorias', authMiddleware, adminOnly, (req, res) => {
  res.json({ ok: true, data: costos.CATEGORIAS_COSTO });
});

// Composición % de un plato (qué categorías de costo lo componen)
app.get('/api/costos/composicion', authMiddleware, adminOnly, async (req, res) => {
  try {
    await costos.cargarComposiciones().catch(() => {});
    const { plato } = req.query;
    if (plato) return res.json({ ok: true, data: costos.getComposicion(plato) || [] });
    res.json({ ok: true, data: costos.listComposiciones() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/api/costos/composicion', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { plato, partes } = req.body || {};
    if (!plato || !Array.isArray(partes)) return res.status(400).json({ ok: false, error: 'Faltan plato y partes' });
    // Validar categorías y que sume ~100
    for (const p of partes) {
      if (!costos.CATEGORIAS_COSTO.includes(p.categoria)) return res.status(400).json({ ok: false, error: `Categoría no válida: ${p.categoria}` });
    }
    const suma = partes.reduce((a, p) => a + (Number(p.pct) || 0), 0);
    if (Math.abs(suma - 100) > 1) return res.status(400).json({ ok: false, error: `Los % deben sumar 100 (suman ${suma})` });
    await costos.setComposicion(plato, partes);
    res.json({ ok: true, message: `Composición de "${plato}" guardada` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Reglas de consumo de INSUMOS (persistente) ───────────────────────────────
// Lista las reglas + cobertura estimada cruzando con compras de insumos.
app.get('/api/consumo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [reglas, compras] = await Promise.all([
      consumo.listConsumo().catch(() => []),
      prov.getCompras().catch(() => []),
    ]);
    // Agregar compras por producto (solo categoría Insumos), en su unidad de compra.
    const porProd = {};
    for (const c of compras) {
      if (!c.producto) continue;
      const norm = consumo.norm(c.producto);
      const e = porProd[norm] = porProd[norm] || { ingresado: 0, ultimaCompra: null };
      e.ingresado += Number(c.cantidad) || 0;
      if (c.fecha && (!e.ultimaCompra || c.fecha > e.ultimaCompra)) e.ultimaCompra = c.fecha;
    }
    const data = consumo.calcularCobertura(reglas, porProd);
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/api/consumo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { producto, cantidad, periodo } = req.body || {};
    if (!producto || cantidad == null) return res.status(400).json({ ok: false, error: 'Faltan producto y cantidad' });
    await consumo.setConsumo(producto, Number(cantidad), periodo || 'semana');
    res.json({ ok: true, message: `Consumo de "${producto}" guardado` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.delete('/api/consumo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const producto = req.query.producto || (req.body && req.body.producto);
    if (!producto) return res.status(400).json({ ok: false, error: 'Falta producto' });
    await consumo.deleteConsumo(producto);
    res.json({ ok: true, message: 'Regla eliminada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── CMV desagregado Comida / Bebida / Insumos (composición desde Compras) ─────
// El TOTAL fiel del CMV sale del resumen (Movimientos); acá damos la composición.
app.get('/api/cmv-desglose', authMiddleware, adminOnly, async (req, res) => {
  try {
    await costos.cargarProveedorGrupoCMV().catch(() => {});
    const filtro = parseFiltro(req.query);
    const desde = filtro.fechaDesde ? filtro.fechaDesde.toISOString().slice(0,10) : undefined;
    const hasta = filtro.fechaHasta ? filtro.fechaHasta.toISOString().slice(0,10) : undefined;
    const [compras, resumenArr, movimientos] = await Promise.all([
      prov.getCompras().catch(() => []),
      getResumenMensual(filtro).catch(() => []),
      getMovimientos().catch(() => []),
    ]);
    const desglose = costos.cmvDesglose(compras, { desde, hasta });
    const r = resumenArr[0] || { gastos: {}, ingresos: {} };
    const insumosMovimientos = r.gastos?.Insumos || 0;
    const mercaderiaMovimientos = r.gastos?.Mercaderia || 0;
    const cmvMovimientos = mercaderiaMovimientos + insumosMovimientos;
    const ingresos = r.ingresos?.total || 0;

    // Insumos viene de MOVIMIENTOS (no de Compras): pisar el grupo y su detalle.
    desglose.grupos.Insumos = insumosMovimientos;
    desglose.detalle.Insumos = [{ categoria: 'Insumos (Movimientos)', costo: insumosMovimientos }];

    // Base desde Compras (lo que el ticket detalla)
    const comidaCompras = desglose.grupos.Comida || 0;
    const bebidaCompras = desglose.grupos.Bebida || 0;

    // --- Reasignacion por proveedor (cascada Compras -> regla proveedor -> Otros) ---
    // El resto de Mercaderia(Movimientos) que NO esta detallado en Compras se reparte
    // segun la regla del proveedor (hoja "Proveedor Grupo CMV"). Lo que no tiene regla -> Otros.
    let movsMerc = movimientos.filter(m => m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCuota);
    if (filtro.mes) movsMerc = movsMerc.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movsMerc = movsMerc.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    movsMerc = movsMerc.filter(m => m.grupo === 'Mercaderia');
    const normProv = (x) => (x || '').toString().trim().toLowerCase();

    const movPorProv = {};   // key cats.norm -> { nombre, monto }
    for (const m of movsMerc) {
      const k = cats.norm(m.proveedor || '') || '(sin proveedor)';
      const e = movPorProv[k] = movPorProv[k] || { nombre: m.proveedor || '(sin proveedor)', monto: 0 };
      e.monto += m.salidaTotal;
    }
    const compPorProvList = {};  // key cats.norm -> { nombre, monto }
    for (const c of (compras || [])) {
      if (desde && c.fecha && c.fecha < desde) continue;
      if (hasta && c.fecha && c.fecha > hasta) continue;
      const g = costos.grupoCMV(cats.normalizarCategoria(c.categoria).categoria || c.categoria);
      if (g !== 'Comida' && g !== 'Bebida') continue;
      const k = cats.norm(c.proveedor || '') || '(sin proveedor)';
      const e = compPorProvList[k] = compPorProvList[k] || { nombre: c.proveedor || '(sin proveedor)', monto: 0 };
      e.monto += costos.montoCompra(c);
    }
    const comprasArr = Object.values(compPorProvList);
    const comprasDe = (nombreMov) => {
      let tot = 0;
      for (const c of comprasArr) if (costos.mismoProveedor(nombreMov, c.nombre)) tot += c.monto;
      return tot;
    };

    let comidaRegla = 0, bebidaRegla = 0, insumosRegla = 0, otros = 0;
    for (const [k, e] of Object.entries(movPorProv)) {
      const montoMov = e.monto;
      const enCompras = Math.min(montoMov, comprasDe(e.nombre));
      const resto = Math.max(0, montoMov - enCompras);
      if (resto <= 0) continue;
      const grupoRegla = costos.grupoCMVPorProveedor(e.nombre);
      if (grupoRegla === 'Comida') comidaRegla += resto;
      else if (grupoRegla === 'Bebida') bebidaRegla += resto;
      else if (grupoRegla === 'Insumos') insumosRegla += resto;
      else otros += resto;
    }

    desglose.grupos.Comida = Math.round(comidaCompras + comidaRegla);
    desglose.grupos.Bebida = Math.round(bebidaCompras + bebidaRegla);
    desglose.grupos.Insumos = Math.round(insumosMovimientos + insumosRegla);
    desglose.grupos.Otros = Math.round(otros);
    desglose.detalle.Otros = [{ categoria: 'Mercaderia sin regla de proveedor (Movimientos)', costo: Math.round(otros) }];
    // El total es fiel al CMV real de Movimientos.
    desglose.total = cmvMovimientos;

    res.json({ ok: true, data: {
      desglose,
      cmvMovimientos,
      mercaderiaMovimientos,
      comidaCompras,
      bebidaCompras,
      insumosMovimientos,
      ingresos,
      pctCMV: ingresos > 0 ? Math.round((cmvMovimientos / ingresos) * 1000) / 10 : 0,
      nota: 'CMV total sale de Movimientos (P&L real). Comida/Bebida = lo detallado en Compras + lo asignado por la regla de proveedor. Otros = lo que no tiene regla.',
    } });
  } catch (err) {
    console.error('Error /api/cmv-desglose:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Detalle de "Otros" del CMV (conciliacion Movimientos vs Compras) ──────────
// "Otros" = Mercaderia (Movimientos) - Comida (Compras) - Bebida (Compras).
// Es la mercaderia real que la hoja Compras no logro atribuir a Comida ni Bebida.
// No existe como filas sueltas: es la BRECHA entre dos fuentes. Este endpoint la explica
// y devuelve, como referencia, las categorias de Compras que SI se clasificaron.
app.get('/api/cmv-otros-detalle', authMiddleware, adminOnly, async (req, res) => {
  try {
    await costos.cargarProveedorGrupoCMV().catch(() => {});
    const filtro = parseFiltro(req.query);
    const desde = filtro.fechaDesde ? filtro.fechaDesde.toISOString().slice(0,10) : undefined;
    const hasta = filtro.fechaHasta ? filtro.fechaHasta.toISOString().slice(0,10) : undefined;
    const [compras, movimientos] = await Promise.all([
      prov.getCompras().catch(() => []),
      getMovimientos().catch(() => []),
    ]);

    // --- Lado MOVIMIENTOS: gastos del grupo Mercaderia (mismo filtro que el dashboard) ---
    let movsMerc = movimientos.filter(m => m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCuota);
    if (filtro.mes) movsMerc = movsMerc.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movsMerc = movsMerc.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    movsMerc = movsMerc.filter(m => m.grupo === 'Mercaderia');

    const normProv = (x) => (x || '').toString().trim().toLowerCase();
    const porProvMov = {};   // proveedor -> { proveedor, montoMov, movimientos }
    for (const m of movsMerc) {
      const k = normProv(m.proveedor) || '(sin proveedor)';
      const e = porProvMov[k] = porProvMov[k] || { proveedor: m.proveedor || '(sin proveedor)', montoMov: 0, movimientos: 0 };
      e.montoMov += m.salidaTotal;
      e.movimientos++;
    }

    // --- Lado COMPRAS: lo detallado por proveedor que mapea a Comida o Bebida ---
    // Agrupado por proveedor REAL para cruzar por nombre flexible (Zuccardi vs Familia Zuccardi SA).
    const compPorProvList = {};  // key cats.norm -> { nombre, monto }
    for (const c of (compras || [])) {
      if (desde && c.fecha && c.fecha < desde) continue;
      if (hasta && c.fecha && c.fecha > hasta) continue;
      const g = costos.grupoCMV(cats.normalizarCategoria(c.categoria).categoria || c.categoria);
      if (g !== 'Comida' && g !== 'Bebida') continue;
      const k = cats.norm(c.proveedor || '') || '(sin proveedor)';
      const e = compPorProvList[k] = compPorProvList[k] || { nombre: c.proveedor || '(sin proveedor)', monto: 0 };
      e.monto += costos.montoCompra(c);
    }
    const comprasArr = Object.values(compPorProvList);
    const comprasDe = (nombreMov) => {
      let tot = 0;
      for (const c of comprasArr) if (costos.mismoProveedor(nombreMov, c.nombre)) tot += c.monto;
      return tot;
    };

    // --- Cascada por proveedor: Compras primero, luego regla por proveedor, sino Otros ---
    const filas = Object.entries(porProvMov).map(([k, e]) => {
      const montoMov = Math.round(e.montoMov);
      const enCompras = Math.min(montoMov, Math.round(comprasDe(e.proveedor)));
      const resto = Math.max(0, montoMov - enCompras);
      const grupoRegla = costos.grupoCMVPorProveedor(e.proveedor); // '', 'Comida', 'Bebida', 'Insumos'
      const porRegla = grupoRegla ? resto : 0;
      const sinClasificar = grupoRegla ? 0 : resto;
      return { proveedor: e.proveedor, movimientos: e.movimientos, montoMov, enCompras, grupoRegla, porRegla, sinClasificar };
    }).sort((a, b) => b.sinClasificar - a.sinClasificar || b.montoMov - a.montoMov);

    const mercaderiaMovimientos = Math.round(movsMerc.reduce((s, m) => s + m.salidaTotal, 0));
    const enComprasTotal = filas.reduce((s, f) => s + f.enCompras, 0);
    const porReglaTotal = filas.reduce((s, f) => s + f.porRegla, 0);
    const otros = filas.reduce((s, f) => s + f.sinClasificar, 0);

    res.json({ ok: true, data: {
      mercaderiaMovimientos,
      enComprasTotal,
      porReglaTotal,
      otros,
      filas,
      nota: 'Cascada: 1) lo detallado en Compras manda; 2) el resto se asigna por la regla del proveedor ' +
            '(hoja "Proveedor Grupo CMV"); 3) lo que queda sin regla es "Otros". ' +
            'Para que Otros baje a cero, agrega los proveedores con saldo "Sin clasificar" a esa hoja.',
    } });
  } catch (err) {
    console.error('Error /api/cmv-otros-detalle:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Detalle de movimientos por GRUPO de gasto (para modales/acordeón del dashboard) ──
// grupo: Mercaderia | Insumos | Personal | Alquiler | Servicios | Fiscales |
//        Financieros | Extraordinarios | Equipamiento | Otros
// Filtros opcionales (solo relevantes para Servicios/Extraordinarios):
//   ?proveedor=Edenor  → sub-filtro dentro de Servicios
//   ?categoria=Sala    → sub-filtro dentro de Extraordinarios
const LEAF_MATCH = {
  Mercaderia:      m => m.superGrupo === 'Variables' && m.categoria === 'Mercaderia',
  Insumos:         m => m.superGrupo === 'Variables' && m.categoria === 'Insumos',
  Personal:        m => m.superGrupo === 'Personal',
  Equipamiento:    m => m.superGrupo === 'Equipamiento',
  Otros:           m => m.superGrupo === 'Otros',
  Alquiler:        m => m.superGrupo === 'Fijos' && m.subGrupo === 'Alquiler',
  Servicios:       m => m.superGrupo === 'Fijos' && m.subGrupo === 'Servicios',
  Fiscales:        m => m.superGrupo === 'Fiscales',
  Financieros:     m => m.superGrupo === 'Financieros',
  Extraordinarios: m => m.superGrupo === 'Extraordinarios',
};
app.get('/api/movimientos/grupo/:grupo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const matcher = LEAF_MATCH[req.params.grupo];
    if (!matcher) return res.status(400).json({ ok: false, error: `Grupo desconocido: ${req.params.grupo}` });
    const filtro = parseFiltro(req.query);
    let movs = await getMovimientos();
    movs = movs.filter(m => m.tipo === 'Gasto' && !m.esCambio && !m.esFondeo && !m.esCuota);
    if (filtro.mes) movs = movs.filter(m => m.mes === filtro.mes);
    if (filtro.fechaDesde) movs = movs.filter(m => m.fecha >= filtro.fechaDesde && m.fecha <= filtro.fechaHasta);
    movs = movs.filter(matcher);
    if (req.query.proveedor) movs = movs.filter(m => (m.proveedor || '') === req.query.proveedor);
    if (req.query.categoria) movs = movs.filter(m => (m.categoria || '') === req.query.categoria);

    // Desglose por categoría y por proveedor dentro del grupo + filas
    const porCategoria = {}, porProveedor = {};
    for (const m of movs) {
      const c = m.categoria || 'Sin categoría';
      porCategoria[c] = (porCategoria[c] || 0) + m.salidaTotal;
      const p = m.proveedor || 'Sin proveedor';
      porProveedor[p] = (porProveedor[p] || 0) + m.salidaTotal;
    }
    const data = movs
      .map(m => ({ fecha: m.fecha.toISOString().split('T')[0], proveedor: m.proveedor, categoria: m.categoria, descripcion: m.descripcion, medioPago: m.medioPago, monto: m.salidaTotal, estado: m.estado }))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    res.json({ ok: true, data, porCategoria, porProveedor, total: data.reduce((s, x) => s + x.monto, 0) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Calculadora P&L (régimen) con inputs editables (solo admin) ──────────────
app.post('/api/calculadora', authMiddleware, adminOnly, async (req, res) => {
  try {
    res.json({ ok: true, data: calcularCalculadora(req.body || {}) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Defaults de la calculadora a partir de los datos reales (para precargar inputs)
app.get('/api/calculadora/defaults', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [movimientos, resumen, nominaBase] = await Promise.all([
      getMovimientos(), getResumenMensual({}), nomina.getNominaParaBaselines(),
    ]);
    const base = require('./proyecciones').calcularBaselines(movimientos, new Date(), { nomina: nominaBase });
    res.json({ ok: true, data: base });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Punto de equilibrio diario (Servicios) ──────────────────────────────────
app.get('/api/punto-equilibrio', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [movimientos, nominaBase] = await Promise.all([getMovimientos(), nomina.getNominaParaBaselines()]);
    const base = calcularBaselines(movimientos, new Date(), { nomina: nominaBase });
    res.json({
      ok: true,
      data: {
        puntoEquilibrioDiario: base.puntoEquilibrioDiario,
        fixedMensual: base.fixedMensual,
        fixedDiario: base.fixedDiario,
        pctCostoVariable: base.pctCostoVariable,
        diasServicioEquilibrio: base.diasServicioEquilibrio,
        diasServicio28: base.diasServicio28,
        // De dónde salió el costo laboral y con cuánta gente. La pantalla lo
        // muestra: un objetivo diario sin origen es un número que nadie audita.
        personalFuente: base.personalFuente,
        dotacion: base.dotacion,
        nominaIncompletos: base.nominaIncompletos,
        desglose: {
          personal: base.personalMensual,
          // El aguinaldo devengado: un doceavo todos los meses. Antes no estaba
          // en el costo fijo y por eso junio y diciembre quedaban por debajo.
          sac: base.sacDevengadoMensual,
          fijos: base.fijosMensual,
          fiscales: base.fiscalesMensual,
          financieros: base.financierosMensual,
          extraordinarios: base.extraordinariosMensual,
          otros: base.otrosMensual,
        },
      },
    });
  } catch (err) {
    console.error('Error /api/punto-equilibrio:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Proyección del MES en curso (real acumulado + forecast a fin de mes) ──────
app.get('/api/proyeccion-mes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [movimientos, variables, nominaBase] = await Promise.all([
      getMovimientos(), leerVariables().catch(() => []), nomina.getNominaParaBaselines(),
    ]);
    res.json({ ok: true, data: proyeccionMes({ movimientos, variables, nomina: nominaBase }) });
  } catch (err) {
    console.error('Error /api/proyeccion-mes:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Resumen simplificado de Costos (Comida / Bebida) ────────────────────────
// ─── Resumen simplificado de Costos (Comida / Bebida) ────────────────────────
// GET /api/costos/resumen?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Fuente de gastos: Movimientos hoja "Movimientos", grupo "Mercaderia".
// Clasificación Comida/Bebida: hoja "Costos Proveedores" en Gestión Mercedes.
// Si no se pasan fechas, defaultea al mes en curso.
app.get('/api/costos/resumen', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Período: default = mes en curso (hora Buenos Aires)
    let { desde, hasta } = req.query;
    if (!desde || !hasta) {
      const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      if (!desde) desde = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
      if (!hasta) hasta = hoy.toISOString().slice(0, 10);
    }

    // Traer movimientos, ventas y consumo real de stock (bebida) en paralelo
    // getVentasConCosto = getVentasItems enriquecido con product.cost de Fudo
    const [todosMovs, ventasConCosto, consumoStock] = await Promise.all([
      getMovimientos().catch(() => []),
      getVentasConCosto({ desde, hasta }).catch(() => []),
      stockBebidas.getConsumoMensualBebidas({ desde, hasta }).catch(() => null),
    ]);

    // Filtrar: solo Gastos de Mercadería del período, sin cuotas ni cambios
    const movsMercaderia = todosMovs.filter(m => {
      if (m.tipo !== 'Gasto') return false;
      if (m.esCambio || m.esFondeo || m.esCuota) return false;
      if (m.grupo !== 'Mercaderia') return false;
      const fechaStr = m.fecha ? m.fecha.toISOString().slice(0, 10) : null;
      if (!fechaStr) return false;
      if (desde && fechaStr < desde) return false;
      if (hasta && fechaStr > hasta) return false;
      return true;
    });

    // Clasificar gastos por proveedor (Comida% / Bebida%)
    const gastos = await costosProveedores.clasificarMovimientos(movsMercaderia);

    const data = costos.resumenCostosSimplificado(gastos, ventasConCosto, { desde, hasta }, consumoStock);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error /api/costos/resumen:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/stock-bebidas/snapshot — toma la foto de stock de HOY manualmente
// (idempotente: si ya existe un snapshot de hoy, no hace nada). Útil para
// pruebas o para forzar un catch-up sin esperar a que reinicie el server.
app.post('/api/stock-bebidas/snapshot', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await stockBebidas.tomarSnapshot();
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error POST /api/stock-bebidas/snapshot:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Config de proveedores para Costos ────────────────────────────────────────
// GET /api/costos/proveedores → lista la config completa
app.get('/api/costos/proveedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await costosProveedores.listarConfig();
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error GET /api/costos/proveedores:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/costos/proveedores → guarda config de uno o varios proveedores
// Body: [{ proveedor, comidaPct, bebidaPct, notas? }]  (array)
//    o: { proveedor, comidaPct, bebidaPct, notas? }     (objeto único)
app.post('/api/costos/proveedores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Nada que guardar' });
    for (const it of items) {
      if (!it.proveedor) return res.status(400).json({ ok: false, error: 'Falta proveedor en algún item' });
      const cp = Number(it.comidaPct) || 0;
      const bp = Number(it.bebidaPct) || 0;
      if (cp < 0 || cp > 100 || bp < 0 || bp > 100) {
        return res.status(400).json({ ok: false, error: `Porcentajes inválidos para ${it.proveedor}` });
      }
    }
    await costosProveedores.guardarConfigBatch(items);
    res.json({ ok: true, guardados: items.length });
  } catch (err) {
    console.error('Error POST /api/costos/proveedores:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Diagnóstico: shape de stock-movements de Fudo (temporal) ────────────────
app.get('/api/fudo/probe-stock-movements', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await probeStockMovements();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Probe de UN solo recurso — evita el rate limit del probe masivo
// GET /api/fudo/probe-stock-single?resource=stock-movements&size=5
app.get('/api/fudo/probe-stock-single', authMiddleware, adminOnly, async (req, res) => {
  try {
    const resource = req.query.resource || 'stock-movements';
    const size = parseInt(req.query.size) || 3;
    const desde = req.query.desde || '';
    const hasta = req.query.hasta || '';
    const token = await (require('./fudo').getToken ? require('./fudo') : { getToken: async () => '' });

    // Usar fetchRetry directamente desde fudo no es posible sin exponerla,
    // así que llamamos probeStockMovements con un solo candidato vía workaround:
    // Re-implementamos la llamada simple acá.
    const { default: nodeFetch } = await import('node-fetch').catch(() => ({ default: fetch }));
    const _fetch = typeof fetch !== 'undefined' ? fetch : nodeFetch;
    const API_BASE = process.env.FUDO_API_BASE || 'https://api.fu.do/v1alpha1';
    const AUTH_URL = process.env.FUDO_AUTH_URL || 'https://auth.fu.do/api';
    const API_KEY = process.env.FUDO_API_KEY;
    const API_SECRET = process.env.FUDO_API_SECRET;

    // Auth
    const authRes = await _fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY, apiSecret: API_SECRET }),
    });
    const authJson = await authRes.json();
    const fudoToken = authJson.token;

    // Build URL with optional date filters
    let url = `${API_BASE}/${resource}?page[size]=${size}`;
    if (desde) url += `&filter[from]=${desde}`;
    if (hasta) url += `&filter[to]=${hasta}`;

    const r = await _fetch(url, {
      headers: { 'Authorization': `Bearer ${fudoToken}`, 'Accept': 'application/json' },
    });
    const status = r.status;
    let body = null;
    try { body = await r.json(); } catch(e) { body = await r.text().catch(() => null); }
    res.json({ ok: r.ok, status, resource, url, body });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Módulo Proveedores (ingesta de facturas + dashboard de costos) ───────────
// registrarGastoEnLibro se inyecta: la escritura en Movimientos necesita
// normalizarMedio, estadoCaja y clearCache, que viven acá. Ver su comentario.
app.use(proveedoresRoutes({ authMiddleware, adminOnly, registrarGastoEnLibro }));

// ─── Static y fallback ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Antes de aceptar tráfico: si el proceso anterior murió (deploy, crash) con la
// caja abierta, restaurar esa sesión desde la planilla en vez de perderla en
// memoria — de lo contrario el próximo GET /api/arqueo/estado mostraría "cerrada"
// aunque el turno siga en curso, y esa noche quedaría sin arquear.
(async () => {
  const persistido = await cargarEstadoCaja();
  if (persistido && persistido.abierta) {
    estadoCaja = persistido;
    console.log(`Caja restaurada tras reinicio: abierta desde ${persistido.apertura} (${persistido.encargado})`);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mercedes Dashboard corriendo en puerto ${PORT}`);
    iniciarCron();
  });
})();

module.exports = { buildFilasCierreServicio, leerProveedoresSheet, registrarGastoEnLibro, construirFilaGasto };
