import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BadgeDollarSign,
  Calendar,
  Check,
  Coins,
  Landmark,
  ReceiptText,
  Search,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Timestamp,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  endOfDay,
  endOfMonth,
  format,
  isWithinInterval,
  parseISO,
  startOfDay,
  startOfMonth,
  subMonths,
} from 'date-fns';
import { es } from 'date-fns/locale';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { UserProfile } from '../types';

type BusinessBox = 'safe' | 'transit' | 'bank' | 'personal';
type PayrollKind = 'advance' | 'salary' | 'bonus' | 'loan' | 'discount' | 'settlement';
type PayrollPeriod = 'este_mes' | 'mes_pasado' | 'custom';

type EmployeeProfile = {
  id: string;
  name: string;
  role?: string;
  monthlySalary: number;
  paymentDay?: number;
  defaultSource: BusinessBox;
  isActive: boolean;
  notes?: string;
};

type EmployeePayment = {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  amount: number;
  kind: PayrollKind;
  from: BusinessBox;
  description: string;
  notes?: string;
  periodKey: string;
  movementId?: string;
  createdBy: string;
};

type PayrollModuleProps = {
  user: UserProfile;
  onBack: () => void;
  balances: Record<BusinessBox, number>;
};

const boxLabels: Record<BusinessBox, string> = {
  safe: 'Tienda',
  transit: 'Transito',
  bank: 'Banco',
  personal: 'Personal',
};

const kindLabels: Record<PayrollKind, string> = {
  advance: 'Anticipo',
  salary: 'Pago de sueldo',
  bonus: 'Bono',
  loan: 'Prestamo',
  discount: 'Descuento',
  settlement: 'Liquidacion',
};

const kindSubcategory: Record<PayrollKind, string> = {
  advance: 'ANTICIPO',
  salary: 'NOMINA',
  bonus: 'BONO',
  loan: 'PRESTAMO',
  discount: 'DESCUENTO',
  settlement: 'LIQUIDACION',
};

const toPositiveNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const formatMoney = (value: number) =>
  `$${value.toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const normalizeDate = (value: unknown) => {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
};

const buildPeriodKey = (isoDate: string) => {
  const parsed = parseISO(isoDate);
  return Number.isNaN(parsed.getTime()) ? format(new Date(), 'yyyy-MM') : format(parsed, 'yyyy-MM');
};

export function PayrollModule({ user, onBack, balances }: PayrollModuleProps) {
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [payments, setPayments] = useState<EmployeePayment[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('all');
  const [search, setSearch] = useState('');
  const [periodType, setPeriodType] = useState<PayrollPeriod>('este_mes');
  const [startDate, setStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
  const [formError, setFormError] = useState<string | null>(null);
  const [employeeDraft, setEmployeeDraft] = useState({
    name: '',
    role: '',
    monthlySalary: 0,
    paymentDay: 30,
    defaultSource: 'safe' as BusinessBox,
    notes: '',
  });
  const [paymentDraft, setPaymentDraft] = useState({
    employeeId: '',
    date: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    amount: 0,
    kind: 'advance' as PayrollKind,
    from: 'safe' as BusinessBox,
    description: '',
    notes: '',
  });

  useEffect(() => {
    const employeesQuery = query(collection(db, 'employees'), orderBy('name', 'asc'));
    const paymentsQuery = query(collection(db, 'employee_payments'), orderBy('date', 'desc'));

    const unsubscribeEmployees = onSnapshot(
      employeesQuery,
      snapshot => {
        setEmployees(snapshot.docs.map(item => {
          const data = item.data();
          return {
            id: item.id,
            name: String(data.name || 'EMPLEADO'),
            role: data.role ? String(data.role) : '',
            monthlySalary: Number(data.monthlySalary || 0),
            paymentDay: Number(data.paymentDay || 30),
            defaultSource: (data.defaultSource || 'safe') as BusinessBox,
            isActive: data.isActive !== false,
            notes: data.notes ? String(data.notes) : '',
          };
        }));
      },
      err => handleFirestoreError(err, OperationType.LIST, 'employees')
    );

    const unsubscribePayments = onSnapshot(
      paymentsQuery,
      snapshot => {
        setPayments(snapshot.docs.map(item => {
          const data = item.data();
          return {
            id: item.id,
            employeeId: String(data.employeeId || ''),
            employeeName: String(data.employeeName || 'EMPLEADO'),
            date: normalizeDate(data.date),
            amount: Number(data.amount || 0),
            kind: (data.kind || 'advance') as PayrollKind,
            from: (data.from || 'safe') as BusinessBox,
            description: String(data.description || ''),
            notes: data.notes ? String(data.notes) : '',
            periodKey: String(data.periodKey || buildPeriodKey(normalizeDate(data.date))),
            movementId: data.movementId ? String(data.movementId) : undefined,
            createdBy: String(data.createdBy || ''),
          };
        }));
      },
      err => handleFirestoreError(err, OperationType.LIST, 'employee_payments')
    );

    return () => {
      unsubscribeEmployees();
      unsubscribePayments();
    };
  }, []);

  const applyPeriod = (next: PayrollPeriod) => {
    const today = new Date();
    const previousMonth = subMonths(today, 1);

    if (next === 'este_mes') {
      setStartDate(format(startOfMonth(today), 'yyyy-MM-dd'));
      setEndDate(format(endOfMonth(today), 'yyyy-MM-dd'));
    }

    if (next === 'mes_pasado') {
      setStartDate(format(startOfMonth(previousMonth), 'yyyy-MM-dd'));
      setEndDate(format(endOfMonth(previousMonth), 'yyyy-MM-dd'));
    }

    setPeriodType(next);
  };

  const filteredPayments = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const start = startOfDay(parseISO(startDate));
    const end = endOfDay(parseISO(endDate));

    return payments.filter(payment => {
      const matchesEmployee = selectedEmployeeId === 'all' || payment.employeeId === selectedEmployeeId;
      const searchable = `${payment.employeeName} ${payment.description} ${payment.notes || ''} ${kindLabels[payment.kind]} ${boxLabels[payment.from]}`.toLowerCase();
      const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
      const parsed = parseISO(payment.date);
      const matchesRange =
        Number.isNaN(parsed.getTime()) ||
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime()) ||
        isWithinInterval(parsed, { start, end });
      return matchesEmployee && matchesSearch && matchesRange;
    });
  }, [payments, search, selectedEmployeeId, startDate, endDate]);

  const activeEmployees = useMemo(() => employees.filter(employee => employee.isActive), [employees]);

  const summary = useMemo(() => {
    const totalPaid = filteredPayments
      .filter(payment => payment.kind !== 'discount')
      .reduce((acc, payment) => acc + payment.amount, 0);
    const totalDiscounts = filteredPayments
      .filter(payment => payment.kind === 'discount')
      .reduce((acc, payment) => acc + payment.amount, 0);
    const totalAdvances = filteredPayments
      .filter(payment => payment.kind === 'advance')
      .reduce((acc, payment) => acc + payment.amount, 0);
    const payrollCommitment = activeEmployees.reduce((acc, employee) => acc + employee.monthlySalary, 0);
    return {
      totalPaid,
      totalDiscounts,
      totalAdvances,
      payrollCommitment,
      remaining: Math.max(0, payrollCommitment - totalPaid + totalDiscounts),
    };
  }, [activeEmployees, filteredPayments]);

  const employeeCards = useMemo(() => {
    const paymentsByEmployee = new Map<string, EmployeePayment[]>();
    filteredPayments.forEach(payment => {
      const current = paymentsByEmployee.get(payment.employeeId) || [];
      current.push(payment);
      paymentsByEmployee.set(payment.employeeId, current);
    });

    return activeEmployees.map(employee => {
      const items = paymentsByEmployee.get(employee.id) || [];
      const advances = items.filter(item => item.kind === 'advance').reduce((acc, item) => acc + item.amount, 0);
      const salaries = items.filter(item => item.kind === 'salary').reduce((acc, item) => acc + item.amount, 0);
      const bonuses = items.filter(item => item.kind === 'bonus').reduce((acc, item) => acc + item.amount, 0);
      const discounts = items.filter(item => item.kind === 'discount').reduce((acc, item) => acc + item.amount, 0);
      return {
        ...employee,
        advances,
        salaries,
        bonuses,
        discounts,
        pending: employee.monthlySalary - advances - salaries + discounts,
      };
    });
  }, [activeEmployees, filteredPayments]);

  const selectedEmployee = useMemo(
    () => activeEmployees.find(employee => employee.id === paymentDraft.employeeId),
    [activeEmployees, paymentDraft.employeeId]
  );

  const selectedEmployeeCard = useMemo(
    () => employeeCards.find(employee => employee.id === paymentDraft.employeeId),
    [employeeCards, paymentDraft.employeeId]
  );

  const handleCreateEmployee = async () => {
    const name = employeeDraft.name.trim().toUpperCase();
    if (!name) {
      setFormError('INGRESA EL NOMBRE DEL EMPLEADO');
      return;
    }

    try {
      const employeeRef = doc(collection(db, 'employees'));
      await setDoc(employeeRef, {
        name,
        role: employeeDraft.role.trim().toUpperCase() || null,
        monthlySalary: toPositiveNumber(employeeDraft.monthlySalary),
        paymentDay: Number(employeeDraft.paymentDay || 30),
        defaultSource: employeeDraft.defaultSource,
        isActive: true,
        notes: employeeDraft.notes.trim() || null,
        createdBy: user.uid,
        createdAt: serverTimestamp(),
      });

      setEmployeeDraft({
        name: '',
        role: '',
        monthlySalary: 0,
        paymentDay: 30,
        defaultSource: 'safe',
        notes: '',
      });
      setPaymentDraft(current => ({ ...current, employeeId: employeeRef.id }));
      setFormError(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'employees');
    }
  };

  const handleRegisterPayment = async () => {
    const amount = toPositiveNumber(paymentDraft.amount);
    const employee = activeEmployees.find(item => item.id === paymentDraft.employeeId);
    const sourceBalance = balances[paymentDraft.from] || 0;
    const paymentDate = new Date(paymentDraft.date);

    if (!employee) {
      setFormError('SELECCIONA EL EMPLEADO');
      return;
    }
    if (amount <= 0) {
      setFormError('EL MONTO DEBE SER MAYOR A 0');
      return;
    }
    if (amount > sourceBalance + 0.009) {
      setFormError(`NO ALCANZA EL SALDO EN ${boxLabels[paymentDraft.from].toUpperCase()}`);
      return;
    }
    if (Number.isNaN(paymentDate.getTime())) {
      setFormError('REVISA LA FECHA DEL PAGO');
      return;
    }

    const description = (paymentDraft.description.trim() || `${kindLabels[paymentDraft.kind]} ${employee.name}`).toUpperCase();
    const periodKey = buildPeriodKey(paymentDate.toISOString());

    try {
      const movementRef = doc(collection(db, 'movements'));
      const paymentRef = doc(collection(db, 'employee_payments'));
      const batch = writeBatch(db);

      batch.set(movementRef, {
        date: Timestamp.fromDate(paymentDate),
        type: 'outflow',
        amount,
        description,
        createdBy: user.uid,
        category: 'Sueldos',
        subcategory: kindSubcategory[paymentDraft.kind],
        from: paymentDraft.from,
        employeeId: employee.id,
        employeeName: employee.name,
        payrollKind: paymentDraft.kind,
        payrollPeriod: periodKey,
        createdAt: serverTimestamp(),
      });

      batch.set(paymentRef, {
        employeeId: employee.id,
        employeeName: employee.name,
        date: Timestamp.fromDate(paymentDate),
        amount,
        kind: paymentDraft.kind,
        from: paymentDraft.from,
        description,
        notes: paymentDraft.notes.trim() || null,
        movementId: movementRef.id,
        periodKey,
        createdBy: user.uid,
        createdAt: serverTimestamp(),
      });

      await batch.commit();

      setPaymentDraft({
        employeeId: employee.id,
        date: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
        amount: 0,
        kind: 'advance',
        from: employee.defaultSource || 'safe',
        description: '',
        notes: '',
      });
      setFormError(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'employee_payments');
    }
  };

  const handleToggleEmployee = async (employee: EmployeeProfile) => {
    try {
      await updateDoc(doc(db, 'employees', employee.id), {
        isActive: !employee.isActive,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `employees/${employee.id}`);
    }
  };

  return (
    <div className="min-h-screen bg-[#0F172A] text-slate-200 pb-16">
      <header className="sticky top-0 z-40 bg-[#1E293B]/70 backdrop-blur-md border-b border-white/5">
        <div className="w-full px-4 h-20 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <button onClick={onBack} className="w-11 h-11 rounded-2xl bg-white/5 border border-white/5 text-slate-400 hover:text-white flex items-center justify-center">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-xl font-black text-white uppercase tracking-tight">Pago al Personal</h1>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest truncate">Anticipos, nomina y control por empleado</p>
            </div>
          </div>
          <div className="hidden lg:flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-blue-300 bg-blue-500/10 border border-blue-500/20 rounded-2xl px-4 py-3">
            <Users className="w-4 h-4" />
            Modulo separado del gasto comun
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-8 space-y-6">
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Pagado en periodo</p>
            <p className="text-3xl font-black text-white">{formatMoney(summary.totalPaid)}</p>
          </div>
          <div className="bg-[#1E293B] border border-amber-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-amber-300/70 uppercase tracking-widest mb-2">Anticipos</p>
            <p className="text-3xl font-black text-amber-300">{formatMoney(summary.totalAdvances)}</p>
          </div>
          <div className="bg-[#1E293B] border border-rose-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-rose-300/70 uppercase tracking-widest mb-2">Pendiente estimado</p>
            <p className="text-3xl font-black text-rose-300">{formatMoney(summary.remaining)}</p>
          </div>
          <div className="bg-[#1E293B] border border-emerald-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-emerald-300/70 uppercase tracking-widest mb-2">Personal activo</p>
            <p className="text-3xl font-black text-emerald-300">{activeEmployees.length}</p>
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
          <div className="space-y-6">
            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2">
                    <BadgeDollarSign className="w-5 h-5 text-amber-300" />
                    Corte por empleado
                  </h2>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Lo que ya salio, anticipos y saldo por recordar</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(['este_mes', 'mes_pasado', 'custom'] as PayrollPeriod[]).map(period => (
                    <button
                      key={period}
                      onClick={() => applyPeriod(period)}
                      className={`px-3 py-2 rounded-xl border text-[9px] font-black uppercase tracking-widest ${periodType === period ? 'bg-blue-500/15 border-blue-500/50 text-blue-200' : 'bg-white/5 border-white/5 text-slate-500 hover:text-white'}`}
                    >
                      {period === 'este_mes' ? 'Este mes' : period === 'mes_pasado' ? 'Mes pasado' : 'Fechas'}
                    </button>
                  ))}
                </div>
              </div>

              {periodType === 'custom' && (
                <div className="grid grid-cols-2 gap-3 mb-5">
                  <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-2 text-xs font-bold text-white" />
                  <input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-2 text-xs font-bold text-white" />
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {employeeCards.map(employee => (
                  <div key={employee.id} className="rounded-[1.5rem] border border-white/5 bg-[#0F172A]/70 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-white uppercase">{employee.name}</p>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{employee.role || 'Sin cargo'}{employee.paymentDay ? ` - pago sugerido ${employee.paymentDay}` : ''}</p>
                      </div>
                      <span className="px-2 py-1 rounded-full text-[9px] font-black uppercase tracking-widest bg-white/5 text-slate-400">
                        {formatMoney(employee.monthlySalary)}
                      </span>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-[11px] font-black uppercase tracking-widest">
                      <div className="rounded-xl bg-white/5 p-3">
                        <p className="text-slate-500">Anticipos</p>
                        <p className="text-amber-300 text-lg mt-1">{formatMoney(employee.advances)}</p>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <p className="text-slate-500">Sueldo</p>
                        <p className="text-blue-300 text-lg mt-1">{formatMoney(employee.salaries)}</p>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <p className="text-slate-500">Bonos</p>
                        <p className="text-emerald-300 text-lg mt-1">{formatMoney(employee.bonuses)}</p>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <p className="text-slate-500">Pendiente</p>
                        <p className={`text-lg mt-1 ${employee.pending > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{formatMoney(employee.pending)}</p>
                      </div>
                    </div>
                  </div>
                ))}
                {employeeCards.length === 0 && (
                  <div className="col-span-full py-16 text-center border border-dashed border-white/10 rounded-2xl">
                    <Users className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                    <p className="text-xs font-black uppercase tracking-widest text-slate-500">Todavia no hay empleados activos registrados</p>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2">
                    <ReceiptText className="w-5 h-5 text-blue-400" />
                    Historial de pagos
                  </h2>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{filteredPayments.length} registros en pantalla</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      value={search}
                      onChange={event => setSearch(event.target.value)}
                      placeholder="Buscar empleado o nota..."
                      className="pl-9 pr-3 py-2 bg-[#0F172A] border border-white/5 rounded-xl text-xs font-bold text-white outline-none focus:border-blue-500"
                    />
                  </div>
                  <select value={selectedEmployeeId} onChange={event => setSelectedEmployeeId(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-2 text-xs font-black text-white outline-none">
                    <option value="all">Todos</option>
                    {activeEmployees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/5">
                {filteredPayments.map(payment => (
                  <div key={payment.id} className="min-h-[88px] bg-[#0F172A]/70 border-b border-white/5 last:border-b-0 px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-white uppercase">{payment.employeeName}</p>
                        <p className="text-sm font-bold text-slate-300 uppercase mt-1">{payment.description}</p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">
                          <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />{format(parseISO(payment.date), 'dd MMM yyyy HH:mm', { locale: es })}</span>
                          <span>{kindLabels[payment.kind]}</span>
                          <span>{boxLabels[payment.from]}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-lg font-black ${payment.kind === 'discount' ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {payment.kind === 'discount' ? '+' : '-'}{formatMoney(payment.amount)}
                        </p>
                        {payment.notes && <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-slate-500 max-w-[180px]">{payment.notes}</p>}
                      </div>
                    </div>
                  </div>
                ))}
                {filteredPayments.length === 0 && (
                  <div className="py-16 text-center bg-[#0F172A]/70">
                    <ReceiptText className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                    <p className="text-xs font-black uppercase tracking-widest text-slate-500">No hay pagos registrados en este periodo</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <aside className="space-y-6">
            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-5">
                <UserRound className="w-4 h-4 text-emerald-400" />
                Registrar empleado
              </h3>
              <div className="space-y-3">
                <input value={employeeDraft.name} onChange={event => setEmployeeDraft({ ...employeeDraft, name: event.target.value })} placeholder="Nombre" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-emerald-500" />
                <input value={employeeDraft.role} onChange={event => setEmployeeDraft({ ...employeeDraft, role: event.target.value })} placeholder="Cargo" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-emerald-500" />
                <div className="grid grid-cols-2 gap-3">
                  <input type="number" min="0" value={employeeDraft.monthlySalary || ''} onChange={event => setEmployeeDraft({ ...employeeDraft, monthlySalary: toPositiveNumber(event.target.value) })} placeholder="Sueldo mensual" className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                  <input type="number" min="1" max="31" value={employeeDraft.paymentDay || 30} onChange={event => setEmployeeDraft({ ...employeeDraft, paymentDay: Number(event.target.value || 30) })} placeholder="Dia de pago" className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                </div>
                <select value={employeeDraft.defaultSource} onChange={event => setEmployeeDraft({ ...employeeDraft, defaultSource: event.target.value as BusinessBox })} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none">
                  {Object.entries(boxLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input value={employeeDraft.notes} onChange={event => setEmployeeDraft({ ...employeeDraft, notes: event.target.value })} placeholder="Notas opcionales" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                <button onClick={handleCreateEmployee} className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" />
                  Guardar empleado
                </button>
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-5">
                <Coins className="w-4 h-4 text-amber-300" />
                Registrar pago
              </h3>
              <div className="space-y-3">
                <select
                  value={paymentDraft.employeeId}
                  onChange={event => {
                    const employee = activeEmployees.find(item => item.id === event.target.value);
                    setPaymentDraft({
                      ...paymentDraft,
                      employeeId: event.target.value,
                      from: employee?.defaultSource || 'safe',
                    });
                  }}
                  className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none"
                >
                  <option value="">Empleado</option>
                  {activeEmployees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                </select>
                <div className="grid grid-cols-2 gap-3">
                  <input type="datetime-local" value={paymentDraft.date} onChange={event => setPaymentDraft({ ...paymentDraft, date: event.target.value })} className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                  <input type="number" min="0" value={paymentDraft.amount || ''} onChange={event => setPaymentDraft({ ...paymentDraft, amount: toPositiveNumber(event.target.value) })} placeholder="Monto" className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-2xl font-black text-white outline-none" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <select value={paymentDraft.kind} onChange={event => setPaymentDraft({ ...paymentDraft, kind: event.target.value as PayrollKind })} className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none">
                    {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <select value={paymentDraft.from} onChange={event => setPaymentDraft({ ...paymentDraft, from: event.target.value as BusinessBox })} className="bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none">
                    {Object.entries(boxLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <input value={paymentDraft.description} onChange={event => setPaymentDraft({ ...paymentDraft, description: event.target.value })} placeholder="Detalle del pago" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                <input value={paymentDraft.notes} onChange={event => setPaymentDraft({ ...paymentDraft, notes: event.target.value })} placeholder="Notas o referencia" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                {selectedEmployee && selectedEmployeeCard && (
                  <div className="rounded-xl bg-blue-500/10 border border-blue-500/20 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-blue-200">
                    Pendiente estimado de {selectedEmployee.name}: {formatMoney(Math.max(0, selectedEmployeeCard.pending))}
                  </div>
                )}
                {formError && <p className="text-xs font-black text-rose-400 uppercase">{formError}</p>}
                <button onClick={handleRegisterPayment} className="w-full py-4 bg-blue-600 hover:bg-blue-500 rounded-xl text-white text-xs font-black uppercase tracking-widest">
                  Registrar pago
                </button>
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-4">
                <Landmark className="w-4 h-4 text-slate-400" />
                Cajas disponibles
              </h3>
              <div className="space-y-2">
                {Object.entries(balances).map(([box, amount]) => (
                  <div key={box} className="flex items-center justify-between rounded-xl bg-[#0F172A] border border-white/5 px-3 py-3">
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{boxLabels[box as BusinessBox]}</span>
                    <span className="text-sm font-black text-white">{formatMoney(amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-4">
                <Wallet className="w-4 h-4 text-purple-300" />
                Estado del personal
              </h3>
              <div className="space-y-2">
                {employees.map(employee => (
                  <div key={employee.id} className="flex items-center justify-between gap-3 rounded-xl bg-[#0F172A] border border-white/5 px-3 py-3">
                    <div className="min-w-0">
                      <p className="text-xs font-black text-white uppercase truncate">{employee.name}</p>
                      <p className="text-[9px] font-black text-slate-500 uppercase">{employee.isActive ? 'Activo' : 'Archivado'}</p>
                    </div>
                    <button onClick={() => handleToggleEmployee(employee)} className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase ${employee.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-400'}`}>
                      {employee.isActive ? 'Activo' : 'Oculto'}
                    </button>
                  </div>
                ))}
                {employees.length === 0 && <p className="text-xs font-bold text-slate-500">Aun no hay fichas de empleados.</p>}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
