import {
  getLargestTelegramPhoto,
  getTelegramMessageKey,
  processTelegramPhotoMessage,
  savePendingTelegramPhoto,
} from "../_lib/telegramPhotoProcessor.js";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import {
  getFriendlyGeminiErrorMessage,
  getTelegramConfig,
  sendTelegramMessage,
} from "../_lib/telegramMovement.js";
import {
  isLikelyPerseoReportMessage,
  processTelegramPerseoReportMessage,
} from "../_lib/telegramPerseoReportProcessor.js";

function getBody(req: any) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

async function saveIgnoredTelegramDocument(message: any, chatId: number | string) {
  try {
    const db = getFirebaseAdminDb();
    const document = message.document || {};
    const id = getTelegramMessageKey(chatId, message.message_id || Date.now());

    await db.collection("telegram_ignored_documents").doc(id).set(
      {
        chatId: String(chatId),
        messageId: message.message_id || null,
        telegramDate: message.date || null,
        fileId: document.file_id || null,
        fileName: document.file_name || null,
        mimeType: document.mime_type || null,
        caption: message.caption || message.text || null,
        ignoredAt: new Date(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("No se pudo guardar documento ignorado de Telegram:", error);
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const {
    telegramBotToken,
    telegramPerseoBotToken,
    telegramSecretToken,
    telegramPerseoSecretToken,
    telegramAllowedChatId,
  } = getTelegramConfig();

  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"] ||
    req.headers["X-Telegram-Bot-Api-Secret-Token"];

  const acceptedSecretTokens = [
    telegramSecretToken,
    telegramPerseoSecretToken,
  ].filter(Boolean).map(String);

  if (
    acceptedSecretTokens.length > 0 &&
    !acceptedSecretTokens.includes(String(receivedSecret || ""))
  ) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  let body: any;

  try {
    body = getBody(req);
  } catch (error) {
    console.error("No se pudo leer el body de Telegram:", error);

    return res.status(200).json({
      ok: false,
      error: "Invalid body",
    });
  }

  const message = body.message || body.edited_message;

  if (!message) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "No message",
    });
  }

  const chatId = message.chat?.id;

  if (!chatId) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "No chat id",
    });
  }

  if (
    telegramAllowedChatId &&
    String(chatId) !== String(telegramAllowedChatId)
  ) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "Chat not allowed",
    });
  }

  const photos = Array.isArray(message.photo) ? message.photo : [];
  const largestPhoto = photos.length > 0 ? getLargestTelegramPhoto(photos) : null;

  if (isLikelyPerseoReportMessage(message)) {
    try {
      const result = await processTelegramPerseoReportMessage({
        chatId,
        message,
        largestPhoto,
        botToken: telegramPerseoBotToken || telegramBotToken,
      });

      return res.status(200).json(result);
    } catch (error: any) {
      console.error("Error procesando reporte Perseo desde Telegram:", error);

      await sendTelegramMessage(
        chatId,
        [
          "No pude procesar el reporte de Perseo automaticamente.",
          error?.message || String(error),
        ].join("\n")
      );

      return res.status(200).json({
        ok: false,
        report: true,
        error: error?.message || String(error),
      });
    }
  }

  if (photos.length === 0) {
    if (message.document?.file_id) {
      console.log("Documento de Telegram ignorado por no coincidir con reporte Perseo:", {
        fileName: message.document?.file_name || null,
        mimeType: message.document?.mime_type || null,
        caption: message.caption || message.text || null,
        messageId: message.message_id,
        chatId,
      });
      await saveIgnoredTelegramDocument(message, chatId);
    }

    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "No photo",
    });
  }

  try {
    const result = await processTelegramPhotoMessage({
      chatId,
      message,
      largestPhoto,
      sendSuccessMessage: true,
      extractionAttempts: 3,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error procesando foto de Telegram:", error);

    const pending = await savePendingTelegramPhoto({
      chatId,
      message,
      largestPhoto,
      error,
      source: "webhook",
    });

    await sendTelegramMessage(
      chatId,
      [
        getFriendlyGeminiErrorMessage(error),
        "No se creó ningún registro incompleto.",
        `Código pendiente: ${pending.pendingId}`,
      ].join("\n")
    );

    return res.status(200).json({
      ok: false,
      queued: true,
      pendingId: pending.pendingId,
      telegramMessageKey: getTelegramMessageKey(chatId, message.message_id),
      retryable: pending.retryable,
      error: error?.message || String(error),
    });
  }
}
