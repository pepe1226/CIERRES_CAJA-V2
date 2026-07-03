import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  getTelegramConfig,
  sendTelegramMessage,
} from "./telegramMovement.js";
import {
  processGmailExpenseCallback,
  scanGmailForExpenses,
} from "./gmailExpenseScanner.js";

type CajaId = "safe" | "transit" | "bank";

type ExpenseSuggestion = {
  category: string;
  subcategory: string;
  tags: string[];
  keyword?: string;
  source: "memory" | "rules" | "default" | "manual";
};

type ExpenseDraft = {
  id?: string;
  chatId: string;
  messageId?: number;
  telegramUserId?: string | null;
  telegramUserName?: string | null;
  telegramFirstName?: string | null;
  text: string;
  normalizedText: string;
  amount: number;
  from: CajaId | null;
  category: string;
  subcategory: string | null;
  tags: string[];
  description: string;
  status: "pending" | "confirmed" | "cancelled";
  movementId?: string | null;
  suggestionSource: string;
  suggestionKeyword?: string | null;
};

const CATEGORY_BUTTONS = [
  { label: "Combustible", category: "Combustible", subcategory: "MOVILIZACION", tags: ["COMBUSTIBLE", "MOVILIZACION"] },
  { label: "Transporte", category: "Transporte", subcategory: "MOVILIZACION", tags: ["TRANSPORTE", "MOVILIZACION"] },
  { label: "Proveedor", category: "Proveedor", subcategory: "COMPRAS", tags: ["PROVEEDOR", "COMPRAS"] },
  { label: "Insumos", category: "Insumos", subcategory: "OPERACION", tags: ["INSUMOS", "OPERACION"] },
  { label: "Personal", category: "Personal", subcategory: "ANTICIPO", tags: ["PERSONAL", "ANTICIPO"] },
  { label: "Servicios", category: "Servicios", subcategory: "FIJOS", tags: ["SERVICIOS", "FIJO"] },
  { label: "Otros", category: "Otros", subcategory: "GENERAL", tags: ["SIN CLASIFICAR"] },
];

const RULES = [
  { terms: ["combustible", "gasolina", "diesel", "nafta", "moto"], suggestion: CATEGORY_BUTTONS[0] },
  { terms: ["taxi", "uber", "flete", "envio", "transporte", "bus", "peaje", "parqueo"], suggestion: CATEGORY_BUTTONS[1] },
  { terms: ["proveedor", "compra proveedor", "mercaderia"], suggestion: CATEGORY_BUTTONS[2] },
  { terms: ["funda", "fundas", "cinta", "papeleria", "limpieza", "material"], suggestion: CATEGORY_BUTTONS[3] },
  { terms: ["sueldo", "anticipo", "prestamo", "nomina", "empleado"], suggestion: CATEGORY_BUTTONS[4] },
  { terms: ["luz", "agua", "internet", "netlife", "claro", "cnt", "arriendo", "alquiler"], suggestion: CATEGORY_BUTTONS[5] },
];

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s.,/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKeyword(value: unknown) {
  return normalizeText(value)
    .replace(/\b(salida|gasto|pago|pague|voy|hacer|una|un|de|del|desde|por|para|con|la|el|en|caja|tienda|banco|transito)\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseAmount(text: string) {
  const match = text.match(/(?:\$|usd)?\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (!match) return 0;
  const amount = Number(match[1].replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0;
}

function parseCaja(text: string): CajaId | null {
  const normalized = normalizeText(text);
  if (/\b(banco|cuenta|transferencia bancaria)\b/.test(normalized)) return "bank";
  if (/\b(transito|transit|ruta|camino)\b/.test(normalized)) return "transit";
  if (/\b(tienda|caja|efectivo|principal)\b/.test(normalized)) return "safe";
  return null;
}

function isLikelyExpenseText(text: string) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return false;
  if (parseAmount(normalized) <= 0) return false;
  return /\b(salida|gasto|pago|pague|compr[eé]|combustible|gasolina|taxi|proveedor|fundas|anticipo|sueldo)\b/.test(normalized);
}

function makeTags(values: Array<string | undefined | null>) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeText(value).replace(/\s+/g, "_").toUpperCase())
        .filter(Boolean)
    )
  ).slice(0, 8);
}

async function findMemorySuggestion(normalizedText: string): Promise<ExpenseSuggestion | null> {
  const db = getFirebaseAdminDb();
  const snapshot = await db
    .collection("expense_category_memory")
    .orderBy("uses", "desc")
    .limit(100)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const keyword = normalizeText(data.keyword);
    if (!keyword) continue;

    if (normalizedText.includes(keyword)) {
      return {
        category: String(data.category || "Otros"),
        subcategory: String(data.subcategory || "GENERAL"),
        tags: Array.isArray(data.tags) ? data.tags.map(String) : ["SIN CLASIFICAR"],
        keyword,
        source: "memory",
      };
    }
  }

  return null;
}

function ruleSuggestion(normalizedText: string): ExpenseSuggestion {
  const rule = RULES.find((item) => item.terms.some((term) => normalizedText.includes(term)));
  if (!rule) {
    return {
      category: "Otros",
      subcategory: "GENERAL",
      tags: ["SIN CLASIFICAR"],
      source: "default",
    };
  }

  return {
    category: rule.suggestion.category,
    subcategory: rule.suggestion.subcategory,
    tags: rule.suggestion.tags,
    keyword: rule.terms.find((term) => normalizedText.includes(term)),
    source: "rules",
  };
}

async function suggestExpense(normalizedText: string) {
  return (await findMemorySuggestion(normalizedText)) || ruleSuggestion(normalizedText);
}

function draftKeyboard(draft: ExpenseDraft) {
  const rows: any[] = [];

  if (!draft.from) {
    rows.push([
      { text: "Tienda", callback_data: `exp:from:${draft.id}:safe` },
      { text: "Transito", callback_data: `exp:from:${draft.id}:transit` },
      { text: "Banco", callback_data: `exp:from:${draft.id}:bank` },
    ]);
  }

  rows.push([
    { text: "Confirmar", callback_data: `exp:confirm:${draft.id}` },
    { text: "Categoria", callback_data: `exp:categories:${draft.id}` },
    { text: "Cancelar", callback_data: `exp:cancel:${draft.id}` },
  ]);

  return { inline_keyboard: rows };
}

function categoryKeyboard(draftId: string) {
  return {
    inline_keyboard: [
      CATEGORY_BUTTONS.slice(0, 3).map((item) => ({ text: item.label, callback_data: `exp:cat:${draftId}:${item.category}` })),
      CATEGORY_BUTTONS.slice(3, 6).map((item) => ({ text: item.label, callback_data: `exp:cat:${draftId}:${item.category}` })),
      [{ text: "Otros", callback_data: `exp:cat:${draftId}:Otros` }],
    ],
  };
}

function registeredMovementKeyboard(movementId: string) {
  return {
    inline_keyboard: [
      [{ text: "Eliminar", callback_data: `exp:deleteAsk:${movementId}` }],
    ],
  };
}

function deleteMovementKeyboard(movementId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Si, eliminar", callback_data: `exp:deleteConfirm:${movementId}` },
        { text: "No", callback_data: `exp:deleteCancel:${movementId}` },
      ],
    ],
  };
}

function cajaLabel(value: CajaId | null) {
  if (value === "bank") return "Banco";
  if (value === "transit") return "Transito";
  if (value === "safe") return "Tienda";
  return "Falta caja";
}

function isDeleteRequest(text: string) {
  return /^\/?(eliminar|borrar|anular)\b/i.test(normalizeText(text));
}

function isGmailScanRequest(text: string) {
  return /^\/?(revisar|buscar|scan)\s+(correo|correos|gmail)\b/i.test(normalizeText(text));
}

function parseDeleteMovementId(text: string) {
  const normalized = String(text || "").trim();
  const match = normalized.match(/^\/?(?:eliminar|borrar|anular)\s+([A-Za-z0-9_-]{8,})/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  return ["ultimo", "ultima"].includes(candidate) ? null : match[1];
}

function movementDeleteText(movementId: string, movement: any) {
  const amount = Number(movement.amount || 0);
  const description = String(movement.description || "SIN DESCRIPCION").replace(/^\[TELEGRAM\]\s*/i, "");

  return [
    "Confirmar eliminacion de salida.",
    `Monto: USD ${amount.toFixed(2)}`,
    `Caja: ${cajaLabel((movement.from || null) as CajaId | null)}`,
    `Categoria: ${movement.category || "Otros"}`,
    `Descripcion: ${description}`,
    `Movimiento: ${movementId}`,
    "",
    "Toca eliminar solo si este registro fue un error.",
  ].join("\n");
}

function draftText(draft: ExpenseDraft) {
  return [
    "Salida detectada.",
    `Monto: USD ${draft.amount.toFixed(2)}`,
    `Caja: ${cajaLabel(draft.from)}`,
    `Categoria: ${draft.category}`,
    `Subcategoria: ${draft.subcategory || "GENERAL"}`,
    `Descripcion: ${draft.description}`,
    draft.suggestionSource === "memory" ? "Memoria: usada" : "Memoria: nueva regla",
    "",
    draft.from ? "Confirma o cambia la categoria." : "Elige primero de donde salio el dinero.",
  ].join("\n");
}

async function saveDraft(draft: ExpenseDraft) {
  const db = getFirebaseAdminDb();
  const ref = db.collection("telegram_expense_drafts").doc();
  const saved = { ...draft, id: ref.id };

  await ref.set({
    ...saved,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return saved;
}

async function updateDraft(draftId: string, values: Partial<ExpenseDraft>) {
  const db = getFirebaseAdminDb();
  await db.collection("telegram_expense_drafts").doc(draftId).set(
    {
      ...values,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getDraft(draftId: string): Promise<ExpenseDraft | null> {
  const doc = await getFirebaseAdminDb().collection("telegram_expense_drafts").doc(draftId).get();
  return doc.exists ? ({ id: doc.id, ...doc.data() } as ExpenseDraft) : null;
}

async function learnFromDraft(draft: ExpenseDraft) {
  const keyword = normalizeKeyword(draft.text);
  if (!keyword || draft.category === "Otros") return;

  const db = getFirebaseAdminDb();
  const key = keyword.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  if (!key) return;

  await db.collection("expense_category_memory").doc(key).set(
    {
      keyword,
      category: draft.category,
      subcategory: draft.subcategory || "GENERAL",
      tags: draft.tags || [],
      uses: FieldValue.increment(1),
      lastUsedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getExpenseMovementForChat(movementId: string, chatId?: number | string | null) {
  const doc = await getFirebaseAdminDb().collection("movements").doc(movementId).get();
  if (!doc.exists) return null;

  const data = doc.data() || {};
  const isExpenseAssistantMovement =
    data.type === "outflow" &&
    data.source === "telegram" &&
    data.telegramProvider === "expense-assistant";

  if (!isExpenseAssistantMovement) return null;
  if (chatId && String(data.telegramChatId || "") !== String(chatId)) return null;

  return { id: doc.id, ref: doc.ref, data };
}

async function findLastExpenseMovementForChat(chatId: number | string) {
  const snapshot = await getFirebaseAdminDb()
    .collection("movements")
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (
      data.type === "outflow" &&
      data.source === "telegram" &&
      data.telegramProvider === "expense-assistant" &&
      String(data.telegramChatId || "") === String(chatId)
    ) {
      return { id: doc.id, ref: doc.ref, data };
    }
  }

  return null;
}

async function deleteExpenseMovement(params: {
  movementId: string;
  chatId?: number | string | null;
  deletedBy?: string | null;
}) {
  const movement = await getExpenseMovementForChat(params.movementId, params.chatId);
  if (!movement) {
    throw new Error("No encontre una salida de este bot para eliminar.");
  }

  const db = getFirebaseAdminDb();
  await db.collection("telegram_expense_deleted_movements").doc(params.movementId).set({
    ...movement.data,
    originalMovementId: params.movementId,
    deletedAt: FieldValue.serverTimestamp(),
    deletedBy: params.deletedBy || "telegram-bot",
  });
  await movement.ref.delete();

  return movement;
}

async function createMovementFromDraft(draft: ExpenseDraft) {
  if (!draft.from) throw new Error("Falta caja origen.");
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) throw new Error("Monto invalido.");

  const db = getFirebaseAdminDb();
  const ref = db.collection("movements").doc();

  await ref.set({
    date: Timestamp.fromDate(new Date()),
    type: "outflow",
    amount: draft.amount,
    description: `[TELEGRAM] ${draft.description}`.toUpperCase().slice(0, 500),
    createdBy: "telegram-bot",
    from: draft.from,
    to: null,
    category: draft.category,
    subcategory: draft.subcategory || null,
    tags: draft.tags || [],
    source: "telegram",
    telegramProvider: "expense-assistant",
    telegramRequiresReview: false,
    telegramConfidence: draft.suggestionSource === "memory" ? 0.95 : 0.75,
    telegramChatId: draft.chatId,
    telegramMessageId: draft.messageId || null,
    telegramUserId: draft.telegramUserId || null,
    telegramUserName: draft.telegramUserName || null,
    telegramFirstName: draft.telegramFirstName || null,
    telegramRawExtraction: {
      text: draft.text,
      normalizedText: draft.normalizedText,
      suggestionSource: draft.suggestionSource,
      suggestionKeyword: draft.suggestionKeyword || null,
    },
    createdAt: FieldValue.serverTimestamp(),
  });

  await learnFromDraft(draft);
  await updateDraft(draft.id!, { status: "confirmed", movementId: ref.id });

  return ref.id;
}

export async function processExpenseAssistantMessage(params: {
  chatId: number | string;
  message: any;
  botToken?: string;
}) {
  const text = String(params.message.text || params.message.caption || "").trim();
  if (isGmailScanRequest(text)) {
    try {
      const config = getTelegramConfig();
      const result = await scanGmailForExpenses({
        maxResults: 10,
        botToken: params.botToken || config.telegramExpenseBotToken || config.telegramBotToken,
      });

      await sendTelegramMessage(
        params.chatId,
        [
          "Revision Gmail completada.",
          `Correos revisados: ${result.checked}`,
          `Candidatos nuevos: ${result.created}`,
          `Avisos enviados: ${result.notified}`,
        ].join("\n"),
        params.botToken
      );

      return { handled: true, gmailScan: true, result };
    } catch (error: any) {
      await sendTelegramMessage(
        params.chatId,
        `No pude revisar Gmail: ${error?.message || String(error)}`,
        params.botToken
      );
      return { handled: true, gmailScan: true, error: error?.message || String(error) };
    }
  }

  if (isDeleteRequest(text)) {
    const movementId = parseDeleteMovementId(text);
    const movement = movementId
      ? await getExpenseMovementForChat(movementId, params.chatId)
      : await findLastExpenseMovementForChat(params.chatId);

    if (!movement) {
      await sendTelegramMessage(
        params.chatId,
        "No encontre una salida reciente de este bot para eliminar.",
        params.botToken
      );
      return { handled: true, deleteRequest: true, found: false };
    }

    await sendTelegramMessage(
      params.chatId,
      movementDeleteText(movement.id, movement.data),
      params.botToken,
      { reply_markup: deleteMovementKeyboard(movement.id) }
    );

    return { handled: true, deleteRequest: true, movementId: movement.id };
  }

  if (!isLikelyExpenseText(text)) {
    return { handled: false };
  }

  const normalizedText = normalizeText(text);
  const suggestion = await suggestExpense(normalizedText);
  const amount = parseAmount(normalizedText);
  const from = parseCaja(normalizedText);
  const description = text.replace(/\s+/g, " ").slice(0, 180);

  const draft = await saveDraft({
    chatId: String(params.chatId),
    messageId: params.message.message_id || null,
    telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
    telegramUserName: params.message.from?.username || null,
    telegramFirstName: params.message.from?.first_name || null,
    text,
    normalizedText,
    amount,
    from,
    category: suggestion.category,
    subcategory: suggestion.subcategory,
    tags: makeTags(suggestion.tags),
    description,
    status: "pending",
    suggestionSource: suggestion.source,
    suggestionKeyword: suggestion.keyword || null,
  });

  await sendTelegramMessage(params.chatId, draftText(draft), params.botToken, {
    reply_markup: draftKeyboard(draft),
  });

  return { handled: true, draftId: draft.id };
}

export async function processExpenseAssistantCallback(params: {
  callbackQuery: any;
  botToken?: string;
}) {
  const data = String(params.callbackQuery.data || "");
  if (data.startsWith("gmail:")) {
    return processGmailExpenseCallback(params);
  }

  if (!data.startsWith("exp:")) return { handled: false };

  const [, action, draftId, value] = data.split(":");
  const chatId = params.callbackQuery.message?.chat?.id;
  const messageId = params.callbackQuery.message?.message_id;

  await answerTelegramCallbackQuery({
    callbackQueryId: params.callbackQuery.id,
    botToken: params.botToken,
  });

  if (action === "deleteAsk") {
    const movement = await getExpenseMovementForChat(draftId, chatId);
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: movement
          ? movementDeleteText(movement.id, movement.data)
          : "No encontre esta salida para eliminar.",
        botToken: params.botToken,
        extraPayload: movement ? { reply_markup: deleteMovementKeyboard(movement.id) } : {},
      });
    }
    return { handled: true, deleteRequest: true, movementId: draftId, found: Boolean(movement) };
  }

  if (action === "deleteCancel") {
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: "Eliminacion cancelada. La salida se mantiene.",
        botToken: params.botToken,
      });
    }
    return { handled: true, deleteCancelled: true, movementId: draftId };
  }

  if (action === "deleteConfirm") {
    try {
      const deleted = await deleteExpenseMovement({
        movementId: draftId,
        chatId,
        deletedBy: params.callbackQuery.from?.id ? String(params.callbackQuery.from.id) : null,
      });

      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: [
            "Salida eliminada.",
            `Monto: USD ${Number(deleted.data.amount || 0).toFixed(2)}`,
            `Caja: ${cajaLabel((deleted.data.from || null) as CajaId | null)}`,
            `Movimiento: ${deleted.id}`,
          ].join("\n"),
          botToken: params.botToken,
        });
      }

      return { handled: true, deleted: true, movementId: draftId };
    } catch (error: any) {
      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: `No pude eliminar la salida: ${error?.message || String(error)}`,
          botToken: params.botToken,
        });
      }
      return { handled: true, deleted: false, error: error?.message || String(error) };
    }
  }

  const draft = await getDraft(draftId);
  if (!draft || draft.status !== "pending") {
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: "Este registro ya no esta pendiente.",
        botToken: params.botToken,
      });
    }
    return { handled: true, stale: true };
  }

  if (action === "cancel") {
    await updateDraft(draftId, { status: "cancelled" });
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: "Salida cancelada. No se guardo ningun movimiento.",
        botToken: params.botToken,
      });
    }
    return { handled: true, cancelled: true };
  }

  if (action === "categories") {
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: "Elige la categoria para esta salida.",
        botToken: params.botToken,
        extraPayload: { reply_markup: categoryKeyboard(draftId) },
      });
    }
    return { handled: true };
  }

  if (action === "cat") {
    const category = CATEGORY_BUTTONS.find((item) => item.category === value) || CATEGORY_BUTTONS[CATEGORY_BUTTONS.length - 1];
    const updated = {
      ...draft,
      category: category.category,
      subcategory: category.subcategory,
      tags: makeTags(category.tags),
      suggestionSource: "manual",
    };
    await updateDraft(draftId, updated);
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: draftText(updated),
        botToken: params.botToken,
        extraPayload: { reply_markup: draftKeyboard(updated) },
      });
    }
    return { handled: true };
  }

  if (action === "from" && ["safe", "transit", "bank"].includes(value)) {
    const updated = { ...draft, from: value as CajaId };
    await updateDraft(draftId, { from: value as CajaId });
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: draftText(updated),
        botToken: params.botToken,
        extraPayload: { reply_markup: draftKeyboard(updated) },
      });
    }
    return { handled: true };
  }

  if (action === "confirm") {
    try {
      const movementId = await createMovementFromDraft(draft);
      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: [
            "Salida registrada.",
            `Monto: USD ${draft.amount.toFixed(2)}`,
            `Caja: ${cajaLabel(draft.from)}`,
            `Categoria: ${draft.category}`,
            `Movimiento: ${movementId}`,
          ].join("\n"),
          botToken: params.botToken,
          extraPayload: { reply_markup: registeredMovementKeyboard(movementId) },
        });
      }
      return { handled: true, movementId };
    } catch (error: any) {
      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: `No pude registrar la salida: ${error?.message || String(error)}`,
          botToken: params.botToken,
          extraPayload: { reply_markup: draftKeyboard(draft) },
        });
      }
      return { handled: true, error: error?.message || String(error) };
    }
  }

  return { handled: true, ignored: true };
}
