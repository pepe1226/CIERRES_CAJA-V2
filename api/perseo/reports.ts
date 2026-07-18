import { getAuth } from "firebase-admin/auth";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";

async function verifyUser(req: any) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new Error("Falta token de sesion.");

  getFirebaseAdminDb();
  return getAuth().verifyIdToken(token);
}

function toIso(value: any) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function roundMoney(value: unknown) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyUser(req);
    const snapshot = await getFirebaseAdminDb()
      .collection("perseo_reports")
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();

    const reports = snapshot.docs.map((document) => {
      const data = document.data();
      return {
        id: document.id,
        createdAt: toIso(data.createdAt),
        businessDates: Array.isArray(data.businessDates) ? data.businessDates : [],
        rows: Array.isArray(data.rows)
          ? data.rows.map((row: any) => ({
              businessDate: String(row.businessDate || ""),
              responsible: row.responsible || null,
              responsibleKey: row.responsibleKey || null,
              cashBox: row.cashBox || row.raw?.caja || null,
              cashBoxKey: row.cashBoxKey || null,
              systemAmount: roundMoney(row.systemAmount),
              systemBalance: roundMoney(row.systemBalance),
            }))
          : [],
      };
    });

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ ok: true, reports });
  } catch (error) {
    console.error("Error listando reportes Perseo:", error);
    return res.status(401).json({ ok: false, error: "Sesion no autorizada." });
  }
}
