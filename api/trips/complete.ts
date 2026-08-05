import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "../_lib/firebaseAdmin.js";
import { computeTripSpend, planTripCompletion } from "../_lib/tripCompletion.js";

/**
 * Cierra un viaje de recoleccion en una sola transaccion.
 *
 * Antes esto eran dos escrituras sueltas desde el navegador: primero se marcaba el
 * viaje completado y despues se movian los cierres. Si la segunda fallaba, el viaje
 * quedaba cerrado con el dinero todavia en transito.
 *
 * Ademas, aquellos cierres pasaban enteros a Banco, pero lo gastado por el camino
 * salio de Transito y no vuelve: Banco quedaba inflado y Transito en negativo. El
 * reparto correcto lo decide planTripCompletion.
 *
 * El gasto se calcula aqui, en el servidor, y no se acepta del cliente.
 */

function getBody(req: any) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function getBearerToken(req: any) {
  const header = String(req.headers?.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const toIso = (value: any) => {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const db = getFirebaseAdminDb();
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "Falta autenticacion." });
    }

    const decoded = await getAuth(getApps()[0]).verifyIdToken(token);
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    const isAdmin =
      userDoc.data()?.role === "admin" ||
      (decoded.email === "noop1226@gmail.com" && decoded.email_verified === true);

    const body = getBody(req);
    const tripId = String(body.tripId || "");
    if (!tripId) {
      return res.status(400).json({ ok: false, error: "Falta el viaje." });
    }

    const tripRef = db.collection("trips").doc(tripId);

    const result = await db.runTransaction(async (transaction) => {
      const tripSnap = await transaction.get(tripRef);
      if (!tripSnap.exists) {
        throw Object.assign(new Error("Viaje no encontrado."), { statusCode: 404 });
      }

      const trip = tripSnap.data() || {};
      if (!isAdmin && trip.createdBy !== decoded.uid) {
        throw Object.assign(new Error("No autorizado para cerrar este viaje."), { statusCode: 403 });
      }
      if (trip.status === "completed") {
        throw Object.assign(new Error("Este viaje ya estaba cerrado."), { statusCode: 409 });
      }

      const [closuresSnap, movementsSnap] = await Promise.all([
        transaction.get(db.collection("closures").where("tripId", "==", tripId)),
        transaction.get(db.collection("movements").where("type", "==", "outflow"))
      ]);

      if (closuresSnap.empty) {
        throw Object.assign(new Error("El viaje no tiene cierres asociados."), { statusCode: 409 });
      }

      const spent = computeTripSpend(
        { id: tripId, startDate: toIso(trip.startDate), completionDate: undefined },
        movementsSnap.docs.map((doc) => {
          const data = doc.data();
          return {
            type: String(data.type || ""),
            from: data.from ?? null,
            amount: Number(data.amount) || 0,
            date: toIso(data.date),
            tripId: data.tripId ?? null
          };
        })
      );

      const plan = planTripCompletion(
        closuresSnap.docs.map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            date: toIso(data.date),
            balances: data.cashBoxBalances || {}
          };
        }),
        spent
      );

      const changedAt = FieldValue.serverTimestamp();

      transaction.update(tripRef, {
        status: "completed",
        completionDate: changedAt
      });

      for (const write of plan.writes) {
        transaction.update(db.collection("closures").doc(write.id), {
          status: write.status,
          cashBoxBalances: write.balances,
          cashBoxBalancesUpdatedAt: changedAt,
          statusUpdatedAt: changedAt
        });
      }

      return { carried: plan.carried, spent: plan.spent, deposited: plan.deposited, closures: plan.writes.length };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      ok: false,
      error: error?.message || "No se pudo cerrar el viaje."
    });
  }
}
