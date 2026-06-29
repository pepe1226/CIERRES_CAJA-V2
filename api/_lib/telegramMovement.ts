import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";

type GeminiTipo = "ingreso" | "egreso" | "transferencia" | "desconocido";
type AppMovementType = "inflow" | "outflow" | "transfer" | "internal_transfer";
type CajaId = "safe" | "transit" | "bank";

const ACTIVE_BUSINESS_YEAR = 2026;

export type TelegramFinancialExtraction = {
  tipo: GeminiTipo;
  monto: number | null;
  venta_sistema?: number | null;
  cuadre_sistema?: number | null;
  sistema?: number | null;
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

function env(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

export function getTelegramConfig() {
  return {
    telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
    telegramPerseoBotToken: env("TELEGRAM_PERSEO_BOT_TOKEN"),
    telegramSecretToken: env("TELEGRAM_SECRET_TOKEN"),
    telegramPerseoSecretToken: env("TELEGRAM_PERSEO_SECRET_TOKEN"),
    telegramAllowedChatId: env("TELEGRAM_ALLOWED_CHAT_ID"),
    telegramCreatedByUid: env("TELEGRAM_CREATED_BY_UID", "telegram-bot"),
    geminiApiKey: env("GEMINI_API_KEY"),
    geminiModel: env("GEMINI_MODEL", "gemini-2.5-flash"),
  };
}

export function getTelegramStatus() {
  const config = getTelegramConfig();

  return {
    configured: Boolean(
      config.telegramBotToken &&
        config.telegramSecretToken &&
        config.geminiApiKey
    ),
    hasTelegramBotToken: Boolean(config.telegramBotToken),
    hasTelegramPerseoBotToken: Boolean(config.telegramPerseoBotToken),
    hasTelegramSecretToken: Boolean(config.telegramSecretToken),
    hasTelegramPerseoSecretToken: Boolean(config.telegramPerseoSecretToken),
    hasGeminiApiKey: Boolean(config.geminiApiKey),
    geminiModel: config.geminiModel,
    allowedChatId: config.telegramAllowedChatId || null,
    telegramCreatedByUid: config.telegramCreatedByUid,
  };
}

async function telegramApi<T>(
  method: string,
  payload: Record<string, unknown>,
  botToken = getTelegramConfig().telegramBotToken
): Promise<T> {
  if (!botToken) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN en Vercel.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} error: ${JSON.stringify(data)}`);
  }

  return data as T;
}

export async function sendTelegramMessage(chatId: number | string, text: string, botToken?: string) {
  try {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }, botToken);
  } catch (error) {
    console.error("No se pudo responder en Telegram:", error);
  }
}

export async function downloadTelegramPhoto(fileId: string, botToken?: string) {
  const fileInfo = await telegramApi<{
    ok: true;
    result: { file_path: string };
  }>("getFile", {
    file_id: fileId,
  }, botToken);

  const telegramFilePath = fileInfo.result.file_path;
  const token = botToken || getTelegramConfig().telegramBotToken;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${telegramFilePath}`;
  const imageResponse = await fetch(fileUrl);

  if (!imageResponse.ok) {
    throw new Error(
      `No se pudo descargar la imagen de Telegram: ${imageResponse.status}`
    );
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  const contentType = imageResponse.headers.get("content-type") || "";

  let mimeType = contentType.split(";")[0].trim().toLowerCase();

  if (
    !mimeType ||
    mimeType === "application/octet-stream" ||
    !mimeType.startsWith("image/")
  ) {
    const lowerPath = telegramFilePath.toLowerCase();

    if (lowerPath.endsWith(".png")) {
      mimeType = "image/png";
    } else if (lowerPath.endsWith(".webp")) {
      mimeType = "image/webp";
    } else if (lowerPath.endsWith(".pdf")) {
      mimeType = "application/pdf";
    } else if (lowerPath.endsWith(".csv")) {
      mimeType = "text/csv";
    } else if (lowerPath.endsWith(".txt")) {
      mimeType = "text/plain";
    } else {
      mimeType = "image/jpeg";
    }
  }

  return {
    imageBuffer: Buffer.from(arrayBuffer),
    mimeType,
    telegramFilePath,
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

function mapTipoToMovementType(
  extraction: TelegramFinancialExtraction
): AppMovementType {
  if (extraction.tipo === "ingreso") return "inflow";
  if (extraction.tipo === "egreso") return "outflow";

  if (extraction.tipo === "transferencia") {
    const destination = normalizeCaja(
      extraction.caja_destino || extraction.caja
    );
    return destination === "bank" ? "transfer" : "internal_transfer";
  }

  return "outflow";
}

function isValidDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function getFallbackDateParts(fallbackDate: Date) {
  return {
    year: ACTIVE_BUSINESS_YEAR,
    month: fallbackDate.getUTCMonth() + 1,
    day: fallbackDate.getUTCDate(),
  };
}

function toBusinessDate(year: number, month: number, day: number, fallbackDate: Date) {
  let normalizedYear = year;

  if (normalizedYear < 100) normalizedYear += 2000;
  if (normalizedYear !== ACTIVE_BUSINESS_YEAR) {
    normalizedYear = ACTIVE_BUSINESS_YEAR;
  }

  if (!isValidDateParts(normalizedYear, month, day)) {
    return null;
  }

  return new Date(Date.UTC(normalizedYear, month - 1, day, 12, 0, 0));
}

function parseBusinessDate(value: string | null, fallbackDate: Date): Date {
  if (!value) {
    return fallbackDate;
  }

  const text = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/[.]/g, "-");

  const fallback = getFallbackDateParts(fallbackDate);

  const dayOnlyMatch = text.match(/^(\d{1,2})$/);

  if (dayOnlyMatch) {
    const parsed = toBusinessDate(fallback.year, fallback.month, Number(dayOnlyMatch[1]), fallbackDate);

    return parsed || fallbackDate;
  }

  const dayMonthMatch = text.match(/^(\d{1,2})[-/](\d{1,2})$/);

  if (dayMonthMatch) {
    const parsed = toBusinessDate(fallback.year, Number(dayMonthMatch[2]), Number(dayMonthMatch[1]), fallbackDate);

    return parsed || fallbackDate;
  }

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);

    return toBusinessDate(year, month, day, fallbackDate) || fallbackDate;
  }

  const shortDateMatch = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);

  if (shortDateMatch) {
    const day = Number(shortDateMatch[1]);
    const month = Number(shortDateMatch[2]);
    const year = Number(shortDateMatch[3]);

    return toBusinessDate(year, month, day, fallbackDate) || fallbackDate;
  }

  if (/^\d+$/.test(text)) {
    return fallbackDate;
  }

  const parsed = new Date(value);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return fallbackDate;
}

export function buildMovementFromExtraction(
  extraction: TelegramFinancialExtraction,
  fallbackDate: Date
) {
  const { telegramCreatedByUid } = getTelegramConfig();

  const type = mapTipoToMovementType(extraction);

  const caja = normalizeCaja(extraction.caja) || "safe";
  const cajaOrigen = normalizeCaja(extraction.caja_origen) || caja;
  const cajaDestino = normalizeCaja(extraction.caja_destino);

  const movementDate = parseBusinessDate(extraction.fecha, fallbackDate);

  const amount =
    typeof extraction.monto === "number" && Number.isFinite(extraction.monto)
      ? Math.max(0, extraction.monto)
      : 0;

  const confidence = Number(extraction.confianza_ia || 0);

  const hasValidAmount = amount > 0;

  const hasValidDate =
    typeof extraction.fecha === "string" &&
    extraction.fecha.trim().length > 0 &&
    !Number.isNaN(movementDate.getTime());

  const hasResponsible = Boolean(
    extraction.proveedor_cliente || extraction.descripcion
  );

  const isSimpleCashBagRecord =
    hasValidAmount && hasValidDate && hasResponsible && type === "inflow";

  const hardReviewReasons = Array.isArray(extraction.razones_revision)
    ? extraction.razones_revision.filter((reason: string) => {
        const lower = reason.toLowerCase();

        if (lower.includes("fecha ambigua")) return false;
        if (lower.includes("año de dos dígitos")) return false;
        if (lower.includes("ano de dos digitos")) return false;
        if (lower.includes("tipo de transacción inferido")) return false;
        if (lower.includes("tipo de transaccion inferido")) return false;
        if (lower.includes("recuento")) return false;
        if (lower.includes("transferencia interna")) return false;
        if (lower.includes("falta especificar caja")) return false;
        if (lower.includes("falta caja")) return false;
        if (lower.includes("falta categoría")) return false;
        if (lower.includes("falta categoria")) return false;
        if (lower.includes("subcategoría")) return false;
        if (lower.includes("subcategoria")) return false;

        return true;
      })
    : [];

  const requiresReview = isSimpleCashBagRecord
    ? false
    : !hasValidAmount ||
      extraction.tipo === "desconocido" ||
      confidence < 0.6 ||
      hardReviewReasons.length > 0;

  let from: CajaId | null = null;
  let to: CajaId | null = null;

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

  const category = extraction.categoria || "Cierre de caja";

  const descriptionBase =
    extraction.descripcion ||
    `Registro de caja ${extraction.proveedor_cliente || ""}`.trim() ||
    "MOVIMIENTO DESDE FOTO";

  const descriptionPrefix = requiresReview
    ? "[REVISAR TELEGRAM] "
    : "[TELEGRAM] ";

  const description = `${descriptionPrefix}${descriptionBase}`
    .trim()
    .toUpperCase()
    .slice(0, 500);

  return {
    date: Timestamp.fromDate(movementDate),
    type,
    amount,
    description,
    createdBy: telegramCreatedByUid,
    category,
    subcategory: extraction.subcategoria || null,
    from,
    to,
    createdAt: FieldValue.serverTimestamp(),
    source: "telegram",
    telegramProvider: "vercel",
    telegramRequiresReview: requiresReview,
    telegramConfidence: confidence,
    telegramReviewReasons: requiresReview ? hardReviewReasons : [],
    telegramRawExtraction: {
      ...extraction,
      requiere_revision: requiresReview,
      razones_revision: requiresReview ? hardReviewReasons : [],
    },
  };
}


function getErrorMessage(error: any) {
  if (!error) return "Error desconocido";

  if (typeof error === "string") return error;

  const parts = [
    error.message,
    error.status,
    error.code,
    error.name,
    error.cause?.message,
  ]
    .filter(Boolean)
    .map((part) => String(part));

  return parts.join(" | ") || JSON.stringify(error);
}

export function isTemporaryGeminiError(error: any) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("429") ||
    message.includes("unavailable") ||
    message.includes("resource_exhausted") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("overload") ||
    message.includes("overloaded") ||
    message.includes("high demand") ||
    message.includes("temporarily") ||
    message.includes("timeout") ||
    message.includes("deadline")
  );
}

export function getFriendlyGeminiErrorMessage(error: any) {
  if (isTemporaryGeminiError(error)) {
    return "La IA está ocupada temporalmente. Guardé la foto como pendiente y el sistema intentará procesarla nuevamente.";
  }

  const message = getErrorMessage(error);

  if (message.includes("GEMINI_API_KEY")) {
    return "No pude procesar la foto porque falta configurar la clave de Gemini en Vercel.";
  }

  return "No pude procesar la foto automáticamente. La foto quedó pendiente para revisión o reintento.";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function extractFinancialDataFromImage(params: {
  imageBuffer: Buffer;
  mimeType: string;
  caption?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
}): Promise<TelegramFinancialExtraction> {
  const maxAttempts = Math.max(1, params.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, params.baseDelayMs ?? 1500);
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await extractFinancialDataFromImageOnce(params);
    } catch (error) {
      lastError = error;
      const temporary = isTemporaryGeminiError(error);

      console.error(
        `Gemini falló en intento ${attempt}/${maxAttempts}:`,
        getErrorMessage(error)
      );

      if (!temporary || attempt >= maxAttempts) {
        break;
      }

      await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError;
}

async function extractFinancialDataFromImageOnce(params: {
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
Eres un asistente para registrar cierres de caja desde fotos enviadas por Telegram.

Regla principal:
La mayoría de imágenes tendrán solamente:
- fecha escrita a mano
- valor o monto fisico de la funda
- venta sistema, venta total o total vendido si aparece
- cuadre sistema, saldo sistema o sistema si aparece
- responsable o nombre de persona

Ejemplo:
03-05-26
$45.15
ESQ Yulexi

En estos casos:
- El anio operativo del sistema es 2026.
- Interpretar la fecha como DD-MM-YY.
- 03-05-26 significa 2026-05-03.
- Si solo ves un dia, por ejemplo "26", interpretalo como dia del mes del mensaje de Telegram y anio 2026.
- Si ves dia y mes sin anio, por ejemplo "26/06", usa el anio 2026.
- Nunca uses 26 como anio 0026 ni intercambies dia y anio.
- El monto es el valor escrito junto al símbolo $.
- El responsable/cajero es el nombre escrito en la etiqueta, normalmente despues de ESQ, Responsable, Sr. o Sra.
- Coloca el responsable/cajero en proveedor_cliente, no solo en descripcion.
- El tipo debe ser "ingreso".
- La caja debe ser "Principal".
- La categoría debe ser "Cierre de caja".
- Si fecha, monto y responsable están presentes, requiere_revision debe ser false.
- No marcar como pendiente solo porque falte subcategoría.
- No marcar como pendiente solo porque la fecha tenga año de dos dígitos.
- No marcar como pendiente solo porque la caja se infiere como Principal.
- No marcar como pendiente solo porque la categoría se infiere como Cierre de caja.

Devuelve solo JSON válido.

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
          tipo: {
            type: Type.STRING,
            enum: ["ingreso", "egreso", "transferencia", "desconocido"],
          },
          monto: { type: Type.NUMBER, nullable: true },
          venta_sistema: { type: Type.NUMBER, nullable: true },
          cuadre_sistema: { type: Type.NUMBER, nullable: true },
          sistema: { type: Type.NUMBER, nullable: true },
          moneda: { type: Type.STRING, nullable: true },
          fecha: {
            type: Type.STRING,
            nullable: true,
            description: "YYYY-MM-DD",
          },
          caja: { type: Type.STRING, nullable: true },
          caja_origen: { type: Type.STRING, nullable: true },
          caja_destino: { type: Type.STRING, nullable: true },
          categoria: { type: Type.STRING, nullable: true },
          subcategoria: { type: Type.STRING, nullable: true },
          descripcion: { type: Type.STRING },
          proveedor_cliente: { type: Type.STRING, nullable: true },
          confianza_ia: { type: Type.NUMBER },
          requiere_revision: { type: Type.BOOLEAN },
          razones_revision: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          "tipo",
          "monto",
          "venta_sistema",
          "cuadre_sistema",
          "sistema",
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
