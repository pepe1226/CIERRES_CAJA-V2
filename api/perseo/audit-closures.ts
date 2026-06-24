import {
  auditClosuresWithPerseoRows,
  isPerseoAuthorized,
  parsePerseoReport,
  savePerseoReport,
} from "../_lib/perseoAudit.js";

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

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isPerseoAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized. Configure PERSEO_IMPORT_SECRET o CRON_SECRET.",
    });
  }

  const body = getBody(req);
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
    tolerance: Number((body as any)?.tolerance || 0.01),
  });

  return res.status(200).json({
    ok: true,
    reportId,
    ...audit,
  });
}

