import { LayoutDashboard, Home, Truck, Wallet, X } from 'lucide-react';

export type AppView = 'main' | 'dashboard' | 'personal';

type ModuleSidebarProps = {
  open: boolean;
  activeView: AppView;
  onClose: () => void;
  onNavigate: (view: AppView) => void;
  onOpenTrips: () => void;
};

const navigationItems = [
  {
    id: 'main' as const,
    title: 'Cierres de caja',
    subtitle: 'Conciliacion y fotos',
    Icon: Home,
    color: 'text-blue-300'
  },
  {
    id: 'dashboard' as const,
    title: 'Analitica',
    subtitle: 'Indicadores financieros',
    Icon: LayoutDashboard,
    color: 'text-violet-300'
  },
  {
    id: 'personal' as const,
    title: 'Finanzas personales',
    subtitle: 'Cajas y movimientos',
    Icon: Wallet,
    color: 'text-emerald-300'
  }
];

export function ModuleSidebar({
  open,
  activeView,
  onClose,
  onNavigate,
  onOpenTrips
}: ModuleSidebarProps) {
  const selectView = (view: AppView) => {
    onNavigate(view);
    onClose();
  };

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Cerrar menu"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside className={`fixed left-0 top-20 bottom-0 z-40 w-[288px] border-r border-white/5 bg-[#111C31]/98 p-4 shadow-2xl transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
        <div className="flex items-center justify-between border-b border-white/5 px-2 pb-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">Navegacion</p>
            <h2 className="mt-1 text-lg font-black text-white">Modulos</h2>
          </div>
          <button type="button" aria-label="Cerrar menu" onClick={onClose} className="p-2 text-slate-500 hover:text-white lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="mt-4 space-y-2" aria-label="Modulos administrativos">
          {navigationItems.map(item => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => selectView(item.id)}
                className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${active ? 'border-blue-500/30 bg-blue-500/10' : 'border-white/5 bg-white/[0.03] hover:bg-white/[0.07]'}`}
              >
                <span className="flex items-center gap-3">
                  <span className={`flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 ${item.color}`}>
                    <item.Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-black uppercase tracking-wide text-white">{item.title}</span>
                    <span className="block truncate text-[11px] font-bold text-slate-500">{item.subtitle}</span>
                  </span>
                </span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => {
              onOpenTrips();
              onClose();
            }}
            className="w-full rounded-2xl border border-white/5 bg-white/[0.03] px-3 py-3 text-left transition-colors hover:bg-white/[0.07]"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-amber-300">
                <Truck className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-xs font-black uppercase tracking-wide text-white">Recolecciones</span>
                <span className="block text-[11px] font-bold text-slate-500">Viajes y depositos</span>
              </span>
            </span>
          </button>
        </nav>

        <div className="absolute bottom-5 left-4 right-4 rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Conciliacion activa</p>
          <p className="mt-1 text-[11px] font-bold text-slate-400">Fotos Telegram y reportes Perseo.</p>
        </div>
      </aside>
    </>
  );
}
