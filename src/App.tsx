/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ShiftClosure, Movement, UserProfile, CollectionTrip } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { auth, db, signInWithGoogle, logOut, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  query,
  orderBy,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import {
  format,
  startOfMonth,
  endOfMonth,
  isWithinInterval,
  parseISO,
  startOfDay,
  endOfDay,
  subDays,
  subMonths,
  startOfYear,
  endOfYear,
  startOfWeek
} from 'date-fns';
import { es } from 'date-fns/locale';
import html2pdf from 'html2pdf.js';
import {
  Plus,
  LogOut,
  History,
  TrendingDown,
  TrendingUp,
  ChevronDown,
  AlertCircle,
  CheckCircle2,
  User as UserIcon,
  DollarSign,
  Banknote,
  Calendar,
  Edit2,
  FileText,
  Wallet,
  Calculator,
  Moon,
  Sun,
  ArrowRight,
  Search,
  MessageSquare,
  Trash2,
  X,
  RefreshCw,
  Copy,
  CopyPlus,
  Check,
  Truck,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownLeft,
  Building2,
  CreditCard,
  ArrowRightLeft,
  Tag,
  Printer,
  Download,
  LayoutDashboard,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Eye,
  Share2,
  Users,
  PanelLeftClose,
  PanelLeftOpen,
  Home,
  Boxes
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Dashboard } from './components/Dashboard';
import { PersonalFinance } from './components/PersonalFinance';
import { PayrollModule } from './components/PayrollModule';
import { InventoryModule } from './components/InventoryModule';
import { BusinessCreditsModule } from './components/BusinessCreditsModule';


type ClosureColumnKey = 'date' | 'responsible' | 'physicalAmount' | 'systemAmount' | 'systemBalance' | 'difference' | 'status' | 'notes';
type ClosureTableColumnKey = ClosureColumnKey | 'transferAmount' | 'reportedAmount' | 'actions';

type CashBoxStatus = 'safe' | 'transit' | 'bank' | 'personal' | 'banquitos';
type ClosureCashBoxStatus = Exclude<CashBoxStatus, 'personal'>;
type DisplayClosureStatus = ClosureCashBoxStatus | 'mixed';
type ClosureAuditStatus = 'all' | 'matched' | 'difference' | 'pending_report' | 'not_audited';
type ClosureLedgerEntry = {
  displayStatus: ClosureCashBoxStatus;
  hasSplitBalance: boolean;
  balances: Record<CashBoxStatus, number>;
};
type AdminModule = {
  id: 'main' | 'dashboard' | 'inventory' | 'personal' | 'payroll' | 'trips' | 'credits';
  title: string;
  subtitle: string;
  group: 'General' | 'Finanzas' | 'Operacion' | 'Administracion' | 'Personal';
  Icon: typeof Home;
  accent: string;
  iconColor: string;
  action: () => void;
};
type PerseoReportRow = {
  businessDate: string;
  responsible?: string | null;
  responsibleKey?: string | null;
  cashBox?: string | null;
  cashBoxKey?: string | null;
  systemAmount?: number;
  systemBalance?: number;
  reportedAmount?: number;
  transferAmount?: number;
  raw?: Record<string, unknown>;
};
type PerseoReport = {
  id: string;
  createdAt?: string | null;
  businessDates: string[];
  dailySystemAmountByDate?: Record<string, number> | null;
  rows: PerseoReportRow[];
};
type MissingPerseoClosure = PerseoReportRow & {
  key: string;
  reportId: string;
  responsibleLabel: string;
};

const cashBoxStatuses: CashBoxStatus[] = ['safe', 'transit', 'bank', 'banquitos', 'personal'];
const closureCashBoxStatuses: ClosureCashBoxStatus[] = ['safe', 'transit', 'bank', 'banquitos'];
const cashBoxStatusPriority: ClosureCashBoxStatus[] = ['safe', 'transit', 'bank', 'banquitos'];

const normalizeCashBoxStatus = (status?: string | null): CashBoxStatus => {
  const normalized = String(status || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (['bank', 'banco', 'en banco'].includes(normalized)) return 'bank';
  if (['transit', 'transito', 'en transito', 'camino', 'viaje'].includes(normalized)) return 'transit';
  if (['banquitos', 'banquitos tmch', 'en banquitos'].includes(normalized)) return 'banquitos';
  if (['personal', 'caja personal', 'mi caja', 'caja mia', 'gasto personal', 'gastos personales', 'finanzas personales'].includes(normalized)) return 'personal';
  return 'safe';
};

const normalizeClosureCashBoxStatus = (status?: string | null): ClosureCashBoxStatus => {
  const normalized = normalizeCashBoxStatus(status);
  return normalized === 'personal' ? 'safe' : normalized;
};

const cashBoxValueMatches = (value: string | undefined | null, status: CashBoxStatus) =>
  Boolean(value) && normalizeCashBoxStatus(value) === status;

const closureStatusMatches = (value: string | undefined | null, status: ClosureCashBoxStatus) =>
  normalizeClosureCashBoxStatus(value) === status;

const getPrimaryCashBoxStatus = (balance: Record<CashBoxStatus, number>): ClosureCashBoxStatus => {
  return cashBoxStatusPriority.reduce<ClosureCashBoxStatus>((primary, status) => {
    const primaryAmount = balance[primary] || 0;
    const statusAmount = balance[status] || 0;

    if (statusAmount > primaryAmount + 0.009) return status;
    if (Math.abs(statusAmount - primaryAmount) <= 0.009 && statusAmount > 0.009) return status;

    return primary;
  }, 'safe');
};

const emptyClosureColumnFilters: Record<ClosureColumnKey, string> = {
  date: '',
  responsible: '',
  physicalAmount: '',
  systemAmount: '',
  systemBalance: '',
  difference: '',
  status: '',
  notes: ''
};

const defaultClosureTableColumnOrder: ClosureTableColumnKey[] = [
  'date',
  'responsible',
  'physicalAmount',
  'systemBalance',
  'transferAmount',
  'systemAmount',
  'reportedAmount',
  'difference',
  'status',
  'actions'
];

const fixedClosureTableTrailingColumns: ClosureTableColumnKey[] = ['status', 'actions'];
const closureMatchTolerance = 0.1001;

const normalizeClosureTableColumnOrder = (value: unknown): ClosureTableColumnKey[] => {
  if (!Array.isArray(value)) return defaultClosureTableColumnOrder;
  const allowed = new Set<ClosureTableColumnKey>(defaultClosureTableColumnOrder);
  const fixed = new Set<ClosureTableColumnKey>(fixedClosureTableTrailingColumns);
  const ordered = value.filter((column): column is ClosureTableColumnKey =>
    allowed.has(column as ClosureTableColumnKey) && !fixed.has(column as ClosureTableColumnKey)
  );
  const missing = defaultClosureTableColumnOrder.filter(column => !ordered.includes(column) && !fixed.has(column));
  return [...ordered, ...missing, ...fixedClosureTableTrailingColumns];
};

const normalizeSearchText = (value: unknown) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

const compactCashierText = (value: unknown) =>
  normalizeSearchText(value).replace(/[^a-z0-9]+/g, '');

const normalizeCashierName = (value: unknown) => {
  const compact = compactCashierText(value);
  if (!compact) return '';

  const definitions: Array<[string, string[]]> = [
    ['JOHANNA', ['johanna', 'johana', 'joha', 'yoha', 'soha']],
    ['YULEXI', ['yulexi', 'yulex', 'yule', 'yuli', 'juli', 'yul', 'pdv3esquina']],
    ['DAYELI', ['dayeli', 'daye', 'dayi', 'dayveli', 'deyli', 'deili', 'daili']],
    ['ERICK', ['erick', 'eric', 'erik']],
  ];

  for (const [canonical, aliases] of definitions) {
    if (aliases.some(alias => {
      const aliasCompact = compactCashierText(alias);
      return compact === aliasCompact || compact.includes(aliasCompact) || aliasCompact.includes(compact);
    })) {
      return canonical;
    }
  }

  return String(value || '').trim().toUpperCase();
};

const normalizePerseoCashBoxKey = (value: unknown) =>
  normalizeSearchText(value)
    .replace(/\bcaja\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');

const moneyText = (value: unknown) =>
  `$${(Number(value) || 0).toLocaleString('es-CL')}`;

const transferPdvAmount = (value: unknown) =>
  Math.abs(Number(value) || 0);

const normalizeReportHeader = (value: unknown) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const parseReportMoney = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!text) return 0;

  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  const decimalSeparator = comma > dot ? ',' : '.';
  const normalized = decimalSeparator === ','
    ? text.replace(/\./g, '').replace(',', '.')
    : text.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getExplicitPerseoTransferAmount = (row: PerseoReportRow) => {
  const stored = transferPdvAmount(row.transferAmount);
  if (stored > 0.009) return stored;

  const raw = row.raw && typeof row.raw === 'object' ? row.raw : null;
  if (!raw) return 0;

  const directKeys = [
    'transferido_compra_pdv',
    'transf_compra_pdv',
    'transf_pdv',
    'transfer_pdv',
    'transferencia_compra_pdv',
    'transferencias_compra_pdv',
    'transferencias_pdv',
    'enviado_compra_pdv',
    'compra_pdv',
  ];

  for (const key of directKeys) {
    const value = raw[key];
    const amount = transferPdvAmount(parseReportMoney(value));
    if (amount > 0.009) return amount;
  }

  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeReportHeader(key);
    const hasTransferTerm =
      normalizedKey.includes('transf') ||
      normalizedKey.includes('transfer') ||
      normalizedKey.includes('transferido') ||
      normalizedKey.includes('transferencia');
    const hasPdvContext = normalizedKey.includes('pdv') || normalizedKey.includes('compra');
    const isWrongField =
      normalizedKey.includes('venta') ||
      normalizedKey.includes('saldo') ||
      normalizedKey.includes('reportado') ||
      normalizedKey.includes('fisico') ||
      normalizedKey.includes('diferencia');

    if (!hasTransferTerm || !hasPdvContext || isWrongField) continue;

    const amount = transferPdvAmount(parseReportMoney(value));
    if (amount > 0.009) return amount;
  }

  return 0;
};

const createPerseoRowKey = (businessDate: string, row: PerseoReportRow, index: number) => {
  const responsibleKey = normalizeCashierName(row.responsibleKey || row.responsible || row.cashBoxKey || row.cashBox);
  const cashBoxKey = normalizePerseoCashBoxKey(row.cashBox || row.cashBoxKey || 'sin-caja');
  const balance = Number(row.systemBalance || 0).toFixed(2);
  return `${businessDate}|${responsibleKey}|${cashBoxKey}|${balance}|${index}`;
};

const getCashBoxLabel = (status?: string | null) => {
  const normalized = normalizeCashBoxStatus(status);
  if (normalized === 'transit') return 'En Transito';
  if (normalized === 'bank') return 'En Banco';
  if (normalized === 'banquitos') return 'En Banquitos';
  if (normalized === 'personal') return 'Caja Personal';
  return 'En Tienda';
};

const getClosureStatusLabel = (status?: ShiftClosure['status']) => getCashBoxLabel(status);

const getClosureAuditInfo = (closure: ShiftClosure) => {
  const isTelegramPhoto = closure.source === 'telegram' || Boolean(closure.telegramFileId);
  const hasPerseoReport = closure.systemSource === 'perseo' || Boolean(closure.perseoReportId);
  const difference = Number(closure.difference) || 0;

  if (hasPerseoReport) {
    const isDifference =
      closure.perseoAuditStatus === 'difference' ||
      Math.abs(difference) > closureMatchTolerance;

    return {
      status: isDifference ? 'difference' : 'matched',
      label: isDifference ? 'Diferencia' : 'Auditado OK',
      detail: isTelegramPhoto ? 'Foto Telegram cruzada con Perseo' : 'Cierre cruzado con Perseo',
      className: isDifference
        ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
        : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
    } as const;
  }

  if (isTelegramPhoto) {
    return {
      status: 'pending_report',
      label: 'Falta Venta Sistema',
      detail: 'Foto Telegram recibida; falta llenar Venta Sistema',
      className: 'bg-amber-500/10 text-amber-400 border-amber-500/20'
    } as const;
  }

  return {
    status: 'not_audited',
    label: 'Sin auditoria',
    detail: 'Cierre manual o sin venta de sistema asociada',
    className: 'bg-slate-500/10 text-slate-500 border-slate-500/20'
  } as const;
};

const calculateClosureDifference = (closure: Partial<ShiftClosure>) =>
  (Number(closure.physicalAmount) || 0) - (Number(closure.systemBalance) || 0);

const toNonNegativeNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

type ExpenseClassificationRule = {
  category: string;
  subcategory: string;
  tags: string[];
  terms: string[];
};
const EXPENSE_CLASSIFICATION_RULES: ExpenseClassificationRule[] = [
  { category: 'Gastos personales', subcategory: 'GENERAL PERSONAL', tags: ['PERSONAL'], terms: ['gasto personal', 'gastos personales', 'retiro personal', 'para mi', 'mio', 'personal mio', 'personal jose', 'uso personal'] },
  { category: 'Sueldos', subcategory: 'NOMINA', tags: ['PERSONAL', 'SUELDOS'], terms: ['sueldo', 'salario', 'nomina', 'pago empleado', 'anticipo', 'decimo', 'beneficio'] },
  { category: 'Arriendo', subcategory: 'LOCAL', tags: ['LOCAL', 'FIJO'], terms: ['arriendo', 'alquiler', 'renta', 'local'] },
  { category: 'Luz', subcategory: 'SERVICIOS BASICOS', tags: ['SERVICIOS', 'FIJO'], terms: ['luz', 'energia', 'electrica', 'empresa electrica'] },
  { category: 'Agua', subcategory: 'SERVICIOS BASICOS', tags: ['SERVICIOS', 'FIJO'], terms: ['agua', 'interagua'] },
  { category: 'Internet', subcategory: 'CONECTIVIDAD', tags: ['SERVICIOS', 'FIJO'], terms: ['internet', 'wifi', 'cnt', 'claro', 'netlife', 'fibra'] },
  { category: 'Transporte', subcategory: 'MOVILIZACION', tags: ['OPERACION', 'TRANSPORTE'], terms: ['taxi', 'uber', 'flete', 'envio', 'gasolina', 'combustible', 'parqueo', 'peaje', 'bus'] },
  { category: 'Insumos', subcategory: 'COMPRAS', tags: ['OPERACION', 'INSUMOS'], terms: ['insumo', 'compra', 'proveedor', 'material', 'fundas', 'papeleria', 'limpieza', 'cinta'] },
  { category: 'Mantenimiento', subcategory: 'REPARACION', tags: ['OPERACION', 'MANTENIMIENTO'], terms: ['mantenimiento', 'reparacion', 'arreglo', 'tecnico', 'equipo'] },
  { category: 'Banco', subcategory: 'COMISIONES', tags: ['BANCO', 'COMISION'], terms: ['comision', 'banco', 'transferencia bancaria', 'deposito', 'retiro'] },
  { category: 'Impuestos', subcategory: 'SRI', tags: ['IMPUESTOS'], terms: ['sri', 'iva', 'impuesto', 'patente', 'municipio'] },
];
const normalizeExpenseText = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const normalizeExpenseTag = (value: string) =>
  normalizeExpenseText(value)
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
const mergeExpenseTags = (tags: Array<string | undefined | null>) =>
  Array.from(new Set(tags.map(tag => tag ? normalizeExpenseTag(tag) : '').filter(Boolean))).slice(0, 8);
const classifyExpenseDescription = (description: string) => {
  const normalized = normalizeExpenseText(description);
  if (!normalized) return null;
  const matchedRule = EXPENSE_CLASSIFICATION_RULES
    .map(rule => ({
      rule,
      score: rule.terms.reduce((acc, term) => normalized.includes(normalizeExpenseText(term)) ? acc + 1 : acc, 0)
    }))
    .sort((a, b) => b.score - a.score)[0];
  if (!matchedRule || matchedRule.score === 0) {
    return {
      category: 'Otros',
      subcategory: 'GENERAL',
      tags: mergeExpenseTags(['SIN CLASIFICAR'])
    };
  }
  return {
    category: matchedRule.rule.category,
    subcategory: matchedRule.rule.subcategory,
    tags: mergeExpenseTags(matchedRule.rule.tags)
  };
};
const getMovementDefaults = (
  type: Movement['type'],
  caja?: string,
  current: Partial<Movement> = {}
): Partial<Movement> => {
  const base = {
    amount: toNonNegativeNumber(current.amount),
    description: current.description || '',
    date: current.date || new Date().toISOString(),
    tags: Array.isArray(current.tags) ? mergeExpenseTags(current.tags) : []
  };

  if (type === 'outflow') {
    const outflowFrom = caja || current.from || ((current.category || '').toLowerCase() === 'gastos personales' ? 'personal' : 'safe');
    const isPersonalOutflow = normalizeCashBoxStatus(outflowFrom) === 'personal';

    return {
      ...base,
      type,
      category: current.category || (isPersonalOutflow ? 'Gastos personales' : 'Sueldos'),
      subcategory: current.subcategory || (isPersonalOutflow ? 'GENERAL PERSONAL' : ''),
      from: outflowFrom,
      to: undefined,
      tags: Array.isArray(current.tags) ? mergeExpenseTags(current.tags) : isPersonalOutflow ? ['PERSONAL'] : []
    };
  }

  if (type === 'transfer') {
    const currentFrom = current.from ? normalizeCashBoxStatus(current.from) : null;
    const selectedBox = caja ? normalizeCashBoxStatus(caja) : null;
    const from = selectedBox && selectedBox !== 'bank'
      ? selectedBox
      : currentFrom && currentFrom !== 'bank'
        ? currentFrom
        : 'safe';
    return {
      ...base,
      type,
      category: undefined,
      subcategory: '',
      tags: [],
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
    tags: [],
    from,
    to
  };
};

const getClosureSearchValues = (closure: ShiftClosure, displayStatus?: ClosureCashBoxStatus) => {
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
    displayStatus || closure.status,
    getClosureStatusLabel(displayStatus || closure.status),
    closure.notes,
    closure.tripId,
    closure.id
  ];
};

const getClosureColumnSearchValue = (
  closure: ShiftClosure,
  column: ClosureColumnKey,
  displayStatus?: ClosureCashBoxStatus
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
    status: `${displayStatus || closure.status || ''} ${getClosureStatusLabel(displayStatus || closure.status)}`,
    notes: closure.notes || ''
  };

  return values[column];
};

function AppContent() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [closures, setClosures] = useState<ShiftClosure[]>([]);
  const [perseoReports, setPerseoReports] = useState<PerseoReport[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [visibleColumnFilter, setVisibleColumnFilter] = useState<ClosureColumnKey | null>(null);
  const [columnFilters, setColumnFilters] = useState<Record<ClosureColumnKey, string>>(emptyClosureColumnFilters);
  const [closureTableColumnOrder, setClosureTableColumnOrder] = useState<ClosureTableColumnKey[]>(() => {
    if (typeof window === 'undefined') return defaultClosureTableColumnOrder;
    try {
      const stored = window.localStorage.getItem('closureTableColumnOrder');
      return normalizeClosureTableColumnOrder(stored ? JSON.parse(stored) : null);
    } catch {
      return defaultClosureTableColumnOrder;
    }
  });
  const [draggedClosureColumn, setDraggedClosureColumn] = useState<ClosureTableColumnKey | null>(null);
  const [currentView, setCurrentView] = useState<'main' | 'dashboard' | 'personal' | 'payroll' | 'inventory' | 'credits'>('main');
  const [isModuleSidebarOpen, setIsModuleSidebarOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const [trips, setTrips] = useState<CollectionTrip[]>([]);
  const [selectedClosures, setSelectedClosures] = useState<Set<string>>(new Set());
  const [isCreatingTrip, setIsCreatingTrip] = useState(false);
  const [isTripLoading, setIsTripLoading] = useState(false);
  const [tripFormValues, setTripFormValues] = useState({
    description: '',
    notes: '',
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
  });
  const [viewingTripId, setViewingTripId] = useState<string | null>(null);

  const [isAddingMovement, setIsAddingMovement] = useState(false);
  const [editingMovementId, setEditingMovementId] = useState<string | null>(null);
  const [viewingCajaMovements, setViewingCajaMovements] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, caja: string } | null>(null);

  const [categories, setCategories] = useState<string[]>(['Gastos personales', 'Sueldos', 'Arriendo', 'Luz', 'Agua', 'Internet', 'Insumos', 'Otros']);
  const [subcategories, setSubcategories] = useState<string[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [isAddingNewCategory, setIsAddingNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isAddingNewSubcategory, setIsAddingNewSubcategory] = useState(false);
  const [newSubcategoryName, setNewSubcategoryName] = useState('');
  const [newExpenseTag, setNewExpenseTag] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isEditingCategories, setIsEditingCategories] = useState(false);

  const [filterStartDate, setFilterStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [filterEndDate, setFilterEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterResponsible, setFilterResponsible] = useState('all');
  const [filterAudit, setFilterAudit] = useState<ClosureAuditStatus>('all');
  const [filterDateRangeType, setFilterDateRangeType] = useState('mes');
  const [outflowPeriodType, setOutflowPeriodType] = useState<'este_mes' | 'mes_pasado' | 'anio_actual' | 'siempre' | 'custom'>('este_mes');
  const [outflowStartDate, setOutflowStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [outflowEndDate, setOutflowEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
  const [hideCollected, setHideCollected] = useState(false);
  const [showOnlyStoreClosures, setShowOnlyStoreClosures] = useState(false);

  const [movementValues, setMovementValues] = useState<Partial<Movement>>({
    type: 'outflow',
    amount: 0,
    description: '',
    date: new Date().toISOString(),
    category: 'Sueldos',
    subcategory: '',
    tags: []
  });

  const applySmartExpenseDescription = (description: string) => {
    const suggestion = classifyExpenseDescription(description);
    setMovementValues(prev => ({
      ...prev,
      description,
      ...(prev.type === 'outflow' && suggestion ? {
        category: suggestion.category,
        subcategory: suggestion.subcategory,
        tags: mergeExpenseTags([...(prev.tags || []), ...suggestion.tags])
      } : {})
    }));
  };
  const addExpenseTag = () => {
    const tag = normalizeExpenseTag(newExpenseTag);
    if (!tag) return;
    setMovementValues(prev => ({
      ...prev,
      tags: mergeExpenseTags([...(prev.tags || []), tag])
    }));
    setNewExpenseTag('');
  };
  const removeExpenseTag = (tagToRemove: string) => {
    const normalized = normalizeExpenseTag(tagToRemove);
    setMovementValues(prev => ({
      ...prev,
      tags: (prev.tags || []).filter(tag => normalizeExpenseTag(tag) !== normalized)
    }));
  };

  const [isInlineAdding, setIsInlineAdding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // Refs for navigation focus
  const dateInputRef = useRef<HTMLInputElement>(null);
  const responsibleInputRef = useRef<HTMLInputElement>(null);
  const physicalAmountRef = useRef<HTMLInputElement>(null);
  const systemAmountRef = useRef<HTMLInputElement>(null);
  const systemBalanceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isInlineAdding) {
      setTimeout(() => dateInputRef.current?.focus(), 100);
    }
  }, [isInlineAdding]);

  useEffect(() => {
    try {
      window.localStorage.setItem('closureTableColumnOrder', JSON.stringify(closureTableColumnOrder));
    } catch {
      // localStorage can be unavailable in restricted browser modes.
    }
  }, [closureTableColumnOrder]);
  const [inlineAddValues, setInlineAddValues] = useState<Partial<ShiftClosure>>({
    date: new Date().toISOString(),
    responsible: '',
    physicalAmount: 0,
    systemAmount: 0,
    systemBalance: 0,
    status: 'safe'
  });

  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [inlineEditValues, setInlineEditValues] = useState<Partial<ShiftClosure>>({});

  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const [bulkEditValues, setBulkEditValues] = useState<Record<string, Partial<ShiftClosure>>>({});

  const [isEditingTripNotes, setIsEditingTripNotes] = useState(false);
  const [editedTripNotes, setEditedTripNotes] = useState('');

  const handleSaveTripNotes = async (tripId: string) => {
    try {
      await updateDoc(doc(db, 'trips', tripId), {
        notes: editedTripNotes
      });
      setIsEditingTripNotes(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `trips/${tripId}`);
    }
  };
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});
  const [historyView, setHistoryView] = useState<{ type: string; title: string } | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const adminModules: AdminModule[] = [
    {
      id: 'main',
      title: 'Inicio',
      subtitle: 'Centro de modulos',
      Icon: Home,
      group: 'General',
      accent: 'from-slate-500/20 to-slate-400/10',
      iconColor: 'text-slate-200',
      action: () => setCurrentView('main'),
    },
    {
      id: 'dashboard',
      title: 'Analitica',
      subtitle: 'Indicadores y resumen',
      Icon: LayoutDashboard,
      group: 'Finanzas',
      accent: 'from-violet-500/20 to-fuchsia-500/10',
      iconColor: 'text-violet-300',
      action: () => setCurrentView('dashboard'),
    },
    {
      id: 'credits',
      title: 'Creditos',
      subtitle: 'Prestamos, cuotas y saldo',
      Icon: CreditCard,
      group: 'Finanzas',
      accent: 'from-amber-500/20 to-yellow-500/10',
      iconColor: 'text-amber-300',
      action: () => setCurrentView('credits'),
    },
    {
      id: 'inventory',
      title: 'Inventario',
      subtitle: 'Stock y cobertura desde Perseo',
      Icon: Boxes,
      group: 'Operacion',
      accent: 'from-cyan-500/20 to-sky-500/10',
      iconColor: 'text-cyan-300',
      action: () => setCurrentView('inventory'),
    },
    {
      id: 'personal',
      title: 'Finanzas Personales',
      subtitle: 'Cajas y movimientos propios',
      Icon: Wallet,
      group: 'Personal',
      accent: 'from-sky-500/20 to-blue-500/10',
      iconColor: 'text-sky-300',
      action: () => setCurrentView('personal'),
    },
    {
      id: 'payroll',
      title: 'Sueldos',
      subtitle: 'Sueldos, anticipos y pagos',
      Icon: Users,
      group: 'Administracion',
      accent: 'from-emerald-500/20 to-cyan-500/10',
      iconColor: 'text-emerald-300',
      action: () => setCurrentView('payroll'),
    },
    {
      id: 'trips',
      title: 'Recolecciones',
      subtitle: 'Viajes y traslados',
      Icon: Truck,
      group: 'Operacion',
      accent: 'from-amber-500/20 to-orange-500/10',
      iconColor: 'text-amber-300',
      action: () => setViewingTripId('LIST'),
    },
  ];

  const activeModuleId = currentView === 'main' ? 'main' : currentView;
  useEffect(() => {
  const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
    try {
      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const userDoc = await getDoc(userRef);

        if (userDoc.exists()) {
          setUser(userDoc.data() as UserProfile);
        } else {
          const newUser: UserProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || '',
            displayName: firebaseUser.displayName || '',
            role: 'user'
          };

          await setDoc(userRef, newUser);
          setUser(newUser);
        }
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error('Error cargando usuario desde Firestore:', error);
      alert('Login correcto, pero Firestore no permite cargar o crear el usuario. Revisa Firestore Database y Rules.');
      setUser(null);
    } finally {
      setLoading(false);
    }
  });

  return () => unsubscribe();
}, []);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  useEffect(() => {
    if (!user) return;

    const qClosures = query(collection(db, 'closures'), orderBy('date', 'desc'));
    const unsubscribeClosures = onSnapshot(qClosures, (snapshot) => {
      const data = snapshot.docs.map(snapshotDoc => {
        const raw = snapshotDoc.data();
        return {
          ...raw,
          id: snapshotDoc.id,
          date: (raw.date as Timestamp).toDate().toISOString(),
          cashBoxBalancesUpdatedAt: raw.cashBoxBalancesUpdatedAt?.toDate
            ? raw.cashBoxBalancesUpdatedAt.toDate().toISOString()
            : undefined
        };
      }) as ShiftClosure[];
      setClosures(data);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'closures'));

    const qPerseoReports = query(collection(db, 'perseo_reports'), orderBy('createdAt', 'desc'));
    const unsubscribePerseoReports = onSnapshot(qPerseoReports, (snapshot) => {
      const data = snapshot.docs.map(reportDoc => {
        const raw = reportDoc.data();
        return {
          id: reportDoc.id,
          createdAt: raw.createdAt?.toDate ? raw.createdAt.toDate().toISOString() : null,
          businessDates: Array.isArray(raw.businessDates) ? raw.businessDates : [],
          dailySystemAmountByDate: raw.dailySystemAmountByDate || null,
          rows: Array.isArray(raw.rows) ? raw.rows : [],
        } as PerseoReport;
      });
      setPerseoReports(data);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'perseo_reports'));

    const qMovements = query(collection(db, 'movements'), orderBy('date', 'desc'));
    const unsubscribeMovements = onSnapshot(qMovements, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
        date: (doc.data().date as Timestamp).toDate().toISOString()
      })) as Movement[];
      setMovements(data);

      setCategories(prev => {
        const unique = new Set([...prev]);
        data.forEach(m => m.category && unique.add(m.category));
        return Array.from(unique).sort();
      });
      setSubcategories(prev => {
        const unique = new Set([...prev]);
        data.forEach(m => m.subcategory && unique.add(m.subcategory));
        return Array.from(unique).sort();
      });
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'movements'));

    const qTrips = query(collection(db, 'trips'), orderBy('startDate', 'desc'));
    const unsubscribeTrips = onSnapshot(qTrips, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
        startDate: (doc.data().startDate as Timestamp).toDate().toISOString(),
        completionDate: doc.data().completionDate ? (doc.data().completionDate as Timestamp).toDate().toISOString() : undefined
      })) as CollectionTrip[];
      setTrips(data);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'trips'));

    return () => {
      unsubscribeClosures();
      unsubscribePerseoReports();
      unsubscribeMovements();
      unsubscribeTrips();
    };
  }, [user]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const playSound = (type: string) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    if (type === 'transit') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.1);
    } else if (type === 'bank') {
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + 0.1);
    } else {
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(220, audioContext.currentTime);
    }

    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);

    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.2);
  };

  const getNextStatus = (currentStatus: string) => {
    if (currentStatus === 'safe') return 'transit';
    if (currentStatus === 'transit') return 'bank';
    if (currentStatus === 'bank') return 'banquitos';
    return 'safe';
  };

  const handleExportCSV = async () => {
    setIsExporting(true);
    try {
      const headers = ['Fecha', 'Responsable', 'Fisico', 'Saldo Esperado', 'Transf. PDV', 'Venta Sistema', 'Reportado', 'Diferencia', 'Estado', 'Auditoria', 'Notas'].join(';');
      const rows = closures.map(c => [
        format(parseISO(c.date), 'dd/MM/yyyy HH:mm'),
        c.responsible,
        c.physicalAmount,
        c.systemBalance,
        transferPdvAmount(c.transferAmount),
        c.systemAmount,
        Number(c.reportedAmount) || 0,
        c.difference,
        getClosureDisplayStatus(c),
        getClosureAuditInfo(c).label,
        c.notes || ''
      ].join(';'));

      const csvContent = "\ufeff" + [headers, ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `cierres_${format(new Date(), 'yyyy-MM-dd')}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Export error:', err);
    } finally {
      setIsExporting(false);
    }
  };

  const closureLedgerById = useMemo(() => {
    const balances: Record<string, Record<CashBoxStatus, number>> = {};
    const balanceBaselineByClosureId: Record<string, number> = {};

    closures.forEach(closure => {
      if (!closure.id) return;

      const initialStatus = normalizeClosureCashBoxStatus(closure.status);
      const persistedBalances = closure.cashBoxBalances;
      const hasPersistedBalances = persistedBalances && typeof persistedBalances === 'object';

      balances[closure.id] = hasPersistedBalances
        ? {
            safe: Math.max(0, Number(persistedBalances.safe) || 0),
            transit: Math.max(0, Number(persistedBalances.transit) || 0),
            bank: Math.max(0, Number(persistedBalances.bank) || 0),
            banquitos: Math.max(0, Number(persistedBalances.banquitos) || 0),
            personal: 0
          }
        : {
            safe: initialStatus === 'safe' ? Number(closure.physicalAmount) || 0 : 0,
            transit: initialStatus === 'transit' ? Number(closure.physicalAmount) || 0 : 0,
            bank: initialStatus === 'bank' ? Number(closure.physicalAmount) || 0 : 0,
            banquitos: initialStatus === 'banquitos' ? Number(closure.physicalAmount) || 0 : 0,
            personal: 0
          };

      const baselineTime = closure.cashBoxBalancesUpdatedAt
        ? new Date(closure.cashBoxBalancesUpdatedAt).getTime()
        : Number.NaN;
      balanceBaselineByClosureId[closure.id] = Number.isNaN(baselineTime) ? 0 : baselineTime;
    });

    const orderedTransfers = [...movements]
      .filter(movement =>
        (movement.type === 'transfer' || movement.type === 'internal_transfer') &&
        movement.source !== 'status_control' &&
        movement.from &&
        movement.to
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    orderedTransfers.forEach(movement => {
      const from = normalizeCashBoxStatus(movement.from);
      const to = normalizeCashBoxStatus(movement.to);

      if (from === 'personal' || to === 'personal' || from === to) return;

      let remainingAmount = Number(movement.amount) || 0;

      if (remainingAmount <= 0) return;

      const movementTime = new Date(movement.date).getTime();

      const candidateClosures = [...closures]
        .filter(closure => {
          if (!closure.id) return false;
          if (movement.closureId && movement.closureId !== closure.id) return false;

          const closureTime = new Date(closure.date).getTime();
          const baselineTime = balanceBaselineByClosureId[closure.id] || 0;

          if (Number.isNaN(movementTime) || Number.isNaN(closureTime)) return true;

          return closureTime <= movementTime && movementTime > baselineTime;
        })
        // Al mover dinero fisicamente, normalmente se toma primero lo mas reciente disponible.
        .sort((a, b) => b.date.localeCompare(a.date));

      for (const closure of candidateClosures) {
        if (!closure.id) continue;

        const closureBalance = balances[closure.id];

        if (!closureBalance) continue;

        const availableAmount = closureBalance[from];

        if (availableAmount <= 0) continue;

        const movedAmount = Math.min(availableAmount, remainingAmount);

        closureBalance[from] -= movedAmount;
        closureBalance[to] += movedAmount;
        remainingAmount -= movedAmount;

        if (remainingAmount <= 0.009) break;
      }
    });

    return Object.entries(balances).reduce((result, [closureId, balance]) => {
      const activeStatuses = closureCashBoxStatuses.filter(status => balance[status] > 0.009);

      result[closureId] = {
        displayStatus: activeStatuses.length === 0 ? 'safe' : getPrimaryCashBoxStatus(balance),
        hasSplitBalance: activeStatuses.length > 1,
        balances: balance
      };

      return result;
    }, {} as Record<string, ClosureLedgerEntry>);
  }, [closures, movements]);

  const derivedClosureStatusById = useMemo(() =>
    Object.entries(closureLedgerById).reduce((result, [closureId, ledger]) => {
      result[closureId] = ledger.displayStatus;
      return result;
    }, {} as Record<string, ClosureCashBoxStatus>),
  [closureLedgerById]);

  const getClosureDisplayStatus = useCallback((closure: ShiftClosure): ClosureCashBoxStatus =>
    closure.id
      ? derivedClosureStatusById[closure.id] || normalizeClosureCashBoxStatus(closure.status)
      : normalizeClosureCashBoxStatus(closure.status),
  [derivedClosureStatusById]);

  const isClosureAvailableForTrip = useCallback((closure: ShiftClosure) =>
    getClosureDisplayStatus(closure) === 'safe' &&
    !closure.tripId &&
    !(closure.id && closureLedgerById[closure.id]?.hasSplitBalance),
  [getClosureDisplayStatus, closureLedgerById]);

  const filteredClosures = useMemo(() => {
    const normalizedGlobalSearch = normalizeSearchText(debouncedSearchTerm);
    const activeColumnFilters = Object.entries(columnFilters)
      .map(([column, value]) => [column as ClosureColumnKey, normalizeSearchText(value)] as const)
      .filter(([, value]) => value.length > 0);

    return closures.filter(c => {
      const date = parseISO(c.date);
      const start = startOfDay(parseISO(filterStartDate));
      const end = endOfDay(parseISO(filterEndDate));

      const matchesDate = filterDateRangeType === 'siempre' || isWithinInterval(date, { start, end });
      const derivedStatus = c.id
        ? derivedClosureStatusById[c.id] || normalizeClosureCashBoxStatus(c.status)
        : normalizeClosureCashBoxStatus(c.status);

      const matchesStatus = filterStatus === 'all' || derivedStatus === filterStatus;
      const matchesResponsible = filterResponsible === 'all' || c.responsible === filterResponsible;
      const matchesSearch = !normalizedGlobalSearch || getClosureSearchValues(c, derivedStatus).some(value =>
        normalizeSearchText(value).includes(normalizedGlobalSearch)
      );
      const matchesColumnFilters = activeColumnFilters.every(([column, value]) =>
        normalizeSearchText(getClosureColumnSearchValue(c, column, derivedStatus)).includes(value)
      );
      const matchesHideCollected = !hideCollected || !c.tripId;
      const matchesOnlyStoreClosures = !showOnlyStoreClosures || isClosureAvailableForTrip(c);
      const auditInfo = getClosureAuditInfo(c);
      const matchesAudit = filterAudit === 'all' || auditInfo.status === filterAudit;

      return matchesDate && matchesStatus && matchesResponsible && matchesSearch && matchesColumnFilters && matchesHideCollected && matchesOnlyStoreClosures && matchesAudit;
    });
  }, [closures, filterStartDate, filterEndDate, filterStatus, filterResponsible, filterAudit, debouncedSearchTerm, columnFilters, hideCollected, showOnlyStoreClosures, filterDateRangeType, derivedClosureStatusById, isClosureAvailableForTrip]);

  const uniqueResponsibles = useMemo(() => {
    return Array.from(new Set(closures.map(c => c.responsible))).sort();
  }, [closures]);

  const selectedTripClosures = useMemo(() =>
    closures.filter(c => c.id && selectedClosures.has(c.id) && isClosureAvailableForTrip(c)),
  [closures, selectedClosures, isClosureAvailableForTrip]);

  const getDayStatusFromItems = (items: ShiftClosure[]): DisplayClosureStatus => {
    if (items.length === 0) return 'safe';

    const hasSplitClosure = items.some(item => item.id && closureLedgerById[item.id]?.hasSplitBalance);

    const normalizedStatuses = items.map(item => {
      if (item.id && derivedClosureStatusById[item.id]) {
        return derivedClosureStatusById[item.id];
      }

      return normalizeClosureCashBoxStatus(item.status);
    });

    const allSafe = normalizedStatuses.every(status => status === 'safe');
    const allTransit = normalizedStatuses.every(status => status === 'transit');
    const allBank = normalizedStatuses.every(status => status === 'bank');
    const allBanquitos = normalizedStatuses.every(status => status === 'banquitos');

    if (allBanquitos) return 'banquitos';
    if (allBank) return 'bank';
    if (allTransit) return 'transit';
    if (allSafe && !hasSplitClosure) return 'safe';

    return 'mixed';
  };

  const latestPerseoRowsByDate = useMemo(() => {
    const rowsByDate = new Map<string, { createdAt: string; reportId: string; rows: PerseoReportRow[]; dailySystemAmount?: number }>();

    perseoReports.forEach(report => {
      const createdAt = String(report.createdAt || '');
      const groupedRows = (report.rows || []).reduce<Record<string, PerseoReportRow[]>>((result, row) => {
        const businessDate = String(row.businessDate || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return result;
        if (!result[businessDate]) result[businessDate] = [];
        result[businessDate].push(row);
        return result;
      }, {});

      Object.entries(groupedRows).forEach(([businessDate, rows]) => {
        const existing = rowsByDate.get(businessDate);
        if (!existing || createdAt.localeCompare(existing.createdAt) > 0) {
          rowsByDate.set(businessDate, {
            createdAt,
            reportId: report.id,
            rows,
            dailySystemAmount: Number(report.dailySystemAmountByDate?.[businessDate]) || undefined,
          });
        }
      });
    });

    return rowsByDate;
  }, [perseoReports]);

  const perseoDailyTotalsByDate = useMemo(() => {
    return Array.from(latestPerseoRowsByDate.entries()).reduce<Record<string, { systemAmount: number; systemBalance: number; reportedAmount: number; transferAmount: number; reportId: string }>>((result, [day, report]) => {
      result[day] = report.rows.reduce((acc, row) => ({
        systemAmount: acc.systemAmount + (Number(row.systemAmount) || 0),
        systemBalance: acc.systemBalance + (Number(row.systemBalance) || 0),
        reportedAmount: acc.reportedAmount + (Number(row.reportedAmount) || 0),
        transferAmount: acc.transferAmount + getExplicitPerseoTransferAmount(row),
        reportId: report.reportId,
      }), { systemAmount: 0, systemBalance: 0, reportedAmount: 0, transferAmount: 0, reportId: report.reportId });
      return result;
    }, {});
  }, [latestPerseoRowsByDate]);

  const perseoClosureMatchById = useMemo(() => {
    const matches: Record<string, { key: string; reportId: string; row: PerseoReportRow }> = {};
    const usedRows = new Set<string>();

    const closuresByDate = closures.reduce<Record<string, ShiftClosure[]>>((result, closure) => {
      if (!closure.id) return result;
      const day = format(parseISO(closure.date), 'yyyy-MM-dd');
      if (!result[day]) result[day] = [];
      result[day].push(closure);
      return result;
    }, {});

    Object.entries(closuresByDate).forEach(([day, dayClosures]) => {
      const report = latestPerseoRowsByDate.get(day);
      if (!report) return;

      const candidateRows = report.rows.map((row, index) => ({
        row,
        index,
        key: createPerseoRowKey(day, row, index),
        cashier: normalizeCashierName(row.responsibleKey || row.responsible || row.cashBoxKey || row.cashBox),
        cashBox: normalizePerseoCashBoxKey(row.cashBox || row.cashBoxKey || 'sin-caja'),
        balance: Number(row.systemBalance) || 0,
      }));

      [...dayClosures]
        .sort((a, b) => Math.abs(Number(b.physicalAmount) || 0) - Math.abs(Number(a.physicalAmount) || 0))
        .forEach(closure => {
          if (!closure.id) return;

          const perseoRaw = closure.perseoRaw as Record<string, unknown> | undefined;
          const cashier = normalizeCashierName(perseoRaw?.responsable || perseoRaw?.cajero || closure.responsible);
          const cashBox = normalizePerseoCashBoxKey(perseoRaw?.caja);
          const physicalAmount = Number(closure.physicalAmount) || 0;
          const storedSystemBalance = Number(closure.systemBalance) || 0;

          let best = candidateRows
            .filter(candidate => !usedRows.has(candidate.key) && candidate.cashier === cashier)
            .map(candidate => {
              const physicalDistance = Math.abs(physicalAmount - candidate.balance);
              const storedDistance = Math.abs(storedSystemBalance - candidate.balance);
              const cashBoxBonus = cashBox && cashBox === candidate.cashBox ? -0.05 : 0;
              const score = physicalDistance <= closureMatchTolerance
                ? physicalDistance + cashBoxBonus
                : storedDistance <= 0.009 || cashBoxBonus < 0
                  ? 100 + storedDistance + cashBoxBonus
                  : 1000 + physicalDistance;

              return { ...candidate, physicalDistance, storedDistance, score };
            })
            .sort((a, b) => a.score - b.score)[0];

          let isConfidentMatch = Boolean(best) && (
            best.physicalDistance <= closureMatchTolerance ||
            best.storedDistance <= 0.009 ||
            Boolean(cashBox && cashBox === best.cashBox)
          );

          if (!isConfidentMatch) {
            const amountOnlyMatches = candidateRows
              .filter(candidate => !usedRows.has(candidate.key))
              .map(candidate => ({
                ...candidate,
                physicalDistance: Math.abs(physicalAmount - candidate.balance),
                storedDistance: Math.abs(storedSystemBalance - candidate.balance),
                score: Math.abs(physicalAmount - candidate.balance),
              }))
              .filter(candidate => candidate.physicalDistance <= closureMatchTolerance)
              .sort((a, b) => a.score - b.score);

            const first = amountOnlyMatches[0];
            const second = amountOnlyMatches[1];
            if (first && (!second || Math.abs(first.score - second.score) > 0.009)) {
              best = first;
              isConfidentMatch = true;
            }
          }

          if (!isConfidentMatch) return;

          usedRows.add(best.key);
          matches[closure.id] = {
            key: best.key,
            reportId: report.reportId,
            row: best.row,
          };
        });
    });

    return matches;
  }, [closures, latestPerseoRowsByDate]);

  const missingPerseoClosuresByDate = useMemo(() => {
    const coveredRowKeys = new Set<string>();
    Object.values(perseoClosureMatchById).forEach(match => coveredRowKeys.add(match.key));

    closures.forEach(closure => {
      const day = format(parseISO(closure.date), 'yyyy-MM-dd');
      const perseoRaw = closure.perseoRaw as Record<string, unknown> | undefined;
      const cashier = normalizeCashierName(perseoRaw?.responsable || perseoRaw?.cajero || closure.responsible);
      const cashBox = normalizePerseoCashBoxKey(perseoRaw?.caja);
      if (cashBox) {
        const report = latestPerseoRowsByDate.get(day);
        const rowIndex = report?.rows.findIndex(row =>
          normalizeCashierName(row.responsibleKey || row.responsible || row.cashBoxKey || row.cashBox) === cashier &&
          normalizePerseoCashBoxKey(row.cashBox || row.cashBoxKey || 'sin-caja') === cashBox
        );
        if (report && rowIndex !== undefined && rowIndex >= 0) {
          coveredRowKeys.add(createPerseoRowKey(day, report.rows[rowIndex], rowIndex));
        }
      }
      if (Number(closure.systemBalance) > 0) {
        const report = latestPerseoRowsByDate.get(day);
        const rowIndex = report?.rows.findIndex(row =>
          normalizeCashierName(row.responsibleKey || row.responsible || row.cashBoxKey || row.cashBox) === cashier &&
          Math.abs((Number(row.systemBalance) || 0) - (Number(closure.systemBalance) || 0)) <= 0.009
        );
        if (report && rowIndex !== undefined && rowIndex >= 0) {
          coveredRowKeys.add(createPerseoRowKey(day, report.rows[rowIndex], rowIndex));
        }
      }
    });

    const reportRows = Array.from(latestPerseoRowsByDate.entries()).flatMap(([businessDate, report]) => {
      return report.rows
        .map((row, index) => {
        const responsibleLabel = String(row.responsible || row.responsibleKey || row.cashBox || row.cashBoxKey || 'SIN RESPONSABLE').trim().toUpperCase();
        const responsibleKey = normalizeCashierName(row.responsibleKey || row.responsible || row.cashBoxKey || row.cashBox);
        const hasSystemValue = (Number(row.systemAmount) || 0) > 0 || Math.abs(Number(row.systemBalance) || 0) > 0.009;
          if (!responsibleKey || !hasSystemValue) return null;

          const cashBoxKey = normalizePerseoCashBoxKey(row.cashBox || row.cashBoxKey || 'sin-caja');
          const key = createPerseoRowKey(businessDate, row, index);
          if (coveredRowKeys.has(key)) return null;
          return {
            ...row,
            key,
            reportId: report.reportId,
            businessDate,
            responsibleLabel,
            responsibleKey,
            cashBoxKey,
          } as MissingPerseoClosure;
        })
        .filter(Boolean) as MissingPerseoClosure[];
    });

    const consolidatedReportRows = Object.values(reportRows.reduce<Record<string, MissingPerseoClosure>>((result, row) => {
      const existing = result[row.key];
      if (!existing) {
        result[row.key] = row;
        return result;
      }

      existing.systemAmount = (Number(existing.systemAmount) || 0) + (Number(row.systemAmount) || 0);
      existing.systemBalance = (Number(existing.systemBalance) || 0) + (Number(row.systemBalance) || 0);
      existing.reportedAmount = (Number(existing.reportedAmount) || 0) + (Number(row.reportedAmount) || 0);
      existing.transferAmount = transferPdvAmount(existing.transferAmount) + getExplicitPerseoTransferAmount(row);
      return result;
    }, {}));

    const rowsByCashier = consolidatedReportRows
      .filter(row => !coveredRowKeys.has(row.key))
      .reduce<Record<string, MissingPerseoClosure[]>>((result, row) => {
        const key = `${row.businessDate}|${normalizeCashierName(row.responsibleKey || row.responsibleLabel)}`;
        if (!result[key]) result[key] = [];
        result[key].push(row);
        return result;
      }, {});

    const missingRows = Object.entries(rowsByCashier).flatMap(([cashierKey, rows]) => {
      void cashierKey;
      return rows
        .sort((a, b) => Math.abs(Number(b.systemBalance) || 0) - Math.abs(Number(a.systemBalance) || 0))
    });

    return missingRows.reduce<Record<string, MissingPerseoClosure[]>>((result, row) => {
      const day = row.businessDate;
      if (!result[day]) result[day] = [];
      result[day].push(row);
      return result;
    }, {});
  }, [closures, latestPerseoRowsByDate, perseoClosureMatchById]);

  const groupedClosures = useMemo(() => {
    const groups: Record<string, ShiftClosure[]> = {};
    filteredClosures.forEach(c => {
      const day = format(parseISO(c.date), 'yyyy-MM-dd');
      if (!groups[day]) groups[day] = [];
      groups[day].push(c);
    });

    Object.keys(missingPerseoClosuresByDate).forEach(day => {
      const dayDate = parseISO(`${day}T12:00:00.000Z`);
      const start = startOfDay(parseISO(filterStartDate));
      const end = endOfDay(parseISO(filterEndDate));
      const matchesDate = filterDateRangeType === 'siempre' || isWithinInterval(dayDate, { start, end });
      if (!matchesDate) return;

      const rows = missingPerseoClosuresByDate[day] || [];
      const matchesResponsible = filterResponsible === 'all' || rows.some(row => normalizeCashierName(row.responsibleLabel) === normalizeCashierName(filterResponsible));
      const matchesSearch = !debouncedSearchTerm || rows.some(row =>
        [
          row.businessDate,
          row.responsibleLabel,
          row.cashBox,
          row.systemAmount,
          row.systemBalance,
          row.reportedAmount,
          row.transferAmount,
        ].some(value => normalizeSearchText(value).includes(normalizeSearchText(debouncedSearchTerm)))
      );
      const matchesAudit = filterAudit === 'all' || filterAudit === 'pending_report';
      const matchesStatus = filterStatus === 'all';

      if (matchesResponsible && matchesSearch && matchesAudit && matchesStatus && !groups[day]) {
        groups[day] = [];
      }
    });

    return Object.entries(groups)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, items]) => {
        const sortedItems = [...items].sort((a,b) => b.date.localeCompare(a.date));
        let missingRows = missingPerseoClosuresByDate[date] || [];
        const perseoDailyTotals = perseoDailyTotalsByDate[date] || null;

        const totals = sortedItems.reduce((acc, curr) => ({
          physicalAmount: acc.physicalAmount + curr.physicalAmount,
          systemAmount: perseoDailyTotals ? acc.systemAmount : acc.systemAmount + curr.systemAmount,
          transferAmount: perseoDailyTotals ? acc.transferAmount : acc.transferAmount + transferPdvAmount(curr.transferAmount),
          systemBalance: perseoDailyTotals ? acc.systemBalance : acc.systemBalance + curr.systemBalance,
          reportedAmount: perseoDailyTotals ? acc.reportedAmount : acc.reportedAmount + (Number(curr.reportedAmount) || 0),
          difference: 0
        }), {
          physicalAmount: 0,
          systemAmount: perseoDailyTotals?.systemAmount || 0,
          transferAmount: perseoDailyTotals?.transferAmount || 0,
          systemBalance: perseoDailyTotals?.systemBalance || 0,
          reportedAmount: perseoDailyTotals?.reportedAmount || 0,
          difference: 0
        });
        totals.difference = Number((totals.physicalAmount - totals.systemBalance).toFixed(2));

        if (
          missingRows.length > 0 &&
          sortedItems.length > 0 &&
          perseoDailyTotals &&
          Math.abs(totals.difference) <= closureMatchTolerance * Math.max(1, sortedItems.length)
        ) {
          missingRows = [];
        }

        const status = getDayStatusFromItems(sortedItems);

        return { date, items: sortedItems, missingRows, totals, status };
      });
  }, [filteredClosures, derivedClosureStatusById, closureLedgerById, missingPerseoClosuresByDate, perseoDailyTotalsByDate, filterStartDate, filterEndDate, filterDateRangeType, filterResponsible, debouncedSearchTerm, filterAudit, filterStatus]);


  const getAccumulatedBoxTotal = useCallback((status: CashBoxStatus) => {
    const closureMoney = status === 'personal'
      ? 0
      : Object.values(closureLedgerById).reduce((acc, ledger) => acc + (Number(ledger.balances[status]) || 0), 0);

    const movementAdjustments = movements.reduce((acc, movement) => {
      const movementType = movement.type;
      const from = movement.from ? normalizeCashBoxStatus(movement.from) : null;
      const to = movement.to ? normalizeCashBoxStatus(movement.to) : null;
      const amount = Number(movement.amount) || 0;

      if (amount <= 0) return acc;

      if (movementType === 'transfer' || movementType === 'internal_transfer') {
        // Transfers between business boxes are already allocated through closureLedgerById.
        if (from !== 'personal' && to !== 'personal') return acc;
      }

      let next = acc;
      if (to && cashBoxValueMatches(to, status)) next += amount;
      if (from && cashBoxValueMatches(from, status)) next -= amount;
      return next;
    }, 0);

    return Number((closureMoney + movementAdjustments).toFixed(2));
  }, [closureLedgerById, movements]);

  const accumulatedSafeTotal = useMemo(() => getAccumulatedBoxTotal('safe'), [getAccumulatedBoxTotal]);
  const accumulatedTransitTotal = useMemo(() => getAccumulatedBoxTotal('transit'), [getAccumulatedBoxTotal]);
  const accumulatedBankTotal = useMemo(() => getAccumulatedBoxTotal('bank'), [getAccumulatedBoxTotal]);
  const accumulatedBanquitosTotal = useMemo(() => getAccumulatedBoxTotal('banquitos'), [getAccumulatedBoxTotal]);
  const accumulatedPersonalTotal = useMemo(() => getAccumulatedBoxTotal('personal'), [getAccumulatedBoxTotal]);

  const applyOutflowPeriod = useCallback((period: 'este_mes' | 'mes_pasado' | 'anio_actual' | 'siempre' | 'custom') => {
    const today = new Date();
    const previousMonth = subMonths(today, 1);

    if (period === 'este_mes') {
      setOutflowStartDate(format(startOfMonth(today), 'yyyy-MM-dd'));
      setOutflowEndDate(format(endOfMonth(today), 'yyyy-MM-dd'));
    }

    if (period === 'mes_pasado') {
      setOutflowStartDate(format(startOfMonth(previousMonth), 'yyyy-MM-dd'));
      setOutflowEndDate(format(endOfMonth(previousMonth), 'yyyy-MM-dd'));
    }

    if (period === 'anio_actual') {
      setOutflowStartDate(format(startOfYear(today), 'yyyy-MM-dd'));
      setOutflowEndDate(format(endOfYear(today), 'yyyy-MM-dd'));
    }

    setOutflowPeriodType(period);
  }, []);

  const filteredOutflowMovements = useMemo(() => {
    return movements.filter(m => {
      if (m.type !== 'outflow') return false;
      if (outflowPeriodType === 'siempre') return true;

      const movementDate = parseISO(m.date);
      const start = startOfDay(parseISO(outflowStartDate));
      const end = endOfDay(parseISO(outflowEndDate));

      if (Number.isNaN(movementDate.getTime()) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return true;
      }

      return isWithinInterval(movementDate, { start, end });
    });
  }, [movements, outflowPeriodType, outflowStartDate, outflowEndDate]);

  const accumulatedOutflowTotal = useMemo(() => {
    return filteredOutflowMovements.reduce((acc, curr) => acc + curr.amount, 0);
  }, [filteredOutflowMovements]);

  const outflowPeriodLabel = useMemo(() => {
    if (outflowPeriodType === 'este_mes') return 'Este mes';
    if (outflowPeriodType === 'mes_pasado') return 'Mes pasado';
    if (outflowPeriodType === 'anio_actual') return 'Anio actual';
    if (outflowPeriodType === 'siempre') return 'Todo el historial';

    const start = parseISO(outflowStartDate);
    const end = parseISO(outflowEndDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'Periodo especifico';
    return `${format(start, 'dd/MM/yyyy')} - ${format(end, 'dd/MM/yyyy')}`;
  }, [outflowPeriodType, outflowStartDate, outflowEndDate]);

  const getBoxBalance = useCallback((box?: string | null) => {
    const normalizedBox = normalizeCashBoxStatus(box);
    if (normalizedBox === 'transit') return accumulatedTransitTotal;
    if (normalizedBox === 'bank') return accumulatedBankTotal;
    if (normalizedBox === 'banquitos') return accumulatedBanquitosTotal;
    if (normalizedBox === 'personal') return accumulatedPersonalTotal;
    return accumulatedSafeTotal;
  }, [accumulatedSafeTotal, accumulatedTransitTotal, accumulatedBankTotal, accumulatedBanquitosTotal, accumulatedPersonalTotal]);

  const getAvailableSourceBalance = useCallback((box?: string | null) => {
    let available = getBoxBalance(box);
    const currentMovement = editingMovementId
      ? movements.find(movement => movement.id === editingMovementId)
      : undefined;

    if (currentMovement) {
      const normalizedBox = normalizeCashBoxStatus(box);
      if (currentMovement.from && normalizeCashBoxStatus(currentMovement.from) === normalizedBox) {
        available += Number(currentMovement.amount) || 0;
      }
      if (currentMovement.to && normalizeCashBoxStatus(currentMovement.to) === normalizedBox) {
        available -= Number(currentMovement.amount) || 0;
      }
    }

    return Math.max(0, available);
  }, [editingMovementId, getBoxBalance, movements]);

  const combinedMovements = useMemo(() => {
    const boxMovements = movements.map(m => ({
      ...m,
      source: 'movement' as const
    }));
    const boxClosures = closures.map(c => {
      const displayStatus = getClosureDisplayStatus(c);
      return {
      id: c.id!,
      date: c.date,
      type: 'closure' as const,
      amount: c.physicalAmount,
      description: `CIERRE: ${c.responsible}`,
      status: displayStatus,
      source: 'closure' as const,
      responsible: c.responsible,
      difference: c.difference,
      systemAmount: c.systemAmount,
      systemBalance: c.systemBalance,
      createdBy: c.createdBy,
      tripId: c.tripId,
      category: undefined,
      subcategory: undefined,
      tags: undefined,
      from: undefined,
      to: displayStatus
    };
    });
    return [...boxMovements, ...boxClosures].sort((a, b) => b.date.localeCompare(a.date));
  }, [movements, closures, getClosureDisplayStatus]);

  const cashBoxStatementRows = useMemo(() => {
    return cashBoxStatuses.reduce((result, status) => {
      let runningBalance = getBoxBalance(status);

      result[status] = combinedMovements
        .filter(m =>
          (m.source === 'movement' && (cashBoxValueMatches(m.from, status) || cashBoxValueMatches(m.to, status))) ||
          (m.source === 'closure' && m.status === status && !m.tripId)
        )
        .map(m => {
          const signedAmount = m.source === 'closure' || cashBoxValueMatches(m.to, status)
            ? Number(m.amount) || 0
            : -(Number(m.amount) || 0);
          const balanceAfter = runningBalance;
          runningBalance -= signedAmount;

          return {
            ...m,
            signedAmount,
            balanceAfter,
          };
        });

      return result;
    }, {} as Record<CashBoxStatus, Array<(typeof combinedMovements)[number] & { signedAmount: number; balanceAfter: number }>>);
  }, [combinedMovements, getBoxBalance]);

  const handleOpenAddMovement = (type: 'outflow' | 'transfer' | 'internal_transfer', caja?: string, destination?: CashBoxStatus) => {
    setFormError(null);
    const defaults = getMovementDefaults(type, caja);
    setMovementValues(destination ? { ...defaults, to: destination } : defaults);
    setEditingMovementId(null);
    setIsAddingMovement(true);
    setContextMenu(null);
  };

  const handleToggleClosureSelection = (id: string) => {
    const newSelected = new Set(selectedClosures);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      const closure = closures.find(item => item.id === id);
      if (!closure || !isClosureAvailableForTrip(closure)) {
        alert('Solo puedes seleccionar cierres disponibles en tienda y sin viaje asociado.');
        return;
      }
      newSelected.add(id);
    }
    setSelectedClosures(newSelected);
  };

  const getClosureTargetBalances = useCallback((
    closure: ShiftClosure,
    status: ClosureCashBoxStatus
  ) => {
    const ledger = closure.id ? closureLedgerById[closure.id] : undefined;
    const currentBalances = ledger?.balances || {
      safe: normalizeClosureCashBoxStatus(closure.status) === 'safe' ? Number(closure.physicalAmount) || 0 : 0,
      transit: normalizeClosureCashBoxStatus(closure.status) === 'transit' ? Number(closure.physicalAmount) || 0 : 0,
      bank: normalizeClosureCashBoxStatus(closure.status) === 'bank' ? Number(closure.physicalAmount) || 0 : 0,
      banquitos: normalizeClosureCashBoxStatus(closure.status) === 'banquitos' ? Number(closure.physicalAmount) || 0 : 0,
      personal: 0
    };
    const totalBalance = closureCashBoxStatuses.reduce(
      (sum, sourceStatus) => sum + Math.max(0, Number(currentBalances[sourceStatus]) || 0),
      0
    );

    return {
      currentBalances,
      totalBalance,
      targetBalances: {
        safe: status === 'safe' ? totalBalance : 0,
        transit: status === 'transit' ? totalBalance : 0,
        bank: status === 'bank' ? totalBalance : 0,
        banquitos: status === 'banquitos' ? totalBalance : 0
      }
    };
  }, [closureLedgerById]);

  const handleCreateTrip = async () => {
    if (!user || !tripFormValues.description) return;

    setIsTripLoading(true);
    // If there are selected closures, use only eligible ones. Otherwise, use all available safe closures in the date range.
    const selectedList = selectedClosures.size > 0
      ? selectedTripClosures
      : closures.filter(c => {
          const d = parseISO(c.date);
          return isClosureAvailableForTrip(c) &&
                 isWithinInterval(d, {
                   start: startOfDay(parseISO(tripFormValues.startDate)),
                   end: endOfDay(parseISO(tripFormValues.endDate))
                 });
        });

    if (selectedList.length === 0) {
      alert('No hay cierres disponibles en tienda para crear el viaje.');
      setIsTripLoading(false);
      return;
    }

    const totalAmount = selectedList.reduce((acc, curr) => acc + curr.physicalAmount, 0);

    try {
      const tripRef = await addDoc(collection(db, 'trips'), {
        startDate: Timestamp.fromDate(new Date(tripFormValues.startDate)),
        description: tripFormValues.description,
        notes: tripFormValues.notes || '',
        status: 'in_transit',
        createdBy: user.uid,
        totalAmount: totalAmount
      });

      await persistClosureStatusChanges(selectedList, 'transit', tripRef.id);

      setIsCreatingTrip(false);
      setSelectedClosures(new Set());
      setTripFormValues({
        description: '',
        notes: '',
        startDate: format(new Date(), 'yyyy-MM-dd'),
        endDate: format(new Date(), 'yyyy-MM-dd')
      });
      playSound('transit');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'trips');
    } finally {
      setIsTripLoading(false);
    }
  };

  const handleCompleteTrip = async (tripId: string) => {
    try {
      await updateDoc(doc(db, 'trips', tripId), {
        status: 'completed',
        completionDate: serverTimestamp()
      });

      const tripClosures = closures.filter(c => c.tripId === tripId);
      await persistClosureStatusChanges(tripClosures, 'bank', tripId);
    } catch (err) {
       handleFirestoreError(err, OperationType.UPDATE, `trips/${tripId}`);
    }
  };

  const handleDeleteTrip = async (tripId: string) => {
    const trip = trips.find(t => t.id === tripId);
    if (trip?.status === 'completed') {
      alert('No se puede eliminar un viaje ya depositado. El dinero ya fue marcado como banco.');
      return;
    }
    if (!window.confirm('Eliminar este viaje? Los cierres marcados volveran a estar disponibles.')) return;
    try {
      const tripClosures = closures.filter(c => c.tripId === tripId);
      await persistClosureStatusChanges(tripClosures, 'safe', null);
      await deleteDoc(doc(db, 'trips', tripId));
      if (viewingTripId === tripId) setViewingTripId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `trips/${tripId}`);
    }
  };

  const lastEnterPress = useRef<number>(0);
  const handleKeyDown = (
    e: React.KeyboardEvent,
    onSave: () => void,
    nextRef?: React.RefObject<HTMLInputElement | null>,
    prevRef?: React.RefObject<HTMLInputElement | null>
  ) => {
    if (e.key === 'Enter') {
      const now = Date.now();

      // If there is a next field, go to it on single enter
      if (nextRef && nextRef.current) {
        e.preventDefault();
        if (nextRef.current) {
          nextRef.current.focus();
          if (nextRef.current.type !== 'datetime-local') nextRef.current.select();
        }
        return;
      }

      // If it's the last field or we want to save on double enter
      if (now - lastEnterPress.current < 500) {
        e.preventDefault();
        onSave();
        lastEnterPress.current = 0;
      } else {
        lastEnterPress.current = now;
      }
    }

    // Navigation with arrow keys
    if (e.key === 'ArrowRight' && nextRef && nextRef.current) {
      e.preventDefault();
      nextRef.current.focus();
      if (nextRef.current.type !== 'datetime-local') nextRef.current.select();
    }
    if (e.key === 'ArrowLeft' && prevRef && prevRef.current) {
      e.preventDefault();
      prevRef.current.focus();
      if (prevRef.current.type !== 'datetime-local') prevRef.current.select();
    }

    // Space bar shortcut to save (since space is not used in numeric/code fields here)
    if (e.key === ' ' && !e.repeat && (e.target as HTMLElement).tagName === 'INPUT') {
      const type = (e.target as HTMLInputElement).type;
      // Allow spaces in text inputs if needed, but the user says "it's not used in that part"
      // We'll trigger save on space
      e.preventDefault();
      onSave();
    }
  };

  const handleSaveInlineAdd = async () => {
    if (!user || !inlineAddValues.responsible || isSaving) return;
    setIsSaving(true);
    try {
      const sanitizedValues = {
        ...inlineAddValues,
        physicalAmount: toNonNegativeNumber(inlineAddValues.physicalAmount),
        systemAmount: toNonNegativeNumber(inlineAddValues.systemAmount),
        systemBalance: toNonNegativeNumber(inlineAddValues.systemBalance)
      };
      const diff = calculateClosureDifference(sanitizedValues);
      let dateToUse = new Date();
      if (sanitizedValues.date) {
        const parsed = new Date(sanitizedValues.date);
        if (!isNaN(parsed.getTime())) {
          dateToUse = parsed;
        }
      }

      await addDoc(collection(db, 'closures'), {
        ...sanitizedValues,
        difference: diff,
        date: Timestamp.fromDate(dateToUse),
        createdBy: user.uid,
        createdAt: serverTimestamp()
      });
      // Close inline adding to distinguish that it was saved, as requested by user
      setIsInlineAdding(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 2000);

      // Keep the date for the next entry
      setInlineAddValues(prev => ({
        ...prev,
        responsible: '',
        physicalAmount: 0,
        systemAmount: 0,
        systemBalance: 0,
        status: 'safe',
        notes: ''
      }));
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'closures');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (closure: ShiftClosure) => {
    setInlineEditingId(closure.id!);
    setInlineEditValues({ ...closure });
  };

  const handleSaveInlineEdit = async () => {
    if (!user || !inlineEditingId || isSaving) return;
    setIsSaving(true);
    try {
      const sanitizedValues = {
        ...inlineEditValues,
        physicalAmount: toNonNegativeNumber(inlineEditValues.physicalAmount),
        systemAmount: toNonNegativeNumber(inlineEditValues.systemAmount),
        systemBalance: toNonNegativeNumber(inlineEditValues.systemBalance)
      };
      const diff = calculateClosureDifference(sanitizedValues);
      await updateDoc(doc(db, 'closures', inlineEditingId), {
        ...sanitizedValues,
        difference: diff,
        date: Timestamp.fromDate(new Date(sanitizedValues.date!))
      });
      setInlineEditingId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `closures/${inlineEditingId}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelInlineEdit = () => {
    setInlineEditingId(null);
    setInlineEditValues({});
  };

  const toggleBulkEdit = () => {
    if (isBulkEditing) {
      setBulkEditValues({});
    }
    setIsBulkEditing(!isBulkEditing);
  };

  const handleSaveBulkEdit = async () => {
    if (!user) return;
    try {
      for (const [id, values] of Object.entries(bulkEditValues)) {
        const original = closures.find(c => c.id === id);
        if (!original) continue;
        const sanitizedValues = {
          ...values,
          physicalAmount: values.physicalAmount === undefined ? undefined : toNonNegativeNumber(values.physicalAmount),
          systemAmount: values.systemAmount === undefined ? undefined : toNonNegativeNumber(values.systemAmount),
          systemBalance: values.systemBalance === undefined ? undefined : toNonNegativeNumber(values.systemBalance)
        };
        const diff = calculateClosureDifference({
          physicalAmount: sanitizedValues.physicalAmount || original.physicalAmount,
          systemBalance: sanitizedValues.systemBalance || original.systemBalance
        });
        await updateDoc(doc(db, 'closures', id), {
          ...sanitizedValues,
          difference: diff,
          date: sanitizedValues.date ? Timestamp.fromDate(new Date(sanitizedValues.date)) : Timestamp.fromDate(new Date(original.date))
        });
      }
      setIsBulkEditing(false);
      setBulkEditValues({});
    } catch (err) {
      console.error('Bulk edit error:', err);
    }
  };

  const handleDuplicate = async (closure: ShiftClosure) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'closures'), {
        ...closure,
        id: undefined,
        date: serverTimestamp(),
        createdBy: user.uid,
        createdAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'closures');
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Estas seguro de eliminar este registro?')) {
      try {
        await deleteDoc(doc(db, 'closures', id));
        setDeleteConfirmId(null);
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `closures/${id}`);
      }
    }
  };

  const openMovementForm = (type: Movement['type'], movement?: Movement) => {
    setFormError(null);
    if (movement) {
      setEditingMovementId(movement.id);
      setMovementValues({ ...movement });
    } else {
      setEditingMovementId(null);
      setMovementValues(getMovementDefaults(type));
    }
    setIsAddingMovement(true);
  };

  const handleSaveMovement = async () => {
    if (!user) return;
    setFormError(null);

    let currentCategory = movementValues.category;
    let currentSubcategory = movementValues.subcategory;
    const currentTags = mergeExpenseTags(movementValues.tags || []);

    // Auto-commit pending new category
    if (isAddingNewCategory && newCategoryName.trim()) {
      const cat = newCategoryName.trim().toUpperCase();
      if (!categories.includes(cat)) {
        setCategories(prev => [...prev, cat]);
      }
      currentCategory = cat;
    }

    // Auto-commit pending new subcategory
    if (isAddingNewSubcategory && newSubcategoryName.trim()) {
      const sub = newSubcategoryName.trim().toUpperCase();
      if (!subcategories.includes(sub)) {
        setSubcategories(prev => [...prev, sub]);
      }
      currentSubcategory = sub;
    }

    const movementAmount = toNonNegativeNumber(movementValues.amount);
    const movementType = movementValues.type;
    const normalizedFrom = movementValues.from ? normalizeCashBoxStatus(movementValues.from) : undefined;
    const normalizedTo = movementType === 'transfer'
      ? 'bank'
      : movementValues.to
        ? normalizeCashBoxStatus(movementValues.to)
        : undefined;

    if (movementAmount <= 0) {
      setFormError('EL MONTO DEBE SER MAYOR A 0');
      return;
    }

    if (!movementValues.description.trim()) {
      setFormError('INGRESE UNA DESCRIPCION');
      return;
    }

    if (movementType === 'transfer') {
      if (!normalizedFrom) {
        setFormError('SELECCIONE ORIGEN Y DESTINO');
        return;
      }
      if (normalizedFrom === 'bank') {
        setFormError('PARA ENVIAR A BANCO, EL ORIGEN DEBE SER TIENDA O TRANSITO');
        return;
      }
    }

    if (movementType === 'internal_transfer') {
      if (!normalizedFrom || !normalizedTo) {
        setFormError('SELECCIONE ORIGEN Y DESTINO');
        return;
      }
      if (normalizedFrom === normalizedTo) {
        setFormError('ORIGEN Y DESTINO DEBEN SER DIFERENTES');
        return;
      }
    }

    if (movementType === 'outflow' && !normalizedFrom) {
      setFormError('SELECCIONE DESDE DONDE SE PAGA');
      return;
    }

    if (normalizedFrom) {
      const available = getAvailableSourceBalance(normalizedFrom);
      if (movementAmount > available + 0.009) {
        setFormError(`SALDO INSUFICIENTE EN ${getCashBoxLabel(normalizedFrom)}. DISPONIBLE: $${available.toLocaleString('es-CL')}`);
        return;
      }
    }

    try {
      // Clean data for Firestore
      const { id: _id, ...rest } = movementValues;
      const data: any = {
        date: Timestamp.fromDate(new Date(movementValues.date!)),
        type: movementType,
        amount: movementAmount,
        description: movementValues.description.toUpperCase(),
        createdBy: user.uid,
        category: movementType === 'outflow' ? currentCategory || 'Sueldos' : null,
        subcategory: movementType === 'outflow' ? currentSubcategory || null : null,
        tags: movementType === 'outflow' ? currentTags : null,
        from: normalizedFrom || null,
        to: movementType === 'outflow' ? null : normalizedTo || null,
      };

      if (!editingMovementId) {
        data.createdAt = serverTimestamp();
      }

      // Remove null/undefined fields that are not needed or not allowed to be null if they shouldn't be
      Object.keys(data).forEach(key => {
        if (data[key] === undefined || data[key] === null || (Array.isArray(data[key]) && data[key].length === 0)) {
          delete data[key];
        }
      });

      if (editingMovementId) {
        await updateDoc(doc(db, 'movements', editingMovementId), data);
      } else {
        await addDoc(collection(db, 'movements'), data);
      }

      setIsAddingMovement(false);
      setEditingMovementId(null);
      setViewingCajaMovements(null);
      setIsAddingNewCategory(false);
      setNewCategoryName('');
      setIsAddingNewSubcategory(false);
      setNewSubcategoryName('');
      setNewExpenseTag('');
      setFormError(null);
    } catch (err: any) {
      console.error('Error saving movement:', err);
      setFormError(err.message || 'ERROR AL GUARDAR');
      handleFirestoreError(err, editingMovementId ? OperationType.UPDATE : OperationType.CREATE, 'movements');
    }
  };

  const handleDeleteMovement = async (id: string) => {
    if (window.confirm('Eliminar este movimiento?')) {
      try {
        await deleteDoc(doc(db, 'movements', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `movements/${id}`);
      }
    }
  };

  const handleAddCategory = () => {
    if (newCategoryName && !categories.includes(newCategoryName)) {
      setCategories([...categories, newCategoryName]);
      setMovementValues({ ...movementValues, category: newCategoryName });
      setNewCategoryName('');
      setIsAddingNewCategory(false);
    }
  };

  const handleAddSubcategory = () => {
    if (newSubcategoryName && !subcategories.includes(newSubcategoryName)) {
      setSubcategories([...subcategories, newSubcategoryName]);
      setMovementValues({ ...movementValues, subcategory: newSubcategoryName });
      setNewSubcategoryName('');
      setIsAddingNewSubcategory(false);
    }
  };

  const persistClosureStatusChanges = async (
    items: ShiftClosure[],
    status: ClosureCashBoxStatus,
    tripId: string | null = null
  ) => {
    if (!user || items.length === 0) return;

    const firebaseUser = auth.currentUser;
    if (!firebaseUser) throw new Error('La sesion de Firebase no esta disponible.');
    const token = await firebaseUser.getIdToken();
    const response = await fetch('/api/perseo/audit-closures', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'closure_status',
        status,
        tripId,
        items: items
          .filter(closure => Boolean(closure.id))
          .map(closure => {
            const { currentBalances } = getClosureTargetBalances(closure, status);
            return {
              id: closure.id,
              cashBoxBalances: {
                safe: Math.max(0, Number(currentBalances.safe) || 0),
                transit: Math.max(0, Number(currentBalances.transit) || 0),
                bank: Math.max(0, Number(currentBalances.bank) || 0),
                banquitos: Math.max(0, Number(currentBalances.banquitos) || 0)
              }
            };
          })
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'No se pudo guardar el cambio de estado.');
    }
  };

  const toggleStatus = async (id: string) => {
    const closure = closures.find(c => c.id === id);
    if (!closure) return;

    const currentStatus = derivedClosureStatusById[id] || normalizeClosureCashBoxStatus(closure.status);
    const nextStatus = getNextStatus(currentStatus);
    playSound(nextStatus);

    try {
      await persistClosureStatusChanges([closure], nextStatus);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `closures/${id}`);
    }
  };

  const setClosureStatus = async (id: string, status: ClosureCashBoxStatus) => {
    const closure = closures.find(c => c.id === id);
    if (!closure) return;

    playSound(status);

    try {
      await persistClosureStatusChanges([closure], status);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `closures/${id}`);
    }
  };

  const toggleDay = (day: string) => {
    setExpandedDays(prev => ({ ...prev, [day]: !prev[day] }));
  };
  const toggleDayStatus = async (dayString: string) => {
    const items = closures.filter(c => format(parseISO(c.date), 'yyyy-MM-dd') === dayString);
    const currentStatus = getDayStatusFromItems(items);
    if (currentStatus === 'mixed') {
      alert('Este dia tiene cierres en estado mixto. Ajusta cada movimiento parcial antes de cambiar todo el dia.');
      return;
    }
    const nextStatus = getNextStatus(currentStatus);

    playSound(nextStatus);

    try {
      await persistClosureStatusChanges(items, nextStatus);
    } catch (err) {
      console.error('Day status toggle error:', err);
    }
  };

  const setDayStatus = async (dayString: string, status: ClosureCashBoxStatus) => {
    const items = closures.filter(c => format(parseISO(c.date), 'yyyy-MM-dd') === dayString);
    if (!items.length) return;

    playSound(status);

    try {
      await persistClosureStatusChanges(items, status);
    } catch (err) {
      console.error('Day status update error:', err);
    }
  };

  const getDayStatusInfo = (status: DisplayClosureStatus | undefined) => {
    if (status === 'banquitos') {
      return {
        label: 'En Banquitos',
        Icon: DollarSign,
        className: 'bg-blue-500/10 border-blue-500/20 text-blue-400'
      };
    }

    if (status === 'bank') {
      return {
        label: 'En Banco',
        Icon: Building2,
        className: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
      };
    }

    if (status === 'transit') {
      return {
        label: 'En Transito',
        Icon: Truck,
        className: 'bg-amber-500/10 border-amber-500/20 text-amber-400'
      };
    }

    if (status === 'mixed') {
      return {
        label: 'Mixto',
        Icon: ArrowRightLeft,
        className: 'bg-purple-500/10 border-purple-500/20 text-purple-400'
      };
    }

    return {
      label: 'En Tienda',
      Icon: ShieldCheck,
      className: 'bg-rose-500/10 border-rose-500/20 text-rose-400'
    };
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = async () => {
    if (!reportRef.current) return;
    setPrintError(null);
    const opt = {
      margin: 10,
      filename: `reporte_cierres_${format(new Date(), 'yyyy-MM-dd')}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: 'mm' as const, format: 'a4', orientation: 'portrait' as const }
    };
    try {
      await html2pdf().set(opt).from(reportRef.current).save();
    } catch (err) {
      setPrintError('Error al generar PDF. Intente imprimir directamente.');
    }
  };

  const copyToClipboard = (closure: ShiftClosure) => {
    const text = `Cierre ${format(parseISO(closure.date), 'dd/MM/yyyy HH:mm')}
Responsable: ${closure.responsible}
Fisico: $${closure.physicalAmount.toLocaleString('es-CL')}
Diferencia: $${closure.difference.toLocaleString('es-CL')}
Notas: ${closure.notes || 'N/A'}`;
    navigator.clipboard.writeText(text);
  };

  const activeColumnFilterCount = Object.values(columnFilters).filter(value => normalizeSearchText(value)).length;

  const updateColumnFilter = (column: ClosureColumnKey, value: string) => {
    setColumnFilters(prev => ({ ...prev, [column]: value }));
  };

  const clearColumnFilter = (column: ClosureColumnKey) => {
    setColumnFilters(prev => ({ ...prev, [column]: '' }));
  };

  const clearAllColumnFilters = () => {
    setColumnFilters(emptyClosureColumnFilters);
    setVisibleColumnFilter(null);
  };

  const renderColumnHeader = (
    column: ClosureColumnKey,
    label: string,
    icon: React.ReactNode,
    alignment: 'left' | 'center' = 'left'
  ) => {
    const isOpen = visibleColumnFilter === column;
    const hasValue = normalizeSearchText(columnFilters[column]).length > 0;
    const alignClass = alignment === 'center' ? 'justify-center text-center' : 'justify-start text-left';

    return (
      <div className="space-y-2">
        <div className={`flex items-center gap-2 ${alignClass}`}>
          {icon}
          <span>{label}</span>
          <button
            type="button"
            title={`Buscar en ${label}`}
            onClick={() => setVisibleColumnFilter(isOpen ? null : column)}
            className={`ml-1 p-1.5 rounded-lg border transition-all ${hasValue || isOpen ? 'bg-blue-500/20 border-blue-500/40 text-blue-300' : 'bg-white/5 border-white/5 text-slate-600 hover:text-white hover:bg-white/10'}`}
          >
            <Search className="w-3 h-3" />
          </button>
          {hasValue && (
            <button
              type="button"
              title={`Limpiar filtro de ${label}`}
              onClick={() => clearColumnFilter(column)}
              className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-all"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {isOpen && (
          <input
            autoFocus
            type="text"
            value={columnFilters[column]}
            onChange={e => updateColumnFilter(column, e.target.value)}
            placeholder={`Filtrar ${label.toLowerCase()}...`}
            className="w-full min-w-[110px] bg-[#0F172A] border border-blue-500/30 rounded-lg px-2.5 py-1.5 text-[10px] font-bold text-white placeholder:text-slate-600 outline-none focus:ring-2 focus:ring-blue-500/30 normal-case tracking-normal"
          />
        )}
      </div>
    );
  };

  const closureTableColumns: Record<ClosureTableColumnKey, {
    label: string;
    icon: React.ReactNode;
    align: 'left' | 'center' | 'right';
    widthClass: string;
    filterable?: boolean;
  }> = {
    date: { label: 'Fecha y Hora', icon: <Calendar className="w-3 h-3" />, align: 'left', widthClass: 'min-w-[145px]', filterable: true },
    responsible: { label: 'Responsable', icon: <UserIcon className="w-3 h-3" />, align: 'left', widthClass: 'min-w-[180px]', filterable: true },
    physicalAmount: { label: '$ Fisico', icon: <Banknote className="w-3 h-3" />, align: 'center', widthClass: 'min-w-[120px]', filterable: true },
    systemBalance: { label: 'Saldo Esperado', icon: <Wallet className="w-3 h-3" />, align: 'center', widthClass: 'min-w-[135px]', filterable: true },
    transferAmount: { label: 'Transf. PDV', icon: <ArrowRightLeft className="w-3 h-3" />, align: 'center', widthClass: 'min-w-[120px]' },
    systemAmount: { label: 'Venta Sistema', icon: <Calculator className="w-3 h-3" />, align: 'center', widthClass: 'min-w-[135px]', filterable: true },
    reportedAmount: { label: 'Reportado', icon: <FileText className="w-3 h-3" />, align: 'center', widthClass: 'min-w-[120px]' },
    difference: { label: 'Diferencia', icon: <AlertCircle className="w-3 h-3" />, align: 'center', widthClass: 'min-w-[120px]', filterable: true },
    status: { label: 'Estado', icon: <ShieldCheck className="w-3 h-3" />, align: 'center', widthClass: 'min-w-[155px]', filterable: true },
    actions: { label: 'Acciones', icon: <Edit2 className="w-3 h-3" />, align: 'right', widthClass: 'min-w-[105px]' },
    notes: { label: 'Notas', icon: <MessageSquare className="w-3 h-3" />, align: 'left', widthClass: 'min-w-[150px]', filterable: true },
  };

  const moveClosureColumn = (from: ClosureTableColumnKey, to: ClosureTableColumnKey) => {
    if (from === to) return;
    if (fixedClosureTableTrailingColumns.includes(from) || fixedClosureTableTrailingColumns.includes(to)) return;
    setClosureTableColumnOrder(prev => {
      const next = [...prev];
      const fromIndex = next.indexOf(from);
      const toIndex = next.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const [removed] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, removed);
      return next;
    });
  };

  const renderDraggableClosureHeader = (column: ClosureTableColumnKey) => {
    const config = closureTableColumns[column];
    const alignClass = config.align === 'right' ? 'text-right' : config.align === 'center' ? 'text-center' : 'text-left';
    const isDragging = draggedClosureColumn === column;
    const isFilterable = config.filterable && column in emptyClosureColumnFilters;
    const canDrag = !fixedClosureTableTrailingColumns.includes(column);

    return (
      <th
        key={column}
        draggable={canDrag}
        onDragStart={() => {
          if (canDrag) setDraggedClosureColumn(column);
        }}
        onDragOver={e => {
          if (canDrag) e.preventDefault();
        }}
        onDrop={e => {
          e.preventDefault();
          if (canDrag && draggedClosureColumn) moveClosureColumn(draggedClosureColumn, column);
          setDraggedClosureColumn(null);
        }}
        onDragEnd={() => setDraggedClosureColumn(null)}
        className={`px-3 py-3 text-[9px] font-black text-slate-500 uppercase tracking-widest border-r border-white/5 ${alignClass} ${config.widthClass} select-none ${canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'} ${isDragging ? 'bg-blue-500/10 text-blue-300' : ''}`}
        title={canDrag ? 'Arrastra para mover esta columna' : 'Columna fija'}
      >
        {isFilterable
          ? renderColumnHeader(column as ClosureColumnKey, config.label, config.icon, config.align === 'left' ? 'left' : 'center')
          : (
            <div className={`flex items-center gap-2 ${config.align === 'right' ? 'justify-end' : config.align === 'center' ? 'justify-center' : 'justify-start'}`}>
              {config.icon}
              <span>{config.label}</span>
            </div>
          )}
      </th>
    );
  };

  const cellClass = (column: ClosureTableColumnKey, extra = '') => {
    const align = closureTableColumns[column].align;
    const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
    return `px-3 py-2.5 ${alignClass} ${extra}`;
  };

  const amountCellClass = 'font-black text-slate-500 font-sans text-xs whitespace-nowrap';
  const inputShellClass = 'flex items-center bg-[#1E293B] border border-white/10 rounded-lg px-2 py-1.5 focus-within:border-blue-500';
  const statusButtonLabel = (status: ClosureCashBoxStatus) =>
    status === 'safe'
      ? 'Tienda'
      : status === 'transit'
        ? 'Transito'
        : status === 'bank'
          ? 'Banco'
          : 'Banquitos';

  const renderDifferenceBadge = (value: number | undefined, pending = false) => {
    if (pending) {
      return (
        <div className="inline-flex px-2.5 py-1 rounded-full text-[9px] font-black border bg-amber-500/10 text-amber-400 border-amber-500/20 whitespace-nowrap">
          Falta revisar
        </div>
      );
    }

    const difference = Number(value) || 0;
    return (
      <div className={`inline-flex items-center px-2.5 py-1 rounded-full text-[9px] font-black border whitespace-nowrap ${difference < 0 ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'}`}>
        {difference >= 0 ? <AlertCircle className="w-3 h-3 mr-1" /> : <ShieldAlert className="w-3 h-3 mr-1" />}
        {difference >= 0 ? '+' : ''}{difference.toLocaleString('es-CL')}
      </div>
    );
  };

  const renderTransferValue = (transferValue: unknown, systemAmount: unknown, systemBalance: unknown) => {
    const transfer = transferPdvAmount(transferValue);
    const expectedDelta = Math.max(0, Number(((Number(systemAmount) || 0) - (Number(systemBalance) || 0)).toFixed(2)));
    const missingExplicitTransfer = transfer <= 0.009 && expectedDelta > closureMatchTolerance;

    return (
      <div className="inline-flex flex-col items-center gap-1">
        <span>{moneyText(transfer)}</span>
        {missingExplicitTransfer && (
          <span
            title="Venta Sistema es mayor que Saldo Esperado, pero el reporte no trajo Transf. PDV explicito."
            className="inline-flex px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-[8px] font-black text-amber-400 uppercase tracking-widest whitespace-nowrap"
          >
            Falta dato
          </span>
        )}
      </div>
    );
  };

  const renderInlineAddCell = (column: ClosureTableColumnKey) => {
    const difference = (inlineAddValues.physicalAmount || 0) - (inlineAddValues.systemBalance || 0);

    switch (column) {
      case 'date':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center bg-[#1E293B] border border-blue-500 rounded-lg px-2 py-1.5 focus-within:ring-2 focus-within:ring-blue-500/50">
              <input
                ref={dateInputRef}
                type="datetime-local"
                value={inlineAddValues.date ? format(parseISO(inlineAddValues.date), "yyyy-MM-dd'T'HH:mm") : ''}
                onChange={e => {
                  if (!e.target.value) return;
                  const d = new Date(e.target.value);
                  if (!isNaN(d.getTime())) setInlineAddValues({ ...inlineAddValues, date: d.toISOString() });
                }}
                onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, responsibleInputRef)}
                className="w-full bg-transparent outline-none text-white font-sans font-bold text-[10px]"
              />
            </div>
          </td>
        );
      case 'responsible':
        return (
          <td key={column} className={cellClass(column)}>
            <div className={inputShellClass}>
              <input
                ref={responsibleInputRef}
                list="responsibles-list"
                type="text"
                value={inlineAddValues.responsible}
                onFocus={e => e.target.select()}
                onChange={e => setInlineAddValues({ ...inlineAddValues, responsible: e.target.value.toUpperCase() })}
                onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, physicalAmountRef, dateInputRef)}
                className="w-full bg-transparent outline-none text-white placeholder:text-slate-600 font-bold text-xs uppercase"
                placeholder="RESPONSABLE"
              />
              <datalist id="responsibles-list">
                {uniqueResponsibles.map(r => <option key={r} value={r} />)}
              </datalist>
            </div>
          </td>
        );
      case 'physicalAmount':
        return (
          <td key={column} className={cellClass(column)}>
            <div className={inputShellClass}>
              <input
                ref={physicalAmountRef}
                type="number"
                min="0"
                value={inlineAddValues.physicalAmount || ''}
                onFocus={e => e.target.select()}
                onChange={e => setInlineAddValues({ ...inlineAddValues, physicalAmount: toNonNegativeNumber(e.target.value) })}
                onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, systemBalanceRef, responsibleInputRef)}
                className="w-full bg-transparent outline-none text-white text-center font-black font-sans text-xs"
                placeholder="FISICO"
              />
            </div>
          </td>
        );
      case 'systemBalance':
        return (
          <td key={column} className={cellClass(column)}>
            <div className={inputShellClass}>
              <input
                ref={systemBalanceRef}
                type="number"
                min="0"
                value={inlineAddValues.systemBalance || ''}
                onFocus={e => e.target.select()}
                onChange={e => setInlineAddValues({ ...inlineAddValues, systemBalance: toNonNegativeNumber(e.target.value) })}
                onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, systemAmountRef, physicalAmountRef)}
                className="w-full bg-transparent outline-none text-white text-center font-black font-sans text-xs"
                placeholder="SALDO"
              />
            </div>
          </td>
        );
      case 'systemAmount':
        return (
          <td key={column} className={cellClass(column)}>
            <div className={inputShellClass}>
              <input
                ref={systemAmountRef}
                type="number"
                min="0"
                value={inlineAddValues.systemAmount || ''}
                onFocus={e => e.target.select()}
                onChange={e => setInlineAddValues({ ...inlineAddValues, systemAmount: toNonNegativeNumber(e.target.value) })}
                onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, undefined, systemBalanceRef)}
                className="w-full bg-transparent outline-none text-white text-center font-black font-sans text-xs"
                placeholder="VENTA"
              />
            </div>
          </td>
        );
      case 'difference':
        return <td key={column} className={cellClass(column)}>{renderDifferenceBadge(difference)}</td>;
      case 'status':
        return (
          <td key={column} className={cellClass(column)}>
            <select
              value={inlineAddValues.status || 'safe'}
              onChange={e => setInlineAddValues({ ...inlineAddValues, status: e.target.value as ClosureCashBoxStatus })}
              className="bg-[#0F172A] border border-white/10 rounded-lg px-2 py-1.5 text-[10px] font-black uppercase text-white outline-none"
            >
              <option value="safe">Tienda</option>
              <option value="transit">Transito</option>
              <option value="bank">Banco</option>
              <option value="banquitos">Banquitos</option>
            </select>
          </td>
        );
      case 'actions':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex justify-end gap-1">
              <button
                onClick={() => {
                  const note = prompt('Notas / Observaciones:', inlineAddValues.notes || '');
                  if (note !== null) setInlineAddValues({ ...inlineAddValues, notes: note });
                }}
                className={`p-1.5 rounded-lg transition-all ${inlineAddValues.notes ? 'bg-blue-500 text-white' : 'bg-white/5 text-slate-500'}`}
              >
                <MessageSquare className="w-4 h-4" />
              </button>
              <button onClick={handleSaveInlineAdd} disabled={isSaving} className="bg-blue-600 hover:bg-blue-500 text-white p-1.5 rounded-lg transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50">
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => setIsInlineAdding(false)} className="bg-white/5 hover:bg-white/10 text-slate-500 p-1.5 rounded-lg transition-all">
                <X className="w-4 h-4" />
              </button>
            </div>
          </td>
        );
      case 'notes':
        return <td key={column} className={cellClass(column, 'text-slate-500 text-xs')}>{inlineAddValues.notes || '-'}</td>;
      default:
        return <td key={column} className={cellClass(column, amountCellClass)}>-</td>;
    }
  };

  const renderGroupSummaryCell = (group: (typeof groupedClosures)[number], column: ClosureTableColumnKey) => {
    switch (column) {
      case 'date':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-white/5 rounded-lg border border-white/5">
                <RefreshCw className="w-4 h-4 text-slate-500" />
              </div>
              <div>
                <div className="font-black text-white text-xs">{format(parseISO(group.date), 'EEEE, dd MMMM', { locale: es })}</div>
                <div className="text-[9px] font-black text-blue-500 uppercase tracking-widest">{group.items.length} Registros</div>
                {group.missingRows.length > 0 && (
                  <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[8px] font-black text-amber-400 uppercase tracking-widest">
                    <ShieldAlert className="w-3 h-3" />
                    {group.missingRows.length} venta sin foto
                  </div>
                )}
              </div>
            </div>
          </td>
        );
      case 'responsible':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Resumen del dia</span>
            </div>
          </td>
        );
      case 'physicalAmount':
        return <td key={column} className={cellClass(column, 'font-black text-white font-sans text-xs whitespace-nowrap')}>${group.totals.physicalAmount.toLocaleString('es-CL')}</td>;
      case 'systemBalance':
        return <td key={column} className={cellClass(column, amountCellClass)}>${(group.totals.systemBalance || 0).toLocaleString('es-CL')}</td>;
      case 'transferAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>{renderTransferValue(group.totals.transferAmount, group.totals.systemAmount, group.totals.systemBalance)}</td>;
      case 'systemAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>${group.totals.systemAmount.toLocaleString('es-CL')}</td>;
      case 'reportedAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>${(group.totals.reportedAmount || 0).toLocaleString('es-CL')}</td>;
      case 'difference':
        return <td key={column} className={cellClass(column)}>{renderDifferenceBadge(group.totals.difference)}</td>;
      case 'status':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center justify-center gap-1" onClick={e => e.stopPropagation()}>
              {closureCashBoxStatuses.map(status => {
                const statusInfo = getDayStatusInfo(status);
                const StatusIcon = statusInfo.Icon;
                const active = group.status === status;
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setDayStatus(group.date, status)}
                    title={`Enviar todos los cierres del dia a ${statusInfo.label}`}
                    className={`px-2 py-1.5 rounded-lg border text-[8px] font-black uppercase inline-flex items-center gap-1 transition-all ${active ? statusInfo.className : 'bg-white/5 border-white/5 text-slate-500 hover:text-white hover:bg-white/10'}`}
                  >
                    <StatusIcon className="w-3 h-3" />
                    {statusButtonLabel(status)}
                  </button>
                );
              })}
            </div>
          </td>
        );
      case 'actions':
        return (
          <td key={column} className={cellClass(column)}>
            <ChevronDown className={`w-5 h-5 text-slate-700 transition-transform ml-auto ${expandedDays[group.date] ? 'rotate-180' : ''}`} />
          </td>
        );
      case 'notes':
        return <td key={column} className={cellClass(column, 'text-slate-600 text-xs')}>-</td>;
      default:
        return <td key={column} className={cellClass(column, amountCellClass)}>-</td>;
    }
  };

  const renderInlineEditCell = (column: ClosureTableColumnKey) => {
    const difference = (inlineEditValues.physicalAmount || 0) - (inlineEditValues.systemBalance || 0);

    switch (column) {
      case 'date':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center bg-[#1E293B] border border-blue-500 rounded-lg px-2 py-1.5 focus-within:ring-2 focus-within:ring-blue-500/50">
              <input
                type="datetime-local"
                value={inlineEditValues.date ? format(parseISO(inlineEditValues.date), "yyyy-MM-dd'T'HH:mm") : ''}
                onChange={e => setInlineEditValues({ ...inlineEditValues, date: new Date(e.target.value).toISOString() })}
                className="bg-transparent outline-none text-white font-sans font-bold text-[10px] w-full"
              />
            </div>
          </td>
        );
      case 'responsible':
        return (
          <td key={column} className={cellClass(column)}>
            <div className={inputShellClass}>
              <input
                type="text"
                value={inlineEditValues.responsible}
                onFocus={e => e.target.select()}
                onChange={e => setInlineEditValues({ ...inlineEditValues, responsible: e.target.value.toUpperCase() })}
                onKeyDown={(e) => handleKeyDown(e, handleSaveInlineEdit)}
                className="bg-transparent outline-none text-white font-black text-xs uppercase w-full"
              />
            </div>
          </td>
        );
      case 'physicalAmount':
      case 'systemBalance':
      case 'systemAmount': {
        const ref = column === 'physicalAmount' ? physicalAmountRef : column === 'systemBalance' ? systemBalanceRef : systemAmountRef;
        const placeholder = column === 'physicalAmount' ? 'FISICO' : column === 'systemBalance' ? 'SALDO' : 'VENTA';
        return (
          <td key={column} className={cellClass(column)}>
            <div className={inputShellClass}>
              <input
                ref={ref}
                type="number"
                min="0"
                value={inlineEditValues[column] || ''}
                onFocus={e => e.target.select()}
                onChange={e => setInlineEditValues({ ...inlineEditValues, [column]: toNonNegativeNumber(e.target.value) })}
                onKeyDown={(e) => handleKeyDown(e, handleSaveInlineEdit)}
                className="bg-transparent outline-none text-white text-center font-black font-sans text-xs w-full"
                placeholder={placeholder}
              />
            </div>
          </td>
        );
      }
      case 'transferAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>{moneyText(transferPdvAmount(inlineEditValues.transferAmount))}</td>;
      case 'reportedAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>{moneyText(inlineEditValues.reportedAmount || 0)}</td>;
      case 'difference':
        return <td key={column} className={cellClass(column)}>{renderDifferenceBadge(difference)}</td>;
      case 'status':
        return (
          <td key={column} className={cellClass(column)}>
            <select
              value={inlineEditValues.status || 'safe'}
              onChange={e => setInlineEditValues({ ...inlineEditValues, status: e.target.value as ClosureCashBoxStatus })}
              className="bg-[#0F172A] border border-white/10 rounded-lg px-2 py-1.5 text-[10px] font-black uppercase text-white outline-none"
            >
              <option value="safe">Tienda</option>
              <option value="transit">Transito</option>
              <option value="bank">Banco</option>
              <option value="banquitos">Banquitos</option>
            </select>
          </td>
        );
      case 'actions':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex justify-end gap-1">
              <button onClick={handleSaveInlineEdit} disabled={isSaving} className="p-1.5 bg-blue-600 rounded-lg text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"><Check className="w-4 h-4" /></button>
              <button onClick={handleCancelInlineEdit} className="p-1.5 bg-white/5 rounded-lg text-slate-500"><X className="w-4 h-4" /></button>
            </div>
          </td>
        );
      case 'notes':
        return <td key={column} className={cellClass(column, 'text-slate-500 text-xs')}>{inlineEditValues.notes || '-'}</td>;
      default:
        return <td key={column} className={cellClass(column, amountCellClass)}>-</td>;
    }
  };

  const renderClosureCell = (closure: ShiftClosure, column: ClosureTableColumnKey) => {
    const matchedPerseoRow = closure.id ? perseoClosureMatchById[closure.id]?.row : null;
    const displaySystemBalance = matchedPerseoRow ? Number(matchedPerseoRow.systemBalance) || 0 : Number(closure.systemBalance) || 0;
    const displaySystemAmount = matchedPerseoRow ? Number(matchedPerseoRow.systemAmount) || 0 : Number(closure.systemAmount) || 0;
    const displayTransferAmount = matchedPerseoRow ? getExplicitPerseoTransferAmount(matchedPerseoRow) : Number(closure.transferAmount) || 0;
    const displayReportedAmount = matchedPerseoRow ? Number(matchedPerseoRow.reportedAmount) || 0 : Number(closure.reportedAmount) || 0;
    const displayDifference = Number(((Number(closure.physicalAmount) || 0) - displaySystemBalance).toFixed(2));
    const displayClosureForAudit: ShiftClosure = {
      ...closure,
      systemAmount: displaySystemAmount,
      systemBalance: displaySystemBalance,
      reportedAmount: displayReportedAmount,
      transferAmount: displayTransferAmount,
      difference: displayDifference,
      systemSource: matchedPerseoRow ? 'perseo' : closure.systemSource,
      perseoAuditStatus: matchedPerseoRow
        ? Math.abs(displayDifference) <= closureMatchTolerance ? 'matched' : 'difference'
        : closure.perseoAuditStatus,
    };

    switch (column) {
      case 'date':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex flex-col">
              <span className="text-xs font-black text-slate-200">{format(parseISO(closure.date), 'dd MMM', { locale: es })}</span>
              <span className="text-[9px] font-black text-slate-500 uppercase">{format(parseISO(closure.date), 'HH:mm')} HRS</span>
            </div>
          </td>
        );
      case 'responsible':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-white/5 rounded-full flex items-center justify-center border border-white/5">
                <UserIcon className="w-3.5 h-3.5 text-slate-500" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-black text-slate-200 uppercase tracking-wider">{closure.responsible}</span>
                {(() => {
                  const auditInfo = getClosureAuditInfo(displayClosureForAudit);
                  if (auditInfo.status === 'not_audited') return null;
                  return (
                    <span
                      title={auditInfo.detail}
                      className={`w-fit inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[8px] font-black uppercase tracking-widest ${auditInfo.className}`}
                    >
                      {auditInfo.status === 'difference'
                        ? <ShieldAlert className="w-3 h-3" />
                        : auditInfo.status === 'matched'
                          ? <CheckCircle2 className="w-3 h-3" />
                          : <FileText className="w-3 h-3" />}
                      {auditInfo.label}
                    </span>
                  );
                })()}
              </div>
            </div>
          </td>
        );
      case 'physicalAmount':
        return <td key={column} className={cellClass(column, 'font-black text-white font-sans text-xs whitespace-nowrap')}>${closure.physicalAmount.toLocaleString('es-CL')}</td>;
      case 'systemBalance':
        return <td key={column} className={cellClass(column, amountCellClass)}>${displaySystemBalance.toLocaleString('es-CL')}</td>;
      case 'transferAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>{renderTransferValue(displayTransferAmount, displaySystemAmount, displaySystemBalance)}</td>;
      case 'systemAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>${displaySystemAmount.toLocaleString('es-CL')}</td>;
      case 'reportedAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>${displayReportedAmount.toLocaleString('es-CL')}</td>;
      case 'difference':
        return <td key={column} className={cellClass(column)}>{renderDifferenceBadge(displayDifference)}</td>;
      case 'status':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center justify-center gap-1">
              {closureCashBoxStatuses.map(status => {
                const currentStatus = closure.id
                  ? derivedClosureStatusById[closure.id] || normalizeClosureCashBoxStatus(closure.status)
                  : normalizeClosureCashBoxStatus(closure.status);
                const statusInfo = getDayStatusInfo(status);
                const StatusIcon = statusInfo.Icon;
                const active = currentStatus === status;
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setClosureStatus(closure.id!, status)}
                    title={statusInfo.label}
                    className={`px-2 py-1.5 rounded-lg border text-[8px] font-black uppercase inline-flex items-center gap-1 transition-all ${active ? statusInfo.className : 'bg-white/5 border-white/5 text-slate-500 hover:text-white hover:bg-white/10'}`}
                  >
                    <StatusIcon className="w-3 h-3" />
                    {statusButtonLabel(status)}
                  </button>
                );
              })}
            </div>
          </td>
        );
      case 'actions':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => handleToggleClosureSelection(closure.id!)} title="Seleccionar para Viaje" className={`p-1.5 rounded-lg transition-colors ${selectedClosures.has(closure.id!) ? 'text-blue-500 bg-blue-500/10' : 'text-slate-600 hover:text-white'}`}><CheckCircle2 className="w-4 h-4" /></button>
              {closure.notes && <button onClick={() => alert(closure.notes)} className="p-1.5 text-blue-400 hover:bg-blue-500/10 rounded-lg"><MessageSquare className="w-4 h-4" /></button>}
              <button onClick={() => handleEdit(closure)} className="p-1.5 text-slate-500 hover:text-white hover:bg-white/5 rounded-lg"><Edit2 className="w-4 h-4" /></button>
              <button onClick={() => handleDelete(closure.id!)} className="p-1.5 text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg"><Trash2 className="w-4 h-4" /></button>
            </div>
          </td>
        );
      case 'notes':
        return <td key={column} className={cellClass(column, 'text-slate-500 text-xs max-w-[180px] truncate')}>{closure.notes || '-'}</td>;
      default:
        return <td key={column} className={cellClass(column, amountCellClass)}>-</td>;
    }
  };

  const renderMissingRowCell = (row: MissingPerseoClosure, column: ClosureTableColumnKey) => {
    switch (column) {
      case 'date':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex flex-col">
              <span className="text-xs font-black text-amber-300">{format(parseISO(`${row.businessDate}T12:00:00.000Z`), 'dd MMM', { locale: es })}</span>
              <span className="text-[9px] font-black text-amber-500 uppercase">Sin foto</span>
            </div>
          </td>
        );
      case 'responsible':
        return (
          <td key={column} className={cellClass(column)}>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-amber-500/10 rounded-full flex items-center justify-center border border-amber-500/20">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-black text-amber-200 uppercase tracking-wider">{row.responsibleLabel}</span>
                <span className="w-fit inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[8px] font-black uppercase tracking-widest bg-amber-500/10 text-amber-400 border-amber-500/20">
                  <FileText className="w-3 h-3" />
                  Falta foto/corte
                </span>
              </div>
            </div>
          </td>
        );
      case 'physicalAmount':
        return <td key={column} className={cellClass(column, 'font-black text-amber-400 font-sans text-xs whitespace-nowrap')}>Pendiente</td>;
      case 'systemBalance':
        return <td key={column} className={cellClass(column, amountCellClass)}>{moneyText(row.systemBalance)}</td>;
      case 'transferAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>{renderTransferValue(getExplicitPerseoTransferAmount(row), row.systemAmount, row.systemBalance)}</td>;
      case 'systemAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>{moneyText(row.systemAmount)}</td>;
      case 'reportedAmount':
        return <td key={column} className={cellClass(column, amountCellClass)}>{moneyText(row.reportedAmount)}</td>;
      case 'difference':
        return <td key={column} className={cellClass(column)}>{renderDifferenceBadge(0, true)}</td>;
      case 'status':
        return (
          <td key={column} className={cellClass(column)}>
            <span className="inline-flex px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[8px] font-black uppercase">
              Perseo
            </span>
          </td>
        );
      case 'actions':
        return <td key={column} className={cellClass(column, 'text-[9px] font-black text-slate-600 uppercase')}>Reporte</td>;
      case 'notes':
        return <td key={column} className={cellClass(column, 'text-slate-600 text-xs')}>Venta sin foto</td>;
      default:
        return <td key={column} className={cellClass(column, amountCellClass)}>-</td>;
    }
  };

  const renderCashBoxStatementModal = () => {
    if (!viewingCajaMovements) return null;

    const status = viewingCajaMovements as CashBoxStatus;
    const boxInfo = {
      safe: {
        label: 'En Tienda',
        balance: accumulatedSafeTotal,
        Icon: ShieldCheck,
        color: 'text-blue-600',
        soft: 'bg-blue-50',
      },
      transit: {
        label: 'En Transito',
        balance: accumulatedTransitTotal,
        Icon: Truck,
        color: 'text-amber-600',
        soft: 'bg-amber-50',
      },
      bank: {
        label: 'Banco',
        balance: accumulatedBankTotal,
        Icon: Building2,
        color: 'text-emerald-600',
        soft: 'bg-emerald-50',
      },
      banquitos: {
        label: 'Banquitos',
        balance: accumulatedBanquitosTotal,
        Icon: DollarSign,
        color: 'text-blue-600',
        soft: 'bg-blue-50',
      },
      personal: {
        label: 'Caja Personal',
        balance: accumulatedPersonalTotal,
        Icon: Wallet,
        color: 'text-purple-600',
        soft: 'bg-purple-50',
      },
    }[status];
    const BoxIcon = boxInfo.Icon;
    const rows = cashBoxStatementRows[status] || [];
    const firstDate = rows[0]?.date;
    const editStatementRow = (m: typeof rows[number]) => {
      if (m.source === 'movement') {
        setMovementValues({
          ...m,
          date: m.date
        });
        setEditingMovementId(m.id);
        setIsAddingMovement(true);
      } else {
        const closure = closures.find(c => c.id === m.id);
        if (closure) {
          setInlineEditingId(closure.id!);
          setInlineEditValues({ ...closure });
          setViewingCajaMovements(null);
        }
      }
    };

    return (
      <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="w-full max-w-xl bg-slate-50 text-slate-950 rounded-[2rem] border border-white/20 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
        >
          <div className="px-5 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BoxIcon className={`w-6 h-6 ${boxInfo.color}`} />
              <div>
                <h3 className="text-lg font-black tracking-tight">Mi cuenta</h3>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">{boxInfo.label}</p>
              </div>
            </div>
            <button
              onClick={() => setViewingCajaMovements(null)}
              className="w-11 h-11 flex items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-5 py-5 bg-white border-b border-slate-200">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold text-slate-500 uppercase">Saldo actual <span className="text-amber-400">*</span></p>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-4xl font-black tracking-tight">${boxInfo.balance.toLocaleString('es-CL')}</p>
                  <Eye className={`w-5 h-5 ${boxInfo.color}`} />
                </div>
              </div>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 text-xs font-bold ${boxInfo.color} mt-4`}
              >
                <Share2 className="w-4 h-4" />
                Compartir cuenta
              </button>
            </div>
          </div>

          <div className="grid grid-cols-5 gap-2 px-5 py-4 border-b border-slate-200 bg-slate-50">
            {[
              { label: 'Gasto', Icon: ArrowUpRight, onClick: () => handleOpenAddMovement('outflow', status) },
              ...(status !== 'safe' && status !== 'personal' ? [{ label: 'Tienda', Icon: ShieldCheck, onClick: () => handleOpenAddMovement('internal_transfer', status, 'safe') }] : []),
              ...(status !== 'bank' && status !== 'personal' ? [{ label: 'Banco', Icon: Building2, onClick: () => handleOpenAddMovement('transfer', status, 'bank') }] : []),
              ...(status !== 'transit' ? [{ label: 'Transito', Icon: Truck, onClick: () => handleOpenAddMovement('internal_transfer', status, 'transit') }] : []),
              ...(status !== 'banquitos' && status !== 'personal' ? [{ label: 'Banquitos', Icon: DollarSign, onClick: () => handleOpenAddMovement('internal_transfer', status, 'banquitos') }] : []),
              ...(status !== 'personal' ? [{ label: 'Personal', Icon: Wallet, onClick: () => handleOpenAddMovement('internal_transfer', status, 'personal') }] : []),
              { label: 'Actualizar', Icon: RefreshCw, onClick: () => setViewingCajaMovements(status) },
            ].map(action => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                className={`flex flex-col items-center gap-1 ${boxInfo.color}`}
                title={action.label}
              >
                <span className="w-10 h-10 rounded-full border border-slate-200 bg-white shadow-sm flex items-center justify-center">
                  <action.Icon className="w-5 h-5" />
                </span>
                <span className="text-[9px] font-black uppercase text-slate-500">{action.label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-base font-black">Movimientos</h4>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 text-xs font-bold ${boxInfo.color}`}
              >
                <Calendar className="w-4 h-4" />
                Filtrar por fechas
              </button>
            </div>

            {firstDate && (
              <p className="text-[11px] font-bold text-slate-500 mb-2">
                {format(parseISO(firstDate), 'EEEE, dd MMM. yyyy', { locale: es })}
              </p>
            )}

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              {rows.length > 0 ? rows.map(m => (
                <div
                  key={`${m.source}-${m.id}`}
                  className="min-h-[84px] border-b border-slate-200 last:border-b-0 px-4 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 pr-2">
                      <p className="text-sm font-semibold text-slate-700 leading-snug uppercase">{m.description}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-2 text-[10px] font-bold text-slate-400 uppercase">
                        <span>{format(parseISO(m.date), 'dd/MM/yyyy HH:mm')}</span>
                        <span className={`px-2 py-0.5 rounded-md ${boxInfo.soft} ${boxInfo.color}`}>
                          {m.source === 'closure' ? 'Cierre de caja' : m.type === 'outflow' ? 'Gasto' : m.to === status ? 'Ingreso' : 'Salida'}
                        </span>
                        {m.category && <span>{m.category}</span>}
                        {m.subcategory && <span>{m.subcategory}</span>}
                        {m.tags?.map(tag => <span key={tag}>{tag}</span>)}
                      </div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase mt-2">
                        {m.source === 'closure'
                          ? `Responsable: ${m.responsible || 'Sin responsable'}`
                          : m.signedAmount < 0
                            ? `Hacia: ${m.to || 'Gasto'}`
                            : `Desde: ${m.from || 'Ingreso'}`}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-lg font-black ${m.signedAmount >= 0 ? 'text-emerald-600' : 'text-slate-700'}`}>
                        {m.signedAmount >= 0 ? '+' : '-'}${Math.abs(m.signedAmount).toLocaleString('es-CL')}
                      </p>
                      <p className="text-sm font-semibold text-slate-500">${m.balanceAfter.toLocaleString('es-CL')}</p>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 mt-3">
                    <button
                      type="button"
                      onClick={() => editStatementRow(m)}
                      className="w-9 h-9 flex items-center justify-center rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-100 transition-all"
                      title="Editar"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (m.source === 'movement') {
                          handleDeleteMovement(m.id);
                        } else {
                          handleDelete(m.id);
                        }
                      }}
                      className="w-9 h-9 flex items-center justify-center rounded-xl bg-rose-50 text-rose-600 hover:bg-rose-100 transition-all"
                      title="Eliminar"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )) : (
                <div className="py-16 text-center">
                  <History className="w-14 h-14 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-400 font-black uppercase tracking-widest text-xs">No hay movimientos registrados para esta caja</p>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0F172A]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) {
    return (
       <div className="min-h-screen flex items-center justify-center bg-[#0F172A] p-4 relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/10 blur-[120px] rounded-full" />
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-[#1E293B]/80 backdrop-blur-xl rounded-[2.5rem] shadow-2xl p-10 text-center border border-white/10 relative z-10"
        >
          <div className="w-24 h-24 bg-gradient-to-br from-blue-500 to-blue-700 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl shadow-blue-500/20">
            <DollarSign className="w-12 h-12 text-white" />
          </div>
          <h1 className="text-4xl font-black text-white mb-4 tracking-tight">CIERRES 1.1</h1>
          <p className="text-slate-400 mb-10 leading-relaxed text-lg">Gestiona tus cierres de caja en la nube.</p>
          <button onClick={signInWithGoogle} className="w-full py-5 bg-white text-[#0F172A] rounded-2xl font-black text-lg hover:bg-slate-100 transition-all shadow-xl flex items-center justify-center gap-3">
            <UserIcon className="w-6 h-6" />
            Ingresar con Google
            <ArrowRight className="w-5 h-5" />
          </button>
        </motion.div>
      </div>
    );
  }

  if (currentView === 'dashboard') {
    return <Dashboard closures={closures} movements={movements} onBack={() => setCurrentView('main')} />;
  }

  if (currentView === 'personal') {
    return <PersonalFinance user={user} onBack={() => setCurrentView('main')} />;
  }

  if (currentView === 'payroll') {
    return (
      <PayrollModule
        user={user}
        onBack={() => setCurrentView('main')}
        balances={{
          safe: accumulatedSafeTotal,
          transit: accumulatedTransitTotal,
          bank: accumulatedBankTotal,
          personal: accumulatedPersonalTotal,
        }}
      />
    );
  }

  if (currentView === 'inventory') {
    return <InventoryModule onBack={() => setCurrentView('main')} />;
  }

  if (currentView === 'credits') {
    return (
      <BusinessCreditsModule
        user={user}
        onBack={() => setCurrentView('main')}
        balances={{
          safe: accumulatedSafeTotal,
          transit: accumulatedTransitTotal,
          bank: accumulatedBankTotal,
        }}
      />
    );
  }

  return (
    <>
      <div className={`min-h-screen bg-[#0F172A] text-slate-200 pb-20 select-none ${showPrintPreview ? 'hidden' : 'block'} print:hidden`}>
        <header className="bg-[#1E293B]/50 backdrop-blur-md border-b border-white/5 sticky top-0 z-30">
          <div className="w-full px-4 h-20 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setIsModuleSidebarOpen(prev => !prev)}
                className="w-11 h-11 rounded-2xl bg-white/5 border border-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-all flex items-center justify-center"
                title={isModuleSidebarOpen ? 'Ocultar menu' : 'Mostrar menu'}
              >
                {isModuleSidebarOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />}
              </button>
              <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center">
                <Calculator className="text-white w-7 h-7" />
              </div>
              <div>
                <h1 className="text-xl font-black text-white">CIERRES 1.1</h1>
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.24em]">Plataforma administrativa</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => setShowPrintPreview(true)} className="p-3 bg-white/5 hover:bg-blue-500/10 text-slate-400 rounded-2xl border border-white/5"><Printer className="w-5 h-5" /></button>
              <button onClick={handleExportCSV} className="p-3 bg-white/5 hover:bg-emerald-500/10 text-slate-400 rounded-2xl border border-white/5"><Download className="w-5 h-5" /></button>
              <button onClick={logOut} className="p-3 bg-white/5 hover:bg-red-500/10 text-slate-400 rounded-2xl border border-white/5"><LogOut className="w-5 h-5" /></button>
            </div>
          </div>
        </header>

        <div className="w-full px-4 py-6 flex gap-6 relative">
          <AnimatePresence>
            {isModuleSidebarOpen && (
              <motion.aside
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 280 }}
                exit={{ opacity: 0, width: 0 }}
                className="sticky top-24 z-30 max-h-[calc(100vh-7rem)] shrink-0 overflow-hidden rounded-[2rem] border border-white/5 bg-[#1E293B]/95 backdrop-blur-xl shadow-2xl"
              >
                <div className="w-[280px] p-4">
                  <div className="px-2 pb-4 border-b border-white/5">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.28em]">Navegacion</p>
                    <h3 className="mt-2 text-lg font-black text-white">Modulos</h3>
                    <p className="mt-1 text-xs font-bold text-slate-400">Aqui iremos agregando nuevas areas administrativas.</p>
                  </div>
                  <div className="mt-4 space-y-2">
                    {adminModules.map(module => {
                      const isActive = activeModuleId === module.id;
                      return (
                        <button
                          key={module.id}
                          onClick={() => {
                            module.action();
                          }}
                          className={`w-full text-left rounded-2xl border px-3 py-3 transition-all ${isActive ? 'bg-white/10 border-white/15' : 'bg-white/[0.03] border-white/5 hover:bg-white/5 hover:border-white/10'}`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center ${module.iconColor}`}>
                              <module.Icon className="w-5 h-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-black text-white uppercase tracking-wide">{module.title}</p>
                              <p className="text-[11px] font-bold text-slate-400 truncate">{module.subtitle}</p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </motion.aside>
            )}
          </AnimatePresence>

          <main className="flex-1 min-w-0">
            {/* Success Feedback Notification */}
            {showSuccess && (
              <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in zoom-in slide-in-from-top-4 duration-300">
                <div className="bg-emerald-500 text-white px-8 py-4 rounded-[2rem] shadow-2xl flex items-center gap-4 border border-emerald-400/50">
                  <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center animate-bounce">
                    <Banknote className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="font-black text-sm uppercase tracking-widest">Registro Guardado!</p>
                    <p className="text-[10px] font-bold opacity-80 uppercase">El cierre se ha guardado correctamente</p>
                  </div>
                </div>
              </div>
            )}
            {/* Context Menu */}
            {contextMenu && (
              <div
                style={{ top: contextMenu.y, left: contextMenu.x }}
                className="fixed z-[200] bg-[#1E293B] border border-white/10 rounded-2xl shadow-2xl py-2 min-w-[200px] overflow-hidden backdrop-blur-xl"
                onClick={e => e.stopPropagation()}
              >
                <div className="px-4 py-2 border-b border-white/5 mb-2">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Acciones: {contextMenu.caja.toUpperCase()}</p>
                </div>
                <button
                  onClick={() => handleOpenAddMovement('outflow', contextMenu.caja)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-rose-500/20 hover:text-rose-400 transition-colors uppercase tracking-widest"
                >
                  <ArrowUpRight className="w-4 h-4" />
                  Registrar Gasto
                </button>
                {contextMenu.caja !== 'bank' && contextMenu.caja !== 'personal' && (
                  <button
                    onClick={() => handleOpenAddMovement('transfer', contextMenu.caja, 'bank')}
                    className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-emerald-500/20 hover:text-emerald-400 transition-colors uppercase tracking-widest"
                  >
                    <Building2 className="w-4 h-4" />
                    Enviar a Banco
                  </button>
                )}
                {contextMenu.caja !== 'transit' && (
                  <button
                    onClick={() => handleOpenAddMovement('internal_transfer', contextMenu.caja, 'transit')}
                    className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-amber-500/20 hover:text-amber-400 transition-colors uppercase tracking-widest"
                  >
                    <Truck className="w-4 h-4" />
                    Enviar a Transito
                  </button>
                )}
                {contextMenu.caja !== 'banquitos' && contextMenu.caja !== 'personal' && (
                  <button
                    onClick={() => handleOpenAddMovement('internal_transfer', contextMenu.caja, 'banquitos')}
                    className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-blue-500/20 hover:text-blue-400 transition-colors uppercase tracking-widest"
                  >
                    <DollarSign className="w-4 h-4" />
                    Enviar a Banquitos
                  </button>
                )}
                {contextMenu.caja !== 'personal' && (
                  <button
                    onClick={() => handleOpenAddMovement('internal_transfer', contextMenu.caja, 'personal')}
                    className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-purple-500/20 hover:text-purple-400 transition-colors uppercase tracking-widest"
                  >
                    <Wallet className="w-4 h-4" />
                    Enviar a Personal
                  </button>
                )}
                <button
                  onClick={() => handleOpenAddMovement('internal_transfer', contextMenu.caja)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-purple-500/20 hover:text-purple-400 transition-colors uppercase tracking-widest"
                >
                  <ArrowRightLeft className="w-4 h-4" />
                  Transferencia Interna
                </button>
              </div>
            )}

            {/* Movements Viewer Modal */}
            <AnimatePresence>
              {renderCashBoxStatementModal()}
              {false && viewingCajaMovements && (
              <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
                <motion.div
                  initial={{ opacity:0, y: 20 }}
                  animate={{ opacity:1, y: 0 }}
                  exit={{ opacity:0, y: 20 }}
                  className="w-full max-w-4xl bg-[#1E293B] rounded-[2.5rem] border border-white/5 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
                >
                  <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/2">
                    <div>
                      <h3 className="text-2xl font-black text-white uppercase tracking-tight flex items-center gap-3">
                        {viewingCajaMovements === 'safe' && <ShieldCheck className="w-8 h-8 text-blue-400" />}
                        {viewingCajaMovements === 'transit' && <Truck className="w-8 h-8 text-amber-400" />}
                        {viewingCajaMovements === 'bank' && <Building2 className="w-8 h-8 text-emerald-400" />}
                        {viewingCajaMovements === 'banquitos' && <DollarSign className="w-8 h-8 text-blue-400" />}
                        Movimientos: {viewingCajaMovements === 'safe' ? 'En Tienda' : viewingCajaMovements === 'transit' ? 'En Transito' : viewingCajaMovements === 'bank' ? 'Banco' : 'Banquitos'}
                      </h3>
                      <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">Historial detallado de transacciones</p>
                    </div>
                    <button
                      onClick={() => setViewingCajaMovements(null)}
                      className="w-12 h-12 flex items-center justify-center rounded-full bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all"
                    >
                      <X className="w-6 h-6" />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-8">
                    <div className="space-y-4">
                      {combinedMovements
                        .filter(m =>
                          (m.source === 'movement' && (m.from === viewingCajaMovements || m.to === viewingCajaMovements)) ||
                          (m.source === 'closure' && m.status === viewingCajaMovements && !m.tripId)
                        )
                        .map(m => (
                          <div key={`${m.source}-${m.id}`} className="group bg-white/2 hover:bg-white/5 p-6 rounded-3xl border border-white/5 transition-all flex items-center justify-between">
                            <div className="flex items-center gap-6">
                              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                                m.source === 'closure' ? 'bg-blue-500/20 text-blue-400' :
                                m.from === viewingCajaMovements ? 'bg-rose-500/20 text-rose-400' : 'bg-emerald-500/20 text-emerald-400'
                              }`}>
                                {m.source === 'closure' ? <DollarSign className="w-6 h-6" /> :
                                 m.from === viewingCajaMovements ? <ArrowUpRight className="w-6 h-6" /> : <ArrowDownLeft className="w-6 h-6" />}
                              </div>
                              <div>
                                <div className="flex items-center gap-3 mb-1">
                                  <p className="text-white font-black text-lg uppercase leading-tight">{m.description}</p>
                                  <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md ${
                                    m.source === 'closure' ? 'bg-blue-500/10 text-blue-500' :
                                    m.type === 'outflow' ? 'bg-rose-500/10 text-rose-500' :
                                    m.to === viewingCajaMovements ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                                  }`}>
                                    {m.source === 'closure' ? 'Cierre de Caja' :
                                     m.type === 'outflow' ? 'Gasto' :
                                     m.to === viewingCajaMovements ? 'Ingreso' : 'Salida'}
                                  </span>
                                </div>
                                <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
                                  <Calendar className="w-3 h-3" />
                                  {format(parseISO(m.date), 'dd MMMM yyyy, HH:mm', { locale: es })}
                                  {m.category && <span className="flex items-center gap-2 ml-2 opacity-60"><Tag className="w-3 h-3" /> {m.category}</span>}
                                  {m.subcategory && <span className="flex items-center gap-2 ml-2 opacity-60"><ChevronRight className="w-3 h-3" /> {m.subcategory}</span>}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-8">
                              <div className="text-right">
                                <p className={`text-2xl font-black font-sans leading-tight ${
                                  m.source === 'closure' ? 'text-blue-400' :
                                  m.from === viewingCajaMovements ? 'text-rose-400' : 'text-emerald-400'
                                }`}>
                                  {m.from === viewingCajaMovements ? '-' : '+'}${m.amount.toLocaleString('es-CL')}
                                </p>
                                <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest mt-1">
                                  {m.source === 'closure' ? `Responsable: ${m.responsible}` :
                                   m.from === viewingCajaMovements ? `Hacia: ${m.to || 'Gasto'}` : `Desde: ${m.from}`}
                                </p>
                              </div>
                              <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => {
                                    if (m.source === 'movement') {
                                      setMovementValues({
                                        ...m,
                                        date: m.date
                                      });
                                      setEditingMovementId(m.id);
                                      setIsAddingMovement(true);
                                    } else {
                                      // It's a closure
                                      const closure = closures.find(c => c.id === m.id);
                                      if (closure) {
                                        setInlineEditingId(closure.id!);
                                        setInlineEditValues({ ...closure });
                                        // We might need to scroll or highlight the closure in the main list
                                        // or provide a modal for editing closure from here
                                        setViewingCajaMovements(null);
                                      }
                                    }
                                  }}
                                  className="w-10 h-10 flex items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 hover:bg-blue-500 text-white transition-all"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => {
                                    if (m.source === 'movement') {
                                      handleDeleteMovement(m.id);
                                    } else {
                                      handleDelete(m.id);
                                    }
                                  }}
                                  className="w-10 h-10 flex items-center justify-center rounded-xl bg-rose-500/10 text-rose-400 hover:bg-rose-500 text-white transition-all"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}

                      {combinedMovements.filter(m =>
                        (m.source === 'movement' && (m.from === viewingCajaMovements || m.to === viewingCajaMovements)) ||
                        (m.source === 'closure' && m.status === viewingCajaMovements && !m.tripId)
                      ).length === 0 && (
                        <div className="py-20 text-center">
                          <History className="w-16 h-16 text-slate-800 mx-auto mb-4" />
                          <p className="text-slate-600 font-black uppercase tracking-widest">No hay movimientos registrados para esta caja</p>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-6 mb-12 text-left">
            <div
              onDoubleClick={() => setViewingCajaMovements('safe')}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, caja: 'safe' });
              }}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 relative overflow-hidden group cursor-pointer hover:border-blue-500/50 transition-colors"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <ShieldCheck className="w-16 h-16 text-blue-400" />
              </div>
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <ShieldCheck className="w-3 h-3 text-blue-400" />
                En Tienda
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedSafeTotal.toLocaleString('es-CL')}</p>
            </div>
            <div
              onDoubleClick={() => setViewingCajaMovements('transit')}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, caja: 'transit' });
              }}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 relative overflow-hidden group cursor-pointer hover:border-amber-500/50 transition-colors"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <Truck className="w-16 h-16 text-amber-400" />
              </div>
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Truck className="w-3 h-3 text-amber-400" />
                En Transito
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedTransitTotal.toLocaleString('es-CL')}</p>
            </div>
            <div
              onDoubleClick={() => setViewingCajaMovements('bank')}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, caja: 'bank' });
              }}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 relative overflow-hidden group cursor-pointer hover:border-emerald-500/50 transition-colors"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <Building2 className="w-16 h-16 text-emerald-400" />
              </div>
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Building2 className="w-3 h-3 text-emerald-400" />
                Banco
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedBankTotal.toLocaleString('es-CL')}</p>
            </div>
            <div
              onDoubleClick={() => setViewingCajaMovements('banquitos')}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, caja: 'banquitos' });
              }}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-blue-500/20 relative overflow-hidden group cursor-pointer hover:border-blue-500/50 transition-colors"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <DollarSign className="w-16 h-16 text-blue-400" />
              </div>
              <p className="text-xs font-black text-blue-400/70 uppercase tracking-widest mb-4 flex items-center gap-2">
                <DollarSign className="w-3 h-3 text-blue-400" />
                Banquitos
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedBanquitosTotal.toLocaleString('es-CL')}</p>
            </div>
            <div
              onDoubleClick={() => setHistoryView({ type: 'outflow', title: 'GASTOS TOTALES' })}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-rose-500/20 relative overflow-hidden group cursor-pointer hover:border-rose-500/50 transition-colors shadow-2xl"
              title="Doble clic para ver historial"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <TrendingDown className="w-16 h-16 text-rose-400" />
              </div>
              <p className="text-xs font-black text-rose-500/60 uppercase tracking-widest mb-4 flex items-center gap-2">
                <ArrowUpRight className="w-3 h-3" />
                GASTOS TOTALES
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedOutflowTotal.toLocaleString('es-CL')}</p>
              <p className="text-[10px] font-black text-rose-300/70 uppercase tracking-widest mt-2">Periodo: ${outflowPeriodLabel}</p>
              <div className="grid grid-cols-2 gap-2 mt-4 relative z-10">
                {[
                  { label: 'Este mes', value: 'este_mes' as const },
                  { label: 'Mes pasado', value: 'mes_pasado' as const },
                  { label: 'Anio actual', value: 'anio_actual' as const },
                  { label: 'Periodo', value: 'custom' as const },
                ].map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      option.value === 'custom' ? setOutflowPeriodType('custom') : applyOutflowPeriod(option.value);
                    }}
                    className={`min-h-[30px] rounded-lg border px-2 text-[9px] font-black uppercase tracking-widest transition-colors ${outflowPeriodType === option.value ? 'border-rose-500 bg-rose-500/15 text-rose-200' : 'border-white/10 bg-white/5 text-slate-500 hover:border-rose-500/40'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {outflowPeriodType === 'custom' && (
                <div className="grid grid-cols-2 gap-2 mt-3 relative z-10">
                  <input
                    type="date"
                    value={outflowStartDate}
                    onClick={(event) => event.stopPropagation()}
                    onChange={e => setOutflowStartDate(e.target.value)}
                    className="min-w-0 rounded-lg border border-white/10 bg-slate-950/50 px-2 py-2 text-[11px] font-bold text-slate-200 outline-none focus:border-rose-500"
                  />
                  <input
                    type="date"
                    value={outflowEndDate}
                    onClick={(event) => event.stopPropagation()}
                    onChange={e => setOutflowEndDate(e.target.value)}
                    className="min-w-0 rounded-lg border border-white/10 bg-slate-950/50 px-2 py-2 text-[11px] font-bold text-slate-200 outline-none focus:border-rose-500"
                  />
                </div>
              )}
            </div>
          </div>

          <AnimatePresence>
            {historyView && (
              <div className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md text-left">
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-[#0F172A] border border-white/10 rounded-[2.5rem] w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
                >
                  <div className="p-8 border-b border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-rose-500/10 rounded-2xl text-rose-500">
                        <TrendingDown className="w-6 h-6" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-black tracking-tight">{historyView.title}</h2>
                        <p className="text-slate-400 text-xs uppercase font-black tracking-widest">Historial completo detallado</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 flex-1 md:max-w-md">
                      <div className="relative flex-1">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                        <input
                          type="text"
                          placeholder="BUSCAR MOVIMIENTO..."
                          className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/5 rounded-xl text-xs font-black uppercase tracking-widest outline-none focus:ring-2 focus:ring-rose-500 transition-all"
                          onInput={(e) => {
                            const val = (e.target as HTMLInputElement).value.toLowerCase();
                            const items = document.querySelectorAll('.history-item');
                            items.forEach((item: any) => {
                              const text = item.innerText.toLowerCase();
                              item.style.display = text.includes(val) ? 'flex' : 'none';
                            });
                          }}
                        />
                      </div>
                      <button
                        onClick={() => setHistoryView(null)}
                        className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-all"
                      >
                        <X className="w-6 h-6" />
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-auto p-8 pt-4">
                    <div className="grid gap-8">
                      {Object.entries(
                        filteredOutflowMovements
                          .reduce((groups: Record<string, typeof filteredOutflowMovements>, m) => {
                            const date = format(parseISO(m.date), 'yyyy-MM-dd');
                            if (!groups[date]) groups[date] = [];
                            groups[date].push(m);
                            return groups;
                          }, {})
                      )
                      .sort((a, b) => b[0].localeCompare(a[0]))
                      .map(([date, dailyMovements]) => (
                        <div key={date} className="space-y-4">
                          <div className="flex items-center gap-4">
                            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] whitespace-nowrap">
                              {format(parseISO(date), 'EEEE dd MMMM, yyyy', { locale: es })}
                            </h3>
                            <div className="h-px bg-white/5 flex-1" />
                            <span className="text-[10px] font-black text-rose-500/50 bg-rose-500/5 px-3 py-1 rounded-full">
                              TOTAL DIA: ${dailyMovements.reduce((sum, m) => sum + m.amount, 0).toLocaleString('es-CL')}
                            </span>
                          </div>

                          <div className="grid gap-3">
                            {dailyMovements
                              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                              .map(m => (
                                <div key={m.id} className="history-item group bg-white/5 border border-white/5 hover:border-rose-500/30 hover:bg-rose-500/[0.02] rounded-3xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all text-left">
                                  <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-rose-500/10 rounded-xl flex items-center justify-center text-rose-500 group-hover:scale-110 transition-transform">
                                      <TrendingDown size={18} strokeWidth={3} />
                                    </div>
                                    <div>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                          {format(parseISO(m.date), 'HH:mm')} ⬢ {m.category || 'GENERAL'}
                                        </span>
                                        {m.from && (
                                          <span className="text-[9px] bg-white/10 text-slate-400 px-2 py-0.5 rounded-lg font-black tracking-widest uppercase">
                                            VIA: {m.from}
                                          </span>
                                        )}
                                        {m.subcategory && (
                                          <span className="text-[9px] bg-rose-500/10 text-rose-400 px-2 py-0.5 rounded-lg font-black tracking-widest uppercase">
                                            {m.subcategory}
                                          </span>
                                        )}
                                      </div>
                                      <h4 className="text-white font-black text-sm uppercase leading-tight">{m.description}</h4>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-lg font-black font-mono text-rose-500">-${m.amount.toLocaleString('es-CL')}</p>
                                    <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Id: {m.id.slice(0, 8)}</p>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}

                      {filteredOutflowMovements.length === 0 && (
                        <div className="text-center py-20 bg-white/5 rounded-[2rem] border border-dashed border-white/10">
                          <TrendingDown className="w-16 h-16 text-slate-800 mx-auto mb-4 opacity-20" />
                          <p className="text-slate-500 font-black uppercase tracking-widest text-xs">No hay movimientos registrados</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="p-6 border-t border-white/5 bg-white/[0.02] flex justify-between items-center px-10">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Monto Consolidado</span>
                    <span className="text-xl font-black font-mono text-rose-500">
                      -${filteredOutflowMovements.reduce((s, m) => s + m.amount, 0).toLocaleString('es-CL')}
                    </span>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <div className="flex flex-col lg:flex-row items-center justify-between gap-6 mb-8 text-left">
             <div className="flex-1">
              <h2 className="text-3xl font-black text-white mb-1 flex items-center gap-3"><History className="w-8 h-8 text-blue-500" /> Historial</h2>
              <p className="text-slate-500 text-sm">Registro de cierres contables.</p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mr-2">Periodo:</span>
              <button
                onClick={() => {
                  setFilterStartDate(format(subDays(new Date(), 7), 'yyyy-MM-dd'));
                  setFilterEndDate(format(new Date(), 'yyyy-MM-dd'));
                  setFilterDateRangeType('semana');
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterDateRangeType === 'semana' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                Semana
              </button>
              <button
                onClick={() => {
                  setFilterStartDate(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
                  setFilterEndDate(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
                  setFilterDateRangeType('mes');
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterDateRangeType === 'mes' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                Este Mes
              </button>
              <button
                onClick={() => {
                  setFilterDateRangeType('siempre');
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterDateRangeType === 'siempre' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                Siempre
              </button>
              <div className="h-8 w-[1px] bg-white/10 hidden sm:block" />
              <div className="flex items-center bg-[#1E293B] rounded-2xl border border-white/5 p-1">
                <input
                  type="date"
                  value={filterStartDate}
                  onChange={e => {
                    setFilterStartDate(e.target.value);
                    setFilterDateRangeType('custom');
                  }}
                  className="bg-transparent px-3 py-2 text-xs font-sans font-bold text-white outline-none"
                />
                <ArrowRight className="w-3 h-3 text-slate-600" />
                <input
                  type="date"
                  value={filterEndDate}
                  onChange={e => {
                    setFilterEndDate(e.target.value);
                    setFilterDateRangeType('custom');
                  }}
                  className="bg-transparent px-3 py-2 text-xs font-sans font-bold text-white outline-none"
                />
              </div>
              <select
                value={filterResponsible}
                onChange={e => setFilterResponsible(e.target.value)}
                className="bg-[#1E293B] border border-white/5 rounded-2xl px-4 py-3 text-xs font-black text-white outline-none appearance-none cursor-pointer"
              >
                <option value="all">Todos los Responsables</option>
                {uniqueResponsibles.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="bg-[#1E293B] border border-white/5 rounded-2xl px-4 py-3 text-xs font-black text-white outline-none appearance-none cursor-pointer"
              >
                <option value="all">Todos los Estados</option>
                <option value="safe">En Tienda</option>
                <option value="transit">En Transito</option>
                <option value="bank">En Banco</option>
                <option value="banquitos">En Banquitos</option>
              </select>
              <select
                value={filterAudit}
                onChange={e => setFilterAudit(e.target.value as ClosureAuditStatus)}
                className="bg-[#1E293B] border border-white/5 rounded-2xl px-4 py-3 text-xs font-black text-white outline-none appearance-none cursor-pointer"
              >
                <option value="all">Toda Auditoria</option>
                <option value="difference">Con Diferencia</option>
                <option value="pending_report">Falta Venta Sistema</option>
                <option value="matched">Auditado OK</option>
                <option value="not_audited">Sin Auditoria</option>
              </select>
              <button
                onClick={() => setHideCollected(!hideCollected)}
                className={`flex items-center gap-2 px-4 py-3 rounded-2xl border transition-all ${hideCollected ? 'bg-amber-500/10 border-amber-500/50 text-amber-500' : 'bg-white/5 border-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                <div className={`w-4 h-4 rounded-md border flex items-center justify-center ${hideCollected ? 'bg-amber-500 border-amber-500' : 'border-slate-600'}`}>
                  {hideCollected && <Check className="w-3 h-3 text-slate-950 font-black" />}
                </div>
                <span className="text-[10px] font-black uppercase tracking-widest whitespace-nowrap">Ocultar recolectados</span>
              </button>
              <button
                onClick={() => setShowOnlyStoreClosures(!showOnlyStoreClosures)}
                className={`flex items-center gap-2 px-4 py-3 rounded-2xl border transition-all ${showOnlyStoreClosures ? 'bg-blue-500/10 border-blue-500/50 text-blue-400' : 'bg-white/5 border-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                <div className={`w-4 h-4 rounded-md border flex items-center justify-center ${showOnlyStoreClosures ? 'bg-blue-500 border-blue-500' : 'border-slate-600'}`}>
                  {showOnlyStoreClosures && <Check className="w-3 h-3 text-slate-950 font-black" />}
                </div>
                <span className="text-[10px] font-black uppercase tracking-widest whitespace-nowrap">Solo en tienda</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row items-center justify-between gap-6 mb-8 text-left">
            <div className="flex-1">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-white/5 p-2 rounded-[2rem] w-full lg:w-fit">
                 <div className="relative flex-1 sm:flex-none">
                   <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                   <input
                     type="text"
                     placeholder="Buscar en todas las columnas..."
                     value={searchTerm}
                     onChange={e => setSearchTerm(e.target.value)}
                     className="pl-12 pr-6 py-3 bg-white/5 rounded-2xl outline-none text-white w-full sm:w-96 text-sm"
                   />
                 </div>
                 {(searchTerm || activeColumnFilterCount > 0) && (
                   <button
                     type="button"
                     onClick={() => {
                       setSearchTerm('');
                       clearAllColumnFilters();
                     }}
                     className="px-4 py-3 rounded-2xl bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 text-[10px] font-black uppercase tracking-widest transition-all"
                   >
                     Limpiar filtros{activeColumnFilterCount > 0 ? ` (${activeColumnFilterCount})` : ''}
                   </button>
                 )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <button
                onClick={() => {
                  if (!isInlineAdding && !inlineAddValues.date) {
                    // Only set current time if no date is preserved
                    setInlineAddValues(v => ({ ...v, date: new Date().toISOString() }));
                  }
                  setIsInlineAdding(!isInlineAdding);
                }}
                className={`px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-lg ${isInlineAdding ? 'bg-slate-700 text-white shadow-slate-500/20' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/20'}`}
              >
                {isInlineAdding ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                {isInlineAdding ? 'Cancelar Registro' : 'Registrar Cierre'}
              </button>
              <button onClick={() => setIsCreatingTrip(true)} className="bg-amber-600 hover:bg-amber-500 text-white px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-amber-500/20 shadow-lg">
                <Truck className="w-5 h-5" />
                Retiro / Viaje
              </button>
              <button onClick={() => openMovementForm('outflow')} className="bg-rose-600 hover:bg-rose-500 text-white px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-rose-500/20 shadow-lg"><ArrowUpRight className="w-5 h-5" /> Gasto / Salida</button>
              <button onClick={() => openMovementForm('internal_transfer')} className="bg-purple-600 hover:bg-purple-500 text-white px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-purple-500/20 shadow-lg"><ArrowRightLeft className="w-5 h-5" /> Traspaso Interno</button>
            </div>
          </div>

          <div className="bg-[#1E293B] rounded-[2.5rem] shadow-2xl border border-white/5 overflow-hidden">
            <div className="overflow-x-auto text-left">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#1D283A] border-b border-white/5 align-top">
                    {closureTableColumnOrder.map(renderDraggableClosureHeader)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {isInlineAdding && (
                    <tr className="bg-blue-950/20 border-y-2 border-blue-500/30">
                      {closureTableColumnOrder.map(renderInlineAddCell)}
                    </tr>
                  )}
                  {groupedClosures.map(group => (
                    <React.Fragment key={group.date}>
                      <tr onClick={() => toggleDay(group.date)} className="bg-white/[0.03] cursor-pointer hover:bg-white/[0.06] transition-colors border-y border-white/5">
                        {closureTableColumnOrder.map(column => renderGroupSummaryCell(group, column))}
                      </tr>
                      {expandedDays[group.date] && group.items.map(closure => (
                        inlineEditingId === closure.id ? (
                          <tr key={closure.id} className="bg-blue-950/30 border-y border-blue-500/20">
                            {closureTableColumnOrder.map(renderInlineEditCell)}
                          </tr>
                        ) : (
                          <tr key={closure.id} className="hover:bg-white/[0.02] border-b border-white/5 group">
                            {closureTableColumnOrder.map(column => renderClosureCell(closure, column))}
                          </tr>
                        )
                      ))}
                      {expandedDays[group.date] && group.missingRows.map(row => (
                        <tr key={`missing-${row.key}`} className="bg-amber-500/[0.04] border-b border-amber-500/10">
                          {closureTableColumnOrder.map(column => renderMissingRowCell(row, column))}
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>

        <AnimatePresence>
          {selectedTripClosures.length > 0 && (
            <motion.div initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }} className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl px-4 text-left">
              <div className="bg-[#1E293B]/90 backdrop-blur-xl border border-blue-500/30 rounded-[2rem] p-4 shadow-2xl flex items-center justify-between">
                <div className="pl-4">
                  <p className="text-sm font-black text-white">{selectedTripClosures.length} Cierres Seleccionados</p>
                  <p className="text-xs text-slate-400">Total: ${selectedTripClosures.reduce((a,b) => a + b.physicalAmount, 0).toLocaleString('es-CL')}</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setSelectedClosures(new Set())} className="px-4 py-2 text-slate-400 text-xs font-black uppercase">Cancelar</button>
                  <button onClick={() => setIsCreatingTrip(true)} className="bg-blue-600 text-white px-6 py-3 rounded-xl font-black text-xs uppercase flex items-center gap-2"><Truck className="w-4 h-4" /> Registrar Viaje</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isCreatingTrip && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
              <motion.div initial={{ opacity:0, scale:0.9 }} animate={{ opacity:1, scale:1 }} className="w-full max-w-xl bg-[#1E293B] p-8 rounded-[2.5rem] border border-blue-500/20 shadow-2xl">
                <div className="flex justify-between items-center mb-8">
                  <h3 className="text-2xl font-black text-white flex items-center gap-3"><Truck className="text-blue-400 w-8 h-8" /> Nuevo Registro de Viaje</h3>
                  <button onClick={() => setIsCreatingTrip(false)} className="p-2 hover:bg-white/5 rounded-full"><X className="w-6 h-6 text-slate-500" /></button>
                </div>

                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Fecha Inicio</label>
                      <input
                        type="date"
                        value={tripFormValues.startDate}
                        onChange={e => setTripFormValues({...tripFormValues, startDate: e.target.value})}
                        className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Fecha Fin</label>
                      <input
                        type="date"
                        value={tripFormValues.endDate}
                        onChange={e => setTripFormValues({...tripFormValues, endDate: e.target.value})}
                        className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Nombre / Descripcion del Viaje</label>
                    <input
                      type="text"
                      value={tripFormValues.description}
                      onChange={e => setTripFormValues({...tripFormValues, description: e.target.value})}
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Ej: Viaje Santiago - Semana 42"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Observaciones y Detalles</label>
                    <textarea
                      value={tripFormValues.notes}
                      onChange={e => setTripFormValues({...tripFormValues, notes: e.target.value})}
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500 min-h-[120px] resize-none"
                      placeholder="Agrega aqui cualquier observacion relevante sobre este retiro de fondos..."
                    />
                  </div>

                  {/* Summary Preview */}
                  <div className="bg-blue-500/5 border border-blue-500/10 rounded-3xl p-6">
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Cierres a incluir</p>
                        <p className="text-xl font-black text-white">
                            {selectedTripClosures.length > 0
                              ? selectedTripClosures.length
                            : closures.filter(c => {
                                const d = parseISO(c.date);
                                return isClosureAvailableForTrip(c) && isWithinInterval(d, {
                                  start: startOfDay(parseISO(tripFormValues.startDate)),
                                  end: endOfDay(parseISO(tripFormValues.endDate))
                                });
                              }).length
                          } registros
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Total Estimado</p>
                        <p className="text-xl font-black text-white font-sans">
                          ${(selectedTripClosures.length > 0
                            ? selectedTripClosures.reduce((a,b) => a + b.physicalAmount, 0)
                            : closures.filter(c => {
                                const d = parseISO(c.date);
                                return isClosureAvailableForTrip(c) && isWithinInterval(d, {
                                  start: startOfDay(parseISO(tripFormValues.startDate)),
                                  end: endOfDay(parseISO(tripFormValues.endDate))
                                });
                              }).reduce((a,b) => a + b.physicalAmount, 0)
                          ).toLocaleString('es-CL')}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4 pt-4">
                    <button onClick={() => setIsCreatingTrip(false)} className="flex-1 py-4 text-slate-400 font-black hover:text-white transition-colors">Cancelar</button>
                    <button
                      onClick={handleCreateTrip}
                      disabled={!tripFormValues.description || isTripLoading}
                      className="flex-[2] bg-blue-600 hover:bg-blue-500 text-white py-4 rounded-2xl font-black shadow-xl shadow-blue-500/20 disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                    >
                      {isTripLoading ? (
                        <>
                          <RefreshCw className="w-5 h-5 animate-spin" />
                          Procesando...
                        </>
                      ) : (
                        <>
                          <Check className="w-5 h-5" />
                          Confirmar y Registrar Viaje
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {viewingTripId && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
              <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} className="w-full max-w-4xl bg-[#1E293B] rounded-[2.5rem] border border-white/5 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                 {viewingTripId === 'LIST' ? (
                   <div className="p-8">
                     <div className="flex justify-between mb-8"><div><h3 className="text-2xl font-black text-white uppercase tracking-tight">Registro de Viajes</h3><p className="text-slate-500 text-sm">Historial completo de recolecciones.</p></div><button onClick={() => setViewingTripId(null)} className="p-2 hover:bg-white/5 rounded-full transition-colors"><X className="w-6 h-6 text-slate-500" /></button></div>
                     <div className="space-y-4 pr-2 overflow-y-auto max-h-[60vh]">
                       {trips.length === 0 ? (
                         <div className="text-center py-20 bg-white/5 rounded-[2rem] border border-dashed border-white/10">
                           <Truck className="w-12 h-12 text-slate-600 mx-auto mb-4 opacity-20" />
                           <p className="text-slate-500 font-black uppercase tracking-widest text-xs">No hay viajes registrados</p>
                         </div>
                       ) : trips.map(trip => (
                         <div key={trip.id} onClick={() => setViewingTripId(trip.id!)} className="p-6 bg-white/5 rounded-3xl flex justify-between items-center cursor-pointer hover:bg-white/10 transition-all border border-white/5 group">
                           <div className="flex items-center gap-6">
                             <div className={`p-4 rounded-2xl ${trip.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                               <Truck className="w-6 h-6" />
                             </div>
                             <div>
                               <h4 className="font-black text-white text-lg group-hover:text-blue-400 transition-colors uppercase tracking-tight">{trip.description}</h4>
                               <div className="flex items-center gap-2 text-xs text-slate-500 font-bold uppercase tracking-widest mt-1">
                                 <Calendar className="w-3 h-3" />
                                 {format(parseISO(trip.startDate), 'dd MMMM yyyy', { locale: es })}
                               </div>
                             </div>
                           </div>
                           <div className="text-right">
                             <p className="text-xl font-black text-white font-sans tracking-tight">${trip.totalAmount.toLocaleString('es-CL')}</p>
                             <span className={`text-[8px] font-black uppercase tracking-widest px-3 py-1 rounded-full mt-2 inline-block ${trip.status === 'completed' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500 animate-pulse'}`}>
                               {trip.status === 'completed' ? 'Depositado' : 'En Transito'}
                             </span>
                           </div>
                         </div>
                       ))}
                     </div>
                   </div>
                 ) : (() => {
                   const trip = trips.find(t => t.id === viewingTripId);
                   if (!trip) return null;
                   const tClosures = closures.filter(c => c.tripId === trip.id);
                   return (
                     <div className="flex flex-col h-full">
                       <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                         <div className="flex items-center gap-4">
                           <button onClick={() => setViewingTripId('LIST')} className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-all border border-white/5"><ChevronLeft /></button>
                           <div>
                             <h3 className="text-2xl font-black text-white uppercase tracking-tight">{trip.description}</h3>
                             <p className="text-xs text-blue-400 font-black uppercase tracking-widest mt-1">{format(parseISO(trip.startDate), 'dd MMMM yyyy', { locale: es })}</p>
                           </div>
                         </div>
                         <div className="flex gap-3">
                           {trip.status === 'in_transit' && (
                             <button onClick={() => handleCompleteTrip(trip.id!)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2">
                               <CheckCircle2 className="w-4 h-4" />
                               Confirmar Deposito
                             </button>
                           )}
                           <button onClick={() => setViewingTripId(null)} className="p-3 bg-white/5 hover:bg-rose-500/20 text-slate-500 hover:text-rose-500 rounded-2xl transition-all"><X className="w-6 h-6" /></button>
                         </div>
                       </div>
                       <div className="p-8 overflow-y-auto space-y-8 bg-[#0F172A]/50">
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                           <div className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                             <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Monto Total Recolectado</p>
                             <p className="text-4xl font-black text-white font-sans tracking-tight">${trip.totalAmount.toLocaleString('es-CL')}</p>
                           </div>
                           <div className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                             <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Estado del Retiro</p>
                             <div className="flex items-center gap-3">
                               <div className={`p-2 rounded-xl ${trip.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                                 {trip.status === 'completed' ? <Building2 className="w-6 h-6" /> : <Truck className="w-6 h-6" />}
                               </div>
                               <p className={`text-lg font-black uppercase tracking-tight ${trip.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'}`}>
                                 {trip.status === 'completed' ? 'Depositado en Banco' : 'En Manos del Recolector'}
                               </p>
                             </div>
                           </div>
                         </div>

                         <div className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                            <div className="flex justify-between items-center mb-6">
                              <h4 className="text-sm font-black text-white uppercase tracking-widest flex items-center gap-2">
                                <MessageSquare className="w-4 h-4 text-blue-400" />
                                Observaciones del Viaje
                              </h4>
                              {!isEditingTripNotes ? (
                                <button
                                  onClick={() => {
                                    setIsEditingTripNotes(true);
                                    setEditedTripNotes(trip.notes || '');
                                  }}
                                  className="text-[10px] font-black text-blue-400 uppercase tracking-widest hover:text-blue-300 transition-colors"
                                >
                                  Editar Notas
                                </button>
                              ) : (
                                <div className="flex gap-4">
                                  <button
                                    onClick={() => handleSaveTripNotes(trip.id!)}
                                    className="text-[10px] font-black text-emerald-400 uppercase tracking-widest hover:text-emerald-300 transition-colors"
                                  >
                                    Guardar
                                  </button>
                                  <button
                                    onClick={() => setIsEditingTripNotes(false)}
                                    className="text-[10px] font-black text-rose-400 uppercase tracking-widest hover:text-rose-300 transition-colors"
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className="bg-white/5 p-6 rounded-3xl border border-white/5">
                              {isEditingTripNotes ? (
                                <textarea
                                  value={editedTripNotes}
                                  onChange={e => setEditedTripNotes(e.target.value)}
                                  className="w-full bg-transparent outline-none text-white text-sm leading-relaxed min-h-[100px] resize-none"
                                  placeholder="Escribe tus observaciones aqui..."
                                  autoFocus
                                />
                              ) : (
                                trip.notes ? (
                                  <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{trip.notes}</p>
                                ) : (
                                  <p className="text-slate-500 text-sm italic py-4">Sin observaciones registradas por el momento.</p>
                                )
                              )}
                            </div>
                         </div>

                         <div className="space-y-4">
                            <h4 className="text-sm font-black text-slate-500 uppercase tracking-widest px-2">Desglose de Cierres ({tClosures.length})</h4>
                            <div className="grid grid-cols-1 gap-3">
                              {tClosures.sort((a,b) => b.date.localeCompare(a.date)).map(c => (
                                <div key={c.id} className="p-6 bg-[#1E293B] rounded-3xl flex justify-between items-center border border-white/5 hover:bg-white/[0.03] transition-all">
                                  <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-slate-500">
                                      <Calendar className="w-4 h-4" />
                                    </div>
                                    <div>
                                      <p className="font-black text-white text-base uppercase tracking-tight">{format(parseISO(c.date), 'EEEE dd MMM', { locale: es })}</p>
                                      <div className="flex items-center gap-2 mt-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">{c.responsible}</p>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="font-black text-white font-sans text-xl tracking-tight">${c.physicalAmount.toLocaleString('es-CL')}</p>
                                    <div className="flex items-center gap-1 justify-end mt-1 text-[10px] font-black text-slate-600 uppercase tracking-widest">
                                      <RefreshCw className="w-3 h-3" />
                                      {format(parseISO(c.date), 'HH:mm')}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                         </div>

                         <div className="pt-10 flex justify-center">
                           <button onClick={() => handleDeleteTrip(trip.id!)} className="px-6 py-3 rounded-2xl bg-rose-500/10 text-rose-500 text-xs font-black uppercase tracking-widest hover:bg-rose-500 hover:text-white transition-all flex items-center gap-2">
                             <Trash2 className="w-4 h-4" />
                             Eliminar Registro del Viaje
                           </button>
                         </div>
                       </div>
                     </div>
                   );
                 })()}
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <div className={`fixed inset-0 bg-[#F8FAFC] text-slate-900 z-[9999] overflow-auto ${showPrintPreview ? 'block' : 'hidden'} print:block`}>
           <div className="p-8 flex justify-between bg-[#0F172A] text-white print:hidden items-center">
             <div className="flex items-center gap-4">
               <div className="p-3 bg-blue-600 rounded-2xl">
                 <Printer className="w-6 h-6" />
               </div>
               <div>
                  <h3 className="text-xl font-black uppercase tracking-tight">Previsualizacion de Reporte</h3>
                  <p className="text-slate-400 text-xs uppercase tracking-widest">{format(new Date(), "EEEE dd 'de' MMMM", { locale: es })}</p>
               </div>
             </div>
             <div className="flex gap-4">
               <button onClick={handleDownload} className="bg-white text-[#0F172A] hover:bg-slate-100 px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-lg flex items-center gap-2">
                 <Download className="w-4 h-4" />
                 Descargar PDF
               </button>
               <button onClick={() => setShowPrintPreview(false)} className="bg-rose-600 hover:bg-rose-500 text-white px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-lg flex items-center gap-2">
                 <X className="w-4 h-4" />
                 Cerrar Preview
               </button>
             </div>
           </div>

           <div ref={reportRef} className="max-w-[210mm] mx-auto bg-white p-16 shadow-2xl min-h-screen">
              {/* Report Header */}
              <div className="flex justify-between items-start border-b-4 border-slate-950 pb-10 mb-12">
                <div>
                  <h1 className="text-5xl font-black text-slate-950 mb-2 font-sans">REPORTE DE CIERRES</h1>
                  <p className="text-slate-500 font-sans font-black tracking-widest text-sm uppercase">Consolidado de Operaciones ⬢ Sistema 1.1</p>
                  <p className="text-slate-500 text-xs mt-4 uppercase font-bold tracking-widest flex items-center gap-2">
                    <Calendar className="w-3 h-3" />
                    Periodo: {format(parseISO(filterStartDate), 'dd/MM/yyyy')} - {format(parseISO(filterEndDate), 'dd/MM/yyyy')}
                  </p>
                </div>
                <div className="text-right">
                  <div className="bg-slate-950 text-white p-4 rounded-2xl mb-4">
                    <p className="text-[10px] font-black tracking-widest mb-1 uppercase opacity-60">Total Consolidado</p>
                    <p className="text-2xl font-black font-sans">${groupedClosures.reduce((a, b) => a + b.totals.physicalAmount, 0).toLocaleString('es-CL')}</p>
                  </div>
                  <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">Generado por</p>
                  <p className="text-slate-900 text-xs font-black uppercase">{user.displayName || user.email}</p>
                </div>
              </div>

              {/* Summary Sections */}
              <div className="grid grid-cols-3 gap-8 mb-12">
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Recaudado</p>
                  <p className="text-3xl font-black text-slate-950 font-sans">${groupedClosures.reduce((a,b) => a+b.totals.physicalAmount, 0).toLocaleString('es-CL')}</p>
                </div>
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Diferencias</p>
                  <p className={`text-3xl font-black font-sans ${groupedClosures.reduce((a,b) => a+b.totals.difference, 0) < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                    ${groupedClosures.reduce((a,b) => a+b.totals.difference, 0).toLocaleString('es-CL')}
                  </p>
                </div>
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cant. Registros</p>
                  <p className="text-3xl font-black text-slate-950 font-sans">{filteredClosures.length}</p>
                </div>
              </div>

              {/* Data Table */}
              <div className="space-y-12">
                {groupedClosures.map(group => (
                  <div key={group.date} className="page-break-inside-avoid">
                    <div className="flex items-center justify-between border-b-2 border-slate-200 pb-2 mb-4">
                      <h3 className="text-lg font-black text-slate-950 uppercase tracking-tight">
                        {format(parseISO(group.date), 'EEEE dd MMMM yyyy', { locale: es })}
                      </h3>
                      <div className="text-right">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-4">Total Dia</span>
                        <span className="text-lg font-black text-slate-950 font-sans">${group.totals.physicalAmount.toLocaleString('es-CL')}</span>
                      </div>
                    </div>

                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-500 font-black text-[10px] uppercase tracking-widest text-left border-b border-slate-100">
                          <th className="py-4">Hora</th>
                          <th className="py-4">Responsable</th>
                          <th className="py-4 text-right">Monto Fisico</th>
                          <th className="py-4 text-right">Diferencia</th>
                          <th className="py-4 text-center">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map(item => (
                          <tr key={item.id} className="border-b border-slate-50 text-slate-700">
                            <td className="py-4 font-sans font-bold text-slate-500">{format(parseISO(item.date), 'HH:mm')}</td>
                            <td className="py-4 font-black text-slate-900 uppercase text-xs">{item.responsible}</td>
                            <td className="py-4 text-right font-black font-sans text-slate-950">${item.physicalAmount.toLocaleString('es-CL')}</td>
                            <td className={`py-4 text-right font-black font-sans ${item.difference < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                              ${item.difference.toLocaleString('es-CL')}
                            </td>
                            <td className="py-4 text-center">
                              <span className="text-[8px] font-black uppercase tracking-widest bg-slate-100 px-2 py-1 rounded">
                                {(() => {
                                  const itemStatus = getClosureDisplayStatus(item);
                                  return itemStatus === 'bank' ? 'En Banco' : itemStatus === 'transit' ? 'Transito' : itemStatus === 'banquitos' ? 'Banquitos' : 'En Tienda';
                                })()}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="mt-20 pt-10 border-t border-slate-200 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Fin del Reporte - Registro de Auditoria: {new Date().getTime()}</p>
                <div className="mt-8 flex justify-center gap-20">
                  <div className="w-48 border-t border-slate-300 pt-2">
                    <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Firma Responsable</p>
                  </div>
                  <div className="w-48 border-t border-slate-300 pt-2">
                    <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Firma Revision</p>
                  </div>
                </div>
              </div>
           </div>
        </div>
      </div>

       <AnimatePresence>
          {isAddingMovement && (
            <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
              <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-[#1E293B] p-8 rounded-[2.5rem] border border-purple-500/20 shadow-2xl">
                <h3 className="text-xl font-black text-white mb-6 uppercase tracking-tight">Movimiento de Caja</h3>
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <button onClick={() => setMovementValues(getMovementDefaults('outflow', movementValues.from, movementValues))} className={`py-4 rounded-2xl font-black text-[10px] uppercase transition-all ${movementValues.type === 'outflow' ? 'bg-rose-600 text-white shadow-lg shadow-rose-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}>Gasto</button>
                    <button onClick={() => setMovementValues(getMovementDefaults('transfer', movementValues.from, movementValues))} className={`py-4 rounded-2xl font-black text-[10px] uppercase transition-all ${movementValues.type === 'transfer' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}>Banco</button>
                    <button onClick={() => setMovementValues(getMovementDefaults('internal_transfer', movementValues.from, movementValues))} className={`py-4 rounded-2xl font-black text-[10px] uppercase transition-all ${movementValues.type === 'internal_transfer' ? 'bg-amber-600 text-white shadow-lg shadow-amber-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}>Interno</button>
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Fecha del Movimiento</label>
                    <input
                      type="datetime-local"
                      value={movementValues.date ? format(parseISO(movementValues.date), "yyyy-MM-dd'T'HH:mm") : format(new Date(), "yyyy-MM-dd'T'HH:mm")}
                      onChange={e => {
                        const selectedDate = e.target.value ? new Date(e.target.value) : new Date();
                        setMovementValues({
                          ...movementValues,
                          date: selectedDate.toISOString()
                        });
                      }}
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white font-sans text-sm outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <p className="mt-2 text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                      Esta fecha sera usada para ordenar el movimiento y afectar el estado del dinero.
                    </p>
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Monto</label>
                    <input
                      type="number"
                      min="0"
                      inputMode="decimal"
                      value={movementValues.amount || ''}
                      onFocus={e => e.target.select()}
                      onKeyDown={e => ['-', '+', 'e', 'E'].includes(e.key) && e.preventDefault()}
                      onChange={e => setMovementValues({...movementValues, amount: toNonNegativeNumber(e.target.value)})}
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white font-sans text-2xl outline-none focus:ring-2 focus:ring-purple-500"
                      placeholder="0"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">
                      {movementValues.type === 'outflow' ? 'Descripcion inteligente' : 'Descripcion'}
                    </label>
                    <input
                      type="text"
                      value={movementValues.description}
                      onChange={e => {
                        const description = e.target.value;
                        if (movementValues.type === 'outflow') {
                          applySmartExpenseDescription(description);
                        } else {
                          setMovementValues({...movementValues, description});
                        }
                      }}
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-purple-500"
                      placeholder="Ej: Pago de flete, sueldo, internet..."
                    />
                    {movementValues.type === 'outflow' && movementValues.description && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className="px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-[10px] font-black uppercase tracking-widest">
                          {movementValues.category || 'Otros'}
                        </span>
                        {movementValues.subcategory && (
                          <span className="px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] font-black uppercase tracking-widest">
                            {movementValues.subcategory}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {(movementValues.type === 'transfer' || movementValues.type === 'internal_transfer') && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Origen</label>
                        <select
                          value={movementValues.from || ''}
                          onChange={e => setMovementValues({
                            ...movementValues,
                            from: e.target.value,
                            to: movementValues.type === 'transfer'
                              ? 'bank'
                              : movementValues.to === e.target.value
                                ? ''
                                : movementValues.to
                          })}
                          className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                        >
                          <option value="safe" className="bg-[#0F172A] text-white">En Tienda</option>
                          <option value="transit" className="bg-[#0F172A] text-white">En Transito</option>
                          {movementValues.type === 'internal_transfer' && (
                            <>
                              <option value="bank" className="bg-[#0F172A] text-white">Banco</option>
                              <option value="banquitos" className="bg-[#0F172A] text-white">Banquitos</option>
                              <option value="personal" className="bg-[#0F172A] text-white">Caja Personal</option>
                            </>
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Destino</label>
                        {movementValues.type === 'transfer' ? (
                          <div className="w-full px-4 py-3 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl text-emerald-400 text-xs font-black uppercase">
                            Banco
                          </div>
                        ) : (
                          <select
                            value={movementValues.to || ''}
                            onChange={e => setMovementValues({...movementValues, to: e.target.value})}
                            className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                          >
                            <option value="safe" className="bg-[#0F172A] text-white">En Tienda</option>
                            <option value="transit" className="bg-[#0F172A] text-white">En Transito</option>
                            <option value="bank" className="bg-[#0F172A] text-white">Banco</option>
                            <option value="banquitos" className="bg-[#0F172A] text-white">Banquitos</option>
                            <option value="personal" className="bg-[#0F172A] text-white">Caja Personal</option>
                          </select>
                        )}
                      </div>
                    </div>
                  )}

                  {movementValues.type === 'outflow' && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Pagar desde</label>
                          <select
                            value={movementValues.from || 'safe'}
                            onChange={e => setMovementValues({...movementValues, from: e.target.value})}
                            className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                          >
                            <option value="safe" className="bg-[#0F172A] text-white">En Tienda</option>
                            <option value="transit" className="bg-[#0F172A] text-white">En Transito</option>
                            <option value="bank" className="bg-[#0F172A] text-white">Banco</option>
                            <option value="banquitos" className="bg-[#0F172A] text-white">Banquitos</option>
                            <option value="personal" className="bg-[#0F172A] text-white">Caja Personal</option>
                          </select>
                        </div>
                        <div>
                          <div className="flex justify-between mb-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">Categoria</label>
                            <button
                              onClick={() => setIsAddingNewCategory(!isAddingNewCategory)}
                              className="text-[10px] font-black text-purple-400 uppercase tracking-widest flex items-center gap-1 hover:text-purple-300 transition-colors"
                            >
                              <Plus className="w-3 h-3" /> {isAddingNewCategory ? 'Cerrar' : 'Nueva'}
                            </button>
                          </div>
                          {isAddingNewCategory ? (
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={newCategoryName}
                                onChange={e => setNewCategoryName(e.target.value.toUpperCase())}
                                placeholder="NOMBRE"
                                className="flex-1 px-3 py-2 bg-white/10 border border-white/5 rounded-xl text-white text-xs font-black outline-none"
                              />
                              <button
                                onClick={handleAddCategory}
                                className="bg-purple-600 p-2 rounded-xl text-white"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <select
                              value={movementValues.category || 'Sueldos'}
                              onChange={e => setMovementValues({...movementValues, category: e.target.value})}
                              className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                            >
                              {Array.from(new Set([...categories, movementValues.category || ''].filter(Boolean))).map(c => <option key={c} value={c} className="bg-[#0F172A] text-white">{c}</option>)}
                            </select>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between mb-2">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">Subcategoria</label>
                          <button
                            onClick={() => setIsAddingNewSubcategory(!isAddingNewSubcategory)}
                            className="text-[10px] font-black text-purple-400 uppercase tracking-widest flex items-center gap-1 hover:text-purple-300 transition-colors"
                          >
                            <Plus className="w-3 h-3" /> {isAddingNewSubcategory ? 'Cerrar' : 'Nueva'}
                          </button>
                        </div>
                        {isAddingNewSubcategory ? (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={newSubcategoryName}
                              onChange={e => setNewSubcategoryName(e.target.value.toUpperCase())}
                              placeholder="SUB NOMBRE"
                              className="flex-1 px-3 py-2 bg-white/10 border border-white/5 rounded-xl text-white text-xs font-black outline-none"
                            />
                            <button
                              onClick={handleAddSubcategory}
                              className="bg-purple-600 p-2 rounded-xl text-white"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <select
                            value={movementValues.subcategory || ''}
                            onChange={e => setMovementValues({...movementValues, subcategory: e.target.value})}
                            className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                          >
                            <option value="" className="bg-[#0F172A] text-slate-500">SIN SUBCATEGORIA</option>
                            {Array.from(new Set([...subcategories, movementValues.subcategory || ''].filter(Boolean))).map(s => <option key={s} value={s} className="bg-[#0F172A] text-white">{s}</option>)}
                          </select>
                        )}
                      </div>

                      {(movementValues.category || '').toLowerCase() === 'sueldos' && (
                        <button
                          onClick={() => {
                            setIsAddingMovement(false);
                            setCurrentView('payroll');
                          }}
                          className="w-full flex items-center justify-center gap-2 rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-blue-200"
                        >
                          <Users className="w-4 h-4" />
                          Abrir modulo de pago al personal
                        </button>
                      )}

                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Etiquetas para reportes</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={newExpenseTag}
                            onChange={e => setNewExpenseTag(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addExpenseTag();
                              }
                            }}
                            placeholder="Ej: OPERACION, FIJO, BANCO"
                            className="flex-1 px-4 py-3 bg-white/5 border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                          />
                          <button onClick={addExpenseTag} className="px-4 py-3 bg-purple-600 rounded-2xl text-white">
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(movementValues.tags || []).map(tag => (
                            <button
                              key={tag}
                              onClick={() => removeExpenseTag(tag)}
                              className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-slate-300 text-[10px] font-black uppercase tracking-widest hover:border-rose-500/40 hover:text-rose-300 transition-colors"
                            >
                              {tag} x
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {formError && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl"
                    >
                      <p className="text-rose-500 text-[10px] font-black uppercase tracking-widest text-center">{formError}</p>
                    </motion.div>
                  )}

                  <div className="flex gap-4 pt-4"><button onClick={() => {
                    setIsAddingMovement(false);
                    setIsAddingNewCategory(false);
                    setNewCategoryName('');
                    setIsAddingNewSubcategory(false);
                    setNewSubcategoryName('');
                    setNewExpenseTag('');
                  }} className="flex-1 py-4 text-slate-400 font-black">Cancelar</button><button onClick={handleSaveMovement} className="flex-[2] bg-purple-600 text-white py-4 rounded-2xl font-black">Registrar</button></div>
                </div>
              </motion.div>
            </div>
              )}
         </AnimatePresence>
        </div>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

