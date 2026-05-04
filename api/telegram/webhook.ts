import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import {
  buildMovementFromExtraction,
  downloadTelegramPhoto,
  extractFinancialDataFromImage,
  getTelegramConfig,
  sendTelegramMessage,
} from "../_lib/telegramMovement.js";

function getBody(req: any) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

function removeUndefinedDeep(value: any): any {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value
      .map(removeUndefinedDeep)
      .filter((item) => item !== undefined);
  }

  if (typeof value !== "object") {
    return value;
  }

  // Muy importante:
  // No tocar Date, Timestamp de Firestore ni FieldValue.serverTimestamp().
  // Si los recorremos como objetos normales, se rompen y la app no puede usar date.toDate().
  if (value instanceof Date) {
    return value;
  }

  if (typeof value.toDate === "function") {
    return value;
  }

  if (value.constructor && value.constructor !== Object) {
    return value;
  }

  const cleaned: Record<string, any> = {};

  for (const [key, childValue] of Object.entries(value)) {
    const cleanedValue = removeUndefinedDeep(childValue);

    if (cleanedValue !== undefined) {
      cleaned[key] = cleanedValue;
    }
  }

  return cleaned;
}

function cleanResponsible(value: any): string {
  const text = String(value || "SIN RESPONSABLE")
    .replace(/^ESQ\s+/i, "")
    .replace(/^RESPONSABLE\s*:?/i, "")
    .replace(/^SR\.?\s*/i, "")
    .replace(/^SRA\.?\s*/i, "")
    .trim();

  return (text || "SIN RESPONSABLE").toUpperCase().slice(0, 80);
}

function formatMoney(value: any) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return number.toFixed(2);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const {
    telegramSecretToken,
    telegramAllowedChatId,
  } = getTelegramConfig();

  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"] ||
    req.headers["X-Telegram-Bot-Api-Secret-Token"];

  if (
    telegramSecretToken &&
    String(receivedSecret || "") !== String(telegramSecretToken)
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

  if (photos.length === 0) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "No photo",
    });
  }

  const db = getFirebaseAdminDb();

  const movementId = `telegram_${chatId}_${message.message_id}`;
  const movementRef = db.collection("movements").doc(movementId);
  const closureRef = db.collection("closures").doc(movementId);

  try {
    const existingClosure = await closureRef.get();

    if (existingClosure.exists) {
      await sendTelegramMessage(
        chatId,
        "Este registro de Telegram ya fue procesado anteriormente."
      );

      return res.status(200).json({
        ok: true,
        duplicate: true,
        id: movementId,
      });
    }

    const largestPhoto = photos.reduce((best: any, current: any) => {
      return (current.file_size || 0) > (best.file_size || 0)
        ? current
        : best;
    }, photos[0]);

    const downloaded = await downloadTelegramPhoto(largestPhoto.file_id);

    const extraction = await extractFinancialDataFromImage({
      imageBuffer: downloaded.imageBuffer,
      mimeType: downloaded.mimeType,
      caption: message.caption || "",
    });

    const movement = buildMovementFromExtraction(extraction, new Date());

    const firestoreMovement = removeUndefinedDeep({
      ...movement,
      telegramChatId: String(chatId),
      telegramMessageId: message.message_id,
      telegramUserId: message.from?.id ? String(message.from.id) : null,
      telegramUserName: message.from?.username || null,
      telegramFirstName: message.from?.first_name || null,
      telegramFileId: largestPhoto.file_id,
      telegramFileUniqueId: largestPhoto.file_unique_id || null,
      telegramFilePath: downloaded.telegramFilePath,
    });

    await movementRef.set(firestoreMovement, { merge: true });

    const raw = firestoreMovement.telegramRawExtraction || {};

    const responsible = cleanResponsible(
      raw.proveedor_cliente ||
        raw.responsable ||
        raw.descripcion ||
        message.from?.first_name ||
        firestoreMovement.telegramFirstName ||
        "SIN RESPONSABLE"
    );

    const amount =
      typeof firestoreMovement.amount === "number" &&
      Number.isFinite(firestoreMovement.amount)
        ? firestoreMovement.amount
        : 0;

    const closureData = removeUndefinedDeep({
      createdAt: FieldValue.serverTimestamp(),
      createdBy: firestoreMovement.createdBy || "telegram-bot",

      date: firestoreMovement.date,

      responsible,

      physicalAmount: amount,
      systemAmount: 0,
      systemBalance: 0,
      difference: amount,

      status: "safe",

      source: "telegram",
      note: firestoreMovement.description || "",

      telegramChatId: String(chatId),
      telegramMessageId: message.message_id,
      telegramUserId: message.from?.id ? String(message.from.id) : null,
      telegramUserName: message.from?.username || null,
      telegramFirstName: message.from?.first_name || null,
      telegramFileId: largestPhoto.file_id,
      telegramFileUniqueId: largestPhoto.file_unique_id || null,
      telegramFilePath: downloaded.telegramFilePath,
      telegramConfidence: firestoreMovement.telegramConfidence || null,
      telegramRequiresReview: firestoreMovement.telegramRequiresReview || false,
      telegramRawExtraction: raw,
    });

    await closureRef.set(closureData, { merge: true });

    const tipoTexto =
      firestoreMovement.type === "inflow"
        ? "ingreso"
        : firestoreMovement.type === "outflow"
          ? "egreso"
          : "transferencia";

    const estadoTexto = firestoreMovement.telegramRequiresReview
      ? "PENDIENTE REVISION"
      : "CONFIRMADO";

    await sendTelegramMessage(
      chatId,
      [
        "Registro creado desde foto.",
        `Tipo: ${tipoTexto}`,
        `Responsable: ${responsible}`,
        `Monto: USD ${formatMoney(amount)}`,
        `Estado: ${estadoTexto}`,
      ].join("\n")
    );

    return res.status(200).json({
      ok: true,
      movementId,
      closureId: movementId,
      type: firestoreMovement.type,
      amount,
      responsible,
      review: firestoreMovement.telegramRequiresReview,
    });
  } catch (error: any) {
    console.error("Error procesando foto de Telegram:", error);

    await sendTelegramMessage(
      chatId,
      `No pude registrar esta foto automaticamente. Motivo: ${
        error?.message || String(error)
      }`
    );

    return res.status(200).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
}