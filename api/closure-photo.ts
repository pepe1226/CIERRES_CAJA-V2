import { getAuth } from "firebase-admin/auth";
import { getFirebaseAdminDb } from "./_lib/firebaseAdmin.js";
import { downloadTelegramPhoto } from "./_lib/telegramMovement.js";

function getBearerToken(req: any) {
  const header = String(req.headers?.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Metodo no permitido." });
  }

  try {
    const database = getFirebaseAdminDb();
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "Falta autenticacion." });
    }

    try {
      await getAuth().verifyIdToken(token);
    } catch {
      return res.status(401).json({ ok: false, error: "Sesion no valida." });
    }

    const closureId = String(req.query?.closureId || "").trim();
    if (!closureId || closureId.length > 180 || closureId.includes("/")) {
      return res.status(400).json({ ok: false, error: "Corte no valido." });
    }

    const snapshot = await database.collection("closures").doc(closureId).get();
    if (!snapshot.exists) {
      return res.status(404).json({ ok: false, error: "No se encontro el corte." });
    }

    const telegramFileId = String(snapshot.data()?.telegramFileId || "").trim();
    if (!telegramFileId) {
      return res.status(404).json({ ok: false, error: "Este corte no tiene una foto disponible." });
    }

    const downloaded = await downloadTelegramPhoto(telegramFileId);
    if (!downloaded.mimeType.startsWith("image/")) {
      return res.status(415).json({ ok: false, error: "El archivo del corte no es una imagen." });
    }

    res.setHeader("Content-Type", downloaded.mimeType);
    res.setHeader("Content-Length", String(downloaded.imageBuffer.length));
    res.setHeader("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(downloaded.imageBuffer);
  } catch (error) {
    console.error("No se pudo entregar la foto del corte:", error);
    return res.status(500).json({ ok: false, error: "No se pudo cargar la foto del corte." });
  }
}
