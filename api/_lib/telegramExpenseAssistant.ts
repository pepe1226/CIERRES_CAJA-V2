import { GoogleGenAI, Type } from "@google/genai";
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
  type ExpenseMemoryNamespace,
} from "./expenseMemory.js";

type CajaId = "safe" | "transit" | "bank" | "personal";

type ExpenseSuggestion = {
  category: string;
  subcategory: string;
  tags: string[];
  keyword?: string;
  source: "memory" | "rules" | "default" | "manual" | "ocr";
};

type CategoryButton = {
  label: string;
  category: string;
  subcategory: string;
  tags: string[];
  callbackValue?: string;
  icon?: string;
};

type PersonalCategoryDefinition = CategoryButton & {
  icon: string;
  terms: string[];
  subcategories: CategoryButton[];
};

type ExpenseDraft = {
  id?: string;
  chatId: string;
  personalOnly?: boolean;
  messageId?: number;
  telegramUserId?: string | null;
  telegramUserName?: string | null;
  telegramFirstName?: string | null;
  text: string;
  normalizedText: string;
  date?: string | null;
  amount: number;
  from: CajaId | null;
  category: string;
  subcategory: string | null;
  tags: string[];
  description: string;
  merchant?: string | null;
  sourceAccount?: string | null;
  destinationAccount?: string | null;
  extractedText?: string | null;
  confidence?: number | null;
  requiresReview?: boolean;
  reviewReasons?: string[];
  status: "pending" | "confirmed" | "cancelled";
  movementId?: string | null;
  suggestionSource: string;
  suggestionKeyword?: string | null;
};

function assistantNamespace(personalOnly?: boolean): ExpenseMemoryNamespace {
  return personalOnly ? "personal" : "business";
}

function draftCollectionName(personalOnly?: boolean) {
  return personalOnly ? "telegram_personal_expense_drafts" : "telegram_expense_drafts";
}

function activeChatCollectionName(personalOnly?: boolean) {
  return personalOnly ? "telegram_personal_expense_active_chats" : "telegram_expense_active_chats";
}

function learningChatCollectionName(personalOnly?: boolean) {
  return personalOnly ? "telegram_personal_expense_learning_chats" : "telegram_expense_learning_chats";
}

function categoryCreationChatCollectionName(personalOnly?: boolean) {
  return personalOnly ? "telegram_personal_expense_category_chats" : "telegram_expense_category_chats";
}

const CATEGORY_BUTTONS = [
  { label: "Personal", category: "Gastos personales", subcategory: "GENERAL PERSONAL", tags: ["PERSONAL"] },
  { label: "Combustible", category: "Combustible", subcategory: "MOVILIZACION", tags: ["COMBUSTIBLE", "MOVILIZACION"] },
  { label: "Transporte", category: "Transporte", subcategory: "MOVILIZACION", tags: ["TRANSPORTE", "MOVILIZACION"] },
  { label: "Proveedor", category: "Proveedor", subcategory: "COMPRAS", tags: ["PROVEEDOR", "COMPRAS"] },
  { label: "Alimentacion", category: "Alimentacion", subcategory: "COMIDAS", tags: ["ALIMENTACION", "COMIDAS"] },
  { label: "Salud", category: "Salud", subcategory: "SALUD", tags: ["SALUD", "PERSONAL"] },
  { label: "Insumos", category: "Insumos", subcategory: "OPERACION", tags: ["INSUMOS", "OPERACION"] },
  { label: "Empleados", category: "Personal", subcategory: "ANTICIPO", tags: ["EMPLEADOS", "ANTICIPO"] },
  { label: "Servicios", category: "Servicios", subcategory: "FIJOS", tags: ["SERVICIOS", "FIJO"] },
  { label: "Otros", category: "Otros", subcategory: "GENERAL", tags: ["SIN CLASIFICAR"] },
];

const PERSONAL_CATEGORY_DEFINITIONS: PersonalCategoryDefinition[] = [
  {
    label: "Alimentacion",
    icon: "🍽️",
    category: "Alimentacion",
    subcategory: "GENERAL",
    tags: ["ALIMENTACION"],
    terms: ["alimentacion", "comida", "comidas", "almuerzo", "merienda", "desayuno", "cena", "supermercado", "super mercado", "mercado", "abasto", "despensa", "tienda", "chucho", "tia", "aki", "gran aki", "mi comisariato", "santa maria", "delivery", "pedido ya", "uber eats", "kfc", "pizza", "hamburguesa", "encebollado", "ceviche", "cebiche", "pan", "cafe", "agua", "cola", "jugo"],
    subcategories: [
      { label: "Supermercado", category: "Alimentacion", subcategory: "SUPERMERCADO", tags: ["ALIMENTACION", "SUPERMERCADO", "ABASTO"], callbackValue: "alimentacion|SUPERMERCADO" },
      { label: "Comida afuera", category: "Alimentacion", subcategory: "COMIDA AFUERA", tags: ["ALIMENTACION", "COMIDA_AFUERA"], callbackValue: "alimentacion|COMIDA AFUERA" },
      { label: "Delivery", category: "Alimentacion", subcategory: "DELIVERY", tags: ["ALIMENTACION", "DELIVERY"], callbackValue: "alimentacion|DELIVERY" },
      { label: "Tienda/Mercado", category: "Alimentacion", subcategory: "TIENDA O MERCADO", tags: ["ALIMENTACION", "TIENDA", "MERCADO"], callbackValue: "alimentacion|TIENDA O MERCADO" },
    ],
  },
  {
    label: "Entretenimiento",
    icon: "🎬",
    category: "Entretenimiento",
    subcategory: "GENERAL",
    tags: ["ENTRETENIMIENTO"],
    terms: ["entretenimiento", "cine", "pelicula", "bar", "discoteca", "salida", "paseo", "netflix", "spotify", "youtube premium", "suscripcion", "suscripción", "juego", "play", "streaming", "evento", "concierto"],
    subcategories: [
      { label: "Cine/Eventos", category: "Entretenimiento", subcategory: "CINE Y EVENTOS", tags: ["ENTRETENIMIENTO", "CINE", "EVENTOS"], callbackValue: "entretenimiento|CINE Y EVENTOS" },
      { label: "Bar/Salidas", category: "Entretenimiento", subcategory: "BAR Y SALIDAS", tags: ["ENTRETENIMIENTO", "BAR", "SALIDAS"], callbackValue: "entretenimiento|BAR Y SALIDAS" },
      { label: "Suscripciones", category: "Entretenimiento", subcategory: "SUSCRIPCIONES", tags: ["ENTRETENIMIENTO", "SUSCRIPCIONES"], callbackValue: "entretenimiento|SUSCRIPCIONES" },
      { label: "Juegos/Hobbies", category: "Entretenimiento", subcategory: "JUEGOS Y HOBBIES", tags: ["ENTRETENIMIENTO", "HOBBIES"], callbackValue: "entretenimiento|JUEGOS Y HOBBIES" },
    ],
  },
  {
    label: "Salud",
    icon: "💊",
    category: "Salud",
    subcategory: "GENERAL",
    tags: ["SALUD"],
    terms: ["salud", "farmacia", "medicina", "medicamento", "doctor", "medico", "médico", "cita medica", "consulta", "clinica", "clínica", "laboratorio", "examen", "dentista", "odontologo", "vitamina", "pastilla"],
    subcategories: [
      { label: "Farmacia", category: "Salud", subcategory: "FARMACIA", tags: ["SALUD", "FARMACIA"], callbackValue: "salud|FARMACIA" },
      { label: "Cita medica", category: "Salud", subcategory: "CITA MEDICA", tags: ["SALUD", "CITA_MEDICA"], callbackValue: "salud|CITA MEDICA" },
      { label: "Laboratorio", category: "Salud", subcategory: "LABORATORIO", tags: ["SALUD", "LABORATORIO"], callbackValue: "salud|LABORATORIO" },
      { label: "Bienestar", category: "Salud", subcategory: "BIENESTAR", tags: ["SALUD", "BIENESTAR"], callbackValue: "salud|BIENESTAR" },
    ],
  },
  {
    label: "Transporte",
    icon: "🚕",
    category: "Transporte",
    subcategory: "GENERAL",
    tags: ["TRANSPORTE"],
    terms: ["transporte", "taxi", "uber", "didi", "indriver", "bus", "pasaje", "gasolina", "combustible", "tanqueo", "parqueo", "peaje", "moto", "lavadora"],
    subcategories: [
      { label: "Taxi/App", category: "Transporte", subcategory: "TAXI O APP", tags: ["TRANSPORTE", "TAXI", "APP"], callbackValue: "transporte|TAXI O APP" },
      { label: "Bus/Pasaje", category: "Transporte", subcategory: "BUS O PASAJE", tags: ["TRANSPORTE", "BUS", "PASAJE"], callbackValue: "transporte|BUS O PASAJE" },
      { label: "Gasolina", category: "Transporte", subcategory: "COMBUSTIBLE", tags: ["TRANSPORTE", "COMBUSTIBLE"], callbackValue: "transporte|COMBUSTIBLE" },
      { label: "Parqueo/Peaje", category: "Transporte", subcategory: "PARQUEO O PEAJE", tags: ["TRANSPORTE", "PARQUEO", "PEAJE"], callbackValue: "transporte|PARQUEO O PEAJE" },
    ],
  },
  {
    label: "Servicios",
    icon: "💡",
    category: "Servicios",
    subcategory: "GENERAL",
    tags: ["SERVICIOS"],
    terms: ["servicio", "servicios", "luz", "agua potable", "internet", "netlife", "claro", "cnt", "telefono", "teléfono", "plan celular", "recarga", "cnel", "interagua"],
    subcategories: [
      { label: "Luz", category: "Servicios", subcategory: "LUZ", tags: ["SERVICIOS", "LUZ"], callbackValue: "servicios|LUZ" },
      { label: "Agua", category: "Servicios", subcategory: "AGUA", tags: ["SERVICIOS", "AGUA"], callbackValue: "servicios|AGUA" },
      { label: "Internet", category: "Servicios", subcategory: "INTERNET", tags: ["SERVICIOS", "INTERNET"], callbackValue: "servicios|INTERNET" },
      { label: "Telefono", category: "Servicios", subcategory: "TELEFONO", tags: ["SERVICIOS", "TELEFONO"], callbackValue: "servicios|TELEFONO" },
    ],
  },
  {
    label: "Casa",
    icon: "🏠",
    category: "Casa",
    subcategory: "GENERAL",
    tags: ["CASA"],
    terms: ["casa", "hogar", "arriendo", "alquiler", "limpieza", "muebles", "cocina", "reparacion casa", "reparación casa", "ferreteria", "ferretería"],
    subcategories: [
      { label: "Arriendo", category: "Casa", subcategory: "ARRIENDO", tags: ["CASA", "ARRIENDO"], callbackValue: "casa|ARRIENDO" },
      { label: "Limpieza", category: "Casa", subcategory: "LIMPIEZA", tags: ["CASA", "LIMPIEZA"], callbackValue: "casa|LIMPIEZA" },
      { label: "Muebles", category: "Casa", subcategory: "MUEBLES", tags: ["CASA", "MUEBLES"], callbackValue: "casa|MUEBLES" },
      { label: "Reparaciones", category: "Casa", subcategory: "REPARACIONES", tags: ["CASA", "REPARACIONES"], callbackValue: "casa|REPARACIONES" },
    ],
  },
  {
    label: "Educacion",
    icon: "📚",
    category: "Educacion",
    subcategory: "GENERAL",
    tags: ["EDUCACION"],
    terms: ["educacion", "educación", "curso", "clase", "colegio", "universidad", "libro", "cuaderno", "matricula", "matrícula"],
    subcategories: [
      { label: "Cursos", category: "Educacion", subcategory: "CURSOS", tags: ["EDUCACION", "CURSOS"], callbackValue: "educacion|CURSOS" },
      { label: "Libros", category: "Educacion", subcategory: "LIBROS", tags: ["EDUCACION", "LIBROS"], callbackValue: "educacion|LIBROS" },
      { label: "Colegio/U", category: "Educacion", subcategory: "COLEGIO O UNIVERSIDAD", tags: ["EDUCACION", "COLEGIO", "UNIVERSIDAD"], callbackValue: "educacion|COLEGIO O UNIVERSIDAD" },
    ],
  },
  {
    label: "Familia",
    icon: "👨‍👩‍👧",
    category: "Familia",
    subcategory: "GENERAL",
    tags: ["FAMILIA"],
    terms: ["familia", "mama", "mamá", "papa", "papá", "hijo", "hija", "hermano", "hermana", "regalo familiar", "ayuda familiar"],
    subcategories: [
      { label: "Ayuda familiar", category: "Familia", subcategory: "AYUDA FAMILIAR", tags: ["FAMILIA", "AYUDA"], callbackValue: "familia|AYUDA FAMILIAR" },
      { label: "Regalos", category: "Familia", subcategory: "REGALOS", tags: ["FAMILIA", "REGALOS"], callbackValue: "familia|REGALOS" },
      { label: "Niños", category: "Familia", subcategory: "NINOS", tags: ["FAMILIA", "NINOS"], callbackValue: "familia|NINOS" },
    ],
  },
  {
    label: "Otros",
    icon: "➕",
    category: "Otros",
    subcategory: "GENERAL",
    tags: ["SIN CLASIFICAR"],
    terms: ["otros", "otro", "varios"],
    subcategories: [
      { label: "General", category: "Otros", subcategory: "GENERAL", tags: ["SIN_CLASIFICAR"], callbackValue: "otros|GENERAL" },
    ],
  },
];

const PERSONAL_CATEGORY_BUTTONS = PERSONAL_CATEGORY_DEFINITIONS.map(({ label, category, subcategory, tags }) => ({
  label,
  category,
  subcategory,
  tags,
}));

const CATEGORY_EMOJIS: Record<string, string> = {
  "Gastos personales": "👤",
  Combustible: "⛽",
  Transporte: "🚕",
  Proveedor: "📦",
  Alimentacion: "🍽️",
  Salud: "💊",
  Insumos: "🧰",
  Personal: "👥",
  Servicios: "💡",
  Casa: "🏠",
  Educacion: "📚",
  Familia: "👨‍👩‍👧",
  Entretenimiento: "🎬",
  Otros: "➕",
  supermercado: "🛒",
};

const CATEGORY_ICON_HINTS: Array<{ terms: string[]; icon: string }> = [
  { terms: ["alimentacion", "comida", "almuerzo", "merienda", "desayuno", "cena", "supermercado", "mercado", "abasto", "despensa"], icon: "🍽️" },
  { terms: ["entretenimiento", "cine", "bar", "salida", "suscripcion", "suscripción", "juego", "evento", "concierto"], icon: "🎬" },
  { terms: ["salud", "farmacia", "medicina", "medico", "médico", "consulta", "cita", "laboratorio", "dentista"], icon: "💊" },
  { terms: ["transporte", "taxi", "uber", "bus", "pasaje", "gasolina", "combustible", "parqueo", "peaje"], icon: "🚕" },
  { terms: ["servicios", "luz", "agua", "internet", "telefono", "teléfono", "recarga"], icon: "💡" },
  { terms: ["casa", "hogar", "arriendo", "alquiler", "limpieza", "muebles", "reparacion", "reparación"], icon: "🏠" },
  { terms: ["educacion", "educación", "curso", "colegio", "universidad", "libro", "cuaderno", "matricula", "matrícula"], icon: "📚" },
  { terms: ["familia", "mama", "mamá", "papa", "papá", "hijo", "hija", "regalo", "nino", "niño"], icon: "👨‍👩‍👧" },
  { terms: ["mascota", "mascotas", "perro", "gato", "animal", "veterinaria"], icon: "🐾" },
  { terms: ["ropa", "zapato", "zapatos", "vestido", "camisa", "pantalon", "pantalón", "moda"], icon: "👕" },
  { terms: ["regalo", "cumple", "cumpleaños", "fiesta"], icon: "🎁" },
  { terms: ["belleza", "salon", "salón", "cabello", "uñas", "unas"], icon: "💅" },
];

const PERSONAL_CATEGORY_PRIORITY = [
  "Alimentacion",
  "Entretenimiento",
  "Salud",
  "Transporte",
  "Servicios",
  "Casa",
  "Educacion",
  "Familia",
  "Otros",
];

function categoryButtons(personalOnly?: boolean) {
  return personalOnly ? PERSONAL_CATEGORY_BUTTONS : CATEGORY_BUTTONS;
}

function findPersonalCategoryDefinition(category: string | null | undefined) {
  const normalizedCategory = normalizeText(category || "");
  return PERSONAL_CATEGORY_DEFINITIONS.find((item) => normalizeText(item.category) === normalizedCategory) || null;
}

function inferIconForCategoryName(categoryName: string) {
  const normalized = normalizeText(categoryName);
  const definition = findPersonalCategoryDefinition(categoryName);
  if (definition) return definition.icon;

  const hint = CATEGORY_ICON_HINTS.find((item) => item.terms.some((term) => normalized.includes(term)));
  if (hint) return hint.icon;

  return "🏷️";
}

function findPersonalSubcategory(category: string | null | undefined, subcategory: string | null | undefined) {
  const definition = findPersonalCategoryDefinition(category);
  const normalizedSubcategory = normalizeText(subcategory || "");
  return definition?.subcategories.find((item) =>
    normalizeText(item.subcategory) === normalizedSubcategory ||
    normalizeText(item.label) === normalizedSubcategory
  ) || null;
}

function defaultPersonalSubcategory(category: string | null | undefined) {
  const definition = findPersonalCategoryDefinition(category);
  return definition?.subcategories[0] || definition || PERSONAL_CATEGORY_DEFINITIONS[PERSONAL_CATEGORY_DEFINITIONS.length - 1];
}

function decodePersonalSubcategoryValue(value: string) {
  const [categoryKey, subcategory] = String(value || "").split("|");
  const definition = PERSONAL_CATEGORY_DEFINITIONS.find((item) => normalizeText(item.category) === normalizeText(categoryKey));
  if (!definition) return null;
  return findPersonalSubcategory(definition.category, subcategory) || defaultPersonalSubcategory(definition.category);
}

function inferPersonalCategoryFromText(normalizedText: string): CategoryButton | null {
  if (!normalizedText) return null;

  for (const definition of PERSONAL_CATEGORY_DEFINITIONS) {
    const subcategory = definition.subcategories.find((item) =>
      item.tags.some((tag) => normalizedText.includes(normalizeText(tag).replace(/_/g, " "))) ||
      normalizedText.includes(normalizeText(item.label)) ||
      normalizedText.includes(normalizeText(item.subcategory))
    );
    if (subcategory) return subcategory;
  }

  const definition = PERSONAL_CATEGORY_DEFINITIONS.find((item) =>
    item.terms.some((term) => normalizedText.includes(normalizeText(term))) ||
    normalizedText.includes(normalizeText(item.category)) ||
    normalizedText.includes(normalizeText(item.label))
  );

  return definition ? defaultPersonalSubcategory(definition.category) : null;
}

function normalizePersonalSuggestion(suggestion: ExpenseSuggestion): ExpenseSuggestion {
  const category = normalizeCategoryForScope(suggestion.category, true);
  const normalizedSubcategory = normalizeText(suggestion.subcategory);
  const migratedSubcategory =
    category === "Transporte" && ["movilizacion", "combustible"].includes(normalizedSubcategory)
      ? "COMBUSTIBLE"
      : category === "Alimentacion" && ["abasto", "compras"].includes(normalizedSubcategory)
        ? "SUPERMERCADO"
        : suggestion.subcategory;
  const subcategory = findPersonalSubcategory(category, migratedSubcategory) || defaultPersonalSubcategory(category);

  return {
    ...suggestion,
    category: subcategory.category,
    subcategory: subcategory.subcategory,
    tags: makeTags([...(suggestion.tags || []), ...subcategory.tags]),
  };
}

function categoryButtonText(item: Pick<CategoryButton, "label" | "category" | "callbackValue" | "icon">) {
  const emoji =
    item.icon ||
    CATEGORY_EMOJIS[item.callbackValue || item.category] ||
    inferIconForCategoryName(item.category) ||
    "🏷️";
  return `${emoji} ${item.label}`;
}

function chunkButtons<T>(items: T[], size = 3) {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function normalizeCategoryName(value: unknown) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  if (!cleaned) return "";

  return cleaned
    .split(" ")
    .map((word) => word ? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}` : "")
    .join(" ");
}

function extractCategoryIconAndName(value: unknown) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const parts = raw.split("|").map((item) => item.trim()).filter(Boolean);
  const emojiPattern = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u;
  const explicitIcon = parts.length > 1 && emojiPattern.test(parts[1]) ? parts[1].match(emojiPattern)?.[0] || "" : "";
  const rawName = parts.length > 1 ? parts[0] : raw;
  const leadingIcon = rawName.match(emojiPattern)?.[0] || "";
  const icon = explicitIcon || leadingIcon || raw.match(emojiPattern)?.[0] || inferIconForCategoryName(rawName);
  const name = normalizeCategoryName(rawName.replace(emojiPattern, " ").replace(/\s+/g, " ").trim());

  return { icon, name };
}

function categoryTag(value: string) {
  return normalizeText(value).replace(/\s+/g, "_").toUpperCase().slice(0, 40);
}

function normalizeCategoryForScope(
  category: string,
  personalOnly?: boolean
) {
  if (personalOnly) {
    const normalizedCategory = normalizeText(category);
    if (normalizedCategory === "combustible") return "Transporte";
    if (normalizedCategory === "gastos personales" || normalizedCategory === "personal") return "Otros";
  }
  const buttons = categoryButtons(personalOnly);
  const allowedCategories = new Set(buttons.map((item) => item.category));
  if (allowedCategories.has(category)) return category;
  if (!personalOnly && allowedCategories.has("Otros")) return "Otros";
  if (personalOnly && normalizeText(category) === "gastos personales") return "Otros";
  if (personalOnly && allowedCategories.has("Otros")) return "Otros";
  return "Otros";
}

const RULES = [
  { terms: ["gasto personal", "gastos personales", "retiro personal", "para mi", "para mí", "mio", "mí", "mi plata", "plata mia", "plata mía", "personal mio", "personal mío", "uso personal"], suggestion: CATEGORY_BUTTONS[0] },
  { terms: ["combustible", "gasolina", "diesel", "nafta", "moto", "tanqueo", "llenar tanque", "llenado", "super", "extra", "ecopais", "ecopaís", "lubricadora", "bomba", "surtidor", "aceite", "lavadora"], suggestion: CATEGORY_BUTTONS[1] },
  { terms: ["taxi", "uber", "flete", "envio", "envío", "transporte", "bus", "peaje", "parqueo", "pasaje", "carrera", "motorizado", "didi", "indriver", "mandado", "la vuelta"], suggestion: CATEGORY_BUTTONS[2] },
  { terms: ["proveedor", "compra proveedor", "mercaderia", "mercadería", "pedido", "provee", "entrega"], suggestion: CATEGORY_BUTTONS[3] },
  { terms: ["supermercado", "super mercado", "mercado", "abasto", "despensa", "mi comisariato", "tia", "aki", "gran aki", "santa maria", "santa maría", "compras casa", "compras hogar", "encebollado", "encebolladito", "cebiche", "ceviche", "almuerzo", "merienda", "desayuno", "comida", "comidas", "colacion", "colación", "colada", "cafe", "cafecito", "pan", "bolon", "tigrillo", "chaulafan", "seco", "guatita", "corviche", "empanada", "platano", "plátano", "cola", "gaseosa", "jugo", "agua", "snack", "picada", "caldo", "sopa", "menestra", "bandera", "fritada", "chuzo", "piqueo", "tuky", "colita", "chicha"], suggestion: CATEGORY_BUTTONS[4] },
  { terms: ["farmacia", "medicina", "medicamento", "clinica", "clínica", "doctor", "laboratorio", "consulta", "salud", "chuchaqui", "vitamina", "vitaminas", "pastilla", "pastillas", "inyeccion", "inyección"], suggestion: CATEGORY_BUTTONS[5] },
  { terms: ["funda", "fundas", "cinta", "papeleria", "papelería", "limpieza", "material", "bolsa", "carton", "cartón", "gel", "desinfectante"], suggestion: CATEGORY_BUTTONS[6] },
  { terms: ["sueldo", "anticipo", "prestamo", "nomina", "empleado"], suggestion: CATEGORY_BUTTONS[7] },
  { terms: ["luz", "agua potable", "internet", "netlife", "claro", "cnt", "arriendo", "alquiler", "interagua", "cnel", "servicio", "servicios"], suggestion: CATEGORY_BUTTONS[8] },
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
    .replace(/\b(salida|gasto|gastos|egreso|pago|pague|voy|hacer|hice|hacerme|mandar|manda|mandame|pon|ponme|poner|pasa|pase|darme|dame|una|un|unos|unas|de|del|desde|por|para|con|la|el|lo|los|las|en|caja|tienda|banco|transito|personal|mio|mi|mis|me|mí)\b/g, " ")
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

function parseDraftDate(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00-05:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const short = raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (!short) return null;

  const day = Number(short[1]);
  const month = Number(short[2]);
  const yearRaw = short[3] ? Number(short[3]) : 2026;
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  const date = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00-05:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseCaja(text: string): CajaId | null {
  const normalized = normalizeText(text);
  if (/\b(personal|caja personal|mi caja|caja mia|gasto personal|gastos personales|para mi|para mí|mio|mí|uso personal|plata mia|plata mía)\b/.test(normalized)) return "personal";
  if (/\b(banco|cuenta|transferencia bancaria|dep[oó]sito|deposito|banca)\b/.test(normalized)) return "bank";
  if (/\b(transito|transit|ruta|camino|en camino|voy en camino)\b/.test(normalized)) return "transit";
  if (/\b(tienda|caja|efectivo|principal|local)\b/.test(normalized)) return "safe";
  return null;
}

function hasLocalExpenseCue(normalized: string) {
  return RULES.some((item) => item.terms.some((term) => normalized.includes(term)));
}

function inferMerchantFromText(text: string) {
  const normalized = normalizeText(text);
  const patterns = [
    /\bcompras?\s+(?:en\s+|donde\s+)?(?:el\s+|la\s+)?([a-z][a-z\s]{1,40})$/i,
    /\ben\s+(?:el\s+|la\s+)?([a-z][a-z\s]{1,40})$/i,
    /\bdonde\s+(?:el\s+|la\s+)?([a-z][a-z\s]{1,40})$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1]
      ?.replace(/\b(ayer|hoy|anoche|ahorita|nomas|nomás)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (candidate && candidate.length >= 3) {
      return normalizeCategoryName(candidate);
    }
  }

  return null;
}

function cleanShortExpenseSubject(text: string) {
  return normalizeText(text)
    .replace(/(?:\$|usd)?\s*\d+(?:[.,]\d{1,2})?/gi, " ")
    .replace(/\b(hola|buenas|buenos dias|buenas tardes|buenas noches|porfa|porfavor|favor|gaste|gasto|pague|pago|compre|compra|compras|en|de|donde|el|la|los|las|un|una|ayer|hoy|anoche|manana|mañana|ahorita|nomas|nomás)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferPersonalShortAmountHint(text: string): LocalTextInterpretation | null {
  const normalized = normalizeText(text);
  const amount = parseAmount(normalized);
  if (amount <= 0) return null;

  const subject = cleanShortExpenseSubject(normalized);
  if (!/[a-z]/.test(subject) || subject.length < 3) return null;

  const merchant = normalizeCategoryName(subject);
  const inferred = inferPersonalCategoryFromText(subject);
  const category = inferred?.category || "Otros";
  const subcategory = inferred?.subcategory || "GENERAL";
  const isKnown = Boolean(inferred);

  return {
    isExpense: true,
    amountMissing: false,
    category,
    subcategory,
    from: "personal",
    merchant,
    description: category === "Alimentacion" ? `Compra en ${merchant}` : `Gasto en ${merchant}`,
    confidence: isKnown ? 0.76 : 0.56,
    reasons: [
      `Detecte monto y referencia corta: ${merchant}.`,
      isKnown
        ? `Lo trato como ${category} / ${subcategory}, pero puedes cambiarlo.`
        : "No hay categoria clara; te dejo botones rapidos para elegirla.",
    ],
  };
}

function inferPersonalShoppingHint(text: string): LocalTextInterpretation | null {
  const normalized = normalizeText(text);
  const merchant = inferMerchantFromText(text);
  const mentionsShopping =
    /\b(compra|compras|comprado|compre|mercado|supermercado|super mercado|despensa|abasto)\b/.test(normalized);
  const mentionsStoreOnly =
    Boolean(merchant) && /\b(en|donde)\b/.test(normalized);

  if (!mentionsShopping && !mentionsStoreOnly) return null;

  const inferred = inferPersonalCategoryFromText(normalized);
  const category = inferred?.category || (mentionsShopping ? "Alimentacion" : "Otros");
  const subcategory = inferred?.subcategory || (category === "Alimentacion" ? "TIENDA O MERCADO" : "GENERAL");
  const description = merchant
    ? mentionsShopping
      ? `Compra en ${merchant}`
      : `Gasto en ${merchant}`
    : mentionsShopping
      ? "Compra personal"
      : "Gasto personal";

  return {
    isExpense: true,
    amountMissing: parseAmount(normalized) <= 0,
    category,
    subcategory,
    from: "personal",
    merchant,
    description,
    confidence: mentionsShopping ? 0.88 : 0.62,
    reasons: merchant
      ? [`Comercio detectado: ${merchant}`]
      : ["Texto de compra personal detectado."],
  };
}

function inferAmbiguousPersonalCategory(normalizedText: string) {
  if (!normalizedText) return null;

  if (/\bagua potable\b/.test(normalizedText)) {
    return null;
  }

  const ambiguousCases = [
    {
      pattern: /\bagua\b/,
      reason: 'La palabra "agua" puede ser bebida, botellon o servicio.',
    },
    {
      pattern: /\bcompra\b|\bcompras\b/,
      reason: 'La frase parece una compra general y conviene confirmar la categoria.',
    },
    {
      pattern: /\bpago\b|\bpague\b/,
      reason: 'La palabra "pago" no deja clara la categoria del gasto.',
    },
    {
      pattern: /\brecarga\b/,
      reason: 'La recarga puede corresponder a servicios o transporte.',
    },
  ];

  return ambiguousCases.find((item) => item.pattern.test(normalizedText)) || null;
}

type LocalTextInterpretation = {
  isExpense: boolean;
  amountMissing: boolean;
  category: string | null;
  subcategory: string | null;
  from: CajaId | null;
  merchant: string | null;
  description: string | null;
  confidence: number;
  reasons: string[];
};

async function classifyLocalExpenseText(params: { text: string; personalOnly?: boolean }): Promise<LocalTextInterpretation | null> {
  if (params.personalOnly) {
    const shortAmountHint = inferPersonalShortAmountHint(params.text);
    if (shortAmountHint) return shortAmountHint;

    const shoppingHint = inferPersonalShoppingHint(params.text);
    if (shoppingHint) return shoppingHint;
  }

  const { geminiApiKey, geminiModel } = getTelegramConfig();
  if (!geminiApiKey) return null;

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const prompt = `
Clasifica texto corto de WhatsApp/Telegram escrito por un usuario en Ecuador.

Entiende jerga local, frases incompletas y diminutivos.
Ejemplos que SI suelen ser gasto:
- "encebolladito"
- "la colita"
- "una vuelta"
- "me hice un mandado"
- "tanqueo"
- "carrera"
- "motorizado"
- "la funda"
- "el chuchaqui"
- "para la farmacia"
- "un cafecito"
- "almuerzo de la casa"
- "un tuki"
- "pasaje"
- "una sopa"
- "la merienda"
- "compras chucho"
- "donde el chucho"
- "hola gaste 5 en agua"

Reglas:
- Si no es gasto, responde isExpense=false.
- Si es gasto pero falta monto, amountMissing=true.
- Para el bot personal usa category solo de esta lista: Alimentacion, Entretenimiento, Salud, Transporte, Servicios, Casa, Educacion, Familia, Otros.
- Subcategorias personales sugeridas:
  - Alimentacion: SUPERMERCADO, COMIDA AFUERA, DELIVERY, TIENDA O MERCADO.
  - Entretenimiento: CINE Y EVENTOS, BAR Y SALIDAS, SUSCRIPCIONES, JUEGOS Y HOBBIES.
  - Salud: FARMACIA, CITA MEDICA, LABORATORIO, BIENESTAR.
  - Transporte: TAXI O APP, BUS O PASAJE, COMBUSTIBLE, PARQUEO O PEAJE.
  - Servicios: LUZ, AGUA, INTERNET, TELEFONO.
  - Casa: ARRIENDO, LIMPIEZA, MUEBLES, REPARACIONES.
  - Educacion: CURSOS, LIBROS, COLEGIO O UNIVERSIDAD.
  - Familia: AYUDA FAMILIAR, REGALOS, NINOS.
- Usa from personal si parece gasto personal; bank si parece transferencia o pago bancario; safe si parece caja/tienda; transit si parece movimiento en transito; null si no aplica.
- merchant debe ser el lugar o beneficiario si se infiere.
- description debe ser una frase corta util.
- confidence entre 0 y 1.
- Si el texto no permite decidir con confianza, responde isExpense=false y deja category/subcategory en null.
- Nunca inventes categorias nuevas. Usa solo las existentes.
- Si el texto suena a comida local o bebida, usa Alimentacion.
- Si suena a compra de tienda o supermercado, usa category Alimentacion y subcategory SUPERMERCADO o TIENDA O MERCADO.
- Si suena a cine, bar, salida, hobby o suscripcion de entretenimiento, usa Entretenimiento.
- Si suena a combustible o tanqueo personal, usa Transporte / COMBUSTIBLE.
- Si suena a transporte, carrera o mandado, usa Transporte.
- Si suena a farmacia, consulta, medicina o chuchaqui, usa Salud.
- Si no estas seguro de la categoria personal, usa Otros / GENERAL y baja la confianza.
- Nombres como "Chucho", "Tia", "Aki" o "Mi Comisariato" pueden ser merchant; no los uses como category.
- El anio operativo actual es 2026.

Texto:
${params.text}
`;

  try {
    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isExpense: { type: Type.BOOLEAN },
            amountMissing: { type: Type.BOOLEAN },
            category: { type: Type.STRING, nullable: true },
            subcategory: { type: Type.STRING, nullable: true },
            from: { type: Type.STRING, enum: ["bank", "safe", "transit", "personal"], nullable: true },
            merchant: { type: Type.STRING, nullable: true },
            description: { type: Type.STRING, nullable: true },
            confidence: { type: Type.NUMBER },
            reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["isExpense", "amountMissing", "category", "subcategory", "from", "merchant", "description", "confidence", "reasons"],
        },
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    return {
      isExpense: Boolean(parsed.isExpense),
      amountMissing: Boolean(parsed.amountMissing),
      category: parsed.category || null,
      subcategory: parsed.subcategory || null,
      from: parsed.from || null,
      merchant: parsed.merchant || null,
      description: parsed.description || null,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
    };
  } catch (error: any) {
    console.error("No se pudo clasificar texto personal con Gemini:", error?.message || String(error));
    return null;
  }
}

function isLikelyExpenseText(text: string) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return false;

  const hasExplicitExpenseAction =
    /\b(salida|gasto|egreso|pago|pague|compre|compro|compra|compras|retire|retiro|saque|sacar|mande|gaste|gast[eé]|hice|me hice|me gaste|me gast[eé])\b/.test(normalized);
  const hasKnownExpenseConcept =
    /\b(combustible|gasolina|diesel|taxi|uber|proveedor|fundas|anticipo|sueldo|flete|peaje|parqueo|luz|internet|arriendo|farmacia|medicina|medicamento|clinica|doctor|laboratorio|salud|encebollado|cebiche|ceviche|almuerzo|merienda|desayuno|comida|colacion|cafe|pan|bolon|tigrillo|chaulafan|seco|guatita|corviche|empanada|cola|gaseosa|jugo|snack|picada|gasto personal|gastos personales|retiro personal|para mi|para mí|mio|mí|uso personal|colita|tanqueo|mandado|la vuelta|chuchaqui|cine|bar|netflix|spotify|suscripcion|suscripción|delivery|mercado|supermercado|tienda|chucho|curso|colegio|universidad|dentista|recarga)\b/.test(normalized);
  const hasLocalExpensePhrase =
    /\b\d+(?:[.,]\d{1,2})?\s+(?:en|de|para|por)\s+[a-z]{3,}/.test(normalized) &&
    hasKnownExpenseConcept;
  const hasIncomeLanguage =
    /\b(ingreso|deposite|deposito|recibi|recibido|cobre|cobro|venta|vendi|abono|acreditacion)\b/.test(normalized);

  return !hasIncomeLanguage && (hasExplicitExpenseAction || hasKnownExpenseConcept || hasLocalExpensePhrase || hasLocalExpenseCue(normalized));
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

async function suggestExpense(normalizedText: string, extraValues: Array<unknown> = [], personalOnly?: boolean) {
  const memorySuggestion = await findExpenseMemorySuggestion([normalizedText, ...extraValues], assistantNamespace(personalOnly));
  if (memorySuggestion) {
    const normalizedSuggestion = {
      ...memorySuggestion,
      category: normalizeCategoryForScope(memorySuggestion.category, personalOnly),
      source: "memory" as const,
    };
    return personalOnly ? normalizePersonalSuggestion(normalizedSuggestion) : normalizedSuggestion;
  }

  if (personalOnly) {
    const personalSuggestion = inferPersonalCategoryFromText(normalizedText);
    if (personalSuggestion) {
      return {
        category: personalSuggestion.category,
        subcategory: personalSuggestion.subcategory,
        tags: personalSuggestion.tags,
        keyword: personalSuggestion.label,
        source: "rules" as const,
      };
    }
  }

  const suggestion = ruleSuggestion(normalizedText);
  return {
    ...suggestion,
    category: normalizeCategoryForScope(suggestion.category, personalOnly),
  };
}

async function getPersonalCategoryUsage() {
  const usage = new Map<string, number>();

  try {
    const snapshot = await getFirebaseAdminDb()
      .collection("personalMovements")
      .orderBy("createdAt", "desc")
      .limit(300)
      .get();

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      const category = String(data.category || "").trim();
      const subcategory = normalizeText(data.subcategory || "");
      const tags = Array.isArray(data.tags) ? data.tags.map((tag) => normalizeText(tag)).join(" ") : "";

      if (category) {
        usage.set(category, (usage.get(category) || 0) + 1);
      }

      if (category === "Alimentacion" && (subcategory.includes("supermercado") || subcategory.includes("tienda") || tags.includes("supermercado"))) {
        usage.set("Alimentacion", (usage.get("Alimentacion") || 0) + 1);
      }
    });
  } catch (error: any) {
    console.error("No se pudo ordenar categorias personales por uso:", error?.message || String(error));
  }

  return usage;
}

function personalCategorySort(usage: Map<string, number>) {
  return (a: CategoryButton, b: CategoryButton) => {
    const aKey = a.callbackValue || a.category;
    const bKey = b.callbackValue || b.category;
    const usageDiff = (usage.get(bKey) || 0) - (usage.get(aKey) || 0);
    if (usageDiff !== 0) return usageDiff;

    const aPriority = PERSONAL_CATEGORY_PRIORITY.indexOf(aKey);
    const bPriority = PERSONAL_CATEGORY_PRIORITY.indexOf(bKey);
    return (aPriority === -1 ? 99 : aPriority) - (bPriority === -1 ? 99 : bPriority);
  };
}

async function draftKeyboard(draft: ExpenseDraft) {
  const rows: any[] = [];

  if (!draft.from) {
    rows.push([
      { text: "🏪 Tienda", callback_data: `exp:from:${draft.id}:safe` },
      { text: "🚚 Transito", callback_data: `exp:from:${draft.id}:transit` },
      { text: "🏦 Banco", callback_data: `exp:from:${draft.id}:bank` },
    ]);
    rows.push([
      { text: "👛 Caja Personal", callback_data: `exp:from:${draft.id}:personal` },
    ]);
  }

  if (draft.personalOnly) {
    const usage = await getPersonalCategoryUsage();
    const quickButtons: CategoryButton[] = [
      ...PERSONAL_CATEGORY_DEFINITIONS.find((item) => item.category === "Alimentacion")!.subcategories.slice(0, 2),
      ...PERSONAL_CATEGORY_DEFINITIONS.find((item) => item.category === "Entretenimiento")!.subcategories.slice(0, 2),
      ...PERSONAL_CATEGORY_DEFINITIONS.find((item) => item.category === "Salud")!.subcategories.slice(0, 2),
      ...PERSONAL_CATEGORY_DEFINITIONS.find((item) => item.category === "Transporte")!.subcategories.slice(0, 2),
      ...PERSONAL_CATEGORY_DEFINITIONS.find((item) => item.category === "Servicios")!.subcategories.slice(0, 2),
      { label: "Otros", category: "Otros", subcategory: "GENERAL", tags: ["SIN CLASIFICAR"] },
    ].sort(personalCategorySort(usage));

    chunkButtons(quickButtons, 3).forEach((row) => {
      rows.push(row.map((item) => ({
        text: categoryButtonText(item),
        callback_data: `exp:subcat:${draft.id}:${item.callbackValue || `${item.category}|${item.subcategory}`}`,
      })));
    });
    rows.push([
      { text: "➕ Nueva categoria", callback_data: `exp:newcat:${draft.id}` },
    ]);
  } else {
    rows.push([
      { text: "🍽️ Comida", callback_data: `exp:cat:${draft.id}:Alimentacion` },
      { text: "⛽ Gasolina", callback_data: `exp:cat:${draft.id}:Combustible` },
      { text: "🚕 Transporte", callback_data: `exp:cat:${draft.id}:Transporte` },
      { text: "👤 Personal", callback_data: `exp:cat:${draft.id}:Gastos personales` },
    ]);
  }

  rows.push([
    { text: "✅ Confirmar", callback_data: `exp:confirm:${draft.id}` },
    { text: "🧠 Aprender", callback_data: `exp:learn:${draft.id}` },
    { text: "🏷️ Categoria", callback_data: `exp:categories:${draft.id}` },
    { text: "✖️ Cancelar", callback_data: `exp:cancel:${draft.id}` },
  ]);

  return { inline_keyboard: rows };
}

async function getSavedPersonalCategories() {
  const snapshot = await getFirebaseAdminDb()
    .collection("personalExpenseCategories")
    .orderBy("name", "asc")
    .get();

  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const name = normalizeCategoryName(data?.name || doc.id);
      return name ? { name, icon: String(data?.icon || "🏷️").slice(0, 8) } : null;
    })
    .filter(Boolean) as Array<{ name: string; icon: string }>;
}

async function savePersonalCategory(name: string, createdBy?: string | null) {
  const parsedCategory = extractCategoryIconAndName(name);
  const normalizedName = parsedCategory.name;
  if (!normalizedName) {
    throw new Error("Categoria invalida.");
  }
  const icon = parsedCategory.icon || inferIconForCategoryName(normalizedName);

  const ref = getFirebaseAdminDb()
    .collection("personalExpenseCategories")
    .doc(normalizeText(normalizedName).replace(/\s+/g, "-"));

  await ref.set(
    {
      name: normalizedName,
      icon,
      normalizedName: normalizeText(normalizedName),
      createdBy: createdBy || "telegram-personal-bot",
      source: "telegram",
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { name: normalizedName, icon };
}

async function categoryKeyboard(draftId: string, personalOnly?: boolean) {
  const rows: any[] = [];
  const buttons = categoryButtons(personalOnly);
  const savedCategories = personalOnly ? await getSavedPersonalCategories() : [];
  const usage = personalOnly ? await getPersonalCategoryUsage() : new Map<string, number>();
  const customButtons: CategoryButton[] = savedCategories
    .filter((item) => !buttons.some((button) => button.category === item.name))
    .map((item) => ({
      label: item.name,
      category: item.name,
      subcategory: "GENERAL",
      tags: [categoryTag(item.name), "PERSONAL"],
      icon: item.icon,
    }));
  const allButtons: CategoryButton[] = personalOnly
    ? [...buttons, ...customButtons].sort(personalCategorySort(usage))
    : [...buttons, ...customButtons];
  for (let index = 0; index < allButtons.length; index += 3) {
    rows.push(
      allButtons.slice(index, index + 3).map((item) => ({
        text: categoryButtonText(item),
        callback_data: `exp:cat:${draftId}:${item.callbackValue || item.category}`,
      }))
    );
  }

  if (personalOnly) {
    rows.push([
      { text: "➕ Nueva categoria", callback_data: `exp:newcat:${draftId}` },
    ]);
  }

  return {
    inline_keyboard: rows,
  };
}

function subcategoryKeyboard(draftId: string, category: string) {
  const definition = findPersonalCategoryDefinition(category);
  const rows: any[] = [];
  const subcategories = definition?.subcategories?.length
    ? definition.subcategories
    : [{ label: "General", category, subcategory: "GENERAL", tags: [categoryTag(category), "PERSONAL"], callbackValue: `${category}|GENERAL` }];

  chunkButtons(subcategories, 2).forEach((row) => {
    rows.push(row.map((item) => ({
      text: categoryButtonText(item),
      callback_data: `exp:subcat:${draftId}:${item.callbackValue || `${item.category}|${item.subcategory}`}`,
    })));
  });
  rows.push([
    { text: "🏷️ Cambiar categoria", callback_data: `exp:categories:${draftId}` },
    { text: "✖️ Cancelar", callback_data: `exp:cancel:${draftId}` },
  ]);

  return { inline_keyboard: rows };
}

function registeredMovementKeyboard(movementId: string) {
  return {
    inline_keyboard: [
      [{ text: "🗑️ Eliminar", callback_data: `exp:deleteAsk:${movementId}` }],
    ],
  };
}

function deleteMovementKeyboard(movementId: string) {
  return {
    inline_keyboard: [
      [
        { text: "🗑️ Si, eliminar", callback_data: `exp:deleteConfirm:${movementId}` },
        { text: "↩️ No", callback_data: `exp:deleteCancel:${movementId}` },
      ],
    ],
  };
}

function cajaLabel(value: CajaId | null) {
  if (value === "bank") return "Banco";
  if (value === "transit") return "Transito";
  if (value === "personal") return "Caja Personal";
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

function assistantMenuText(personalOnly = false) {
  if (personalOnly) {
    return [
      "Bot personal disponible.",
      "",
      "Uso:",
      "- Escribe: encebollado 5",
      "- Escribe: la colita 2",
      "- Escribe: 2 en platano",
      "- Escribe: tanqueo 20",
      "- Envia una foto o comprobante y te propongo el gasto.",
      "- Corrige conversando: no, era 8.50 / categoria salud / descripcion farmacia",
      "- Eliminar ultimo: borra la ultima salida creada por este bot.",
      "",
      "Este bot registra solo finanzas personales y no toca cierres ni gastos del negocio.",
    ].join("\n");
  }

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
    "- Escribe: 2 en platano",
    "- Escribe: la vuelta 8",
    "- Escribe: tanqueo 20",
    "- Escribe: combustible 20 tienda",
    "- Escribe: taxi 8 banco",
    "- Escribe: salida proveedor 50 transito",
    "- Si hay una salida pendiente puedes corregir: no, era banco",
    "- Tambien: el monto era 8.50 / categoria personal / descripcion almuerzo",
    "- Eliminar ultimo: borra la ultima salida creada por este bot.",
  ].join("\n");
}

function unclearMovementHelpText(personalOnly = false) {
  if (personalOnly) {
    return [
      "No te entendi como gasto personal.",
      "Si quieres registrar un gasto, dime el monto con una frase corta.",
      "Ejemplos:",
      "- almuerzo 5",
      "- compras chucho 2.75",
      "- gasolina 20",
      "- farmacia 8.50",
    ].join("\n");
  }

  return [
    "No te entendi como salida del negocio.",
    "Si quieres registrar un movimiento, dime el monto con una frase corta.",
    "Ejemplos:",
    "- combustible 20 banco",
    "- proveedor 50 transito",
    "- almuerzo 12 tienda",
    "- ingreso 150 banco",
  ].join("\n");
}

function missingAmountExamples(personalOnly = false) {
  return personalOnly
    ? "Escribe algo como: compras chucho 2.75 / gasolina 20 / almuerzo 5"
    : "Escribe algo como: combustible 20 banco / proveedor 50 transito / almuerzo 5";
}

function missingAmountHelpText(suggestion: ExpenseSuggestion, personalOnly = false) {
  const category = suggestion.category || "gasto";
  const hint = personalOnly || suggestion.category === "Gastos personales" ? "personal" : "del negocio";

  return [
    `Entendi que hablas de ${category.toLowerCase()} ${hint}, pero me falta el monto.`,
    "Escribe el valor junto a la frase, por ejemplo:",
    "- la colita 2",
    "- encebollado 5",
    "- tanqueo 20",
    "- mandado 8",
    "Tambien puedes tocar una categoria o usar los botones rapidos del mensaje del registro.",
  ].join("\n");
}

export function expenseAssistantMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📩 Revisar Gmail", callback_data: "gmail:scanMore" },
        { text: "📋 Ver pendientes", callback_data: "gmail:pending" },
      ],
      [
        { text: "🔎 Revision amplia Gmail", callback_data: "gmail:scanDeep" },
      ],
      [
        { text: "🗑️ Eliminar ultimo", callback_data: "exp:deleteLast" },
        { text: "❔ Ayuda", callback_data: "exp:help" },
      ],
    ],
  };
}

export function personalFinanceBotMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🗑️ Eliminar ultimo", callback_data: "exp:deleteLast" },
        { text: "❔ Ayuda", callback_data: "exp:help" },
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
  const details = [
    draft.date ? `Fecha: ${draft.date}` : "",
    draft.merchant ? `Comercio/beneficiario: ${draft.merchant}` : "",
    draft.destinationAccount ? `Destino: ${draft.destinationAccount}` : "",
    draft.confidence ? `Confianza lectura: ${Math.round(Number(draft.confidence) * 100)}%` : "",
  ].filter(Boolean);
  const review = draft.requiresReview
    ? [
      "",
      "Necesita revision:",
      ...(draft.reviewReasons?.length ? draft.reviewReasons.map((reason) => `- ${reason}`) : ["- Revisa los datos antes de confirmar."]),
    ]
    : [];
  const categoryPrompt =
    draft.personalOnly && (draft.requiresReview || draft.category === "Otros")
      ? [
          "",
          "No estuve seguro de la categoria.",
          "Elige una con los botones rapidos, abre Categoria o usa Nueva categoria.",
        ]
      : [];

  return [
    "Salida detectada.",
    `Monto: USD ${draft.amount.toFixed(2)}`,
    `Caja: ${cajaLabel(draft.from)}`,
    `Categoria: ${draft.category}`,
    `Subcategoria: ${draft.subcategory || "GENERAL"}`,
    `Descripcion: ${draft.description}`,
    ...details,
    draft.suggestionSource === "memory" ? "Memoria: usada" : "Memoria: nueva regla",
    ...review,
    ...categoryPrompt,
    "",
    draft.from ? "Confirma o corrige conversando: monto, caja, categoria, subcategoria o descripcion." : "Elige primero de donde salio el dinero.",
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

async function setActiveDraftForChat(chatId: number | string, draftId: string | null, personalOnly?: boolean) {
  const db = getFirebaseAdminDb();
  const ref = db.collection(activeChatCollectionName(personalOnly)).doc(String(chatId));

  await ref.set(
    {
      chatId: String(chatId),
      draftId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function setLearningDraftForChat(chatId: number | string, draftId: string | null, personalOnly?: boolean) {
  const db = getFirebaseAdminDb();
  const ref = db.collection(learningChatCollectionName(personalOnly)).doc(String(chatId));

  await ref.set(
    {
      chatId: String(chatId),
      draftId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function setCategoryCreationDraftForChat(chatId: number | string, draftId: string | null, personalOnly?: boolean) {
  const db = getFirebaseAdminDb();
  const ref = db.collection(categoryCreationChatCollectionName(personalOnly)).doc(String(chatId));

  await ref.set(
    {
      chatId: String(chatId),
      draftId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getLearningDraftForChat(chatId: number | string, personalOnly?: boolean): Promise<ExpenseDraft | null> {
  const db = getFirebaseAdminDb();
  const active = await db.collection(learningChatCollectionName(personalOnly)).doc(String(chatId)).get();
  const draftId = active.data()?.draftId ? String(active.data()?.draftId) : "";
  if (!draftId) return null;
  const draft = await getDraft(draftId, personalOnly);
  if (!draft || draft.status !== "pending") return null;
  return draft;
}

async function getCategoryCreationDraftForChat(chatId: number | string, personalOnly?: boolean): Promise<ExpenseDraft | null> {
  const db = getFirebaseAdminDb();
  const active = await db.collection(categoryCreationChatCollectionName(personalOnly)).doc(String(chatId)).get();
  const draftId = active.data()?.draftId ? String(active.data()?.draftId) : "";
  if (!draftId) return null;
  const draft = await getDraft(draftId, personalOnly);
  if (!draft || draft.status !== "pending") return null;
  return draft;
}

async function saveDraft(draft: ExpenseDraft) {
  const db = getFirebaseAdminDb();
  const ref = db.collection(draftCollectionName(draft.personalOnly)).doc();
  const saved = { ...draft, id: ref.id };

  await ref.set({
    ...saved,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await setActiveDraftForChat(saved.chatId, ref.id, saved.personalOnly);

  return saved;
}

async function updateDraft(draftId: string, values: Partial<ExpenseDraft>, personalOnly?: boolean) {
  const db = getFirebaseAdminDb();
  await db.collection(draftCollectionName(personalOnly)).doc(draftId).set(
    {
      ...values,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getDraft(draftId: string, personalOnly?: boolean): Promise<ExpenseDraft | null> {
  const doc = await getFirebaseAdminDb().collection(draftCollectionName(personalOnly)).doc(draftId).get();
  return doc.exists ? ({ id: doc.id, ...doc.data() } as ExpenseDraft) : null;
}

async function findLatestPendingDraftForChat(chatId: number | string, personalOnly?: boolean): Promise<ExpenseDraft | null> {
  const db = getFirebaseAdminDb();
  const active = await db.collection(activeChatCollectionName(personalOnly)).doc(String(chatId)).get();
  const activeDraftId = active.data()?.draftId ? String(active.data()?.draftId) : "";

  if (activeDraftId) {
    const activeDraft = await getDraft(activeDraftId, personalOnly);
    if (activeDraft && activeDraft.status === "pending" && String(activeDraft.chatId) === String(chatId)) {
      return activeDraft;
    }
  }

  const snapshot = await getFirebaseAdminDb()
    .collection(draftCollectionName(personalOnly))
    .orderBy("updatedAt", "desc")
    .limit(200)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (String(data.chatId || "") === String(chatId) && data.status === "pending") {
      await setActiveDraftForChat(chatId, doc.id, personalOnly);
      return { id: doc.id, ...data } as ExpenseDraft;
    }
  }

  return null;
}

async function findCategoryFromText(normalizedText: string, personalOnly?: boolean) {
  if (personalOnly) {
    const personalCategory = inferPersonalCategoryFromText(normalizedText);
    if (personalCategory) return personalCategory;
  }

  const buttons = categoryButtons(personalOnly);
  const byCategory = buttons.find((item) =>
    normalizeText(item.category) === normalizedText ||
    normalizeText(item.label) === normalizedText ||
    normalizedText.includes(normalizeText(item.category)) ||
    normalizedText.includes(normalizeText(item.label))
  );
  if (byCategory) return byCategory;

  if (personalOnly) {
    const savedCategories = await getSavedPersonalCategories();
    const custom = savedCategories.find((item) => {
      const normalizedCategory = normalizeText(item.name);
      return normalizedCategory === normalizedText || normalizedText.includes(normalizedCategory);
    });
    if (custom) {
      return {
        label: custom.name,
        category: custom.name,
        subcategory: "GENERAL",
        tags: [categoryTag(custom.name), "PERSONAL"],
        icon: custom.icon,
      };
    }
  }

  const suggestion = ruleSuggestion(normalizedText);
  if (personalOnly && !PERSONAL_CATEGORY_BUTTONS.some((item) => item.category === suggestion.category)) {
    return null;
  }
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

function merchantCorrection(text: string) {
  const raw = String(text || "").trim();
  const match = raw.match(/\b(?:comercio|proveedor|beneficiario|local|empresa|persona)\s*:?\s*(.+)$/i);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim().slice(0, 140);
}

function dateCorrection(text: string) {
  const raw = String(text || "").trim();
  const explicit = raw.match(/\b(?:fecha|dia|d[ií]a)\s*:?\s*(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})/i);
  const loose = raw.match(/\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/);
  const value = explicit?.[1] || loose?.[1] || "";
  if (!value) return "";
  const date = parseDraftDate(value);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
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
    "- 2 en platano",
    "- fecha 03/07/2026",
    "- comercio Farmacia Cruz Azul",
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
  personalOnly?: boolean;
}) {
  const normalized = normalizeText(params.text);
  const menuKeyboard = params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard();

  if (/\b(cancelar|cancela|anular|olvida)\b/.test(normalized)) {
    await updateDraft(params.draft.id!, { status: "cancelled" }, params.personalOnly);
    await setActiveDraftForChat(params.chatId, null, params.personalOnly);
    await sendTelegramMessage(
      params.chatId,
      "Salida cancelada. No se guardo ningun movimiento.",
      params.botToken,
      { reply_markup: menuKeyboard }
    );
    return { handled: true, corrected: true, cancelled: true, draftId: params.draft.id };
  }

  if (/^(confirmar|confirma|registrar|registra|listo|ok|dale|guardar|guarda)$/.test(normalized)) {
    try {
      const movementId = await createMovementFromDraft(params.draft);
      await setActiveDraftForChat(params.chatId, null, params.personalOnly);
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
        { reply_markup: await draftKeyboard(params.draft) }
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

  const category = await findCategoryFromText(normalized, params.personalOnly);
  if (category && category.category !== params.draft.category) {
    updates.category = category.category;
    updates.subcategory = category.subcategory;
    updates.tags = makeTags(category.tags);
    updates.suggestionSource = "manual";
    updates.suggestionKeyword = category.label;
    changed.push(`Categoria: ${category.category}`);
  }

  if (category?.category === "Gastos personales" && params.draft.from !== "personal") {
    updates.from = "personal";
    changed.push("Caja: Caja Personal");
  }

  const newDescription = descriptionCorrection(params.text);
  if (newDescription && newDescription !== params.draft.description) {
    updates.description = newDescription;
    updates.text = `${params.draft.text}\nCorreccion: ${params.text}`.slice(0, 800);
    updates.normalizedText = normalizeText([params.draft.normalizedText, params.text].join(" "));
    changed.push(`Descripcion: ${newDescription}`);
  }

  const newMerchant = merchantCorrection(params.text);
  if (newMerchant && newMerchant !== params.draft.merchant) {
    updates.merchant = newMerchant;
    updates.text = `${updates.text || params.draft.text}\nCorreccion: ${params.text}`.slice(0, 800);
    updates.normalizedText = normalizeText([updates.normalizedText || params.draft.normalizedText, params.text].join(" "));
    changed.push(`Comercio/beneficiario: ${newMerchant}`);
  }

  const newDate = dateCorrection(params.text);
  if (newDate && newDate !== params.draft.date) {
    updates.date = newDate;
    changed.push(`Fecha: ${newDate}`);
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
      { reply_markup: await draftKeyboard(params.draft) }
    );
    return { handled: true, corrected: false, draftId: params.draft.id };
  }

  const updatedDraft = { ...params.draft, ...updates };
  await updateDraft(params.draft.id!, updates, params.personalOnly);
  await sendTelegramMessage(
    params.chatId,
    [
      "Correccion aplicada.",
      ...changed.map((item) => `- ${item}`),
      "",
      draftText(updatedDraft),
    ].join("\n"),
    params.botToken,
    { reply_markup: await draftKeyboard(updatedDraft) }
  );

  return { handled: true, corrected: true, draftId: params.draft.id, updates };
}

async function learnFromDraft(draft: ExpenseDraft, movementId?: string) {
  await learnExpenseMemory({
    keywords: [
      draft.suggestionKeyword,
      draft.merchant,
      draft.destinationAccount,
      draft.sourceAccount,
      draft.description,
      draft.text,
      draft.extractedText,
      normalizeKeyword(draft.text),
    ],
    category: draft.category,
    subcategory: draft.subcategory || "GENERAL",
    tags: draft.tags || [],
    movementId: movementId || draft.movementId || null,
    source: draft.suggestionSource || "telegram",
    namespace: assistantNamespace(draft.personalOnly),
  });
}

async function learnAliasFromDraft(draft: ExpenseDraft, aliasText: string) {
  const alias = normalizeKeyword(aliasText) || normalizeText(aliasText);
  if (!alias || alias.length < 2) {
    throw new Error("Alias invalido.");
  }

  await learnExpenseMemory({
    keywords: [
      alias,
      draft.suggestionKeyword,
      draft.merchant,
      draft.destinationAccount,
      draft.sourceAccount,
      draft.description,
      draft.text,
      draft.extractedText,
    ],
    category: draft.category,
    subcategory: draft.subcategory || "GENERAL",
    tags: draft.tags || [],
    movementId: draft.movementId || draft.id || null,
    source: "manual",
    namespace: assistantNamespace(draft.personalOnly),
  });
}

async function getExpenseMovementForChat(movementId: string, chatId?: number | string | null, personalOnly?: boolean) {
  const db = getFirebaseAdminDb();
  const candidates = [
    await db.collection(personalOnly ? "personalMovements" : "movements").doc(movementId).get(),
  ];

  for (const doc of candidates) {
    if (!doc.exists) continue;

    const data = doc.data() || {};
    const isExpenseAssistantMovement =
      ["outflow", "expense"].includes(String(data.type || "")) &&
      data.source === "telegram" &&
      data.telegramProvider === "expense-assistant";

    if (!isExpenseAssistantMovement) continue;
    if (chatId && String(data.telegramChatId || "") !== String(chatId)) continue;

    return { id: doc.id, ref: doc.ref, data };
  }

  return null;
}

async function findLastExpenseMovementForChat(chatId: number | string, personalOnly?: boolean) {
  const db = getFirebaseAdminDb();
  const snapshots = await Promise.all([
    db.collection(personalOnly ? "personalMovements" : "movements").orderBy("createdAt", "desc").limit(50).get(),
  ]);

  const matches: Array<{ id: string; ref: any; data: any }> = [];
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (
        ["outflow", "expense"].includes(String(data.type || "")) &&
        data.source === "telegram" &&
        data.telegramProvider === "expense-assistant" &&
        String(data.telegramChatId || "") === String(chatId)
      ) {
        matches.push({ id: doc.id, ref: doc.ref, data });
      }
    }
  }

  return matches
    .sort((a, b) => {
      const aMillis = a.data.createdAt?.toMillis?.() || 0;
      const bMillis = b.data.createdAt?.toMillis?.() || 0;
      return bMillis - aMillis;
    })[0] || null;
}

async function deleteExpenseMovement(params: {
  movementId: string;
  chatId?: number | string | null;
  deletedBy?: string | null;
  personalOnly?: boolean;
}) {
  const movement = await getExpenseMovementForChat(params.movementId, params.chatId, params.personalOnly);
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

async function ensureDefaultPersonalTelegramBox(chatId: string) {
  const db = getFirebaseAdminDb();
  const ref = db.collection("personalCashBoxes").doc(`telegram-${chatId}`);
  const doc = await ref.get();

  if (!doc.exists) {
    await ref.set({
      name: "TELEGRAM PERSONAL",
      type: "wallet",
      openingBalance: 0,
      color: "#8B5CF6",
      isActive: true,
      createdBy: "telegram-personal-bot",
      createdAt: FieldValue.serverTimestamp(),
      telegramChatId: chatId,
    });
  }

  return ref.id;
}

async function createMovementFromDraft(draft: ExpenseDraft) {
  if (!draft.from) throw new Error("Falta caja origen.");
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) throw new Error("Monto invalido.");

  const db = getFirebaseAdminDb();
  const movementDate = parseDraftDate(draft.date) || new Date();
  if (draft.from === "personal") {
    const boxId = await ensureDefaultPersonalTelegramBox(draft.chatId);
    const ref = db.collection("personalMovements").doc();

    await ref.set({
      date: Timestamp.fromDate(movementDate),
      type: "expense",
      amount: draft.amount,
      description: `[TELEGRAM] ${draft.description}`.toUpperCase().slice(0, 500),
      category: draft.category || "Otros",
      subcategory: draft.subcategory || null,
      tags: draft.tags || [],
      fromBoxId: boxId,
      toBoxId: null,
      merchant: draft.merchant || null,
      sourceAccount: draft.sourceAccount || null,
      destinationAccount: draft.destinationAccount || null,
      createdBy: "telegram-personal-bot",
      createdByName: draft.telegramFirstName || draft.telegramUserName || "Telegram",
      source: "telegram",
      telegramProvider: "expense-assistant",
      telegramRequiresReview: Boolean(draft.requiresReview),
      telegramConfidence: draft.confidence || (draft.suggestionSource === "memory" ? 0.95 : 0.75),
      telegramChatId: draft.chatId,
      telegramMessageId: draft.messageId || null,
      telegramUserId: draft.telegramUserId || null,
      telegramUserName: draft.telegramUserName || null,
      telegramFirstName: draft.telegramFirstName || null,
      telegramRawExtraction: {
        text: draft.text,
        normalizedText: draft.normalizedText,
        extractedText: draft.extractedText || null,
        suggestionSource: draft.suggestionSource,
        suggestionKeyword: draft.suggestionKeyword || null,
        reviewReasons: draft.reviewReasons || [],
      },
      createdAt: FieldValue.serverTimestamp(),
    });

    await learnFromDraft(draft, ref.id);
    await updateDraft(draft.id!, { status: "confirmed", movementId: ref.id }, draft.personalOnly);
    await setActiveDraftForChat(draft.chatId, null, draft.personalOnly);

    return ref.id;
  }

  const ref = db.collection("movements").doc();

  await ref.set({
    date: Timestamp.fromDate(movementDate),
    type: "outflow",
    amount: draft.amount,
    description: `[TELEGRAM] ${draft.description}`.toUpperCase().slice(0, 500),
    createdBy: "telegram-bot",
    from: draft.from,
    to: null,
    category: draft.category,
    subcategory: draft.subcategory || null,
    tags: draft.tags || [],
    merchant: draft.merchant || null,
    sourceAccount: draft.sourceAccount || null,
    destinationAccount: draft.destinationAccount || null,
    source: "telegram",
    telegramProvider: "expense-assistant",
    telegramRequiresReview: Boolean(draft.requiresReview),
    telegramConfidence: draft.confidence || (draft.suggestionSource === "memory" ? 0.95 : 0.75),
    telegramChatId: draft.chatId,
    telegramMessageId: draft.messageId || null,
    telegramUserId: draft.telegramUserId || null,
    telegramUserName: draft.telegramUserName || null,
    telegramFirstName: draft.telegramFirstName || null,
    telegramRawExtraction: {
      text: draft.text,
      normalizedText: draft.normalizedText,
      extractedText: draft.extractedText || null,
      suggestionSource: draft.suggestionSource,
      suggestionKeyword: draft.suggestionKeyword || null,
      reviewReasons: draft.reviewReasons || [],
    },
    createdAt: FieldValue.serverTimestamp(),
  });

  await learnFromDraft(draft, ref.id);
  await updateDraft(draft.id!, { status: "confirmed", movementId: ref.id }, draft.personalOnly);
  await setActiveDraftForChat(draft.chatId, null, draft.personalOnly);

  return ref.id;
}

async function autoRegisterPersonalKnownExpense(params: {
  chatId: number | string;
  message: any;
  botToken?: string;
  text: string;
  normalizedText: string;
  amount: number;
  suggestion: ExpenseSuggestion;
  merchant?: string | null;
}) {
  const draft = await saveDraft({
    chatId: String(params.chatId),
    personalOnly: true,
    messageId: params.message.message_id || null,
    telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
    telegramUserName: params.message.from?.username || null,
    telegramFirstName: params.message.from?.first_name || null,
    text: params.text,
    normalizedText: params.normalizedText,
    date: dateCorrection(params.text) || null,
    amount: params.amount,
    from: "personal",
    category: params.suggestion.category,
    subcategory: params.suggestion.subcategory,
    tags: makeTags(params.suggestion.tags),
    description: params.text.replace(/\s+/g, " ").slice(0, 180),
    merchant: params.merchant || null,
    confidence: 0.96,
    requiresReview: false,
    reviewReasons: [],
    status: "pending",
    suggestionSource: "memory",
    suggestionKeyword: params.suggestion.keyword || null,
  });

  const movementId = await createMovementFromDraft(draft);
  await sendTelegramMessage(
    params.chatId,
    [
      "Salida registrada con memoria.",
      `Monto: USD ${params.amount.toFixed(2)}`,
      `Categoria: ${draft.category}`,
      `Subcategoria: ${draft.subcategory || "GENERAL"}`,
      `Movimiento: ${movementId}`,
      "",
      "Si esta mal, puedes eliminarla o registrar una nueva correccion.",
    ].join("\n"),
    params.botToken,
    { reply_markup: registeredMovementKeyboard(movementId) }
  );

  return { handled: true, autoRegistered: true, movementId, draftId: draft.id };
}

export async function processExpenseAssistantMessage(params: {
  chatId: number | string;
  message: any;
  botToken?: string;
  personalOnly?: boolean;
}) {
  const text = String(params.message.text || params.message.caption || "").trim();
  const menuKeyboard = params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard();
  if (isMenuRequest(text)) {
    await sendTelegramMessage(
      params.chatId,
      assistantMenuText(Boolean(params.personalOnly)),
      params.botToken,
      { reply_markup: menuKeyboard }
    );
    return { handled: true, menu: true };
  }

  const categoryCreationDraft = await getCategoryCreationDraftForChat(params.chatId, params.personalOnly);
  if (categoryCreationDraft) {
    try {
      const category = await savePersonalCategory(
        text,
        params.message.from?.id ? String(params.message.from.id) : null
      );
      const updatedDraft = {
        ...categoryCreationDraft,
        category: category.name,
        subcategory: "GENERAL",
        tags: makeTags([categoryTag(category.name), "PERSONAL"]),
        from: "personal" as CajaId,
        suggestionSource: "manual",
        suggestionKeyword: category.name,
      };
      await updateDraft(categoryCreationDraft.id!, {
        category: category.name,
        subcategory: "GENERAL",
        tags: makeTags([categoryTag(category.name), "PERSONAL"]),
        from: "personal",
        suggestionSource: "manual",
        suggestionKeyword: category.name,
      }, params.personalOnly);
      await setCategoryCreationDraftForChat(params.chatId, null, params.personalOnly);
      await setActiveDraftForChat(params.chatId, categoryCreationDraft.id!, params.personalOnly);
      await sendTelegramMessage(
        params.chatId,
        [
          `Categoria creada: ${category.icon} ${category.name}.`,
          "Ya la deje aplicada a esta salida.",
          "",
          draftText(updatedDraft),
        ].join("\n"),
        params.botToken,
        { reply_markup: await draftKeyboard(updatedDraft) }
      );
      return { handled: true, categoryCreated: true, draftId: categoryCreationDraft.id, category: category.name, icon: category.icon };
    } catch (error: any) {
      await sendTelegramMessage(
        params.chatId,
        `No pude crear esa categoria: ${error?.message || String(error)}`,
        params.botToken,
        { reply_markup: await draftKeyboard(categoryCreationDraft) }
      );
      return { handled: true, categoryCreated: false, error: error?.message || String(error) };
    }
  }

  const learningDraft = await getLearningDraftForChat(params.chatId, params.personalOnly);
  if (learningDraft) {
    try {
      await learnAliasFromDraft(learningDraft, text);
      await setLearningDraftForChat(params.chatId, null, params.personalOnly);
      await sendTelegramMessage(
        params.chatId,
        [
          "Aprendido.",
          `Voy a relacionar "${normalizeText(text)}" con ${learningDraft.category}.`,
          learningDraft.merchant ? `Tambien voy a usar ${learningDraft.merchant} como pista.` : "",
          "La próxima vez lo reconoceré mejor.",
        ].filter(Boolean).join("\n"),
        params.botToken,
        { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() }
      );
      return { handled: true, learnedAlias: true, draftId: learningDraft.id };
    } catch (error: any) {
      await sendTelegramMessage(
        params.chatId,
        `No pude aprender esa palabra: ${error?.message || String(error)}`,
        params.botToken,
        { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() }
      );
      return { handled: true, learnedAlias: false, error: error?.message || String(error) };
    }
  }

  if (isGmailScanRequest(text)) {
    if (params.personalOnly) {
      await sendTelegramMessage(
        params.chatId,
        [
          "Este bot es solo para finanzas personales.",
          "No revisa Gmail del negocio ni registra movimientos operativos.",
          "Para registrar un gasto personal escribe algo como: almuerzo 5",
        ].join("\n"),
        params.botToken,
        { reply_markup: menuKeyboard }
      );
      return { handled: true, personalOnly: true, gmailBlocked: true };
    }

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
        { reply_markup: menuKeyboard }
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
      ? await getExpenseMovementForChat(movementId, params.chatId, params.personalOnly)
      : await findLastExpenseMovementForChat(params.chatId, params.personalOnly);

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
    const pendingDraft = await findLatestPendingDraftForChat(params.chatId, params.personalOnly);
    if (pendingDraft) {
      return processDraftCorrection({
        chatId: params.chatId,
        message: params.message,
        botToken: params.botToken,
        draft: pendingDraft,
        text,
        personalOnly: params.personalOnly,
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
      { reply_markup: menuKeyboard }
    );
    return { handled: true, correction: true, foundDraft: false };
  }

  const normalizedText = normalizeText(text);
  const parsedAmount = parseAmount(normalizedText);
  const personalAmbiguousCategory = params.personalOnly
    ? inferAmbiguousPersonalCategory(normalizedText)
    : null;
  if (!isLikelyExpenseText(text)) {
    if (params.personalOnly && parsedAmount > 0) {
      const memorySuggestion = await suggestExpense(normalizedText, [], true);
      if (memorySuggestion.source === "memory") {
        return autoRegisterPersonalKnownExpense({
          chatId: params.chatId,
          message: params.message,
          botToken: params.botToken,
          text,
          normalizedText,
          amount: parsedAmount,
          suggestion: memorySuggestion,
          merchant: cleanShortExpenseSubject(normalizedText) || null,
        });
      }
    }

    const localHint = await classifyLocalExpenseText({ text, personalOnly: params.personalOnly });
    if (!localHint?.isExpense) {
      await sendTelegramMessage(
        params.chatId,
        unclearMovementHelpText(Boolean(params.personalOnly)),
        params.botToken,
        { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() }
      );
      return { handled: true, unclear: true };
    }

    if (parsedAmount > 0) {
      const localCategoryLabel = localHint.category
        ? normalizeCategoryForScope(localHint.category, params.personalOnly)
        : params.personalOnly ? "Otros" : "Gastos personales";
      const personalSubcategory = params.personalOnly
        ? findPersonalSubcategory(localCategoryLabel, localHint.subcategory) || defaultPersonalSubcategory(localCategoryLabel)
        : null;
      const finalCategory = personalAmbiguousCategory ? "Otros" : localCategoryLabel;
      const finalSubcategory = personalAmbiguousCategory ? "GENERAL" : (personalSubcategory?.subcategory || localHint.subcategory || "GENERAL");
      const finalReviewReasons = [
        ...(localHint.reasons || []),
        ...(personalAmbiguousCategory ? [personalAmbiguousCategory.reason] : []),
      ].filter(Boolean);
      const localSuggestion = {
        category: finalCategory,
        subcategory: finalSubcategory,
        tags: makeTags([
          ...(personalSubcategory?.tags || []),
          finalCategory,
          finalSubcategory,
          params.personalOnly ? "PERSONAL" : "",
          personalAmbiguousCategory ? "REVISION_CATEGORIA" : "",
        ]),
        source: "manual" as const,
        keyword: localHint.merchant || undefined,
      };
      const draft = await saveDraft({
        chatId: String(params.chatId),
        personalOnly: Boolean(params.personalOnly),
        messageId: params.message.message_id || null,
        telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
        telegramUserName: params.message.from?.username || null,
        telegramFirstName: params.message.from?.first_name || null,
        text,
        normalizedText,
        date: dateCorrection(text) || null,
        amount: parsedAmount,
        from: params.personalOnly
          ? "personal"
          : localHint.from || parseCaja(normalizedText) || (localCategoryLabel === "Gastos personales" ? "personal" : null),
        category: localSuggestion.category,
        subcategory: localSuggestion.subcategory,
        tags: localSuggestion.tags,
        description: (localHint.description || text).replace(/\s+/g, " ").slice(0, 180),
        merchant: localHint.merchant || null,
        confidence: localHint.confidence,
        requiresReview: localHint.confidence < 0.75 || Boolean(personalAmbiguousCategory),
        reviewReasons: finalReviewReasons,
        status: "pending",
        suggestionSource: localSuggestion.source,
        suggestionKeyword: localSuggestion.keyword || null,
      });

      await sendTelegramMessage(params.chatId, draftText(draft), params.botToken, {
        reply_markup: await draftKeyboard(draft),
      });

      return { handled: true, amountDetectedFromHint: true, draft };
    }

    const localCategoryLabel = localHint.category
      ? normalizeCategoryForScope(localHint.category, params.personalOnly)
      : null;
    const hintMessage = localHint.category
      ? [
          `Entendi que hablas de ${localCategoryLabel?.toLowerCase() || "un gasto"}.`,
          localHint.merchant ? `Parece relacionado con ${localHint.merchant}.` : "",
          "Me falta el monto.",
          missingAmountExamples(Boolean(params.personalOnly)),
        ].filter(Boolean).join("\n")
      : missingAmountHelpText({ category: "Otros", subcategory: "GENERAL", tags: [], source: "default" }, Boolean(params.personalOnly));

    await sendTelegramMessage(
      params.chatId,
      hintMessage,
      params.botToken,
      { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() }
    );
    return { handled: true, missingAmount: true, hint: localHint };
  }

  const suggestion = await suggestExpense(normalizedText, [], params.personalOnly);
  const amount = parsedAmount;
  if (amount <= 0) {
    const localHint = await classifyLocalExpenseText({ text, personalOnly: params.personalOnly });
    const localCategoryLabel = localHint?.category
      ? normalizeCategoryForScope(localHint.category, params.personalOnly)
      : null;
    await sendTelegramMessage(
      params.chatId,
      localCategoryLabel
        ? [
            `Entendi que hablas de ${localCategoryLabel.toLowerCase()}.`,
            localHint.merchant ? `Parece relacionado con ${localHint.merchant}.` : "",
            "Me falta el monto.",
            missingAmountExamples(Boolean(params.personalOnly)),
          ].filter(Boolean).join("\n")
        : [
            `Entendi que quieres registrar un movimiento ${params.personalOnly ? "personal" : "del negocio"}, pero me falta el monto.`,
            missingAmountExamples(Boolean(params.personalOnly)),
          ].join("\n"),
      params.botToken,
      { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() }
    );
    return { handled: true, missingAmount: true, suggestion };
  }
  const from = params.personalOnly
    ? "personal"
    : parseCaja(normalizedText) || (suggestion.category === "Gastos personales" ? "personal" : null);
  const description = text.replace(/\s+/g, " ").slice(0, 180);
  const finalCategory = personalAmbiguousCategory ? "Otros" : suggestion.category;
  const finalSubcategory = personalAmbiguousCategory ? "GENERAL" : suggestion.subcategory;
  const finalTags = personalAmbiguousCategory
    ? makeTags([...(suggestion.tags || []), "REVISION_CATEGORIA"])
    : makeTags(suggestion.tags);
  const requiresPersonalReview =
    Boolean(personalAmbiguousCategory) ||
    (params.personalOnly && suggestion.source === "default");

  if (params.personalOnly && suggestion.source === "memory" && !requiresPersonalReview) {
    return autoRegisterPersonalKnownExpense({
      chatId: params.chatId,
      message: params.message,
      botToken: params.botToken,
      text,
      normalizedText,
      amount,
      suggestion,
      merchant: null,
    });
  }

  const draft = await saveDraft({
    chatId: String(params.chatId),
    personalOnly: Boolean(params.personalOnly),
    messageId: params.message.message_id || null,
    telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
    telegramUserName: params.message.from?.username || null,
    telegramFirstName: params.message.from?.first_name || null,
    text,
    normalizedText,
    date: dateCorrection(text) || null,
    amount,
    from,
    category: finalCategory,
    subcategory: finalSubcategory,
    tags: finalTags,
    description,
    requiresReview: requiresPersonalReview,
    reviewReasons: personalAmbiguousCategory
      ? [personalAmbiguousCategory.reason]
      : requiresPersonalReview
        ? ["No encontre una categoria personal clara; elige categoria y subcategoria."]
        : [],
    status: "pending",
    suggestionSource: suggestion.source,
    suggestionKeyword: suggestion.keyword || null,
  });

  await sendTelegramMessage(params.chatId, draftText(draft), params.botToken, {
    reply_markup: await draftKeyboard(draft),
  });

  return { handled: true, draftId: draft.id };
}

export async function processExpenseAssistantPhoto(params: {
  chatId: number | string;
  message: any;
  largestPhoto: any;
  botToken?: string;
  personalOnly?: boolean;
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
        { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() }
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
    ], params.personalOnly);
    const category = suggestion.source === "memory" ? suggestion.category : extraction.category || suggestion.category;
    const subcategory = suggestion.source === "memory" ? suggestion.subcategory : extraction.subcategory || suggestion.subcategory || "GENERAL";
    const description = (
      extraction.description ||
      caption ||
      "Gasto detectado desde captura"
    ).replace(/\s+/g, " ").slice(0, 180);

    const draft = await saveDraft({
      chatId: String(params.chatId),
      personalOnly: Boolean(params.personalOnly),
      messageId: params.message.message_id || null,
      telegramUserId: params.message.from?.id ? String(params.message.from.id) : null,
      telegramUserName: params.message.from?.username || null,
      telegramFirstName: params.message.from?.first_name || null,
      text: caption || extraction.extractedText || extraction.description,
      normalizedText,
      date: extraction.date || null,
      amount: Number(extraction.amount),
      from: params.personalOnly
        ? "personal"
        : extraction.suggestedFrom || parseCaja(normalizedText) || (category === "Gastos personales" ? "personal" : null),
      category,
      subcategory,
      tags: makeTags([
        ...(extraction.tags || []),
        category,
        subcategory,
        "OCR",
      ]),
      description,
      merchant: extraction.merchant || null,
      sourceAccount: extraction.sourceAccount || null,
      destinationAccount: extraction.destinationAccount || null,
      extractedText: extraction.extractedText || null,
      confidence: extraction.confidence || null,
      requiresReview: Boolean(extraction.requiresReview),
      reviewReasons: extraction.reasons || [],
      status: "pending",
      suggestionSource: suggestion.source === "memory" ? "memory" : "ocr",
      suggestionKeyword: extraction.merchant || suggestion.keyword || null,
    });

    await sendTelegramMessage(params.chatId, draftText(draft), params.botToken, {
      reply_markup: await draftKeyboard(draft),
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
  personalOnly?: boolean;
}) {
  const data = String(params.callbackQuery.data || "");
  if (data.startsWith("gmail:")) {
    if (params.personalOnly) {
      return { handled: true, ignored: true, reason: "Personal bot does not handle Gmail callbacks" };
    }
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
        text: assistantMenuText(Boolean(params.personalOnly)),
        botToken: params.botToken,
        extraPayload: { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() },
      });
    }
    return { handled: true, menu: true };
  }

  if (action === "deleteLast") {
    const movement = chatId ? await findLastExpenseMovementForChat(chatId, params.personalOnly) : null;
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: movement
          ? movementDeleteText(movement.id, movement.data)
          : "No encontre una salida reciente de este bot para eliminar.",
        botToken: params.botToken,
        extraPayload: movement ? { reply_markup: deleteMovementKeyboard(movement.id) } : { reply_markup: params.personalOnly ? personalFinanceBotMenuKeyboard() : expenseAssistantMenuKeyboard() },
      });
    }
    return { handled: true, deleteRequest: true, movementId: movement?.id || null, found: Boolean(movement) };
  }

  if (action === "deleteAsk") {
    const movement = await getExpenseMovementForChat(draftId, chatId, params.personalOnly);
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
        personalOnly: params.personalOnly,
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

  const draft = await getDraft(draftId, params.personalOnly);
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
    await updateDraft(draftId, { status: "cancelled" }, params.personalOnly);
    if (chatId) await setActiveDraftForChat(chatId, null, params.personalOnly);
    if (chatId) await setLearningDraftForChat(chatId, null, params.personalOnly);
    if (chatId) await setCategoryCreationDraftForChat(chatId, null, params.personalOnly);
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
    if (chatId) await setActiveDraftForChat(chatId, draftId, params.personalOnly);
    if (chatId) await setCategoryCreationDraftForChat(chatId, null, params.personalOnly);
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: "Elige la categoria para esta salida.",
        botToken: params.botToken,
        extraPayload: { reply_markup: await categoryKeyboard(draftId, params.personalOnly) },
      });
    }
    return { handled: true };
  }

  if (action === "newcat") {
    if (chatId) {
      await setActiveDraftForChat(chatId, draftId, params.personalOnly);
      await setCategoryCreationDraftForChat(chatId, draftId, params.personalOnly);
    }
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: [
          "Escribe el icono y nombre de la nueva categoria personal.",
          "Ejemplos:",
          "- 🐶 Mascotas",
          "- 👕 Ropa",
          "- Chucho | 🛒",
          "- 🎁 Regalos",
        ].join("\n"),
        botToken: params.botToken,
        extraPayload: { reply_markup: await draftKeyboard(draft) },
      });
    }
    return { handled: true, newCategory: true, draftId };
  }

  if (action === "learn") {
    if (chatId) {
      await setActiveDraftForChat(chatId, draftId, params.personalOnly);
      await setCategoryCreationDraftForChat(chatId, null, params.personalOnly);
      await setLearningDraftForChat(chatId, draftId, params.personalOnly);
    }
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: [
          "Escribe la palabra o alias que quieres que recuerde.",
          "Ejemplos:",
          "- platano",
          "- la colita",
          "- tanqueo",
          "- mandado",
        ].join("\n"),
        botToken: params.botToken,
        extraPayload: { reply_markup: await draftKeyboard(draft) },
      });
    }
    return { handled: true, learning: true, draftId };
  }

  if (action === "cat") {
    const buttons = categoryButtons(params.personalOnly);
    const savedCategories = params.personalOnly ? await getSavedPersonalCategories() : [];
    const customCategory = savedCategories.find((item) => item.name === value);
    const category =
      value === "supermercado"
        ? {
            label: "Supermercado",
            category: "Alimentacion",
            subcategory: "SUPERMERCADO",
            tags: ["ALIMENTACION", "SUPERMERCADO"],
          }
        :
      buttons.find((item) => item.category === value) ||
      (customCategory
        ? {
            label: customCategory.name,
            category: customCategory.name,
            subcategory: "GENERAL",
            tags: [categoryTag(customCategory.name), "PERSONAL"],
            icon: customCategory.icon,
          }
        : null) ||
      buttons[buttons.length - 1];
    const selectedCategory = params.personalOnly && !customCategory
      ? defaultPersonalSubcategory(category.category)
      : category;
    const updated = {
      ...draft,
      category: selectedCategory.category,
      subcategory: selectedCategory.subcategory,
      tags: makeTags(selectedCategory.tags),
      from: params.personalOnly || selectedCategory.category === "Gastos personales" ? "personal" as CajaId : draft.from,
      suggestionSource: "manual",
      suggestionKeyword: selectedCategory.label,
      requiresReview: params.personalOnly ? true : draft.requiresReview,
      reviewReasons: params.personalOnly
        ? ["Elige la subcategoria para completar la clasificacion personal."]
        : draft.reviewReasons,
    };
    await updateDraft(draftId, updated, params.personalOnly);
    if (chatId) await setActiveDraftForChat(chatId, draftId, params.personalOnly);
    if (chatId) await setCategoryCreationDraftForChat(chatId, null, params.personalOnly);
    if (chatId && messageId) {
      if (params.personalOnly && findPersonalCategoryDefinition(selectedCategory.category) && !customCategory) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: [
            `Categoria elegida: ${selectedCategory.category}.`,
            "Ahora elige la subcategoria:",
          ].join("\n"),
          botToken: params.botToken,
          extraPayload: { reply_markup: subcategoryKeyboard(draftId, selectedCategory.category) },
        });
        return { handled: true, chooseSubcategory: true };
      }

      await editTelegramMessageText({
        chatId,
        messageId,
        text: draftText(updated),
        botToken: params.botToken,
        extraPayload: { reply_markup: await draftKeyboard(updated) },
      });
    }
    return { handled: true };
  }

  if (action === "subcat") {
    const subcategory = decodePersonalSubcategoryValue(value);
    if (!subcategory) {
      if (chatId && messageId) {
        await editTelegramMessageText({
          chatId,
          messageId,
          text: "No pude leer esa subcategoria. Elige una categoria otra vez.",
          botToken: params.botToken,
          extraPayload: { reply_markup: await categoryKeyboard(draftId, params.personalOnly) },
        });
      }
      return { handled: true, subcategory: false };
    }

    const updated = {
      ...draft,
      category: subcategory.category,
      subcategory: subcategory.subcategory,
      tags: makeTags(subcategory.tags),
      from: "personal" as CajaId,
      suggestionSource: "manual",
      suggestionKeyword: subcategory.label,
      requiresReview: false,
      reviewReasons: [],
    };
    await updateDraft(draftId, updated, params.personalOnly);
    if (chatId) await setActiveDraftForChat(chatId, draftId, params.personalOnly);
    if (chatId) await setCategoryCreationDraftForChat(chatId, null, params.personalOnly);
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: draftText(updated),
        botToken: params.botToken,
        extraPayload: { reply_markup: await draftKeyboard(updated) },
      });
    }
    return { handled: true, subcategory: true };
  }

  if (action === "from" && ["safe", "transit", "bank", "personal"].includes(value)) {
    const updated = { ...draft, from: value as CajaId };
    await updateDraft(draftId, { from: value as CajaId }, params.personalOnly);
    if (chatId) await setActiveDraftForChat(chatId, draftId, params.personalOnly);
    if (chatId) await setCategoryCreationDraftForChat(chatId, null, params.personalOnly);
    if (chatId && messageId) {
      await editTelegramMessageText({
        chatId,
        messageId,
        text: draftText(updated),
        botToken: params.botToken,
        extraPayload: { reply_markup: await draftKeyboard(updated) },
      });
    }
    return { handled: true };
  }

  if (action === "confirm") {
    try {
      const movementId = await createMovementFromDraft(draft);
      if (chatId) await setLearningDraftForChat(chatId, null, params.personalOnly);
      if (chatId) await setCategoryCreationDraftForChat(chatId, null, params.personalOnly);
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
          extraPayload: { reply_markup: await draftKeyboard(draft) },
        });
      }
      return { handled: true, error: error?.message || String(error) };
    }
  }

  return { handled: true, ignored: true };
}

