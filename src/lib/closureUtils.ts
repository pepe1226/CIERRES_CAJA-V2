import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';
import type { Movement, ShiftClosure } from '../types';

export type ClosureColumnKey =
  | 'date'
  | 'responsible'
  | 'physicalAmount'
  | 'systemAmount'
  | 'systemBalance'
  | 'difference'
  | 'status'
  | 'notes';

export const emptyClosureColumnFilters: Record<ClosureColumnKey, string> = {
  date: '',
  responsible: '',
  physicalAmount: '',
  systemAmount: '',
  systemBalance: '',
  difference: '',
  status: '',
  notes: ''
};

export const normalizeSearchText = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

export const getClosureStatusLabel = (status?: ShiftClosure['status']) => {
  if (status === 'transit') return 'En Tr\u00e1nsito';
  if (status === 'bank') return 'En Banco';
  return 'En Tienda';
};

export const calculateClosureDifference = (closure: Partial<ShiftClosure>) =>
  (Number(closure.physicalAmount) || 0) - (Number(closure.systemBalance) || 0);

export const toNonNegativeNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const getMovementDefaults = (
  type: Movement['type'],
  caja?: string,
  current: Partial<Movement> = {}
): Partial<Movement> => {
  const base = {
    amount: toNonNegativeNumber(current.amount),
    description: current.description || '',
    date: current.date || new Date().toISOString()
  };

  if (type === 'outflow') {
    return {
      ...base,
      type,
      category: current.category || 'Sueldos',
      subcategory: current.subcategory || '',
      from: caja || current.from || 'safe',
      to: undefined
    };
  }

  if (type === 'transfer') {
    const from = caja || (current.from && current.from !== 'bank' ? current.from : 'transit');
    return {
      ...base,
      type,
      category: undefined,
      subcategory: '',
      from,
      to: 'bank'
    };
  }

  const from = caja || current.from || 'safe';
  const to = current.to && current.to !== from
    ? current.to
    : from === 'safe'
      ? 'transit'
      : 'safe';

  return {
    ...base,
    type,
    category: undefined,
    subcategory: '',
    from,
    to
  };
};

export const getClosureSearchValues = (closure: ShiftClosure) => {
  const parsedDate = parseISO(closure.date);
  const dateValues = Number.isNaN(parsedDate.getTime())
    ? [closure.date]
    : [
        closure.date,
        format(parsedDate, 'dd/MM/yyyy HH:mm'),
        format(parsedDate, 'dd MMM yyyy HH:mm', { locale: es }),
        format(parsedDate, 'yyyy-MM-dd'),
        format(parsedDate, 'HH:mm')
      ];

  return [
    ...dateValues,
    closure.responsible,
    closure.physicalAmount,
    closure.systemAmount,
    closure.systemBalance,
    closure.difference,
    closure.status,
    getClosureStatusLabel(closure.status),
    closure.notes,
    closure.tripId,
    closure.id
  ];
};

export const getClosureColumnSearchValue = (
  closure: ShiftClosure,
  column: ClosureColumnKey
) => {
  const parsedDate = parseISO(closure.date);
  const dateValue = Number.isNaN(parsedDate.getTime())
    ? closure.date
    : `${closure.date} ${format(parsedDate, 'dd/MM/yyyy HH:mm')} ${format(parsedDate, 'dd MMM yyyy HH:mm', { locale: es })} ${format(parsedDate, 'yyyy-MM-dd')} ${format(parsedDate, 'HH:mm')}`;

  const values: Record<ClosureColumnKey, unknown> = {
    date: dateValue,
    responsible: closure.responsible,
    physicalAmount: closure.physicalAmount,
    systemAmount: closure.systemAmount,
    systemBalance: closure.systemBalance,
    difference: closure.difference,
    status: `${closure.status || ''} ${getClosureStatusLabel(closure.status)}`,
    notes: closure.notes || ''
  };

  return values[column];
};
