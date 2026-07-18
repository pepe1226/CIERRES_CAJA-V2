import {
  auditClosuresWithPerseoRows,
  isPerseoAuthorized,
  parsePerseoReport,
} from "../_lib/perseoAudit.js";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";

function getDateParam(req: any) {
  const raw = String(req.query?.date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function roundMoney(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
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

  const date = getDateParam(req);

  if (!date) {
    return res.status(400).json({
      ok: false,
      error: "Use ?date=YYYY-MM-DD",
    });
  }

  const db = getFirebaseAdminDb();
  const reportsSnapshot = await db
    .collection("perseo_reports")
    .where("businessDates", "array-contains", date)
    .get();

  const rowsInput: Record<string, unknown>[] = [];
  const reportIds: string[] = [];

  reportsSnapshot.docs.forEach((doc) => {
    const data = doc.data();
    const rows = Array.isArray(data.rows) ? data.rows : [];

    reportIds.push(doc.id);

    rows
      .filter((row: any) => row?.businessDate === date)
      .forEach((row: any) => {
        const rowInput: Record<string, unknown> = {
          ...(row.raw && typeof row.raw === "object" ? row.raw : {}),
          fecha: row.businessDate,
          responsable: row.responsible,
        };
        const systemAmount = roundMoney(row.systemAmount);
        const systemBalance = roundMoney(row.systemBalance);

        if (systemAmount > 0) rowInput.venta_sistema = systemAmount;
        if (systemBalance > 0) rowInput.cuadre_sistema = systemBalance;

        rowsInput.push(rowInput);
      });
  });

  const rows = parsePerseoReport(rowsInput);

  if (rows.length === 0) {
    return res.status(404).json({
      ok: false,
      date,
      reportsFound: reportsSnapshot.size,
      reportIds,
      error: "No hay filas Perseo guardadas para recruzar esta fecha.",
    });
  }

  const replayReportId = `replay:${date}:${reportIds.join(",")}`;
  const audit = await auditClosuresWithPerseoRows({
    rows,
    reportId: replayReportId,
  });

  return res.status(200).json({
    ok: true,
    date,
    reportsFound: reportsSnapshot.size,
    reportIds,
    replayReportId,
    ...audit,
  });
}
