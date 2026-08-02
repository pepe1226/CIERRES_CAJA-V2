import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";

const STATUSES = new Set(["safe", "transit", "bank", "banquitos"]);
const MAX_ITEMS = 90;
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

function getStoredBalances(data: any) {
  const persisted = data?.cashBoxBalances;
  if (persisted && typeof persisted === "object") {
    return {
      safe: Math.max(0, roundMoney(persisted.safe)),
      transit: Math.max(0, roundMoney(persisted.transit)),
      bank: Math.max(0, roundMoney(persisted.bank)),
      banquitos: Math.max(0, roundMoney(persisted.banquitos)),
    };
  }

  const status = STATUSES.has(String(data?.status || "")) ? String(data.status) : "safe";
  const amount = Math.max(0, roundMoney(data?.physicalAmount));
  return {
    safe: status === "safe" ? amount : 0,
    transit: status === "transit" ? amount : 0,
    bank: status === "bank" ? amount : 0,
    banquitos: status === "banquitos" ? amount : 0,
  };
}

function balancesMatch(left: any, right: any) {
  return ["safe", "transit", "bank", "banquitos"].every(
    location => Math.abs(roundMoney(left?.[location]) - roundMoney(right?.[location])) <= 0.009,
  );
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
    const shouldUpdateTripId = Object.prototype.hasOwnProperty.call(body, "tripId");
    const tripId = body.tripId === null || typeof body.tripId === "string"
      ? body.tripId
      : undefined;

    if (shouldUpdateTripId && tripId === undefined) {
      return res.status(400).json({ ok: false, error: "Viaje no valido." });
    }

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
    if (uniqueItems.length === 0 || uniqueItems.length !== items.length) {
      return res.status(400).json({ ok: false, error: "La lista de cierres contiene elementos invalidos o repetidos." });
    }
    const refs = uniqueItems.map(item => db.collection("closures").doc(item.id));
    const storeSnapshotRef = db.collection(STORE_SNAPSHOT_COLLECTION).doc(STORE_SNAPSHOT_ID);
    const result = await db.runTransaction(async transaction => {
      const snapshots = await transaction.getAll(...refs);
      const publishedStoreSnapshot = await transaction.get(storeSnapshotRef);

      for (const snapshot of snapshots) {
        if (!snapshot.exists) {
          throw Object.assign(new Error(`Cierre no encontrado: ${snapshot.id}`), { statusCode: 404 });
        }
        if (!isAdmin && snapshot.data()?.createdBy !== decoded.uid) {
          throw Object.assign(new Error("No autorizado para modificar este cierre."), { statusCode: 403 });
        }
      }

      const preparedChanges = snapshots.map(snapshot => {
        const data = snapshot.data() || {};
        const currentBalances = getStoredBalances(data);
        const nonBanquitosAmount = currentBalances.safe + currentBalances.transit + currentBalances.bank;

        if (currentBalances.banquitos > 0.009 && status !== "banquitos") {
          throw Object.assign(
            new Error("Este cierre tiene dinero en Banquitos. Usa Reversar a Tienda desde Banquitos."),
            { statusCode: 409 }
          );
        }
        if (status === "banquitos" && nonBanquitosAmount > 0.009) {
          throw Object.assign(
            new Error("El ingreso a Banquitos debe realizarse desde Banquitos para conservar el movimiento vinculado."),
            { statusCode: 409 }
          );
        }
        if (data.tripId && !shouldUpdateTripId) {
          throw Object.assign(
            new Error("Este cierre pertenece a un viaje. Cambia su estado desde el modulo de Recolecciones."),
            { statusCode: 409 }
          );
        }

        const targetBalances = normalizeBalances(currentBalances, status);
        const tripChanged = shouldUpdateTripId && (data.tripId || null) !== tripId;
        const changed = data.status !== status || !balancesMatch(currentBalances, targetBalances) || tripChanged;
        return { snapshot, data, currentBalances, targetBalances, changed };
      });
      const changedEntries = preparedChanges.filter(entry => entry.changed);
      if (changedEntries.length === 0) {
        return { updated: 0, unchanged: snapshots.length };
      }

      const changedAt = FieldValue.serverTimestamp();
      changedEntries.forEach(({ snapshot, currentBalances, targetBalances }) => {
        const updateData: Record<string, unknown> = {
          status,
          cashBoxBalances: targetBalances,
          cashBoxBalancesUpdatedAt: changedAt,
          statusUpdatedAt: changedAt,
        };
        if (shouldUpdateTripId) updateData.tripId = tripId;
        transaction.update(snapshot.ref, updateData);

        for (const from of ["safe", "transit", "bank", "banquitos"]) {
          const amount = Math.max(0, Number(currentBalances[from]) || 0);
          if (from === status || amount <= 0.009) continue;
          transaction.set(db.collection("closure_status_history").doc(), {
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
        const changedIds = new Set(changedEntries.map(entry => entry.snapshot.id));
        const publishedData = publishedStoreSnapshot.data() || {};
        const nextClosures = (Array.isArray(publishedData.closures) ? publishedData.closures : [])
          .filter((closure: any) => !changedIds.has(String(closure?.id || "")));

        if (status === "safe" && !tripId) {
          changedEntries.forEach(({ snapshot, data, targetBalances }) => {
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
        transaction.set(storeSnapshotRef, {
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

      return { updated: changedEntries.length, unchanged: snapshots.length - changedEntries.length };
    });

    return res.status(200).json({
      ok: true,
      updated: result.updated,
      unchanged: result.unchanged,
      status,
    });
  } catch (error: any) {
    console.error("closure-status failed", error);
    return res.status(Number(error?.statusCode) || 500).json({
      ok: false,
      error: error?.message || "No se pudo cambiar el estado.",
    });
  }
}
