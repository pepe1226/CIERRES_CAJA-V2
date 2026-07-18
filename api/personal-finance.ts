import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getFirebaseAdminDb } from "./_lib/firebaseAdmin.js";

async function verifyUser(req: any) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new Error("Falta token de sesion.");
  getFirebaseAdminDb();
  return getAuth().verifyIdToken(token);
}

function serializeDate(value: any) {
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

async function listData() {
  const db = getFirebaseAdminDb();
  const [boxesSnapshot, movementsSnapshot] = await Promise.all([
    db.collection("personalCashBoxes").orderBy("name", "asc").get(),
    db.collection("personalMovements").orderBy("date", "desc").limit(500).get(),
  ]);

  return {
    boxes: boxesSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || "Caja personal",
        type: data.type || "cash",
        openingBalance: Number(data.openingBalance || 0),
        color: data.color || "#8B5CF6",
        isActive: data.isActive !== false,
        createdBy: data.createdBy || "",
      };
    }),
    movements: movementsSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        date: serializeDate(data.date),
        type: data.type || "expense",
        amount: Number(data.amount || 0),
        description: data.description || "",
        category: data.category || "Otros",
        tags: Array.isArray(data.tags) ? data.tags : [],
        fromBoxId: data.fromBoxId || null,
        toBoxId: data.toBoxId || null,
        createdBy: data.createdBy || "",
        source: data.source || "app",
      };
    }),
  };
}

function cleanAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0;
}

export default async function handler(req: any, res: any) {
  try {
    const user = await verifyUser(req);
    const db = getFirebaseAdminDb();

    if (req.method === "GET") {
      return res.status(200).json(await listData());
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

      if (body.kind === "box") {
        const name = String(body.name || "").trim().toUpperCase();
        if (!name) return res.status(400).json({ error: "Falta nombre de caja." });

        const ref = await db.collection("personalCashBoxes").add({
          name,
          type: ["cash", "bank", "wallet", "savings", "other"].includes(body.type) ? body.type : "cash",
          openingBalance: Math.max(0, Number(body.openingBalance || 0)),
          color: String(body.color || "#8B5CF6").slice(0, 20),
          isActive: true,
          createdBy: user.uid,
          createdAt: FieldValue.serverTimestamp(),
        });

        return res.status(200).json({ id: ref.id, ...(await listData()) });
      }

      if (body.kind === "movement") {
        const type = ["income", "expense", "transfer"].includes(body.type) ? body.type : "expense";
        const amount = cleanAmount(body.amount);
        const description = String(body.description || "").trim().toUpperCase();

        if (amount <= 0) return res.status(400).json({ error: "Monto invalido." });
        if (!description) return res.status(400).json({ error: "Falta descripcion." });

        const date = body.date ? new Date(body.date) : new Date();
        const ref = await db.collection("personalMovements").add({
          date: Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date),
          type,
          amount,
          description: description.slice(0, 500),
          category: String(body.category || (type === "income" ? "Ingreso personal" : type === "transfer" ? "Transferencia" : "Otros")).slice(0, 100),
          tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 8) : [],
          fromBoxId: type === "income" ? null : body.fromBoxId || null,
          toBoxId: type === "expense" ? null : body.toBoxId || null,
          createdBy: user.uid,
          createdByName: user.name || user.email || null,
          source: "app",
          createdAt: FieldValue.serverTimestamp(),
        });

        return res.status(200).json({ id: ref.id, ...(await listData()) });
      }

      return res.status(400).json({ error: "Operacion no soportada." });
    }

    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      if (body.kind !== "box" || !body.id) return res.status(400).json({ error: "Falta caja." });

      await db.collection("personalCashBoxes").doc(String(body.id)).set(
        {
          isActive: Boolean(body.isActive),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).json(await listData());
    }

    if (req.method === "DELETE") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "Falta movimiento." });
      await db.collection("personalMovements").doc(id).delete();
      return res.status(200).json(await listData());
    }

    return res.status(405).json({ error: "Metodo no permitido." });
  } catch (error: any) {
    return res.status(401).json({ error: error?.message || String(error) });
  }
}
