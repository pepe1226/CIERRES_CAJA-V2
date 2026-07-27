import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";

const STATUSES = new Set(["safe", "transit", "bank", "banquitos"]);
const MAX_ITEMS = 250;
const STORE_SNAPSHOT_COLLECTION = "integration_snapshots";
const STORE_SNAPSHOT_ID = "banquitos_store_closures";

const roundMoney = (value: unknown) => {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
};

const toIso = (value: any) => {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const buildStoreSnapshotSignature = (closures: Array<Record<string, unknown>>) => {
  const value = JSON.stringify(closures);
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

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
    const storeSnapshotRef = db.collection(STORE_SNAPSHOT_COLLECTION).doc(STORE_SNAPSHOT_ID);
    const publishedStoreSnapshot = await storeSnapshotRef.get();

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

    if (publishedStoreSnapshot.exists) {
      const changedIds = new Set(snapshots.map(snapshot => snapshot.id));
      const publishedData = publishedStoreSnapshot.data() || {};
      const nextClosures = (Array.isArray(publishedData.closures) ? publishedData.closures : [])
        .filter((closure: any) => !changedIds.has(String(closure?.id || "")));

      if (status === "safe" && !tripId) {
        snapshots.forEach((snapshot, index) => {
          const data = snapshot.data() || {};
          const current = uniqueItems[index].cashBoxBalances || data.cashBoxBalances || {};
          const targetBalances = normalizeBalances(current, status);
          if (targetBalances.safe <= 0.009) return;

          const physicalAmount = roundMoney(data.physicalAmount);
          const systemBalance = roundMoney(data.systemBalance);
          nextClosures.push({
            id: snapshot.id,
            date: toIso(data.date),
            responsible: String(data.responsible || "SIN RESPONSABLE"),
            amount: roundMoney(targetBalances.safe),
            physicalAmount,
            systemBalance,
            difference: roundMoney(data.difference ?? physicalAmount - systemBalance),
            systemSource: data.systemSource ? String(data.systemSource) : null,
            auditStatus: data.perseoAuditStatus ? String(data.perseoAuditStatus) : null,
            source: data.source ? String(data.source) : null,
          });
        });
      }

      nextClosures.sort((left: any, right: any) => String(right.date).localeCompare(String(left.date)));
      const limitedClosures = nextClosures.slice(0, 100);
      batch.set(storeSnapshotRef, {
        schemaVersion: 1,
        source: "cierres-caja-v2",
        signature: buildStoreSnapshotSignature(limitedClosures),
        generatedAt: changedAt,
        generatedBy: decoded.uid,
        count: limitedClosures.length,
        totalAmount: roundMoney(limitedClosures.reduce(
          (total: number, closure: any) => total + roundMoney(closure?.amount),
          0,
        )),
        closures: limitedClosures,
      });
    }

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
