import { timingSafeEqual } from "node:crypto";
import { getFirebaseAdminDb } from "../../_lib/firebaseAdmin.js";

type CashLocation = "safe" | "transit" | "bank" | "personal";

type ClosureRecord = {
  id: string;
  date: string;
  responsible: string;
  physicalAmount: number;
  systemBalance: number;
  difference: number;
  status: CashLocation;
  tripId: string | null;
  systemSource: string | null;
  perseoAuditStatus: string | null;
  source: string | null;
};

type TransferRecord = {
  date: string;
  amount: number;
  from: CashLocation;
  to: CashLocation;
};

const CASH_LOCATIONS: CashLocation[] = ["safe", "transit", "bank", "personal"];

const normalizeCashLocation = (value: unknown): CashLocation => {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (["bank", "banco", "en banco"].includes(normalized)) return "bank";
  if (["transit", "transito", "en transito", "camino", "viaje"].includes(normalized)) return "transit";
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

  closures.forEach((closure) => {
    const initialBalance = {
      safe: 0,
      transit: 0,
      bank: 0,
      personal: 0,
    };
    initialBalance[closure.status] = closure.physicalAmount;
    balances.set(closure.id, initialBalance);
  });

  [...transfers]
    .sort((left, right) => left.date.localeCompare(right.date))
    .forEach((transfer) => {
      if (transfer.from === transfer.to || transfer.amount <= 0) return;

      let remainingAmount = transfer.amount;
      const transferTime = new Date(transfer.date).getTime();
      const candidates = [...closures]
        .filter((closure) => {
          const closureTime = new Date(closure.date).getTime();
          if (Number.isNaN(transferTime) || Number.isNaN(closureTime)) return true;
          return closureTime <= transferTime;
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

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!process.env.BANQUITOS_INTEGRATION_SECRET) {
    return res.status(503).json({ ok: false, error: "Conector no configurado." });
  }

  if (!isAuthorizedIntegration(req)) {
    return res.status(401).json({ ok: false, error: "Conector no autorizado." });
  }

  try {
    const database = getFirebaseAdminDb();
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
        systemSource: data.systemSource ? String(data.systemSource) : null,
        perseoAuditStatus: data.perseoAuditStatus ? String(data.perseoAuditStatus) : null,
        source: data.source ? String(data.source) : null,
      };
    });

    const transfers: TransferRecord[] = movementsSnapshot.docs
      .map((document) => document.data())
      .filter((data) => (
        (data.type === "transfer" || data.type === "internal_transfer")
        && data.from
        && data.to
      ))
      .map((data) => ({
        date: toIso(data.date),
        amount: roundMoney(data.amount),
        from: normalizeCashLocation(data.from),
        to: normalizeCashLocation(data.to),
      }));

    const balances = buildStoreBalances(closures, transfers);
    const availableClosures = closures
      .filter((closure) => {
        if (closure.tripId) return false;
        const closureBalance = balances.get(closure.id);
        if (!closureBalance || closureBalance.safe <= 0.009) return false;
        return CASH_LOCATIONS
          .filter((location) => location !== "safe")
          .every((location) => closureBalance[location] <= 0.009);
      })
      .map((closure) => ({
        id: closure.id,
        date: closure.date,
        responsible: closure.responsible,
        amount: roundMoney(balances.get(closure.id)?.safe),
        physicalAmount: closure.physicalAmount,
        systemBalance: closure.systemBalance,
        difference: closure.difference,
        systemSource: closure.systemSource,
        auditStatus: closure.perseoAuditStatus,
        source: closure.source,
      }))
      .sort((left, right) => right.date.localeCompare(left.date));

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({
      ok: true,
      source: "cierres-caja-v2",
      generatedAt: new Date().toISOString(),
      closures: availableClosures,
    });
  } catch (error) {
    console.error("Error listando cortes disponibles para Banquitos:", error);
    return res.status(500).json({ ok: false, error: "No se pudieron cargar los cortes de tienda." });
  }
}
