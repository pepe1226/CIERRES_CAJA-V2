import { createHash } from 'node:crypto';

export type PerseoReportFingerprintRow = {
  businessDate: string;
  responsibleKey: string;
  cashBoxKey?: string;
  systemAmount: number;
  systemBalance: number;
  reportedAmount: number;
  transferAmount: number;
};

function normalizedRow(row: PerseoReportFingerprintRow) {
  return {
    businessDate: row.businessDate,
    responsibleKey: row.responsibleKey,
    cashBoxKey: row.cashBoxKey || '',
    systemAmount: Number(row.systemAmount.toFixed(2)),
    systemBalance: Number(row.systemBalance.toFixed(2)),
    reportedAmount: Number(row.reportedAmount.toFixed(2)),
    transferAmount: Number(row.transferAmount.toFixed(2)),
  };
}

export function buildPerseoReportFingerprint(
  rows: PerseoReportFingerprintRow[],
  dailySystemAmountByDate?: Record<string, number>,
) {
  const normalizedRows = rows
    .map(normalizedRow)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const normalizedDailyTotals = Object.entries(dailySystemAmountByDate || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, amount]) => [date, Number(Number(amount || 0).toFixed(2))]);

  return createHash('sha256')
    .update(JSON.stringify({ rows: normalizedRows, dailySystemAmountByDate: normalizedDailyTotals }))
    .digest('hex');
}
