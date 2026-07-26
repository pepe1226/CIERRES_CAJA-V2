import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";

type InventoryRow = {
  sku: string;
  name: string;
  stock: number;
  sold90d: number;
  coverageDays: number | null;
  lastCost: number | null;
  supplier: string | null;
  warehouse: string | null;
  status: "critical" | "low" | "watch" | "ok";
  priorityReason: string | null;
  raw: Record<string, unknown>;
};

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
}

function parseMoney(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "")
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");
  if (!text) return 0;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  const decimalSeparator = comma > dot ? "," : ".";
  const normalized = decimalSeparator === ","
    ? text.replace(/\./g, "").replace(",", ".")
    : text.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumber(value: unknown) {
  const parsed = Number(parseMoney(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function splitCsvLine(line: string, delimiter: string) {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function parseCsv(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
  const headers = splitCsvLine(lines[0], delimiter).map(normalizeText);

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line, delimiter);
    return headers.reduce<Record<string, unknown>>((row, header, index) => {
      row[header] = values[index] ?? "";
      return row;
    }, {});
  });
}

function normalizeRows(input: unknown): Record<string, unknown>[] {
  if (typeof input === "string") return parseCsv(input);

  if (Array.isArray(input)) {
    return input.map((row) =>
      Object.entries(row as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, value]) => {
        result[normalizeText(key)] = value;
        return result;
      }, {})
    );
  }

  if (input && typeof input === "object") {
    const body = input as Record<string, unknown>;
    if (Array.isArray(body.rows)) return normalizeRows(body.rows);
    if (Array.isArray(body.data)) return normalizeRows(body.data);
    if (typeof body.csv === "string") return parseCsv(body.csv);
    if (typeof body.report === "string") return parseCsv(body.report);
  }

  return [];
}

function first(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function classifyStatus(stock: number, coverageDays: number | null) {
  if (stock <= 0 || (coverageDays !== null && coverageDays <= 3)) {
    return { status: "critical" as const, reason: stock <= 0 ? "Sin stock disponible" : "Cobertura menor o igual a 3 dias" };
  }
  if ((coverageDays !== null && coverageDays <= 7) || stock <= 5) {
    return { status: "low" as const, reason: "Stock bajo o cobertura corta" };
  }
  if (coverageDays !== null && coverageDays <= 15) {
    return { status: "watch" as const, reason: "Conviene vigilar este producto" };
  }
  return { status: "ok" as const, reason: "Stock estable" };
}

export function parsePerseoInventory(input: unknown) {
  const rows = normalizeRows(input);

  return rows
    .map((raw) => {
      const sku = String(first(raw, ["sku", "codigo", "cod", "id_producto"]) ?? "").trim();
      const name = String(first(raw, ["producto", "nombre", "descripcion", "item"]) ?? "").trim();
      const stock = parseNumber(first(raw, ["stock", "existencia", "saldo", "cantidad"]));
      const sold90d = parseNumber(first(raw, ["vendido_90d", "vendido90d", "venta_90d", "ventas_90d", "salida_90d"]));
      const coverageRaw = first(raw, ["cobertura", "cobertura_dias", "dias_cobertura"]);
      const coverageDays = coverageRaw === undefined || coverageRaw === null || String(coverageRaw).trim() === ""
        ? null
        : parseNumber(coverageRaw);
      const lastCostRaw = first(raw, ["ultimo_costo", "costo", "costo_ultimo", "last_cost"]);
      const lastCost = lastCostRaw === undefined || lastCostRaw === null || String(lastCostRaw).trim() === ""
        ? null
        : parseMoney(lastCostRaw);
      const supplier = String(first(raw, ["proveedor", "supplier"]) ?? "").trim() || null;
      const warehouse = String(first(raw, ["bodega", "warehouse", "almacen"]) ?? "").trim() || null;
      const statusInfo = classifyStatus(stock, coverageDays);

      return {
        sku,
        name,
        stock,
        sold90d,
        coverageDays,
        lastCost,
        supplier,
        warehouse,
        status: statusInfo.status,
        priorityReason: statusInfo.reason,
        raw,
      } satisfies InventoryRow;
    })
    .filter((row) => row.name);
}

export async function savePerseoInventory(params: {
  source?: string;
  rows: InventoryRow[];
  rawInput?: unknown;
}) {
  const db = getFirebaseAdminDb();
  const snapshotRef = db.collection("inventory_snapshots").doc();

  const summary = params.rows.reduce((acc, row) => {
    acc.total += 1;
    if (row.status === "critical") acc.critical += 1;
    if (row.status === "low") acc.low += 1;
    if (row.status === "watch") acc.watch += 1;
    if (row.status === "ok") acc.ok += 1;
    return acc;
  }, { total: 0, critical: 0, low: 0, watch: 0, ok: 0 });

  await snapshotRef.set({
    createdAt: FieldValue.serverTimestamp(),
    source: params.source || "api",
    rowCount: params.rows.length,
    summary,
  });

  const batch = db.batch();

  params.rows.forEach((row) => {
    const itemId = row.sku || normalizeText(row.name).slice(0, 120);
    const itemRef = db.collection("inventory_items").doc(itemId);
    const priorityRank = row.status === "critical" ? 1 : row.status === "low" ? 2 : row.status === "watch" ? 3 : 4;

    batch.set(itemRef, {
      sku: row.sku || null,
      name: row.name,
      stock: row.stock,
      sold90d: row.sold90d,
      coverageDays: row.coverageDays,
      lastCost: row.lastCost,
      supplier: row.supplier,
      warehouse: row.warehouse,
      status: row.status,
      priorityReason: row.priorityReason,
      snapshotId: snapshotRef.id,
      priorityRank,
      raw: row.raw,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  await batch.commit();

  return {
    snapshotId: snapshotRef.id,
    ...summary,
  };
}
