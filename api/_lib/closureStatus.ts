import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";

const STATUSES = new Set(["safe", "transit", "bank", "banquitos"]);
const MAX_ITEMS = 250;

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

function normalizeBalances(value: any, status: string) {
  const source = value && typeof value === "object" ? value : {};
  const balances = {
    safe: Math.max(0, Number(source.safe) || 0),
    transit: Math.max(0, Number(source.transit) || 0),
    bank: Math.max(0, Number(source.bank) || 0),
    banquitos: Math.max(0, Number(source.banquitos) || 0),
  };
  const total = balances.safe + balances.transit + balances.bank + balances.banquitos;

  return {
    safe: status === "safe" ? Number(total.toFixed(2)) : 0,
    transit: status === "transit" ? Number(total.toFixed(2)) : 0,
    bank: status === "bank" ? Number(total.toFixed(2)) : 0,
    banquitos: status === "banquitos" ? Number(total.toFixed(2)) : 0,
  };
}

export async function handleClosureStatus(req: any, res: any) {
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
    const status = String(body.status || "");
    const items = Array.isArray(body.items) ? body.items : [];
    const tripId = body.tripId === null || typeof body.tripId === "string"
      ? body.tripId
      : null;

    if (!STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: "Estado no valido." });
    }
    if (items.length === 0 || items.length > MAX_ITEMS) {
      return res.status(400).json({ ok: false, error: "Cantidad de cierres no valida." });
    }

    const uniqueItems = Array.from(
      new Map(
        items
          .filter((item: any) => typeof item?.id === "string" && item.id)
          .map((item: any) => [item.id, item])
      ).values()
    ) as any[];
    const refs = uniqueItems.map(item => db.collection("closures").doc(item.id));
    const snapshots = await db.getAll(...refs);

    for (const snapshot of snapshots) {
      if (!snapshot.exists) {
        return res.status(404).json({ ok: false, error: `Cierre no encontrado: ${snapshot.id}` });
      }
      if (!isAdmin && snapshot.data()?.createdBy !== decoded.uid) {
        return res.status(403).json({ ok: false, error: "No autorizado para modificar este cierre." });
      }
    }

    const changedAt = FieldValue.serverTimestamp();
    const batch = db.batch();

    snapshots.forEach((snapshot, index) => {
      const item = uniqueItems[index];
      const current = item.cashBoxBalances || snapshot.data()?.cashBoxBalances || {};
      const targetBalances = normalizeBalances(current, status);

      batch.update(snapshot.ref, {
        status,
        tripId,
        cashBoxBalances: targetBalances,
        cashBoxBalancesUpdatedAt: changedAt,
        statusUpdatedAt: changedAt,
      });

      for (const from of ["safe", "transit", "bank", "banquitos"]) {
        const amount = Math.max(0, Number(current[from]) || 0);
        if (from === status || amount <= 0.009) continue;
        const historyRef = db.collection("closure_status_history").doc();
        batch.set(historyRef, {
          closureId: snapshot.id,
          changedAt,
          amount: Number(amount.toFixed(2)),
          responsible: String(snapshot.data()?.responsible || ""),
          createdBy: decoded.uid,
          from,
          to: status,
          createdAt: changedAt,
        });
      }
    });

    await batch.commit();
    return res.status(200).json({
      ok: true,
      updated: snapshots.length,
      status,
    });
  } catch (error: any) {
    console.error("closure-status failed", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "No se pudo cambiar el estado.",
    });
  }
}
