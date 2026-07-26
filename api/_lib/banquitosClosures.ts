import { createHash, timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "./firebaseAdmin.js";

type CashLocation = "safe" | "transit" | "bank" | "personal" | "banquitos";

type ClosureRecord = {
  id: string;
  date: string;
  responsible: string;
  physicalAmount: number;
  systemBalance: number;
  difference: number;
  status: CashLocation;
  tripId: string | null;
  cashBoxBalances: Partial<Record<CashLocation, number>> | null;
  cashBoxBalancesUpdatedAt: string | null;
  systemSource: string | null;
  perseoAuditStatus: string | null;
  source: string | null;
};

type TransferRecord = {
  date: string;
  amount: number;
  from: CashLocation;
  to: CashLocation;
  source: string | null;
  closureId: string | null;
};

const CASH_LOCATIONS: CashLocation[] = ["safe", "transit", "bank", "personal", "banquitos"];

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

const STORE_CLOSURES_CACHE_MS = 15_000;
const STORE_CLOSURES_STALE_MS = 10 * 60_000;
const STORE_CLOSURES_QUOTA_BACKOFF_MS = 30 * 60_000;
const STORE_CLOSURES_BOOTSTRAP_SNAPSHOT = {
  generatedAt: "2026-07-26T16:57:09.553Z",
  closures: [
    {
      id: "telegram_2026-07-25_YULEXI_UEM9DEAVUYRCI17GZT32LPHF2C72",
      date: "2026-07-25T12:00:00.000Z",
      responsible: "YULEXI",
      amount: 166.8,
    },
    {
      id: "telegram_2026-07-25_JOHANNA_UEM9DEAVUYRCI17GZT32LPHF2C72",
      date: "2026-07-25T12:00:00.000Z",
      responsible: "JOHANNA",
      amount: 79.62,
    },
    {
      id: "telegram_2026-07-25_ERICK_UEM9DEAVUYRCI17GZT32LPHF2C72",
      date: "2026-07-25T12:00:00.000Z",
      responsible: "ERICK",
      amount: 168.39,
    },
    {
      id: "telegram_2026-02-10_1115_ERICK_UEM9DEAVUYRCI17GZT32LPHF2C72",
      date: "2026-02-10T12:00:00.000Z",
      responsible: "ERICK",
      amount: 11.15,
    },
  ],
};
let storeClosuresCache: {
  loadedAt: number;
  closures: Array<Record<string, unknown>>;
} | null = null;
let storeClosuresRequest: Promise<Array<Record<string, unknown>>> | null = null;
let storeClosuresQuotaBackoffUntil = 0;

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

const buildStoreBalances = (closures: ClosureRecord[], transfers: TransferRecord[]) => {
  const balances = new Map<string, Record<CashLocation, number>>();
  const balanceBaselineByClosureId = new Map<string, number>();

  closures.forEach((closure) => {
    const persistedBalances = closure.cashBoxBalances;
    const hasPersistedBalances = persistedBalances && typeof persistedBalances === "object";
    const initialBalance: Record<CashLocation, number> = hasPersistedBalances
      ? {
          safe: Math.max(0, Number(persistedBalances.safe) || 0),
          transit: Math.max(0, Number(persistedBalances.transit) || 0),
          bank: Math.max(0, Number(persistedBalances.bank) || 0),
          personal: 0,
          banquitos: Math.max(0, Number(persistedBalances.banquitos) || 0),
        }
      : { safe: 0, transit: 0, bank: 0, personal: 0, banquitos: 0 };

    if (!hasPersistedBalances) initialBalance[closure.status] = closure.physicalAmount;
    balances.set(closure.id, initialBalance);

    const baselineTime = closure.cashBoxBalancesUpdatedAt
      ? new Date(closure.cashBoxBalancesUpdatedAt).getTime()
      : Number.NaN;
    balanceBaselineByClosureId.set(closure.id, Number.isNaN(baselineTime) ? 0 : baselineTime);
  });

  [...transfers]
    .sort((left, right) => left.date.localeCompare(right.date))
    .forEach((transfer) => {
      if (
        transfer.from === "personal"
        || transfer.to === "personal"
        || transfer.from === transfer.to
        || transfer.amount <= 0
      ) return;

      let remainingAmount = transfer.amount;
      const transferTime = new Date(transfer.date).getTime();
      const candidates = [...closures]
        .filter((closure) => {
          if (transfer.closureId && transfer.closureId !== closure.id) return false;
          const closureTime = new Date(closure.date).getTime();
          const baselineTime = balanceBaselineByClosureId.get(closure.id) || 0;
          if (Number.isNaN(transferTime) || Number.isNaN(closureTime)) return true;
          return closureTime <= transferTime && transferTime > baselineTime;
        })
        .sort((left, right) => right.date.localeCompare(left.date));

      for (const closure of candidates) {
        const closureBalance = balances.get(closure.id);
        if (!closureBalance || closureBalance[transfer.from] <= 0) continue;

        const movedAmount = Math.min(closureBalance[transfer.from], remainingAmount);
        closureBalance[transfer.from] -= movedAmount;
        closureBalance[transfer.to] += movedAmount;
        remainingAmount -= movedAmount;
        if (remainingAmount <= 0.009) break;
      }
    });

  return balances;
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

const getPrimaryLocation = (balances: Record<CashLocation, number>, fallback: CashLocation) => {
  const businessLocations: CashLocation[] = ["safe", "transit", "bank", "banquitos"];
  return businessLocations.reduce((primary, location) => (
    balances[location] > balances[primary] + 0.009 ? location : primary
  ), fallback === "personal" ? "safe" : fallback);
};

const loadAvailableStoreClosures = async (database: ReturnType<typeof getFirebaseAdminDb>) => {
  const snapshot = await database
    .collection("closures")
    .where("status", "==", "safe")
    .limit(100)
    .get();

  return snapshot.docs
    .map((document) => {
      const data = document.data();
      const physicalAmount = roundMoney(data.physicalAmount);
      const systemBalance = roundMoney(data.systemBalance);
      const persisted = data.cashBoxBalances && typeof data.cashBoxBalances === "object"
        ? data.cashBoxBalances
        : null;
      const safeAmount = persisted ? roundMoney(persisted.safe) : physicalAmount;
      const hasMoneyOutsideStore = persisted && ["transit", "bank", "banquitos"]
        .some((location) => roundMoney(persisted[location]) > 0.009);

      if (data.tripId || safeAmount <= 0.009 || hasMoneyOutsideStore) return null;

      return {
        id: document.id,
        date: toIso(data.date),
        responsible: String(data.responsible || "SIN RESPONSABLE"),
        amount: safeAmount,
        physicalAmount,
        systemBalance,
        difference: roundMoney(data.difference ?? physicalAmount - systemBalance),
        systemSource: data.systemSource ? String(data.systemSource) : null,
        auditStatus: data.perseoAuditStatus ? String(data.perseoAuditStatus) : null,
        source: data.source ? String(data.source) : null,
      };
    })
    .filter((closure): closure is NonNullable<typeof closure> => Boolean(closure))
    .sort((left, right) => String(right.date).localeCompare(String(left.date)));
};

const getAvailableStoreClosures = async (
  database: ReturnType<typeof getFirebaseAdminDb>,
  forceRefresh: boolean,
) => {
  const now = Date.now();
  if (
    !forceRefresh
    && storeClosuresCache
    && now - storeClosuresCache.loadedAt < STORE_CLOSURES_CACHE_MS
  ) {
    return { closures: storeClosuresCache.closures, cached: true, stale: false };
  }
  if (now < storeClosuresQuotaBackoffUntil) {
    if (storeClosuresCache) {
      return { closures: storeClosuresCache.closures, cached: true, stale: true };
    }
    const closures = STORE_CLOSURES_BOOTSTRAP_SNAPSHOT.closures;
    storeClosuresCache = { loadedAt: Date.now(), closures };
    return { closures, cached: true, stale: true };
  }

  try {
    storeClosuresRequest ||= loadAvailableStoreClosures(database);
    const closures = await storeClosuresRequest;
    storeClosuresCache = { loadedAt: Date.now(), closures };
    storeClosuresQuotaBackoffUntil = 0;
    return { closures, cached: false, stale: false };
  } catch (error) {
    if (isQuotaExceededError(error)) {
      storeClosuresQuotaBackoffUntil = Date.now() + STORE_CLOSURES_QUOTA_BACKOFF_MS;
    }
    if (
      storeClosuresCache
      && now - storeClosuresCache.loadedAt < STORE_CLOSURES_STALE_MS
    ) {
      console.warn("Usando cache temporal de cortes por error de Firestore:", error);
      return { closures: storeClosuresCache.closures, cached: true, stale: true };
    }
    if (isQuotaExceededError(error)) {
      const closures = STORE_CLOSURES_BOOTSTRAP_SNAPSHOT.closures;
      storeClosuresCache = { loadedAt: Date.now(), closures };
      return { closures, cached: true, stale: true };
    }
    throw error;
  } finally {
    storeClosuresRequest = null;
  }
};

const loadClosureLedger = async (database: ReturnType<typeof getFirebaseAdminDb>) => {
  const [closuresSnapshot, movementsSnapshot] = await Promise.all([
    database.collection("closures").orderBy("date", "desc").limit(1000).get(),
    database.collection("movements").orderBy("date", "asc").limit(3000).get(),
  ]);

  const closures: ClosureRecord[] = closuresSnapshot.docs.map((document) => {
    const data = document.data();
    const physicalAmount = roundMoney(data.physicalAmount);
    const systemBalance = roundMoney(data.systemBalance);
    return {
      id: document.id,
      date: toIso(data.date),
      responsible: String(data.responsible || "SIN RESPONSABLE"),
      physicalAmount,
      systemBalance,
      difference: roundMoney(data.difference ?? physicalAmount - systemBalance),
      status: normalizeCashLocation(data.status),
      tripId: data.tripId ? String(data.tripId) : null,
      cashBoxBalances: data.cashBoxBalances && typeof data.cashBoxBalances === "object"
        ? data.cashBoxBalances
        : null,
      cashBoxBalancesUpdatedAt: data.cashBoxBalancesUpdatedAt
        ? toIso(data.cashBoxBalancesUpdatedAt)
        : null,
      systemSource: data.systemSource ? String(data.systemSource) : null,
      perseoAuditStatus: data.perseoAuditStatus ? String(data.perseoAuditStatus) : null,
      source: data.source ? String(data.source) : null,
    };
  });

  const transfers: TransferRecord[] = movementsSnapshot.docs
    .map((document) => document.data())
    .filter((data) => (
      (data.type === "transfer" || data.type === "internal_transfer")
      && data.source !== "status_control"
      && data.from
      && data.to
    ))
    .map((data) => ({
      date: toIso(data.date),
      amount: roundMoney(data.amount),
      from: normalizeCashLocation(data.from),
      to: normalizeCashLocation(data.to),
      source: data.source ? String(data.source) : null,
      closureId: data.closureId ? String(data.closureId) : null,
    }));

  return { closures, balances: buildStoreBalances(closures, transfers) };
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
    const [movementSnapshot, closureSnapshot] = await Promise.all([
      transaction.get(movementRef),
      transaction.get(closureRef),
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
    if (req.method === "POST") {
      return await transferClosureToBanquitos(req, res);
    }

    const database = getFirebaseAdminDb();
    const forceRefresh = String(req.query?.refresh || "") === "1";
    const available = await getAvailableStoreClosures(database, forceRefresh);

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      ok: true,
      source: "cierres-caja-v2",
      generatedAt: new Date().toISOString(),
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
