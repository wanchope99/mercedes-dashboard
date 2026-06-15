"""
Bar Proveedores Bot (cliente delgado)
--------------------------------------
Recibe una foto de factura/remito en Telegram y la reenvía a la app
mercedes-dashboard. TODA la inteligencia (extracción con Claude, normalización,
inferencia de categorías y escritura en Google Sheets) vive en la app.

Flujo:
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


async def post_resolver(pendiente_id: str, resoluciones: dict) -> dict:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as cli:
        r = await cli.post(
            f"{APP_BASE_URL}/api/proveedores/pendientes/{pendiente_id}/resolver",
            json={"resoluciones": resoluciones},
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


# ── Auth ──────────────────────────────────────────────────────────────
def is_allowed(update: Update) -> bool:
    if not ALLOWED_USERS:
        return True
    username = (update.effective_user.username or "").lower()
    return username in {u.lower() for u in ALLOWED_USERS}


# ── Estado de confirmaciones por chat ─────────────────────────────────
# context.chat_data["pend"] = {
#   "id": pendiente_id,
#   "items": [...],                # items con dudas devueltos por la app
#   "cola": [(item_idx, campo), ...],  # dudas a resolver, en orden
#   "resoluciones": { item_idx: { campo: valor } },
#   "esperando_texto": (item_idx, campo) | None,
# }

CAMPO_LABEL = {
    "categoria": "categoría",
    "medioPago": "medio de pago",
    "iva": "¿se paga con o sin IVA?",
    "producto": "nombre del producto",
    "precio_unitario": "precio unitario",
}

# Índice especial para las dudas de FACTURA (medio de pago, IVA): -1.
FACTURA_IDX = -1


def construir_cola(items, factura=None):
    cola = []
    # Primero las dudas de FACTURA (medio de pago, IVA) — se preguntan una vez.
    for d in (factura or {}).get("dudas", []):
        cola.append((FACTURA_IDX, d["campo"]))
    for it in items:
        for d in it.get("dudas", []):
            cola.append((it["idx"] if "idx" in it else items.index(it), d["campo"]))
    return cola


def duda_factura(factura, campo):
    for d in (factura or {}).get("dudas", []):
        if d["campo"] == campo:
            return d
    return None


def duda_de(pend, item_idx, campo):
    if item_idx == FACTURA_IDX:
        fact = pend.get("factura") or {}
        d = duda_factura(fact, campo)
        if d:
            # "it" sintético para mostrar contexto del proveedor
            return {"producto": "(toda la factura)", "proveedor": fact.get("proveedor", "?")}, d
        return None, None
    items = pend["items"]
    for it in items:
        idx = it.get("idx", items.index(it))
        if idx == item_idx:
            for d in it.get("dudas", []):
                if d["campo"] == campo:
                    return it, d
    return None, None


async def preguntar_siguiente(update_or_query, context):
    """Toma la próxima duda de la cola y la pregunta. Si no quedan, resuelve."""
    pend = context.chat_data.get("pend")
    if not pend:
        return

    # Asegurar idx en items
    for i, it in enumerate(pend["items"]):
        it.setdefault("idx", i)

    if not pend["cola"]:
        await finalizar(update_or_query, context)
        return

    item_idx, campo = pend["cola"][0]
    it, d = duda_de(pend, item_idx, campo)
    if it is None:
        pend["cola"].pop(0)
        await preguntar_siguiente(update_or_query, context)
        return

    prod = it.get("producto") or "(producto ilegible)"
    prov = it.get("proveedor") or "?"
    label = CAMPO_LABEL.get(campo, campo)
    sugerido = d.get("sugerido")
    sug_txt = f"\nSugerencia: *{sugerido}*" if sugerido else ""
    fuente = d.get("fuente", "")
    fuente_txt = {
        "proveedor-historico": " (según compras previas de este proveedor)",
        "producto-historico": " (según compras previas de este producto)",
        "keywords": " (estimado por el nombre)",
        "baja-confianza": " (la imagen no era clara)",
        "plazo-no-es-medio": " (la factura dice \"Contado\", que es un plazo, no el medio real)",
        "proveedor-config": " (medio habitual de este proveedor)",
    }.get(fuente, "")

    texto = (
        f"🧾 *{prov}* — {prod}\n"
        f"Necesito confirmar la *{label}*.{sug_txt}{fuente_txt}"
    )

    opciones = d.get("opciones", [])
    chat = _chat(update_or_query)

    if opciones:
        # Botones inline. callback_data: "r|<item_idx>|<campo>|<n>" donde n indexa opciones.
        botones, fila = [], []
        for n, op in enumerate(opciones):
            etiqueta = ("✅ " + op) if op == sugerido else op
            fila.append(InlineKeyboardButton(etiqueta[:40], callback_data=f"r|{item_idx}|{campo}|{n}"))
            if len(fila) == 2:
                botones.append(fila); fila = []
        if fila:
            botones.append(fila)
        botones.append([InlineKeyboardButton("⏭️ Dejar para la app", callback_data=f"skip|{item_idx}|{campo}|0")])
        # Guardar opciones para resolver el callback
        pend.setdefault("opciones", {})[f"{item_idx}|{campo}"] = opciones
        await context.bot.send_message(chat, texto, parse_mode="Markdown",
                                       reply_markup=InlineKeyboardMarkup(botones))
    else:
        # Campo de texto libre (producto / precio): esperamos el próximo mensaje.
        pend["esperando_texto"] = (item_idx, campo)
        await context.bot.send_message(
            chat,
            texto + "\n\nEscribí el valor correcto (o mandá «-» para dejarlo a la app).",
            parse_mode="Markdown",
        )


def _chat(update_or_query):
    if hasattr(update_or_query, "message") and update_or_query.message:
        return update_or_query.message.chat_id
    if hasattr(update_or_query, "effective_chat") and update_or_query.effective_chat:
        return update_or_query.effective_chat.id
    return update_or_query.callback_query.message.chat_id


async def finalizar(update_or_query, context):
    pend = context.chat_data.get("pend")
    chat = _chat(update_or_query)
    if not pend:
        return
    try:
        resp = await post_resolver(pend["id"], pend["resoluciones"])
    except Exception as e:
        log.exception("Error al resolver")
        await context.bot.send_message(chat, f"❌ Error al guardar: {e}")
        return

    status = resp.get("status")
    if status == "escrito":
        await context.bot.send_message(
            chat, f"✅ {resp.get('message', 'Cargado.')}\n_Verificá en la planilla si algo quedó mal._",
            parse_mode="Markdown",
        )
        context.chat_data.pop("pend", None)
    elif status == "incompleto":
        # Quedaron dudas que el usuario decidió dejar para la app.
        await context.bot.send_message(
            chat,
            f"📋 {resp.get('message')}\nLo pendiente quedó en el panel *Proveedores* de la app para confirmar ahí.",
            parse_mode="Markdown",
        )
        context.chat_data.pop("pend", None)
    else:
        await context.bot.send_message(chat, f"ℹ️ {resp.get('message', 'Listo.')}")
        context.chat_data.pop("pend", None)


# ── Handlers ──────────────────────────────────────────────────────────
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Hola! Mandame una foto de una factura o remito y la cargo en la "
        "planilla de Compras.\n\nSi algún dato no queda claro, te pregunto acá "
        "mismo antes de guardarlo."
    )


async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_allowed(update):
        await update.message.reply_text("⛔ No tenés permiso para usar este bot.")
        return

    # Si estábamos esperando texto para una duda, esto NO es una nueva factura.
    await update.message.reply_text("📸 Recibí la foto, procesando...")

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

    if status == "escrito":
        lines = [f"✅ {resp.get('message')}"]
        for it in resp.get("items", []):
            lines.append(f"• *{it.get('producto','?')}* — {it.get('proveedor','?')} "
                         f"— ${it.get('precioUnit','?')} ({it.get('categoria','?')})")
        await update.message.reply_text("\n".join(lines), parse_mode="Markdown")
        return

    if status == "sin_datos":
        await update.message.reply_text("⚠️ No pude leer productos. Probá con una foto más nítida.")
        return

    if status == "pendiente":
        items = resp.get("items", [])
        for i, it in enumerate(items):
            it.setdefault("idx", i)
        factura = resp.get("factura", {}) or {}
        context.chat_data["pend"] = {
            "id": resp.get("pendienteId"),
            "items": items,
            "factura": factura,
            "cola": construir_cola(items, factura),
            "resoluciones": {},
            "esperando_texto": None,
            "opciones": {},
        }
        nfac = len((factura or {}).get("dudas", []))
        ndud = resp.get("conDudas", 0)
        partes = []
        if nfac: partes.append("datos de la factura (medio de pago / IVA)")
        if ndud: partes.append(f"{ndud} producto(s)")
        detalle = " y ".join(partes) if partes else "algunos datos"
        await update.message.reply_text(
            f"📝 Leí {resp.get('total')} producto(s). Necesito confirmar {detalle}:"
        )
        await preguntar_siguiente(update, context)
        return

    await update.message.reply_text(f"ℹ️ {resp.get('message', 'Listo.')}")


async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    pend = context.chat_data.get("pend")
    if not pend:
        await query.edit_message_text("Esta confirmación ya expiró. Mandá la foto de nuevo si hace falta.")
        return

    accion, item_idx, campo, n = query.data.split("|")
    item_idx, n = int(item_idx), int(n)

    if accion == "skip":
        # Quitar esta duda de la cola → quedará pendiente en la app.
        pend["cola"] = [c for c in pend["cola"] if not (c[0] == item_idx and c[1] == campo)]
        await query.edit_message_text("⏭️ Lo dejo para confirmar en la app.")
        await preguntar_siguiente(query, context)
        return

    opciones = pend.get("opciones", {}).get(f"{item_idx}|{campo}", [])
    valor = opciones[n] if 0 <= n < len(opciones) else None
    if valor is None:
        await query.edit_message_text("No pude registrar la opción, probá de nuevo.")
        return

    key = "factura" if item_idx == FACTURA_IDX else item_idx
    pend["resoluciones"].setdefault(key, {})[campo] = valor
    pend["cola"] = [c for c in pend["cola"] if not (c[0] == item_idx and c[1] == campo)]
    etiqueta = CAMPO_LABEL.get(campo, campo)
    await query.edit_message_text(f"✅ {etiqueta}: *{valor}*", parse_mode="Markdown")
    await preguntar_siguiente(query, context)


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    pend = context.chat_data.get("pend")
    if not pend or not pend.get("esperando_texto"):
        return  # texto suelto sin contexto: ignorar
    item_idx, campo = pend["esperando_texto"]
    valor = (update.message.text or "").strip()
    pend["esperando_texto"] = None

    if valor and valor != "-":
        # producto → texto; precio_unitario → número
        if campo == "precio_unitario":
            try:
                valor_num = float(valor.replace(".", "").replace(",", "."))
                key = "factura" if item_idx == FACTURA_IDX else item_idx
                pend["resoluciones"].setdefault(key, {})["precioUnit"] = valor_num
            except ValueError:
                await update.message.reply_text("No entendí el número. Probá de nuevo (ej: 17990).")
                pend["esperando_texto"] = (item_idx, campo)
                return
        else:
            key = "factura" if item_idx == FACTURA_IDX else item_idx
            pend["resoluciones"].setdefault(key, {})[campo] = valor
        await update.message.reply_text(f"✅ Anotado: *{valor}*", parse_mode="Markdown")
    else:
        await update.message.reply_text("⏭️ Lo dejo para la app.")

    pend["cola"] = [c for c in pend["cola"] if not (c[0] == item_idx and c[1] == campo)]
    await preguntar_siguiente(update, context)


# ── Main ──────────────────────────────────────────────────────────────
def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.Document.IMAGE, handle_photo))
    app.add_handler(CallbackQueryHandler(on_button))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))

    log.info("Bot (cliente delgado) iniciado. App: %s", APP_BASE_URL)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
