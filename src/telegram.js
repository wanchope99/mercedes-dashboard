// ─── El único canal que sale de la app ────────────────────────────────────────
//
// Hasta el 06/09/2026 esta app no mandaba NADA. Cinco crons, cuatro fuentes de
// notificación y dos avisos de severidad alta, y todo esperaba a que alguien
// abriera la pantalla. Un "se pagó dos veces" podía quedar sin leer hasta la
// mañana siguiente. El bot de Telegram ya estaba construido y andando, pero sólo
// de entrada: el `chatId` se venía guardando desde hace meses "para poder
// responder por el bot" y no había un solo emisor.
//
// QUÉ SALE POR ACÁ Y QUÉ NO. Sólo los avisos de severidad alta, que hoy son dos
// y los dos son de plata: se pagó más de lo cargado, y se pagó algo que ya
// estaba pago. Nada periódico, nada de resúmenes, nada de recordatorios. Este
// repo ya desarmó tres alarmas por ruidosas —el cierre de cocina en la
// campanita, el control semanal de facturación en los informes, los horarios en
// el informe de salón— y la regla que quedó escrita es la misma: una alarma que
// suena siempre deja de escucharse. Un mensaje de Telegram tiene menos derecho
// todavía a sonar, porque interrumpe.
//
// NUNCA TIRA, y eso es parte del contrato. Lo llama `avisos.registrar()`, que a
// su vez lo llama alguien que ya escribió la fila del libro y ya marcó el
// pedido. Una recepción no puede fallar porque no se pudo mandar un mensaje.
// Cuando falla, el aviso igual quedó en la hoja y en la campanita: se pierde la
// inmediatez, no el registro.
//
// CONFIGURACIÓN. `TELEGRAM_BOT_TOKEN` es el mismo token del bot (mismo bot,
// misma frontera de confianza, igual que el token de ingest). El chat de cada
// persona va en `TELEGRAM_CHAT_<USUARIO>` —una variable por persona, como las
// contraseñas— porque este repo es público y porque un chat id es un dato de
// alguien. Sin token, o sin la variable de esa persona, el módulo se apaga solo
// y lo dice en el log: mismo criterio que `PROVEEDORES_SHEET_ID` en facturas.js.

// Se acepta cualquiera de los dos nombres. El bot, que es otro servicio de
// Railway con su propio entorno, la llama `TELEGRAM_TOKEN`; acá el nombre
// preferido es `TELEGRAM_BOT_TOKEN` porque en la app "telegram" solo sería
// ambiguo. Aceptar los dos es más barato que un deploy silenciosamente mudo
// porque se copió el nombre de la otra mitad del repo.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
const TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 8000);

// Telegram corta los mensajes en 4096; se manda bastante menos porque un aviso
// que no entra en una notificación del teléfono no cumple su función.
const LARGO_MAX = 900;

function configurado() { return !!TOKEN; }

/**
 * El chat de una persona, por su nombre de usuario de la app.
 * `tincho` → TELEGRAM_CHAT_TINCHO. Devuelve '' si no está seteada, que es la
 * forma de decir "esta persona no recibe por Telegram" sin que sea un error.
 */
function chatDe(usuario) {
  const u = String(usuario || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!u) return '';
  return String(process.env[`TELEGRAM_CHAT_${u}`] || '').trim();
}

// Telegram interpreta el texto si se le pide un parse_mode. No se le pide
// ninguno: el título y el detalle de un aviso llevan nombres de proveedor e
// importes escritos por gente, y un guion bajo o un asterisco en el medio
// rompería el mensaje entero o lo dejaría a medias. El bot ya aprendió eso
// (`_mostrar` reintenta sin Markdown); acá directamente no se entra en el
// problema. Texto plano, siempre.
async function enviar(chatId, texto) {
  if (!TOKEN) return { ok: false, error: 'Falta TELEGRAM_BOT_TOKEN' };
  if (!chatId) return { ok: false, error: 'Sin chat id' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(texto || '').slice(0, LARGO_MAX),
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status} ${cuerpo.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** El texto de un aviso, tal como llega al teléfono. */
function textoDeAviso({ titulo, detalle, quien }) {
  const lineas = [`⚠️ ${titulo}`];
  if (detalle) lineas.push('', detalle);
  if (quien) lineas.push('', `Lo registró: ${quien}`);
  lineas.push('', 'Está en la campanita de la app.');
  return lineas.join('\n');
}

/**
 * Manda un aviso a sus destinatarios. Devuelve a quiénes les llegó y a quiénes
 * no, para que la pantalla que provocó el aviso pueda decirlo — que los dueños
 * NO se enteraron es exactamente el dato que hace que alguien lo mencione en
 * persona.
 *
 * No espera a que termine quien la llama: se invoca sin await desde
 * `avisos.registrar()`, que ya devolvió.
 */
async function avisar(aviso) {
  const resultado = { enviados: [], fallaron: [], apagado: !configurado() };
  if (!configurado()) return resultado;
  if (String(aviso && aviso.severidad).toLowerCase() !== 'alta') return resultado;

  const texto = textoDeAviso(aviso);
  for (const usuario of aviso.para || []) {
    const chat = chatDe(usuario);
    if (!chat) continue;   // esa persona no recibe por Telegram: no es un fallo
    const r = await enviar(chat, texto);
    if (r.ok) resultado.enviados.push(usuario);
    else {
      resultado.fallaron.push(usuario);
      console.warn(`Telegram: no se pudo avisar a ${usuario} (${r.error})`);
    }
  }
  return resultado;
}

module.exports = { configurado, chatDe, enviar, avisar, textoDeAviso, LARGO_MAX };
