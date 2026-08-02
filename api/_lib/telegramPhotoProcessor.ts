import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { auditSavedPerseoReportsForDate, getEcuadorBusinessDateKeyFromValue } from "./perseoAudit.js";
import { canonicalizeCashierName } from "./cashierNames.js";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import {
  buildMovementFromExtraction,
  downloadTelegramPhoto,
  extractFinancialDataFromImage,
  getFriendlyGeminiErrorMessage,
  isTemporaryPhotoProcessingError,
  sendTelegramMessage,
} from "./telegramMovement.js";

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
    .replace(/^CAJER[OA]\s*:?/i, "")
    .replace(/^CAJA\s*:?/i, "")
    .replace(/^SR\.?\s*/i, "")
    .replace(/^SRA\.?\s*/i, "")
    .trim();

  const canonical = canonicalizeCashierName(text || "SIN RESPONSABLE");
  return (canonical.canonical || "SIN RESPONSABLE").toUpperCase().slice(0, 80);
}

function normalizeDuplicateText(value: any): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^ESQ\s+/i, "")
    .replace(/^RESPONSABLE\s*:?/i, "")
    .replace(/^CAJER[OA]\s*:?/i, "")
    .replace(/^CAJA\s*:?/i, "")
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

function buildClosureIdentityKey(params: {
  date: any;
  responsible: string;
  createdBy: string;
}) {
  const dateKey = timestampToBusinessDateKey(params.date);
  const responsibleKey = normalizeDuplicateText(params.responsible);
  const userKey = normalizeDuplicateText(params.createdBy);

  return `${dateKey}_${responsibleKey}_${userKey}`;
}

function getTelegramFallbackDate(message: any) {
  const unixSeconds = Number(message?.date || 0);

  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return new Date();
  }

  return new Date(unixSeconds * 1000);
}

function formatEcuadorBusinessDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guayaquil",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function formatMoney(value: any) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return number.toFixed(2);
}

function shiftBusinessDate(businessDate: string, days: number) {
  const [year, month, day] = businessDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

async function findPerseoDateCorrection(params: {
  date: any;
  amount: number;
  responsible: string;
}) {
  const originalDate = getEcuadorBusinessDateKeyFromValue(params.date);
  if (!originalDate || params.amount <= 0) return null;

  const candidateDates = [
    originalDate,
    shiftBusinessDate(originalDate, -1),
    shiftBusinessDate(originalDate, 1),
  ];
  const cashier = canonicalizeCashierName(params.responsible).canonical;
  const reportSnapshot = await getFirebaseAdminDb()
    .collection("perseo_reports")
    .where("businessDates", "array-contains-any", candidateDates)
    .limit(20)
    .get();
  const matchingDates = new Set<string>();

  reportSnapshot.docs.forEach(document => {
    const rows = Array.isArray(document.data()?.rows) ? document.data().rows : [];
    rows.forEach((row: any) => {
      const businessDate = String(row?.businessDate || "");
      if (!candidateDates.includes(businessDate)) return;

      const rowCashiers = [row?.responsible, row?.cashBox]
        .map(value => canonicalizeCashierName(value).canonical)
        .filter(Boolean);
      if (!rowCashiers.includes(cashier)) return;

      const amounts = [row?.systemBalance, row?.reportedAmount]
        .map(value => Number(value || 0))
        .filter(value => value > 0);
      if (amounts.some(value => Math.abs(value - params.amount) <= 0.10)) {
        matchingDates.add(businessDate);
      }
    });
  });

  if (matchingDates.has(originalDate) || matchingDates.size !== 1) return null;
  const correctedDate = Array.from(matchingDates)[0];
  return correctedDate && correctedDate !== originalDate
    ? { originalDate, correctedDate }
    : null;
}

function parseOptionalMoney(value: any) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);

  const text = String(value ?? "")
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!text) return 0;

  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  const decimalSeparator = comma > dot ? "," : ".";
  const normalized = decimalSeparator === ","
    ? text.replace(/\./g, "").replace(",", ".")
    : text.replace(/,/g, "");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getExtractedSystemValues(raw: Record<string, any>) {
  const systemAmount = parseOptionalMoney(
    raw.venta_sistema ??
      raw.ventas_sistema ??
      raw.venta_total ??
      raw.total_venta ??
      raw.total_vendido ??
      raw.facturado ??
      raw.ingresos
  );
  const systemBalance = parseOptionalMoney(
    raw.cuadre_sistema ??
      raw.saldo_sistema ??
      raw.efectivo_esperado ??
      raw.sistema ??
      raw.cierre_sistema
  );
  const fallbackBalance = systemBalance || systemAmount || parseOptionalMoney(raw.sistema);

  return {
    systemAmount,
    systemBalance: fallbackBalance,
  };
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

async function findPotentialClosureDuplicate(params: {
  date: any;
  amount: number;
  responsible: string;
  createdBy: string;
}) {
  const businessDate = getEcuadorBusinessDateKeyFromValue(params.date);
  if (!businessDate || params.amount <= 0) return null;

  const db = getFirebaseAdminDb();
  const dayStart = new Date(`${businessDate}T00:00:00.000Z`);
  const dayEnd = new Date(`${businessDate}T23:59:59.999Z`);
  const canonicalResponsible = canonicalizeCashierName(params.responsible).canonical;

  const snapshot = await db
    .collection("closures")
    .where("date", ">=", dayStart)
    .where("date", "<=", dayEnd)
    .get();

  const sameCashierClosures = snapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data() }))
    .filter((doc) => {
      const data = doc.data;
      const sameCreator = String(data.createdBy || "") === String(params.createdBy || "");
      const sameResponsible =
        canonicalizeCashierName(data.responsible || "").canonical === canonicalResponsible;

      return sameCreator && sameResponsible;
    })
    .sort((a, b) => {
      const aHasPerseo = a.data.systemSource === "perseo" || a.data.perseoReportId ? 1 : 0;
      const bHasPerseo = b.data.systemSource === "perseo" || b.data.perseoReportId ? 1 : 0;
      if (aHasPerseo !== bHasPerseo) return bHasPerseo - aHasPerseo;

      const aCreated = typeof a.data.createdAt?.toMillis === "function" ? a.data.createdAt.toMillis() : 0;
      const bCreated = typeof b.data.createdAt?.toMillis === "function" ? b.data.createdAt.toMillis() : 0;
      return aCreated - bCreated;
    });

  const matched = sameCashierClosures.find((doc) => {
    const data = doc.data;
    const sameAmount = Math.abs(Number(data.physicalAmount || 0) - Number(params.amount || 0)) <= 0.01;

    return sameAmount;
  });

  if (matched) {
    return { id: matched.id, data: matched.data, duplicateType: "same-day-cashier-amount" };
  }

  if (sameCashierClosures.length > 0) {
    const nearest = sameCashierClosures
      .map((doc) => ({
        ...doc,
        amountDifference: Math.abs(Number(doc.data.physicalAmount || 0) - Number(params.amount || 0)),
      }))
      .sort((a, b) => a.amountDifference - b.amountDifference)[0];

    return {
      id: nearest.id,
      data: nearest.data,
      duplicateType: nearest.amountDifference <= 1 ? "same-day-cashier-near-amount" : "same-day-cashier",
      amountDifference: nearest.amountDifference,
    };
  }

  return null;
}

export function getTelegramMessageKey(chatId: number | string, messageId: number | string) {
  return `telegram_${chatId}_${messageId}`;
}

export function getLargestTelegramPhoto(photos: any[]) {
  return photos.reduce((best: any, current: any) => {
    return (current.file_size || 0) > (best.file_size || 0) ? current : best;
  }, photos[0]);
}

export async function savePendingTelegramPhoto(params: {
  chatId: number | string;
  message: any;
  largestPhoto: any;
  error: any;
  source?: "webhook" | "retry";
}) {
  const db = getFirebaseAdminDb();
  const pendingId = getTelegramMessageKey(params.chatId, params.message.message_id);
  const errorMessage = params.error?.message || String(params.error || "Error desconocido");
  const retryable = isTemporaryPhotoProcessingError(params.error);

  await db.collection("telegram_pending_photos").doc(pendingId).set(
    removeUndefinedDeep({
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      chatId: String(params.chatId),
      messageId: params.message.message_id,
      status: retryable ? "pending" : "needs_review",
      retryable,
      attempts: FieldValue.increment(1),
      lastError: errorMessage.slice(0, 1000),
      friendlyMessage: getFriendlyGeminiErrorMessage(params.error),
      source: params.source || "webhook",
      nextRetryAt: retryable ? FieldValue.serverTimestamp() : null,
      telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
      telegramUserName: params.message.from?.username || null,
      telegramFirstName: params.message.from?.first_name || null,
      caption: params.message.caption || "",
      photo: {
        fileId: params.largestPhoto.file_id,
        fileUniqueId: params.largestPhoto.file_unique_id || null,
        fileSize: params.largestPhoto.file_size || null,
        width: params.largestPhoto.width || null,
        height: params.largestPhoto.height || null,
      },
      rawMessage: params.message,
    }),
    { merge: true }
  );

  return {
    pendingId,
    retryable,
    friendlyMessage: getFriendlyGeminiErrorMessage(params.error),
  };
}

export async function markPendingStatus(params: {
  pendingId: string;
  status: "processing" | "completed" | "failed" | "needs_review" | "pending";
  error?: any;
  closureId?: string;
}) {
  const db = getFirebaseAdminDb();
  const isCompleted = params.status === "completed";
  const isTerminal = isCompleted || params.status === "failed" || params.status === "needs_review";

  await db.collection("telegram_pending_photos").doc(params.pendingId).set(
    removeUndefinedDeep({
      updatedAt: FieldValue.serverTimestamp(),
      status: params.status,
      lastError: params.error
        ? String(params.error?.message || params.error).slice(0, 1000)
        : isCompleted ? null : undefined,
      retryable: isTerminal ? false : undefined,
      nextRetryAt: isCompleted ? null : undefined,
      completedAt: isCompleted ? FieldValue.serverTimestamp() : undefined,
      closureId: params.closureId,
    }),
    { merge: true }
  );
}

export async function processTelegramPhotoMessage(params: {
  chatId: number | string;
  message: any;
  largestPhoto: any;
  sendSuccessMessage?: boolean;
  extractionAttempts?: number;
}) {
  const db = getFirebaseAdminDb();
  const telegramMessageKey = getTelegramMessageKey(params.chatId, params.message.message_id);
  const telegramMessageRef = db
    .collection("telegram_processed_messages")
    .doc(telegramMessageKey);

  const alreadyProcessedMessage = await telegramMessageRef.get();

  if (alreadyProcessedMessage.exists) {
    await sendTelegramMessage(
      params.chatId,
      "Este mensaje de Telegram ya fue procesado anteriormente."
    );

    return {
      ok: true,
      duplicate: true,
      duplicateType: "telegram-message",
      id: telegramMessageKey,
    };
  }

  const telegramFileUniqueId = params.largestPhoto.file_unique_id || null;

  if (telegramFileUniqueId) {
    const samePhotoQuery = await db
      .collection("closures")
      .where("telegramFileUniqueId", "==", telegramFileUniqueId)
      .limit(1)
      .get();

    if (!samePhotoQuery.empty) {
      const existingDoc = samePhotoQuery.docs[0];
      const data = existingDoc.data();

      if (!data.telegramFileId) {
        await existingDoc.ref.set(
          removeUndefinedDeep({
            source: data.source || "telegram",
            telegramChatId: String(params.chatId),
            telegramMessageId: params.message.message_id,
            telegramFileId: params.largestPhoto.file_id,
            telegramFileUniqueId,
          }),
          { merge: true }
        );
      }

      await replyDuplicate({
        chatId: params.chatId,
        responsible: cleanResponsible(data.responsible || "SIN RESPONSABLE"),
        amount: data.physicalAmount || 0,
        reason: "Esta misma foto ya existe en el sistema.",
      });

      await telegramMessageRef.set(
        {
          createdAt: FieldValue.serverTimestamp(),
          chatId: String(params.chatId),
          messageId: params.message.message_id,
          duplicate: true,
          duplicateType: "same-photo",
          existingClosureId: existingDoc.id,
          telegramFileUniqueId,
        },
        { merge: true }
      );

      return {
        ok: true,
        duplicate: true,
        duplicateType: "same-photo",
        existingClosureId: existingDoc.id,
      };
    }
  }

  const downloaded = await downloadTelegramPhoto(params.largestPhoto.file_id);

  const telegramFallbackDate = getTelegramFallbackDate(params.message);
  const extraction = await extractFinancialDataFromImage({
    imageBuffer: downloaded.imageBuffer,
    mimeType: downloaded.mimeType,
    caption: params.message.caption || "",
    referenceDate: formatEcuadorBusinessDate(telegramFallbackDate),
    maxAttempts: params.extractionAttempts ?? 3,
    baseDelayMs: 1500,
  });

  const parsedMovement = buildMovementFromExtraction(
    extraction,
    telegramFallbackDate
  );

  const firestoreMovement = removeUndefinedDeep({
    ...parsedMovement,
    telegramChatId: String(params.chatId),
    telegramMessageId: params.message.message_id,
    telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
    telegramUserName: params.message.from?.username || null,
    telegramFirstName: params.message.from?.first_name || null,
    telegramFileId: params.largestPhoto.file_id,
    telegramFileUniqueId,
    telegramFilePath: downloaded.telegramFilePath,
  });

  const raw = firestoreMovement.telegramRawExtraction || {};

  const responsible = cleanResponsible(
    raw.proveedor_cliente ||
      raw.responsable ||
      raw.descripcion ||
      params.message.from?.first_name ||
      firestoreMovement.telegramFirstName ||
      "SIN RESPONSABLE"
  );

  const amount =
    typeof firestoreMovement.amount === "number" &&
    Number.isFinite(firestoreMovement.amount)
      ? firestoreMovement.amount
      : 0;

  if (amount <= 0) {
    throw new Error(
      "La IA no encontró un monto válido en la foto. No se creó ningún registro incompleto."
    );
  }

  const perseoDateCorrection = await findPerseoDateCorrection({
    date: firestoreMovement.date,
    amount,
    responsible,
  });
  if (perseoDateCorrection) {
    firestoreMovement.date = Timestamp.fromDate(
      new Date(`${perseoDateCorrection.correctedDate}T12:00:00.000Z`)
    );
    firestoreMovement.telegramDateAdjusted = true;
    firestoreMovement.telegramOriginalDate = perseoDateCorrection.originalDate;
    firestoreMovement.telegramDateCorrectionReason = "perseo_cashier_amount_match";
    firestoreMovement.telegramRawExtraction = {
      ...raw,
      fecha_original_ocr: perseoDateCorrection.originalDate,
      fecha: perseoDateCorrection.correctedDate,
    };
  }

  const createdBy = firestoreMovement.createdBy || "telegram-bot";

  const duplicateKey = buildDuplicateKey({
    date: firestoreMovement.date,
    amount,
    responsible,
    createdBy,
  });

  const duplicateIdentityKey = buildClosureIdentityKey({
    date: firestoreMovement.date,
    responsible,
    createdBy,
  });

  const closureId = `telegram_${duplicateIdentityKey}`;
  const closureRef = db.collection("closures").doc(closureId);
  const potentialDuplicate = await findPotentialClosureDuplicate({
    date: firestoreMovement.date,
    amount,
    responsible,
    createdBy,
  });

  if (
    potentialDuplicate?.duplicateType === "same-day-cashier"
    && Number(potentialDuplicate.amountDifference || 0) > 1
  ) {
    const error: any = new Error(
      "La fecha OCR coincide con otro cierre del mismo cajero, pero el monto es diferente. Esperando reporte Perseo."
    );
    error.code = "PHOTO_AWAITING_PERSEO_REPORT";
    throw error;
  }

  if (potentialDuplicate) {
    await telegramMessageRef.set(
      {
        createdAt: FieldValue.serverTimestamp(),
        chatId: String(params.chatId),
        messageId: params.message.message_id,
        duplicate: true,
        duplicateType: potentialDuplicate.duplicateType || "same-day-cashier",
        existingClosureId: potentialDuplicate.id,
        attemptedAmount: amount,
        existingAmount: Number(potentialDuplicate.data.physicalAmount || 0),
        duplicateKey,
        duplicateIdentityKey,
        telegramFileUniqueId,
      },
      { merge: true }
    );

    await db.collection("telegram_duplicate_closure_attempts").doc(telegramMessageKey).set(
      removeUndefinedDeep({
        createdAt: FieldValue.serverTimestamp(),
        chatId: String(params.chatId),
        messageId: params.message.message_id,
        duplicateType: potentialDuplicate.duplicateType || "same-day-cashier",
        existingClosureId: potentialDuplicate.id,
        duplicateKey,
        duplicateIdentityKey,
        responsible,
        attemptedAmount: amount,
        existingAmount: Number(potentialDuplicate.data.physicalAmount || 0),
        amountDifference: potentialDuplicate.amountDifference,
        telegramFileUniqueId,
        telegramRawExtraction: raw,
      }),
      { merge: true }
    );

    await replyDuplicate({
      chatId: params.chatId,
      responsible,
      amount,
      reason: "Ya existe un cierre para ese cajero en el mismo dia. No cree otro corte; deje este intento guardado para revision.",
    });

    return {
      ok: true,
      duplicate: true,
      duplicateType: potentialDuplicate.duplicateType || "same-day-cashier",
      existingClosureId: potentialDuplicate.id,
      duplicateKey,
      duplicateIdentityKey,
    };
  }

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
          chatId: String(params.chatId),
          messageId: params.message.message_id,
          duplicate: true,
          duplicateType: "business-duplicate",
          closureId,
          duplicateKey,
          duplicateIdentityKey,
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
      duplicateIdentityKey,
      source: "telegram",
      notes: firestoreMovement.description || "",
      telegramChatId: String(params.chatId),
      telegramMessageId: params.message.message_id,
      telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
      telegramUserName: params.message.from?.username || null,
      telegramFirstName: params.message.from?.first_name || null,
      telegramFileId: params.largestPhoto.file_id,
      telegramFileUniqueId,
      telegramFilePath: downloaded.telegramFilePath,
      telegramConfidence: firestoreMovement.telegramConfidence || null,
      telegramRequiresReview: firestoreMovement.telegramRequiresReview || false,
      telegramRawExtraction: raw,
    });

    transaction.set(closureRef, closureData, { merge: true });

    transaction.set(
      telegramMessageRef,
      {
        createdAt: FieldValue.serverTimestamp(),
        chatId: String(params.chatId),
        messageId: params.message.message_id,
        duplicate: false,
        closureId,
        duplicateKey,
        duplicateIdentityKey,
        telegramFileUniqueId,
      },
      { merge: true }
    );

    return {
      duplicate: false,
      closureId,
    };
  });

  if (transactionResult.duplicate) {
    await replyDuplicate({
      chatId: params.chatId,
      responsible,
      amount,
      reason: "Este cierre ya existe en el sistema.",
    });

    return {
      ok: true,
      duplicate: true,
      duplicateType: transactionResult.duplicateType,
      existingClosureId: transactionResult.existingClosureId,
      duplicateKey,
    };
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

  if (params.sendSuccessMessage !== false) {
    const savedBusinessDate = timestampToBusinessDateKey(firestoreMovement.date);
    const dateCorrectionMessage = firestoreMovement.telegramDateAdjusted
      ? `Fecha OCR ${firestoreMovement.telegramOriginalDate} corregida automaticamente a ${savedBusinessDate}.`
      : null;

    await sendTelegramMessage(
      params.chatId,
      [
        "Registro creado desde foto.",
        `Tipo: ${tipoTexto}`,
        `Fecha: ${savedBusinessDate}`,
        `Responsable: ${responsible}`,
        `Monto: USD ${formatMoney(amount)}`,
        `Estado: ${estadoTexto}`,
        dateCorrectionMessage,
      ].filter(Boolean).join("\n")
    );
  }

  const businessDate = getEcuadorBusinessDateKeyFromValue(firestoreMovement.date);
  if (businessDate) {
    try {
      await auditSavedPerseoReportsForDate({ businessDate });
    } catch (error) {
      console.error(`No se pudo cruzar Perseo automaticamente para ${businessDate}:`, error);
    }
  }

  return {
    ok: true,
    closureId: transactionResult.closureId,
    type: firestoreMovement.type,
    amount,
    responsible,
    duplicateKey,
    duplicateIdentityKey,
    review: firestoreMovement.telegramRequiresReview,
  };
}
