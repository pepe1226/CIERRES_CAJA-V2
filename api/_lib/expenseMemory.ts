import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";

export type ExpenseMemorySuggestion = {
  category: string;
  subcategory: string;
  tags: string[];
  keyword: string;
  source: "memory";
  matchedFrom: "memory" | "movement";
  confidence?: number;
};

export type ExpenseMemoryNamespace = "business" | "personal";

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
    .replace(
      /\b(telegram|gmail|pichincha|banco|ocr|transferencia|exitosa|realizaste|transaccion|notificacion|salida|gasto|pago|pague|compra|compre|proveedor|cuenta|destino|origen|documento|usd|dolar|dolares|s\.?a\.?|cia|ltda|compania|distribuidora|importadora)\b/g,
      " "
    )
    .replace(/\b\d+(?:[.,]\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function memoryKey(keyword: string) {
  return keyword
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

function memoryCollectionName(namespace: ExpenseMemoryNamespace) {
  return namespace === "personal" ? "personal_expense_category_memory" : "expense_category_memory";
}

function movementCollections(namespace: ExpenseMemoryNamespace) {
  return namespace === "personal"
    ? ["personalMovements"]
    : ["movements"];
}

function keywordCandidates(values: Array<unknown>) {
  const output = new Set<string>();

  for (const value of values) {
    const normalized = normalizeKeyword(value);
    if (normalized.length >= 3) output.add(normalized);

    const words = normalized.split(/\s+/).filter((word) => word.length >= 4);
    for (let size = Math.min(4, words.length); size >= 1; size -= 1) {
      for (let index = 0; index <= words.length - size; index += 1) {
        const phrase = words.slice(index, index + size).join(" ");
        if (phrase.length >= 4) output.add(phrase);
      }
    }
  }

  return Array.from(output)
    .sort((a, b) => b.length - a.length)
    .slice(0, 16);
}

function isMatch(searchText: string, keyword: string) {
  if (!keyword || keyword.length < 3) return false;
  if (searchText.includes(keyword)) return true;
  return keyword.length >= 8 && keyword.includes(searchText) && searchText.length >= 8;
}

export async function findExpenseMemorySuggestion(
  values: Array<unknown>,
  namespace: ExpenseMemoryNamespace = "business"
): Promise<ExpenseMemorySuggestion | null> {
  const searchText = normalizeText(values.filter(Boolean).join(" "));
  const candidates = keywordCandidates(values);
  if (!searchText && candidates.length === 0) return null;

  const db = getFirebaseAdminDb();
  const memorySnapshot = await db
    .collection(memoryCollectionName(namespace))
    .orderBy("uses", "desc")
    .limit(250)
    .get();

  for (const doc of memorySnapshot.docs) {
    const data = doc.data();
    const keywords = [
      data.keyword,
      ...(Array.isArray(data.aliases) ? data.aliases : []),
    ].map(normalizeKeyword).filter(Boolean);

    if (keywords.some((keyword) => isMatch(searchText, keyword) || candidates.some((candidate) => isMatch(candidate, keyword)))) {
      return {
        category: String(data.category || "Otros"),
        subcategory: String(data.subcategory || "GENERAL"),
        tags: Array.isArray(data.tags) ? data.tags.map(String) : ["SIN CLASIFICAR"],
        keyword: keywords[0],
        source: "memory",
        matchedFrom: "memory",
      };
    }
  }

  const movementSnapshots = await Promise.all(
    movementCollections(namespace).map((collectionName) =>
      db.collection(collectionName).orderBy("createdAt", "desc").limit(300).get()
    )
  );

  for (const snapshot of movementSnapshots) {
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!["outflow", "expense"].includes(String(data.type || ""))) continue;

      const description = normalizeText([
        data.description,
        data.category,
        data.subcategory,
        data.merchant,
        data.destinationAccount,
        data.providerName,
        Array.isArray(data.tags) ? data.tags.join(" ") : "",
        data.telegramRawExtraction?.text,
        data.telegramRawExtraction?.extractedText,
      ].join(" "));

      const matched = candidates.find((candidate) => isMatch(description, candidate));
      if (!matched) continue;

      return {
        category: String(data.category || "Otros"),
        subcategory: String(data.subcategory || "GENERAL"),
        tags: Array.isArray(data.tags) ? data.tags.map(String) : ["SIN CLASIFICAR"],
        keyword: matched,
        source: "memory",
        matchedFrom: "movement",
        confidence: 0.85,
      };
    }
  }

  return null;
}

export async function learnExpenseMemory(params: {
  keywords: Array<unknown>;
  category: string;
  subcategory?: string | null;
  tags?: string[];
  movementId?: string | null;
  source?: string;
  namespace?: ExpenseMemoryNamespace;
}) {
  if (!params.category || params.category === "Otros") return;

  const candidates = keywordCandidates(params.keywords);
  if (candidates.length === 0) return;

  const db = getFirebaseAdminDb();
  const primary = candidates[0];
  const key = memoryKey(primary);
  if (!key) return;

  await db.collection(memoryCollectionName(params.namespace || "business")).doc(key).set(
    {
      keyword: primary,
      aliases: candidates.slice(1, 10),
      category: params.category,
      subcategory: params.subcategory || "GENERAL",
      tags: params.tags || [],
      movementId: params.movementId || null,
      source: params.source || "system",
      uses: FieldValue.increment(1),
      lastUsedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}
