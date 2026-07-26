import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowRightLeft,
  ArrowUpRight,
  BarChart3,
  Calendar,
  Check,
  Edit2,
  Plus,
  Search,
  Settings2,
  Tag,
  Trash2,
  Wallet,
  X,
  PieChart as PieChartIcon,
} from 'lucide-react';
import {
  format,
  parseISO,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfYear,
  endOfYear,
  isWithinInterval,
  startOfDay,
  endOfDay,
  subDays,
  startOfQuarter,
  endOfQuarter,
} from 'date-fns';
import { es } from 'date-fns/locale';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  LineChart,
  Line,
} from 'recharts';
import { auth } from '../firebase';
import { UserProfile } from '../types';

type PersonalBoxType = 'cash' | 'bank' | 'wallet' | 'savings' | 'other';
type PersonalMovementType = 'income' | 'expense' | 'transfer';
type PeriodType = 'ultimos_7_dias' | 'ultimos_15_dias' | 'ultimos_30_dias' | 'este_mes' | 'mes_pasado' | 'trimestre_actual' | 'anio_actual' | 'siempre' | 'custom';

type PersonalCashBox = {
  id: string;
  name: string;
  type: PersonalBoxType;
  openingBalance: number;
  color: string;
  isActive: boolean;
  createdBy: string;
};

type PersonalMovement = {
  id: string;
  date: string;
  type: PersonalMovementType;
  amount: number;
  description: string;
  category: string;
  subcategory?: string | null;
  tags: string[];
  fromBoxId?: string | null;
  toBoxId?: string | null;
  createdBy: string;
  source?: string;
};

type PersonalFinanceProps = {
  user: UserProfile;
  onBack: () => void;
};

const boxTypeLabels: Record<PersonalBoxType, string> = {
  cash: 'Efectivo',
  bank: 'Banco',
  wallet: 'Billetera',
  savings: 'Ahorro',
  other: 'Otra',
};

const boxColors = ['#8B5CF6', '#2563EB', '#059669', '#D97706', '#E11D48', '#0F766E'];
const expenseChartColors = ['#8B5CF6', '#2563EB', '#10B981', '#F59E0B', '#EC4899', '#14B8A6', '#F43F5E', '#6366F1'];

const defaultPersonalCategories = [
  'Alimentacion',
  'Entretenimiento',
  'Salud',
  'Transporte',
  'Servicios',
  'Casa',
  'Familia',
  'Educacion',
  'Transferencia familiar',
  'Otros',
];

const personalSubcategories: Record<string, string[]> = {
  Alimentacion: ['SUPERMERCADO', 'COMIDA AFUERA', 'DELIVERY', 'TIENDA O MERCADO'],
  Entretenimiento: ['CINE Y EVENTOS', 'BAR Y SALIDAS', 'SUSCRIPCIONES', 'JUEGOS Y HOBBIES'],
  Salud: ['FARMACIA', 'CITA MEDICA', 'LABORATORIO', 'BIENESTAR'],
  Transporte: ['TAXI O APP', 'BUS O PASAJE', 'COMBUSTIBLE', 'PARQUEO O PEAJE'],
  Servicios: ['LUZ', 'AGUA', 'INTERNET', 'TELEFONO'],
  Casa: ['ARRIENDO', 'LIMPIEZA', 'MUEBLES', 'REPARACIONES'],
  Educacion: ['CURSOS', 'LIBROS', 'COLEGIO O UNIVERSIDAD'],
  Familia: ['AYUDA FAMILIAR', 'REGALOS', 'NINOS'],
  Otros: ['GENERAL'],
};

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeDate = (value: any) => {
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
};

const normalizeTags = (value: string) =>
  value
    .split(',')
    .map(tag => tag.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 8);

export function PersonalFinance({ user, onBack }: PersonalFinanceProps) {
  const [boxes, setBoxes] = useState<PersonalCashBox[]>([]);
  const [movements, setMovements] = useState<PersonalMovement[]>([]);
  const [categories, setCategories] = useState<string[]>(defaultPersonalCategories);
  const [personalView, setPersonalView] = useState<'overview' | 'dashboard'>('overview');
  const [selectedBoxId, setSelectedBoxId] = useState('all');
  const [periodType, setPeriodType] = useState<PeriodType>('este_mes');
  const [startDate, setStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
  const [search, setSearch] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [boxDraft, setBoxDraft] = useState({
    name: '',
    type: 'cash' as PersonalBoxType,
    openingBalance: 0,
    color: boxColors[0],
  });
  const [movementDraft, setMovementDraft] = useState({
    type: 'expense' as PersonalMovementType,
    date: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    amount: 0,
    description: '',
    category: 'Alimentacion',
    subcategory: 'SUPERMERCADO',
    tags: '',
    fromBoxId: '',
    toBoxId: '',
  });

  const applyServerData = (data: any) => {
    setCategories(
      Array.isArray(data.categories) && data.categories.length > 0
        ? data.categories.map(String)
        : defaultPersonalCategories
    );
    setBoxes((Array.isArray(data.boxes) ? data.boxes : []).map((item: any) => ({
      id: String(item.id),
      name: String(item.name || 'Caja personal'),
      type: (item.type || 'cash') as PersonalBoxType,
      openingBalance: Number(item.openingBalance || 0),
      color: String(item.color || boxColors[0]),
      isActive: item.isActive !== false,
      createdBy: String(item.createdBy || ''),
    })));
    setMovements((Array.isArray(data.movements) ? data.movements : []).map((item: any) => ({
      id: String(item.id),
      date: normalizeDate(item.date),
      type: (item.type || 'expense') as PersonalMovementType,
      amount: Number(item.amount || 0),
      description: String(item.description || ''),
      category: String(item.category || 'Otros'),
      subcategory: item.subcategory ? String(item.subcategory) : null,
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      fromBoxId: item.fromBoxId || null,
      toBoxId: item.toBoxId || null,
      createdBy: String(item.createdBy || ''),
      source: item.source ? String(item.source) : undefined,
    })));
  };

  const personalApi = useCallback(async (options: RequestInit & { query?: string } = {}) => {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('No hay sesion activa para finanzas personales.');

    const response = await fetch(`/api/personal-finance${options.query || ''}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error en finanzas personales.');
    applyServerData(data);
    return data;
  }, []);

  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      await personalApi();
      setFormError(null);
    } catch (error: any) {
      setFormError(error?.message || String(error));
    } finally {
      setIsLoading(false);
    }
  }, [personalApi]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const activeBoxes = useMemo(() => boxes.filter(box => box.isActive), [boxes]);
  const boxById = useMemo(() => new Map(boxes.map(box => [box.id, box])), [boxes]);

  const applyPeriod = (period: PeriodType) => {
    const today = new Date();
    const previousMonth = subMonths(today, 1);

    if (period === 'ultimos_7_dias') {
      setStartDate(format(subDays(today, 7), 'yyyy-MM-dd'));
      setEndDate(format(today, 'yyyy-MM-dd'));
    }

    if (period === 'ultimos_15_dias') {
      setStartDate(format(subDays(today, 15), 'yyyy-MM-dd'));
      setEndDate(format(today, 'yyyy-MM-dd'));
    }

    if (period === 'ultimos_30_dias') {
      setStartDate(format(subDays(today, 30), 'yyyy-MM-dd'));
      setEndDate(format(today, 'yyyy-MM-dd'));
    }

    if (period === 'este_mes') {
      setStartDate(format(startOfMonth(today), 'yyyy-MM-dd'));
      setEndDate(format(endOfMonth(today), 'yyyy-MM-dd'));
    }

    if (period === 'mes_pasado') {
      setStartDate(format(startOfMonth(previousMonth), 'yyyy-MM-dd'));
      setEndDate(format(endOfMonth(previousMonth), 'yyyy-MM-dd'));
    }

    if (period === 'anio_actual') {
      setStartDate(format(startOfYear(today), 'yyyy-MM-dd'));
      setEndDate(format(endOfYear(today), 'yyyy-MM-dd'));
    }

    if (period === 'trimestre_actual') {
      setStartDate(format(startOfQuarter(today), 'yyyy-MM-dd'));
      setEndDate(format(endOfQuarter(today), 'yyyy-MM-dd'));
    }

    setPeriodType(period);
  };

  const isInPeriod = useCallback((date: string) => {
    if (periodType === 'siempre') return true;
    const parsed = parseISO(date);
    const start = startOfDay(parseISO(startDate));
    const end = endOfDay(parseISO(endDate));
    if (Number.isNaN(parsed.getTime()) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return true;
    return isWithinInterval(parsed, { start, end });
  }, [periodType, startDate, endDate]);

  const boxBalances = useMemo(() => {
    const balances = new Map<string, number>();
    boxes.forEach(box => balances.set(box.id, Number(box.openingBalance || 0)));

    movements.forEach(movement => {
      const amount = Number(movement.amount || 0);
      if (movement.type === 'income' && movement.toBoxId) {
        balances.set(movement.toBoxId, (balances.get(movement.toBoxId) || 0) + amount);
      }
      if (movement.type === 'expense' && movement.fromBoxId) {
        balances.set(movement.fromBoxId, (balances.get(movement.fromBoxId) || 0) - amount);
      }
      if (movement.type === 'transfer') {
        if (movement.fromBoxId) balances.set(movement.fromBoxId, (balances.get(movement.fromBoxId) || 0) - amount);
        if (movement.toBoxId) balances.set(movement.toBoxId, (balances.get(movement.toBoxId) || 0) + amount);
      }
    });

    return balances;
  }, [boxes, movements]);

  const filteredMovements = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return movements.filter(movement => {
      const matchesBox = selectedBoxId === 'all' || movement.fromBoxId === selectedBoxId || movement.toBoxId === selectedBoxId;
      const matchesPeriod = isInPeriod(movement.date);
      const searchable = [
        movement.description,
        movement.category,
        movement.subcategory || '',
        ...(movement.tags || []),
        movement.fromBoxId ? boxById.get(movement.fromBoxId)?.name : '',
        movement.toBoxId ? boxById.get(movement.toBoxId)?.name : '',
      ].join(' ').toLowerCase();
      const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
      return matchesBox && matchesPeriod && matchesSearch;
    });
  }, [boxById, isInPeriod, movements, search, selectedBoxId]);

  const totals = useMemo(() => {
    return filteredMovements.reduce((acc, movement) => {
      if (movement.type === 'expense') acc.expenses += movement.amount;
      if (movement.type === 'income') acc.income += movement.amount;
      if (movement.type === 'transfer') acc.transfers += movement.amount;
      return acc;
    }, { income: 0, expenses: 0, transfers: 0 });
  }, [filteredMovements]);

  const totalBalance = useMemo(() =>
    activeBoxes.reduce((sum, box) => sum + (boxBalances.get(box.id) || 0), 0),
  [activeBoxes, boxBalances]);

  const categoryTotals = useMemo(() => {
    const groups = new Map<string, { amount: number; count: number }>();
    filteredMovements
      .filter(movement => movement.type === 'expense')
      .forEach(movement => {
        const current = groups.get(movement.category) || { amount: 0, count: 0 };
        groups.set(movement.category, {
          amount: current.amount + movement.amount,
          count: current.count + 1,
        });
      });
    return [...groups.entries()]
      .map(([category, stats]) => ({ category, amount: stats.amount, count: stats.count }))
      .sort((a, b) => b.amount - a.amount);
  }, [filteredMovements]);

  const expenseMovements = useMemo(
    () => filteredMovements.filter(movement => movement.type === 'expense'),
    [filteredMovements]
  );

  const topCategories = useMemo(() => categoryTotals.slice(0, 8), [categoryTotals]);

  const categoryPieData = useMemo(
    () =>
      topCategories.map((item, index) => ({
        name: item.category,
        value: item.amount,
        color: expenseChartColors[index % expenseChartColors.length],
      })),
    [topCategories]
  );

  const dailyExpenseTrend = useMemo(() => {
    const byDay = new Map<string, { name: string; expense: number; sort: number }>();
    expenseMovements.forEach(movement => {
      const parsed = parseISO(movement.date);
      if (Number.isNaN(parsed.getTime())) return;
      const key = format(parsed, 'yyyy-MM-dd');
      const current = byDay.get(key) || { name: format(parsed, 'dd/MM'), expense: 0, sort: parsed.getTime() };
      byDay.set(key, {
        name: current.name,
        expense: current.expense + movement.amount,
        sort: current.sort,
      });
    });

    return [...byDay.entries()]
      .map(([, value]) => ({ name: value.name, expense: value.expense, sort: value.sort }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ sort, ...rest }) => rest);
  }, [expenseMovements]);

  const averageDailyExpense = useMemo(() => {
    if (expenseMovements.length === 0) return 0;
    const uniqueDays = new Set(expenseMovements.map(movement => format(parseISO(movement.date), 'yyyy-MM-dd'))).size;
    return totals.expenses / Math.max(1, uniqueDays);
  }, [expenseMovements, totals.expenses]);

  const periodSummary = useMemo(() => {
    if (expenseMovements.length === 0) return 'Sin gastos en el periodo seleccionado';
    const firstExpense = expenseMovements[expenseMovements.length - 1];
    const lastExpense = expenseMovements[0];
    return `${expenseMovements.length} gastos entre ${format(parseISO(firstExpense.date), 'dd MMM', { locale: es })} y ${format(parseISO(lastExpense.date), 'dd MMM', { locale: es })}`;
  }, [expenseMovements]);

  const topCategory = topCategories[0];
  const oldestExpense = expenseMovements[expenseMovements.length - 1];
  const newestExpense = expenseMovements[0];
  const periodStartDisplay = periodType === 'siempre'
    ? oldestExpense
      ? format(parseISO(oldestExpense.date), 'dd/MM/yyyy', { locale: es })
      : 'Sin datos'
    : format(parseISO(startDate), 'dd/MM/yyyy', { locale: es });
  const periodEndDisplay = periodType === 'siempre'
    ? newestExpense
      ? format(parseISO(newestExpense.date), 'dd/MM/yyyy', { locale: es })
      : 'Sin datos'
    : format(parseISO(endDate), 'dd/MM/yyyy', { locale: es });

  const ensureDefaultBox = async () => {
    if (activeBoxes.length > 0) return activeBoxes[0].id;
    const data = await personalApi({
      method: 'POST',
      body: JSON.stringify({
        kind: 'box',
        name: 'Caja Personal',
        type: 'cash',
        openingBalance: 0,
        color: boxColors[0],
      }),
    });
    return data.id;
  };

  const handleCreateBox = async () => {
    const name = boxDraft.name.trim();
    if (!name) {
      setFormError('INGRESA EL NOMBRE DE LA CAJA PERSONAL');
      return;
    }

    try {
      await personalApi({
        method: 'POST',
        body: JSON.stringify({
          kind: 'box',
          name,
          type: boxDraft.type,
          openingBalance: toNumber(boxDraft.openingBalance),
          color: boxDraft.color,
        }),
      });
      setBoxDraft({ name: '', type: 'cash', openingBalance: 0, color: boxColors[0] });
      setFormError(null);
    } catch (error: any) {
      setFormError(error?.message || String(error));
    }
  };

  const handleSaveMovement = async () => {
    const amount = toNumber(movementDraft.amount);
    const description = movementDraft.description.trim();
    const type = movementDraft.type;
    const fromBoxId = movementDraft.fromBoxId || (type !== 'income' ? activeBoxes[0]?.id : '');
    const toBoxId = movementDraft.toBoxId || (type !== 'expense' ? activeBoxes[0]?.id : '');

    if (amount <= 0) {
      setFormError('EL MONTO DEBE SER MAYOR A 0');
      return;
    }
    if (!description) {
      setFormError('INGRESA UNA DESCRIPCION');
      return;
    }
    if (activeBoxes.length === 0) {
      await ensureDefaultBox();
      setFormError('CREE UNA CAJA POR DEFECTO. VUELVE A REGISTRAR EL MOVIMIENTO.');
      return;
    }
    if (type === 'expense' && !fromBoxId) {
      setFormError('SELECCIONA LA CAJA DE ORIGEN');
      return;
    }
    if (type === 'income' && !toBoxId) {
      setFormError('SELECCIONA LA CAJA DESTINO');
      return;
    }
    if (type === 'transfer' && (!fromBoxId || !toBoxId || fromBoxId === toBoxId)) {
      setFormError('LA TRANSFERENCIA NECESITA CAJAS DIFERENTES');
      return;
    }

    try {
      await personalApi({
        method: 'POST',
        body: JSON.stringify({
          kind: 'movement',
          date: new Date(movementDraft.date).toISOString(),
          type,
          amount,
          description,
          category: type === 'expense' ? movementDraft.category : type === 'income' ? 'Ingreso personal' : 'Transferencia',
          subcategory: type === 'expense' ? movementDraft.subcategory || null : null,
          tags: normalizeTags(movementDraft.tags),
          fromBoxId: type === 'income' ? null : fromBoxId,
          toBoxId: type === 'expense' ? null : toBoxId,
        }),
      });

      setMovementDraft({
        type: 'expense',
        date: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
        amount: 0,
        description: '',
        category: 'Alimentacion',
        subcategory: 'SUPERMERCADO',
        tags: '',
        fromBoxId: fromBoxId || '',
        toBoxId: toBoxId || '',
      });
      setFormError(null);
    } catch (error: any) {
      setFormError(error?.message || String(error));
    }
  };

  const deleteMovement = async (id: string) => {
    if (!window.confirm('Eliminar este movimiento personal?')) return;
    await personalApi({ method: 'DELETE', query: `?id=${encodeURIComponent(id)}` });
  };

  const periodButtons: { value: PeriodType; label: string }[] = [
    { value: 'ultimos_7_dias', label: '7 dias' },
    { value: 'ultimos_15_dias', label: '15 dias' },
    { value: 'ultimos_30_dias', label: '30 dias' },
    { value: 'este_mes', label: 'Este mes' },
    { value: 'mes_pasado', label: 'Mes pasado' },
    { value: 'trimestre_actual', label: 'Trimestre' },
    { value: 'anio_actual', label: 'Anio' },
    { value: 'siempre', label: 'Todo' },
    { value: 'custom', label: 'Fechas' },
  ];

  return (
    <div className="min-h-screen bg-[#0F172A] text-slate-200 pb-16">
      <header className="sticky top-0 z-40 bg-[#1E293B]/70 backdrop-blur-md border-b border-white/5">
        <div className="w-full px-4 h-20 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <button onClick={onBack} className="w-11 h-11 rounded-2xl bg-white/5 border border-white/5 text-slate-400 hover:text-white flex items-center justify-center">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-xl font-black text-white uppercase tracking-tight">Finanzas Personales</h1>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest truncate">Cajas, gastos e historial separados del negocio</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPersonalView(personalView === 'dashboard' ? 'overview' : 'dashboard')}
              className={`px-4 py-3 rounded-2xl border text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-colors ${personalView === 'dashboard' ? 'bg-amber-500/15 border-amber-400/40 text-amber-200' : 'bg-white/5 border-white/5 text-slate-300 hover:text-white'}`}
            >
              <PieChartIcon className="w-4 h-4" />
              {personalView === 'dashboard' ? 'Volver al modulo' : 'Ver dashboard'}
            </button>
            <div className="hidden md:flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded-2xl px-4 py-3">
              <Wallet className="w-4 h-4" />
              Chatbot familiar listo para datos personales
            </div>
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-8 space-y-8">
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Saldo personal</p>
            <p className="text-3xl font-black text-white">${totalBalance.toLocaleString('es-CL')}</p>
          </div>
          <div className="bg-[#1E293B] border border-emerald-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-emerald-400/70 uppercase tracking-widest mb-2">Ingresos periodo</p>
            <p className="text-3xl font-black text-emerald-400">+${totals.income.toLocaleString('es-CL')}</p>
          </div>
          <div className="bg-[#1E293B] border border-rose-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-rose-400/70 uppercase tracking-widest mb-2">Gastos periodo</p>
            <p className="text-3xl font-black text-rose-400">-${totals.expenses.toLocaleString('es-CL')}</p>
          </div>
          <div className="bg-[#1E293B] border border-purple-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-purple-300/70 uppercase tracking-widest mb-2">Caja activa</p>
            <p className="text-3xl font-black text-purple-300">{activeBoxes.length > 0 ? 1 : 0}</p>
          </div>
        </section>

        <section className="bg-[radial-gradient(circle_at_top_left,_rgba(168,85,247,0.18),_transparent_35%),linear-gradient(135deg,_rgba(30,41,59,0.98),_rgba(15,23,42,0.98))] border border-white/5 rounded-[2rem] p-6 lg:p-8 overflow-hidden">
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
            <div className="max-w-3xl">
              <p className="text-[10px] font-black uppercase tracking-[0.35em] text-amber-300/80 mb-3">Dashboard personal</p>
              <h2 className="text-2xl lg:text-4xl font-black text-white uppercase tracking-tight">Analiza tus gastos por categoria y por plazo</h2>
              <p className="mt-3 text-sm lg:text-base text-slate-300 max-w-2xl">
                Revisa consumo por categoria, tendencia diaria y comparativos en periodos cortos o fechas personalizadas, sin mezclar nada del negocio.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 min-w-full xl:min-w-[420px]">
              <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Periodo activo</p>
                <p className="mt-2 text-sm font-black text-white uppercase">{periodStartDisplay} - {periodEndDisplay}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Resumen</p>
                <p className="mt-2 text-sm font-black text-white">{periodSummary}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Categoria mas fuerte</p>
                <p className="mt-2 text-sm font-black text-white uppercase">{topCategory?.category || 'Sin datos'}</p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {periodButtons.map(period => (
              <button
                key={period.value}
                onClick={() => applyPeriod(period.value)}
                className={`px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${periodType === period.value ? 'bg-amber-500/15 border-amber-400/40 text-amber-200' : 'bg-white/5 border-white/5 text-slate-400 hover:text-white'}`}
              >
                {period.label}
              </button>
            ))}
          </div>

          {periodType === 'custom' && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="date"
                value={startDate}
                onChange={event => {
                  setPeriodType('custom');
                  setStartDate(event.target.value);
                }}
                className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white"
              />
              <input
                type="date"
                value={endDate}
                onChange={event => {
                  setPeriodType('custom');
                  setEndDate(event.target.value);
                }}
                className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white"
              />
            </div>
          )}
        </section>

        {personalView === 'dashboard' && (
          <section className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Gasto promedio diario</p>
                <p className="mt-3 text-3xl font-black text-white">${averageDailyExpense.toLocaleString('es-CL')}</p>
              </div>
              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Gastos registrados</p>
                <p className="mt-3 text-3xl font-black text-white">{expenseMovements.length}</p>
              </div>
              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Categoria principal</p>
                <p className="mt-3 text-lg font-black text-white uppercase">{topCategory?.category || 'Sin datos'}</p>
                <p className="mt-1 text-sm font-bold text-slate-400">{topCategory ? `$${topCategory.amount.toLocaleString('es-CL')}` : 'Sin gasto'}</p>
              </div>
              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Cobertura</p>
                <p className="mt-3 text-lg font-black text-white">{periodStartDisplay}</p>
                <p className="mt-1 text-sm font-bold text-slate-400">hasta {periodEndDisplay}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <div className="flex items-center justify-between gap-4 mb-5">
                  <div>
                    <h3 className="text-lg font-black text-white uppercase tracking-tight">Consumo por categoria</h3>
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Distribucion del gasto personal</p>
                  </div>
                </div>
                <div className="h-[340px]">
                  {categoryPieData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={categoryPieData}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={70}
                          outerRadius={118}
                          paddingAngle={3}
                        >
                          {categoryPieData.map(entry => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => `$${Number(value).toLocaleString('es-CL')}`} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm font-bold text-slate-500">No hay gastos para graficar en este plazo.</div>
                  )}
                </div>
              </div>

              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <h3 className="text-lg font-black text-white uppercase tracking-tight mb-5">Top categorias</h3>
                <div className="space-y-4">
                  {topCategories.map(item => (
                    <div key={item.category} className="rounded-2xl border border-white/5 bg-[#0F172A]/70 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-black text-white uppercase">{item.category}</p>
                        <p className="text-sm font-black text-amber-300">${item.amount.toLocaleString('es-CL')}</p>
                      </div>
                      <div className="mt-3 h-2 rounded-full bg-white/5 overflow-hidden">
                        <div className="h-full bg-amber-400" style={{ width: `${Math.min(100, (item.amount / Math.max(1, totals.expenses)) * 100)}%` }} />
                      </div>
                      <p className="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">{item.count} movimientos</p>
                    </div>
                  ))}
                  {topCategories.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm font-bold text-slate-500">
                      Todavia no hay categorias para mostrar en este periodo.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-6">
              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <h3 className="text-lg font-black text-white uppercase tracking-tight mb-5">Tendencia diaria</h3>
                <div className="h-[320px]">
                  {dailyExpenseTrend.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyExpenseTrend}>
                        <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                        <XAxis dataKey="name" stroke="#94A3B8" fontSize={12} />
                        <YAxis stroke="#94A3B8" fontSize={12} />
                        <Tooltip formatter={(value: number) => `$${Number(value).toLocaleString('es-CL')}`} />
                        <Line type="monotone" dataKey="expense" stroke="#F59E0B" strokeWidth={3} dot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm font-bold text-slate-500">Aun no hay tendencia disponible.</div>
                  )}
                </div>
              </div>

              <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
                <h3 className="text-lg font-black text-white uppercase tracking-tight mb-5">Comparativo por categoria</h3>
                <div className="h-[320px]">
                  {topCategories.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={topCategories}>
                        <CartesianGrid stroke="rgba(148, 163, 184, 0.12)" vertical={false} />
                        <XAxis dataKey="category" stroke="#94A3B8" fontSize={11} angle={-14} textAnchor="end" height={70} />
                        <YAxis stroke="#94A3B8" fontSize={12} />
                        <Tooltip formatter={(value: number) => `$${Number(value).toLocaleString('es-CL')}`} />
                        <Bar dataKey="amount" radius={[10, 10, 0, 0]}>
                          {topCategories.map((item, index) => (
                            <Cell key={item.category} fill={expenseChartColors[index % expenseChartColors.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-sm font-bold text-slate-500">Aun no hay categorias suficientes para comparar.</div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-6">
          <div className="space-y-6">
            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2">
                    <Wallet className="w-5 h-5 text-purple-400" />
                    Cajas personales
                  </h2>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Configurables y separadas del negocio</p>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {(['este_mes', 'mes_pasado', 'anio_actual', 'siempre'] as PeriodType[]).map(period => (
                    <button
                      key={period}
                      onClick={() => applyPeriod(period)}
                      className={`px-3 py-2 rounded-xl border text-[9px] font-black uppercase tracking-widest ${periodType === period ? 'bg-purple-500/15 border-purple-500/50 text-purple-200' : 'bg-white/5 border-white/5 text-slate-500 hover:text-white'}`}
                    >
                      {period === 'este_mes' ? 'Este mes' : period === 'mes_pasado' ? 'Mes pasado' : period === 'anio_actual' ? 'Anio' : 'Todo'}
                    </button>
                  ))}
                </div>
              </div>

              {periodType === 'custom' && (
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-2 text-xs font-bold text-white" />
                  <input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-2 text-xs font-bold text-white" />
                </div>
              )}

              {activeBoxes[0] ? (
                <button
                  type="button"
                  onClick={() => setSelectedBoxId(selectedBoxId === activeBoxes[0].id ? 'all' : activeBoxes[0].id)}
                  className={`text-left rounded-2xl border p-5 transition-all w-full ${selectedBoxId === activeBoxes[0].id ? 'border-purple-400 bg-purple-500/10' : 'border-white/5 bg-[#0F172A]/70 hover:border-white/20'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ backgroundColor: `${activeBoxes[0].color}22`, color: activeBoxes[0].color }}>
                      <Wallet className="w-5 h-5" />
                    </span>
                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">{boxTypeLabels[activeBoxes[0].type]}</span>
                  </div>
                  <p className="mt-4 text-sm font-black uppercase text-white">{activeBoxes[0].name}</p>
                  <p className="mt-2 text-2xl font-black text-white">${(boxBalances.get(activeBoxes[0].id) || 0).toLocaleString('es-CL')}</p>
                </button>
              ) : (
                <div className="py-16 text-center border border-dashed border-white/10 rounded-2xl">
                  <Wallet className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                  <p className="text-xs font-black uppercase tracking-widest text-slate-500">Crea tu caja personal principal</p>
                </div>
              )}
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-blue-400" />
                    Historial personal
                  </h2>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{filteredMovements.length} movimientos en pantalla</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      value={search}
                      onChange={event => setSearch(event.target.value)}
                      placeholder="Buscar..."
                      className="pl-9 pr-3 py-2 bg-[#0F172A] border border-white/5 rounded-xl text-xs font-bold text-white outline-none focus:border-purple-500"
                    />
                  </div>
                  <select value={selectedBoxId} onChange={event => setSelectedBoxId(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-2 text-xs font-black text-white outline-none">
                    <option value="all">Todas</option>
                    {activeBoxes.map(box => <option key={box.id} value={box.id}>{box.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/5">
                {filteredMovements.map(movement => {
                  const isPositive = movement.type === 'income' || (selectedBoxId !== 'all' && movement.toBoxId === selectedBoxId);
                  const signed = movement.type === 'income' ? movement.amount : movement.type === 'expense' ? -movement.amount : isPositive ? movement.amount : -movement.amount;
                  return (
                    <div key={movement.id} className="min-h-[84px] bg-[#0F172A]/70 border-b border-white/5 last:border-b-0 px-4 py-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-white uppercase">{movement.description}</p>
                          <div className="flex flex-wrap items-center gap-2 mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">
                            <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />{format(parseISO(movement.date), 'dd MMM yyyy HH:mm', { locale: es })}</span>
                            <span className="inline-flex items-center gap-1"><Tag className="w-3 h-3" />{movement.category}</span>
                            {movement.subcategory && <span>{movement.subcategory}</span>}
                            <span>{movement.type === 'transfer' ? `${boxById.get(movement.fromBoxId || '')?.name || 'Origen'} -> ${boxById.get(movement.toBoxId || '')?.name || 'Destino'}` : boxById.get(movement.fromBoxId || movement.toBoxId || '')?.name || 'Caja'}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-lg font-black ${signed >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signed >= 0 ? '+' : '-'}${Math.abs(signed).toLocaleString('es-CL')}</p>
                          <button onClick={() => deleteMovement(movement.id)} className="mt-2 text-slate-600 hover:text-rose-400">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredMovements.length === 0 && (
                  <div className="py-16 text-center bg-[#0F172A]/70">
                    <Search className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                    <p className="text-xs font-black uppercase tracking-widest text-slate-500">No hay movimientos personales en este periodo</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <aside className="space-y-6">
            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-5">
                <Plus className="w-4 h-4 text-purple-400" />
                Crear caja
              </h3>
              <div className="space-y-3">
                <input value={boxDraft.name} onChange={event => setBoxDraft({ ...boxDraft, name: event.target.value })} placeholder="Nombre de caja" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-purple-500" />
                <div className="grid grid-cols-2 gap-3">
                  <select value={boxDraft.type} onChange={event => setBoxDraft({ ...boxDraft, type: event.target.value as PersonalBoxType })} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-3 text-xs font-black text-white outline-none">
                    {Object.entries(boxTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <input type="number" min="0" value={boxDraft.openingBalance || ''} onChange={event => setBoxDraft({ ...boxDraft, openingBalance: toNumber(event.target.value) })} placeholder="Saldo inicial" className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-3 text-xs font-bold text-white outline-none" />
                </div>
                <div className="flex gap-2">
                  {boxColors.map(color => (
                    <button key={color} type="button" onClick={() => setBoxDraft({ ...boxDraft, color })} className={`w-8 h-8 rounded-xl border ${boxDraft.color === color ? 'border-white' : 'border-transparent'}`} style={{ backgroundColor: color }} />
                  ))}
                </div>
                <button onClick={handleCreateBox} className="w-full py-3 bg-purple-600 hover:bg-purple-500 rounded-xl text-white text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" />
                  Guardar caja
                </button>
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-5">
                <ArrowUpRight className="w-4 h-4 text-rose-400" />
                Movimiento personal
              </h3>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'expense', label: 'Gasto', Icon: ArrowUpRight },
                    { value: 'income', label: 'Ingreso', Icon: ArrowDownLeft },
                    { value: 'transfer', label: 'Mover', Icon: ArrowRightLeft },
                  ].map(item => (
                    <button key={item.value} onClick={() => setMovementDraft({ ...movementDraft, type: item.value as PersonalMovementType })} className={`py-3 rounded-xl text-[10px] font-black uppercase flex items-center justify-center gap-1 ${movementDraft.type === item.value ? 'bg-purple-600 text-white' : 'bg-white/5 text-slate-500'}`}>
                      <item.Icon className="w-3 h-3" />
                      {item.label}
                    </button>
                  ))}
                </div>
                <input type="datetime-local" value={movementDraft.date} onChange={event => setMovementDraft({ ...movementDraft, date: event.target.value })} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-purple-500" />
                <input type="number" min="0" value={movementDraft.amount || ''} onChange={event => setMovementDraft({ ...movementDraft, amount: toNumber(event.target.value) })} placeholder="Monto" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-2xl font-black text-white outline-none focus:border-purple-500" />
                <input value={movementDraft.description} onChange={event => setMovementDraft({ ...movementDraft, description: event.target.value })} placeholder="Descripcion" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-purple-500" />
                {movementDraft.type === 'expense' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <select
                      value={movementDraft.category}
                      onChange={event => {
                        const category = event.target.value;
                        setMovementDraft({
                          ...movementDraft,
                          category,
                          subcategory: personalSubcategories[category]?.[0] || 'GENERAL',
                        });
                      }}
                      className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none focus:border-purple-500"
                    >
                      {categories.map(category => <option key={category} value={category}>{category}</option>)}
                    </select>
                    <select
                      value={movementDraft.subcategory}
                      onChange={event => setMovementDraft({ ...movementDraft, subcategory: event.target.value })}
                      className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none focus:border-purple-500"
                    >
                      {Array.from(new Set([...(personalSubcategories[movementDraft.category] || ['GENERAL']), movementDraft.subcategory].filter(Boolean))).map(subcategory => (
                        <option key={subcategory} value={subcategory}>{subcategory}</option>
                      ))}
                    </select>
                  </div>
                )}
                {movementDraft.type !== 'income' && (
                  <select value={movementDraft.fromBoxId || activeBoxes[0]?.id || ''} onChange={event => setMovementDraft({ ...movementDraft, fromBoxId: event.target.value })} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none">
                    <option value="">Origen</option>
                    {activeBoxes.map(box => <option key={box.id} value={box.id}>{box.name}</option>)}
                  </select>
                )}
                {movementDraft.type !== 'expense' && (
                  <select value={movementDraft.toBoxId || activeBoxes[0]?.id || ''} onChange={event => setMovementDraft({ ...movementDraft, toBoxId: event.target.value })} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none">
                    <option value="">Destino</option>
                    {activeBoxes.map(box => <option key={box.id} value={box.id}>{box.name}</option>)}
                  </select>
                )}
                <input value={movementDraft.tags} onChange={event => setMovementDraft({ ...movementDraft, tags: event.target.value })} placeholder="Etiquetas separadas por coma" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-bold text-white outline-none focus:border-purple-500" />
                {formError && <p className="text-xs font-black text-rose-400 uppercase">{formError}</p>}
                <button onClick={handleSaveMovement} className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white text-xs font-black uppercase tracking-widest">
                  Registrar movimiento
                </button>
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight mb-4">Categorias fuertes</h3>
              <div className="space-y-3">
                {categoryTotals.map(({ category, amount }) => (
                  <div key={category}>
                    <div className="flex justify-between text-[10px] font-black uppercase tracking-widest mb-1">
                      <span className="text-slate-400">{category}</span>
                      <span className="text-white">${amount.toLocaleString('es-CL')}</span>
                    </div>
                    <div className="h-2 bg-[#0F172A] rounded-full overflow-hidden">
                      <div className="h-full bg-purple-500" style={{ width: `${Math.min(100, (amount / Math.max(1, totals.expenses)) * 100)}%` }} />
                    </div>
                  </div>
                ))}
                {categoryTotals.length === 0 && <p className="text-xs font-bold text-slate-500">Sin gastos para analizar en este periodo.</p>}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
