import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import { getTelegramConfig } from "./telegramMovement.js";

type PerseoReportRow = {
  date: Date;
  businessDate: string;
  responsible: string;
  responsibleKey: string;
  systemAmount: number;
  systemBalance: number;
  raw: Record<string, unknown>;
};

type AuditResult = {
  row: PerseoReportRow;
  ok: boolean;
  closureId?: string;
  reason?: string;
  candidates?: number;
  physicalAmount?: number;
  difference?: number;
  auditStatus?: "matched" | "difference";
};

function stripAccents(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(value: unknown) {
  return stripAccents(String(value ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeHeader(value: unknown) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function normalizeResponsible(value: unknown) {
  return normalizeText(value)
    .replace(/^(responsable|cajero|caja|sr|sra)\s+/i, "")
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

  let normalized = text;
  if (decimalSeparator === ",") {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = normalized.replace(/,/g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function businessDateKey(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function parseBusinessDate(value: unknown, fallback = new Date()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (value && typeof (value as any).toDate === "function") {
    const date = (value as any).toDate();
    if (!Number.isNaN(date.getTime())) return date;
  }

  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12));
  }

  const local = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (local) {
    let year = Number(local[3]);
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, Number(local[2]) - 1, Number(local[1]), 12));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function getFirst(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") {
      return record[key];
    }
  }

  return undefined;
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
  const headers = splitCsvLine(lines[0], delimiter).map(normalizeHeader);

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
        result[normalizeHeader(key)] = value;
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

export function isPerseoAuthorized(req: any) {
  const expectedSecret = (
    process.env.PERSEO_IMPORT_SECRET ||
    process.env.CRON_SECRET ||
    getTelegramConfig().telegramSecretToken ||
    ""
  ).trim();

  if (!expectedSecret) return false;

  const authHeader = String(req.headers?.authorization || "");
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const headerSecret = req.headers?.["x-perseo-secret"] || req.headers?.["x-cron-secret"];

  return bearerToken === expectedSecret || String(headerSecret || "") === expectedSecret;
}

export function parsePerseoReport(input: unknown) {
  const rows = normalizeRows(input);

  return rows
    .map((raw) => {
      const dateValue = getFirst(raw, [
        "fecha",
        "date",
        "dia",
        "fecha_cierre",
        "fecha_negocio",
        "business_date",
      ]);
      const responsible = String(
        getFirst(raw, [
          "responsable",
          "cajero",
          "cajera",
          "usuario",
          "empleado",
          "nombre",
          "vendedor",
        ]) ?? ""
      ).trim();

      const systemAmount = parseMoney(
        getFirst(raw, [
          "venta_sistema",
          "ventas_sistema",
          "total_sistema",
          "total_venta",
          "venta",
          "sistema",
        ])
      );
      const systemBalanceRaw = getFirst(raw, [
        "cuadre_sistema",
        "saldo_sistema",
        "cierre_sistema",
        "efectivo_esperado",
        "esperado",
        "saldo",
        "sistema",
      ]);
      const systemBalance = parseMoney(systemBalanceRaw ?? systemAmount);
      const date = parseBusinessDate(dateValue);
      const responsibleKey = normalizeResponsible(responsible);

      return {
        date,
        businessDate: businessDateKey(date),
        responsible,
        responsibleKey,
        systemAmount,
        systemBalance,
        raw,
      };
    })
    .filter((row) => row.responsibleKey && (row.systemAmount > 0 || row.systemBalance > 0));
}

function closureBusinessDate(data: any) {
  return businessDateKey(parseBusinessDate(data.date));
}

function scoreCandidate(row: PerseoReportRow, closure: any) {
  const closureKey = normalizeResponsible(closure.responsible);

  if (closureKey === row.responsibleKey) return 100;
  if (closureKey.includes(row.responsibleKey) || row.responsibleKey.includes(closureKey)) return 80;

  const rowParts = new Set(row.responsibleKey.split(/\s+/).filter((part) => part.length >= 3));
  const closureParts = closureKey.split(/\s+/).filter((part) => part.length >= 3);
  const hits = closureParts.filter((part) => rowParts.has(part)).length;

  return hits * 20;
}

async function getClosuresForDate(businessDate: string) {
  const db = getFirebaseAdminDb();
  const start = new Date(`${businessDate}T00:00:00.000Z`);
  const end = new Date(`${businessDate}T23:59:59.999Z`);

  const snapshot = await db
    .collection("closures")
    .where("date", ">=", Timestamp.fromDate(start))
    .where("date", "<=", Timestamp.fromDate(end))
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() }));
}

export async function savePerseoReport(params: {
  source?: string;
  rows: PerseoReportRow[];
  rawInput?: unknown;
}) {
  const db = getFirebaseAdminDb();
  const reportRef = db.collection("perseo_reports").doc();

  await reportRef.set({
    createdAt: FieldValue.serverTimestamp(),
    source: params.source || "api",
    rowCount: params.rows.length,
    businessDates: Array.from(new Set(params.rows.map((row) => row.businessDate))).sort(),
    rows: params.rows.map((row) => ({
      businessDate: row.businessDate,
      responsible: row.responsible,
      responsibleKey: row.responsibleKey,
      systemAmount: row.systemAmount,
      systemBalance: row.systemBalance,
      raw: row.raw,
    })),
  });

  return reportRef.id;
}

export async function auditClosuresWithPerseoRows(params: {
  rows: PerseoReportRow[];
  reportId?: string;
  tolerance?: number;
}) {
  const tolerance = Math.max(0, params.tolerance ?? 0.01);
  const results: AuditResult[] = [];
  const closuresByDate = new Map<string, Awaited<ReturnType<typeof getClosuresForDate>>>();

  for (const row of params.rows) {
    if (!closuresByDate.has(row.businessDate)) {
      closuresByDate.set(row.businessDate, await getClosuresForDate(row.businessDate));
    }

    const closures = closuresByDate
      .get(row.businessDate)!
      .filter((closure) => closureBusinessDate(closure.data) === row.businessDate)
      .map((closure) => ({ ...closure, score: scoreCandidate(row, closure.data) }))
      .filter((closure) => closure.score >= 20)
      .sort((a, b) => b.score - a.score);

    if (closures.length === 0) {
      results.push({ row, ok: false, reason: "closure_not_found", candidates: 0 });
      continue;
    }

    const best = closures[0];
    const tied = closures.filter((closure) => closure.score === best.score);

    if (tied.length > 1 && best.score < 100) {
      results.push({ row, ok: false, reason: "ambiguous_closure", candidates: tied.length });
      continue;
    }

    const physicalAmount = Number(best.data.physicalAmount || 0);
    const difference = Number((physicalAmount - row.systemBalance).toFixed(2));
    const auditStatus = Math.abs(difference) <= tolerance ? "matched" : "difference";

    await best.ref.set(
      {
        systemAmount: row.systemAmount,
        systemBalance: row.systemBalance,
        difference,
        systemSource: "perseo",
        perseoReportId: params.reportId || null,
        perseoMatchedAt: FieldValue.serverTimestamp(),
        perseoAuditStatus: auditStatus,
        perseoRaw: row.raw,
      },
      { merge: true }
    );

    results.push({
      row,
      ok: true,
      closureId: best.id,
      candidates: closures.length,
      physicalAmount,
      difference,
      auditStatus,
    });
  }

  const matchedResults = results.filter((result) => result.ok);
  const differenceResults = matchedResults.filter((result) => result.auditStatus === "difference");

  return {
    ok: true,
    totalRows: params.rows.length,
    updated: matchedResults.length,
    unmatched: results.filter((result) => !result.ok).length,
    matched: matchedResults.filter((result) => result.auditStatus === "matched").length,
    differences: differenceResults.length,
    totalPhysicalAmount: Number(
      matchedResults.reduce((sum, result) => sum + Number(result.physicalAmount || 0), 0).toFixed(2)
    ),
    totalSystemBalance: Number(
      matchedResults.reduce((sum, result) => sum + Number(result.row.systemBalance || 0), 0).toFixed(2)
    ),
    totalDifference: Number(
      matchedResults.reduce((sum, result) => sum + Number(result.difference || 0), 0).toFixed(2)
    ),
    results: results.map((result) => ({
      ok: result.ok,
      closureId: result.closureId,
      reason: result.reason,
      candidates: result.candidates,
      businessDate: result.row.businessDate,
      responsible: result.row.responsible,
      systemAmount: result.row.systemAmount,
      systemBalance: result.row.systemBalance,
      physicalAmount: result.physicalAmount,
      difference: result.difference,
      auditStatus: result.auditStatus,
    })),
  };
}

