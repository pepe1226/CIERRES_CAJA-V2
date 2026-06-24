# Integración Telegram + Gemini en Vercel + Firebase

Esta versión ya no depende de `server.ts` ni de Cloud Run. La app se publica en Vercel como frontend Vite y el bot de Telegram funciona con funciones serverless dentro de la carpeta `api/`.

## 1. Arquitectura

```txt
Usuario con Google Auth -> App React/Vite en Vercel -> Firebase Auth + Firestore
Grupo Telegram -> /api/telegram/webhook en Vercel -> Gemini -> Firestore movements
```

## 2. Archivos agregados o modificados

```txt
api/telegram/webhook.ts       Webhook que recibe fotos desde Telegram
api/telegram/status.ts        Endpoint de verificación
api/_lib/firebaseAdmin.ts     Inicialización segura de Firebase Admin
api/_lib/telegramMovement.ts  Lógica Telegram + Gemini + movimiento de caja
vercel.json                   Configuración para Vercel
.env.example                  Variables necesarias
firestore.rules               Reglas actualizadas para metadata de Telegram
src/types.ts                  Tipo Movement con campos opcionales de Telegram
src/firebase.ts               Google Auth con selector de cuenta
```

## 3. Autenticación por Google

La app mantiene Firebase Authentication con Google.

En Firebase Console:

```txt
[ ] Entra a Firebase Console
[ ] Authentication
[ ] Sign-in method
[ ] Habilita Google
[ ] Settings
[ ] Authorized domains
[ ] Agrega tu dominio de Vercel
```

Debes agregar dominios como:

```txt
tu-proyecto.vercel.app
tu-dominio.com
```

No agregues `https://`; solo el dominio.

## 4. Firebase Admin para Vercel

El frontend usa Google Auth, pero el webhook de Telegram no puede iniciar sesión como usuario. Por eso el webhook escribe en Firestore usando Firebase Admin desde Vercel.

En Firebase Console:

```txt
[ ] Project settings
[ ] Service accounts
[ ] Generate new private key
[ ] Descarga el JSON
```

Convierte ese JSON a base64 antes de subirlo a Vercel.

En Mac/Linux:

```bash
base64 -w 0 serviceAccount.json
```

En Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccount.json"))
```

Ese resultado va en:

```txt
FIREBASE_SERVICE_ACCOUNT_BASE64
```

No subas el archivo JSON al proyecto.

## 5. Variables de entorno en Vercel

En Vercel:

```txt
Project Settings -> Environment Variables
```

Agrega:

```txt
GEMINI_API_KEY=tu_api_key_de_ai_studio
GEMINI_MODEL=gemini-2.5-flash

TELEGRAM_BOT_TOKEN=token_de_botfather
TELEGRAM_SECRET_TOKEN=una_clave_interna_inventada_por_ti
TELEGRAM_ALLOWED_CHAT_ID=
TELEGRAM_CREATED_BY_UID=uid_del_usuario_google_admin
CRON_SECRET=una_clave_larga_para_reintentos_automaticos

FIREBASE_PROJECT_ID=gen-lang-client-0181048054
FIRESTORE_DATABASE_ID=ai-studio-1c7e2a21-6400-4184-8dda-2ebe06e9d591
FIREBASE_STORAGE_BUCKET=gen-lang-client-0181048054.firebasestorage.app
FIREBASE_SERVICE_ACCOUNT_BASE64=contenido_base64_del_json_service_account
```

Importante: no pegues el token del bot ni la service account dentro del código.

## 6. UID del usuario Google

Cuando entras a la app con Google, Firebase crea tu usuario.

Para obtener el UID:

```txt
Firebase Console -> Authentication -> Users -> copia el User UID
```

Ese valor va en:

```txt
TELEGRAM_CREATED_BY_UID
```

Si no lo configuras, los registros se guardan como `telegram-bot`. En ese caso solo un usuario con rol admin podrá editarlos, según tus reglas actuales.

## 7. Endpoints en Vercel

Después de publicar en Vercel, tendrás:

```txt
https://TU_APP.vercel.app/api/telegram/status
https://TU_APP.vercel.app/api/telegram/webhook
https://TU_APP.vercel.app/api/telegram/retry-pending
```

También dejé rutas limpias:

```txt
https://TU_APP.vercel.app/telegram/status
https://TU_APP.vercel.app/telegram/webhook
https://TU_APP.vercel.app/telegram/retry-pending
```

## 7.1 Reintento automatico de fotos pendientes

Si Gemini responde saturado o temporalmente no disponible, el webhook guarda la foto en:

```txt
telegram_pending_photos
```

El archivo `vercel.json` programa un Cron Job cada 8 horas para llamar:

```txt
/api/telegram/retry-pending
```

Para que Vercel autorice esa llamada, configura en Vercel:

```txt
CRON_SECRET=una_clave_larga_para_reintentos_automaticos
```

El endpoint también se puede ejecutar manualmente:

```bash
curl -H "Authorization: Bearer TU_CRON_SECRET" \
  "https://TU_APP.vercel.app/api/telegram/retry-pending"
```

También acepta `?secret=TU_CRON_SECRET` para una prueba rápida desde el navegador, pero es mejor usar el header `Authorization`.

Cada foto pendiente se intenta hasta 5 veces. Si una función queda en `processing` por timeout, el siguiente cron la retoma después de 10 minutos cuando vuelva a ejecutarse.

## 8. Verificar configuración

Abre:

```txt
https://TU_APP.vercel.app/api/telegram/status
```

Debe responder algo parecido a:

```json
{
  "ok": true,
  "runtime": "vercel-serverless",
  "configured": true,
  "hasTelegramBotToken": true,
  "hasTelegramSecretToken": true,
  "hasGeminiApiKey": true
}
```

Si `configured` es `false`, falta alguna variable de entorno.

## 9. Configurar webhook de Telegram

Cuando ya tengas tu URL de Vercel, ejecuta:

```bash
curl -X POST "https://api.telegram.org/botTU_TOKEN/setWebhook" \
  -d "url=https://TU_APP.vercel.app/api/telegram/webhook" \
  -d "secret_token=TU_TELEGRAM_SECRET_TOKEN" \
  -d 'allowed_updates=["message"]' \
  -d "drop_pending_updates=true"
```

Verifica:

```bash
curl "https://api.telegram.org/botTU_TOKEN/getWebhookInfo"
```

## 10. Configurar el grupo de Telegram

```txt
[ ] Agrega el bot al grupo
[ ] Hazlo administrador
[ ] Dale permiso para leer mensajes
[ ] Dale permiso para enviar mensajes
```

Si no responde a fotos, en BotFather usa:

```txt
/setprivacy
```

Selecciona el bot y elige:

```txt
Disable
```

## 11. Prueba recomendada

Envía una foto al grupo con un texto como:

```txt
Caja: Principal
Tipo: egreso
Categoría: proveedores
```

El bot debería responder:

```txt
Registro creado desde foto.
Tipo: egreso
Monto: USD 18.75
Estado: CONFIRMADO
```

O si falta información:

```txt
Registro creado desde foto.
Tipo: egreso
Monto: USD 0.00
Estado: PENDIENTE DE REVISION
```

## 12. Cómo guarda el movimiento

Colección:

```txt
movements
```

Campos principales:

```txt
date
type
amount
description
createdBy
category
subcategory
from
to
```

Campos extra de Telegram:

```txt
source
telegramProvider
telegramRequiresReview
telegramConfidence
telegramReviewReasons
telegramRawExtraction
telegramChatId
telegramMessageId
telegramUserId
telegramUserName
telegramFirstName
telegramFileId
telegramFileUniqueId
telegramFilePath
```

## 13. Seguridad

```txt
[ ] Google Auth protege la app frontend
[ ] Firestore Rules protegen las escrituras desde usuarios autenticados
[ ] Firebase Admin permite al webhook escribir desde Vercel
[ ] TELEGRAM_SECRET_TOKEN valida que la petición venga del webhook configurado
[ ] TELEGRAM_ALLOWED_CHAT_ID permite limitar el bot a un solo grupo
[ ] Duplicados se evitan con telegram_<chat_id>_<message_id>
```
