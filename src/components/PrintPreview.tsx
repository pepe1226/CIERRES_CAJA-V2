import { memo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';
import { Calendar, Download, Printer, X } from 'lucide-react';
import type { ShiftClosure } from '../types';
import type { CashBoxStatus } from '../lib/cashLedger';

type ClosureGroup = {
  date: string;
  items: ShiftClosure[];
  totals: {
    physicalAmount: number;
    systemAmount: number;
    systemBalance: number;
    difference: number;
  };
};

type PrintPreviewProps = {
  open: boolean;
  filterStartDate: string;
  filterEndDate: string;
  userName: string;
  groups: ClosureGroup[];
  closureCount: number;
  getClosureDisplayStatus: (closure: ShiftClosure) => CashBoxStatus;
  onClose: () => void;
};

export const PrintPreview = memo(function PrintPreview({
  open,
  filterStartDate,
  filterEndDate,
  userName,
  groups,
  closureCount,
  getClosureDisplayStatus,
  onClose
}: PrintPreviewProps) {
  const reportRef = useRef<HTMLDivElement>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  if (!open) return null;

  const totalPhysical = groups.reduce((total, group) => total + group.totals.physicalAmount, 0);
  const totalDifference = groups.reduce((total, group) => total + group.totals.difference, 0);
  const auditId = Date.now();

  const handleDownload = async () => {
    if (!reportRef.current || isDownloading) return;

    setPrintError(null);
    setIsDownloading(true);

    try {
      const { default: html2pdf } = await import('html2pdf.js');
      await html2pdf().set({
        margin: 0,
        filename: `reporte_cierres_${format(new Date(), 'yyyy-MM-dd')}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      }).from(reportRef.current).save();
    } catch (error) {
      console.error('PDF Error:', error);
      setPrintError('No se pudo generar el PDF. Intenta nuevamente.');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#F8FAFC] text-slate-900 z-[9999] overflow-auto print:block">
      <div className="p-8 flex justify-between bg-[#0F172A] text-white print:hidden items-center">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-blue-600 rounded-2xl">
            <Printer className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-xl font-black uppercase tracking-tight">Previsualización de Reporte</h3>
            <p className="text-slate-400 text-xs uppercase tracking-widest">
              {format(new Date(), "EEEE dd 'de' MMMM", { locale: es })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {printError && <p className="text-xs font-bold text-rose-300">{printError}</p>}
          <button
            onClick={handleDownload}
            disabled={isDownloading}
            className="bg-white text-[#0F172A] hover:bg-slate-100 disabled:opacity-60 px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-lg flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            {isDownloading ? 'Generando...' : 'Descargar PDF'}
          </button>
          <button
            onClick={onClose}
            className="bg-rose-600 hover:bg-rose-500 text-white px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-lg flex items-center gap-2"
          >
            <X className="w-4 h-4" />
            Cerrar Preview
          </button>
        </div>
      </div>

      <div ref={reportRef} className="max-w-[210mm] mx-auto bg-white p-16 shadow-2xl min-h-screen">
        <div className="flex justify-between items-start border-b-4 border-slate-950 pb-10 mb-12">
          <div>
            <h1 className="text-5xl font-black text-slate-950 mb-2 font-sans">REPORTE DE CIERRES</h1>
            <p className="text-slate-500 font-sans font-black tracking-widest text-sm uppercase">Consolidado de Operaciones - Sistema 1.1</p>
            <p className="text-slate-500 text-xs mt-4 uppercase font-bold tracking-widest flex items-center gap-2">
              <Calendar className="w-3 h-3" />
              Periodo: {format(parseISO(filterStartDate), 'dd/MM/yyyy')} - {format(parseISO(filterEndDate), 'dd/MM/yyyy')}
            </p>
          </div>
          <div className="text-right">
            <div className="bg-slate-950 text-white p-4 rounded-2xl mb-4">
              <p className="text-[10px] font-black tracking-widest mb-1 uppercase opacity-60">Total Consolidado</p>
              <p className="text-2xl font-black font-sans">${totalPhysical.toLocaleString('es-CL')}</p>
            </div>
            <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">Generado por</p>
            <p className="text-slate-900 text-xs font-black uppercase">{userName}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-8 mb-12">
          <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Recaudado</p>
            <p className="text-3xl font-black text-slate-950 font-sans">${totalPhysical.toLocaleString('es-CL')}</p>
          </div>
          <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Diferencias</p>
            <p className={`text-3xl font-black font-sans ${totalDifference < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
              ${totalDifference.toLocaleString('es-CL')}
            </p>
          </div>
          <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cant. Registros</p>
            <p className="text-3xl font-black text-slate-950 font-sans">{closureCount}</p>
          </div>
        </div>

        <div className="space-y-12">
          {groups.map(group => (
            <div key={group.date} className="page-break-inside-avoid">
              <div className="flex items-center justify-between border-b-2 border-slate-200 pb-2 mb-4">
                <h3 className="text-lg font-black text-slate-950 uppercase tracking-tight">
                  {format(parseISO(group.date), 'EEEE dd MMMM yyyy', { locale: es })}
                </h3>
                <div className="text-right">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-4">Total Día</span>
                  <span className="text-lg font-black text-slate-950 font-sans">${group.totals.physicalAmount.toLocaleString('es-CL')}</span>
                </div>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-500 font-black text-[10px] uppercase tracking-widest text-left border-b border-slate-100">
                    <th className="py-4">Hora</th>
                    <th className="py-4">Responsable</th>
                    <th className="py-4 text-right">Monto Físico</th>
                    <th className="py-4 text-right">Diferencia</th>
                    <th className="py-4 text-center">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map(item => {
                    const status = getClosureDisplayStatus(item);
                    return (
                      <tr key={item.id} className="border-b border-slate-50 text-slate-700">
                        <td className="py-4 font-sans font-bold text-slate-500">{format(parseISO(item.date), 'HH:mm')}</td>
                        <td className="py-4 font-black text-slate-900 uppercase text-xs">{item.responsible}</td>
                        <td className="py-4 text-right font-black font-sans text-slate-950">${item.physicalAmount.toLocaleString('es-CL')}</td>
                        <td className={`py-4 text-right font-black font-sans ${item.difference < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          ${item.difference.toLocaleString('es-CL')}
                        </td>
                        <td className="py-4 text-center">
                          <span className="text-[8px] font-black uppercase tracking-widest bg-slate-100 px-2 py-1 rounded">
                            {status === 'bank' ? 'En Banco' : status === 'transit' ? 'Tránsito' : 'En Tienda'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div className="mt-20 pt-10 border-t border-slate-200 text-center">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Fin del Reporte - Registro de Auditoría: {auditId}</p>
          <div className="mt-8 flex justify-center gap-20">
            <div className="w-48 border-t border-slate-300 pt-2">
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Firma Responsable</p>
            </div>
            <div className="w-48 border-t border-slate-300 pt-2">
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Firma Revisión</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
