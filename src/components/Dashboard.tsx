import React, { useMemo, useState } from 'react';
import { 
  PieChart, 
  Pie, 
  Cell, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer,
  LineChart,
  Line
} from 'recharts';
import { format, parseISO, startOfMonth, endOfMonth, isWithinInterval, startOfDay, endOfDay, subDays } from 'date-fns';
import { es } from 'date-fns/locale';
import { ShiftClosure, Movement } from '../types';
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Users, 
  Calendar,
  ArrowLeft,
  PieChart as PieChartIcon,
  BarChart3,
  X,
  Search,
  Building2,
  Tag,
  Wallet,
  ReceiptText,
  Eye,
  Share2,
  Repeat2,
  RefreshCw,
  ShieldCheck
} from 'lucide-react';
import { motion } from 'motion/react';

interface DashboardProps {
  closures: ShiftClosure[];
  movements: Movement[];
  onBack: () => void;
}

const COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#6366F1', '#F43F5E', '#84CC16'];

export function Dashboard({ closures, movements, onBack }: DashboardProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [dateRangeType, setDateRangeType] = useState<'semana' | 'mes' | 'siempre' | 'custom'>('mes');
  const [startDate, setStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));

  const isWithinDashboardRange = (dateString: string) => {
    if (dateRangeType === 'siempre') return true;

    const currentDate = parseISO(dateString);
    const start = startOfDay(parseISO(startDate));
    const end = endOfDay(parseISO(endDate));

    if (Number.isNaN(currentDate.getTime()) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return true;
    }

    return isWithinInterval(currentDate, { start, end });
  };

  const filteredClosures = useMemo(() => {
    return closures.filter(c => isWithinDashboardRange(c.date));
  }, [closures, startDate, endDate, dateRangeType]);

  const filteredMovements = useMemo(() => {
    return movements.filter(m => isWithinDashboardRange(m.date));
  }, [movements, startDate, endDate, dateRangeType]);

  const dateRangeLabel = useMemo(() => {
    if (dateRangeType === 'siempre') return 'Mostrando todos los registros';

    const parsedStart = parseISO(startDate);
    const parsedEnd = parseISO(endDate);

    if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
      return 'Seleccione un rango de fechas válido';
    }

    return `${format(parsedStart, 'dd/MM/yyyy')} — ${format(parsedEnd, 'dd/MM/yyyy')}`;
  }, [startDate, endDate, dateRangeType]);

  // 1. Gastos por Categoría (Outflows)
  const expensesByCategory = useMemo(() => {
    const data: Record<string, number> = {};
    filteredMovements
      .filter(m => m.type === 'outflow')
      .forEach(m => {
        const cat = m.category || 'GENERAL';
        data[cat] = (data[cat] || 0) + m.amount;
      });
    
    return Object.entries(data)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [filteredMovements]);

  // 1b. Gastos por Caja (Source Box)
  const expensesByCaja = useMemo(() => {
    const data: Record<string, number> = {};
    filteredMovements
      .filter(m => m.type === 'outflow')
      .forEach(m => {
        const box = m.from || 'GENERAL';
        data[box] = (data[box] || 0) + m.amount;
      });
    
    return Object.entries(data)
      .map(([name, value]) => ({ name: name.toUpperCase(), value }))
      .sort((a, b) => b.value - a.value);
  }, [filteredMovements]);

  const expensesByTag = useMemo(() => {
    const data: Record<string, number> = {};
    filteredMovements
      .filter(m => m.type === 'outflow')
      .forEach(m => {
        const tags = m.tags?.length ? m.tags : ['SIN ETIQUETA'];
        tags.forEach(tag => {
          data[tag] = (data[tag] || 0) + m.amount;
        });
      });

    return Object.entries(data)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [filteredMovements]);

  // 1c. Gastos Diarios
  const dailyExpenses = useMemo(() => {
    const data: Record<string, number> = {};
    filteredMovements
      .filter(m => m.type === 'outflow')
      .forEach(m => {
        const day = format(parseISO(m.date), 'dd/MM');
        data[day] = (data[day] || 0) + m.amount;
      });
    
    return Object.entries(data)
      .map(([name, expense]) => ({ name, expense }))
      .sort((a, b) => {
        const [da, ma] = a.name.split('/').map(Number);
        const [db, mb] = b.name.split('/').map(Number);
        return (ma * 100 + da) - (mb * 100 + db);
      })
      .slice(-15);
  }, [filteredMovements]);

  // 2. Ingresos por Día (Últimos 30 días)
  const dailyIncome = useMemo(() => {
    const data: Record<string, number> = {};
    filteredClosures.forEach(c => {
      const day = format(parseISO(c.date), 'dd/MM');
      data[day] = (data[day] || 0) + c.physicalAmount;
    });
    
    return Object.entries(data)
      .map(([name, income]) => ({ name, income }))
      .slice(-15); // Mostrar últimos 15 días con datos
  }, [filteredClosures]);

  // 3. Ingresos por Mes
  const monthlyIncome = useMemo(() => {
    const data: Record<string, number> = {};
    filteredClosures.forEach(c => {
      const month = format(parseISO(c.date), 'MMMM yyyy', { locale: es });
      data[month] = (data[month] || 0) + c.physicalAmount;
    });
    
    return Object.entries(data)
      .map(([name, income]) => ({ name, income }));
  }, [filteredClosures]);

  // 4. Ingresos por Cajero (Responsable)
  const incomeByCashier = useMemo(() => {
    const data: Record<string, number> = {};
    filteredClosures.forEach(c => {
      const name = c.responsible || 'Desconocido';
      data[name] = (data[name] || 0) + c.physicalAmount;
    });
    
    return Object.entries(data)
      .map(([name, income]) => ({ name, income }))
      .sort((a, b) => b.income - a.income);
  }, [filteredClosures]);

  const totalExpenses = expensesByCategory.reduce((acc, curr) => acc + curr.value, 0);
  const totalInflowMovements = filteredMovements.filter(m => m.type === 'inflow').reduce((acc, curr) => acc + curr.amount, 0);
  const totalIncome = filteredClosures.reduce((acc, curr) => acc + curr.physicalAmount, 0) + totalInflowMovements;
  const netBalance = totalIncome - totalExpenses;
  const recentExpenses = useMemo(() => {
    return filteredMovements
      .filter(m => m.type === 'outflow')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 5);
  }, [filteredMovements]);
  const statementRows = useMemo(() => {
    let runningTotal = totalExpenses;

    return recentExpenses.map(m => {
      const balanceAfter = runningTotal;
      runningTotal = Math.max(0, runningTotal - m.amount);

      return {
        ...m,
        balanceAfter,
      };
    });
  }, [recentExpenses, totalExpenses]);

  return (
    <div className="min-h-screen bg-[#0F172A] text-white p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button 
              onClick={onBack}
              className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-all text-slate-400 hover:text-white"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <div>
              <h1 className="text-3xl font-black tracking-tight">Dashboard de Reportes</h1>
              <p className="text-slate-400">Análisis detallado de ingresos y gastos.</p>
            </div>
          </div>
          
          <div className="w-full md:w-[430px] overflow-hidden rounded-[1.75rem] border border-slate-200 bg-slate-50 text-slate-900 shadow-2xl shadow-black/25">
            <div className="px-5 py-4 border-b border-slate-200 bg-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-blue-700" />
                  <span className="text-sm font-black text-slate-800">Mi cuenta</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowHistory(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-black text-blue-700"
                >
                  <ReceiptText className="w-4 h-4" />
                  Detalle
                </button>
              </div>
            </div>

            <div className="px-5 py-5 bg-white">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold text-slate-500 uppercase">Gastos totales <span className="text-amber-400">★</span></p>
                  <div className="flex items-center gap-2 mt-1">
                    <p className="text-3xl font-black tracking-tight">${totalExpenses.toLocaleString('es-CL')}</p>
                    <Eye className="w-5 h-5 text-blue-600" />
                  </div>
                  <p className="text-[11px] font-bold text-slate-400 mt-1">Balance periodo: ${netBalance.toLocaleString('es-CL')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowHistory(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 mt-4"
                >
                  <Share2 className="w-4 h-4" />
                  Compartir cuenta
                </button>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-4 px-7 py-4 border-y border-slate-200 bg-slate-50">
              {[
                { icon: Repeat2, label: 'Mover' },
                { icon: RefreshCw, label: 'Cruzar' },
                { icon: ReceiptText, label: 'Detalle' },
                { icon: ShieldCheck, label: 'Nuevo' },
              ].map(action => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => setShowHistory(true)}
                  className="flex flex-col items-center gap-1 text-blue-600"
                  title={action.label}
                >
                  <span className="w-10 h-10 rounded-full border border-slate-200 bg-white shadow-sm flex items-center justify-center">
                    <action.icon className="w-5 h-5" />
                  </span>
                  <span className="text-[9px] font-black uppercase text-slate-500">{action.label}</span>
                </button>
              ))}
            </div>

            <div className="px-4 py-4 bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-black text-slate-950">Movimientos</h3>
                <button
                  type="button"
                  onClick={() => setShowHistory(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600"
                >
                  <Calendar className="w-4 h-4" />
                  Filtrar por fechas
                </button>
              </div>

              {statementRows.length > 0 && (
                <p className="text-[11px] font-bold text-slate-500 mb-2">
                  {format(parseISO(statementRows[0].date), 'EEEE, dd MMM. yyyy', { locale: es })}
                </p>
              )}

              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                {statementRows.length > 0 ? statementRows.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setShowHistory(true)}
                    className="w-full min-h-[66px] flex items-center justify-between gap-3 border-b border-slate-200 last:border-b-0 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                  >
                    <span className="min-w-0 pr-2">
                      <span className="block text-xs font-semibold text-slate-700 leading-snug line-clamp-2">{m.description}</span>
                      <span className="block text-[10px] font-bold text-slate-400 mt-1 uppercase">{m.category || 'GENERAL'}</span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-sm font-bold text-slate-700">-${m.amount.toLocaleString('es-CL')}</span>
                      <span className="block text-xs font-semibold text-slate-500">${m.balanceAfter.toLocaleString('es-CL')}</span>
                    </span>
                  </button>
                )) : (
                  <button
                    type="button"
                    onClick={() => setShowHistory(true)}
                    className="w-full px-4 py-8 text-center text-xs font-black text-slate-400 uppercase tracking-widest"
                  >
                    Sin gastos en el periodo
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-[#1E293B]/60 backdrop-blur-xl border border-white/10 rounded-[2rem] p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Calendar className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Visualizador de fecha</p>
              <h2 className="text-lg font-black text-white">{dateRangeLabel}</h2>
              <p className="text-xs text-slate-500">{filteredClosures.length} cierres y {filteredMovements.length} movimientos en el periodo</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setStartDate(format(subDays(new Date(), 7), 'yyyy-MM-dd'));
                setEndDate(format(new Date(), 'yyyy-MM-dd'));
                setDateRangeType('semana');
              }}
              className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${dateRangeType === 'semana' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
            >
              Semana
            </button>
            <button
              type="button"
              onClick={() => {
                setStartDate(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
                setEndDate(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
                setDateRangeType('mes');
              }}
              className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${dateRangeType === 'mes' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
            >
              Este Mes
            </button>
            <button
              type="button"
              onClick={() => setDateRangeType('siempre')}
              className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${dateRangeType === 'siempre' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
            >
              Siempre
            </button>
            <div className="flex items-center bg-[#0F172A] rounded-2xl border border-white/10 p-1">
              <input
                type="date"
                value={startDate}
                onChange={e => {
                  setStartDate(e.target.value);
                  setDateRangeType('custom');
                }}
                className="bg-transparent px-3 py-2 text-xs font-sans font-bold text-white outline-none"
              />
              <span className="text-slate-600 px-1">—</span>
              <input
                type="date"
                value={endDate}
                onChange={e => {
                  setEndDate(e.target.value);
                  setDateRangeType('custom');
                }}
                className="bg-transparent px-3 py-2 text-xs font-sans font-bold text-white outline-none"
              />
            </div>
          </div>
        </div>

        {/* Charts Grid */}
        {closures.length === 0 && movements.length === 0 ? (
          <div className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-20 text-center">
            <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6">
              <BarChart3 className="w-10 h-10 text-slate-500" />
            </div>
            <h3 className="text-2xl font-black text-white mb-2">Sin datos suficientes</h3>
            <p className="text-slate-400">Registra cierres y movimientos para ver las estadísticas aquí.</p>
          </div>
        ) : filteredClosures.length === 0 && filteredMovements.length === 0 ? (
          <div className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-20 text-center">
            <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6">
              <Calendar className="w-10 h-10 text-slate-500" />
            </div>
            <h3 className="text-2xl font-black text-white mb-2">Sin datos en este periodo</h3>
            <p className="text-slate-400">Cambia el rango de fechas del visualizador para ver otros registros.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Gastos por Categoría */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8"
            >
              <div className="flex items-center gap-3 mb-8">
                <div className="p-2 bg-rose-500/10 rounded-xl">
                  <PieChartIcon className="w-5 h-5 text-rose-400" />
                </div>
                <h3 className="text-xl font-black">Gastos por Categoría</h3>
              </div>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={expensesByCategory}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {expensesByCategory.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#1E293B', border: 'none', borderRadius: '12px', color: '#fff' }}
                      formatter={(value: number) => `$${value.toLocaleString('es-CL')}`}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

            {/* Gastos por Etiqueta */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8"
            >
              <div className="flex items-center gap-3 mb-8">
                <div className="p-2 bg-blue-500/10 rounded-xl">
                  <Tag className="w-5 h-5 text-blue-400" />
                </div>
                <h3 className="text-xl font-black">Gastos por Etiqueta</h3>
              </div>
              <div className="space-y-3">
                {expensesByTag.map((entry, index) => (
                  <div key={entry.name} className="flex items-center justify-between gap-4 rounded-2xl bg-white/5 border border-white/5 px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                      <span className="text-xs font-black uppercase tracking-widest text-slate-300 truncate">{entry.name}</span>
                    </div>
                    <span className="font-mono font-black text-rose-300">${entry.value.toLocaleString('es-CL')}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Gastos por Subcategoría */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8"
            >
              <div className="flex items-center gap-3 mb-8">
                <div className="p-2 bg-purple-500/10 rounded-xl">
                  <Tag className="w-5 h-5 text-purple-400" />
                </div>
                <h3 className="text-xl font-black">Gastos por Subcategoría</h3>
              </div>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(() => {
                    const data: Record<string, number> = {};
                    filteredMovements
                      .filter(m => m.type === 'outflow' && m.subcategory)
                      .forEach(m => {
                        const sub = m.subcategory!;
                        data[sub] = (data[sub] || 0) + m.amount;
                      });
                    return Object.entries(data)
                      .map(([name, value]) => ({ name, value }))
                      .sort((a,b) => b.value - a.value)
                      .slice(0, 8);
                  })()} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={10} width={100} />
                    <Tooltip 
                      cursor={{ fill: '#ffffff05' }}
                      contentStyle={{ backgroundColor: '#1E293B', border: 'none', borderRadius: '12px', color: '#fff' }}
                      formatter={(value: number) => `$${value.toLocaleString('es-CL')}`}
                    />
                    <Bar dataKey="value" fill="#8B5CF6" radius={[0, 8, 8, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

          {/* Gastos por Caja */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8"
          >
            <div className="flex items-center gap-3 mb-8">
              <div className="p-2 bg-orange-500/10 rounded-xl">
                <Building2 className="w-5 h-5 text-orange-400" />
              </div>
              <h3 className="text-xl font-black">Gastos por Caja (Origen)</h3>
            </div>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={expensesByCaja} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={10} width={80} />
                  <Tooltip 
                    cursor={{ fill: '#ffffff05' }}
                    contentStyle={{ backgroundColor: '#1E293B', border: 'none', borderRadius: '12px', color: '#fff' }}
                    formatter={(value: number) => `$${value.toLocaleString('es-CL')}`}
                  />
                  <Bar dataKey="value" fill="#F59E0B" radius={[0, 8, 8, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Gastos Diarios */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8 lg:col-span-2"
          >
            <div className="flex items-center gap-3 mb-8">
              <div className="p-2 bg-rose-500/10 rounded-xl">
                <TrendingDown className="w-5 h-5 text-rose-400" />
              </div>
              <h3 className="text-xl font-black">Gastos Diarios (Histórico)</h3>
            </div>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dailyExpenses}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
                  <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(val) => `$${(val/1000)}k`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1E293B', border: 'none', borderRadius: '12px', color: '#fff' }}
                    formatter={(value: number) => `$${value.toLocaleString('es-CL')}`}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="expense" 
                    stroke="#F43F5E" 
                    strokeWidth={4} 
                    dot={{ r: 6, fill: '#F43F5E', strokeWidth: 2, stroke: '#fff' }}
                    activeDot={{ r: 8 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Ingresos por Cajero */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8"
          >
            <div className="flex items-center gap-3 mb-8">
              <div className="p-2 bg-blue-500/10 rounded-xl">
                <Users className="w-5 h-5 text-blue-400" />
              </div>
              <h3 className="text-xl font-black">Ingresos por Cajero</h3>
            </div>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={incomeByCashier} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={12} width={100} />
                  <Tooltip 
                    cursor={{ fill: '#ffffff05' }}
                    contentStyle={{ backgroundColor: '#1E293B', border: 'none', borderRadius: '12px', color: '#fff' }}
                    formatter={(value: number) => `$${value.toLocaleString('es-CL')}`}
                  />
                  <Bar dataKey="income" fill="#3B82F6" radius={[0, 8, 8, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Ingresos Diarios */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8 lg:col-span-2"
          >
            <div className="flex items-center gap-3 mb-8">
              <div className="p-2 bg-emerald-500/10 rounded-xl">
                <TrendingUp className="w-5 h-5 text-emerald-400" />
              </div>
              <h3 className="text-xl font-black">Ingresos Diarios (Últimos 15 días con actividad)</h3>
            </div>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dailyIncome}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
                  <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(val) => `$${(val/1000)}k`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1E293B', border: 'none', borderRadius: '12px', color: '#fff' }}
                    formatter={(value: number) => `$${value.toLocaleString('es-CL')}`}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="income" 
                    stroke="#10B981" 
                    strokeWidth={4} 
                    dot={{ r: 6, fill: '#10B981', strokeWidth: 2, stroke: '#fff' }}
                    activeDot={{ r: 8 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Ingresos Mensuales */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-[#1E293B]/50 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8 lg:col-span-2"
          >
            <div className="flex items-center gap-3 mb-8">
              <div className="p-2 bg-purple-500/10 rounded-xl">
                <Calendar className="w-5 h-5 text-purple-400" />
              </div>
              <h3 className="text-xl font-black">Balance Mensual</h3>
            </div>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyIncome}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
                  <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(val) => `$${(val/1000000)}M`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1E293B', border: 'none', borderRadius: '12px', color: '#fff' }}
                    formatter={(value: number) => `$${value.toLocaleString('es-CL')}`}
                  />
                  <Bar dataKey="income" fill="#8B5CF6" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        </div>
        )}

        {/* Modal Historial de Gastos */}
        {showHistory && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-[#0F172A] border border-white/10 rounded-[2.5rem] w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
            >
              <div className="p-8 border-b border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-rose-500/10 rounded-2xl text-rose-500">
                    <TrendingDown className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-black tracking-tight">Historial Detallado</h2>
                    <p className="text-slate-400 text-xs uppercase font-black tracking-widest">Todos los gastos registrados</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-4 flex-1 md:max-w-md">
                   <div className="relative flex-1">
                     <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                     <input 
                       type="text" 
                       placeholder="BUSCAR GASTO..."
                       className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/5 rounded-xl text-xs font-black uppercase tracking-widest outline-none focus:ring-2 focus:ring-rose-500 transition-all"
                       onInput={(e) => {
                         const val = (e.target as HTMLInputElement).value.toLowerCase();
                         const items = document.querySelectorAll('.expense-item');
                         items.forEach((item: any) => {
                           const text = item.innerText.toLowerCase();
                           item.style.display = text.includes(val) ? 'flex' : 'none';
                         });
                       }}
                     />
                   </div>
                   <button 
                    onClick={() => setShowHistory(false)}
                    className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-all"
                  >
                    <X className="w-6 h-6" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-8 pt-4">
                <div className="grid gap-8">
                  {Object.entries(
                    filteredMovements
                      .filter(m => m.type === 'outflow')
                      .reduce((groups: Record<string, typeof filteredMovements>, m) => {
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
                          TOTAL DÍA: ${dailyMovements.reduce((sum, m) => sum + m.amount, 0).toLocaleString('es-CL')}
                        </span>
                      </div>
                      
                      <div className="grid gap-3">
                        {dailyMovements
                          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                          .map(m => (
                            <div key={m.id} className="expense-item group bg-white/5 border border-white/5 hover:border-rose-500/30 hover:bg-rose-500/[0.02] rounded-3xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all">
                              <div className="flex items-center gap-4">
                                <div className="w-10 h-10 bg-rose-500/10 rounded-xl flex items-center justify-center text-rose-500 group-hover:scale-110 transition-transform">
                                  <TrendingDown size={18} strokeWidth={3} />
                                </div>
                                <div>
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                      {format(parseISO(m.date), 'HH:mm')} • {m.category || 'GENERAL'}
                                    </span>
                                    {m.from && (
                                      <span className="text-[9px] bg-white/10 text-slate-400 px-2 py-0.5 rounded-lg font-black tracking-widest uppercase">
                                        CAJA: {m.from}
                                      </span>
                                    )}
                                    {m.subcategory && (
                                      <span className="text-[9px] bg-rose-500/10 text-rose-400 px-2 py-0.5 rounded-lg font-black tracking-widest uppercase">
                                        {m.subcategory}
                                      </span>
                                    )}
                                    {m.tags?.map(tag => (
                                      <span key={tag} className="text-[9px] bg-blue-500/10 text-blue-300 px-2 py-0.5 rounded-lg font-black tracking-widest uppercase">
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                  <h4 className="text-white font-black text-sm uppercase leading-tight">{m.description}</h4>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="text-lg font-black font-mono text-rose-500">-${m.amount.toLocaleString('es-CL')}</p>
                                <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Ref: {m.id.slice(0, 8)}</p>
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                  
                  {filteredMovements.filter(m => m.type === 'outflow').length === 0 && (
                    <div className="text-center py-20 bg-white/5 rounded-[2rem] border border-dashed border-white/10">
                      <div className="w-16 h-16 bg-slate-500/10 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-500">
                        <TrendingDown size={32} />
                      </div>
                      <p className="text-slate-500 font-black uppercase tracking-[0.2em] text-xs">No hay gastos para mostrar</p>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="p-6 border-t border-white/5 bg-white/[0.02] flex justify-between items-center px-10">
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Resumen Histórico</span>
                <span className="text-xl font-black font-mono text-rose-500">
                  -${filteredMovements.filter(m => m.type === 'outflow').reduce((s, m) => s + m.amount,0).toLocaleString('es-CL')}
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </div>
  );
}
