import { createHash } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  getTelegramConfig,
  sendTelegramMessage,
} from "./telegramMovement.js";

type CajaId = "safe" | "transit" | "bank";

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
  description: string;
  category: string;
  subcategory: string;
  tags: string[];
  rawText: string;
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
  results: any[];
};

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
    'newer_than:7d (pichincha OR "Banco Pichincha" OR "transaccion" OR "transferencia" OR "compra")'
  );
}

function isAuthorized(req: any) {
  const expectedSecret = (process.env.CRON_SECRET || getTelegramConfig().telegramSecretToken || "").trim();
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

  const amount = Number(match[1].replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0;
}

function findAmounts(text: string) {
  const currencyMatches = Array.from(text.matchAll(/(?:usd|\$)\s*(\d{1,6}(?:[.,]\d{1,2})?)/gi));
  const labelMatches = Array.from(
    text.matchAll(/\b(?:valor|monto|importe|total)\b\s*:?\s*(?:usd|\$)?\s*(\d{1,6}(?:[.,]\d{1,2})?)/gi)
  );
  const matches = [...currencyMatches, ...labelMatches];
  return matches
    .map((match) => parseMoney(match[1]))
    .filter((amount) => amount > 0)
    .sort((a, b) => b - a);
}

function suggestCategory(text: string) {
  const normalized = normalizeText(text);

  if (/\b(primax|terpel|gasolina|combustible|diesel|estacion de servicio)\b/.test(normalized)) {
    return { category: "Combustible", subcategory: "MOVILIZACION", tags: ["COMBUSTIBLE", "MOVILIZACION"] };
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

  return { category: "Otros", subcategory: "GENERAL", tags: ["BANCO", "PICHINCHA"] };
}

function parsePichinchaExpense(message: GmailMessage): ParsedBankExpense | null {
  const subject = getHeader(message, "Subject");
  const from = getHeader(message, "From");
  const body = collectBodyParts(message.payload).join("\n");
  const rawText = [subject, from, message.snippet || "", body].join("\n").slice(0, 8000);
  const normalized = normalizeText(rawText);

  if (!/\b(pichincha|banco pichincha)\b/.test(normalized)) return null;

  const looksLikeExpense =
    /\b(compra|consumo|debito|transferencia|pago|retiro|transaccion|tarjeta)\b/.test(normalized) &&
    !/\b(deposito|acreditacion|recibiste|ingreso)\b/.test(normalized);

  if (!looksLikeExpense) return null;

  const amounts = findAmounts(rawText);
  const amount = amounts[0] || 0;
  if (amount <= 0) return null;

  const category = suggestCategory(rawText);
  const emailDate = message.internalDate
    ? new Date(Number(message.internalDate))
    : new Date(getHeader(message, "Date") || Date.now());

  const description = [
    "Pichincha",
    subject || "transaccion bancaria",
    (message.snippet || "").replace(/\s+/g, " ").slice(0, 140),
  ].filter(Boolean).join(" - ").slice(0, 240);

  return {
    messageId: message.id,
    threadId: message.threadId || null,
    emailDate,
    subject,
    from,
    amount,
    description,
    category: category.category,
    subcategory: category.subcategory,
    tags: category.tags,
    rawText: rawText.slice(0, 3000),
  };
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
  return [
    "Posible gasto no registrado.",
    `Fecha: ${candidate.emailDateText}`,
    `Valor: USD ${Number(candidate.amount || 0).toFixed(2)}`,
    `Categoria sugerida: ${candidate.category || "Otros"}`,
    `Descripcion: ${candidate.description}`,
    `Origen: Gmail / Banco Pichincha`,
    "",
    `Candidato: ${candidateId}`,
  ].join("\n");
}

function candidateKeyboard(candidateId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Registrar Banco", callback_data: `gmail:register:${candidateId}:bank` },
        { text: "Registrar Tienda", callback_data: `gmail:register:${candidateId}:safe` },
      ],
      [
        { text: "Transito", callback_data: `gmail:register:${candidateId}:transit` },
        { text: "Ignorar", callback_data: `gmail:ignore:${candidateId}` },
      ],
    ],
  };
}

export function gmailScanKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Revisar mas correos", callback_data: "gmail:scanMore" },
        { text: "Ver pendientes", callback_data: "gmail:pending" },
      ],
    ],
  };
}

async function saveCandidate(expense: ParsedBankExpense) {
  const db = getFirebaseAdminDb();
  const candidateId = candidateIdForMessage(expense.messageId);
  const ref = db.collection("gmail_expense_candidates").doc(candidateId);
  const existing = await ref.get();

  if (existing.exists) {
    return { candidateId, created: false, data: existing.data() || {} };
  }

  const duplicateMovement = await movementAlreadyExists(expense);
  const data = {
    status: duplicateMovement ? "matched_existing" : "pending",
    source: "gmail",
    provider: "banco-pichincha",
    gmailMessageId: expense.messageId,
    gmailThreadId: expense.threadId,
    emailDate: Timestamp.fromDate(expense.emailDate),
    emailDateText: expense.emailDate.toISOString().slice(0, 10),
    subject: expense.subject,
    from: expense.from,
    amount: expense.amount,
    description: expense.description,
    category: expense.category,
    subcategory: expense.subcategory,
    tags: expense.tags,
    rawText: expense.rawText,
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
    reply_markup: candidateKeyboard(candidateId),
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

async function createMovementFromCandidate(candidateId: string, from: CajaId) {
  const db = getFirebaseAdminDb();
  const ref = db.collection("gmail_expense_candidates").doc(candidateId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("No encontre el gasto candidato.");

  const candidate = doc.data() || {};
  if (candidate.status === "registered") throw new Error("Este gasto ya fue registrado.");
  if (candidate.status === "ignored") throw new Error("Este gasto fue ignorado.");

  const amount = Number(candidate.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Monto invalido.");

  const movementRef = db.collection("movements").doc();
  const emailDate = candidate.emailDate?.toDate ? candidate.emailDate.toDate() : new Date(candidate.emailDate);

  await movementRef.set({
    date: Timestamp.fromDate(Number.isNaN(emailDate.getTime()) ? new Date() : emailDate),
    type: "outflow",
    amount,
    description: `[GMAIL PICHINCHA] ${String(candidate.description || "GASTO BANCARIO")}`.toUpperCase().slice(0, 500),
    createdBy: "gmail-expense-scanner",
    from,
    to: null,
    category: candidate.category || "Otros",
    subcategory: candidate.subcategory || null,
    tags: Array.isArray(candidate.tags) ? candidate.tags : ["BANCO", "PICHINCHA"],
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
      registeredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { movementId: movementRef.id, candidate };
}

export async function scanGmailForExpenses(params: {
  maxResults?: number;
  botToken?: string;
  notificationChatId?: number | string;
} = {}): Promise<GmailScanResult> {
  const accessToken = await getGmailAccessToken();
  const maxResults = Math.min(Math.max(params.maxResults || 10, 1), 25);
  const query = getGmailQuery();
  const list = await gmailApi<{ messages?: Array<{ id: string; threadId: string }> }>(
    `messages?${new URLSearchParams({ q: query, maxResults: String(maxResults) })}`,
    accessToken
  );

  const results: any[] = [];
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
    const parsed = parsePichinchaExpense(message);

    if (!parsed) {
      addSkipped("not-expense");
      results.push({ messageId: item.id, ok: true, skipped: true, reason: "not-expense" });
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

  if (action === "scanMore") {
    const config = getTelegramConfig();
    const result = await scanGmailForExpenses({
      maxResults: 25,
      botToken: params.botToken || config.telegramExpenseBotToken || config.telegramBotToken,
      notificationChatId: chatId,
    });

    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: [
          "Revision amplia Gmail completada.",
          `Correos revisados: ${result.checked}`,
          `Nuevos: ${result.created}`,
          `Reenviados: ${result.resent + result.pendingNotified}`,
          `Avisos enviados: ${result.notified}`,
        ].join("\n"),
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

  if (action === "register" && ["safe", "transit", "bank"].includes(value)) {
    try {
      const created = await createMovementFromCandidate(candidateId, value as CajaId);

      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: [
            "Gasto de Gmail registrado.",
            `Monto: USD ${Number(created.candidate.amount || 0).toFixed(2)}`,
            `Caja: ${value === "bank" ? "Banco" : value === "transit" ? "Transito" : "Tienda"}`,
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
