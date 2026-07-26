import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  Calendar,
  Check,
  CreditCard,
  FileText,
  Landmark,
  Plus,
  Wallet,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { UserProfile } from '../types';

type BusinessBoxKey = 'safe' | 'transit' | 'bank';

type CreditInstallment = {
  installmentNumber: number;
  dueDate: string;
  paymentAmount: number;
  principalAmount: number;
  interestAmount: number;
  feesAmount: number;
  remainingBalance: number;
  paidAmount: number;
  status: 'pending' | 'partial' | 'paid' | string;
  paidAt?: string | null;
};

type BusinessCredit = {
  id: string;
  name: string;
  lender: string;
  principalAmount: number;
  openingBalance: number;
  currentBalance: number;
  monthlyPayment: number;
  startDate: string;
  endDate?: string | null;
  notes?: string;
  status?: 'active' | 'paid' | string;
  installments: CreditInstallment[];
};

type BusinessCreditPayment = {
  id: string;
  creditId: string;
  creditName: string;
  lender: string;
  installmentNumber: number;
  date: string;
  amount: number;
  fromBox: BusinessBoxKey;
  description: string;
};

type BusinessCreditsModuleProps = {
  user: UserProfile;
  onBack: () => void;
  balances: Record<BusinessBoxKey, number>;
};

const businessBoxLabels: Record<BusinessBoxKey, string> = {
  safe: 'Tienda',
  transit: 'Transito',
  bank: 'Banco',
};

const toPositiveAmount = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : 0;
};

const parseMoneyValue = (value: string) => {
  const normalized = value
    .replace(/\$/g, '')
    .replace(/\s+/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(/,/g, '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
};

const normalizeDate = (value: any) => {
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
};

const normalizeInstallmentStatus = (item: Partial<CreditInstallment>) => {
  const paymentAmount = toPositiveAmount(item.paymentAmount);
  const paidAmount = Math.max(0, Number(item.paidAmount || 0));
  if (paymentAmount > 0 && paidAmount >= paymentAmount - 0.01) return 'paid';
  if (paidAmount > 0) return 'partial';
  return 'pending';
};

const parseAmortizationTable = (input: string, principalFallback: number) => {
  const rows = input
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const parsedRows = rows
    .map((line, index) => {
      const columns = line
        .split(/[|\t;,]+/)
        .map(cell => cell.trim())
        .filter(Boolean);

      if (columns.length < 3) return null;

      const explicitNumber = Number(columns[0]);
      return {
        installmentNumber: Number.isFinite(explicitNumber) && explicitNumber > 0 ? explicitNumber : index + 1,
        dueDate: columns[1] || format(new Date(), 'yyyy-MM-dd'),
        paymentAmount: parseMoneyValue(columns[2] || '0'),
        principalAmount: parseMoneyValue(columns[3] || '0'),
        interestAmount: parseMoneyValue(columns[4] || '0'),
        feesAmount: parseMoneyValue(columns[5] || '0'),
        remainingBalance: parseMoneyValue(columns[6] || '0'),
        paidAmount: 0,
        status: 'pending',
      } as CreditInstallment;
    })
    .filter((row): row is CreditInstallment => Boolean(row && row.paymentAmount > 0));

  if (parsedRows.length === 0) return [];

  let runningBalance = principalFallback > 0 ? principalFallback : parsedRows.reduce((sum, row) => sum + row.principalAmount, 0);
  return parsedRows.map((row, index) => {
    const explicitBalance = row.remainingBalance > 0 ? row.remainingBalance : 0;
    if (explicitBalance > 0) {
      runningBalance = explicitBalance;
    } else {
      runningBalance = Math.max(0, runningBalance - row.principalAmount);
    }

    return {
      ...row,
      installmentNumber: row.installmentNumber || index + 1,
      remainingBalance: Number(runningBalance.toFixed(2)),
      status: 'pending',
      paidAmount: 0,
    };
  });
};

export function BusinessCreditsModule({ user, onBack, balances }: BusinessCreditsModuleProps) {
  const [credits, setCredits] = useState<BusinessCredit[]>([]);
  const [payments, setPayments] = useState<BusinessCreditPayment[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [creditDraft, setCreditDraft] = useState({
    name: '',
    lender: '',
    principalAmount: 0,
    monthlyPayment: 0,
    startDate: format(new Date(), 'yyyy-MM-dd'),
    notes: '',
    amortizationText: '',
  });
  const [paymentDraft, setPaymentDraft] = useState({
    creditId: '',
    installmentNumber: '',
    amount: 0,
    fromBox: 'bank' as BusinessBoxKey,
    date: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    description: '',
  });

  useEffect(() => {
    const unsubscribeCredits = onSnapshot(
      query(collection(db, 'businessCredits'), orderBy('createdAt', 'desc')),
      (snapshot) => {
        setCredits(snapshot.docs.map((item) => {
          const data = item.data();
          return {
            id: item.id,
            name: String(data.name || 'CREDITO'),
            lender: String(data.lender || 'BANCO'),
            principalAmount: Number(data.principalAmount || 0),
            openingBalance: Number(data.openingBalance || data.principalAmount || 0),
            currentBalance: Number(data.currentBalance || data.openingBalance || data.principalAmount || 0),
            monthlyPayment: Number(data.monthlyPayment || 0),
            startDate: normalizeDate(data.startDate),
            endDate: data.endDate ? normalizeDate(data.endDate) : null,
            notes: String(data.notes || ''),
            status: String(data.status || 'active'),
            installments: Array.isArray(data.installments)
              ? data.installments.map((row: any) => ({
                  installmentNumber: Number(row.installmentNumber || 0),
                  dueDate: normalizeDate(row.dueDate),
                  paymentAmount: Number(row.paymentAmount || 0),
                  principalAmount: Number(row.principalAmount || 0),
                  interestAmount: Number(row.interestAmount || 0),
                  feesAmount: Number(row.feesAmount || 0),
                  remainingBalance: Number(row.remainingBalance || 0),
                  paidAmount: Number(row.paidAmount || 0),
                  status: row.status || 'pending',
                  paidAt: row.paidAt ? normalizeDate(row.paidAt) : null,
                }))
              : [],
          };
        }));
      }
    );

    const unsubscribePayments = onSnapshot(
      query(collection(db, 'businessCreditPayments'), orderBy('date', 'desc')),
      (snapshot) => {
        setPayments(snapshot.docs.map((item) => {
          const data = item.data();
          return {
            id: item.id,
            creditId: String(data.creditId || ''),
            creditName: String(data.creditName || ''),
            lender: String(data.lender || ''),
            installmentNumber: Number(data.installmentNumber || 0),
            date: normalizeDate(data.date),
            amount: Number(data.amount || 0),
            fromBox: (data.fromBox || 'bank') as BusinessBoxKey,
            description: String(data.description || ''),
          };
        }));
      }
    );

    return () => {
      unsubscribeCredits();
      unsubscribePayments();
    };
  }, []);

  const creditById = useMemo(() => new Map(credits.map(item => [item.id, item])), [credits]);

  const creditSummaries = useMemo(() => {
    return credits.map((credit) => {
      const nextInstallment = credit.installments.find(item => normalizeInstallmentStatus(item) !== 'paid') || null;
      const paidInstallments = credit.installments.filter(item => normalizeInstallmentStatus(item) === 'paid').length;
      return { credit, nextInstallment, paidInstallments };
    });
  }, [credits]);

  const totalOutstanding = useMemo(
    () => credits.reduce((sum, credit) => sum + Number(credit.currentBalance || 0), 0),
    [credits]
  );

  const totalMonthlyCommitment = useMemo(
    () => credits.reduce((sum, credit) => sum + Number(credit.monthlyPayment || 0), 0),
    [credits]
  );

  const selectedCredit = paymentDraft.creditId ? creditById.get(paymentDraft.creditId) || null : null;
  const selectedInstallment = useMemo(() => {
    if (!selectedCredit) return null;
    const explicit = Number(paymentDraft.installmentNumber || 0);
    if (explicit > 0) {
      return selectedCredit.installments.find(item => item.installmentNumber === explicit) || null;
    }
    return selectedCredit.installments.find(item => normalizeInstallmentStatus(item) !== 'paid') || null;
  }, [paymentDraft.installmentNumber, selectedCredit]);

  const handleAmortizationFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCreditDraft(current => ({ ...current, amortizationText: text }));
  };

  const handleCreateCredit = async () => {
    const name = creditDraft.name.trim().toUpperCase();
    const lender = creditDraft.lender.trim().toUpperCase();
    const principalAmount = toPositiveAmount(creditDraft.principalAmount);
    const monthlyPayment = toPositiveAmount(creditDraft.monthlyPayment);
    const installments = parseAmortizationTable(creditDraft.amortizationText, principalAmount);

    if (!name) {
      setFormError('INGRESA EL NOMBRE DEL CREDITO');
      return;
    }
    if (!lender) {
      setFormError('INGRESA EL BANCO O ENTIDAD');
      return;
    }
    if (principalAmount <= 0) {
      setFormError('EL MONTO DEL CREDITO DEBE SER MAYOR A 0');
      return;
    }
    if (installments.length === 0) {
      setFormError('PEGA O ADJUNTA LA TABLA DE AMORTIZACION');
      return;
    }

    const openingBalance = Math.max(principalAmount, ...installments.map(item => item.remainingBalance || 0));

    try {
      await addDoc(collection(db, 'businessCredits'), {
        name,
        lender,
        principalAmount,
        openingBalance: Number(openingBalance.toFixed(2)),
        currentBalance: Number(openingBalance.toFixed(2)),
        monthlyPayment: monthlyPayment || installments[0]?.paymentAmount || 0,
        startDate: Timestamp.fromDate(new Date(`${creditDraft.startDate}T00:00:00`)),
        endDate: Timestamp.fromDate(new Date(parseISO(installments[installments.length - 1].dueDate))),
        notes: creditDraft.notes.trim().slice(0, 1200),
        status: 'active',
        installments: installments.map(item => ({
          ...item,
          dueDate: Timestamp.fromDate(new Date(parseISO(item.dueDate))),
          paidAt: null,
        })),
        createdBy: user.uid,
        createdByName: user.displayName || user.email || '',
        createdAt: serverTimestamp(),
      });

      setCreditDraft({
        name: '',
        lender: '',
        principalAmount: 0,
        monthlyPayment: 0,
        startDate: format(new Date(), 'yyyy-MM-dd'),
        notes: '',
        amortizationText: '',
      });
      setFormError(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'businessCredits');
      setFormError('NO SE PUDO CREAR EL CREDITO');
    }
  };

  const handleSelectCredit = (creditId: string) => {
    const credit = creditById.get(creditId);
    const nextInstallment = credit?.installments.find(item => normalizeInstallmentStatus(item) !== 'paid') || null;
    setPaymentDraft(current => ({
      ...current,
      creditId,
      installmentNumber: nextInstallment ? String(nextInstallment.installmentNumber) : '',
      amount: nextInstallment ? Number(Math.max(0, nextInstallment.paymentAmount - nextInstallment.paidAmount).toFixed(2)) : 0,
      description: credit ? `PAGO CREDITO ${credit.name}` : '',
    }));
  };

  const handlePayInstallment = async () => {
    if (!selectedCredit) {
      setFormError('SELECCIONA EL CREDITO');
      return;
    }

    const amount = toPositiveAmount(paymentDraft.amount);
    const installment = selectedInstallment;
    if (!installment) {
      setFormError('ESTE CREDITO YA NO TIENE CUOTAS PENDIENTES');
      return;
    }
    if (amount <= 0) {
      setFormError('EL MONTO DEBE SER MAYOR A 0');
      return;
    }

    const nextPaidAmount = Number((Number(installment.paidAmount || 0) + amount).toFixed(2));
    const updatedInstallments = selectedCredit.installments.map(item => {
      if (item.installmentNumber !== installment.installmentNumber) return item;
      return {
        ...item,
        paidAmount: nextPaidAmount,
        status: normalizeInstallmentStatus({ paymentAmount: item.paymentAmount, paidAmount: nextPaidAmount }),
        paidAt: new Date(paymentDraft.date).toISOString(),
      };
    });

    const totalPrincipalPaid = updatedInstallments.reduce((sum, item) => {
      const paymentAmount = Number(item.paymentAmount || 0);
      if (paymentAmount <= 0) return sum;
      const paidRatio = Math.min(1, Math.max(0, Number(item.paidAmount || 0)) / paymentAmount);
      return sum + (Number(item.principalAmount || 0) * paidRatio);
    }, 0);

    const currentBalance = Number(Math.max(0, Number(selectedCredit.openingBalance || selectedCredit.principalAmount || 0) - totalPrincipalPaid).toFixed(2));
    const allPaid = updatedInstallments.every(item => normalizeInstallmentStatus(item) === 'paid');
    const paidDate = new Date(paymentDraft.date);

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'businessCredits', selectedCredit.id), {
        installments: updatedInstallments.map(item => ({
          ...item,
          dueDate: Timestamp.fromDate(parseISO(item.dueDate)),
          paidAt: item.paidAt ? Timestamp.fromDate(parseISO(item.paidAt)) : null,
        })),
        currentBalance,
        status: allPaid ? 'paid' : 'active',
        updatedAt: serverTimestamp(),
      });

      batch.set(doc(collection(db, 'businessCreditPayments')), {
        creditId: selectedCredit.id,
        creditName: selectedCredit.name,
        lender: selectedCredit.lender,
        installmentNumber: installment.installmentNumber,
        date: Timestamp.fromDate(Number.isNaN(paidDate.getTime()) ? new Date() : paidDate),
        amount,
        fromBox: paymentDraft.fromBox,
        description: (paymentDraft.description.trim().toUpperCase() || `PAGO CREDITO ${selectedCredit.name}`).slice(0, 500),
        createdBy: user.uid,
        createdByName: user.displayName || user.email || '',
        createdAt: serverTimestamp(),
      });

      batch.set(doc(collection(db, 'movements')), {
        date: Timestamp.fromDate(Number.isNaN(paidDate.getTime()) ? new Date() : paidDate),
        type: 'outflow',
        category: 'Financiero',
        subcategory: 'Pago credito',
        tags: ['CREDITO', selectedCredit.lender].filter(Boolean).slice(0, 8),
        amount,
        description: (paymentDraft.description.trim().toUpperCase() || `PAGO CREDITO ${selectedCredit.name}`).slice(0, 500),
        createdBy: user.uid,
        from: paymentDraft.fromBox,
        to: 'credit',
        createdAt: serverTimestamp(),
        creditId: selectedCredit.id,
        creditName: selectedCredit.name,
        creditInstallmentNumber: installment.installmentNumber,
        source: 'credit_payment',
      });

      await batch.commit();

      const nextRemaining = Math.max(0, installment.paymentAmount - nextPaidAmount);
      setPaymentDraft({
        creditId: selectedCredit.id,
        installmentNumber: '',
        amount: nextRemaining > 0 ? nextRemaining : 0,
        fromBox: paymentDraft.fromBox,
        date: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
        description: `PAGO CREDITO ${selectedCredit.name}`,
      });
      setFormError(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `businessCredits/${selectedCredit.id}`);
      setFormError('NO SE PUDO REGISTRAR EL PAGO DEL CREDITO');
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
              <h1 className="text-xl font-black text-white uppercase tracking-tight">Creditos del negocio</h1>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest truncate">Tabla de amortizacion, cuotas y saldo pendiente real</p>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-4 py-3">
            <Landmark className="w-4 h-4" />
            Obligaciones financieras del negocio
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-8 space-y-8">
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Saldo pendiente total</p>
            <p className="text-3xl font-black text-white">${totalOutstanding.toLocaleString('es-CL')}</p>
          </div>
          <div className="bg-[#1E293B] border border-amber-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-amber-300/70 uppercase tracking-widest mb-2">Compromiso mensual</p>
            <p className="text-3xl font-black text-amber-300">${totalMonthlyCommitment.toLocaleString('es-CL')}</p>
          </div>
          <div className="bg-[#1E293B] border border-cyan-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-cyan-300/70 uppercase tracking-widest mb-2">Creditos activos</p>
            <p className="text-3xl font-black text-cyan-300">{credits.filter(item => item.status !== 'paid').length}</p>
          </div>
          <div className="bg-[#1E293B] border border-emerald-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-emerald-300/70 uppercase tracking-widest mb-2">Pagos registrados</p>
            <p className="text-3xl font-black text-emerald-300">{payments.length}</p>
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-6">
          <div className="space-y-6">
            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <div className="flex items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-amber-300" />
                    Cartera de creditos
                  </h2>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{credits.length} creditos cargados</p>
                </div>
              </div>

              <div className="space-y-4">
                {creditSummaries.map(({ credit, nextInstallment, paidInstallments }) => (
                  <div key={credit.id} className="rounded-[1.75rem] border border-white/5 bg-[#0F172A]/70 p-5">
                    <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <h3 className="text-base font-black text-white uppercase">{credit.name}</h3>
                          <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest ${credit.status === 'paid' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>
                            {credit.status === 'paid' ? 'Pagado' : 'Activo'}
                          </span>
                        </div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{credit.lender}</p>
                        <div className="flex flex-wrap gap-4 mt-4 text-[11px] font-bold text-slate-300">
                          <span>Capital: ${credit.principalAmount.toLocaleString('es-CL')}</span>
                          <span>Saldo: ${credit.currentBalance.toLocaleString('es-CL')}</span>
                          <span>Cuota: ${credit.monthlyPayment.toLocaleString('es-CL')}</span>
                          <span>{paidInstallments}/{credit.installments.length} cuotas</span>
                        </div>
                        {credit.notes && <p className="mt-3 text-xs text-slate-400">{credit.notes}</p>}
                      </div>

                      <div className="shrink-0 lg:text-right">
                        {nextInstallment ? (
                          <>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Siguiente cuota</p>
                            <p className="text-2xl font-black text-amber-300">${Math.max(0, nextInstallment.paymentAmount - nextInstallment.paidAmount).toLocaleString('es-CL')}</p>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mt-1">
                              #{nextInstallment.installmentNumber} - {format(parseISO(nextInstallment.dueDate), 'dd MMM yyyy', { locale: es })}
                            </p>
                          </>
                        ) : (
                          <p className="text-sm font-black uppercase tracking-widest text-emerald-300">Sin cuotas pendientes</p>
                        )}
                        <button
                          type="button"
                          onClick={() => handleSelectCredit(credit.id)}
                          className="mt-4 px-4 py-2 rounded-xl bg-amber-500/15 border border-amber-500/20 text-[10px] font-black uppercase tracking-widest text-amber-200"
                        >
                          Pagar este credito
                        </button>
                      </div>
                    </div>

                    <div className="mt-5 overflow-hidden rounded-2xl border border-white/5">
                      {credit.installments.slice(0, 6).map(item => {
                        const due = format(parseISO(item.dueDate), 'dd MMM yyyy', { locale: es });
                        const pending = Math.max(0, Number(item.paymentAmount || 0) - Number(item.paidAmount || 0));
                        return (
                          <div key={`${credit.id}-${item.installmentNumber}`} className="grid grid-cols-[90px_1fr_120px] gap-3 items-center px-4 py-3 border-b border-white/5 last:border-b-0">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Cuota {item.installmentNumber}</p>
                              <p className="text-xs font-bold text-slate-300">{due}</p>
                            </div>
                            <div>
                              <p className="text-sm font-black text-white">${item.paymentAmount.toLocaleString('es-CL')}</p>
                              <p className="text-[10px] font-bold text-slate-500">Capital ${item.principalAmount.toLocaleString('es-CL')} / Interes ${item.interestAmount.toLocaleString('es-CL')}</p>
                            </div>
                            <div className="text-right">
                              <p className={`text-xs font-black uppercase tracking-widest ${normalizeInstallmentStatus(item) === 'paid' ? 'text-emerald-300' : normalizeInstallmentStatus(item) === 'partial' ? 'text-amber-300' : 'text-slate-400'}`}>
                                {normalizeInstallmentStatus(item) === 'paid' ? 'Pagada' : normalizeInstallmentStatus(item) === 'partial' ? 'Parcial' : 'Pendiente'}
                              </p>
                              <p className="text-xs font-bold text-slate-400">Falta ${pending.toLocaleString('es-CL')}</p>
                            </div>
                          </div>
                        );
                      })}
                      {credit.installments.length > 6 && (
                        <div className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 bg-[#0B1220]">
                          Se muestran las primeras 6 cuotas. El saldo total sigue calculandose con toda la tabla.
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {credits.length === 0 && (
                  <div className="py-16 text-center border border-dashed border-white/10 rounded-2xl">
                    <CreditCard className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                    <p className="text-xs font-black uppercase tracking-widest text-slate-500">Todavia no hay creditos del negocio</p>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2 mb-5">
                <Wallet className="w-5 h-5 text-emerald-300" />
                Historial de pagos
              </h2>
              <div className="overflow-hidden rounded-2xl border border-white/5">
                {payments.slice(0, 20).map(item => (
                  <div key={item.id} className="flex items-start justify-between gap-4 px-4 py-3 bg-[#0F172A]/70 border-b border-white/5 last:border-b-0">
                    <div className="min-w-0">
                      <p className="text-sm font-black text-white uppercase">{item.creditName}</p>
                      <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
                        {item.lender} - cuota {item.installmentNumber} - {businessBoxLabels[item.fromBox]}
                      </p>
                      <p className="mt-2 text-xs text-slate-400">{item.description}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-lg font-black text-rose-300">-${item.amount.toLocaleString('es-CL')}</p>
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                        {format(parseISO(item.date), 'dd MMM yyyy HH:mm', { locale: es })}
                      </p>
                    </div>
                  </div>
                ))}
                {payments.length === 0 && (
                  <div className="py-12 text-center bg-[#0F172A]/70">
                    <Calendar className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                    <p className="text-xs font-black uppercase tracking-widest text-slate-500">Aun no hay pagos registrados</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <aside className="space-y-6">
            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-5">
                <Plus className="w-4 h-4 text-amber-300" />
                Crear credito
              </h3>
              <div className="space-y-3">
                <input value={creditDraft.name} onChange={event => setCreditDraft({ ...creditDraft, name: event.target.value })} placeholder="Nombre del credito" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-amber-500" />
                <input value={creditDraft.lender} onChange={event => setCreditDraft({ ...creditDraft, lender: event.target.value })} placeholder="Banco o entidad" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-amber-500" />
                <div className="grid grid-cols-2 gap-3">
                  <input type="number" min="0" value={creditDraft.principalAmount || ''} onChange={event => setCreditDraft({ ...creditDraft, principalAmount: toPositiveAmount(event.target.value) })} placeholder="Monto total" className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-3 text-sm font-black text-white outline-none" />
                  <input type="number" min="0" value={creditDraft.monthlyPayment || ''} onChange={event => setCreditDraft({ ...creditDraft, monthlyPayment: toPositiveAmount(event.target.value) })} placeholder="Cuota referencial" className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-3 text-sm font-black text-white outline-none" />
                </div>
                <input type="date" value={creditDraft.startDate} onChange={event => setCreditDraft({ ...creditDraft, startDate: event.target.value })} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                <textarea value={creditDraft.notes} onChange={event => setCreditDraft({ ...creditDraft, notes: event.target.value })} placeholder="Notas del credito" rows={3} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none resize-none" />
                <div className="rounded-2xl border border-dashed border-white/10 p-4 bg-[#0F172A]/70">
                  <div className="flex items-center gap-2 mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">
                    <FileText className="w-4 h-4" />
                    Tabla de amortizacion
                  </div>
                  <p className="text-[11px] text-slate-500 mb-3">Pega filas asi: numero | fecha | cuota | capital | interes | otros | saldo</p>
                  <textarea value={creditDraft.amortizationText} onChange={event => setCreditDraft({ ...creditDraft, amortizationText: event.target.value })} placeholder="1 | 2026-07-30 | 185.40 | 120 | 60 | 5.40 | 3880" rows={7} className="w-full bg-[#0B1220] border border-white/5 rounded-xl px-4 py-3 text-sm font-mono text-white outline-none resize-none" />
                  <label className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/5 text-[10px] font-black uppercase tracking-widest text-slate-300 cursor-pointer">
                    <FileText className="w-4 h-4" />
                    Adjuntar csv o txt
                    <input type="file" accept=".csv,.txt" onChange={handleAmortizationFile} className="hidden" />
                  </label>
                </div>
                {formError && <p className="text-xs font-black text-rose-400 uppercase">{formError}</p>}
                <button onClick={handleCreateCredit} className="w-full py-4 bg-amber-500 hover:bg-amber-400 rounded-xl text-slate-950 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" />
                  Guardar credito
                </button>
              </div>
            </div>

            <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2 mb-5">
                <Wallet className="w-4 h-4 text-emerald-300" />
                Registrar pago
              </h3>
              <div className="space-y-3">
                <select value={paymentDraft.creditId} onChange={event => handleSelectCredit(event.target.value)} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none">
                  <option value="">Selecciona el credito</option>
                  {credits.map(item => <option key={item.id} value={item.id}>{item.name} - {item.lender}</option>)}
                </select>
                <select value={paymentDraft.installmentNumber} onChange={event => setPaymentDraft({ ...paymentDraft, installmentNumber: event.target.value })} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-xs font-black text-white outline-none">
                  <option value="">Siguiente cuota pendiente</option>
                  {selectedCredit?.installments.map(item => (
                    <option key={item.installmentNumber} value={item.installmentNumber}>
                      Cuota {item.installmentNumber} - {format(parseISO(item.dueDate), 'dd/MM/yyyy')} - {normalizeInstallmentStatus(item)}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-3 gap-3">
                  {(['safe', 'transit', 'bank'] as BusinessBoxKey[]).map(box => (
                    <button
                      key={box}
                      type="button"
                      onClick={() => setPaymentDraft({ ...paymentDraft, fromBox: box })}
                      className={`rounded-xl border px-3 py-3 text-[10px] font-black uppercase tracking-widest ${paymentDraft.fromBox === box ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200' : 'bg-[#0F172A] border-white/5 text-slate-500'}`}
                    >
                      {businessBoxLabels[box]}
                      <span className="block mt-1 text-[9px] text-slate-400">${balances[box].toLocaleString('es-CL')}</span>
                    </button>
                  ))}
                </div>
                <input type="datetime-local" value={paymentDraft.date} onChange={event => setPaymentDraft({ ...paymentDraft, date: event.target.value })} className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                <input type="number" min="0" value={paymentDraft.amount || ''} onChange={event => setPaymentDraft({ ...paymentDraft, amount: toPositiveAmount(event.target.value) })} placeholder="Monto pagado" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-2xl font-black text-white outline-none" />
                <input value={paymentDraft.description} onChange={event => setPaymentDraft({ ...paymentDraft, description: event.target.value })} placeholder="Descripcion del pago" className="w-full bg-[#0F172A] border border-white/5 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none" />
                {selectedInstallment && (
                  <div className="rounded-2xl bg-[#0F172A] border border-white/5 p-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Cuota objetivo</p>
                    <p className="mt-1 text-sm font-black text-white">Cuota {selectedInstallment.installmentNumber} - vence {format(parseISO(selectedInstallment.dueDate), 'dd MMM yyyy', { locale: es })}</p>
                    <p className="mt-2 text-xs text-slate-400">Falta por cubrir: ${Math.max(0, selectedInstallment.paymentAmount - selectedInstallment.paidAmount).toLocaleString('es-CL')}</p>
                  </div>
                )}
                <button onClick={handlePayInstallment} className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white text-xs font-black uppercase tracking-widest">
                  Registrar pago del credito
                </button>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
