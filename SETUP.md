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
4. Railway detecta `railway.toml` y hace el deploy automáticamente

### La planilla de nómina

Vive **aparte** de Gestión Mercedes y se lee con `NOMINA_SHEET_ID`. Hay que
compartirla con la cuenta de servicio (`dashboardviewer@…`, alcanza rol Lector).

A diferencia de `PROVEEDORES_SHEET_ID`, esta variable **no cae a
`SPREADSHEET_ID`** si falta: son sueldos de gente real y el fallback los pondría
en la planilla que ve más gente. Sin la variable, la sección Nómina devuelve
error y el punto de equilibrio vuelve a estimar el costo laboral como antes —
nada más se rompe.

La app **no le escribe nada**: la planilla se sigue editando a mano.

### La planilla de Stocks

El cierre de cocina (qué comprar, qué producir). Se lee con `STOCKS_SHEET_ID` y
**acá la cuenta de servicio necesita rol Editor**, no Lector como en nómina: la
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


### Informes automáticos

Tres agentes escriben en **Reportes → Informe**. Al destinatario le salta una
ventana con el informe apenas entra a la app (o apenas vuelve a la pestaña, si
la había dejado abierta), y no vuelve a saltar una vez que lo marca leído.

Variables opcionales:

| Variable | Para qué | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Requerida.** Sin ella los informes no se generan (el extractor de facturas ya la usa) | — |
| `INFORMES_DESTINATARIO` | Qué usuario los ve. **Ojo: `admin` no los ve** salvo que se ponga acá | `tincho` |
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
