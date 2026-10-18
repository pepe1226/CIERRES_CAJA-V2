export type CashboxMonth = { month: string; count: number; totalCents: number; hash: string };
export type PerseoCashbox = { id: number; name: string; balanceCents: number; lastMovementDate: string | null; months: CashboxMonth[] };
export type CashboxMovement = { id: number; date: string; recordedAt: string; amountCents: number; type: string; description: string; reference: string };
export type CashboxRow = CashboxMovement & { incomeCents: number; expenseCents: number; balanceCents: number };
export type CashboxLedger = {
  boxId: number; from: string; to: string; openingBalanceCents: number; closingBalanceCents: number;
  incomeCents: number; expenseCents: number; movements: CashboxRow[];
};
export type CashboxColumn = 'date' | 'reference' | 'description' | 'type' | 'incomeCents' | 'expenseCents' | 'balanceCents';
export type CashboxFilter = { values?: string[]; min?: string; max?: string };
export type CashboxFilters = Partial<Record<CashboxColumn, CashboxFilter>>;
export type CashboxSort = { column: CashboxColumn; direction: 'asc' | 'desc' };

export function isCashboxDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function buildCashboxLedger(box: PerseoCashbox, histories: Map<string, CashboxMovement[]>, from: string, to: string): CashboxLedger {
  if (!isCashboxDate(from) || !isCashboxDate(to) || from > to) throw new Error('Rango de fechas no válido.');
  const startMonth = from.slice(0, 7);
  let balance = box.months.filter(item => item.month < startMonth).reduce((sum, item) => sum + item.totalCents, 0);
  const entries = box.months.filter(item => item.month >= startMonth && item.month <= to.slice(0, 7)).flatMap(item => {
    const rows = histories.get(item.month);
    if (!rows || rows.length !== item.count || rows.reduce((sum, row) => sum + row.amountCents, 0) !== item.totalCents) {
      throw new Error('Historial pendiente de sincronización. Actualiza la vista en unos instantes.');
    }
    return rows;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  let incomeCents = 0;
  let expenseCents = 0;
  const movements: CashboxRow[] = [];
  for (const entry of entries) {
    if (entry.date >= from) continue;
    balance += entry.amountCents;
  }
  const openingBalanceCents = balance;
  for (const entry of entries) {
    if (entry.date < from || entry.date > to) continue;
    balance += entry.amountCents;
    const income = Math.max(0, entry.amountCents);
    const expense = Math.max(0, -entry.amountCents);
    incomeCents += income;
    expenseCents += expense;
    movements.push({ ...entry, incomeCents: income, expenseCents: expense, balanceCents: balance });
  }
  return { boxId: box.id, from, to, openingBalanceCents, closingBalanceCents: balance, incomeCents, expenseCents, movements };
}

export const cashboxText = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
export const cashboxType = (type: string) => type === 'IN' ? 'Ingreso' : type === 'EG' ? 'Egreso' : type;
export const cashboxCell = (row: CashboxRow, column: CashboxColumn): string | number => column === 'type' ? cashboxType(row.type) : row[column];
export const isCashboxNumericColumn = (column: CashboxColumn) => ['incomeCents', 'expenseCents', 'balanceCents'].includes(column);

export function filterCashboxRows(rows: CashboxRow[], search: string, filters: CashboxFilters, sort: CashboxSort): CashboxRow[] {
  const query = cashboxText(search);
  return rows.filter(row => {
    if (query && !cashboxText([row.id, row.date, row.reference, row.description, cashboxType(row.type), row.recordedAt,
      (row.amountCents / 100).toFixed(2), (row.balanceCents / 100).toFixed(2)].join(' ')).includes(query.replace(',', '.'))) return false;
    return Object.entries(filters).every(([key, filter]) => {
      const column = key as CashboxColumn;
      const value = cashboxCell(row, column);
      if (filter.values !== undefined && !filter.values.includes(String(value))) return false;
      if (isCashboxNumericColumn(column)) {
        const min = filter.min?.trim() ? Number(filter.min.replace(',', '.')) * 100 : null;
        const max = filter.max?.trim() ? Number(filter.max.replace(',', '.')) * 100 : null;
        if (min !== null && (!Number.isFinite(min) || Number(value) < Math.round(min))) return false;
        if (max !== null && (!Number.isFinite(max) || Number(value) > Math.round(max))) return false;
      }
      return true;
    });
  }).sort((a, b) => {
    const left = cashboxCell(a, sort.column);
    const right = cashboxCell(b, sort.column);
    const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'es', { numeric: true });
    return (comparison || a.date.localeCompare(b.date) || a.id - b.id) * (sort.direction === 'asc' ? 1 : -1);
  });
}

export function cashboxCsv(rows: CashboxRow[]): string {
  const text = (value: string) => `"${(/^[\s]*[=+\-@]/.test(value) ? "'" + value : value).replace(/"/g, '""')}"`;
  const amount = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
  const header = ['Movimiento', 'Fecha', 'Fecha de registro', 'Comprobante', 'Concepto', 'Tipo', 'Ingresos', 'Egresos', 'Saldo'].map(text).join(';');
  return '\uFEFF' + [header, ...rows.map(row => [String(row.id), text(row.date), text(row.recordedAt), text(row.reference),
    text(row.description), text(cashboxType(row.type)), amount(row.incomeCents), amount(row.expenseCents), amount(row.balanceCents)].join(';'))].join('\r\n');
}
