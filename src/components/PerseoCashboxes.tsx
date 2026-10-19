import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowDownLeft, ArrowUp, ArrowUpRight, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Filter, RefreshCw, Search, SlidersHorizontal, Wallet, X } from 'lucide-react';
import { auth } from '../firebase';
import { cashboxCell, cashboxCsv, cashboxText, cashboxType, filterCashboxRows, isCashboxDate, isCashboxNumericColumn } from '../lib/perseoCashboxLedger';
import type { CashboxColumn, CashboxFilter, CashboxFilters, CashboxLedger, CashboxRow, CashboxSort, PerseoCashbox } from '../lib/perseoCashboxLedger';

type Summary = { collectedAt: string | null; boxes: PerseoCashbox[]; visibleBoxIds: number[] };
type LedgerResponse = CashboxLedger & { collectedAt: string; currentBalanceCents: number };
type DateRange = { from: string; to: string };
const BOX_LABELS: Record<number, string> = { 1: 'Esperado', 2: 'Ganancias', 3: 'Ganancias CNB', 12: 'Compra PDV' };
const boxLabel = (box: PerseoCashbox) => BOX_LABELS[box.id] || box.name.replace(/^CAJA\s+/i, '').trim();
const COLUMNS: { key: CashboxColumn; label: string; numeric?: boolean }[] = [
  { key: 'date', label: 'Fecha' }, { key: 'reference', label: 'Comprobante' }, { key: 'description', label: 'Concepto' },
  { key: 'type', label: 'Tipo' }, { key: 'incomeCents', label: 'Ingresos', numeric: true },
  { key: 'expenseCents', label: 'Egresos', numeric: true }, { key: 'balanceCents', label: 'Saldo', numeric: true },
];
const money = (cents: number) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(cents / 100);
const dateTime = (value: string) => new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Guayaquil' }).format(new Date(value));
const dayLabel = (value: string) => value ? value.split('-').reverse().join('/') : 'Sin movimientos';
const todayInEcuador = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const inputClass = 'min-h-11 w-full rounded-xl border border-slate-600/60 bg-slate-950/60 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/15 [color-scheme:dark]';
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-semibold text-slate-200 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:cursor-not-allowed disabled:opacity-40';
const hasFilter = (filter?: CashboxFilter) => filter && (filter.values !== undefined || !!filter.min?.trim() || !!filter.max?.trim());
function keepDialogFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
  const first = controls[0]; const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

async function privateRequest<T>(url: string, options: { signal?: AbortSignal; visibleBoxIds?: number[] } = {}): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Vuelve a iniciar sesión para consultar Perseo.');
  const response = await fetch(url, { method: options.visibleBoxIds !== undefined ? 'PATCH' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(options.visibleBoxIds !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: options.visibleBoxIds !== undefined ? JSON.stringify({ visibleBoxIds: options.visibleBoxIds }) : undefined,
    cache: 'no-store', signal: options.signal });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo consultar Perseo.');
  return data as T;
}

function ColumnMenu({ column, rows, initial, position, onApply, onSort, onClose }: {
  column: CashboxColumn; rows: CashboxRow[]; initial?: CashboxFilter; position: { left: number; top: number };
  onApply: (value: CashboxFilter) => void; onSort: (direction: 'asc' | 'desc') => void; onClose: () => void;
}) {
  const title = COLUMNS.find(item => item.key === column)!.label;
  const [query, setQuery] = useState('');
  const [values, setValues] = useState<string[] | undefined>(initial?.values);
  const [min, setMin] = useState(initial?.min || '');
  const [max, setMax] = useState(initial?.max || '');
  const options = useMemo(() => [...new Set(rows.map(row => String(cashboxCell(row, column))))].sort((a, b) =>
    isCashboxNumericColumn(column) ? Number(a) - Number(b) : a.localeCompare(b, 'es', { numeric: true })), [rows, column]);
  const label = (value: string) => isCashboxNumericColumn(column) ? money(Number(value)) : column === 'date' ? dayLabel(value) : value || '(Vacío)';
  const matching = options.filter(value => cashboxText(label(value)).includes(cashboxText(query)));
  const selected = values ?? options;
  return createPortal(<div className="fixed inset-0 z-[190]" onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div className="absolute inset-0 bg-slate-950/35 sm:bg-transparent" onClick={onClose} />
    <div role="dialog" aria-modal="true" aria-label={`Filtrar ${title}`} style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 12}px)` }} className="absolute flex w-[min(320px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-slate-600 bg-slate-900 text-left shadow-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2"><h4 className="text-sm font-bold text-white">{title}</h4><button type="button" className="h-9 w-9 rounded-lg text-slate-400 hover:bg-white/10" onClick={onClose} aria-label="Cerrar filtro"><X className="mx-auto h-4 w-4" /></button></div>
      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-white/10 p-3">
        <button type="button" className={buttonClass} onClick={() => { onSort('asc'); onClose(); }}><ArrowUp className="h-4 w-4" /> Ascendente</button>
        <button type="button" className={buttonClass} onClick={() => { onSort('desc'); onClose(); }}><ArrowDown className="h-4 w-4" /> Descendente</button>
      </div>
      {isCashboxNumericColumn(column) && <div className="grid shrink-0 grid-cols-2 gap-2 px-3 pt-3">
        <label className="text-xs text-slate-400">Mínimo ($)<input className={`${inputClass} mt-1`} inputMode="decimal" value={min} onChange={event => setMin(event.target.value)} /></label>
        <label className="text-xs text-slate-400">Máximo ($)<input className={`${inputClass} mt-1`} inputMode="decimal" value={max} onChange={event => setMax(event.target.value)} /></label>
      </div>}
      <div className="shrink-0 p-3"><input autoFocus className={inputClass} placeholder="Buscar valores…" aria-label={`Buscar valores de ${title}`} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="flex shrink-0 gap-3 px-3 pb-2 text-xs"><button type="button" className="min-h-8 text-cyan-300" onClick={() => setValues(query ? [...new Set([...selected, ...matching])] : undefined)}>Seleccionar {query ? 'visibles' : 'todo'}</button><button type="button" className="min-h-8 text-slate-400" onClick={() => setValues([])}>Desmarcar todo</button><span className="ml-auto self-center text-slate-500">{selected.length}/{options.length}</span></div>
      <div className="min-h-0 max-h-52 flex-1 overflow-y-auto border-y border-white/5 px-2 py-1">
        {matching.slice(0, 200).map(value => <label key={value} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm text-slate-200 hover:bg-white/5">
          <input type="checkbox" className="h-4 w-4 shrink-0 accent-cyan-400" checked={selected.includes(value)} onChange={event => setValues(event.target.checked ? [...selected, value] : selected.filter(item => item !== value))} />
          <span className="truncate" title={label(value)}>{label(value)}</span>
        </label>)}
        {!matching.length && <p className="p-3 text-xs text-slate-400">Sin valores coincidentes.</p>}
        {matching.length > 200 && <p className="p-3 text-xs text-amber-200">Hay {matching.length} valores. Escribe para encontrar uno específico.</p>}
      </div>
      <div className="flex shrink-0 justify-between gap-2 p-3"><button type="button" className={buttonClass} onClick={() => { onApply({}); onClose(); }}>Quitar filtro</button><button type="button" className="min-h-11 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 hover:bg-cyan-300" onClick={() => { onApply({ values: values?.length === options.length ? undefined : values, min, max }); onClose(); }}>Aplicar</button></div>
    </div>
  </div>, document.body);
}

export function PerseoCashboxes() {
  const today = todayInEcuador();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(1);
  const [draftRange, setDraftRange] = useState<DateRange>({ from: `${today.slice(0, 7)}-01`, to: today });
  const [range, setRange] = useState(draftRange);
  const [dateError, setDateError] = useState('');
  const [revision, setRevision] = useState(0);
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<CashboxFilters>({});
  const [sort, setSort] = useState<CashboxSort>({ column: 'date', direction: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [menu, setMenu] = useState<{ column: CashboxColumn; left: number; top: number } | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const [detail, setDetail] = useState<CashboxRow | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogDraft, setCatalogDraft] = useState<number[]>([]);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const selected = summary?.boxes.find(box => box.id === selectedId);
  const selectedName = selected ? boxLabel(selected) : 'Caja';
  const visibleIds = summary?.visibleBoxIds ?? [1, 2, 3, 12];
  const visibleBoxes = summary?.boxes.filter(box => visibleIds.includes(box.id)) || [];
  const catalogBoxes = summary?.boxes.filter(box => cashboxText(`${box.id} ${box.name}`).includes(cashboxText(catalogSearch))) || [];

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await privateRequest<Summary>('/api/perseo/cashboxes');
      setSummary(data); setError(''); setRevision(value => value + 1);
      setSelectedId(value => data.boxes.some(box => box.id === value) ? value : data.visibleBoxIds?.[0] || data.boxes[0]?.id || 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo consultar Perseo.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!summary?.collectedAt) { setHistoryLoading(false); return; }
    const controller = new AbortController(); let active = true;
    setHistoryLoading(true); setHistoryError(''); setLedger(null);
    const params = new URLSearchParams({ boxId: String(selectedId), from: range.from, to: range.to });
    void privateRequest<LedgerResponse>(`/api/perseo/cashboxes?${params}`, { signal: controller.signal })
      .then(data => { if (active) setLedger(data); })
      .catch(cause => { if (active) setHistoryError(cause instanceof Error ? cause.message : 'No se pudo cargar el historial.'); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [selectedId, range.from, range.to, revision, !!summary?.collectedAt]);
  useEffect(() => { setPage(1); }, [search, filters, sort, pageSize, selectedId, range]);
  useEffect(() => { setFilters({}); setSearch(''); setMenu(null); setDetail(null); }, [selectedId, range]);

  const rows = useMemo(() => filterCashboxRows(ledger?.movements || [], search, filters, sort), [ledger, search, filters, sort]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const activeFilters = Object.values(filters).filter(hasFilter).length;
  const filteredIncome = rows.reduce((sum, row) => sum + row.incomeCents, 0);
  const filteredExpense = rows.reduce((sum, row) => sum + row.expenseCents, 0);
  const stale = summary?.collectedAt ? Date.now() - Date.parse(summary.collectedAt) > 45 * 60_000 : false;
  const applyRange = (next: DateRange) => {
    if (!isCashboxDate(next.from) || !isCashboxDate(next.to) || next.from > next.to || next.to > today) {
      setDateError('Revisa las fechas: Desde debe ser anterior o igual a Hasta, sin superar hoy.'); return;
    }
    setDraftRange(next); setRange({ ...next }); setDateError('');
  };
  const preset = (kind: 'today' | 'month' | 'previous' | 'all') => {
    if (kind === 'today') applyRange({ from: today, to: today });
    if (kind === 'month') applyRange({ from: `${today.slice(0, 7)}-01`, to: today });
    if (kind === 'all') {
      if ((selected?.months.reduce((sum, item) => sum + item.count, 0) || 0) > 10_000) { setDateError('Esta caja tiene un historial extenso. Elige un mes o un rango de fechas para consultar todos sus movimientos con detalle.'); return; }
      applyRange({ from: `${selected?.months.map(item => item.month).sort()[0] || today.slice(0, 7)}-01`, to: today });
    }
    if (kind === 'previous') {
      const first = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
      const last = new Date(first.getTime() - 24 * 60 * 60_000);
      applyRange({ from: `${last.toISOString().slice(0, 7)}-01`, to: last.toISOString().slice(0, 10) });
    }
  };
  const closeMenu = () => { setMenu(null); menuTrigger.current?.focus(); };
  const openCatalog = () => { setCatalogDraft([...visibleIds]); setCatalogSearch(''); setCatalogOpen(true); };
  const selectBox = (box: PerseoCashbox) => {
    const count = box.months.filter(item => item.month >= range.from.slice(0, 7) && item.month <= range.to.slice(0, 7)).reduce((sum, item) => sum + item.count, 0);
    if (count > 10_000) applyRange({ from: `${today.slice(0, 7)}-01`, to: today });
    setSelectedId(box.id); setCatalogOpen(false);
  };
  const saveVisibility = async () => {
    setSavingVisibility(true);
    try {
      const result = await privateRequest<{ visibleBoxIds: number[] }>('/api/perseo/cashboxes', { visibleBoxIds: catalogDraft });
      setSummary(previous => previous ? { ...previous, visibleBoxIds: result.visibleBoxIds } : previous);
      setCatalogOpen(false); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo guardar la visibilidad de las cajas.'); }
    finally { setSavingVisibility(false); }
  };
  const exportRows = () => {
    const url = URL.createObjectURL(new Blob([cashboxCsv(rows)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url; link.download = `perseo-caja-${selectedId}-${range.from}-${range.to}.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <section className="mb-8 text-left sm:mb-12" aria-labelledby="perseo-cashboxes-title">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div><div className="flex items-center gap-2"><Wallet className="h-5 w-5 text-cyan-300" /><h2 id="perseo-cashboxes-title" className="text-lg font-black text-white sm:text-xl">Cajas de Perseo</h2><span className="rounded-md border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-200">Consulta</span></div><p className="mt-1 text-xs text-slate-400">Saldos, movimientos y estado de caja por fecha</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={openCatalog} disabled={!summary?.boxes.length} className={buttonClass}><SlidersHorizontal className="h-4 w-4" />Todas las cajas ({summary?.boxes.length || 0})</button><button type="button" onClick={() => void refresh()} disabled={loading} className={buttonClass} aria-label="Actualizar cajas de Perseo"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Actualizar vista</button></div>
    </div>
    {error && <p role="alert" className="mb-3 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
    {loading && !summary && <p role="status" className="rounded-2xl border border-white/10 bg-slate-800 p-5 text-sm text-slate-300">Cargando cajas de Perseo…</p>}
    {!loading && !summary?.collectedAt && !error && <p className="rounded-2xl border border-white/10 bg-slate-800 p-5 text-sm text-slate-300">Aún no hay datos sincronizados desde Perseo.</p>}
    {!!summary?.boxes.length && <>
      <p className="mb-3 text-[11px] text-slate-500">{visibleBoxes.length} visibles · {summary.boxes.length - visibleBoxes.length} ocultas · Puedes consultar cualquiera desde «Todas las cajas».</p>
      {!visibleBoxes.length && <button type="button" className={`${buttonClass} mb-4 w-full`} onClick={openCatalog}>Todas las cajas están ocultas. Abrir catálogo</button>}
      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">{visibleBoxes.map(box => <button key={box.id} type="button" aria-pressed={selectedId === box.id} onClick={() => selectBox(box)} className={`rounded-2xl border p-3 text-left transition sm:p-4 ${selectedId === box.id ? 'border-cyan-400/70 bg-cyan-400/10 ring-1 ring-cyan-400/20' : 'border-white/10 bg-slate-800/70 hover:border-slate-500'} focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400`}>
        <span className="flex items-center justify-between gap-1 text-[11px] font-bold uppercase tracking-wide text-slate-300"><span>{boxLabel(box)}</span>{selectedId === box.id && <Check className="h-4 w-4 shrink-0 text-cyan-300" />}</span>
        <span className="mt-2 block whitespace-nowrap text-xl font-black tabular-nums text-white sm:text-2xl">{money(box.balanceCents)}</span><span className="mt-1 block text-[10px] text-slate-400 sm:text-xs">Últ. movimiento: {dayLabel(box.lastMovementDate || '')}</span>
      </button>)}</div>
      <div className="overflow-hidden rounded-2xl border border-slate-600/60 bg-slate-900 shadow-xl shadow-slate-950/20">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-slate-800/60 px-4 py-3 sm:px-5"><div><h3 className="font-bold text-white">Movimientos · {selectedName}</h3><p className="mt-1 text-[11px] text-slate-400">{selected?.name}{!visibleIds.includes(selectedId) ? ' · Consulta de caja oculta' : ''}</p></div><p className={`text-[11px] ${stale ? 'text-amber-300' : 'text-slate-400'}`}><span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${stale ? 'bg-amber-400' : 'bg-emerald-400'}`} />{stale ? 'Sincronización atrasada · ' : 'Corte sincronizado · '}{summary.collectedAt && dateTime(summary.collectedAt)}</p></div>
        {stale && <p role="status" className="border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-200">Los saldos corresponden al último corte recibido. La sincronización local con Perseo se realiza cada 15 minutos.</p>}
        <form className="border-b border-white/10 p-4 sm:px-5" onSubmit={event => { event.preventDefault(); applyRange(draftRange); }}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-xs font-semibold text-slate-400 sm:max-w-48">Desde<input type="date" max={today} value={draftRange.from} onChange={event => setDraftRange(value => ({ ...value, from: event.target.value }))} className={`${inputClass} mt-1.5`} /></label>
            <label className="min-w-0 flex-1 text-xs font-semibold text-slate-400 sm:max-w-48">Hasta<input type="date" max={today} value={draftRange.to} onChange={event => setDraftRange(value => ({ ...value, to: event.target.value }))} className={`${inputClass} mt-1.5`} /></label>
            <button type="submit" className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 hover:bg-cyan-300 sm:w-auto"><CalendarDays className="h-4 w-4" />Consultar</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">{([['today', 'Hoy'], ['month', 'Este mes'], ['previous', 'Mes anterior'], ['all', 'Todo el historial']] as const).map(([key, label]) => <button key={key} type="button" onClick={() => preset(key)} className="min-h-9 rounded-lg border border-white/10 px-3 text-xs text-slate-300 hover:border-cyan-400/40 hover:text-cyan-200">{label}</button>)}</div>
          {dateError && <p role="alert" className="mt-2 text-xs text-rose-300">{dateError}</p>}
        </form>
        {historyLoading && <div role="status" className="flex items-center gap-2 px-5 py-12 text-sm text-slate-400"><RefreshCw className="h-4 w-4 animate-spin" /> Consultando movimientos y saldos…</div>}
        {historyError && <div role="alert" className="px-5 py-8 text-sm text-rose-200">{historyError}<button type="button" onClick={() => setRevision(value => value + 1)} className={`${buttonClass} ml-3`}>Reintentar</button></div>}
        {!historyLoading && !historyError && ledger && <>
          <div className="grid grid-cols-2 gap-px border-b border-white/10 bg-slate-700/30 lg:grid-cols-4" aria-label="Resumen del período">{[
            { label: 'Saldo inicial', value: ledger.openingBalanceCents, note: `Antes del ${dayLabel(range.from)}`, color: 'text-white', icon: <Wallet className="h-4 w-4 text-slate-400" /> },
            { label: 'Ingresos del período', value: ledger.incomeCents, note: 'Entradas de caja', color: 'text-emerald-300', icon: <ArrowDownLeft className="h-4 w-4 text-emerald-400" /> },
            { label: 'Egresos del período', value: ledger.expenseCents, note: 'Salidas de caja', color: 'text-rose-300', icon: <ArrowUpRight className="h-4 w-4 text-rose-400" /> },
            { label: 'Saldo al cierre del rango', value: ledger.closingBalanceCents, note: `Al ${dayLabel(range.to)}`, color: 'text-cyan-200', icon: <CalendarDays className="h-4 w-4 text-cyan-300" /> },
          ].map(item => <div key={item.label} className="bg-slate-900 px-4 py-4 sm:px-5"><span className="flex items-center gap-2 text-[11px] font-semibold text-slate-400">{item.icon}{item.label}</span><p className={`mt-2 whitespace-nowrap text-lg font-bold tabular-nums sm:text-xl ${item.color}`}>{money(item.value)}</p><p className="mt-1 text-[10px] text-slate-500">{item.note}</p></div>)}</div>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5"><label className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" /><input className={`${inputClass} pl-9`} placeholder="Buscar en los movimientos…" aria-label="Buscar en los movimientos de Perseo" value={search} onChange={event => setSearch(event.target.value)} /></label>
            {(activeFilters > 0 || search) && <button type="button" onClick={() => { setFilters({}); setSearch(''); }} className={buttonClass}><X className="h-4 w-4" />Limpiar{activeFilters > 0 ? ` (${activeFilters})` : ''}</button>}
            <button type="button" className={buttonClass} onClick={exportRows} disabled={!rows.length} title="Exportar todos los movimientos filtrados, de todas las páginas"><Download className="h-4 w-4" /><span className="hidden sm:inline">Exportar</span> Excel CSV</button>
          </div>
          {!!activeFilters && <div className="flex flex-wrap gap-2 px-4 pb-3 sm:px-5">{COLUMNS.filter(column => hasFilter(filters[column.key])).map(column => <button key={column.key} type="button" onClick={() => setFilters(value => { const next = { ...value }; delete next[column.key]; return next; })} className="inline-flex min-h-8 items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-2 text-xs text-cyan-200"><Filter className="h-3 w-3" />{column.label}<X className="h-3 w-3" /></button>)}</div>}
          <div className="flex flex-wrap items-center justify-between gap-2 border-y border-white/5 bg-slate-800/30 px-4 py-2 text-[11px] text-slate-400 sm:px-5"><span><span className="font-bold text-slate-200">{rows.length}</span> de {ledger.movements.length} movimientos · {dayLabel(range.from)} — {dayLabel(range.to)}</span><span className="inline-flex items-center gap-1"><SlidersHorizontal className="h-3 w-3" />Filtros en cada columna</span></div>
          <p className="px-4 pt-2 text-[10px] text-slate-500 sm:hidden">Desliza la tabla hacia los lados para ver todas las columnas.</p>
          <div className="max-h-[520px] overflow-auto" tabIndex={0} aria-label="Tabla desplazable de movimientos"><table className="w-full min-w-[1060px] border-collapse text-sm" aria-label={`Movimientos de ${selectedName}`}>
            <thead className="sticky top-0 z-10 bg-slate-800 shadow-sm"><tr>{COLUMNS.map(column => <th key={column.key} scope="col" aria-sort={sort.column === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className={`border-b border-r border-slate-600/50 px-3 py-1.5 text-xs font-semibold text-slate-300 ${column.numeric ? 'text-right' : 'text-left'}`}>
              <div className={`flex items-center gap-1 ${column.numeric ? 'justify-end' : ''}`}><button type="button" className="inline-flex min-h-10 items-center gap-1 whitespace-nowrap hover:text-white" onClick={() => setSort(value => ({ column: column.key, direction: value.column === column.key && value.direction === 'asc' ? 'desc' : 'asc' }))}>{column.label}{sort.column === column.key && (sort.direction === 'asc' ? <ArrowUp className="h-3 w-3 text-cyan-300" /> : <ArrowDown className="h-3 w-3 text-cyan-300" />)}</button><button type="button" aria-label={`Filtrar ${column.label}`} aria-expanded={menu?.column === column.key} className={`flex h-9 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/10 ${hasFilter(filters[column.key]) ? 'bg-cyan-400/15 text-cyan-300' : 'text-slate-500'}`} onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect(); menuTrigger.current = event.currentTarget;
                setMenu({ column: column.key, left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 530)) });
              }}>{hasFilter(filters[column.key]) ? <Filter className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</button></div>
            </th>)}</tr></thead>
            <tbody className="divide-y divide-slate-700/50">
              {!pageRows.length && <tr><td colSpan={7} className="px-5 py-12 text-center text-sm text-slate-400">{ledger.movements.length ? 'No hay movimientos que coincidan con los filtros.' : 'No hay movimientos en este período. El saldo anterior se conserva en el resumen.'}</td></tr>}
              {pageRows.map((row, index) => <tr key={row.id} className={`${index % 2 ? 'bg-slate-800/25' : 'bg-slate-900'} hover:bg-cyan-400/5`} onDoubleClick={() => setDetail(row)}>
                <td className="whitespace-nowrap border-r border-slate-700/30 px-3 py-3 font-mono text-xs text-slate-300">{dayLabel(row.date)}</td>
                <td className="max-w-44 truncate border-r border-slate-700/30 px-3 py-3 font-mono text-xs text-slate-400" title={row.reference}>{row.reference || '—'}</td>
                <td className="w-full min-w-64 border-r border-slate-700/30 px-3 py-2"><button type="button" onClick={() => setDetail(row)} className="min-h-9 w-full text-left text-xs font-medium text-slate-200 hover:text-cyan-200" title="Ver detalle del movimiento"><span className="line-clamp-2">{row.description || 'Sin concepto'}</span></button></td>
                <td className="border-r border-slate-700/30 px-3 py-3"><span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${row.amountCents < 0 ? 'border-rose-400/20 bg-rose-400/10 text-rose-300' : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'}`}>{cashboxType(row.type)}</span></td>
                <td className="whitespace-nowrap border-r border-slate-700/30 px-3 py-3 text-right font-mono text-xs tabular-nums text-emerald-300">{row.incomeCents ? money(row.incomeCents) : '—'}</td>
                <td className="whitespace-nowrap border-r border-slate-700/30 px-3 py-3 text-right font-mono text-xs tabular-nums text-rose-300">{row.expenseCents ? money(row.expenseCents) : '—'}</td>
                <td className={`whitespace-nowrap px-3 py-3 text-right font-mono text-xs font-semibold tabular-nums ${row.balanceCents < 0 ? 'text-rose-300' : 'text-slate-100'}`}>{money(row.balanceCents)}</td>
              </tr>)}
            </tbody>
            {!!rows.length && <tfoot className="sticky bottom-0 bg-slate-800 text-xs shadow-sm"><tr><th scope="row" colSpan={4} className="border-t border-slate-600 px-3 py-3 text-left font-semibold text-slate-300">Totales filtrados · {rows.length} movimientos</th><td className="whitespace-nowrap border-t border-slate-600 px-3 py-3 text-right font-mono font-bold text-emerald-300">{money(filteredIncome)}</td><td className="whitespace-nowrap border-t border-slate-600 px-3 py-3 text-right font-mono font-bold text-rose-300">{money(filteredExpense)}</td><td className="border-t border-slate-600 px-3 py-3 text-right text-slate-500">—</td></tr></tfoot>}
          </table></div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3 sm:px-5"><label className="flex items-center gap-2 text-xs text-slate-400">Filas<select className="min-h-10 rounded-lg border border-slate-600 bg-slate-800 px-2 text-slate-200" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
            <div className="flex items-center gap-2 text-xs text-slate-400"><button type="button" className={buttonClass} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} aria-label="Página anterior de movimientos"><ChevronLeft className="h-4 w-4" /></button><span aria-live="polite">{currentPage} / {pageCount}</span><button type="button" className={buttonClass} disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)} aria-label="Página siguiente de movimientos"><ChevronRight className="h-4 w-4" /></button></div>
          </div><p className="border-t border-white/5 px-4 py-3 text-[11px] leading-relaxed text-slate-500 sm:px-5">Saldo inicial + ingresos − egresos = saldo al cierre del rango. Los filtros y el orden de la tabla no alteran el saldo contable de cada movimiento. Toca el concepto para ver su detalle.</p>
        </>}
      </div>
    </>}
    {menu && ledger && <ColumnMenu key={`${menu.column}-${selectedId}`} column={menu.column} rows={ledger.movements} initial={filters[menu.column]} position={{ left: menu.left, top: menu.top }} onApply={value => setFilters(previous => ({ ...previous, [menu.column]: value }))} onSort={direction => setSort({ column: menu.column, direction })} onClose={closeMenu} />}
    {catalogOpen && <div className="fixed inset-0 z-[185] flex items-end justify-center bg-slate-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={event => { if (event.target === event.currentTarget) setCatalogOpen(false); }} onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape') setCatalogOpen(false); }}>
      <div role="dialog" aria-modal="true" aria-label="Todas las cajas activas de Perseo" className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-slate-900 sm:rounded-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 p-4"><div><h3 className="font-bold text-white">Todas las cajas activas ({summary?.boxes.length || 0})</h3><p className="mt-1 text-xs text-slate-400">Marca las que quieres mostrar. «Consultar» abre el historial de cualquier caja.</p></div><button type="button" className={buttonClass} onClick={() => setCatalogOpen(false)} aria-label="Cerrar catálogo de cajas"><X className="h-4 w-4" /></button></div>
        <div className="shrink-0 p-4"><input autoFocus className={inputClass} placeholder="Buscar caja por nombre o número…" aria-label="Buscar caja activa" value={catalogSearch} onChange={event => setCatalogSearch(event.target.value)} /></div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">{catalogBoxes.map(box => <div key={box.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-slate-800/60 p-3">
          <input type="checkbox" aria-label={`Mostrar ${boxLabel(box)}`} checked={catalogDraft.includes(box.id)} onChange={event => setCatalogDraft(previous => event.target.checked ? [...previous, box.id] : previous.filter(id => id !== box.id))} className="h-5 w-5 shrink-0 accent-cyan-400" />
          <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-100">{box.id} · {boxLabel(box)}</p><p className="mt-1 text-sm font-bold tabular-nums text-cyan-200">{money(box.balanceCents)}</p><p className="mt-1 text-[10px] text-slate-500">{catalogDraft.includes(box.id) ? 'Visible en el panel' : 'Oculta del panel'} · Últ. mov. {dayLabel(box.lastMovementDate || '')}</p></div>
          <button type="button" className={buttonClass} aria-label={`Consultar ${boxLabel(box)}`} onClick={() => selectBox(box)}>Consultar<ChevronRight className="h-3 w-3" /></button>
        </div>)}{!catalogBoxes.length && <p className="py-6 text-center text-sm text-slate-400">No hay cajas que coincidan.</p>}</div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 p-4"><button type="button" className={buttonClass} onClick={() => setCatalogDraft([1, 2, 3, 12].filter(id => summary?.boxes.some(box => box.id === id)))}>Solo principales</button><button type="button" disabled={savingVisibility} onClick={() => void saveVisibility()} className="min-h-11 rounded-xl bg-cyan-400 px-4 text-xs font-bold text-slate-950 disabled:opacity-50">{savingVisibility ? 'Guardando…' : `Guardar visibilidad (${catalogDraft.length})`}</button></div>
      </div>
    </div>}
    {detail && <div className="fixed inset-0 z-[180] flex items-end justify-center bg-slate-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={event => { if (event.target === event.currentTarget) setDetail(null); }} onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape') setDetail(null); }}>
      <div role="dialog" aria-modal="true" aria-label="Detalle del movimiento de Perseo" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-white/10 bg-slate-900 p-5 sm:rounded-2xl"><div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-cyan-300">{selectedName}</p><h4 className="mt-1 text-lg font-bold text-white">Movimiento #{detail.id}</h4></div><button autoFocus type="button" className={buttonClass} onClick={() => setDetail(null)} aria-label="Cerrar detalle del movimiento"><X className="h-4 w-4" /></button></div>
        <p className="mb-5 break-words text-sm font-medium text-slate-200">{detail.description || 'Sin concepto'}</p><dl className="grid grid-cols-2 gap-4 text-xs">{[['Fecha del movimiento', dayLabel(detail.date)], ['Fecha de registro', detail.recordedAt || 'No disponible'], ['Comprobante', detail.reference || 'Sin comprobante'], ['Tipo', cashboxType(detail.type)], ['Importe', money(detail.amountCents)], ['Saldo tras el movimiento', money(detail.balanceCents)]].map(([label, value]) => <div key={label}><dt className="text-slate-500">{label}</dt><dd className="mt-1 break-words font-semibold text-slate-100">{value}</dd></div>)}</dl>
      </div>
    </div>}
  </section>;
}
