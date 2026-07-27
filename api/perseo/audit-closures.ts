import {
  auditClosuresWithPerseoRows,
  isPerseoAuthorized,
  parsePerseoReport,
  savePerseoReport,
} from "../_lib/perseoAudit.js";
import { handleClosureStatus } from "../_lib/closureStatus.js";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const REPORT_LIST_CACHE_MS = 60_000;
let reportListCache: { loadedAt: number; reports: any[] } | null = null;

function getBody(req: any) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return req.body;
    }
  }

  return req.body;
}

function getBearerToken(req: any) {
  const header = String(req.headers?.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function handleReportList(req: any, res: any, requestedLimit: unknown) {
  try {
    const db = getFirebaseAdminDb();
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "Falta autenticacion." });
    }

    await getAuth(getApps()[0]).verifyIdToken(token);
    const reportLimit = Math.min(Math.max(Number(requestedLimit) || 60, 1), 180);
    const now = Date.now();

    if (reportListCache && now - reportListCache.loadedAt < REPORT_LIST_CACHE_MS) {
      return res.status(200).json({
        ok: true,
        cached: true,
        reports: reportListCache.reports.slice(0, reportLimit),
      });
    }

    const snapshot = await db
      .collection("perseo_reports")
      .orderBy("createdAt", "desc")
      .limit(180)
      .get();
    const reports = snapshot.docs.map((document) => {
      const data = document.data();
      return {
        id: document.id,
        createdAt: data.createdAt?.toDate
          ? data.createdAt.toDate().toISOString()
          : data.createdAt || null,
        businessDates: Array.isArray(data.businessDates) ? data.businessDates : [],
        dailySystemAmountByDate: data.dailySystemAmountByDate || null,
        rows: Array.isArray(data.rows) ? data.rows : [],
      };
    });

    reportListCache = { loadedAt: now, reports };
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ ok: true, cached: false, reports: reports.slice(0, reportLimit) });
  } catch (error: any) {
    console.error("No se pudieron listar los reportes Perseo:", error);
    return res.status(401).json({
      ok: false,
      error: "Sesion no autorizada para consultar reportes Perseo.",
      detail: error?.message || String(error),
    });
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const body = getBody(req);
  if (body?.action === "closure_status") {
    return handleClosureStatus(req, res);
  }
  if (body?.action === "list_reports") {
    return handleReportList(req, res, body?.limit);
  }

  if (!isPerseoAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized. Configure PERSEO_IMPORT_SECRET o CRON_SECRET.",
    });
  }

  const rows = parsePerseoReport(body);

  if (rows.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "No se encontraron filas validas para auditar.",
    });
  }

  const reportId = (body as any)?.reportId || await savePerseoReport({ source: "audit-api", rows });
  const audit = await auditClosuresWithPerseoRows({
    rows,
    reportId,
    tolerance: Number((body as any)?.tolerance || 0.10),
  });

  return res.status(200).json({
    ok: true,
    reportId,
    ...audit,
  });
}

