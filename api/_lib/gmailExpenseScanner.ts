import { createHash } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  getTelegramConfig,
  sendTelegramMessage,
} from "./telegramMovement.js";
import { extractExpenseFromImage } from "./expenseImageOcr.js";
import {
  findExpenseMemorySuggestion,
  learnExpenseMemory,
} from "./expenseMemory.js";

type CajaId = "safe" | "transit" | "bank" | "personal";

type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: any;
};

type ParsedBankExpense = {
  messageId: string;
  threadId: string | null;
  emailDate: Date;
  subject: string;
  from: string;
  amount: number;
  movementKind: "expense" | "transfer";
  description: string;
  category: string;
  subcategory: string;
  tags: string[];
  rawText: string;
  merchant?: string | null;
  destinationBank?: string | null;
  sourceAccount?: string | null;
  destinationAccount?: string | null;
  memoryKeyword?: string | null;
};

type GmailDiagnostic = {
  reason: string;
  subject: string;
  from: string;
  snippet: string;
  amounts: number[];
  imageParts?: number;
};

type GmailScanResult = {
  ok: true;
  query: string;
  checked: number;
  created: number;
  notified: number;
  resent: number;
  pendingNotified: number;
  skippedByReason: Record<string, number>;
  diagnostics: GmailDiagnostic[];
  results: any[];
};

const GMAIL_CATEGORY_OPTIONS = [
  { key: "proveedor", label: "Proveedor", category: "Proveedor", subcategory: "COMPRAS", tags: ["PROVEEDOR", "COMPRAS", "BANCO", "PICHINCHA"] },
  { key: "servicios", label: "Servicios", category: "Servicios", subcategory: "FIJOS", tags: ["SERVICIOS", "FIJO", "BANCO", "PICHINCHA"] },
  { key: "combustible", label: "Combustible", category: "Combustible", subcategory: "MOVILIZACION", tags: ["COMBUSTIBLE", "MOVILIZACION", "BANCO", "PICHINCHA"] },
  { key: "transporte", label: "Transporte", category: "Transporte", subcategory: "MOVILIZACION", tags: ["TRANSPORTE", "MOVILIZACION", "BANCO", "PICHINCHA"] },
  { key: "alimentacion", label: "Alimentacion", category: "Alimentacion", subcategory: "COMIDAS", tags: ["ALIMENTACION", "COMIDAS", "BANCO", "PICHINCHA"] },
  { key: "personal", label: "Personal negocio", category: "Personal", subcategory: "ANTICIPO", tags: ["EMPLEADOS", "ANTICIPO", "BANCO", "PICHINCHA"] },
  { key: "otros", label: "Otro gasto", category: "Otros", subcategory: "GENERAL", tags: ["BANCO", "PICHINCHA", "SIN CLASIFICAR"] },
];

function env(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

export function getGmailExpenseStatus() {
  return {
    hasGmailClientId: Boolean(env("GMAIL_CLIENT_ID")),
    hasGmailClientSecret: Boolean(env("GMAIL_CLIENT_SECRET")),
    hasGmailRefreshToken: Boolean(env("GMAIL_REFRESH_TOKEN")),
    hasGmailExpenseTelegramChatId: Boolean(env("GMAIL_EXPENSE_TELEGRAM_CHAT_ID")),
    gmailExpenseQuery: getGmailQuery(),
  };
}

function getGmailQuery() {
  return env(
    "GMAIL_EXPENSE_QUERY",
    'newer_than:30d (from:pichincha OR subject:(pichincha OR "banco pichincha" OR notificacion OR transaccion OR transferencia OR compra OR consumo))'
  );
}

function isAuthorized(req: any) {
  const expectedSecret = (
    process.env.GMAIL_SCAN_SECRET ||
    process.env.CRON_SECRET ||
    getTelegramConfig().telegramSecretToken ||
    ""
  ).trim();
  if (!expectedSecret) return false;

  const authHeader = String(req.headers?.authorization || "");
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const headerSecret = req.headers?.["x-cron-secret"] || req.headers?.["x-gmail-secret"];

  return bearerToken === expectedSecret || String(headerSecret || "") === expectedSecret;
}

export function isGmailScanAuthorized(req: any) {
  return isAuthorized(req);
}

async function getGmailAccessToken() {
  const clientId = env("GMAIL_CLIENT_ID");
  const clientSecret = env("GMAIL_CLIENT_SECRET");
  const refreshToken = env("GMAIL_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Faltan GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET o GMAIL_REFRESH_TOKEN.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`No pude renovar acceso Gmail: ${JSON.stringify(data)}`);
  }

  return String(data.access_token);
}

async function gmailApi<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gmail API error: ${JSON.stringify(data)}`);
  }

  return data as T;
}

function candidateIdForMessage(messageId: string) {
  return `gm_${createHash("sha1").update(messageId).digest("hex").slice(0, 24)}`;
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function decodeBase64UrlBuffer(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function getHeader(message: GmailMessage, name: string) {
  const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
  const found = headers.find((header: any) => String(header.name || "").toLowerCase() === name.toLowerCase());
  return String(found?.value || "");
}

function collectBodyParts(part: any, output: string[] = []) {
  if (!part) return output;

  if (part.body?.data && String(part.mimeType || "").startsWith("text/")) {
    output.push(decodeBase64Url(String(part.body.data)));
  }

  if (Array.isArray(part.parts)) {
    part.parts.forEach((child: any) => collectBodyParts(child, output));
  }

  return output;
}

function collectImageParts(part: any, output: any[] = []) {
  if (!part) return output;

  const mimeType = String(part.mimeType || "").toLowerCase();
  const size = Number(part.body?.size || 0);
  if (mimeType.startsWith("image/") && size >= 4000) {
    output.push(part);
  }

  if (Array.isArray(part.parts)) {
    part.parts.forEach((child: any) => collectImageParts(child, output));
  }

  return output;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s.,:$/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(value: unknown) {
  const text = String(value ?? "").replace(/\s/g, "");
  const match = text.match(/(?:usd|\$)?(-?\d{1,6}(?:[.,]\d{1,2})?)/i);
  if (!match) return 0;

  const rawNumber = match[1];
  const plainDigits = rawNumber.replace(/[.,].*$/, "");
  if (!/[.,]/.test(rawNumber) && plainDigits.length === 4) {
    const maybeYear = Number(plainDigits);
    if (maybeYear >= 1900 && maybeYear <= 2099) {
      return 0;
    }
  }

  const amount = Number(match[1].replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0;
}

function findAmounts(text: string) {
  const currencyMatches = Array.from(text.matchAll(/(?:usd|\$)\s*(\d{1,6}(?:[.,]\d{1,2})?)/gi));
  const trailingCurrencyMatches = Array.from(text.matchAll(/\b(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:usd|\$)\b/gi));
  const labelMatches = Array.from(
    text.matchAll(/\b(?:valor|monto|importe|total|compra|consumo|debito|d[eé]bito|retiro|transferencia|pago)\b\s*:?\s*(?:usd|\$)?\s*(\d{1,6}(?:[.,]\d{1,2})?)/gi)
  );
  const matches = [...currencyMatches, ...trailingCurrencyMatches, ...labelMatches];
  return matches
    .map((match) => parseMoney(match[1]))
    .filter((amount) => amount > 0 && amount <= 10000)
    .sort((a, b) => b - a);
}

function extractField(rawText: string, labels: string[]) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(
    `(?:${escaped.join("|")})\\s*:?\\s*(.+?)(?=\\n\\s*(?:[A-Za-zÁÉÍÓÚÑa-z0-9][^\\n]{0,40}:)|$)`,
    "i"
  );
  const match = rawText.match(regex);
  return match?.[1]?.replace(/\s+/g, " ").trim() || "";
}

function looksInformationalBankMail(normalized: string) {
  return (
    /\b(credito digital|cr[eé]dito digital|cuota de tu credito|cuota de tu cr[eé]dito|estas al dia|est[aá]s al d[ií]a|reconocemos tu esfuerzo|gracias maria|gracias por cumplir)\b/.test(normalized) ||
    (/\b(credito|cr[eé]dito|prestamo|pr[eé]stamo)\b/.test(normalized) &&
      /\b(cuota|mensual|debito con exito|d[eé]bito con [eé]xito)\b/.test(normalized))
  );
}

function inferBankMovement(rawText: string) {
  const normalized = normalizeText(rawText);
  const hasTransferSignal =
    /\b(transferencia solicitada|transferencia exitosa|realizaste una transferencia|enviaste una transferencia|cuenta acreditada|banco destino|nombre del beneficiario|beneficiario|cuenta de origen|cuenta destino)\b/.test(normalized);
  const hasExpenseSignal =
    /\b(compra|consumo|debito|transferencia|pago|retiro|transaccion|tarjeta|pagaste|realizaste|enviaste)\b/.test(normalized);
  const hasIncomeSignal =
    /\b(deposito|acreditacion|recibiste|recibido|ingreso|abono|te transfirieron)\b/.test(normalized);

  return {
    normalized,
    hasTransferSignal,
    hasExpenseSignal,
    hasIncomeSignal,
    looksInformationalOnly: looksInformationalBankMail(normalized),
  };
}

function suggestCategory(text: string) {
  const normalized = normalizeText(text);

  if (/\b(primax|terpel|gasolina|combustible|diesel|estacion de servicio)\b/.test(normalized)) {
    return { category: "Combustible", subcategory: "MOVILIZACION", tags: ["COMBUSTIBLE", "MOVILIZACION"] };
  }
  if (/\b(gasto personal|gastos personales|retiro personal|para mi|mio|personal mio|uso personal)\b/.test(normalized)) {
    return { category: "Gastos personales", subcategory: "GENERAL PERSONAL", tags: ["PERSONAL"] };
  }
  if (/\b(taxi|uber|transporte|peaje|parqueo)\b/.test(normalized)) {
    return { category: "Transporte", subcategory: "MOVILIZACION", tags: ["TRANSPORTE", "MOVILIZACION"] };
  }
  if (/\b(netlife|claro|cnt|internet|luz|agua|servicio)\b/.test(normalized)) {
    return { category: "Servicios", subcategory: "FIJOS", tags: ["SERVICIOS", "FIJO"] };
  }
  if (/\b(supermaxi|tia|mi comisariato|compra|proveedor|ferreteria)\b/.test(normalized)) {
    return { category: "Proveedor", subcategory: "COMPRAS", tags: ["PROVEEDOR", "COMPRAS"] };
  }
  if (/\b(encebollado|cebiche|ceviche|almuerzo|merienda|desayuno|comida|cafe|bolon|tigrillo|chaulafan|seco|guatita|empanada|cola|gaseosa|jugo|snack)\b/.test(normalized)) {
    return { category: "Alimentacion", subcategory: "COMIDAS", tags: ["ALIMENTACION", "COMIDAS"] };
  }

  return { category: "Otros", subcategory: "GENERAL", tags: ["BANCO", "PICHINCHA"] };
}

function suggestCategoryForBankMovement(rawText: string, movementKind: "expense" | "transfer", merchant = "") {
  const combined = [rawText, merchant].filter(Boolean).join("\n");
  const base = suggestCategory(combined);

  if (movementKind === "transfer" && base.category === "Otros") {
    return {
      category: "Proveedor",
      subcategory: "COMPRAS",
      tags: ["PROVEEDOR", "TRANSFERENCIA", "BANCO", "PICHINCHA"],
    };
  }

  if (movementKind === "transfer") {
    return {
      ...base,
      tags: Array.from(new Set([...(base.tags || []), "TRANSFERENCIA", "BANCO", "PICHINCHA"])).slice(0, 8),
    };
  }

  return base;
}

function analyzePichinchaExpense(message: GmailMessage): { expense: ParsedBankExpense | null; diagnostic: GmailDiagnostic } {
  const subject = getHeader(message, "Subject");
  const from = getHeader(message, "From");
  const body = collectBodyParts(message.payload).join("\n");
  const rawText = [subject, from, message.snippet || "", body].join("\n").slice(0, 8000);
  const normalized = normalizeText(rawText);
  const headerText = normalizeText([subject, from].join("\n"));
  const amounts = findAmounts(rawText);
  const diagnostic: GmailDiagnostic = {
    reason: "parsed",
    subject: subject.slice(0, 90),
    from: from.slice(0, 70),
    snippet: String(message.snippet || "").replace(/\s+/g, " ").slice(0, 120),
    amounts: amounts.slice(0, 5),
  };

  const hasPichinchaSignal =
    /\b(pichincha|banco pichincha)\b/.test(headerText) ||
    /pichincha/i.test(from) ||
    /pichincha/i.test(subject);

  if (!hasPichinchaSignal) {
    return { expense: null, diagnostic: { ...diagnostic, reason: "no_pichincha" } };
  }

  const amount = amounts[0] || 0;
  if (amount <= 0) {
    return { expense: null, diagnostic: { ...diagnostic, reason: "sin_monto" } };
  }

  const movement = inferBankMovement(rawText);
  const beneficiary =
    extractField(rawText, ["Nombre del beneficiario", "Beneficiario", "Cuenta destino", "Destino"]) ||
    "";
  const destinationBank = extractField(rawText, ["Banco destino", "Banco beneficiario"]) || "";
  const sourceAccount = extractField(rawText, ["Cuenta de origen", "Cuenta origen"]) || "";
  const destinationAccount = extractField(rawText, ["Cuenta acreditada", "Cuenta destino", "Cuenta beneficiario"]) || "";
  const merchant = beneficiary || destinationBank || null;
  const movementKind: "expense" | "transfer" = movement.hasTransferSignal ? "transfer" : "expense";

  if (movement.looksInformationalOnly && !movement.hasTransferSignal) {
    return { expense: null, diagnostic: { ...diagnostic, reason: "informativo" } };
  }

  if (movement.hasIncomeSignal && !movement.hasExpenseSignal && !movement.hasTransferSignal) {
    return { expense: null, diagnostic: { ...diagnostic, reason: "parece_ingreso" } };
  }

  if (!movement.hasExpenseSignal && !movement.hasTransferSignal) {
    return { expense: null, diagnostic: { ...diagnostic, reason: "sin_senal_gasto" } };
  }

  const category = suggestCategoryForBankMovement(rawText, movementKind, merchant || "");
  const emailDate = message.internalDate
    ? new Date(Number(message.internalDate))
    : new Date(getHeader(message, "Date") || Date.now());

  const description = [
    "Pichincha",
    movementKind === "transfer" ? "transferencia" : "egreso bancario",
    merchant || subject || "transaccion bancaria",
    (message.snippet || "").replace(/\s+/g, " ").slice(0, 140),
    movement.hasExpenseSignal || movement.hasTransferSignal ? "" : "REVISAR: detectado por monto en correo Pichincha",
  ].filter(Boolean).join(" - ").slice(0, 240);

  return {
    expense: {
      messageId: message.id,
      threadId: message.threadId || null,
      emailDate,
      subject,
      from,
      amount,
      movementKind,
      description,
      category: category.category,
      subcategory: category.subcategory,
      tags: category.tags,
      rawText: rawText.slice(0, 3000),
      merchant,
      destinationBank: destinationBank || null,
      sourceAccount: sourceAccount || null,
      destinationAccount: destinationAccount || null,
    },
    diagnostic,
  };
}

function parsePichinchaExpense(message: GmailMessage): ParsedBankExpense | null {
  return analyzePichinchaExpense(message).expense;
}

async function readGmailImagePart(params: {
  messageId: string;
  part: any;
  accessToken: string;
}) {
  const mimeType = String(params.part.mimeType || "image/jpeg").split(";")[0].trim().toLowerCase();
  const inlineData = params.part.body?.data ? String(params.part.body.data) : "";
  if (inlineData) {
    return { imageBuffer: decodeBase64UrlBuffer(inlineData), mimeType };
  }

  const attachmentId = params.part.body?.attachmentId ? String(params.part.body.attachmentId) : "";
  if (!attachmentId) return null;

  const attachment = await gmailApi<{ data?: string }>(
    `messages/${params.messageId}/attachments/${attachmentId}`,
    params.accessToken
  );
  if (!attachment.data) return null;

  return { imageBuffer: decodeBase64UrlBuffer(attachment.data), mimeType };
}

async function parsePichinchaExpenseFromImages(
  message: GmailMessage,
  accessToken: string
): Promise<{ expense: ParsedBankExpense | null; diagnostic: GmailDiagnostic }> {
  const subject = getHeader(message, "Subject");
  const from = getHeader(message, "From");
  const body = collectBodyParts(message.payload).join("\n");
  const contextText = [subject, from, message.snippet || "", body].join("\n").slice(0, 3000);
  const imageParts = collectImageParts(message.payload).slice(0, 6);
  const diagnostic: GmailDiagnostic = {
    reason: imageParts.length ? "ocr_sin_gasto" : "sin_monto_sin_imagen_ocr",
    subject: subject.slice(0, 90),
    from: from.slice(0, 70),
    snippet: String(message.snippet || "").replace(/\s+/g, " ").slice(0, 120),
    amounts: [],
    imageParts: imageParts.length,
  };

  for (const part of imageParts) {
    try {
      const image = await readGmailImagePart({ messageId: message.id, part, accessToken });
      if (!image) continue;

      const extraction = await extractExpenseFromImage({
        imageBuffer: image.imageBuffer,
        mimeType: image.mimeType,
        contextText,
      });

      const amount = Number(extraction.amount || 0);
      if (
        extraction.isFinancialMovement &&
        ["outflow", "transfer"].includes(extraction.movementType) &&
        amount > 0
      ) {
        const memorySuggestion = await findExpenseMemorySuggestion([
          extraction.merchant,
          extraction.destinationAccount,
          extraction.description,
          extraction.extractedText,
          contextText,
        ]);
        const ruleCategory = suggestCategory([contextText, extraction.extractedText, extraction.description].join("\n"));
        const category = memorySuggestion || ruleCategory;
        const emailDate = extraction.date
          ? new Date(`${extraction.date}T12:00:00-05:00`)
          : message.internalDate
            ? new Date(Number(message.internalDate))
            : new Date(getHeader(message, "Date") || Date.now());
        const merchant = extraction.merchant || "Banco Pichincha";
        const description = [
          "Pichincha OCR",
          merchant,
          extraction.description,
        ].filter(Boolean).join(" - ").slice(0, 240);

        return {
          expense: {
            messageId: message.id,
            threadId: message.threadId || null,
            emailDate: Number.isNaN(emailDate.getTime()) ? new Date() : emailDate,
            subject,
            from,
            amount: Number(amount.toFixed(2)),
            movementKind: extraction.movementType === "transfer" ? "transfer" : "expense",
            description,
            category: memorySuggestion ? memorySuggestion.category : extraction.category || category.category,
            subcategory: memorySuggestion ? memorySuggestion.subcategory : extraction.subcategory || category.subcategory,
            tags: Array.from(new Set([...(extraction.tags || []), ...category.tags, "OCR"])).slice(0, 8),
            rawText: [
              contextText,
              "OCR:",
              extraction.extractedText,
              extraction.reasons?.join("; ") || "",
            ].join("\n").slice(0, 3000),
            merchant,
            destinationBank: extraction.destinationAccount || null,
            sourceAccount: extraction.sourceAccount || null,
            destinationAccount: extraction.destinationAccount || null,
            memoryKeyword: memorySuggestion?.keyword || null,
          },
          diagnostic: {
            ...diagnostic,
            reason: "ocr_detectado",
            amounts: [Number(amount.toFixed(2))],
          },
        };
      }
    } catch (error) {
      console.error("No pude leer imagen Gmail con OCR:", error);
    }
  }

  return { expense: null, diagnostic };
}

async function movementAlreadyExists(expense: ParsedBankExpense) {
  const db = getFirebaseAdminDb();
  const start = new Date(expense.emailDate.getTime() - 36 * 60 * 60 * 1000);
  const end = new Date(expense.emailDate.getTime() + 36 * 60 * 60 * 1000);

  const snapshot = await db
    .collection("movements")
    .where("date", ">=", Timestamp.fromDate(start))
    .where("date", "<=", Timestamp.fromDate(end))
    .limit(80)
    .get();

  return snapshot.docs.some((doc) => {
    const data = doc.data();
    return data.type === "outflow" && Math.abs(Number(data.amount || 0) - expense.amount) <= 0.01;
  });
}

async function getNotificationChatId(preferredChatId?: number | string) {
  if (preferredChatId) return String(preferredChatId);

  const configured = env("GMAIL_EXPENSE_TELEGRAM_CHAT_ID");
  if (configured) return configured;

  const db = getFirebaseAdminDb();
  const settings = await db.collection("gmail_expense_settings").doc("default").get();
  const savedChatId = settings.data()?.telegramChatId;
  if (savedChatId) return String(savedChatId);

  const snapshot = await db
    .collection("telegram_expense_drafts")
    .orderBy("updatedAt", "desc")
    .limit(1)
    .get();

  return snapshot.docs[0]?.data()?.chatId ? String(snapshot.docs[0].data().chatId) : "";
}

function candidateTelegramText(candidateId: string, candidate: any) {
  const isKnownBusinessExpense = candidate.category && candidate.category !== "Otros";
  return [
    candidate.movementKind === "transfer"
      ? "Posible transferencia/salida bancaria no registrada."
      : "Posible gasto no registrado.",
    `Fecha: ${candidate.emailDateText}`,
    `Valor: USD ${Number(candidate.amount || 0).toFixed(2)}`,
    candidate.merchant ? `Beneficiario: ${candidate.merchant}` : "",
    candidate.destinationBank ? `Banco destino: ${candidate.destinationBank}` : "",
    candidate.destinationAccount ? `Cuenta destino: ${candidate.destinationAccount}` : "",
    `Categoria sugerida: ${candidate.category || "Otros"}`,
    `Descripcion: ${candidate.description}`,
    candidate.duplicateMovement ? "Aviso: existe un movimiento parecido. Revisa antes de registrar." : "",
    candidate.memoryKeyword ? `Memoria: asociada con "${candidate.memoryKeyword}"` : "",
    `Origen: Gmail / Banco Pichincha`,
    "",
    isKnownBusinessExpense
      ? "Confirmame si es un gasto conocido del negocio o si en realidad fue personal."
      : "No la doy por clasificada todavia. Elige si es un gasto del negocio, clasificalo o marcalo como personal.",
    "",
    `Candidato: ${candidateId}`,
  ].filter(Boolean).join("\n");
}

function candidateKeyboard(candidateId: string, candidate: any) {
  const suggestedCategory = GMAIL_CATEGORY_OPTIONS.find((item) => item.category === String(candidate.category || ""));
  if (suggestedCategory && suggestedCategory.category !== "Otros") {
    return {
      inline_keyboard: [
        [
          { text: `Negocio: ${suggestedCategory.label}`, callback_data: `gmail:categorize:${candidateId}:${suggestedCategory.key}` },
          { text: "Es personal", callback_data: `gmail:register:${candidateId}:personal` },
        ],
        [
          { text: "Cambiar categoria", callback_data: `gmail:categories:${candidateId}` },
          { text: "Ignorar", callback_data: `gmail:ignore:${candidateId}` },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        { text: "Clasificar negocio", callback_data: `gmail:categories:${candidateId}` },
        { text: "Es personal", callback_data: `gmail:register:${candidateId}:personal` },
      ],
      [
        { text: "Ignorar", callback_data: `gmail:ignore:${candidateId}` },
      ],
    ],
  };
}

function gmailCategoryKeyboard(candidateId: string) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < GMAIL_CATEGORY_OPTIONS.length; index += 2) {
    rows.push(
      GMAIL_CATEGORY_OPTIONS.slice(index, index + 2).map((item) => ({
        text: item.label,
        callback_data: `gmail:categorize:${candidateId}:${item.key}`,
      }))
    );
  }

  rows.push([
    { text: "Es personal", callback_data: `gmail:register:${candidateId}:personal` },
    { text: "Ignorar", callback_data: `gmail:ignore:${candidateId}` },
  ]);

  return { inline_keyboard: rows };
}

export function gmailScanKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Revisar mas correos", callback_data: "gmail:scanMore" },
        { text: "Ver pendientes", callback_data: "gmail:pending" },
      ],
      [
        { text: "Revision amplia Gmail", callback_data: "gmail:scanDeep" },
        { text: "Ayuda Gmail", callback_data: "gmail:help" },
      ],
    ],
  };
}

function gmailResultText(title: string, result: GmailScanResult) {
  const reasonText = Object.entries(result.skippedByReason || {})
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  const examples = (result.diagnostics || [])
    .slice(0, 5)
    .map((item) => {
      const amountText = item.amounts?.length ? ` | montos: ${item.amounts.join(", ")}` : "";
      const imageText = item.imageParts ? ` | imagenes OCR: ${item.imageParts}` : "";
      return `- ${item.reason}: ${item.subject || item.from || "correo sin asunto"}${amountText}${imageText}`;
    });

  return [
    title,
    `Correos revisados: ${result.checked}`,
    `Candidatos nuevos: ${result.created}`,
    `Pendientes reenviados: ${result.resent + result.pendingNotified}`,
    `Avisos enviados: ${result.notified}`,
    result.created + result.resent + result.pendingNotified > 0
      ? "Te envie los movimientos detectados con botones."
      : "No encontre movimientos nuevos para confirmar.",
    reasonText ? `Motivos: ${reasonText}` : "",
    examples.length ? "Ejemplos revisados:" : "",
    ...examples,
  ].filter(Boolean).join("\n");
}

function gmailHelpText() {
  return [
    "Botones Gmail disponibles.",
    "",
    "Revisar mas correos: revisa los correos recientes de Pichincha.",
    "Revision amplia Gmail: revisa hasta 100 correos por si el movimiento no estaba entre los ultimos.",
    "Ver pendientes: reenvia movimientos detectados que aun no confirmaste.",
    "",
    "Si un correo de Pichincha viene solo como imagen remota y Gmail no entrega esa imagen al API, reenvia o captura ese comprobante al bot para leerlo por OCR.",
  ].join("\n");
}

async function saveCandidate(expense: ParsedBankExpense) {
  const db = getFirebaseAdminDb();
  const candidateId = candidateIdForMessage(expense.messageId);
  const ref = db.collection("gmail_expense_candidates").doc(candidateId);
  const existing = await ref.get();

  if (existing.exists) {
    const existingData = existing.data() || {};
    if (existingData.status === "matched_existing") {
      const updatedData = {
        ...existingData,
        status: "pending",
        previousStatus: "matched_existing",
        duplicateMovement: true,
        updatedAt: FieldValue.serverTimestamp(),
      };
      await ref.set(updatedData, { merge: true });
      return { candidateId, created: false, data: updatedData };
    }

    return { candidateId, created: false, data: existingData };
  }

  const duplicateMovement = await movementAlreadyExists(expense);
  const data = {
    status: "pending",
    source: "gmail",
    provider: "banco-pichincha",
    gmailMessageId: expense.messageId,
    gmailThreadId: expense.threadId,
    emailDate: Timestamp.fromDate(expense.emailDate),
    emailDateText: expense.emailDate.toISOString().slice(0, 10),
    subject: expense.subject,
    from: expense.from,
    amount: expense.amount,
    movementKind: expense.movementKind,
    description: expense.description,
    category: expense.category,
    subcategory: expense.subcategory,
    tags: expense.tags,
    rawText: expense.rawText,
    merchant: expense.merchant || null,
    destinationBank: expense.destinationBank || null,
    sourceAccount: expense.sourceAccount || null,
    destinationAccount: expense.destinationAccount || null,
    memoryKeyword: expense.memoryKeyword || null,
    duplicateMovement,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await ref.set(data);
  return { candidateId, created: true, data };
}

async function notifyCandidate(
  candidateId: string,
  candidate: any,
  botToken?: string,
  notificationChatId?: number | string
) {
  const chatId = await getNotificationChatId(notificationChatId);
  if (!chatId) {
    await getFirebaseAdminDb().collection("gmail_expense_candidates").doc(candidateId).set(
      {
        notificationStatus: "waiting_telegram_chat",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return false;
  }

  if (notificationChatId) {
    await getFirebaseAdminDb().collection("gmail_expense_settings").doc("default").set(
      {
        telegramChatId: String(notificationChatId),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  await sendTelegramMessage(chatId, candidateTelegramText(candidateId, candidate), botToken, {
    reply_markup: candidateKeyboard(candidateId, candidate),
  });

  await getFirebaseAdminDb().collection("gmail_expense_candidates").doc(candidateId).set(
    {
      notificationStatus: "sent",
      notifiedAt: FieldValue.serverTimestamp(),
      telegramChatId: String(chatId),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return true;
}

async function notifyPendingCandidates(params: {
  botToken?: string;
  notificationChatId?: number | string;
  excludeIds?: Set<string>;
  limit?: number;
}) {
  const db = getFirebaseAdminDb();
  const chatId = await getNotificationChatId(params.notificationChatId);
  if (!chatId) return 0;

  const snapshot = await db
    .collection("gmail_expense_candidates")
    .where("status", "==", "pending")
    .limit(Math.min(Math.max(params.limit || 5, 1), 10))
    .get();

  let count = 0;
  for (const doc of snapshot.docs) {
    if (params.excludeIds?.has(doc.id)) continue;
    await notifyCandidate(doc.id, doc.data(), params.botToken, chatId);
    count += 1;
  }

  return count;
}

async function createMovementFromCandidate(
  candidateId: string,
  from: CajaId,
  categoryOverride?: { category: string; subcategory: string; tags: string[] } | null
) {
  const db = getFirebaseAdminDb();
  const ref = db.collection("gmail_expense_candidates").doc(candidateId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("No encontre el gasto candidato.");

  const candidate = doc.data() || {};
  if (candidate.status === "registered") throw new Error("Este gasto ya fue registrado.");
  if (candidate.status === "ignored") throw new Error("Este gasto fue ignorado.");

  const amount = Number(candidate.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Monto invalido.");

  const emailDate = candidate.emailDate?.toDate ? candidate.emailDate.toDate() : new Date(candidate.emailDate);
  const movementRef = from === "personal"
    ? db.collection("personalMovements").doc()
    : db.collection("movements").doc();

  if (from === "personal") {
    const boxRef = db.collection("personalCashBoxes").doc("gmail-personal");
    const boxDoc = await boxRef.get();
    if (!boxDoc.exists) {
      await boxRef.set({
        name: "GMAIL PERSONAL",
        type: "bank",
        openingBalance: 0,
        color: "#2563EB",
        isActive: true,
        createdBy: "gmail-expense-scanner",
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    await movementRef.set({
      date: Timestamp.fromDate(Number.isNaN(emailDate.getTime()) ? new Date() : emailDate),
      type: "expense",
      amount,
      description: `[GMAIL PICHINCHA] ${String(candidate.description || "GASTO BANCARIO")}`.toUpperCase().slice(0, 500),
      createdBy: "gmail-expense-scanner",
      fromBoxId: boxRef.id,
      toBoxId: null,
      category: categoryOverride?.category || candidate.category || "Otros",
      tags: categoryOverride?.tags || (Array.isArray(candidate.tags) ? candidate.tags : ["BANCO", "PICHINCHA"]),
      source: "gmail",
      gmailProvider: "banco-pichincha",
      gmailCandidateId: candidateId,
      gmailMessageId: candidate.gmailMessageId || null,
      gmailThreadId: candidate.gmailThreadId || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    await ref.set(
      {
        status: "registered",
        movementId: movementRef.id,
        registeredFrom: from,
        registeredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { movementId: movementRef.id, candidate };
  }

  await movementRef.set({
    date: Timestamp.fromDate(Number.isNaN(emailDate.getTime()) ? new Date() : emailDate),
    type: "outflow",
    amount,
    description: `[GMAIL PICHINCHA] ${String(candidate.description || "GASTO BANCARIO")}`.toUpperCase().slice(0, 500),
    createdBy: "gmail-expense-scanner",
    from,
    to: null,
    category: categoryOverride?.category || candidate.category || "Otros",
    subcategory: categoryOverride?.subcategory || candidate.subcategory || null,
    tags: categoryOverride?.tags || (Array.isArray(candidate.tags) ? candidate.tags : ["BANCO", "PICHINCHA"]),
    source: "gmail",
    gmailProvider: "banco-pichincha",
    gmailCandidateId: candidateId,
    gmailMessageId: candidate.gmailMessageId || null,
    gmailThreadId: candidate.gmailThreadId || null,
    gmailRawExtraction: {
      subject: candidate.subject || null,
      from: candidate.from || null,
      rawText: candidate.rawText || null,
    },
    createdAt: FieldValue.serverTimestamp(),
  });

  await ref.set(
    {
      status: "registered",
      movementId: movementRef.id,
      registeredFrom: from,
      category: categoryOverride?.category || candidate.category || "Otros",
      subcategory: categoryOverride?.subcategory || candidate.subcategory || null,
      tags: categoryOverride?.tags || (Array.isArray(candidate.tags) ? candidate.tags : ["BANCO", "PICHINCHA"]),
      registeredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await learnExpenseMemory({
    keywords: [
      candidate.merchant,
      candidate.description,
      candidate.rawText,
      candidate.subject,
    ],
    category: categoryOverride?.category || candidate.category || "Otros",
    subcategory: categoryOverride?.subcategory || candidate.subcategory || "GENERAL",
    tags: categoryOverride?.tags || (Array.isArray(candidate.tags) ? candidate.tags : ["BANCO", "PICHINCHA"]),
    movementId: movementRef.id,
    source: "gmail",
  });

  return { movementId: movementRef.id, candidate };
}

export async function scanGmailForExpenses(params: {
  maxResults?: number;
  botToken?: string;
  notificationChatId?: number | string;
} = {}): Promise<GmailScanResult> {
  const accessToken = await getGmailAccessToken();
  const maxResults = Math.min(Math.max(params.maxResults || 10, 1), 100);
  const query = getGmailQuery();
  const list = await gmailApi<{ messages?: Array<{ id: string; threadId: string }> }>(
    `messages?${new URLSearchParams({ q: query, maxResults: String(maxResults) })}`,
    accessToken
  );

  const results: any[] = [];
  const diagnostics: GmailDiagnostic[] = [];
  const notifiedIds = new Set<string>();
  const skippedByReason: Record<string, number> = {};
  let createdCount = 0;
  let resent = 0;

  const addSkipped = (reason: string) => {
    skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
  };

  for (const item of list.messages || []) {
    const message = await gmailApi<GmailMessage>(
      `messages/${item.id}?${new URLSearchParams({ format: "full" })}`,
      accessToken
    );
    let analysis = analyzePichinchaExpense(message);
    let parsed = analysis.expense;

    if (!parsed && analysis.diagnostic.reason === "sin_monto") {
      const ocrAnalysis = await parsePichinchaExpenseFromImages(message, accessToken);
      if (ocrAnalysis.expense) {
        analysis = ocrAnalysis;
        parsed = ocrAnalysis.expense;
      } else if (ocrAnalysis.diagnostic.imageParts || ocrAnalysis.diagnostic.reason === "sin_monto_sin_imagen_ocr") {
        analysis = ocrAnalysis;
      }
    }

    if (!parsed) {
      addSkipped(analysis.diagnostic.reason);
      if (diagnostics.length < 5) diagnostics.push(analysis.diagnostic);
      results.push({ messageId: item.id, ok: true, skipped: true, reason: analysis.diagnostic.reason });
      continue;
    }

    const saved = await saveCandidate(parsed);
    if (!saved.created) {
      const savedData = saved.data as any;
      if (savedData.status === "pending" && (params.notificationChatId || savedData.notificationStatus !== "sent")) {
        const notified = await notifyCandidate(
          saved.candidateId,
          savedData,
          params.botToken,
          params.notificationChatId
        );
        if (notified) {
          notifiedIds.add(saved.candidateId);
          resent += 1;
        }
        results.push({ messageId: item.id, candidateId: saved.candidateId, ok: true, resent: notified });
        continue;
      }

      addSkipped("already-seen");
      results.push({ messageId: item.id, candidateId: saved.candidateId, ok: true, skipped: true, reason: "already-seen" });
      continue;
    }
    if (saved.data.status === "matched_existing") {
      addSkipped("already-registered");
      results.push({ messageId: item.id, candidateId: saved.candidateId, ok: true, skipped: true, reason: "already-registered" });
      continue;
    }
    createdCount += 1;

    const notified = await notifyCandidate(
      saved.candidateId,
      saved.data,
      params.botToken,
      params.notificationChatId
    );
    if (notified) notifiedIds.add(saved.candidateId);
    results.push({ messageId: item.id, candidateId: saved.candidateId, ok: true, notified });
  }

  const pendingNotified = params.notificationChatId
    ? await notifyPendingCandidates({
        botToken: params.botToken,
        notificationChatId: params.notificationChatId,
        excludeIds: notifiedIds,
        limit: 5,
      })
    : 0;

  return {
    ok: true,
    query,
    checked: list.messages?.length || 0,
    created: createdCount,
    notified: results.filter((result) => result.notified).length,
    resent,
    pendingNotified,
    skippedByReason,
    diagnostics,
    results,
  };
}

export async function processGmailExpenseCallback(params: {
  callbackQuery: any;
  botToken?: string;
}) {
  const data = String(params.callbackQuery.data || "");
  if (!data.startsWith("gmail:")) return { handled: false };

  const [, action, candidateId, value] = data.split(":");
  const chatId = params.callbackQuery.message?.chat?.id;
  const messageId = params.callbackQuery.message?.message_id;

  await answerTelegramCallbackQuery({
    callbackQueryId: params.callbackQuery.id,
    botToken: params.botToken,
  });

  if (action === "help") {
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: gmailHelpText(),
        botToken: params.botToken,
        extraPayload: { reply_markup: gmailScanKeyboard() },
      });
    }

    return { handled: true, gmailHelp: true };
  }

  if (action === "scanMore" || action === "scanDeep") {
    const config = getTelegramConfig();
    const result = await scanGmailForExpenses({
      maxResults: action === "scanDeep" ? 100 : 25,
      botToken: params.botToken || config.telegramExpenseBotToken || config.telegramBotToken,
      notificationChatId: chatId,
    });

    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: gmailResultText(
          action === "scanDeep" ? "Revision amplia Gmail completada." : "Revision Gmail completada.",
          result
        ),
        botToken: params.botToken,
        extraPayload: { reply_markup: gmailScanKeyboard() },
      });
    }

    return { handled: true, gmailScan: true, result };
  }

  if (action === "pending") {
    const pendingNotified = await notifyPendingCandidates({
      botToken: params.botToken,
      notificationChatId: chatId,
      limit: 10,
    });

    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: pendingNotified > 0
          ? `Te reenvie ${pendingNotified} gasto(s) pendiente(s) con botones.`
          : "No hay gastos pendientes de Gmail para confirmar.",
        botToken: params.botToken,
        extraPayload: { reply_markup: gmailScanKeyboard() },
      });
    }

    return { handled: true, pendingNotified };
  }

  if (action === "ignore") {
    await getFirebaseAdminDb().collection("gmail_expense_candidates").doc(candidateId).set(
      {
        status: "ignored",
        ignoredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: "Gasto de Gmail ignorado. No se registro movimiento.",
        botToken: params.botToken,
      });
    }

    return { handled: true, ignored: true, candidateId };
  }

  if (action === "categories") {
    const candidateDoc = await getFirebaseAdminDb().collection("gmail_expense_candidates").doc(candidateId).get();
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: candidateDoc.exists
          ? [
              "Clasifica este gasto del negocio antes de registrarlo.",
              `Valor: USD ${Number(candidateDoc.data()?.amount || 0).toFixed(2)}`,
              `Descripcion: ${String(candidateDoc.data()?.description || "GASTO BANCARIO")}`,
              "",
              "Si no es del negocio, toca 'Es personal'.",
            ].join("\n")
          : "No encontre este candidato de Gmail.",
        botToken: params.botToken,
        extraPayload: candidateDoc.exists ? { reply_markup: gmailCategoryKeyboard(candidateId) } : undefined,
      });
    }

    return { handled: true, categoryMenu: true, candidateId };
  }

  if (action === "categorize") {
    const selected = GMAIL_CATEGORY_OPTIONS.find((item) => item.key === value);
    if (!selected) {
      return { handled: true, ignored: true, reason: "Categoria Gmail no soportada" };
    }

    try {
      const created = await createMovementFromCandidate(candidateId, "bank", {
        category: selected.category,
        subcategory: selected.subcategory,
        tags: selected.tags,
      });

      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: [
            "Gasto de Gmail registrado.",
            `Monto: USD ${Number(created.candidate.amount || 0).toFixed(2)}`,
            "Caja: Banco",
            `Categoria: ${selected.category}`,
            `Subcategoria: ${selected.subcategory}`,
            `Movimiento: ${created.movementId}`,
          ].join("\n"),
          botToken: params.botToken,
        });
      }

      return { handled: true, registered: true, candidateId, movementId: created.movementId };
    } catch (error: any) {
      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: `No pude clasificar y registrar el gasto de Gmail: ${error?.message || String(error)}`,
          botToken: params.botToken,
          extraPayload: { reply_markup: gmailCategoryKeyboard(candidateId) },
        });
      }
      return { handled: true, registered: false, error: error?.message || String(error) };
    }
  }

  if (action === "register" && ["safe", "transit", "bank", "personal"].includes(value)) {
    try {
      const created = await createMovementFromCandidate(candidateId, value as CajaId);

      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: [
            "Gasto de Gmail registrado.",
            `Monto: USD ${Number(created.candidate.amount || 0).toFixed(2)}`,
            `Caja: ${value === "bank" ? "Banco" : value === "transit" ? "Transito" : value === "personal" ? "Caja Personal" : "Tienda"}`,
            `Categoria: ${created.candidate.category || "Otros"}`,
            `Movimiento: ${created.movementId}`,
          ].join("\n"),
          botToken: params.botToken,
        });
      }

      return { handled: true, registered: true, candidateId, movementId: created.movementId };
    } catch (error: any) {
      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: `No pude registrar el gasto de Gmail: ${error?.message || String(error)}`,
          botToken: params.botToken,
        });
      }
      return { handled: true, registered: false, error: error?.message || String(error) };
    }
  }

  return { handled: true, ignored: true };
}
