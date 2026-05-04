import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import {
  buildMovementFromExtraction,
  downloadTelegramPhoto,
  extractFinancialDataFromImage,
  getTelegramConfig,
  getTelegramStatus,
  sendTelegramMessage,
} from "../_lib/telegramMovement.js";

function getHeader(req: any, name: string): string | undefined {
  const value = req.headers?.[name.toLowerCase()] || req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function getBody(req: any) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

function removeUndefinedDeep(value: any): any {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === "object") {
    const cleaned: Record<string, any> = {};

    for (const [key, childValue] of Object.entries(value)) {
      if (childValue !== undefined) {
        cleaned[key] = removeUndefinedDeep(childValue);
      }
    }

    return cleaned;
  }

  return value;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const config = getTelegramConfig();
  const secret = getHeader(req, "x-telegram-bot-api-secret-token");

  if (!config.telegramSecretToken || secret !== config.telegramSecretToken) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = getBody(req);
  const message = body?.message || body?.edited_message;
  const chatId = message?.chat?.id;

  try {
    const status = getTelegramStatus();

    if (!status.configured) {
      if (chatId) {
        await sendTelegramMessage(chatId, "Bot recibido, pero faltan variables de entorno en Vercel.");
      }
      return res.status(200).json({ ok: true, skipped: "missing_config", status });
    }

    if (!message) {
      return res.status(200).json({ ok: true, skipped: "no_message" });
    }

    if (config.telegramAllowedChatId && String(message.chat?.id) !== config.telegramAllowedChatId) {
      return res.status(200).json({ ok: true, skipped: "chat_not_allowed" });
    }

    const photos = message.photo;
    if (!Array.isArray(photos) || photos.length === 0) {
      return res.status(200).json({ ok: true, skipped: "no_photo" });
    }

    const largestPhoto = photos.reduce((best: any, current: any) => {
      return (current.file_size || 0) > (best.file_size || 0) ? current : best;
    }, photos[0]);

    const db = getFirebaseAdminDb();
    const externalId = `telegram_${message.chat.id}_${message.message_id}`;
    const movementRef = db.collection("movements").doc(externalId);
    const existingMovement = await movementRef.get();

    if (existingMovement.exists) {
      return res.status(200).json({ ok: true, skipped: "duplicate", id: externalId });
    }

    const downloaded = await downloadTelegramPhoto(largestPhoto.file_id);
    const extraction = await extractFinancialDataFromImage({
      imageBuffer: downloaded.imageBuffer,
      mimeType: downloaded.mimeType,
      caption: message.caption,
    });

    const movement = buildMovementFromExtraction(extraction, new Date());

    const firestoreMovement = removeUndefinedDeep({
  ...movement,
  telegramChatId: String(message.chat.id),
  telegramMessageId: message.message_id,
  telegramUserId: message.from?.id ? String(message.from.id) : null,
  telegramUserName: message.from?.username || null,
  telegramFirstName: message.from?.first_name || null,
  telegramFileId: largestPhoto.file_id,
  telegramFileUniqueId: largestPhoto.file_unique_id || null,
  telegramFilePath: downloaded.telegramFilePath,
});

await movementRef.set(firestoreMovement);

    const estado = movement.telegramRequiresReview ? "PENDIENTE DE REVISION" : "CONFIRMADO";
    const monto = typeof extraction.monto === "number" ? extraction.monto.toFixed(2) : "0.00";
    const moneda = extraction.moneda || "USD";

    await sendTelegramMessage(
      message.chat.id,
      `Registro creado desde foto.\nTipo: ${extraction.tipo}\nMonto: ${moneda} ${monto}\nEstado: ${estado}`
    );

    return res.status(200).json({ ok: true, id: externalId, extraction });
  } catch (error) {
    console.error("Error en /api/telegram/webhook:", error);

    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `No pude registrar esta foto automaticamente. Motivo: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return res.status(200).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
