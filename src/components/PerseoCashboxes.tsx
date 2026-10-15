import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, RefreshCw, X } from 'lucide-react';
import { auth } from '../firebase';

type Month = { month: string; count: number };
type Box = { id: number; name: string; balanceCents: number; lastMovementDate: string | null; months: Month[] };
type Movement = { id: number; date: string; recordedAt: string; amountCents: number; type: string; description: string; reference: string };
type Summary = { collectedAt: string | null; boxes: Box[] };

const BOX_LABELS: Record<number, string> = {
  1: 'Esperado',
  2: 'Ganancias',
  3: 'Ganancias CNB',
  12: 'Compra PDV',
};
const money = (cents: number) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(cents / 100);
const dateTime = (value: string) => new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Guayaquil' }).format(new Date(value));

async function privateGet<T>(url: string): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Vuelve a iniciar sesión para consultar Perseo.');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo consultar Perseo.');
  return data as T;
}

export function PerseoCashboxes() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Box | null>(null);
  const [month, setMonth] = useState('');
  const [movements, setMovements] = useState<Movement[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await privateGet<Summary>('/api/perseo/cashboxes');
      setSummary(data);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo consultar Perseo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selected || !month) return;
    let active = true;
    setHistoryLoading(true);
    setHistoryError('');
    setMovements([]);
    void privateGet<{ movements: Movement[] }>(`/api/perseo/cashboxes?boxId=${selected.id}&month=${encodeURIComponent(month)}`)
      .then(data => { if (active) setMovements(data.movements); })
      .catch(cause => { if (active) setHistoryError(cause instanceof Error ? cause.message : 'No se pudo cargar el historial.'); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [selected, month]);

  const stale = summary?.collectedAt ? Date.now() - Date.parse(summary.collectedAt) > 24 * 60 * 60_000 : false;
  const openBox = (box: Box) => {
    setSelected(box);
    setMonth(box.months[box.months.length - 1]?.month || '');
  };

  return (
    <section className="mb-8 sm:mb-12 text-left" aria-labelledby="perseo-cashboxes-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="perseo-cashboxes-title" className="text-lg sm:text-xl font-black text-white">Cajas de Perseo</h2>
          <p className="mt-1 text-xs text-slate-400">Consulta de solo lectura · Saldo e historial de las cajas seleccionadas</p>
          {summary?.collectedAt && <p className={`mt-1 text-xs font-semibold ${stale ? 'text-amber-300' : 'text-slate-400'}`}>Actualizado: {dateTime(summary.collectedAt)}{stale ? ' · Datos atrasados' : ''}</p>}
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50" aria-label="Actualizar cajas de Perseo">
          <RefreshCw className="h-4 w-4" /> Actualizar vista
        </button>
      </div>
      {error && <p role="alert" className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
      {!loading && !summary?.collectedAt && !error && <p className="rounded-2xl border border-white/10 bg-[#1E293B] p-5 text-sm text-slate-300">Aún no hay datos sincronizados desde Perseo. Los saldos aparecerán tras la primera sincronización local.</p>}
      {loading && !summary && <p className="rounded-2xl border border-white/10 bg-[#1E293B] p-5 text-sm text-slate-300">Cargando cajas de Perseo…</p>}
      {!!summary?.boxes.length && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summary.boxes.map(box => <button key={box.id} type="button" onClick={() => openBox(box)} className="min-h-32 rounded-2xl border border-cyan-500/20 bg-[#1E293B] p-5 text-left transition-colors hover:border-cyan-400/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
          <span className="flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wide text-cyan-300"><span>{BOX_LABELS[box.id] || box.name}</span><ChevronRight className="h-4 w-4 shrink-0" /></span>
          <span className="mt-3 block text-2xl font-black text-white">{money(box.balanceCents)}</span>
          <span className="mt-2 block text-xs text-slate-400">Último movimiento: {box.lastMovementDate || 'Sin movimientos'}</span>
        </button>)}
      </div>}

      {selected && <div className="fixed inset-0 z-[180] flex items-end justify-center bg-slate-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}>
        <div role="dialog" aria-modal="true" aria-label={`Historial de ${BOX_LABELS[selected.id]}`} className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-[#0F172A] shadow-2xl sm:rounded-3xl">
          <div className="flex items-start justify-between gap-4 border-b border-white/10 p-5">
            <div><h3 className="text-lg font-black text-white">{BOX_LABELS[selected.id]}</h3><p className="text-sm text-slate-400">Saldo Perseo: <span className="font-bold text-white">{money(selected.balanceCents)}</span></p></div>
            <button type="button" onClick={() => setSelected(null)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/5 text-white" aria-label="Cerrar historial"><X className="h-5 w-5" /></button>
          </div>
          <div className="border-b border-white/10 px-5 py-3"><label htmlFor="perseo-history-month" className="mr-3 text-xs font-bold text-slate-300">Mes</label><select id="perseo-history-month" value={month} onChange={event => setMonth(event.target.value)} className="min-h-11 rounded-xl border border-white/10 bg-slate-800 px-3 text-sm text-white">{selected.months.slice().reverse().map(item => <option key={item.month} value={item.month}>{item.month} · {item.count} movimientos</option>)}</select></div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {historyLoading && <p className="text-sm text-slate-400">Cargando movimientos…</p>}
            {historyError && <p role="alert" className="text-sm text-rose-300">{historyError}</p>}
            {!historyLoading && !historyError && movements.length === 0 && <p className="text-sm text-slate-400">No hay movimientos este mes.</p>}
            <div className="space-y-2">{movements.slice().reverse().map(item => <div key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/5 bg-slate-800/60 p-3">
              <div className="min-w-0"><p className="break-words text-sm font-semibold text-white">{item.description || item.type}</p><p className="mt-1 text-xs text-slate-400">{item.date} · {item.type}{item.reference ? ` · ${item.reference}` : ''}</p></div>
              <span className={`shrink-0 text-sm font-black ${item.amountCents < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{money(item.amountCents)}</span>
            </div>)}</div>
          </div>
        </div>
      </div>}
    </section>
  );
}
