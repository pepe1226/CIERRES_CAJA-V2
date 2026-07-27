import {
  getLargestTelegramPhoto,
  getTelegramMessageKey,
  markPendingStatus,
  processTelegramPhotoMessage,
  savePendingTelegramPhoto,
} from "../_lib/telegramPhotoProcessor.js";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageReplyMarkup,
  getFriendlyGeminiErrorMessage,
  getTelegramConfig,
  isTemporaryPhotoProcessingError,
  sendTelegramMessage,
} from "../_lib/telegramMovement.js";
import {
  isLikelyPerseoReportMessage,
  processTelegramPerseoReportMessage,
} from "../_lib/telegramPerseoReportProcessor.js";
import {
  expenseAssistantMenuKeyboard,
  personalFinanceBotMenuKeyboard,
  processExpenseAssistantCallback,
  processExpenseAssistantMessage,
  processExpenseAssistantPhoto,
} from "../_lib/telegramExpenseAssistant.js";

function getBody(req: any) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

const MANUAL_RETRY_TIMEOUT_MS = 45_000;
const STALE_PROCESSING_MS = 10 * 60_000;

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isStalePendingProcessing(pending: any) {
  if (pending.status !== "processing") return false;
  const updatedAt = toDate(pending.updatedAt) || toDate(pending.createdAt);
  return !updatedAt || Date.now() - updatedAt.getTime() >= STALE_PROCESSING_MS;
}

async function withPhotoProcessingTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      const error: any = new Error("Se agotó el tiempo máximo de procesamiento de la foto.");
      error.code = "PHOTO_PROCESSING_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function processPendingPhotoFromCallback(callbackQuery: any, botToken?: string) {
  const data = String(callbackQuery.data || "");
  const pendingId = data.replace(/^pending:retry:/, "");
  const chatId = callbackQuery.message?.chat?.id;

  await answerTelegramCallbackQuery({
    callbackQueryId: callbackQuery.id,
    text: "Reintentando foto pendiente...",
    botToken,
  });

  if (!pendingId || !chatId) {
    return { ok: false, handled: true, error: "Falta codigo pendiente o chat." };
  }

  const db = getFirebaseAdminDb();
  const pendingRef = db.collection("telegram_pending_photos").doc(pendingId);
  let pendingDoc: any;

  try {
    pendingDoc = await pendingRef.get();
  } catch (error: any) {
    await sendTelegramMessage(
      chatId,
      "No pude consultar el pendiente en Firebase. El botón seguirá disponible para intentarlo nuevamente.",
      botToken,
    );
    return { ok: false, handled: true, pendingId, error: error?.message || String(error) };
  }

  if (!pendingDoc.exists) {
    await sendTelegramMessage(chatId, `No encontre el pendiente ${pendingId}.`);
    return { ok: false, handled: true, pendingId, error: "pending-not-found" };
  }

  const pending = pendingDoc.data() || {};
  const callbackMessageId = Number(callbackQuery.message?.message_id || 0);

  if (pending.status === "completed") {
    if (callbackMessageId) {
      await editTelegramMessageReplyMarkup({
        chatId,
        messageId: callbackMessageId,
        inlineKeyboard: [],
        botToken,
      });
    }
    await sendTelegramMessage(
      chatId,
      `Ese pendiente ya fue procesado correctamente.${pending.closureId ? `\nCierre: ${pending.closureId}` : ""}`,
      botToken,
    );
    return { ok: true, handled: true, pendingId, alreadyCompleted: true };
  }

  if (pending.status === "processing" && !isStalePendingProcessing(pending)) {
    await sendTelegramMessage(chatId, "La foto ya se está procesando. Te avisaré cuando termine.", botToken);
    return { ok: true, handled: true, pendingId, alreadyProcessing: true };
  }

  const message = pending.rawMessage;
  const largestPhoto = {
    file_id: pending.photo?.fileId,
    file_unique_id: pending.photo?.fileUniqueId,
    file_size: pending.photo?.fileSize,
    width: pending.photo?.width,
    height: pending.photo?.height,
  };

  if (!message || !largestPhoto.file_id) {
    await markPendingStatus({
      pendingId,
      status: "needs_review",
      error: "Pendiente sin rawMessage o file_id. No se puede reintentar desde Telegram.",
    });
    await sendTelegramMessage(chatId, `No pude reintentar ${pendingId}: falta información de la foto.`, botToken);
    return { ok: false, handled: true, pendingId, error: "missing-pending-data" };
  }

  try {
    await markPendingStatus({ pendingId, status: "processing" });
    if (callbackMessageId) {
      await editTelegramMessageReplyMarkup({
        chatId,
        messageId: callbackMessageId,
        inlineKeyboard: [[
          { text: "Procesando...", callback_data: `pending:working:${pendingId}` },
        ]],
        botToken,
      });
    }

    const result = await withPhotoProcessingTimeout(
      processTelegramPhotoMessage({
        chatId,
        message,
        largestPhoto,
        sendSuccessMessage: true,
        extractionAttempts: 2,
      }),
      MANUAL_RETRY_TIMEOUT_MS,
    );

    await markPendingStatus({
      pendingId,
      status: "completed",
      closureId: result.closureId || result.existingClosureId,
    });

    if (callbackMessageId) {
      await editTelegramMessageReplyMarkup({
        chatId,
        messageId: callbackMessageId,
        inlineKeyboard: [],
        botToken,
      });
    }

    return { ok: true, handled: true, pendingId, result };
  } catch (error: any) {
    try {
      await savePendingTelegramPhoto({
        chatId,
        message,
        largestPhoto,
        error,
        source: "retry",
      });

      await markPendingStatus({
        pendingId,
        status: isTemporaryPhotoProcessingError(error) ? "pending" : "needs_review",
        error,
      });
    } catch (persistenceError) {
      console.error("No se pudo actualizar el pendiente durante el reintento:", persistenceError);
    }

    if (callbackMessageId) {
      await editTelegramMessageReplyMarkup({
        chatId,
        messageId: callbackMessageId,
        inlineKeyboard: [[
          { text: "Reintentar ahora", callback_data: `pending:retry:${pendingId}` },
        ]],
        botToken,
      });
    }

    await sendTelegramMessage(
      chatId,
      [
        getFriendlyGeminiErrorMessage(error),
        `Sigue pendiente: ${pendingId}`,
      ].join("\n"),
      botToken,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "Reintentar ahora", callback_data: `pending:retry:${pendingId}` },
          ]],
        },
      }
    );

    return { ok: false, handled: true, pendingId, error: error?.message || String(error) };
  }
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
    telegramExpenseBotToken,
    telegramPersonalBotToken,
    telegramSecretToken,
    telegramPerseoSecretToken,
    telegramExpenseSecretToken,
    telegramPersonalSecretToken,
    telegramAllowedChatId,
    telegramPersonalAllowedChatId,
  } = getTelegramConfig();

  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"] ||
    req.headers["X-Telegram-Bot-Api-Secret-Token"];
  const forcedBot = String(req.query?.bot || "").toLowerCase();
  const forcePersonalWebhook = forcedBot === "personal";
  const forceExpenseWebhook = forcedBot === "expense";

  const acceptedSecretTokens = [
    telegramSecretToken,
    telegramPerseoSecretToken,
    telegramExpenseSecretToken,
    telegramPersonalSecretToken,
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

  const isPerseoBotRequest =
    Boolean(telegramPerseoSecretToken) &&
    String(receivedSecret || "") === String(telegramPerseoSecretToken);
  const isExpenseBotRequest =
    Boolean(telegramExpenseSecretToken) &&
    String(receivedSecret || "") === String(telegramExpenseSecretToken);
  const isPersonalBotRequest =
    Boolean(telegramPersonalSecretToken) &&
    String(receivedSecret || "") === String(telegramPersonalSecretToken);
  const activePersonalBotRequest = forcePersonalWebhook || isPersonalBotRequest;
  const activeExpenseBotRequest = forceExpenseWebhook ? false : isExpenseBotRequest;
  const activePerseoBotRequest = forcePersonalWebhook ? false : isPerseoBotRequest;
  const activeBotToken = activePersonalBotRequest
    ? telegramPersonalBotToken || telegramBotToken
    : activeExpenseBotRequest
      ? telegramExpenseBotToken || telegramBotToken
      : activePerseoBotRequest
        ? telegramPerseoBotToken || telegramBotToken
        : telegramBotToken;

  const allowedChatId = activePersonalBotRequest
    ? telegramPersonalAllowedChatId || telegramAllowedChatId
    : telegramAllowedChatId;

  const callbackQuery = body.callback_query;

  if (callbackQuery) {
    const callbackData = String(callbackQuery.data || "");

    if (callbackData.startsWith("pending:retry:")) {
      const result = await processPendingPhotoFromCallback(callbackQuery, activeBotToken);
      return res.status(200).json(result);
    }

    if (callbackData.startsWith("pending:working:")) {
      await answerTelegramCallbackQuery({
        callbackQueryId: callbackQuery.id,
        text: "La foto todavía se está procesando...",
        botToken: activeBotToken,
      });
      return res.status(200).json({ ok: true, handled: true, processing: true });
    }

    if (activeExpenseBotRequest || activePersonalBotRequest) {
      const result = await processExpenseAssistantCallback({
        callbackQuery,
        botToken: activePersonalBotRequest
          ? telegramPersonalBotToken || telegramBotToken
          : telegramExpenseBotToken || telegramBotToken,
        personalOnly: activePersonalBotRequest,
      });

      return res.status(200).json(result);
    }

    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "Callback ignored",
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
    allowedChatId &&
    String(chatId) !== String(allowedChatId)
  ) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "Chat not allowed",
    });
  }

  const photos = Array.isArray(message.photo) ? message.photo : [];
  const largestPhoto = photos.length > 0 ? getLargestTelegramPhoto(photos) : null;

  if (activePerseoBotRequest || (!activePersonalBotRequest && isLikelyPerseoReportMessage(message))) {
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
        ].join("\n"),
        telegramPerseoBotToken || telegramBotToken
      );

      return res.status(200).json({
        ok: false,
        report: true,
        error: error?.message || String(error),
      });
    }
  }

  if (activeExpenseBotRequest || activePersonalBotRequest) {
    const activeBotToken = activePersonalBotRequest
      ? telegramPersonalBotToken || telegramBotToken
      : telegramExpenseBotToken || telegramBotToken;

    if (largestPhoto?.file_id) {
      const photoResult = await processExpenseAssistantPhoto({
        chatId,
        message,
        largestPhoto,
        botToken: activeBotToken,
        personalOnly: activePersonalBotRequest,
      });

      if (photoResult.handled) {
        return res.status(200).json(photoResult);
      }
    }

    const assistantResult = await processExpenseAssistantMessage({
      chatId,
      message,
      botToken: activeBotToken,
      personalOnly: activePersonalBotRequest,
    });

    if (assistantResult.handled) {
      return res.status(200).json(assistantResult);
    }

    await sendTelegramMessage(
      chatId,
      [
        activePersonalBotRequest ? "No identifique un gasto personal." : "No identifique una salida.",
        "No voy a registrar nada sin una accion clara de gasto.",
        "Ejemplos:",
        ...(activePersonalBotRequest
          ? ["2 en platano", "la colita 2", "tanqueo 20", "farmacia 8.50"]
          : ["combustible 20 tienda", "taxi 8 banco", "salida proveedor 50 transito", "revisar correos"]),
      ].join("\n"),
      activeBotToken,
      { reply_markup: activePersonalBotRequest ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() }
    );

    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "Expense assistant did not understand message",
    });
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
      ].join("\n"),
      undefined,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "Reintentar ahora", callback_data: `pending:retry:${pending.pendingId}` },
          ]],
        },
      }
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
