import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { normalizeCashierName } from "./cashierNames.js";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import { getTelegramConfig } from "./telegramMovement.js";

type PerseoReportRow = {
  date: Date;
  businessDate: string;
  responsible: string;
  responsibleKey: string;
  cashBox: string;
  cashBoxKey: string;
  systemAmount: number;
  systemBalance: number;
  reportedAmount: number;
  transferAmount: number;
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
  return normalizeCashierName(
    normalizeText(value)
      .replace(/^(responsable|cajero|caja|sr|sra)\s+/i, "")
      .trim()
  );
}

function isKnownCashierKey(value: string) {
  return ["JOHANNA", "YULEXI", "DAYELI", "ERICK"].includes(value);
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

function ecuadorBusinessDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guayaquil",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function getEcuadorBusinessDateKeyFromValue(value: unknown) {
  const date = parseBusinessDate(value);
  return Number.isNaN(date.getTime()) ? "" : ecuadorBusinessDateKey(date);
}

function getEcuadorBusinessDateRange(businessDate: string) {
  const [year, month, day] = businessDate.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { start, end };
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

function getFirstByHeaderTerms(
  record: Record<string, unknown>,
  includeTerms: string[],
  excludeTerms: string[] = []
) {
  const include = includeTerms.map(normalizeHeader);
  const exclude = excludeTerms.map(normalizeHeader);

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || String(value).trim() === "") continue;

    const normalizedKey = normalizeHeader(key);
    const matchesInclude = include.some((term) => normalizedKey.includes(term));
    const matchesExclude = exclude.some((term) => normalizedKey.includes(term));

    if (matchesInclude && !matchesExclude) {
      return value;
    }
  }

  return undefined;
}

function getExplicitTransferAmountValue(record: Record<string, unknown>) {
  const direct = getFirst(record, [
    "transferido_compra_pdv",
    "transf_compra_pdv",
    "transf_pdv",
    "transfer_pdv",
    "transferencia_compra_pdv",
    "transferencias_compra_pdv",
    "transferencias_pdv",
    "enviado_compra_pdv",
    "compra_pdv",
  ]);

  if (direct !== undefined) return direct;

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || String(value).trim() === "") continue;

    const normalizedKey = normalizeHeader(key);
    const hasTransferTerm =
      normalizedKey.includes("transf") ||
      normalizedKey.includes("transfer") ||
      normalizedKey.includes("transferido") ||
      normalizedKey.includes("transferencia");
    const hasPdvContext = normalizedKey.includes("pdv") || normalizedKey.includes("compra");
    const isWrongField =
      normalizedKey.includes("venta") ||
      normalizedKey.includes("saldo") ||
      normalizedKey.includes("reportado") ||
      normalizedKey.includes("fisico") ||
      normalizedKey.includes("diferencia");

    if (hasTransferTerm && hasPdvContext && !isWrongField) return value;
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

export function parsePerseoReport(input: unknown, fallbackDate = new Date()) {
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
      const cashBox = String(
        getFirst(raw, [
          "caja",
          "caja_pdv",
          "caja_perseo",
          "nombre_caja",
          "punto_venta",
          "pdv",
        ]) ?? ""
      ).trim();

      const systemAmount = parseMoney(
        getFirst(raw, [
          "venta_sistema",
          "ventas_sistema",
          "venta_total",
          "ventas_total",
          "total_venta",
          "total_ventas",
          "total_vendido",
          "venta_neta",
          "ventas_netas",
          "monto_venta",
          "importe_venta",
          "ingreso_sistema",
          "valor_sistema_venta",
          "venta",
        ]) ??
          getFirstByHeaderTerms(
            raw,
            ["venta", "ventas", "vendido", "facturado", "total_venta", "ingreso"],
            ["diferencia", "diff", "saldo", "cuadre", "cierre", "esperado", "efectivo", "fisico", "funda"]
          )
      );
      const expectedBalanceRaw = getFirst(raw, [
        "saldo_esperado_caja",
        "efectivo_esperado_movcaja",
        "efectivo_esperado",
        "esperado",
        "saldo_a_dejar",
        "saldo_debe_dejar",
        "debe_dejar",
        "debe_quedar",
        "saldo_en_caja",
        "saldo_cajero",
        "neto_caja",
        "total_esperado",
      ]);
      const systemBalanceRaw = expectedBalanceRaw ?? getFirst(raw, [
        "cuadre_sistema",
        "saldo_sistema",
        "cierre_sistema",
        "saldo",
        "sistema",
      ]) ??
        getFirstByHeaderTerms(
          raw,
          ["cuadre", "saldo", "cierre", "esperado", "efectivo", "sistema"],
          ["venta", "ventas", "vendido", "facturado", "diferencia", "diff", "fisico", "funda"]
        );
      const systemBalance = parseMoney(systemBalanceRaw ?? systemAmount);
      const reportedAmount = parseMoney(
        getFirst(raw, [
          "reportado",
          "efectivo_reportado",
          "cierre_reportado",
          "fisico_reportado",
          "totalefectivo",
          "total_reportado",
        ])
      );
      const transferAmount = parseMoney(getExplicitTransferAmountValue(raw));
      const date = parseBusinessDate(dateValue, fallbackDate);
      const cashBoxKey = normalizeResponsible(cashBox);
      const responsibleKey = normalizeResponsible(responsible);
      const effectiveResponsible = isKnownCashierKey(cashBoxKey) ? cashBoxKey : responsible;
      const effectiveResponsibleKey = isKnownCashierKey(cashBoxKey) ? cashBoxKey : responsibleKey;
      const normalizedRaw = isKnownCashierKey(cashBoxKey)
        ? {
            ...raw,
            responsable: effectiveResponsible,
            cajero: effectiveResponsible,
          }
        : raw;

      return {
        date,
        businessDate: businessDateKey(date),
        responsible: effectiveResponsible,
        responsibleKey: effectiveResponsibleKey,
        cashBox,
        cashBoxKey,
        systemAmount,
        systemBalance,
        reportedAmount,
        transferAmount,
        raw: normalizedRaw,
      };
    })
    .filter((row) => (row.responsibleKey || row.cashBoxKey) && (row.systemAmount > 0 || row.systemBalance > 0));
}

function closureBusinessDate(data: any) {
  return ecuadorBusinessDateKey(parseBusinessDate(data.date));
}

function amountMatchScore(row: PerseoReportRow, closure: any, tolerance: number) {
  const physicalAmount = Number(closure.physicalAmount || 0);
  const candidates = [row.systemBalance, row.reportedAmount, row.systemAmount]
    .map((value) => Number(value || 0))
    .filter((value) => value > 0);

  if (physicalAmount <= 0 || candidates.length === 0) return 0;

  const delta = Math.min(...candidates.map((value) => Math.abs(physicalAmount - value)));
  const effectiveTolerance = Math.max(tolerance, 0.10);

  if (delta <= effectiveTolerance) return 160;
  if (delta <= 0.25) return 120;
  if (delta <= 1) return 80;
  return 0;
}

function scoreCandidate(row: PerseoReportRow, closure: any, tolerance: number) {
  const closureKey = normalizeResponsible(closure.responsible);
  const keys = [row.responsibleKey, row.cashBoxKey].filter(Boolean);
  const amountScore = amountMatchScore(row, closure, tolerance);
  let nameScore = 0;

  if (row.responsibleKey && closureKey === row.responsibleKey) nameScore = 90;
  else if (row.cashBoxKey && closureKey === row.cashBoxKey) nameScore = 80;
  else {
    const containedKey = keys.find((key) => closureKey.includes(key) || key.includes(closureKey));
    if (containedKey) nameScore = containedKey === row.responsibleKey ? 60 : 50;
    else {
      const rowParts = new Set(keys.flatMap((key) => key.split(/\s+/).filter((part) => part.length >= 3)));
      const closureParts = closureKey.split(/\s+/).filter((part) => part.length >= 3);
      const hits = closureParts.filter((part) => rowParts.has(part)).length;
      nameScore = hits * 20;
    }
  }

  return nameScore + amountScore;
}

function rowHasNamedCashier(row: PerseoReportRow) {
  return [row.responsibleKey, row.cashBoxKey].some(isKnownCashierKey);
}

function isSameMoney(left: unknown, right: unknown, tolerance: number) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;
}

async function getClosuresForDate(businessDate: string) {
  const db = getFirebaseAdminDb();
  const { start, end } = getEcuadorBusinessDateRange(businessDate);

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
  dailySystemAmountByDate?: Record<string, number>;
}) {
  const db = getFirebaseAdminDb();
  const reportRef = db.collection("perseo_reports").doc();

  await reportRef.set({
    createdAt: FieldValue.serverTimestamp(),
    source: params.source || "api",
    rowCount: params.rows.length,
    businessDates: Array.from(new Set(params.rows.map((row) => row.businessDate))).sort(),
    dailySystemAmountByDate: params.dailySystemAmountByDate || null,
    rows: params.rows.map((row) => ({
      businessDate: row.businessDate,
      responsible: row.responsible,
      responsibleKey: row.responsibleKey,
      cashBox: row.cashBox,
      cashBoxKey: row.cashBoxKey,
      systemAmount: row.systemAmount,
      systemBalance: row.systemBalance,
      reportedAmount: row.reportedAmount,
      transferAmount: row.transferAmount,
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
  const tolerance = Math.max(0, params.tolerance ?? 0.10);
  const results: AuditResult[] = [];
  const closuresByDate = new Map<string, Awaited<ReturnType<typeof getClosuresForDate>>>();
  const usedClosureIds = new Set<string>();

  for (const row of params.rows) {
    if (!closuresByDate.has(row.businessDate)) {
      closuresByDate.set(row.businessDate, await getClosuresForDate(row.businessDate));
    }

    const closures = closuresByDate
      .get(row.businessDate)!
      .filter((closure) => closureBusinessDate(closure.data) === row.businessDate)
      .filter((closure) => !usedClosureIds.has(closure.id))
      .map((closure) => ({ ...closure, score: scoreCandidate(row, closure.data, tolerance) }))
      .filter((closure) => closure.score >= 20)
      .sort((a, b) => b.score - a.score);

    if (closures.length === 0) {
      const remainingClosures = closuresByDate
        .get(row.businessDate)!
        .filter((closure) => closureBusinessDate(closure.data) === row.businessDate)
        .filter((closure) => !usedClosureIds.has(closure.id));

      const amountMatchedClosures = remainingClosures.filter((closure) =>
        isSameMoney(closure.data.physicalAmount, row.systemBalance, tolerance)
      );

      if (amountMatchedClosures.length === 1) {
        closures.push({ ...amountMatchedClosures[0], score: 15 });
      } else if (amountMatchedClosures.length > 1) {
        results.push({
          row,
          ok: false,
          reason: "ambiguous_amount_match",
          candidates: amountMatchedClosures.length,
        });
        continue;
      }

      if (closures.length === 0) {
        results.push({
          row,
          ok: false,
          reason: rowHasNamedCashier(row)
            ? "cashier_closure_not_found"
            : remainingClosures.length > 1
            ? "ambiguous_remaining_closure"
            : "closure_not_found",
          candidates: remainingClosures.length,
        });
        continue;
      }
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
    usedClosureIds.add(best.id);

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
      cashBox: result.row.cashBox,
      systemAmount: result.row.systemAmount,
      systemBalance: result.row.systemBalance,
      physicalAmount: result.physicalAmount,
      difference: result.difference,
      auditStatus: result.auditStatus,
    })),
  };
}

export async function auditSavedPerseoReportsForDate(params: {
  businessDate: string;
}) {
  const db = getFirebaseAdminDb();
  const reportsSnapshot = await db
    .collection("perseo_reports")
    .where("businessDates", "array-contains", params.businessDate)
    .get();

  const rowsInput: Record<string, unknown>[] = [];
  const reportIds: string[] = [];

  reportsSnapshot.docs.forEach((doc) => {
    const data = doc.data();
    const rows = Array.isArray(data.rows) ? data.rows : [];

    reportIds.push(doc.id);

    rows
      .filter((row: any) => row?.businessDate === params.businessDate)
      .forEach((row: any) => {
        const rowInput: Record<string, unknown> = {
          ...(row.raw && typeof row.raw === "object" ? row.raw : {}),
          fecha: row.businessDate,
          responsable: row.responsible,
        };

        const systemAmount = parseMoney(row.systemAmount);
        const systemBalance = parseMoney(row.systemBalance);

        if (systemAmount > 0) rowInput.venta_sistema = systemAmount;
        if (systemBalance > 0) {
          rowInput.saldo_esperado_caja = systemBalance;
          rowInput.cuadre_sistema = systemBalance;
        }
        if (parseMoney(row.reportedAmount) > 0) rowInput.reportado = row.reportedAmount;
        if (parseMoney(row.transferAmount) !== 0) rowInput.transferido_compra_pdv = row.transferAmount;

        rowsInput.push(rowInput);
      });
  });

  const rows = parsePerseoReport(rowsInput);

  if (rows.length === 0) {
    return {
      ok: true,
      businessDate: params.businessDate,
      reportsFound: reportsSnapshot.size,
      reportIds,
      updated: 0,
      reason: "no_saved_rows",
    };
  }

  const reportId = `auto:${params.businessDate}:${reportIds.join(",")}`;
  const audit = await auditClosuresWithPerseoRows({ rows, reportId });

  return {
    ...audit,
    businessDate: params.businessDate,
    reportsFound: reportsSnapshot.size,
    reportIds,
    reportId,
  };
}

