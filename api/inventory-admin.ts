import { getAuth } from "firebase-admin/auth";
import { getFirebaseAdminDb } from "./_lib/firebaseAdmin.js";
import { handleBanquitosClosures } from "./_lib/banquitosClosures.js";
import { parsePerseoInventory, savePerseoInventory } from "./_lib/perseoInventory.js";

async function verifyUser(req: any) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new Error("Falta token de sesion.");
  getFirebaseAdminDb();
  return getAuth().verifyIdToken(token);
}

function getBody(req: any) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    const trimmed = req.body.trim();
    if (!trimmed) return {};

    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return req.body;
}

function serializeDate(value: any) {
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

async function listSnapshots() {
  const db = getFirebaseAdminDb();
  const snapshot = await db.collection("inventory_snapshots").orderBy("createdAt", "desc").limit(20).get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      createdAt: serializeDate(data.createdAt),
      source: String(data.source || "api"),
      rowCount: Number(data.rowCount || 0),
      summary: {
        total: Number(data.summary?.total || 0),
        critical: Number(data.summary?.critical || 0),
        low: Number(data.summary?.low || 0),
        watch: Number(data.summary?.watch || 0),
        ok: Number(data.summary?.ok || 0),
      },
    };
  });
}

export default async function handler(req: any, res: any) {
  if (req.query?.integration === "banquitos-closures") {
    return handleBanquitosClosures(req, res);
  }

  try {
    const user = await verifyUser(req);

    if (req.method === "GET") {
      return res.status(200).json({ ok: true, snapshots: await listSnapshots(), user: user.uid });
    }

    if (req.method === "POST") {
      const body = getBody(req);
      const rows = parsePerseoInventory(body);

      if (rows.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "No se encontraron filas validas. Sube CSV, TXT o JSON con nombre, stock y opcionalmente ventas, cobertura y costo.",
        });
      }

      const saved = await savePerseoInventory({
        source: typeof body === "object" && body ? String((body as any).source || "web-upload") : "web-upload",
        rows,
        rawInput: body,
      });

      return res.status(200).json({
        ok: true,
        imported: rows.length,
        snapshots: await listSnapshots(),
        ...saved,
      });
    }

    return res.status(405).json({ ok: false, error: "Metodo no permitido." });
  } catch (error: any) {
    return res.status(401).json({ ok: false, error: error?.message || String(error) });
  }
}
