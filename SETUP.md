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
4. Railway detecta `railway.toml` y hace el deploy automáticamente

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
