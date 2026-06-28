import { GoogleGenAI, Type } from "@google/genai";
import { FieldValue } from "firebase-admin/firestore";
import {
  auditClosuresWithPerseoRows,
  parsePerseoReport,
  savePerseoReport,
} from "./perseoAudit.js";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import {
  downloadTelegramPhoto,
  getTelegramConfig,
  sendTelegramMessage,
} from "./telegramMovement.js";

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function getEcuadorHourFromTelegramMessage(message: any) {
  const unixSeconds = Number(message.date || message.edit_date || 0);

  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return null;
  }

  const hourText = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: "America/Guayaquil",
  }).format(new Date(unixSeconds * 1000));

  return Number(hourText);
}

export function isLikelyPerseoReportMessage(message: any) {
  const isDocument = Boolean(message.document?.file_id);
  const mimeType = normalizeText(message.document?.mime_type);
  const fileName = normalizeText(message.document?.file_name);
  const caption = normalizeText(message.caption);
  const text = normalizeText([
    message.text,
    message.caption,
    message.document?.file_name,
    message.document?.mime_type,
  ].filter(Boolean).join(" "));
  const rawFileName = String(message.document?.file_name || "").toLowerCase();
  const isPdf =
    isDocument &&
    (mimeType.includes("application pdf") ||
      rawFileName.endsWith(".pdf") ||
      text.includes(" pdf"));
  const strongReportTerms = [
    "perseo",
    "reporte 21",
    "21:00",
    "21h",
    "cuadre sistema",
    "venta sistema",
    "saldo sistema",
    "estado cierres",
    "estado de cierres",
    "cierres de caja",
    "cierre de caja",
    "cierre caja",
    "cierres caja",
    "corte de caja",
    "cortes de caja",
  ];
  const documentReportTerms = [
    ...strongReportTerms,
    "cuadres",
    "cuadre",
    "cuadrar",
    "saldo caja",
    "sistema",
    "arqueo",
    "arqueos",
  ];
  const pdfNameTerms = [
    "cierre",
    "cierres",
    "caja",
    "cuadre",
    "cuadres",
    "estado",
    "saldo",
    "sistema",
    "arqueo",
    "corte",
  ];
  const ecuadorHour = getEcuadorHourFromTelegramMessage(message);
  const isNearDailyReportTime =
    ecuadorHour === null || (ecuadorHour >= 20 && ecuadorHour <= 23);

  return (
    hasAny(text, strongReportTerms) ||
    (isPdf && hasAny(caption, documentReportTerms)) ||
    (isPdf && hasAny(fileName, ["reporte", ...documentReportTerms])) ||
    (isPdf && hasAny(fileName, pdfNameTerms) && isNearDailyReportTime) ||
    (isPdf && isNearDailyReportTime)
  );
}

function getReportText(message: any) {
  return String(message.text || message.caption || "").trim();
}

function getAttemptId(chatId: number | string, messageId: number | string) {
  return `telegram_${String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_")}_${messageId}`;
}

function formatMoney(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function buildAuditTelegramMessage(audit: any, reportId: string) {
  const differenceRows = Array.isArray(audit.results)
    ? audit.results.filter((result: any) => result.ok && result.auditStatus === "difference")
    : [];
  const unmatchedRows = Array.isArray(audit.results)
    ? audit.results.filter((result: any) => !result.ok)
    : [];
  const lines = [
    "Reporte de cierres procesado.",
    `Filas: ${audit.totalRows}`,
    `Cierres cruzados: ${audit.updated}`,
    `Auditados OK: ${audit.matched || 0}`,
    `Con diferencia: ${audit.differences || 0}`,
    `Sin coincidencia/revision: ${audit.unmatched}`,
    `Total fisico fotos: USD ${formatMoney(audit.totalPhysicalAmount)}`,
    `Total sistema cierre: USD ${formatMoney(audit.totalSystemBalance)}`,
    `Diferencia total: USD ${formatMoney(audit.totalDifference)}`,
  ];

  if (differenceRows.length > 0) {
    lines.push("", "Diferencias:");

    differenceRows.slice(0, 8).forEach((result: any) => {
      lines.push(
        [
          `- ${result.responsible || "SIN RESPONSABLE"}`,
          `foto USD ${formatMoney(result.physicalAmount)}`,
          `sistema USD ${formatMoney(result.systemBalance)}`,
          `dif USD ${formatMoney(result.difference)}`,
        ].join(" | ")
      );
    });

    if (differenceRows.length > 8) {
      lines.push(`... y ${differenceRows.length - 8} diferencias mas.`);
    }
  }

  if (unmatchedRows.length > 0) {
    lines.push("", "Sin coincidencia:");

    unmatchedRows.slice(0, 5).forEach((result: any) => {
      lines.push(`- ${result.responsible || "SIN RESPONSABLE"} (${result.reason || "revision"})`);
    });
  }

  lines.push("", `Reporte: ${reportId}`);

  return lines.join("\n");
}

async function saveReportAttempt(params: {
  chatId: number | string;
  message: any;
  status: string;
  rows?: number;
  reportId?: string;
  error?: string;
  audit?: any;
}) {
  try {
    const db = getFirebaseAdminDb();
    const document = params.message.document || {};
    const attemptId = getAttemptId(params.chatId, params.message.message_id || Date.now());

    await db.collection("telegram_perseo_report_attempts").doc(attemptId).set(
      {
        chatId: String(params.chatId),
        messageId: params.message.message_id || null,
        telegramDate: params.message.date || null,
        fileId: document.file_id || null,
        fileName: document.file_name || null,
        mimeType: document.mime_type || null,
        caption: params.message.caption || params.message.text || null,
        status: params.status,
        rows: params.rows ?? null,
        reportId: params.reportId || null,
        error: params.error || null,
        auditSummary: params.audit
          ? {
              totalRows: params.audit.totalRows,
              updated: params.audit.updated,
              unmatched: params.audit.unmatched,
              matched: params.audit.matched,
              differences: params.audit.differences,
              totalPhysicalAmount: params.audit.totalPhysicalAmount,
              totalSystemBalance: params.audit.totalSystemBalance,
              totalDifference: params.audit.totalDifference,
            }
          : null,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("No se pudo guardar intento de reporte Perseo:", error);
  }
}

async function extractRowsFromReportFile(params: {
  imageBuffer: Buffer;
  mimeType: string;
  caption?: string;
}) {
  const { geminiApiKey, geminiModel } = getTelegramConfig();

  if (!geminiApiKey) {
    throw new Error("Falta GEMINI_API_KEY en Vercel.");
  }

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const prompt = `
Extrae filas de un reporte PDF o imagen de Perseo/cuadre de cierres de caja.

Objetivo:
Por cada cajero/responsable/local que aparezca, devuelve una fila con:
- fecha en formato YYYY-MM-DD
- responsable o cajero
- venta_sistema si existe
- cuadre_sistema, saldo_sistema, efectivo esperado o sistema si existe
- sistema si solo hay un valor general de sistema

Reglas:
- No inventes filas.
- Si solo existe una columna "sistema", usala como sistema.
- Si hay totales generales y filas por cajero, prefiere filas por cajero.
- Devuelve JSON valido.

Texto adicional:
${params.caption || "Sin texto adicional"}
`;

  const response = await ai.models.generateContent({
    model: geminiModel,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              data: params.imageBuffer.toString("base64"),
              mimeType: params.mimeType,
            },
          },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          rows: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                fecha: { type: Type.STRING, nullable: true },
                responsable: { type: Type.STRING, nullable: true },
                cajero: { type: Type.STRING, nullable: true },
                venta_sistema: { type: Type.NUMBER, nullable: true },
                cuadre_sistema: { type: Type.NUMBER, nullable: true },
                sistema: { type: Type.NUMBER, nullable: true },
              },
            },
          },
        },
        required: ["rows"],
      },
    },
  });

  const parsed = JSON.parse(response.text || "{}");
  return parsePerseoReport(parsed);
}

async function getReportRowsFromMessage(message: any, largestPhoto?: any) {
  const directText = getReportText(message);
  const directRows = parsePerseoReport(directText);

  if (directRows.length > 0) {
    return directRows;
  }

  const fileId = largestPhoto?.file_id || message.document?.file_id;

  if (!fileId) {
    return [];
  }

  const downloaded = await downloadTelegramPhoto(fileId);
  const mimeType = downloaded.mimeType.toLowerCase();
  const fileName = String(message.document?.file_name || "").toLowerCase();

  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("csv") ||
    fileName.endsWith(".csv") ||
    fileName.endsWith(".txt")
  ) {
    return parsePerseoReport(downloaded.imageBuffer.toString("utf8"));
  }

  if (mimeType.startsWith("image/")) {
    return extractRowsFromReportFile({
      imageBuffer: downloaded.imageBuffer,
      mimeType,
      caption: directText,
    });
  }

  if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
    return extractRowsFromReportFile({
      imageBuffer: downloaded.imageBuffer,
      mimeType: "application/pdf",
      caption: directText,
    });
  }

  return [];
}

export async function processTelegramPerseoReportMessage(params: {
  chatId: number | string;
  message: any;
  largestPhoto?: any;
}) {
  await saveReportAttempt({
    chatId: params.chatId,
    message: params.message,
    status: "processing",
  });

  let rows: ReturnType<typeof parsePerseoReport>;

  try {
    rows = await getReportRowsFromMessage(params.message, params.largestPhoto);
  } catch (error: any) {
    await saveReportAttempt({
      chatId: params.chatId,
      message: params.message,
      status: "error",
      error: error?.message || String(error),
    });

    throw error;
  }

  if (rows.length === 0) {
    await saveReportAttempt({
      chatId: params.chatId,
      message: params.message,
      status: "no_valid_rows",
      rows: 0,
    });

    await sendTelegramMessage(
      params.chatId,
      "Recibi un posible reporte de Perseo, pero no pude extraer filas validas para cruzar."
    );

    return {
      ok: false,
      report: true,
      reason: "no-valid-rows",
    };
  }

  const reportId = await savePerseoReport({
    source: "telegram-21h",
    rows,
  });

  const audit = await auditClosuresWithPerseoRows({
    rows,
    reportId,
  });

  await saveReportAttempt({
    chatId: params.chatId,
    message: params.message,
    status: "processed",
    rows: rows.length,
    reportId,
    audit,
  });

  await sendTelegramMessage(params.chatId, buildAuditTelegramMessage(audit, reportId));

  return {
    ok: true,
    report: true,
    reportId,
    ...audit,
  };
}
