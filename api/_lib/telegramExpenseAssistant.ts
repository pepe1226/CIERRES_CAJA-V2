import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import {
  answerTelegramCallbackQuery,
  downloadTelegramPhoto,
  editTelegramMessageText,
  getTelegramConfig,
  sendTelegramMessage,
} from "./telegramMovement.js";
import { extractExpenseFromImage } from "./expenseImageOcr.js";
import {
  processGmailExpenseCallback,
  scanGmailForExpenses,
} from "./gmailExpenseScanner.js";
import {
  findExpenseMemorySuggestion,
  learnExpenseMemory,
} from "./expenseMemory.js";

type CajaId = "safe" | "transit" | "bank";

type ExpenseSuggestion = {
  category: string;
  subcategory: string;
  tags: string[];
  keyword?: string;
  source: "memory" | "rules" | "default" | "manual" | "ocr";
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
  { label: "Personal", category: "Gastos personales", subcategory: "GENERAL PERSONAL", tags: ["PERSONAL"] },
  { label: "Combustible", category: "Combustible", subcategory: "MOVILIZACION", tags: ["COMBUSTIBLE", "MOVILIZACION"] },
  { label: "Transporte", category: "Transporte", subcategory: "MOVILIZACION", tags: ["TRANSPORTE", "MOVILIZACION"] },
  { label: "Proveedor", category: "Proveedor", subcategory: "COMPRAS", tags: ["PROVEEDOR", "COMPRAS"] },
  { label: "Alimentacion", category: "Alimentacion", subcategory: "COMIDAS", tags: ["ALIMENTACION", "COMIDAS"] },
  { label: "Insumos", category: "Insumos", subcategory: "OPERACION", tags: ["INSUMOS", "OPERACION"] },
  { label: "Empleados", category: "Personal", subcategory: "ANTICIPO", tags: ["EMPLEADOS", "ANTICIPO"] },
  { label: "Servicios", category: "Servicios", subcategory: "FIJOS", tags: ["SERVICIOS", "FIJO"] },
  { label: "Otros", category: "Otros", subcategory: "GENERAL", tags: ["SIN CLASIFICAR"] },
];

const RULES = [
  { terms: ["gasto personal", "gastos personales", "retiro personal", "para mi", "mio", "personal mio", "uso personal"], suggestion: CATEGORY_BUTTONS[0] },
  { terms: ["combustible", "gasolina", "diesel", "nafta", "moto"], suggestion: CATEGORY_BUTTONS[1] },
  { terms: ["taxi", "uber", "flete", "envio", "transporte", "bus", "peaje", "parqueo"], suggestion: CATEGORY_BUTTONS[2] },
  { terms: ["proveedor", "compra proveedor", "mercaderia"], suggestion: CATEGORY_BUTTONS[3] },
  { terms: ["encebollado", "cebiche", "ceviche", "almuerzo", "merienda", "desayuno", "comida", "comidas", "colacion", "colada", "cafe", "pan", "bolon", "tigrillo", "chaulafan", "seco", "guatita", "corviche", "empanada", "cola", "gaseosa", "jugo", "agua", "snack", "picada"], suggestion: CATEGORY_BUTTONS[4] },
  { terms: ["funda", "fundas", "cinta", "papeleria", "limpieza", "material"], suggestion: CATEGORY_BUTTONS[5] },
  { terms: ["sueldo", "anticipo", "prestamo", "nomina", "empleado"], suggestion: CATEGORY_BUTTONS[6] },
  { terms: ["luz", "agua potable", "internet", "netlife", "claro", "cnt", "arriendo", "alquiler"], suggestion: CATEGORY_BUTTONS[7] },
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
  return Number.isFinite(amount) && amount > 0 && amount <= 10000 ? Number(amount.toFixed(2)) : 0;
}

function parseLastAmount(text: string) {
  const matches = Array.from(String(text || "").matchAll(/(?:\$|usd)?\s*(\d+(?:[.,]\d{1,2})?)/gi));
  const amounts = matches
    .map((match) => Number(match[1].replace(",", ".")))
    .filter((amount) => Number.isFinite(amount) && amount > 0 && amount <= 10000);
  const amount = amounts[amounts.length - 1] || 0;
  return amount > 0 ? Number(amount.toFixed(2)) : 0;
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

  const hasExplicitExpenseAction =
    /\b(salida|gasto|egreso|pago|pague|compre|retire|retiro|saque|sacar)\b/.test(normalized);
  const hasKnownExpenseConcept =
    /\b(combustible|gasolina|diesel|taxi|uber|proveedor|fundas|anticipo|sueldo|flete|peaje|parqueo|luz|internet|arriendo|encebollado|cebiche|ceviche|almuerzo|merienda|desayuno|comida|colacion|cafe|pan|bolon|tigrillo|chaulafan|seco|guatita|corviche|empanada|cola|gaseosa|jugo|snack|picada|gasto personal|gastos personales|retiro personal|para mi|mio|uso personal)\b/.test(normalized);
  const hasLocalExpensePhrase =
    /\b\d+(?:[.,]\d{1,2})?\s+(?:en|de|para|por)\s+[a-z]{3,}/.test(normalized) &&
    hasKnownExpenseConcept;
  const hasIncomeLanguage =
    /\b(ingreso|deposite|deposito|recibi|recibido|cobre|cobro|venta|vendi|abono|acreditacion)\b/.test(normalized);

  return !hasIncomeLanguage && (hasExplicitExpenseAction || hasKnownExpenseConcept || hasLocalExpensePhrase);
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

async function suggestExpense(normalizedText: string, extraValues: Array<unknown> = []) {
  const memorySuggestion = await findExpenseMemorySuggestion([normalizedText, ...extraValues]);
  if (memorySuggestion) return { ...memorySuggestion, source: "memory" as const };
  return ruleSuggestion(normalizedText);
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
  const rows: any[] = [];
  for (let index = 0; index < CATEGORY_BUTTONS.length; index += 3) {
    rows.push(
      CATEGORY_BUTTONS.slice(index, index + 3).map((item) => ({
        text: item.label,
        callback_data: `exp:cat:${draftId}:${item.category}`,
      }))
    );
  }

  return {
    inline_keyboard: rows,
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

function isMenuRequest(text: string) {
  const normalized = normalizeText(text);
  return /^\/?(start|menu|ayuda|help|botones|opciones)\b/.test(normalized);
}

function isConversationalCorrectionText(text: string) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return false;

  return /\b(no|corrige|corregir|correccion|cambiar|cambia|pon|poner|ajusta|arregla|edita|editar|era|es|son|valor|monto|caja|desde|categoria|subcategoria|descripcion|concepto|detalle|personal|banco|tienda|transito|cancelar|confirma|confirmar|registrar|listo|ok)\b/.test(normalized);
}

function isGmailScanRequest(text: string) {
  const normalized = normalizeText(text);
  if (!/\b(correo|correos|gmail|mail)\b/.test(normalized)) return false;

  return /\b(revisar|buscar|scan|ver|mostrar|relacionar|vincular|cruzar|gastos|movimientos)\b/.test(normalized);
}

function gmailScanDetails(result: Awaited<ReturnType<typeof scanGmailForExpenses>>) {
  if (result.created + result.resent + result.pendingNotified > 0) {
    return ["Te envie los movimientos detectados con botones."];
  }

  const reasonText = Object.entries(result.skippedByReason || {})
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  const examples = (result.diagnostics || [])
    .slice(0, 3)
    .map((item) => {
      const amountText = item.amounts?.length ? ` | montos: ${item.amounts.join(", ")}` : "";
      const imageText = item.imageParts ? ` | imagenes OCR: ${item.imageParts}` : "";
      return `- ${item.reason}: ${item.subject || item.from || "correo sin asunto"}${amountText}${imageText}`;
    });

  return [
    "No encontre movimientos nuevos para confirmar con la busqueda actual.",
    reasonText ? `Motivos: ${reasonText}` : "",
    examples.length ? "Ejemplos revisados:" : "",
    ...examples,
  ].filter(Boolean);
}

function assistantMenuText() {
  return [
    "Botones disponibles.",
    "",
    "Gmail:",
    "- Revisar Gmail: busca movimientos recientes.",
    "- Revision amplia Gmail: revisa mas correos si no salio nada.",
    "- Ver pendientes: reenvia gastos detectados sin confirmar.",
    "",
    "Gastos:",
    "- Envia una captura/comprobante y te propongo el gasto.",
    "- Escribe: 5 en encebollado",
    "- Escribe: combustible 20 tienda",
    "- Escribe: taxi 8 banco",
    "- Escribe: salida proveedor 50 transito",
    "- Si hay una salida pendiente puedes corregir: no, era banco",
    "- Tambien: el monto era 8.50 / categoria personal / descripcion almuerzo",
    "- Eliminar ultimo: borra la ultima salida creada por este bot.",
  ].join("\n");
}

export function expenseAssistantMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Revisar Gmail", callback_data: "gmail:scanMore" },
        { text: "Ver pendientes", callback_data: "gmail:pending" },
      ],
      [
        { text: "Revision amplia Gmail", callback_data: "gmail:scanDeep" },
      ],
      [
        { text: "Eliminar ultimo", callback_data: "exp:deleteLast" },
        { text: "Ayuda", callback_data: "exp:help" },
      ],
    ],
  };
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

function imageRejectedText(extraction: Awaited<ReturnType<typeof extractExpenseFromImage>>) {
  const reasons = extraction.reasons?.length
    ? extraction.reasons.map((reason) => `- ${reason}`).join("\n")
    : "- No encontre una salida clara.";

  return [
    "Revise la captura, pero no voy a registrar nada sin una salida clara.",
    extraction.amount ? `Monto leido: USD ${extraction.amount.toFixed(2)}` : "Monto leido: no detectado",
    `Tipo detectado: ${extraction.movementType}`,
    "",
    "Motivos:",
    reasons,
    "",
    "Si es un gasto, escribe algo como: salida proveedor 186.37 banco",
  ].join("\n");
}

async function setActiveDraftForChat(chatId: number | string, draftId: string | null) {
  const db = getFirebaseAdminDb();
  const ref = db.collection("telegram_expense_active_chats").doc(String(chatId));

  await ref.set(
    {
      chatId: String(chatId),
      draftId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
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

  await setActiveDraftForChat(saved.chatId, ref.id);

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

async function findLatestPendingDraftForChat(chatId: number | string): Promise<ExpenseDraft | null> {
  const db = getFirebaseAdminDb();
  const active = await db.collection("telegram_expense_active_chats").doc(String(chatId)).get();
  const activeDraftId = active.data()?.draftId ? String(active.data()?.draftId) : "";

  if (activeDraftId) {
    const activeDraft = await getDraft(activeDraftId);
    if (activeDraft && activeDraft.status === "pending" && String(activeDraft.chatId) === String(chatId)) {
      return activeDraft;
    }
  }

  const snapshot = await getFirebaseAdminDb()
    .collection("telegram_expense_drafts")
    .orderBy("updatedAt", "desc")
    .limit(200)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (String(data.chatId || "") === String(chatId) && data.status === "pending") {
      await setActiveDraftForChat(chatId, doc.id);
      return { id: doc.id, ...data } as ExpenseDraft;
    }
  }

  return null;
}

function findCategoryFromText(normalizedText: string) {
  const byCategory = CATEGORY_BUTTONS.find((item) =>
    normalizeText(item.category) === normalizedText ||
    normalizeText(item.label) === normalizedText ||
    normalizedText.includes(normalizeText(item.category)) ||
    normalizedText.includes(normalizeText(item.label))
  );
  if (byCategory) return byCategory;

  const suggestion = ruleSuggestion(normalizedText);
  if (suggestion.source === "rules") {
    return {
      label: suggestion.category,
      category: suggestion.category,
      subcategory: suggestion.subcategory,
      tags: suggestion.tags,
    };
  }

  return null;
}

function descriptionCorrection(text: string) {
  const raw = String(text || "").trim();
  const match = raw.match(/\b(?:descripcion|descripci[oó]n|concepto|detalle)\s*:?\s*(.+)$/i);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim().slice(0, 180);
}

function subcategoryCorrection(text: string) {
  const raw = String(text || "").trim();
  const match = raw.match(/\b(?:subcategoria|subcategor[ií]a|sub)\s*:?\s*(.+)$/i);
  if (!match) return "";
  return normalizeText(match[1]).replace(/\s+/g, " ").toUpperCase().slice(0, 80);
}

function tagsCorrection(text: string) {
  const raw = String(text || "").trim();
  const match = raw.match(/\b(?:etiqueta|etiquetas|tag|tags)\s*:?\s*(.+)$/i);
  if (!match) return [];
  return makeTags(match[1].split(/[,/]+/).map((item) => item.trim()));
}

function correctionHelpText(draft: ExpenseDraft) {
  return [
    "Tengo esta salida pendiente y no entendi que cambiar.",
    "",
    draftText(draft),
    "",
    "Puedes responder asi:",
    "- no, era banco",
    "- el monto era 8.50",
    "- ponlo como personal",
    "- categoria alimentacion",
    "- descripcion almuerzo proveedor",
    "- confirmar",
    "- cancelar",
  ].join("\n");
}

async function processDraftCorrection(params: {
  chatId: number | string;
  message: any;
  botToken?: string;
  draft: ExpenseDraft;
  text: string;
}) {
  const normalized = normalizeText(params.text);

  if (/\b(cancelar|cancela|anular|olvida)\b/.test(normalized)) {
    await updateDraft(params.draft.id!, { status: "cancelled" });
    await setActiveDraftForChat(params.chatId, null);
    await sendTelegramMessage(
      params.chatId,
      "Salida cancelada. No se guardo ningun movimiento.",
      params.botToken,
      { reply_markup: expenseAssistantMenuKeyboard() }
    );
    return { handled: true, corrected: true, cancelled: true, draftId: params.draft.id };
  }

  if (/^(confirmar|confirma|registrar|registra|listo|ok|dale|guardar|guarda)$/.test(normalized)) {
    try {
      const movementId = await createMovementFromDraft(params.draft);
      await setActiveDraftForChat(params.chatId, null);
      await sendTelegramMessage(
        params.chatId,
        [
          "Salida registrada.",
          `Monto: USD ${params.draft.amount.toFixed(2)}`,
          `Caja: ${cajaLabel(params.draft.from)}`,
          `Categoria: ${params.draft.category}`,
          `Movimiento: ${movementId}`,
        ].join("\n"),
        params.botToken,
        { reply_markup: registeredMovementKeyboard(movementId) }
      );
      return { handled: true, corrected: true, confirmed: true, movementId };
    } catch (error: any) {
      await sendTelegramMessage(
        params.chatId,
        `No pude registrar la salida: ${error?.message || String(error)}`,
        params.botToken,
        { reply_markup: draftKeyboard(params.draft) }
      );
      return { handled: true, corrected: true, error: error?.message || String(error) };
    }
  }

  const updates: Partial<ExpenseDraft> = {};
  const changed: string[] = [];
  const amount = /\b(monto|valor|total|era|son|es|corrige|cambia)\b/.test(normalized)
    ? parseLastAmount(normalized)
    : 0;

  if (amount > 0 && Math.abs(amount - params.draft.amount) > 0.001) {
    updates.amount = amount;
    changed.push(`Monto: USD ${amount.toFixed(2)}`);
  }

  const from = parseCaja(normalized);
  if (from && from !== params.draft.from) {
    updates.from = from;
    changed.push(`Caja: ${cajaLabel(from)}`);
  }

  const category = findCategoryFromText(normalized);
  if (category && category.category !== params.draft.category) {
    updates.category = category.category;
    updates.subcategory = category.subcategory;
    updates.tags = makeTags(category.tags);
    updates.suggestionSource = "manual";
    updates.suggestionKeyword = category.label;
    changed.push(`Categoria: ${category.category}`);
  }

  const newDescription = descriptionCorrection(params.text);
  if (newDescription && newDescription !== params.draft.description) {
    updates.description = newDescription;
    updates.text = `${params.draft.text}\nCorreccion: ${params.text}`.slice(0, 800);
    updates.normalizedText = normalizeText([params.draft.normalizedText, params.text].join(" "));
    changed.push(`Descripcion: ${newDescription}`);
  }

  const subcategory = subcategoryCorrection(params.text);
  if (subcategory && subcategory !== params.draft.subcategory) {
    updates.subcategory = subcategory;
    changed.push(`Subcategoria: ${subcategory}`);
  }

  const tags = tagsCorrection(params.text);
  if (tags.length > 0) {
    updates.tags = makeTags([...(params.draft.tags || []), ...tags]);
    changed.push(`Etiquetas: ${updates.tags.join(", ")}`);
  }

  if (changed.length === 0) {
    await sendTelegramMessage(
      params.chatId,
      correctionHelpText(params.draft),
      params.botToken,
      { reply_markup: draftKeyboard(params.draft) }
    );
    return { handled: true, corrected: false, draftId: params.draft.id };
  }

  const updatedDraft = { ...params.draft, ...updates };
  await updateDraft(params.draft.id!, updates);
  await sendTelegramMessage(
    params.chatId,
    [
      "Correccion aplicada.",
      ...changed.map((item) => `- ${item}`),
      "",
      draftText(updatedDraft),
    ].join("\n"),
    params.botToken,
    { reply_markup: draftKeyboard(updatedDraft) }
  );

  return { handled: true, corrected: true, draftId: params.draft.id, updates };
}

async function learnFromDraft(draft: ExpenseDraft, movementId?: string) {
  await learnExpenseMemory({
    keywords: [
      draft.suggestionKeyword,
      draft.description,
      draft.text,
      normalizeKeyword(draft.text),
    ],
    category: draft.category,
    subcategory: draft.subcategory || "GENERAL",
    tags: draft.tags || [],
    movementId: movementId || draft.movementId || null,
    source: draft.suggestionSource || "telegram",
  });
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

  await learnFromDraft(draft, ref.id);
  await updateDraft(draft.id!, { status: "confirmed", movementId: ref.id });
  await setActiveDraftForChat(draft.chatId, null);

  return ref.id;
}

export async function processExpenseAssistantMessage(params: {
  chatId: number | string;
  message: any;
  botToken?: string;
}) {
  const text = String(params.message.text || params.message.caption || "").trim();
  if (isMenuRequest(text)) {
    await sendTelegramMessage(
      params.chatId,
      assistantMenuText(),
      params.botToken,
      { reply_markup: expenseAssistantMenuKeyboard() }
    );
    return { handled: true, menu: true };
  }

  if (isGmailScanRequest(text)) {
    try {
      const config = getTelegramConfig();
      const result = await scanGmailForExpenses({
        maxResults: /\b(amplia|profunda|mas|más|todos|todo)\b/i.test(normalizeText(text)) ? 100 : 25,
        botToken: params.botToken || config.telegramExpenseBotToken || config.telegramBotToken,
        notificationChatId: params.chatId,
      });

      await sendTelegramMessage(
        params.chatId,
        [
          "Revision Gmail completada.",
          `Correos revisados: ${result.checked}`,
          `Candidatos nuevos: ${result.created}`,
          `Pendientes reenviados: ${result.resent + result.pendingNotified}`,
          `Avisos enviados: ${result.notified}`,
          ...gmailScanDetails(result),
        ].join("\n"),
        params.botToken,
        { reply_markup: expenseAssistantMenuKeyboard() }
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

  if (isConversationalCorrectionText(text)) {
    const pendingDraft = await findLatestPendingDraftForChat(params.chatId);
    if (pendingDraft) {
      return processDraftCorrection({
        chatId: params.chatId,
        message: params.message,
        botToken: params.botToken,
        draft: pendingDraft,
        text,
      });
    }

    await sendTelegramMessage(
      params.chatId,
      [
        "Entendi que quieres corregir algo, pero no tengo una salida pendiente en este chat.",
        "Envia primero el gasto o la captura, y luego puedes responder cosas como:",
        "no, era banco",
        "el monto era 8.50",
        "es un gasto personal",
      ].join("\n"),
      params.botToken,
      { reply_markup: expenseAssistantMenuKeyboard() }
    );
    return { handled: true, correction: true, foundDraft: false };
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

export async function processExpenseAssistantPhoto(params: {
  chatId: number | string;
  message: any;
  largestPhoto: any;
  botToken?: string;
}) {
  if (!params.largestPhoto?.file_id) return { handled: false };

  try {
    const downloaded = await downloadTelegramPhoto(params.largestPhoto.file_id, params.botToken);
    const caption = String(params.message.caption || "").trim();
    const extraction = await extractExpenseFromImage({
      imageBuffer: downloaded.imageBuffer,
      mimeType: downloaded.mimeType,
      contextText: caption,
    });

    const isExpense =
      extraction.isFinancialMovement &&
      ["outflow", "transfer"].includes(extraction.movementType) &&
      Number(extraction.amount || 0) > 0;

    if (!isExpense) {
      await sendTelegramMessage(
        params.chatId,
        imageRejectedText(extraction),
        params.botToken,
        { reply_markup: expenseAssistantMenuKeyboard() }
      );
      return { handled: true, imageExpense: false, extraction };
    }

    const normalizedText = normalizeText([
      caption,
      extraction.description,
      extraction.extractedText,
    ].filter(Boolean).join(" "));
    const suggestion = await suggestExpense(normalizedText, [
      extraction.merchant,
      extraction.destinationAccount,
      extraction.description,
    ]);
    const category = suggestion.source === "memory" ? suggestion.category : extraction.category || suggestion.category;
    const subcategory = suggestion.source === "memory" ? suggestion.subcategory : extraction.subcategory || suggestion.subcategory || "GENERAL";
    const description = (
      extraction.description ||
      caption ||
      "Gasto detectado desde captura"
    ).replace(/\s+/g, " ").slice(0, 180);

    const draft = await saveDraft({
      chatId: String(params.chatId),
      messageId: params.message.message_id || null,
      telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
      telegramUserName: params.message.from?.username || null,
      telegramFirstName: params.message.from?.first_name || null,
      text: caption || extraction.extractedText || extraction.description,
      normalizedText,
      amount: Number(extraction.amount),
      from: extraction.suggestedFrom || parseCaja(normalizedText),
      category,
      subcategory,
      tags: makeTags([
        ...(extraction.tags || []),
        category,
        subcategory,
        "OCR",
      ]),
      description,
      status: "pending",
      suggestionSource: suggestion.source === "memory" ? "memory" : "ocr",
      suggestionKeyword: extraction.merchant || suggestion.keyword || null,
    });

    await sendTelegramMessage(params.chatId, draftText(draft), params.botToken, {
      reply_markup: draftKeyboard(draft),
    });

    return { handled: true, imageExpense: true, draftId: draft.id, extraction };
  } catch (error: any) {
    await sendTelegramMessage(
      params.chatId,
      [
        "No pude leer la captura automaticamente.",
        error?.message || String(error),
        "",
        "Puedes escribir el gasto manualmente, por ejemplo: salida proveedor 186.37 banco",
      ].join("\n"),
      params.botToken
    );
    return { handled: true, imageExpense: false, error: error?.message || String(error) };
  }
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

  if (action === "help" || action === "menu") {
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: assistantMenuText(),
        botToken: params.botToken,
        extraPayload: { reply_markup: expenseAssistantMenuKeyboard() },
      });
    }
    return { handled: true, menu: true };
  }

  if (action === "deleteLast") {
    const movement = chatId ? await findLastExpenseMovementForChat(chatId) : null;
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: movement
          ? movementDeleteText(movement.id, movement.data)
          : "No encontre una salida reciente de este bot para eliminar.",
        botToken: params.botToken,
        extraPayload: movement ? { reply_markup: deleteMovementKeyboard(movement.id) } : { reply_markup: expenseAssistantMenuKeyboard() },
      });
    }
    return { handled: true, deleteRequest: true, movementId: movement?.id || null, found: Boolean(movement) };
  }

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
    if (chatId) await setActiveDraftForChat(chatId, null);
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
    if (chatId) await setActiveDraftForChat(chatId, draftId);
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
    if (chatId) await setActiveDraftForChat(chatId, draftId);
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
    if (chatId) await setActiveDraftForChat(chatId, draftId);
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

