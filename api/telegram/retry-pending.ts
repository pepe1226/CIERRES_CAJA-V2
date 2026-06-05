import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import {
  getLargestTelegramPhoto,
  markPendingStatus,
  processTelegramPhotoMessage,
  savePendingTelegramPhoto,
} from "../_lib/telegramPhotoProcessor.js";
import { getTelegramConfig, isTemporaryGeminiError } from "../_lib/telegramMovement.js";

function getQuerySecret(req: any) {
  try {
    const url = new URL(req.url || "", "https://local.vercel.app");
    return url.searchParams.get("secret") || "";
  } catch {
    return "";
  }
}

function isAuthorized(req: any) {
  const fallbackSecret = getTelegramConfig().telegramSecretToken;
  const expectedSecret = (process.env.CRON_SECRET || fallbackSecret || "").trim();

  if (!expectedSecret) {
    return false;
  }

  const authHeader = String(req.headers?.authorization || "");
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  const headerSecret =
    req.headers?.["x-cron-secret"] ||
    req.headers?.["x-telegram-bot-api-secret-token"] ||
    req.headers?.["X-Telegram-Bot-Api-Secret-Token"];

  return (
    bearerToken === expectedSecret ||
    String(headerSecret || "") === expectedSecret ||
    getQuerySecret(req) === expectedSecret
  );
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized. Configure CRON_SECRET o use TELEGRAM_SECRET_TOKEN como secreto.",
    });
  }

  const db = getFirebaseAdminDb();
  const maxItems = 5;
  const maxAttemptsPerPhoto = 5;

  const snapshot = await db
    .collection("telegram_pending_photos")
    .where("status", "==", "pending")
    .limit(maxItems)
    .get();

  const results: any[] = [];

  for (const pendingDoc of snapshot.docs) {
    const pending = pendingDoc.data();
    const pendingId = pendingDoc.id;
    const attempts = Number(pending.attempts || 0);
    const message = pending.rawMessage;

    if (!message) {
      await markPendingStatus({
        pendingId,
        status: "needs_review",
        error: "Pendiente sin rawMessage. No se puede reprocesar automáticamente.",
      });

      results.push({ pendingId, ok: false, reason: "missing-raw-message" });
      continue;
    }

    if (attempts >= maxAttemptsPerPhoto) {
      await markPendingStatus({
        pendingId,
        status: "failed",
        error: `Superó el máximo de ${maxAttemptsPerPhoto} intentos automáticos.`,
      });

      results.push({ pendingId, ok: false, reason: "max-attempts" });
      continue;
    }

    const chatId = message.chat?.id || pending.chatId;
    const photos = Array.isArray(message.photo) ? message.photo : [];
    const largestPhoto = photos.length > 0 ? getLargestTelegramPhoto(photos) : {
      file_id: pending.photo?.fileId,
      file_unique_id: pending.photo?.fileUniqueId,
      file_size: pending.photo?.fileSize,
      width: pending.photo?.width,
      height: pending.photo?.height,
    };

    if (!chatId || !largestPhoto?.file_id) {
      await markPendingStatus({
        pendingId,
        status: "needs_review",
        error: "Pendiente sin chatId o file_id. No se puede reprocesar automáticamente.",
      });

      results.push({ pendingId, ok: false, reason: "missing-chat-or-file" });
      continue;
    }

    try {
      await markPendingStatus({ pendingId, status: "processing" });

      const result = await processTelegramPhotoMessage({
        chatId,
        message,
        largestPhoto,
        sendSuccessMessage: true,
        extractionAttempts: 2,
      });

      await markPendingStatus({
        pendingId,
        status: "completed",
        closureId: result.closureId || result.existingClosureId,
      });

      results.push({ pendingId, ok: true, result });
    } catch (error: any) {
      await savePendingTelegramPhoto({
        chatId,
        message,
        largestPhoto,
        error,
        source: "retry",
      });

      const nextStatus = isTemporaryGeminiError(error) ? "pending" : "needs_review";
      await markPendingStatus({
        pendingId,
        status: nextStatus,
        error,
      });

      results.push({
        pendingId,
        ok: false,
        retryable: nextStatus === "pending",
        error: error?.message || String(error),
      });
    }
  }

  return res.status(200).json({
    ok: true,
    processed: results.length,
    results,
  });
}
