import { GoogleGenAI, Type } from "@google/genai";
import {
  auditClosuresWithPerseoRows,
  parsePerseoReport,
  savePerseoReport,
} from "./perseoAudit.js";
import {
  downloadTelegramPhoto,
  getTelegramConfig,
  sendTelegramMessage,
} from "./telegramMovement.js";

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function isLikelyPerseoReportMessage(message: any) {
  const text = normalizeText([
    message.text,
    message.caption,
    message.document?.file_name,
    message.document?.mime_type,
  ].filter(Boolean).join(" "));
  const isPdf = text.includes("application/pdf") || text.endsWith(".pdf") || text.includes(".pdf");

  return (
    text.includes("perseo") ||
    text.includes("reporte 21") ||
    text.includes("21:00") ||
    text.includes("cuadre sistema") ||
    text.includes("cuadres") ||
    text.includes("venta sistema") ||
    text.includes("estado cierres") ||
    text.includes("estado de cierres") ||
    (isPdf && text.includes("reporte")) ||
    (isPdf && text.includes("cuadre")) ||
    (isPdf && text.includes("cierre") && text.includes("caja"))
  );
}

function getReportText(message: any) {
  return String(message.text || message.caption || "").trim();
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
  const rows = await getReportRowsFromMessage(params.message, params.largestPhoto);

  if (rows.length === 0) {
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

  await sendTelegramMessage(
    params.chatId,
    [
      "Reporte Perseo procesado.",
      `Filas: ${audit.totalRows}`,
      `Cierres actualizados: ${audit.updated}`,
      `Sin coincidencia/revision: ${audit.unmatched}`,
      `Reporte: ${reportId}`,
    ].join("\n")
  );

  return {
    ok: true,
    report: true,
    reportId,
    ...audit,
  };
}
