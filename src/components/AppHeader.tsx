import { memo } from 'react';
import { Calculator, Download, LogOut, Menu, Printer } from 'lucide-react';

type AppHeaderProps = {
  isExporting: boolean;
  onOpenPrint: () => void;
  onExportCsv: () => void;
  onToggleMenu: () => void;
  onLogout: () => void;
};

export const AppHeader = memo(function AppHeader({
  isExporting,
  onOpenPrint,
  onExportCsv,
  onToggleMenu,
  onLogout
}: AppHeaderProps) {
  return (
    <header className="bg-[#1E293B]/50 backdrop-blur-md border-b border-white/5 sticky top-0 z-30">
      <div className="w-full px-4 h-20 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button type="button" title="Abrir menu" aria-label="Abrir menu" onClick={onToggleMenu} className="p-3 bg-white/5 hover:bg-white/10 text-slate-400 rounded-2xl border border-white/5 lg:hidden">
            <Menu className="w-5 h-5" />
          </button>
          <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center">
            <Calculator className="text-white w-7 h-7" />
          </div>
          <h1 className="text-xl font-black text-white">CIERRES 1.1</h1>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <button type="button" title="Ver reporte" aria-label="Ver reporte" onClick={onOpenPrint} className="p-3 bg-white/5 hover:bg-blue-500/10 text-slate-400 rounded-2xl border border-white/5">
            <Printer className="w-5 h-5" />
          </button>
          <button type="button" title="Exportar CSV" aria-label="Exportar CSV" disabled={isExporting} onClick={onExportCsv} className="p-3 bg-white/5 hover:bg-emerald-500/10 disabled:opacity-50 text-slate-400 rounded-2xl border border-white/5">
            <Download className={`w-5 h-5 ${isExporting ? 'animate-pulse' : ''}`} />
          </button>
          <button type="button" title="Cerrar sesión" aria-label="Cerrar sesión" onClick={onLogout} className="p-3 bg-white/5 hover:bg-red-500/10 text-slate-400 rounded-2xl border border-white/5">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  );
});
