import { Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import { isPerseoAuthorized } from "../_lib/perseoAudit.js";

function getDateParam(req: any) {
  const raw = String(req.query?.date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function toIso(value: any) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function roundMoney(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function getEcuadorTelegramRange(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const start = Date.UTC(year, month - 1, day, 5, 0, 0, 0);
  const end = start + 24 * 60 * 60 * 1000 - 1;

  return {
    startSeconds: Math.floor(start / 1000),
    endSeconds: Math.floor(end / 1000),
  };
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isPerseoAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized. Configure PERSEO_IMPORT_SECRET o CRON_SECRET.",
    });
  }

  const date = getDateParam(req);

  if (!date) {
    return res.status(400).json({
      ok: false,
      error: "Use ?date=YYYY-MM-DD",
    });
  }

  const db = getFirebaseAdminDb();
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  const telegramRange = getEcuadorTelegramRange(date);

  const [reportsSnapshot, closuresSnapshot, ignoredDocumentsSnapshot] = await Promise.all([
    db.collection("perseo_reports").where("businessDates", "array-contains", date).get(),
    db
      .collection("closures")
      .where("date", ">=", Timestamp.fromDate(start))
      .where("date", "<=", Timestamp.fromDate(end))
      .get(),
    db
      .collection("telegram_ignored_documents")
      .where("telegramDate", ">=", telegramRange.startSeconds)
      .where("telegramDate", "<=", telegramRange.endSeconds)
      .get(),
  ]);

  const reports = reportsSnapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        createdAt: toIso(data.createdAt),
        source: data.source || null,
        rowCount: Number(data.rowCount || 0),
        businessDates: data.businessDates || [],
        rows: Array.isArray(data.rows)
          ? data.rows.map((row: any) => ({
              businessDate: row.businessDate || null,
              responsible: row.responsible || null,
              responsibleKey: row.responsibleKey || null,
              systemAmount: roundMoney(row.systemAmount),
              systemBalance: roundMoney(row.systemBalance),
              raw: row.raw || null,
            }))
          : [],
      };
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const closures = closuresSnapshot.docs
    .map((doc) => {
      const data = doc.data();
      const physicalAmount = roundMoney(data.physicalAmount);
      const systemBalance = roundMoney(data.systemBalance);
      return {
        id: doc.id,
        date: toIso(data.date),
        responsible: data.responsible || null,
        physicalAmount,
        systemAmount: roundMoney(data.systemAmount),
        systemBalance,
        difference: roundMoney(data.difference ?? physicalAmount - systemBalance),
        systemSource: data.systemSource || null,
        perseoReportId: data.perseoReportId || null,
        perseoMatchedAt: toIso(data.perseoMatchedAt),
        perseoAuditStatus: data.perseoAuditStatus || null,
        status: data.status || null,
      };
    })
    .sort((a, b) => String(a.responsible || "").localeCompare(String(b.responsible || "")));

  const ignoredDocuments = ignoredDocumentsSnapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        telegramDate: data.telegramDate || null,
        fileName: data.fileName || null,
        mimeType: data.mimeType || null,
        caption: data.caption || null,
        ignoredAt: toIso(data.ignoredAt),
      };
    })
    .sort((a, b) => Number(a.telegramDate || 0) - Number(b.telegramDate || 0));

  return res.status(200).json({
    ok: true,
    date,
    reportsFound: reports.length,
    reportRows: reports.reduce((sum, report) => sum + report.rows.length, 0),
    closuresFound: closures.length,
    closuresMatched: closures.filter((closure) => closure.systemSource === "perseo").length,
    ignoredDocumentsFound: ignoredDocuments.length,
    reports,
    closures,
    ignoredDocuments,
  });
}
