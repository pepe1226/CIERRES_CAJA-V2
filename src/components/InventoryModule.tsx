import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, AlertTriangle, Boxes, FileUp, PackageSearch, RefreshCw, Search, ShieldAlert, TrendingUp, Upload, Warehouse } from 'lucide-react';
import { collection, getDocs, onSnapshot, orderBy, query, Timestamp } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { InventoryItem } from '../types';

type InventoryModuleProps = {
  onBack: () => void;
};

type InventoryStatusFilter = 'all' | 'critical' | 'low' | 'watch' | 'ok';

const statusLabels: Record<string, string> = {
  critical: 'Resurtir ya',
  low: 'Bajo',
  watch: 'Vigilar',
  ok: 'Estable',
};

const statusClasses: Record<string, string> = {
  critical: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  low: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  watch: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  ok: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
};

const formatMoney = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `$${value.toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : 'Sin costo';

const normalizeDate = (value: unknown) => {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return '';
};

const buildInventoryQuery = () => query(collection(db, 'inventory_items'), orderBy('priorityRank', 'asc'), orderBy('coverageDays', 'asc'));

const mapInventoryDoc = (doc: any) => {
  const data = doc.data();
  return {
    id: doc.id,
    sku: data.sku ? String(data.sku) : '',
    name: String(data.name || 'PRODUCTO'),
    stock: Number(data.stock || 0),
    sold90d: Number(data.sold90d || 0),
    coverageDays: data.coverageDays === null || data.coverageDays === undefined ? null : Number(data.coverageDays),
    lastCost: data.lastCost === null || data.lastCost === undefined ? null : Number(data.lastCost),
    supplier: data.supplier ? String(data.supplier) : null,
    warehouse: data.warehouse ? String(data.warehouse) : null,
    status: String(data.status || 'ok'),
    priorityReason: data.priorityReason ? String(data.priorityReason) : null,
    updatedAt: normalizeDate(data.updatedAt),
    snapshotId: data.snapshotId ? String(data.snapshotId) : null,
  } as InventoryItem;
};

export function InventoryModule({ onBack }: InventoryModuleProps) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InventoryStatusFilter>('all');
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [warehouseFilter, setWarehouseFilter] = useState('all');
  const [isUploading, setIsUploading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const inventoryQuery = buildInventoryQuery();

    return onSnapshot(inventoryQuery, (snapshot) => {
      setItems(snapshot.docs.map(mapInventoryDoc));
    });
  }, []);

  const suppliers = useMemo(
    () => Array.from(new Set(items.map(item => item.supplier).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b)),
    [items]
  );

  const warehouses = useMemo(
    () => Array.from(new Set(items.map(item => item.warehouse).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b)),
    [items]
  );

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return items.filter((item) => {
      const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
      const matchesSupplier = supplierFilter === 'all' || item.supplier === supplierFilter;
      const matchesWarehouse = warehouseFilter === 'all' || item.warehouse === warehouseFilter;
      const searchable = [item.name, item.sku, item.supplier, item.warehouse, item.priorityReason].filter(Boolean).join(' ').toLowerCase();
      const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
      return matchesStatus && matchesSupplier && matchesWarehouse && matchesSearch;
    });
  }, [items, search, statusFilter, supplierFilter, warehouseFilter]);

  const summary = useMemo(() => ({
    critical: items.filter(item => item.status === 'critical').length,
    low: items.filter(item => item.status === 'low').length,
    watch: items.filter(item => item.status === 'watch').length,
    ok: items.filter(item => item.status === 'ok').length,
  }), [items]);

  const totalInventoryValue = useMemo(
    () => items.reduce((sum, item) => sum + ((Number(item.stock || 0) * Number(item.lastCost || 0)) || 0), 0),
    [items]
  );

  const lastUpdate = useMemo(() => {
    const first = items.find(item => item.updatedAt);
    return first?.updatedAt || '';
  }, [items]);

  const handleUploadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      setIsUploading(true);
      setUploadError(null);
      setUploadMessage(null);

      const content = await file.text();
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('No hay sesion activa.');

      let payload: unknown = content;
      if (file.name.toLowerCase().endsWith('.json')) {
        try {
          payload = JSON.parse(content);
        } catch {
          payload = content;
        }
      }

      const response = await fetch('/api/inventory-admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(
          typeof payload === 'string'
            ? { report: payload, source: `web-upload:${file.name}` }
            : { ...payload as Record<string, unknown>, source: `web-upload:${file.name}` }
        ),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No se pudo importar el inventario.');

      setUploadMessage(`Inventario actualizado: ${Number(data.imported || 0).toLocaleString('es-EC')} productos.`);
    } catch (error: any) {
      setUploadError(error?.message || String(error));
    } finally {
      setIsUploading(false);
    }
  };

  const handleRefreshCache = async () => {
    try {
      setIsRefreshing(true);
      setUploadError(null);
      const snapshot = await getDocs(buildInventoryQuery());
      setItems(snapshot.docs.map(mapInventoryDoc));
      setUploadMessage(`Cache leida: ${snapshot.size.toLocaleString('es-EC')} productos.`);
    } catch (error: any) {
      setUploadError(error?.message || String(error));
    } finally {
      setIsRefreshing(false);
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
              <h1 className="text-xl font-black text-white uppercase tracking-tight">Inventario</h1>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest truncate">Hoja filtrable con cache propio de Perseo</p>
            </div>
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-8 space-y-6">
        <section className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Productos cargados</p>
            <p className="text-3xl font-black text-white">{items.length}</p>
          </div>
          <div className="bg-[#1E293B] border border-rose-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-rose-300/70 uppercase tracking-widest mb-2">Resurtir ya</p>
            <p className="text-3xl font-black text-rose-300">{summary.critical}</p>
          </div>
          <div className="bg-[#1E293B] border border-amber-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-amber-300/70 uppercase tracking-widest mb-2">Bajo</p>
            <p className="text-3xl font-black text-amber-300">{summary.low}</p>
          </div>
          <div className="bg-[#1E293B] border border-sky-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-sky-300/70 uppercase tracking-widest mb-2">Ultima actualizacion</p>
            <p className="text-sm font-black text-white">{lastUpdate ? new Date(lastUpdate).toLocaleString('es-EC') : 'Sin datos'}</p>
          </div>
          <div className="bg-[#1E293B] border border-emerald-500/10 rounded-[2rem] p-6">
            <p className="text-[10px] font-black text-emerald-300/70 uppercase tracking-widest mb-2">Valor estimado</p>
            <p className="text-sm font-black text-white">{formatMoney(totalInventoryValue)}</p>
          </div>
        </section>

        <section className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-5">
            <div>
              <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2">
                <FileUp className="w-5 h-5 text-cyan-300" />
                Actualizar cache
              </h2>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Sube CSV, TXT o JSON exportado desde Perseo para actualizar la cache</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={handleRefreshCache} disabled={isRefreshing} className={`inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] ${isRefreshing ? 'border-white/5 bg-white/5 text-slate-500' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'}`}>
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                {isRefreshing ? 'Leyendo...' : 'Refrescar vista'}
              </button>
              <label className={`inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] ${isUploading ? 'border-white/5 bg-white/5 text-slate-500' : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-200 cursor-pointer hover:bg-cyan-500/15'}`}>
                <Upload className="w-4 h-4" />
                {isUploading ? 'Actualizando...' : 'Actualizar desde archivo'}
                <input type="file" accept=".csv,.txt,.json" onChange={handleUploadFile} className="hidden" disabled={isUploading} />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto_auto] gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Buscar producto, sku, proveedor o criterio..."
                className="w-full pl-9 pr-3 py-3 bg-[#0F172A] border border-white/5 rounded-xl text-xs font-bold text-white outline-none focus:border-cyan-500"
              />
            </div>
            <select value={supplierFilter} onChange={event => setSupplierFilter(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-3 text-xs font-black text-white outline-none">
              <option value="all">Todos los proveedores</option>
              {suppliers.map(supplier => <option key={supplier} value={supplier}>{supplier}</option>)}
            </select>
            <select value={warehouseFilter} onChange={event => setWarehouseFilter(event.target.value)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-3 text-xs font-black text-white outline-none">
              <option value="all">Todas las bodegas</option>
              {warehouses.map(warehouse => <option key={warehouse} value={warehouse}>{warehouse}</option>)}
            </select>
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as InventoryStatusFilter)} className="bg-[#0F172A] border border-white/5 rounded-xl px-3 py-3 text-xs font-black text-white outline-none">
              <option value="all">Todos los estados</option>
              <option value="critical">Resurtir ya</option>
              <option value="low">Bajo</option>
              <option value="watch">Vigilar</option>
              <option value="ok">Estable</option>
            </select>
          </div>

          <div className="mt-4 rounded-[1.5rem] border border-dashed border-white/10 bg-[#0F172A]/60 p-4">
            <p className="text-xs font-bold text-slate-400">La hoja reconoce columnas de producto, stock, ventas 90 dias, cobertura, costo, proveedor y bodega aunque cambie el orden.</p>
            {uploadMessage && <p className="mt-3 text-xs font-black uppercase text-emerald-300">{uploadMessage}</p>}
            {uploadError && <p className="mt-3 text-xs font-black uppercase text-rose-300">{uploadError}</p>}
          </div>
        </section>

        <section className="bg-[#1E293B] border border-white/5 rounded-[2rem] p-6">
          <div className="flex items-center justify-between gap-4 mb-5">
            <div>
              <h2 className="text-lg font-black text-white uppercase tracking-tight flex items-center gap-2">
                <Boxes className="w-5 h-5 text-cyan-300" />
                Hoja de inventario
              </h2>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Vista tipo excel con cabeceras y filtros</p>
            </div>
          </div>

          <div className="overflow-hidden rounded-[1.5rem] border border-white/5 bg-[#0F172A]/70">
            <div className="overflow-auto max-h-[72vh]">
              <table className="min-w-[1280px] w-full">
                <thead className="sticky top-0 z-10 bg-[#111827]">
                  <tr className="border-b border-white/5">
                    <th className="px-4 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400">Estado</th>
                    <th className="px-4 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400">SKU</th>
                    <th className="px-4 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400">Producto</th>
                    <th className="px-4 py-4 text-right text-[10px] font-black uppercase tracking-widest text-slate-400">Stock</th>
                    <th className="px-4 py-4 text-right text-[10px] font-black uppercase tracking-widest text-slate-400">Vendido 90d</th>
                    <th className="px-4 py-4 text-right text-[10px] font-black uppercase tracking-widest text-slate-400">Cobertura</th>
                    <th className="px-4 py-4 text-right text-[10px] font-black uppercase tracking-widest text-slate-400">Ultimo costo</th>
                    <th className="px-4 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400">Proveedor</th>
                    <th className="px-4 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400">Bodega</th>
                    <th className="px-4 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400">Criterio</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map(item => (
                    <tr key={item.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                      <td className="px-4 py-3 align-top">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${statusClasses[item.status || 'ok'] || statusClasses.ok}`}>
                          {item.status === 'critical' ? <ShieldAlert className="w-3 h-3" /> : item.status === 'low' ? <AlertTriangle className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                          {statusLabels[item.status || 'ok'] || 'Estable'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs font-black text-slate-300 uppercase align-top">{item.sku || '-'}</td>
                      <td className="px-4 py-3 text-sm font-black text-white uppercase align-top min-w-[320px]">{item.name}</td>
                      <td className="px-4 py-3 text-sm font-black text-white text-right align-top">{item.stock.toLocaleString('es-EC')}</td>
                      <td className="px-4 py-3 text-sm font-black text-white text-right align-top">{Number(item.sold90d || 0).toLocaleString('es-EC')}</td>
                      <td className="px-4 py-3 text-sm font-black text-white text-right align-top">{item.coverageDays === null || item.coverageDays === undefined ? '-' : item.coverageDays.toFixed(1)}</td>
                      <td className="px-4 py-3 text-sm font-black text-white text-right align-top">{formatMoney(item.lastCost)}</td>
                      <td className="px-4 py-3 text-xs font-black text-slate-300 uppercase align-top">{item.supplier || '-'}</td>
                      <td className="px-4 py-3 text-xs font-black text-slate-300 uppercase align-top">
                        {item.warehouse ? <span className="inline-flex items-center gap-1"><Warehouse className="w-3 h-3" />{item.warehouse}</span> : '-'}
                      </td>
                      <td className="px-4 py-3 text-xs font-bold text-slate-400 align-top min-w-[260px]">{item.priorityReason || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {filteredItems.length === 0 && (
              <div className="py-16 text-center border-t border-white/5">
                <PackageSearch className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                <p className="text-xs font-black uppercase tracking-widest text-slate-500">No hay filas que coincidan con los filtros actuales</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
