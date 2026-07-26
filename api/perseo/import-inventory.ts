import { isPerseoAuthorized } from "../_lib/perseoAudit.js";
import { parsePerseoInventory, savePerseoInventory } from "../_lib/perseoInventory.js";

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
  const rows = parsePerseoInventory(body);

  if (rows.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "No se encontraron filas validas para inventario. Envie JSON con rows/data o CSV con nombre y stock.",
    });
  }

  const saved = await savePerseoInventory({
    source: typeof body === "object" && body ? String((body as any).source || "perseo-inventory") : "perseo-inventory",
    rows,
    rawInput: body,
  });

  return res.status(200).json({
    ok: true,
    imported: rows.length,
    ...saved,
  });
}
