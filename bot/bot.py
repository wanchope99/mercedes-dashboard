"""
Bar Mercedes Bot (cliente delgado)
-----------------------------------
Hace dos cosas, las dos con el mismo patrón: recibe algo por Telegram y lo
reenvía a la app mercedes-dashboard. TODA la inteligencia (extracción con
Claude, normalización, inferencia de categorías y escritura en Google Sheets)
vive en la app.

1) FACTURAS — una foto de factura/remito:
  1. Martin/Pablo manda una foto al bot.
  2. El bot la descarga y la POSTea a  POST /api/proveedores/ingest.
  3. La app responde:
       · status="escrito"    → listo, confirma cuántos productos cargó.
       · status="sin_datos"  → no pudo leer la imagen.
       · status="pendiente"  → algún dato (categoría, medio de pago, producto,
                               precio) no quedó claro. El bot pregunta por chat,
                               junta las respuestas y llama a
                               POST /api/proveedores/pendientes/<id>/resolver.
  4. Lo que el usuario no resuelva por Telegram queda en el panel de la app.

2) MANTENIMIENTO — lo que hay que arreglar:
  · /arreglo se quemó la lámpara del baño  → POST /api/mantenimiento/ingest
  · /pendientes                            → GET  /api/mantenimiento/pendientes
  Se anota en el acto con prioridad normal y el bot ofrece tres botones para
  corregirla. Anotar primero y afinar después es a propósito: si hay que elegir
  sector y prioridad ANTES de que quede guardado, en pleno servicio no se anota.

El bot NO accede a Google Sheets ni a la API de Claude: solo habla con la app
mediante un token de servicio (PROVEEDORES_INGEST_TOKEN).
"""

import os
import base64
import logging

import httpx
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes,
)

load_dotenv()

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
# URL base de la app mercedes-dashboard (ej: https://mercedes-dashboard.up.railway.app)
APP_BASE_URL = os.environ["APP_BASE_URL"].strip().rstrip("/")
# Tolerancia: si la variable se cargó sin esquema, asumimos https://
if APP_BASE_URL and not APP_BASE_URL.startswith(("http://", "https://")):
    APP_BASE_URL = "https://" + APP_BASE_URL
# Token de servicio que la app valida en el header X-Ingest-Token.
INGEST_TOKEN = os.environ["PROVEEDORES_INGEST_TOKEN"]
ALLOWED_USERS = set(u.strip() for u in os.environ.get("ALLOWED_USERS", "").split(",") if u.strip())

HTTP_TIMEOUT = float(os.environ.get("BOT_HTTP_TIMEOUT", "120"))


# ── Helpers HTTP ──────────────────────────────────────────────────────
def _headers():
    return {"X-Ingest-Token": INGEST_TOKEN, "Content-Type": "application/json"}


async def post_ingest(image_bytes: bytes, mime: str, origen: dict, nombre: str) -> dict:
    payload = {
        "imageBase64": base64.standard_b64encode(image_bytes).decode("utf-8"),
        "mime": mime,
        "origen": origen,
        "imagenInfo": {"nombre": nombre},
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as cli:
        r = await cli.post(f"{APP_BASE_URL}/api/proveedores/ingest", json=payload, headers=_headers())
        r.raise_for_status()
        return r.json()


async def post_paso(pendiente_id: str, campo: str, valor) -> dict:
    """Contesta un paso de la conversación y trae el siguiente.

    El bot no sabe qué se está preguntando ni qué sigue: manda el botón que se
    tocó y dibuja lo que vuelve. Toda la lógica vive en la app
    (src/compra-conversacion.js), que es donde se puede probar.
    """
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as cli:
        r = await cli.post(
            f"{APP_BASE_URL}/api/proveedores/pendientes/{pendiente_id}/paso",
            json={"campo": campo, "valor": valor},
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


# ── Mantenimiento ─────────────────────────────────────────────────────
async def post_arreglo(titulo: str, quien: str) -> dict:
    """Anota algo para arreglar. El sector y la prioridad los pone la app por
    defecto (Otros / normal): se ajustan después, con los botones o en la app."""
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as cli:
        r = await cli.post(
            f"{APP_BASE_URL}/api/mantenimiento/ingest",
            json={"titulo": titulo, "reportadoPor": quien},
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


async def put_arreglo(item_id: str, cambios: dict) -> dict:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as cli:
        r = await cli.put(
            f"{APP_BASE_URL}/api/mantenimiento/ingest/{item_id}",
            json=cambios,
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


async def get_arreglos_pendientes() -> list:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as cli:
        r = await cli.get(f"{APP_BASE_URL}/api/mantenimiento/pendientes", headers=_headers())
        r.raise_for_status()
        return r.json().get("data", [])


# ── Auth ──────────────────────────────────────────────────────────────
def is_allowed(update: Update) -> bool:
    if not ALLOWED_USERS:
        return True
    username = (update.effective_user.username or "").lower()
    return username in {u.lower() for u in ALLOWED_USERS}


# ── La conversación de una factura ────────────────────────────────────
#
# El bot NO decide qué preguntar. La app manda un "paso" ya armado —el texto,
# los botones, si acepta que se escriba— y acá sólo se dibuja y se devuelve el
# botón que se tocó.
#
# Antes la lógica estaba partida: la app armaba las dudas y este archivo decidía
# el orden, armaba la cola y traducía las etiquetas. Se desincronizaron (el
# mensaje llegó a decir "Leí None producto(s)") y ese es el motivo de que ahora
# viva de un solo lado. El otro motivo, más terco: en la máquina donde se
# desarrolla no hay Python, así que lo que quede acá no se puede ni ejecutar.
#
# context.chat_data["pend"] = {
#   "id":      pendiente_id,
#   "mid":     message_id de la tarjeta que se va editando,
#   "campo":   qué se está preguntando ahora,
#   "botones": [id, ...] en el mismo orden que se dibujaron,
#   "texto":   True si además se puede contestar escribiendo,
# }

# callback_data tiene 64 bytes: se manda el ÍNDICE del botón, no su valor. Un
# nombre de categoría o una fecha ISO no siempre entran, y truncarlos silencioso
# sería contestar otra cosa.
CB_PASO = "p"


def _teclado(paso):
    """Los botones del paso, de a dos por fila."""
    botones, fila = [], []
    for n, b in enumerate(paso.get("botones") or []):
        etiqueta = b.get("label", "")
        if b.get("sugerido"):
            etiqueta = "✅ " + etiqueta
        fila.append(InlineKeyboardButton(etiqueta[:40], callback_data=f"{CB_PASO}|{n}"))
        if len(fila) == 2:
            botones.append(fila); fila = []
    if fila:
        botones.append(fila)
    return InlineKeyboardMarkup(botones) if botones else None


def _texto_paso(resp):
    """El resumen arriba y la pregunta abajo, siempre en el mismo mensaje.

    Que el resumen esté SIEMPRE a la vista es lo que permite contestar sin
    scrollear: lo que se está por escribir en la planilla no puede quedar dos
    mensajes atrás.
    """
    partes = []
    if resp.get("error"):
        partes.append(f"⚠️ {resp['error']}")
    if resp.get("resumen"):
        partes.append(resp["resumen"])
    paso = resp.get("paso") or {}
    if paso.get("texto"):
        partes.append(paso["texto"])
    if paso.get("ayuda"):
        partes.append(f"_{paso['ayuda']}_")
    return "\n\n".join(p for p in partes if p)


async def dibujar(context, chat_id, resp, mid=None):
    """Dibuja el paso que mandó la app, editando la tarjeta si ya existe.

    Devuelve el message_id de la tarjeta.
    """
    texto = _texto_paso(resp)
    teclado = _teclado(resp.get("paso") or {})
    return await _mostrar(context, chat_id, texto, teclado, mid)


async def _mostrar(context, chat_id, texto, teclado=None, mid=None):
    """Manda o edita un mensaje, y si el Markdown no parsea lo manda plano.

    El nombre de un proveedor puede traer `_` o `*` (viene de una factura, no de
    nosotros) y eso rompe el parser de Telegram. Perder la negrita es aceptable;
    perder el mensaje entero no.
    """
    for modo in ("Markdown", None):
        try:
            if mid:
                m = await context.bot.edit_message_text(
                    chat_id=chat_id, message_id=mid, text=texto,
                    parse_mode=modo, reply_markup=teclado)
            else:
                m = await context.bot.send_message(
                    chat_id, texto, parse_mode=modo, reply_markup=teclado)
            return m.message_id if hasattr(m, "message_id") else mid
        except Exception as e:
            # "message is not modified" no es un error que valga reintentar.
            if "not modified" in str(e).lower():
                return mid
            if modo is None:
                log.warning("No se pudo mostrar el mensaje: %s", e)
                return mid
    return mid


def _guardar_paso(context, pendiente_id, resp, mid):
    paso = resp.get("paso") or {}
    context.chat_data["pend"] = {
        "id": pendiente_id,
        "mid": mid,
        "campo": paso.get("campo") or ("confirmar" if paso.get("tipo") == "confirmar" else ""),
        "botones": [b.get("id") for b in (paso.get("botones") or [])],
        "texto": bool(paso.get("permiteTexto")),
    }


def _texto_final(resp):
    """Lo que quedó escrito. El que sacó la foto tiene que poder verlo sin abrir
    la app: si el monto o la caja están mal, es AHORA cuando se da cuenta."""
    lineas = ["✅ *Cargado.*", ""]
    if resp.get("resumen"):
        lineas.append(resp["resumen"])
        lineas.append("")
    if resp.get("enElLibro"):
        lineas.append("📒 Quedó anotado en Movimientos.")
    else:
        lineas.append("📒 Todavía NO entra en Movimientos: se anota cuando llegue el pedido.")
    ped = resp.get("pedido")
    if ped:
        n = ped.get("items") or 0
        detalle = f" con {n} producto{'s' if n != 1 else ''} para tildar" if n else ""
        lineas.append(f"📦 Pedido anotado para el {ped.get('fecha', '')}{detalle}.")
    if resp.get("escritas"):
        lineas.append(f"🧾 {resp['escritas']} renglón/es en la hoja Compras.")
    for a in (resp.get("avisos") or []):
        lineas.append(f"⚠️ {_md(str(a))}")
    return "\n".join(lineas)


async def avanzar(context, chat_id, pendiente_id, campo, valor):
    """Contesta un paso y dibuja lo que venga: otra pregunta, o el resultado."""
    pend = context.chat_data.get("pend") or {}
    mid = pend.get("mid")
    try:
        resp = await post_paso(pendiente_id, campo, valor)
    except httpx.HTTPStatusError as e:
        await _mostrar(context, chat_id, f"❌ La app respondió con error ({e.response.status_code}).", None, mid)
        context.chat_data.pop("pend", None)
        return
    except Exception as e:
        log.exception("Error avanzando la conversación")
        await _mostrar(context, chat_id, f"❌ Error: {e}", None, mid)
        context.chat_data.pop("pend", None)
        return

    if not resp.get("ok"):
        await _mostrar(context, chat_id, f"❌ {resp.get('error', 'No se pudo cargar.')}", None, mid)
        context.chat_data.pop("pend", None)
        return

    status = resp.get("status")
    if status == "escrito":
        await _mostrar(context, chat_id, _texto_final(resp), None, mid)
        context.chat_data.pop("pend", None)
        return
    if status == "cancelado":
        await _mostrar(context, chat_id, f"🚫 {resp.get('message', 'No cargué nada.')}", None, mid)
        context.chat_data.pop("pend", None)
        return

    nuevo_mid = await dibujar(context, chat_id, resp, mid)
    _guardar_paso(context, pendiente_id, resp, nuevo_mid)


# ── Handlers ──────────────────────────────────────────────────────────
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Hola! Hago dos cosas:\n\n"
        "📸 *Compras* — mandame la foto de una factura y la cargo entera: el "
        "gasto en el libro, el IVA, y si lleva entrega también el pedido con la "
        "lista de lo que tiene que llegar, para tildarlo en la puerta.\n"
        "Te muestro lo que leí y confirmás con un toque. La primera factura de "
        "cada proveedor lleva unas preguntas más; después ya las sé.\n\n"
        "🔧 *Arreglos* — `/arreglo se quemó la lámpara del baño` y queda anotado "
        "en la lista de mantenimiento. `/pendientes` para ver qué falta hacer.",
        parse_mode="Markdown",
    )


# ── Mantenimiento ─────────────────────────────────────────────────────
PRIO_BOTONES = [("🔴 Urgente", "urgente"), ("🟡 Normal", "normal"), ("🟢 Puede esperar", "baja")]
PRIO_EMOJI = {"urgente": "🔴", "normal": "🟡", "baja": "🟢"}


def _quien(update: Update) -> str:
    u = update.effective_user
    return u.username or u.first_name or ""


def _md(texto: str) -> str:
    """Escapa lo que escribió la persona antes de meterlo en un mensaje Markdown.

    Sin esto, un `/arreglo cambiar el foco *ya*` rompe el parser de Telegram y el
    mensaje no se envía: el arreglo QUEDÓ guardado pero el bot parece haber
    fallado, que es la peor combinación posible.
    """
    for c in ("_", "*", "`", "["):
        texto = texto.replace(c, "\\" + c)
    return texto


async def cmd_arreglo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update):
        await update.message.reply_text("⛔ No tenés permiso para usar este bot.")
        return

    texto = " ".join(context.args).strip() if context.args else ""
    if not texto:
        # Sin texto: se pide y se captura el próximo mensaje (ver on_text).
        context.chat_data["esperando_arreglo"] = True
        await update.message.reply_text("🔧 ¿Qué hay que arreglar? Escribilo en el próximo mensaje.")
        return

    await _guardar_arreglo(update, context, texto)


async def _guardar_arreglo(update: Update, context: ContextTypes.DEFAULT_TYPE, texto: str):
    try:
        resp = await post_arreglo(texto, _quien(update))
    except httpx.HTTPStatusError as e:
        log.exception("HTTP error arreglo")
        await update.message.reply_text(f"❌ La app respondió con error ({e.response.status_code}).")
        return
    except Exception as e:
        log.exception("Error anotando arreglo")
        await update.message.reply_text(f"❌ Error: {e}")
        return

    item = resp.get("data", {}) or {}
    item_id = item.get("id", "")
    botones = [[
        InlineKeyboardButton(label, callback_data=f"m|{item_id}|{valor}")
        for label, valor in PRIO_BOTONES
    ]]
    await update.message.reply_text(
        f"✅ Anotado: *{_md(item.get('titulo') or texto)}*\n"
        f"Quedó como 🟡 normal. ¿Cambiás la prioridad?",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(botones),
    )


async def cmd_pendientes(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update):
        await update.message.reply_text("⛔ No tenés permiso para usar este bot.")
        return
    try:
        items = await get_arreglos_pendientes()
    except Exception as e:
        log.exception("Error leyendo pendientes")
        await update.message.reply_text(f"❌ Error: {e}")
        return

    if not items:
        await update.message.reply_text("✨ No hay nada pendiente de arreglar.")
        return

    lineas = [f"🔧 *{len(items)} cosa(s) para arreglar:*", ""]
    for it in items:
        emoji = PRIO_EMOJI.get(it.get("prioridad"), "🟡")
        curso = " _(en curso)_" if it.get("estado") == "en curso" else ""
        lineas.append(f"{emoji} {_md(it.get('titulo') or '?')} — {_md(it.get('sector') or '?')}{curso}")
    lineas.append("")
    lineas.append("_Para marcarlas como resueltas, entrá a Mantenimiento en la app._")
    await update.message.reply_text("\n".join(lineas), parse_mode="Markdown")


async def on_boton_prioridad(query, context) -> bool:
    """Botones de prioridad de un arreglo. Devuelve True si manejó el callback."""
    if not query.data.startswith("m|"):
        return False
    _, item_id, prioridad = query.data.split("|", 2)
    try:
        await put_arreglo(item_id, {"prioridad": prioridad})
    except Exception as e:
        log.exception("Error cambiando prioridad")
        await query.edit_message_text(f"❌ No pude cambiar la prioridad: {e}")
        return True
    emoji = PRIO_EMOJI.get(prioridad, "")
    await query.edit_message_text(f"✅ Anotado como {emoji} *{prioridad}*.", parse_mode="Markdown")
    return True


async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update):
        await update.message.reply_text("⛔ No tenés permiso para usar este bot.")
        return

    # Se guarda el id de este mensaje para EDITARLO con el resumen cuando la
    # factura esté leída: así el chat queda con una sola tarjeta por compra.
    aviso = await update.message.reply_text("📸 Leyendo la factura…")
    aviso_mid = aviso.message_id

    try:
        if update.message.photo:
            tg_file = await update.message.photo[-1].get_file()
            mime = "image/jpeg"
            nombre = "foto.jpg"
        else:
            doc = update.message.document
            if doc.mime_type not in ("image/jpeg", "image/png", "image/webp"):
                await update.message.reply_text("Solo acepto imágenes (JPG, PNG, WEBP).")
                return
            tg_file = await doc.get_file()
            mime = doc.mime_type
            nombre = doc.file_name or "archivo"

        buf = await tg_file.download_as_bytearray()
        image_bytes = bytes(buf)

        origen = {
            "tipo": "telegram",
            "chatId": update.effective_chat.id,
            "usuario": update.effective_user.username or update.effective_user.first_name or "",
        }
        resp = await post_ingest(image_bytes, mime, origen, nombre)
    except httpx.HTTPStatusError as e:
        log.exception("HTTP error ingest")
        await update.message.reply_text(f"❌ La app respondió con error ({e.response.status_code}).")
        return
    except Exception as e:
        log.exception("Error procesando foto")
        await update.message.reply_text(f"❌ Error: {e}")
        return

    status = resp.get("status")
    chat = update.effective_chat.id

    if not resp.get("ok"):
        await _mostrar(context, chat, f"❌ {resp.get('error', 'No se pudo leer la factura.')}", None, aviso_mid)
        return

    if status == "sin_datos":
        await _mostrar(context, chat, "⚠️ No pude leer la factura. Probá con una foto más nítida.", None, aviso_mid)
        return

    if status == "pendiente":
        # La misma tarjeta del "leyendo…" se convierte en el resumen con los
        # botones: el chat queda con UN mensaje que se va completando en vez de
        # una tira de preguntas.
        mid = await dibujar(context, chat, resp, aviso_mid)
        _guardar_paso(context, resp.get("pendienteId"), resp, mid)
        return

    await _mostrar(context, chat, f"ℹ️ {resp.get('message', 'Listo.')}", None, aviso_mid)


async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    # Mantenimiento primero: su callback_data tiene 3 partes, no 4, así que el
    # split de abajo reventaría. Además no depende de chat_data, así que sigue
    # funcionando aunque el chat esté en medio de confirmar una factura.
    if await on_boton_prioridad(query, context):
        return

    pend = context.chat_data.get("pend")
    if not pend:
        await query.edit_message_text("Esta confirmación ya expiró. Mandá la foto de nuevo si hace falta.")
        return

    partes = query.data.split("|")
    if len(partes) != 2 or partes[0] != CB_PASO:
        return
    n = int(partes[1])
    botones = pend.get("botones") or []
    if not (0 <= n < len(botones)):
        await query.edit_message_text("No pude registrar la opción, probá de nuevo.")
        return

    valor = botones[n]
    campo = pend.get("campo") or ""

    # "Corregir" viaja como `corregir:<bloque>` en el id del botón, para no
    # gastar un tipo de paso en algo que es una respuesta más.
    if isinstance(valor, str) and valor.startswith("corregir:"):
        campo, valor = "corregir", valor.split(":", 1)[1]
    elif campo == "confirmar":
        valor = "si"

    await avanzar(context, query.message.chat_id, pend["id"], campo, valor)


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # "/arreglo" sin texto deja el chat esperando el próximo mensaje. Se chequea
    # antes que las dudas de factura porque es lo que se acaba de pedir.
    if context.chat_data.pop("esperando_arreglo", False):
        texto = (update.message.text or "").strip()
        if not texto:
            await update.message.reply_text("No entendí. Probá con /arreglo y qué hay que arreglar.")
            return
        await _guardar_arreglo(update, context, texto)
        return

    pend = context.chat_data.get("pend")
    if not pend or not pend.get("texto"):
        return  # texto suelto sin contexto: ignorar

    valor = (update.message.text or "").strip()
    if not valor:
        return

    # El monto y las fechas los interpreta la app, con la misma regla que usa
    # para todo lo demás. Acá ya no se parsea plata: había una tercera copia de
    # esa regla en este archivo y era una de más.
    await avanzar(context, update.effective_chat.id, pend["id"], pend.get("campo") or "", valor)


# ── Main ──────────────────────────────────────────────────────────────
def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("arreglo", cmd_arreglo))
    app.add_handler(CommandHandler("pendientes", cmd_pendientes))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.Document.IMAGE, handle_photo))
    app.add_handler(CallbackQueryHandler(on_button))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))

    log.info("Bot (cliente delgado) iniciado. App: %s", APP_BASE_URL)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
