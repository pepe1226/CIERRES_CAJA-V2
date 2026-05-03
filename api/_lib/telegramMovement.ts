import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

type GeminiTipo = "ingreso" | "egreso" | "transferencia" | "desconocido";
type AppMovementType = "inflow" | "outflow" | "transfer" | "internal_transfer";
type CajaId = "safe" | "transit" | "bank";

export type TelegramFinancialExtraction = {
  tipo: GeminiTipo;
  monto: number | null;
  moneda: string | null;
  fecha: string | null;
  caja: string | null;
  caja_origen: string | null;
  caja_destino: string | null;
  categoria: string | null;
  subcategoria: string | null;
  descripcion: string;
  proveedor_cliente: string | null;
  confianza_ia: number;
  requiere_revision: boolean;
  razones_revision: string[];
};

export function getTelegramConfig() {
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramSecretToken: process.env.TELEGRAM_SECRET_TOKEN || "",
    telegramAllowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID || "",
    telegramCreatedByUid: process.env.TELEGRAM_CREATED_BY_UID || "telegram-bot",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  };
}

export function getTelegramStatus() {
  const config = getTelegramConfig();

  return {
    configured: Boolean(config.telegramBotToken && config.telegramSecretToken && config.geminiApiKey),
    hasTelegramBotToken: Boolean(config.telegramBotToken),
    hasTelegramSecretToken: Boolean(config.telegramSecretToken),
    hasGeminiApiKey: Boolean(config.geminiApiKey),
    geminiModel: config.geminiModel,
    allowedChatId: config.telegramAllowedChatId || null,
    telegramCreatedByUid: config.telegramCreatedByUid,
  };
}

async function telegramApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const { telegramBotToken } = getTelegramConfig();

  if (!telegramBotToken) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN en Vercel.");
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} error: ${JSON.stringify(data)}`);
  }

  return data as T;
}

export async function sendTelegramMessage(chatId: number | string, text: string) {
  try {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("No se pudo responder en Telegram:", error);
  }
}

export async function downloadTelegramPhoto(fileId: string) {
  const { telegramBotToken } = getTelegramConfig();

  const fileInfo = await telegramApi<{ ok: true; result: { file_path: string } }>("getFile", {
    file_id: fileId,
  });

  const fileUrl = `https://api.telegram.org/file/bot${telegramBotToken}/${fileInfo.result.file_path}`;
  const imageResponse = await fetch(fileUrl);

  if (!imageResponse.ok) {
    throw new Error(`No se pudo descargar la imagen de Telegram: ${imageResponse.status}`);
  }

  const arrayBuffer = await imageResponse.arrayBuffer();

  return {
    imageBuffer: Buffer.from(arrayBuffer),
    mimeType: imageResponse.headers.get("content-type") || "image/jpeg",
    telegramFilePath: fileInfo.result.file_path,
  };
}

function normalizeCaja(value?: string | null): CajaId | null {
  if (!value) return null;

  const text = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (
    text.includes("banco") ||
    text.includes("bank") ||
    text.includes("deposito") ||
    text.includes("cuenta") ||
    text.includes("transferencia bancaria")
  ) {
    return "bank";
  }

  if (
    text.includes("transito") ||
    text.includes("transit") ||
    text.includes("viaje") ||
    text.includes("recaudacion") ||
    text.includes("ruta")
  ) {
    return "transit";
  }

  if (
    text.includes("caja") ||
    text.includes("principal") ||
    text.includes("chica") ||
    text.includes("safe") ||
    text.includes("efectivo") ||
    text.includes("cash")
  ) {
    return "safe";
  }

  return null;
}

function mapTipoToMovementType(extraction: TelegramFinancialExtraction): AppMovementType {
  if (extraction.tipo === "ingreso") return "inflow";
  if (extraction.tipo === "egreso") return "outflow";

  if (extraction.tipo === "transferencia") {
    const destination = normalizeCaja(extraction.caja_destino || extraction.caja);
    return destination === "bank" ? "transfer" : "internal_transfer";
  }

  return "outflow";
}

export function buildMovementFromExtraction(extraction: TelegramFinancialExtraction, fallbackDate: Date) {
  const { telegramCreatedByUid } = getTelegramConfig();
  const type = mapTipoToMovementType(extraction);
  const caja = normalizeCaja(extraction.caja) || "safe";
  const cajaOrigen = normalizeCaja(extraction.caja_origen) || caja;
  const cajaDestino = normalizeCaja(extraction.caja_destino);

  const movementDate = extraction.fecha && !Number.isNaN(new Date(extraction.fecha).getTime())
    ? new Date(extraction.fecha)
    : fallbackDate;

  const amount = typeof extraction.monto === "number" && Number.isFinite(extraction.monto)
    ? Math.max(0, extraction.monto)
    : 0;

  const requiresReview =
    extraction.requiere_revision ||
    extraction.confianza_ia < 0.85 ||
    !extraction.monto ||
    extraction.tipo === "desconocido" ||
    (!normalizeCaja(extraction.caja) && type !== "transfer" && type !== "internal_transfer");

  let from: CajaId | undefined;
  let to: CajaId | undefined;

  if (type === "inflow") {
    to = caja;
  } else if (type === "outflow") {
    from = caja;
  } else if (type === "transfer") {
    from = cajaOrigen || "transit";
    to = cajaDestino || "bank";
  } else if (type === "internal_transfer") {
    from = cajaOrigen || "safe";
    to = cajaDestino || (from === "safe" ? "transit" : "safe");
  }

  const descriptionPrefix = requiresReview ? "[REVISAR TELEGRAM] " : "[TELEGRAM] ";
  const description = `${descriptionPrefix}${extraction.descripcion || "MOVIMIENTO DESDE FOTO"}`
    .trim()
    .toUpperCase()
    .slice(0, 500);

  return {
    date: Timestamp.fromDate(movementDate),
    type,
    amount,
    description,
    createdBy: telegramCreatedByUid,
    category: extraction.categoria || "Telegram",
    subcategory: extraction.subcategoria || undefined,
    from,
    to,
    createdAt: FieldValue.serverTimestamp(),
    source: "telegram",
    telegramProvider: "vercel",
    telegramRequiresReview: requiresReview,
    telegramConfidence: extraction.confianza_ia,
    telegramReviewReasons: extraction.razones_revision || [],
    telegramRawExtraction: extraction,
  };
}

export async function extractFinancialDataFromImage(params: {
  imageBuffer: Buffer;
  mimeType: string;
  caption?: string;
}): Promise<TelegramFinancialExtraction> {
  const { geminiApiKey, geminiModel } = getTelegramConfig();

  if (!geminiApiKey) {
    throw new Error("Falta GEMINI_API_KEY en Vercel.");
  }

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const prompt = `
Eres un asistente para una app de control, manejo y gestion de dinero en diferentes cajas.

Analiza la imagen enviada por Telegram. Puede ser factura, recibo, comprobante, transferencia bancaria, captura de pantalla, nota de venta o comprobante escrito a mano.

Objetivo: extraer los datos para crear un movimiento de caja en Firestore.

Reglas:
- Si parece venta, cobro, deposito o dinero recibido: tipo = "ingreso".
- Si parece compra, gasto, pago o salida de dinero: tipo = "egreso".
- Si parece movimiento entre cajas: tipo = "transferencia".
- Si no estas seguro: tipo = "desconocido".
- No inventes datos.
- Si no detectas monto claro: monto = null.
- Si no detectas fecha: fecha = null.
- Si no detectas caja: caja = null.
- La caja debe inferirse como caja principal, caja chica, transito o banco cuando sea posible.
- Usa USD si no se ve otra moneda.
- Si falta monto, fecha, caja o tipo claro, requiere_revision = true.
- Si la confianza es menor a 0.85, requiere_revision = true.
- La descripcion debe ser corta y util para una app de caja.

Texto adicional escrito junto con la foto:
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
          tipo: { type: Type.STRING, enum: ["ingreso", "egreso", "transferencia", "desconocido"] },
          monto: { type: Type.NUMBER, nullable: true },
          moneda: { type: Type.STRING, nullable: true },
          fecha: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
          caja: { type: Type.STRING, nullable: true },
          caja_origen: { type: Type.STRING, nullable: true },
          caja_destino: { type: Type.STRING, nullable: true },
          categoria: { type: Type.STRING, nullable: true },
          subcategoria: { type: Type.STRING, nullable: true },
          descripcion: { type: Type.STRING },
          proveedor_cliente: { type: Type.STRING, nullable: true },
          confianza_ia: { type: Type.NUMBER },
          requiere_revision: { type: Type.BOOLEAN },
          razones_revision: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: [
          "tipo",
          "monto",
          "moneda",
          "fecha",
          "caja",
          "caja_origen",
          "caja_destino",
          "categoria",
          "subcategoria",
          "descripcion",
          "proveedor_cliente",
          "confianza_ia",
          "requiere_revision",
          "razones_revision",
        ],
      },
    },
  });

  return JSON.parse(response.text || "{}");
}
