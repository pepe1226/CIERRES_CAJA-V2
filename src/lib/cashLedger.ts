import type { Movement, ShiftClosure } from '../types';

export type CashBoxStatus = 'safe' | 'transit' | 'bank';
export type DisplayClosureStatus = CashBoxStatus | 'mixed';

export type ClosureLedgerEntry = {
  displayStatus: CashBoxStatus;
  hasSplitBalance: boolean;
  balances: Record<CashBoxStatus, number>;
};

const cashBoxStatuses: CashBoxStatus[] = ['safe', 'transit', 'bank'];
const cashBoxStatusPriority: CashBoxStatus[] = ['safe', 'transit', 'bank'];

export const normalizeCashBoxStatus = (status?: string | null): CashBoxStatus => {
  const normalized = String(status || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (['bank', 'banco', 'en banco'].includes(normalized)) return 'bank';
  if (['transit', 'transito', 'en transito', 'camino', 'viaje'].includes(normalized)) return 'transit';
  return 'safe';
};

const getPrimaryCashBoxStatus = (
  balance: Record<CashBoxStatus, number>
): CashBoxStatus => cashBoxStatusPriority.reduce<CashBoxStatus>((primary, status) => {
  const primaryAmount = balance[primary] || 0;
  const statusAmount = balance[status] || 0;

  if (statusAmount > primaryAmount + 0.009) return status;
  if (Math.abs(statusAmount - primaryAmount) <= 0.009 && statusAmount > 0.009) return status;
  return primary;
}, 'safe');

export const buildClosureLedger = (
  closures: ShiftClosure[],
  movements: Movement[]
): Record<string, ClosureLedgerEntry> => {
  const balances: Record<string, Record<CashBoxStatus, number>> = {};

  closures.forEach(closure => {
    if (!closure.id) return;

    balances[closure.id] = { safe: 0, transit: 0, bank: 0 };
    balances[closure.id][normalizeCashBoxStatus(closure.status)] = Number(closure.physicalAmount) || 0;
  });

  // Reuse this ordering for every transfer instead of sorting all closures repeatedly.
  const newestClosures = closures
    .filter((closure): closure is ShiftClosure & { id: string } => Boolean(closure.id))
    .map(closure => ({ closure, time: new Date(closure.date).getTime() }))
    .sort((a, b) => b.closure.date.localeCompare(a.closure.date));

  movements
    .filter(movement =>
      (movement.type === 'transfer' || movement.type === 'internal_transfer') &&
      movement.from &&
      movement.to
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(movement => {
      const from = normalizeCashBoxStatus(movement.from);
      const to = normalizeCashBoxStatus(movement.to);
      if (from === to) return;

      let remainingAmount = Number(movement.amount) || 0;
      if (remainingAmount <= 0) return;

      const movementTime = new Date(movement.date).getTime();

      for (const { closure, time: closureTime } of newestClosures) {
        if (!Number.isNaN(movementTime) && !Number.isNaN(closureTime) && closureTime > movementTime) {
          continue;
        }

        const closureBalance = balances[closure.id];
        const availableAmount = closureBalance?.[from] || 0;
        if (availableAmount <= 0) continue;

        const movedAmount = Math.min(availableAmount, remainingAmount);
        closureBalance[from] -= movedAmount;
        closureBalance[to] += movedAmount;
        remainingAmount -= movedAmount;

        if (remainingAmount <= 0.009) break;
      }
    });

  return Object.entries(balances).reduce((result, [closureId, balance]) => {
    const activeStatuses = cashBoxStatuses.filter(status => balance[status] > 0.009);
    result[closureId] = {
      displayStatus: activeStatuses.length === 0 ? 'safe' : getPrimaryCashBoxStatus(balance),
      hasSplitBalance: activeStatuses.length > 1,
      balances: balance
    };
    return result;
  }, {} as Record<string, ClosureLedgerEntry>);
};

export const getDerivedClosureStatuses = (
  ledgerById: Record<string, ClosureLedgerEntry>
) => Object.entries(ledgerById).reduce((result, [closureId, ledger]) => {
  result[closureId] = ledger.displayStatus;
  return result;
}, {} as Record<string, CashBoxStatus>);

export const getDayClosureStatus = (
  items: ShiftClosure[],
  ledgerById: Record<string, ClosureLedgerEntry>,
  derivedStatusById: Record<string, CashBoxStatus>
): DisplayClosureStatus => {
  if (items.length === 0) return 'safe';

  const hasSplitClosure = items.some(item => item.id && ledgerById[item.id]?.hasSplitBalance);
  const statuses = items.map(item =>
    item.id && derivedStatusById[item.id]
      ? derivedStatusById[item.id]
      : normalizeCashBoxStatus(item.status)
  );

  if (statuses.every(status => status === 'bank')) return 'bank';
  if (statuses.every(status => status === 'transit')) return 'transit';
  if (statuses.every(status => status === 'safe') && !hasSplitClosure) return 'safe';
  return 'mixed';
};
