import { createHash, timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";
import { downloadTelegramPhoto } from "./telegramMovement.js";

type CashLocation = "safe" | "transit" | "bank" | "personal" | "banquitos";

const normalizeCashLocation = (value: unknown): CashLocation => {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (["bank", "banco", "en banco"].includes(normalized)) return "bank";
  if (["transit", "transito", "en transito", "camino", "viaje"].includes(normalized)) return "transit";
  if (["banquitos", "banquitos tmch", "en banquitos"].includes(normalized)) return "banquitos";
  if (["personal", "caja personal", "mi caja", "caja mia", "gasto personal", "gastos personales", "finanzas personales"].includes(normalized)) {
    return "personal";
  }
  return "safe";
};

const toIso = (value: any) => {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const roundMoney = (value: unknown) => {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
};

const STORE_CLOSURES_CACHE_MS = 60_000;
const STORE_CLOSURES_STALE_MS = 24 * 60 * 60_000;
const STORE_CLOSURES_SNAPSHOT_COLLECTION = "integration_snapshots";
const STORE_CLOSURES_SNAPSHOT_ID = "banquitos_store_closures";
let storeClosuresCache: {
  loadedAt: number;
  generatedAt: string;
  closures: Array<Record<string, unknown>>;
} | null = null;
let storeClosuresRequest: Promise<Array<Record<string, unknown>>> | null = null;

const isQuotaExceededError = (error: any) => {
  const message = String(error?.message || "");
  return error?.code === 8
    || String(error?.code || "").includes("resource-exhausted")
    || message.includes("RESOURCE_EXHAUSTED")
    || message.includes("Quota exceeded");
};

const isAuthorizedIntegration = (req: any) => {
  const configuredSecret = String(process.env.BANQUITOS_INTEGRATION_SECRET || "");
  const receivedSecret = String(req.headers["x-integration-key"] || "");
  const configuredBuffer = Buffer.from(configuredSecret);
  const receivedBuffer = Buffer.from(receivedSecret);
  if (configuredBuffer.length < 16 || receivedBuffer.length !== configuredBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, configuredBuffer);
};

const getBody = (req: any) => {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
};

const getMovementDocumentId = (movementId: string) =>
  `banquitos_${createHash("sha256").update(movementId).digest("hex").slice(0, 40)}`;

const getReversalDocumentId = (movementId: string) =>
  `banquitos_reverse_${createHash("sha256").update(movementId).digest("hex").slice(0, 32)}`;

const buildPublishedClosure = (
  closureId: string,
  closure: Record<string, any>,
  amount: number,
) => ({
  id: closureId,
  date: toIso(closure.date),
  responsible: String(closure.responsible || "SIN RESPONSABLE"),
  amount: roundMoney(amount),
  physicalAmount: roundMoney(closure.physicalAmount),
  systemBalance: roundMoney(closure.systemBalance),
  difference: roundMoney(closure.difference),
  systemSource: closure.systemSource ? String(closure.systemSource) : null,
  auditStatus: closure.perseoAuditStatus ? String(closure.perseoAuditStatus) : null,
  source: closure.source ? String(closure.source) : null,
});

const getPrimaryLocation = (balances: Record<CashLocation, number>, fallback: CashLocation) => {
  const businessLocations: CashLocation[] = ["safe", "transit", "bank", "banquitos"];
  return businessLocations.reduce((primary, location) => (
    balances[location] > balances[primary] + 0.009 ? location : primary
  ), fallback === "personal" ? "safe" : fallback);
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

const loadPublishedStoreClosures = async (database: ReturnType<typeof getFirebaseAdminDb>) => {
  const snapshot = await database
    .collection(STORE_CLOSURES_SNAPSHOT_COLLECTION)
    .doc(STORE_CLOSURES_SNAPSHOT_ID)
    .get();

  if (!snapshot.exists) {
    throw Object.assign(new Error("El resumen de cortes todavia no fue publicado por Cierres de Caja."), {
      statusCode: 503,
    });
  }

  const data = snapshot.data() || {};
  const closures = Array.isArray(data.closures)
    ? data.closures
      .filter((closure) => closure && typeof closure === "object" && String(closure.id || "").trim())
      .slice(0, 100)
      .map((closure) => ({
        id: String(closure.id),
        date: String(closure.date || ""),
        responsible: String(closure.responsible || "SIN RESPONSABLE"),
        amount: roundMoney(closure.amount),
        physicalAmount: roundMoney(closure.physicalAmount),
        systemBalance: roundMoney(closure.systemBalance),
        difference: roundMoney(closure.difference),
        systemSource: closure.systemSource ? String(closure.systemSource) : null,
        auditStatus: closure.auditStatus ? String(closure.auditStatus) : null,
        source: closure.source ? String(closure.source) : null,
      }))
      .filter((closure) => closure.amount > 0.009)
      .sort((left, right) => right.date.localeCompare(left.date))
    : [];

  return {
    closures,
    generatedAt: toIso(data.generatedAt) || new Date().toISOString(),
  };
};

const getAvailableStoreClosures = async (
  database: ReturnType<typeof getFirebaseAdminDb>,
) => {
  const now = Date.now();
  if (
    storeClosuresCache
    && now - storeClosuresCache.loadedAt < STORE_CLOSURES_CACHE_MS
  ) {
    return { ...storeClosuresCache, cached: true, stale: false };
  }

  try {
    if (!storeClosuresRequest) {
      storeClosuresRequest = loadPublishedStoreClosures(database)
        .then((published) => {
          storeClosuresCache = { loadedAt: Date.now(), ...published };
          return published.closures;
        })
        .finally(() => {
          storeClosuresRequest = null;
        });
    }

    const closures = await storeClosuresRequest;
    return {
      closures,
      generatedAt: storeClosuresCache?.generatedAt || new Date().toISOString(),
      cached: false,
      stale: false,
    };
  } catch (error) {
    if (
      storeClosuresCache
      && now - storeClosuresCache.loadedAt < STORE_CLOSURES_STALE_MS
    ) {
      console.warn("Usando cache temporal de cortes por error de Firestore:", error);
      return { ...storeClosuresCache, cached: true, stale: true };
    }
    throw error;
  }
};

const sendClosurePhoto = async (req: any, res: any) => {
  const closureId = String(req.query?.closureId || "").trim();
  if (!closureId || closureId.length > 180 || closureId.includes("/")) {
    return res.status(400).json({ ok: false, error: "Corte no valido." });
  }

  const database = getFirebaseAdminDb();
  const snapshot = await database.collection("closures").doc(closureId).get();
  if (!snapshot.exists) {
    return res.status(404).json({ ok: false, error: "No se encontro el corte." });
  }

  const closure = snapshot.data() || {};
  const telegramFileId = String(closure.telegramFileId || "").trim();
  if (!telegramFileId) {
    return res.status(404).json({ ok: false, error: "Este corte no tiene una foto disponible." });
  }

  const downloaded = await downloadTelegramPhoto(telegramFileId);
  if (!downloaded.mimeType.startsWith("image/")) {
    return res.status(415).json({ ok: false, error: "El archivo del corte no es una imagen." });
  }

  res.setHeader("Content-Type", downloaded.mimeType);
  res.setHeader("Content-Length", String(downloaded.imageBuffer.length));
  res.setHeader("Content-Disposition", `inline; filename="corte-${closureId.replace(/[^a-zA-Z0-9_-]/g, "-")}.jpg"`);
  res.setHeader("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).send(downloaded.imageBuffer);
};

const transferClosureToBanquitos = async (req: any, res: any) => {
  const body = getBody(req);
  const closureId = String(body.closureId || "").trim();
  const movementId = String(body.movementId || "").trim();
  const amount = roundMoney(body.amount);
  const responsible = String(body.responsible || "BANQUITOS").trim().slice(0, 120) || "BANQUITOS";
  const occurredAt = body.occurredAt ? new Date(String(body.occurredAt)) : new Date();

  if (!closureId || !movementId || amount <= 0 || Number.isNaN(occurredAt.getTime())) {
    return res.status(400).json({ ok: false, error: "Datos del traslado no validos." });
  }

  const database = getFirebaseAdminDb();
  const movementDocumentId = getMovementDocumentId(movementId);
  const movementRef = database.collection("movements").doc(movementDocumentId);
  const closureRef = database.collection("closures").doc(closureId);
  const historyRef = database.collection("closure_status_history").doc();
  const storeSnapshotRef = database
    .collection(STORE_CLOSURES_SNAPSHOT_COLLECTION)
    .doc(STORE_CLOSURES_SNAPSHOT_ID);
  const existingMovement = await movementRef.get();

  if (existingMovement.exists) {
    const existing = existingMovement.data() || {};
    if (
      String(existing.externalMovementId || "") !== movementId
      || String(existing.closureId || "") !== closureId
      || Math.abs(roundMoney(existing.amount) - amount) > 0.009
    ) {
      return res.status(409).json({ ok: false, error: "El identificador ya pertenece a otro traslado." });
    }
    return res.status(200).json({
      ok: true,
      alreadySynced: true,
      movementId,
      closureId,
      amount,
      destination: "banquitos",
    });
  }

  const result = await database.runTransaction(async (transaction) => {
    const [movementSnapshot, closureSnapshot, publishedStoreSnapshot] = await Promise.all([
      transaction.get(movementRef),
      transaction.get(closureRef),
      transaction.get(storeSnapshotRef),
    ]);

    if (movementSnapshot.exists) {
      const existing = movementSnapshot.data() || {};
      if (
        String(existing.externalMovementId || "") !== movementId
        || String(existing.closureId || "") !== closureId
        || Math.abs(roundMoney(existing.amount) - amount) > 0.009
      ) {
        throw Object.assign(new Error("El identificador ya pertenece a otro traslado."), { statusCode: 409 });
      }
      return { alreadySynced: true };
    }
    if (!closureSnapshot.exists) {
      throw Object.assign(new Error("El corte ya no existe."), { statusCode: 404 });
    }

    const current = closureSnapshot.data() || {};
    const persisted = current.cashBoxBalances && typeof current.cashBoxBalances === "object"
      ? current.cashBoxBalances
      : null;
    const currentBalances: Record<CashLocation, number> = persisted
      ? {
          safe: Math.max(0, roundMoney(persisted.safe)),
          transit: Math.max(0, roundMoney(persisted.transit)),
          bank: Math.max(0, roundMoney(persisted.bank)),
          personal: 0,
          banquitos: Math.max(0, roundMoney(persisted.banquitos)),
        }
      : {
          safe: normalizeCashLocation(current.status) === "safe" ? roundMoney(current.physicalAmount) : 0,
          transit: normalizeCashLocation(current.status) === "transit" ? roundMoney(current.physicalAmount) : 0,
          bank: normalizeCashLocation(current.status) === "bank" ? roundMoney(current.physicalAmount) : 0,
          personal: 0,
          banquitos: normalizeCashLocation(current.status) === "banquitos" ? roundMoney(current.physicalAmount) : 0,
        };

    if (current.tripId) {
      throw Object.assign(new Error("El corte ya salio de Tienda hacia un viaje."), { statusCode: 409 });
    }
    if (Math.abs(currentBalances.safe - amount) > 0.009) {
      throw Object.assign(new Error("El monto disponible del corte cambio. Actualiza la lista antes de ingresarlo."), { statusCode: 409 });
    }

    currentBalances.safe = roundMoney(currentBalances.safe - amount);
    currentBalances.banquitos = roundMoney(currentBalances.banquitos + amount);
    const status = getPrimaryLocation(currentBalances, normalizeCashLocation(current.status));

    transaction.update(closureRef, {
      status,
      tripId: null,
      cashBoxBalances: {
        safe: currentBalances.safe,
        transit: currentBalances.transit,
        bank: currentBalances.bank,
        banquitos: currentBalances.banquitos,
      },
      cashBoxBalancesUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(movementRef, {
      type: "internal_transfer",
      amount,
      description: `CORTE DE TIENDA A BANQUITOS - ${String(current.responsible || "SIN RESPONSABLE")}`,
      createdBy: "banquitos-integration",
      responsible,
      from: "safe",
      to: "banquitos",
      closureId,
      source: "status_control",
      integrationSource: "banquitos-tmch",
      externalMovementId: movementId,
      date: Timestamp.fromDate(occurredAt),
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.create(historyRef, {
      closureId,
      changedAt: FieldValue.serverTimestamp(),
      amount,
      responsible: String(current.responsible || ""),
      createdBy: "banquitos-integration",
      from: "safe",
      to: "banquitos",
      externalMovementId: movementId,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (publishedStoreSnapshot.exists) {
      const publishedData = publishedStoreSnapshot.data() || {};
      const nextClosures = (Array.isArray(publishedData.closures) ? publishedData.closures : [])
        .filter((closure) => String(closure?.id || "") !== closureId);

      if (nextClosures.length !== Number(publishedData.count || 0)) {
        transaction.set(storeSnapshotRef, {
          schemaVersion: 1,
          source: "cierres-caja-v2",
          signature: buildStoreSnapshotSignature(nextClosures),
          generatedAt: FieldValue.serverTimestamp(),
          generatedBy: "banquitos-integration",
          count: nextClosures.length,
          totalAmount: roundMoney(nextClosures.reduce(
            (total, closure) => total + roundMoney(closure?.amount),
            0,
          )),
          closures: nextClosures,
        });
      }
    }

    return { alreadySynced: false };
  });

  storeClosuresCache = null;
  return res.status(200).json({
    ok: true,
    alreadySynced: result.alreadySynced,
    movementId,
    closureId,
    amount,
    destination: "banquitos",
  });
};

const reverseClosureFromBanquitos = async (req: any, res: any) => {
  const body = getBody(req);
  const closureId = String(body.closureId || "").trim();
  const movementId = String(body.movementId || "").trim();
  const responsible = String(body.responsible || "BANQUITOS").trim().slice(0, 120) || "BANQUITOS";
  const occurredAt = body.occurredAt ? new Date(String(body.occurredAt)) : new Date();

  if (!closureId || !movementId || Number.isNaN(occurredAt.getTime())) {
    return res.status(400).json({ ok: false, error: "Datos de la reversion no validos." });
  }

  const database = getFirebaseAdminDb();
  const movementRef = database.collection("movements").doc(getMovementDocumentId(movementId));
  const reversalRef = database.collection("movements").doc(getReversalDocumentId(movementId));
  const closureRef = database.collection("closures").doc(closureId);
  const historyRef = database.collection("closure_status_history").doc();
  const storeSnapshotRef = database
    .collection(STORE_CLOSURES_SNAPSHOT_COLLECTION)
    .doc(STORE_CLOSURES_SNAPSHOT_ID);

  const result = await database.runTransaction(async (transaction) => {
    const [movementSnapshot, reversalSnapshot, closureSnapshot, publishedStoreSnapshot] = await Promise.all([
      transaction.get(movementRef),
      transaction.get(reversalRef),
      transaction.get(closureRef),
      transaction.get(storeSnapshotRef),
    ]);

    if (!movementSnapshot.exists) {
      throw Object.assign(new Error("No existe el traslado original a Banquitos."), { statusCode: 404 });
    }
    const originalMovement = movementSnapshot.data() || {};
    const amount = roundMoney(originalMovement.amount);
    if (
      String(originalMovement.closureId || "") !== closureId
      || String(originalMovement.externalMovementId || "") !== movementId
      || amount <= 0
    ) {
      throw Object.assign(new Error("El traslado original no corresponde a este corte."), { statusCode: 409 });
    }
    if (reversalSnapshot.exists) {
      return { alreadyReversed: true, amount };
    }
    if (!closureSnapshot.exists) {
      throw Object.assign(new Error("El corte ya no existe."), { statusCode: 404 });
    }

    const current = closureSnapshot.data() || {};
    const persisted = current.cashBoxBalances && typeof current.cashBoxBalances === "object"
      ? current.cashBoxBalances
      : {};
    const currentBalances: Record<CashLocation, number> = {
      safe: Math.max(0, roundMoney(persisted.safe)),
      transit: Math.max(0, roundMoney(persisted.transit)),
      bank: Math.max(0, roundMoney(persisted.bank)),
      personal: 0,
      banquitos: Math.max(0, roundMoney(persisted.banquitos)),
    };

    if (current.tripId) {
      throw Object.assign(new Error("El corte pertenece a un viaje y no puede revertirse."), { statusCode: 409 });
    }
    if (currentBalances.banquitos + 0.009 < amount) {
      throw Object.assign(new Error("El dinero del corte ya no esta completo en Banquitos."), { statusCode: 409 });
    }

    currentBalances.banquitos = roundMoney(currentBalances.banquitos - amount);
    currentBalances.safe = roundMoney(currentBalances.safe + amount);
    const status = getPrimaryLocation(currentBalances, "safe");

    transaction.update(closureRef, {
      status,
      tripId: null,
      cashBoxBalances: {
        safe: currentBalances.safe,
        transit: currentBalances.transit,
        bank: currentBalances.bank,
        banquitos: currentBalances.banquitos,
      },
      cashBoxBalancesUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(reversalRef, {
      type: "internal_transfer",
      amount,
      description: `REVERSO DE BANQUITOS A TIENDA - ${String(current.responsible || "SIN RESPONSABLE")}`,
      createdBy: "banquitos-integration",
      responsible,
      from: "banquitos",
      to: "safe",
      closureId,
      source: "status_control",
      integrationSource: "banquitos-tmch",
      reversesExternalMovementId: movementId,
      date: Timestamp.fromDate(occurredAt),
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.create(historyRef, {
      closureId,
      changedAt: FieldValue.serverTimestamp(),
      amount,
      responsible: String(current.responsible || ""),
      createdBy: "banquitos-integration",
      from: "banquitos",
      to: "safe",
      reversesExternalMovementId: movementId,
      createdAt: FieldValue.serverTimestamp(),
    });

    const publishedData = publishedStoreSnapshot.exists ? publishedStoreSnapshot.data() || {} : {};
    const nextClosures = (Array.isArray(publishedData.closures) ? publishedData.closures : [])
      .filter((closure) => String(closure?.id || "") !== closureId);
    nextClosures.push(buildPublishedClosure(closureId, current, currentBalances.safe));
    nextClosures.sort((left, right) => String(right.date).localeCompare(String(left.date)));
    const limitedClosures = nextClosures.slice(0, 100);
    transaction.set(storeSnapshotRef, {
      schemaVersion: 1,
      source: "cierres-caja-v2",
      signature: buildStoreSnapshotSignature(limitedClosures),
      generatedAt: FieldValue.serverTimestamp(),
      generatedBy: "banquitos-integration",
      count: limitedClosures.length,
      totalAmount: roundMoney(limitedClosures.reduce(
        (total, closure) => total + roundMoney(closure?.amount),
        0,
      )),
      closures: limitedClosures,
    });

    return { alreadyReversed: false, amount };
  });

  storeClosuresCache = null;
  return res.status(200).json({
    ok: true,
    alreadyReversed: result.alreadyReversed,
    movementId,
    closureId,
    amount: result.amount,
    destination: "safe",
  });
};

export async function handleBanquitosClosures(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!process.env.BANQUITOS_INTEGRATION_SECRET) {
    return res.status(503).json({ ok: false, error: "Conector no configurado." });
  }
  if (!isAuthorizedIntegration(req)) {
    return res.status(401).json({ ok: false, error: "Conector no autorizado." });
  }

  try {
    if (req.method === "GET" && String(req.query?.action || "") === "photo") {
      return await sendClosurePhoto(req, res);
    }

    if (req.method === "POST") {
      const action = String(getBody(req).action || "transfer");
      return action === "reverse"
        ? await reverseClosureFromBanquitos(req, res)
        : await transferClosureToBanquitos(req, res);
    }

    const database = getFirebaseAdminDb();
    const available = await getAvailableStoreClosures(database);

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      ok: true,
      source: "cierres-caja-v2",
      generatedAt: available.generatedAt,
      cached: available.cached,
      stale: available.stale,
      closures: available.closures,
    });
  } catch (error) {
    console.error("Error listando cortes disponibles para Banquitos:", error);
    const errorText = String((error as any)?.message || "");
    const isQuotaError = isQuotaExceededError(error);
    const statusCode = isQuotaError ? 429 : Number((error as any)?.statusCode) || 500;
    return res.status(statusCode).json({
      ok: false,
      error: isQuotaError
        ? "Cierres alcanzo temporalmente el limite de consultas. Reintenta en unos minutos."
        : errorText || "No se pudieron procesar los cortes de tienda.",
    });
  }
}
