# Mercedes Dashboard — Setup

## 1. Habilitar Google Sheets API y crear Service Account

1. Ir a [Google Cloud Console](https://console.cloud.google.com) → tu proyecto existente
2. **APIs & Services → Library** → buscar "Google Sheets API" → habilitar
3. **APIs & Services → Credentials → Create Credentials → Service Account**
   - Nombre: `mercedes-dashboard`
   - Role: no es necesario asignar rol de proyecto
4. Entrar a la Service Account creada → **Keys → Add Key → JSON**
   - Se descarga un archivo `credentials.json` — **guardarlo seguro, no subir a git**

## 2. Dar acceso a la planilla

1. Abrir el JSON descargado → copiar el valor de `client_email` (ej: `mercedes-dashboard@proyecto.iam.gserviceaccount.com`)
2. Abrir la planilla "Gestion Mercedes" en Google Sheets
3. **Compartir → pegar el client_email → rol: Lector**

## 3. Correr localmente

```bash
cd mercedes-dashboard
npm install
cp .env.example .env
# Editar .env: pegar el JSON completo de credentials en GOOGLE_CREDENTIALS_JSON
# O poner el archivo credentials.json en la raíz del proyecto
npm run dev
# → http://localhost:3000
```

## 4. Deploy en Railway

1. Subir el proyecto a GitHub (sin `credentials.json` ni `.env`)
2. En Railway → New Project → Deploy from GitHub repo
3. **Variables de entorno** (Settings → Variables):
   - `SPREADSHEET_ID` = `19gIe8Y3PwjQ58z29hFX-n0wnX4BnI0Zd`
   - `GOOGLE_CREDENTIALS_JSON` = pegar el contenido completo del JSON en una línea
     ```
     {"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n..."}
     ```
   - `NOMINA_SHEET_ID` = id de la planilla de nómina (`10yDUZWZZl528NgrmmkIxfxFldOaVId38X3ayve5oBcM`)
   - `STOCKS_SHEET_ID` = id de la planilla de Stocks (`1gEt0H5Rou22jmtpiNFjH79oj8-n_b5azLXKJVZ_zgSk`)
   - `PROVEEDORES_SHEET_ID` = id de la planilla *Comparación Proveedores*
4. Railway detecta `railway.toml` y hace el deploy automáticamente

### La planilla de proveedores

`PROVEEDORES_SHEET_ID`. Ahí viven `Compras`, `Facturas`, `Proveedores Saldos` y
—desde el 07/09/2026— las tres hojas de Pedidos: `Pedidos`, `Pedidos Semanal` y
`Pedidos Items`. Todas se crean solas al primer uso.

**Desde esa mudanza la variable dejó de ser opcional.** Sin ella la sección
Pedidos no funciona y lo dice; antes sólo se apagaban los saldos y el registro de
facturas. Y **no cae a `SPREADSHEET_ID`**: con el fallback, un servidor sin la
variable volvería a crear las hojas en Gestión —justo de donde se las sacó— y
nadie se enteraría hasta encontrarlas ahí.

### La planilla de nómina

Vive **aparte** de Gestión Mercedes y se lee con `NOMINA_SHEET_ID`. Hay que
compartirla con la cuenta de servicio **con rol Editor**. Decía "alcanza Lector" y
dejó de ser cierto el 31/08/2026, cuando la liquidación pasó a cargarse también
desde la app (`guardarLiquidacion` y `guardarEmpleados`); con Lector esas dos
escrituras fallan y el error aparece recién al guardar.

A diferencia de `PROVEEDORES_SHEET_ID`, esta variable **no cae a
`SPREADSHEET_ID`** si falta: son sueldos de gente real y el fallback los pondría
en la planilla que ve más gente. Sin la variable, la sección Nómina devuelve
error y el punto de equilibrio vuelve a estimar el costo laboral como antes —
nada más se rompe.

La app **no le escribe nada**: la planilla se sigue editando a mano.

### La planilla de Stocks

El cierre de cocina (qué comprar, qué producir). Se lee con `STOCKS_SHEET_ID` y
**la cuenta de servicio necesita rol Editor** —igual que en nómina desde el
31/08/2026, así que ya no es la excepción que era—: la
app escribe el estado y los comentarios de los ítems que se marcan, y crea dos
hojas propias de historial (`Cierre Cocina`, `Cierre Cocina Detalle`).

Lo que la app escribe está acotado a propósito: la columna `Estado` y columnas
que agrega al final (`Comentario`, `Actualizado`), y **sólo en las filas que
alguien marcó**. `Checklist seteo` no se toca nunca. Tampoco cae a
`SPREADSHEET_ID` si falta la variable — sin ella la sección dice que no está
configurada y nada más se rompe.

### Usuarios

**Este repositorio es público: ninguna contraseña ni secreto va en el código.**
No hay valores por defecto. Cada cuenta se habilita seteando su variable; la que
no la tiene, no existe y no se puede usar para entrar.

| Variable | Para qué | Si falta |
|---|---|---|
| `JWT_SECRET` | Firma los tokens de sesión | **El server no arranca** |
| `ADMIN_PASSWORD` | Usuario `admin` (rol admin) | La cuenta no existe |
| `CHARLY_PASSWORD` | Usuario `charly` (rol encargado) | La cuenta no existe |
| `PABLO_PASSWORD` | Usuario `pablo` (rol admin) | La cuenta no existe |
| `TINCHO_PASSWORD` | Usuario `tincho` (rol admin) | La cuenta no existe |
| `JUAN_PASSWORD` | Usuario `juan` (rol encargado) | La cuenta no existe |
| `EZEQUIEL_PASSWORD` | Usuario `ezequiel` (rol encargado) | La cuenta no existe |

`JWT_SECRET` tiene que ser largo y aleatorio, y **no se comparte con nadie**:
quien la tenga puede firmarse un token que diga `rol: admin` y entrar sin
contraseña. Cambiarla cierra todas las sesiones abiertas — no hacerlo en medio
del servicio, o quien esté cerrando la caja queda afuera a mitad de camino.

Al arrancar, el server lista en el log qué cuentas quedaron habilitadas y cuál
falta por qué variable. Una cuenta sin su variable se ve, desde la pantalla de
login, igual que una contraseña mal tipeada; ese log es la diferencia entre "me
equivoqué al escribirla" y "esa cuenta no existe en este deploy".

El login admite 10 intentos fallidos por IP y usuario cada 15 minutos, y 30 por
usuario (la segunda cubeta existe porque la IP se puede falsificar). Un login
correcto borra lo acumulado.


### El bot de Telegram

El bot es la **otra puerta al libro**: quien lo puede usar carga una factura, y
con eso escribe una fila de gasto en `Movimientos`, elige de qué caja sale la
plata y registra el IVA. En la app eso está detrás de un login con JWT y de
`adminOnly`; en el bot está detrás de una sola variable.

| Variable | Servicio | Qué pasa si falta |
|---|---|---|
| `TELEGRAM_TOKEN` | bot | El bot no arranca |
| `ALLOWED_USERS` | bot | **El bot no atiende a NADIE** |
| `PROVEEDORES_INGEST_TOKEN` | bot y app | El bot no puede escribir en la app |
| `MANTENIMIENTO_INGEST_TOKEN` | app | Se usa `PROVEEDORES_INGEST_TOKEN` (mismo bot, misma frontera) |
| `FOTO_LADO_MINIMO` | bot | `0` — el tamaño de foto que se le pide a Telegram (0 = el mayor) |

**`ALLOWED_USERS` es obligatoria desde el 06/09/2026.** Antes, si estaba vacía el
bot atendía a cualquiera que lo encontrara: fallaba abierta. Ahora falla cerrada,
que es el mismo criterio que las contraseñas —una cuenta sin su variable no
existe, en vez de quedar sin contraseña—. Al arrancar, el bot dice en el log
cuántos usuarios quedaron habilitados, o grita si quedó en cero.

Se cargan separados por coma, y vale tanto el `@username` como el **user id
numérico** de Telegram. Conviene el id: un username se libera y lo puede reclamar
otra persona, y el id no cambia nunca.

```
ALLOWED_USERS=gonzalo_ok,123456789,charly_bar
```

**`FOTO_LADO_MINIMO` está en 0, y eso es un resultado medido, no un pendiente.**
Telegram guarda cada foto en varios tamaños y los manda todos; el bot puede tomar
el más chico cuyo lado largo llegue a ese número, y con 0 se queda con el mayor,
que es lo que hizo siempre.

Parecía la palanca fácil —la imagen viaja al modelo **dos veces** por factura y
se paga por píxel—, pero el 11/09/2026 se midió sobre siete facturas reales del
chat y **el ahorro fue cero**: cinco de las siete ya venían a 1280 px porque
Telegram las comprime antes de que el bot elija nada, y las otras dos quedaban
apenas encima del techo de 1568 px al que la API escala todo igual. La foto chica
encima *perdió* una lectura de proveedor que la grande tenía.

Lo que quedó es el log: el bot dice en cada foto qué tamaño eligió de cuántos le
ofrecieron. Es lo único que puede decir, con volumen real, si esto alguna vez
cambia — y si cambia, subir el número es una variable, no un deploy.

### El modelo que lee las facturas: uno por mitad

| Variable | Servicio | Default |
|---|---|---|
| `EXTRACTOR_MODEL_CABECERA` | app | `claude-haiku-4-5` |
| `EXTRACTOR_MODEL_ITEMS` | app | `claude-opus-4-6` |
| `EXTRACTOR_MODEL` | app | — pisa las dos anteriores |
| `PROVEEDORES_UMBRAL_CONFIANZA` | app | `0.6` |

Leer facturas es cerca del 60% del costo de una instancia y la única línea que
crece con el uso. El extractor hace **dos llamadas** —cabecera y renglones, en
paralelo, ver el encabezado de `src/extractor.js`— y el 11/09/2026 se midió que
no se comportan igual:

- **La cabecera, que es donde está la plata, la lee Haiku igual que Opus.** Seis
  de siete totales idénticos; en el séptimo —un presupuesto manuscrito sin
  renglón de TOTAL— Haiku contestó "no sé" donde Opus afirmó con confianza 0,65.
  Y tarda la mitad: 5,2 s contra 10,6 s, en la llamada que la persona espera.
- **Los renglones no.** En una factura de once renglones Haiku fusionó dos
  productos y corrió cinco precios. La plata no corre peligro (el cruce de la
  suma de líneas contra el total de cabecera dispara la pregunta), pero esas
  líneas entran a `Compras`, de donde salen el CMV y el análisis de precios, y
  eso no se pregunta.

**Costo medido por factura:** 3,47 centavos de dólar, contra 5,46 todo en Opus
(**−36%**) y 1,01 todo en Haiku (−81%). Las dos llamadas cuestan casi lo mismo
—cabecera 46%, renglones 54%—, así que bajar sólo la cabecera rinde un tercio y
no la mitad; los 2,5 centavos de diferencia contra Haiku entero son lo que se
paga por no ensuciar `Compras`. Una factura de un renglón sale 2,3 centavos y una
de once, 5,8: lo que mueve el número es cuántos renglones tiene, no el modelo.

`EXTRACTOR_MODEL` pisa las dos y es la marcha atrás sin deploy.

Lo que hace defendible bajar de modelo no es el precio: es que la app ya está
preparada para que el extractor dude. Todo lo que vuelve con confianza menor a
`PROVEEDORES_UMBRAL_CONFIANZA` se convierte en una pregunta al que sacó la foto
en vez de escribirse. Un modelo menos preciso degrada en **más preguntas**, no en
datos mal cargados — y por eso el único resultado que veta un cambio es un total
mal leído **con confianza alta**, que es el que se escribe solo y nadie mira.

**No se cambia a ciegas:** `scripts/comparar-extractor.js` corre las
combinaciones sobre facturas reales y aplica ese criterio. Fue lo que encontró
que el prompt del proveedor no tenía la regla que sí tenía el del CUIT, y que por
eso Haiku leía el domicilio del comprador como proveedor, con confianza 0,9.

### Avisos por Telegram (los graves)

Desde el 06/09/2026 los avisos de **severidad alta** —hoy son dos, y los dos son
de plata: se pagó más de lo cargado, y se pagó algo que ya estaba pago— además de
quedar en la campanita **salen por Telegram**. Hasta esa fecha la app no mandaba
nada: un aviso esperaba a que alguien la abriera.

| Variable | Servicio | Qué pasa si falta |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` (o `TELEGRAM_TOKEN`) | app | No sale ningún aviso. Todo lo demás sigue igual |
| `TELEGRAM_CHAT_<USUARIO>` | app | Esa persona no recibe (no es un error) |
| `TELEGRAM_TIMEOUT_MS` | app | 8000 |

Es el **mismo token del bot** (mismo bot, misma frontera de confianza). Una
variable por persona, en mayúsculas y con el nombre de usuario de la app:
`TELEGRAM_CHAT_TINCHO`, `TELEGRAM_CHAT_PABLO`. Van así y no en una lista porque
un chat id es un dato de alguien y este repositorio es público.

**Nada periódico sale por acá, a propósito.** Ni resúmenes ni recordatorios: sólo
lo grave. Una alarma que suena todos los días deja de escucharse, y por Telegram
además interrumpe.

Si Telegram falla, el aviso **igual quedó** en la hoja `Avisos` y en la
campanita: se pierde la inmediatez, nunca el registro. Una recepción de pedido no
puede fallar porque no se pudo mandar un mensaje.


### Informes automáticos

Tres agentes escriben en **Reportes → Informe**. Al destinatario le salta una
ventana con el informe apenas entra a la app (o apenas vuelve a la pestaña, si
la había dejado abierta), y no vuelve a saltar una vez que lo marca leído.

Variables opcionales:

| Variable | Para qué | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Requerida.** Sin ella los informes no se generan (el extractor de facturas ya la usa) | — |
| ~~`INFORMES_DESTINATARIO`~~ | **Ya no se usa** (06/09/2026). Los informes los ven los tres logins de admin. Si quedó seteada en Railway no hace nada: se puede borrar | — |
| `INFORMES_MODEL` | Modelo | `claude-opus-5` |
| `INFORMES_NOTAS_DIAS` | Cuánto tiempo una nota escrita sigue llegándole al agente | `240` |
| `INFORMES_CONTEXTO_PREVIOS` | Cuántos informes anteriores lee antes de escribir el nuevo | `2` |
| `INFORME_MOVIMIENTOS_CRON` | Cuándo sale el de la plata | `0 10 * * 0` (domingos 10:00) |
| `INFORME_SERVICIOS_CRON` | Cuándo sale el del salón | `15 10 * * 0` (domingos 10:15) |
| `INFORME_MENSUAL_CRON` | Cuándo sale el balance | `30 10 1 * *` (día 1, 10:30) |

Horario: America/Argentina/Buenos_Aires. La primera vez se crea sola una hoja
`Informes` en la planilla — es esperado, no un error.

**Si el server estaba reiniciando a la hora de la corrida, el informe se
recupera solo al arrancar** (Railway reinicia el contenedor en cada deploy). No
gasta llamadas de más: si el informe del período ya existe, no hace nada.
Ojo: poner cualquiera de las tres variables `INFORME_*_CRON` **desactiva esa
recuperación** para ese informe, porque de un horario arbitrario no se puede
deducir cuándo tendría que haber salido.

Los tres informes sólo **LEEN**: ninguno escribe en `Movimientos`. Y ninguno
calcula: los números los hace el código y el modelo sólo los interpreta.

### Lo que el agente se acuerda entre corridas

**`src/contexto-operativo.md`** — lo que ya sabemos del negocio y hace que un
número raro no sea raro (la dotación, que Mercado Pago Pablo es cuenta de uso
diario, que las propinas no entran al libro). Se le pasa a los tres agentes en
cada corrida. **Es un archivo de texto: se edita y listo, no hace falta tocar
código.** Sin esto, el agente redescubre esas cosas todas las semanas y las
presenta como hallazgos.

**Los dos informes anteriores del mismo tipo.** Antes de escribir el nuevo, el
agente lee lo que él mismo dijo las últimas dos veces. Así puede decir "sigue
pasando por tercera semana" en vez de repetir el mismo hallazgo, y avisar cuando
algo que había marcado como grave desapareció.

### Notas al agente (el feedback)

Debajo de cada hallazgo hay dos botones: **"Me sirvió"** y **"Ya lo sé"**. El
segundo abre un campo para explicar por qué. También hay un cuadro suelto,
**"Contale algo al agente"**, para contexto que no responde a ningún hallazgo.
Se guardan en la hoja `Informes Notas`, firmadas con quién las escribió, y en la
próxima corrida le llegan al modelo.

**La casilla "esto cambió para siempre" es la que más pesa, y no la lee el
modelo sino el código.** Es un solo clic: no hay nada que escribir, porque el
proveedor y la fecha salen del propio hallazgo. La casilla dice en voz alta qué
va a hacer — *"que deje de comparar ARCA contra lo anterior al 05/08/26"* — así
que si el dato estuviera mal se ve antes de tildarla.

Tildándola, el análisis deja de comparar ese concepto contra lo anterior a esa
fecha. Es lo que hay que usar cuando algo subió de nivel de forma permanente:
más empleados, un aumento, otras condiciones. Sin eso el mismo hallazgo puede
volver durante meses, hasta que la mediana histórica se mueva sola.

Si un hallazgo no habla de un proveedor concreto, la casilla no aparece. El
comentario en texto sirve igual: lo lee el modelo.

Una nota escrita se puede archivar desde la misma pantalla ("ya no aplica")
cuando dejó de ser cierta.

## Una segunda instancia (otro negocio)

Desde el 09/09/2026 este repositorio corre **más de un negocio**. No se forkea:
se deploya el mismo repo otra vez, con otras variables. La regla que lo sostiene
es que **cada default es el de Mercedes** — una instancia sin ninguna de las
variables de acá abajo se comporta exactamente como la app se comportaba antes.

Todo lo que define de quién es una instancia vive en `src/config-negocio.js`.

### Identidad

| Variable | Para qué | Default |
|---|---|---|
| `NEGOCIO_ID` | Elige el archivo de contexto de los agentes y los días excluidos de los informes. Y decide si se siembran los datos de arranque de Mercedes (proveedores, equipo de propinas, alias) | `mercedes` |
| `NEGOCIO_NOMBRE` | Título de la pestaña, pantalla de login, encabezado | `Bar Mercedes` |
| `NEGOCIO_CIUDAD` | Va al prompt de los tres agentes | `Buenos Aires` |
| `NEGOCIO_DESCRIPCION` | La frase entera detrás de "Sos el analista de datos …" | `del bar Mercedes (Buenos Aires)` |
| `NEGOCIO_LOGO` | Ruta dentro de `public/` | `/logo.jpg` |

**`NEGOCIO_ID` es lo primero que hay que setear en una instancia nueva.** Sin él,
la app le sirve a ese negocio el contexto operativo de Mercedes —Mercado Pago
Pablo, Galicia y Brubank, la dotación de julio— y el modelo no tiene forma de
saber que esos hechos no son suyos: los va a usar para explicar sus números. Cada
instancia lleva su `src/contexto-<NEGOCIO_ID>.md`, y la que no lo tiene corre sin
contexto, que es lo que la app hacía antes de agosto: informes más ingenuos,
nunca ajenos.

### Las cajas

| Variable | Para qué | Default |
|---|---|---|
| `CAJAS` | Los nombres EXACTOS de la columna A de la hoja `Cajas`, separados por coma | las nueve de Mercedes |
| `CAJA_EFECTIVO` / `CAJA_MP` | Las dos que se arquean todas las noches | se derivan de `CAJAS` |
| `CAJA_ECHEQ` | A qué cuenta va un echeq | `Galicia` si existe; si no, no se traduce |
| `MEDIOS_LIBRO` | Lo que se puede escribir en `Movimientos` columna L | `CAJAS` sin el pozo ni las de dólares |
| `MEDIOS_COMPRA` | Lo que ofrece "Nueva compra" | `MEDIOS_LIBRO` + el pozo |
| `MEDIOS_PAGO` | Lo que el bot ofrece por Telegram | `MEDIOS_LIBRO` + Echeq + Otro |
| `CAJA_POZO` / `CAJA_POZO_USD` | La cuenta del recupero y su vault en dólares | `Mercado Pago Pablo` / `MP Pablo USD` |
| `CAJAS_GRUPOS` | Prefijos que el filtro de Pagos ofrece juntos | `Mercado Pago` sólo en Mercedes |
| `CUENTAS_PROPINAS` | Dónde caen las propinas digitales | `Galicia,Brubank` sólo en Mercedes |

**Un medio de pago es el nombre exacto de una caja, y ahí no hay margen.** El
`Saldo Calculado` de la hoja `Cajas` es un `SUMIFS` por texto contra la columna L
de `Movimientos`: una letra de diferencia vuelve esa plata invisible para el
saldo, para siempre y sin ningún error a la vista. Lo que se ponga en `CAJAS`
tiene que estar escrito igual que en la planilla.

Los desplegables del navegador se arman solos desde `GET /api/config`. Si esa
llamada falla, el HTML queda como está escrito y la app sigue usable.

### Fudo

| Variable | Para qué | Default |
|---|---|---|
| `FUDO_GRUPOS` | Mapea las categorías de Fudo a comida/bebida: `PARA PICAR=comida,Vinos Tintos=bebida` | las categorías de Mercedes |

Es la que más silenciosamente se olvida. Las categorías de otra carta **no dan
error**: caen en `otros` por el fallback heurístico, y el split comida/bebida,
los porcentajes y el CMV por grupo quedan sin sentido sin que nada lo señale.

### Cuentas

Los seis logins de Mercedes siguen escritos en el código con su propia variable
de contraseña. Las demás instancias declaran las suyas:

```
USUARIOS=pulpo:admin:Pulpo,barra:encargado:La Barra
USUARIO_PULPO_PASSWORD=…
USUARIO_BARRA_PASSWORD=…
```

El formato es `clave:rol:nombre`; el nombre es opcional. Los roles son `admin` y
`encargado` y **no hay un tercero**: un rol que no sea uno de esos no crea la
cuenta, en vez de asumirse — asumir `admin` daría permisos que nadie pidió, y esa
es la que no se puede deshacer. La contraseña sigue yendo en su propia variable y
no dentro de `USUARIOS`, por lo mismo de siempre: este repositorio es público.

Al arrancar, el log lista las cuentas habilitadas y cuál falta por qué variable,
igual que antes. Y `AVISOS_DUENOS` hay que setearla: su default nombra a los
dueños de Mercedes.

### Apagar módulos

```
MODULOS_OFF=propinas,arqueo,arqueos,plan,nomina,cierre
```

Saca del menú los grupos y submenús que se nombren, **y hace que sus rutas
contesten 404**. Las dos mitades importan: esconder un botón nunca fue un
permiso, y este repositorio ya tiene esa regla escrita para el cierre de cocina y
para Pagos.

Devuelve 404 y no 403 a propósito: en esa instancia el módulo no existe, y un 403
diría "existe pero no podés", que es otra afirmación y es falsa.

Tres módulos **ya se apagan solos** sin entrar en esta lista: no seteando
`NOMINA_SHEET_ID` ni `STOCKS_SHEET_ID`, Nómina y Cierre de cocina se reportan no
configurados y nada más se rompe.

Lo que el guard deliberadamente **no** tapa aunque suene del grupo Plan:
`/api/proyecciones`, `/api/calculadora` y `/api/punto-equilibrio`. Las consume
también Servicios, y apagarlas dejaría esa pantalla sin su objetivo por noche.

### Armar las planillas

La app crea 26 hojas sola al primer uso. Cinco no, y son las que no puede
inventar: `Movimientos`, `Cajas`, `Arqueo de Cajas`, `Proveedores` y `Compras`.

```bash
node scripts/bootstrap-planillas.js            # muestra qué haría
node scripts/bootstrap-planillas.js --aplicar  # lo hace
```

Lee el entorno de la instancia, así que hay que correrlo con **sus** variables.
Es idempotente, no pisa una hoja que ya exista, y si encuentra una con otro
encabezado lo reporta y no la toca — reescribir un encabezado corre el
significado de cada columna sin mover un solo dato.

Crea la hoja `Cajas` con **el `SUMIFS` en la columna F**, que es lo que hace que
los saldos signifiquen algo, y pone la validación de las 13 categorías en
`Movimientos!J`. Las dos cosas son las que fallan sin avisar si se hacen a mano.

La cuenta de servicio necesita **Editor** en las dos planillas.

## Estructura del proyecto

```
mercedes-dashboard/
├── src/
│   ├── server.js       # Express + endpoints API
│   └── sheets.js       # Lógica Google Sheets + parseo de datos
├── public/
│   └── index.html      # Dashboard frontend (single file)
├── package.json
├── railway.toml
├── .env.example
└── .gitignore
```

## API endpoints

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/meses` | Lista de meses disponibles |
| `GET /api/categorias` | Categorías de gastos |
| `GET /api/kpis?mes=Mayo` | KPIs ejecutivos del mes |
| `GET /api/resumen?mes=Mayo` | Resumen mensual completo |
| `GET /api/actividad-diaria?mes=Mayo` | Actividad agrupada por día |
| `GET /api/movimientos?mes=Mayo&categoria=Mercaderia` | Movimientos filtrados |
| `POST /api/refresh` | Limpia cache (fuerza recarga de Sheets) |

El cache dura 2 minutos. Para datos inmediatos usar el botón "Actualizar" del dashboard.
