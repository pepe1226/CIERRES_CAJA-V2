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
    return value.map(removeUndefinedDeep).filter((item) => item !== undefined);
  }

  if (typeof value !== "object") {
    return value;
  }

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

function normalizeDuplicateText(value: any): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^ESQ\s+/i, "")
    .replace(/^RESPONSABLE\s*:?/i, "")
    .replace(/^SR\.?\s*/i, "")
    .replace(/^SRA\.?\s*/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

function timestampToBusinessDateKey(value: any): string {
  try {
    if (value && typeof value.toDate === "function") {
      const date = value.toDate();

      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");

      return `${year}-${month}-${day}`;
    }

    if (value instanceof Date) {
      const year = value.getUTCFullYear();
      const month = String(value.getUTCMonth() + 1).padStart(2, "0");
      const day = String(value.getUTCDate()).padStart(2, "0");

      return `${year}-${month}-${day}`;
    }
  } catch (error) {
    console.error("No se pudo crear fecha para duplicateKey:", error);
  }

  return "SIN-FECHA";
}

function buildDuplicateKey(params: {
  date: any;
  amount: number;
  responsible: string;
  createdBy: string;
}) {
  const dateKey = timestampToBusinessDateKey(params.date);
  const amountInCents = Math.round((params.amount || 0) * 100);
  const responsibleKey = normalizeDuplicateText(params.responsible);
  const userKey = normalizeDuplicateText(params.createdBy);

  return `${dateKey}_${amountInCents}_${responsibleKey}_${userKey}`;
}

function formatMoney(value: any) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return number.toFixed(2);
}

async function replyDuplicate(params: {
  chatId: number | string;
  responsible: string;
  amount: number;
  reason: string;
}) {
  await sendTelegramMessage(
    params.chatId,
    [
      "Registro duplicado detectado.",
      `Responsable: ${params.responsible}`,
      `Monto: USD ${formatMoney(params.amount)}`,
      params.reason,
    ].join("\n")
  );
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const { telegramSecretToken, telegramAllowedChatId } = getTelegramConfig();

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

  const telegramMessageKey = `telegram_${chatId}_${message.message_id}`;
  const telegramMessageRef = db
    .collection("telegram_processed_messages")
    .doc(telegramMessageKey);

  try {
    const alreadyProcessedMessage = await telegramMessageRef.get();

    if (alreadyProcessedMessage.exists) {
      await sendTelegramMessage(
        chatId,
        "Este mensaje de Telegram ya fue procesado anteriormente."
      );

      return res.status(200).json({
        ok: true,
        duplicate: true,
        duplicateType: "telegram-message",
        id: telegramMessageKey,
      });
    }

    const largestPhoto = photos.reduce((best: any, current: any) => {
      return (current.file_size || 0) > (best.file_size || 0)
        ? current
        : best;
    }, photos[0]);

    const telegramFileUniqueId = largestPhoto.file_unique_id || null;

    if (telegramFileUniqueId) {
      const samePhotoQuery = await db
        .collection("closures")
        .where("telegramFileUniqueId", "==", telegramFileUniqueId)
        .limit(1)
        .get();

      if (!samePhotoQuery.empty) {
        const existingDoc = samePhotoQuery.docs[0];
        const data = existingDoc.data();

        await replyDuplicate({
          chatId,
          responsible: cleanResponsible(data.responsible || "SIN RESPONSABLE"),
          amount: data.physicalAmount || 0,
          reason: "Esta misma foto ya existe en el sistema.",
        });

        await telegramMessageRef.set(
          {
            createdAt: FieldValue.serverTimestamp(),
            chatId: String(chatId),
            messageId: message.message_id,
            duplicate: true,
            duplicateType: "same-photo",
            existingClosureId: existingDoc.id,
            telegramFileUniqueId,
          },
          { merge: true }
        );

        return res.status(200).json({
          ok: true,
          duplicate: true,
          duplicateType: "same-photo",
          existingClosureId: existingDoc.id,
        });
      }
    }

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
      telegramFileUniqueId,
      telegramFilePath: downloaded.telegramFilePath,
    });

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

    const createdBy = firestoreMovement.createdBy || "telegram-bot";

    const duplicateKey = buildDuplicateKey({
      date: firestoreMovement.date,
      amount,
      responsible,
      createdBy,
    });

    const closureId = `telegram_${duplicateKey}`;
    const movementId = `telegram_${duplicateKey}`;

    const closureRef = db.collection("closures").doc(closureId);
    const movementRef = db.collection("movements").doc(movementId);

    const transactionResult = await db.runTransaction(async (transaction: any) => {
      const processedMessageDoc = await transaction.get(telegramMessageRef);
      const existingClosureDoc = await transaction.get(closureRef);

      if (processedMessageDoc.exists) {
        return {
          duplicate: true,
          duplicateType: "telegram-message",
          existingClosureId: processedMessageDoc.data()?.closureId || closureId,
        };
      }

      if (existingClosureDoc.exists) {
        transaction.set(
          telegramMessageRef,
          {
            createdAt: FieldValue.serverTimestamp(),
            chatId: String(chatId),
            messageId: message.message_id,
            duplicate: true,
            duplicateType: "business-duplicate",
            closureId,
            duplicateKey,
            telegramFileUniqueId,
          },
          { merge: true }
        );

        return {
          duplicate: true,
          duplicateType: "business-duplicate",
          existingClosureId: closureId,
        };
      }

      const closureData = removeUndefinedDeep({
        createdAt: FieldValue.serverTimestamp(),
        createdBy,

        date: firestoreMovement.date,

        responsible,

        physicalAmount: amount,
        systemAmount: 0,
        systemBalance: 0,
        difference: amount,

        status: "safe",

        duplicateKey,

        source: "telegram",
        note: firestoreMovement.description || "",

        telegramChatId: String(chatId),
        telegramMessageId: message.message_id,
        telegramUserId: message.from?.id ? String(message.from.id) : null,
        telegramUserName: message.from?.username || null,
        telegramFirstName: message.from?.first_name || null,
        telegramFileId: largestPhoto.file_id,
        telegramFileUniqueId,
        telegramFilePath: downloaded.telegramFilePath,
        telegramConfidence: firestoreMovement.telegramConfidence || null,
        telegramRequiresReview: firestoreMovement.telegramRequiresReview || false,
        telegramRawExtraction: raw,
      });

      transaction.set(movementRef, firestoreMovement, { merge: true });
      transaction.set(closureRef, closureData, { merge: true });

      transaction.set(
        telegramMessageRef,
        {
          createdAt: FieldValue.serverTimestamp(),
          chatId: String(chatId),
          messageId: message.message_id,
          duplicate: false,
          closureId,
          movementId,
          duplicateKey,
          telegramFileUniqueId,
        },
        { merge: true }
      );

      return {
        duplicate: false,
        closureId,
        movementId,
      };
    });

    if (transactionResult.duplicate) {
      await replyDuplicate({
        chatId,
        responsible,
        amount,
        reason: "Este cierre ya existe en el sistema.",
      });

      return res.status(200).json({
        ok: true,
        duplicate: true,
        duplicateType: transactionResult.duplicateType,
        existingClosureId: transactionResult.existingClosureId,
        duplicateKey,
      });
    }

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
      movementId: transactionResult.movementId,
      closureId: transactionResult.closureId,
      type: firestoreMovement.type,
      amount,
      responsible,
      duplicateKey,
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