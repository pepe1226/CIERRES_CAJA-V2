import { getFirebaseAdminStatus } from "../_lib/firebaseAdmin";
import { getTelegramStatus } from "../_lib/telegramMovement";

export default function handler(_req: any, res: any) {
  const hasServiceAccount = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
  );

  const status = {
    ok: true,
    runtime: "vercel-serverless",
    configured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_SECRET_TOKEN &&
      process.env.GEMINI_API_KEY &&
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIRESTORE_DATABASE_ID &&
      process.env.FIREBASE_STORAGE_BUCKET &&
      hasServiceAccount
    ),
    telegram: {
      hasTelegramBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      hasTelegramPerseoBotToken: Boolean(process.env.TELEGRAM_PERSEO_BOT_TOKEN),
      hasTelegramExpenseBotToken: Boolean(process.env.TELEGRAM_EXPENSE_BOT_TOKEN),
      hasTelegramPersonalBotToken: Boolean(process.env.TELEGRAM_PERSONAL_BOT_TOKEN),
      hasTelegramSecretToken: Boolean(process.env.TELEGRAM_SECRET_TOKEN),
      hasTelegramPerseoSecretToken: Boolean(process.env.TELEGRAM_PERSEO_SECRET_TOKEN),
      hasTelegramExpenseSecretToken: Boolean(process.env.TELEGRAM_EXPENSE_SECRET_TOKEN),
      hasTelegramPersonalSecretToken: Boolean(process.env.TELEGRAM_PERSONAL_SECRET_TOKEN),
      hasCronSecret: Boolean(process.env.CRON_SECRET),
      allowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID || null,
      telegramCreatedByUid: process.env.TELEGRAM_CREATED_BY_UID || "telegram-bot"
    },
    perseo: {
      hasPerseoImportSecret: Boolean(process.env.PERSEO_IMPORT_SECRET),
      acceptsCronSecretFallback: Boolean(process.env.CRON_SECRET)
    },
    gmailExpenses: {
      hasGmailClientId: Boolean(process.env.GMAIL_CLIENT_ID),
      hasGmailClientSecret: Boolean(process.env.GMAIL_CLIENT_SECRET),
      hasGmailRefreshToken: Boolean(process.env.GMAIL_REFRESH_TOKEN),
      hasGmailExpenseTelegramChatId: Boolean(process.env.GMAIL_EXPENSE_TELEGRAM_CHAT_ID),
      gmailExpenseQuery: process.env.GMAIL_EXPENSE_QUERY ||
        'newer_than:30d (pichincha OR "Banco Pichincha" OR "notificaciones pichincha" OR "transaccion" OR "transacción" OR "transferencia" OR "compra" OR "consumo")'
    },
    gemini: {
      hasGeminiApiKey: Boolean(process.env.GEMINI_API_KEY),
      geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash"
    },
    firebase: {
      projectId: process.env.FIREBASE_PROJECT_ID || null,
      firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || null,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || null,
      hasServiceAccountJson: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
      hasServiceAccountBase64: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64),
      hasAnyServiceAccount: hasServiceAccount
    }
  };

  res.status(200).json(status);
}
