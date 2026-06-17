# CIERRES 1.1

Aplicación React + Vite para control de cierres, movimientos y cajas.

Esta versión está preparada para correr en Vercel, usar Firebase como base de datos, mantener autenticación con Google y recibir fotos desde un grupo de Telegram para crear movimientos automáticamente con Gemini.

## Stack

```txt
Frontend: React + Vite
Auth: Firebase Authentication con Google
Base de datos: Firestore
Backend serverless: Vercel Functions
IA: Gemini API
Telegram: Bot API con webhook
```

## Desarrollo local

```bash
npm install
npm run dev
```

Para probar funciones serverless localmente usa Vercel CLI:

```bash
npm install -g vercel
vercel dev
```

## Despliegue en Vercel

```txt
[ ] Sube el proyecto a GitHub
[ ] Importa el repositorio en Vercel
[ ] Configura las variables de entorno
[ ] Deploy
```

La configuración de Vercel está en:

```txt
vercel.json
```

## Autenticación por Google

La app ya usa:

```txt
Firebase Authentication + GoogleAuthProvider
```

En Firebase Console debes habilitar Google y agregar el dominio de Vercel en:

```txt
Authentication -> Settings -> Authorized domains
```

## Telegram + Gemini

Consulta el archivo:

```txt
TELEGRAM_SETUP.md
```

Endpoints principales:

```txt
/api/telegram/status
/api/telegram/webhook
```
