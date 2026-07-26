import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getFirebaseAdminDb } from "./_lib/firebaseAdmin.js";

const defaultPersonalCategories = [
  "Alimentacion",
  "Entretenimiento",
  "Salud",
  "Transporte",
  "Servicios",
  "Casa",
  "Familia",
  "Educacion",
  "Transferencia familiar",
  "Otros",
];

const PERSONAL_MAIN_BOX_ID = "personal-main-box";

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
  const [boxesSnapshot, movementsSnapshot, categoriesSnapshot] = await Promise.all([
    db.collection("personalCashBoxes").orderBy("name", "asc").get(),
    db.collection("personalMovements").orderBy("date", "desc").limit(500).get(),
    db.collection("personalExpenseCategories").orderBy("name", "asc").get(),
  ]);

  const movementCategories = movementsSnapshot.docs
    .map((doc) => String(doc.data().category || "").trim())
    .filter(Boolean);
  const savedCategories = categoriesSnapshot.docs
    .map((doc) => String(doc.data().name || "").trim())
    .filter(Boolean);
  const categories = Array.from(new Set([...defaultPersonalCategories, ...savedCategories, ...movementCategories]));

  const allBoxes = boxesSnapshot.docs.map((doc) => {
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
  });
  const primaryBox = allBoxes.find((box) => box.id === PERSONAL_MAIN_BOX_ID) || allBoxes[0] || null;

  return {
    categories,
    boxes: primaryBox ? [primaryBox] : [],
    movements: movementsSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        date: serializeDate(data.date),
        type: data.type || "expense",
        amount: Number(data.amount || 0),
        description: data.description || "",
        category: data.category || "Otros",
        subcategory: data.subcategory || null,
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

        const ref = db.collection("personalCashBoxes").doc(PERSONAL_MAIN_BOX_ID);
        await ref.set({
          name,
          type: ["cash", "bank", "wallet", "savings", "other"].includes(body.type) ? body.type : "cash",
          openingBalance: Math.max(0, Number(body.openingBalance || 0)),
          color: String(body.color || "#8B5CF6").slice(0, 20),
          isActive: true,
          createdBy: user.uid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
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
          subcategory: body.subcategory ? String(body.subcategory).slice(0, 100) : null,
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

      if (body.kind === "category") {
        const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: "Falta nombre de categoria." });

        const ref = db.collection("personalExpenseCategories").doc(
          name
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^\w\s-]+/g, "")
            .replace(/\s+/g, "-")
        );

        await ref.set(
          {
            name,
            normalizedName: name
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " "),
            createdBy: user.uid,
            source: "app",
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        return res.status(200).json({ ...(await listData()) });
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
