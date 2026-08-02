import { useEffect, useRef, useState } from 'react';
import { ImageOff, LoaderCircle, X, ZoomIn } from 'lucide-react';
import { auth } from '../firebase';

type ClosurePhotoThumbnailProps = {
  closureId?: string;
  telegramFileId?: string;
  responsible: string;
  date: string;
};

export function ClosurePhotoThumbnail({ closureId, telegramFileId, responsible, date }: ClosurePhotoThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || shouldLoad || !closureId || !telegramFileId) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: '160px' });

    observer.observe(element);
    return () => observer.disconnect();
  }, [closureId, shouldLoad, telegramFileId]);

  useEffect(() => {
    if (!shouldLoad || !closureId || !telegramFileId) return;

    let active = true;
    let objectUrl = '';

    const loadPhoto = async () => {
      try {
        const user = auth.currentUser;
        if (!user) throw new Error('Sesion no disponible.');
        const token = await user.getIdToken();
        const response = await fetch(`/api/closure-photo?closureId=${encodeURIComponent(closureId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('Foto no disponible.');

        objectUrl = URL.createObjectURL(await response.blob());
        if (active) setImageUrl(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    };

    void loadPhoto();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [closureId, shouldLoad, telegramFileId]);

  if (!closureId || !telegramFileId) return null;

  return (
    <>
      <div ref={containerRef} className="w-10 h-10 shrink-0">
        {failed ? (
          <div title="Foto no disponible" className="w-10 h-10 rounded-md border border-white/10 bg-white/5 flex items-center justify-center text-slate-600">
            <ImageOff className="w-4 h-4" />
          </div>
        ) : imageUrl ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            title="Ampliar foto del corte"
            className="group/photo relative w-10 h-10 rounded-md overflow-hidden border border-white/10 bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <img src={imageUrl} alt={`Corte de ${responsible}`} className="w-full h-full object-cover" />
            <span className="absolute inset-0 bg-slate-950/55 opacity-0 group-hover/photo:opacity-100 flex items-center justify-center transition-opacity">
              <ZoomIn className="w-4 h-4 text-white" />
            </span>
          </button>
        ) : (
          <div className="w-10 h-10 rounded-md border border-white/10 bg-white/5 flex items-center justify-center text-slate-500">
            <LoaderCircle className="w-4 h-4 animate-spin" />
          </div>
        )}
      </div>

      {expanded && imageUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Foto del corte de ${responsible}`}
          className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <button
            type="button"
            onClick={() => setExpanded(false)}
            title="Cerrar foto"
            className="absolute top-4 right-4 w-10 h-10 rounded-md bg-slate-900 border border-white/10 text-white flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="max-w-4xl w-full max-h-[90vh] flex flex-col gap-3" onClick={event => event.stopPropagation()}>
            <img src={imageUrl} alt={`Corte de ${responsible}`} className="max-w-full max-h-[82vh] object-contain mx-auto rounded-md" />
            <div className="text-center text-xs font-bold text-slate-300 uppercase">{responsible} · {date}</div>
          </div>
        </div>
      )}
    </>
  );
}
