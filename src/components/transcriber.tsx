'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HistoryPanel } from './history-panel';
import { ProgressPanel } from './progress-panel';
import { ResultPanel } from './result-panel';
import { Turnstile } from './turnstile';
import { UploadPanel } from './upload-panel';
import { Switch } from '@/components/ui/switch';
import type {
  ChunkView,
  QuotaSnapshot,
  TranscriptionDetail,
  TranscriptionView,
} from '@/lib/api-types';

interface TranscriberProps {
  turnstileSiteKey: string | null;
  maxUploadMb: number;
  cleanupEnabledByDefault: boolean;
  retentionDays: number;
}

const TERMINAL = new Set(['done', 'failed']);

export function Transcriber({
  turnstileSiteKey,
  maxUploadMb,
  cleanupEnabledByDefault,
  retentionDays,
}: TranscriberProps): React.JSX.Element {
  const [detail, setDetail] = useState<TranscriptionDetail | null>(null);
  const [history, setHistory] = useState<TranscriptionView[]>([]);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notifyOnDone, setNotifyOnDone] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const notifyRef = useRef(false);

  useEffect(() => {
    notifyRef.current = notifyOnDone;
  }, [notifyOnDone]);

  /** Aviso del sistema al terminar, si el usuario lo pidió y dio permiso. */
  const notifyFinished = useCallback((filename: string) => {
    if (!notifyRef.current) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    new Notification('Transcripción lista', { body: filename });
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/transcriptions', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as { items: TranscriptionView[] };
      setHistory(payload.items);
    } catch {
      // El historial es accesorio; un fallo aquí no bloquea nada.
    }
  }, []);

  const refreshQuota = useCallback(async () => {
    try {
      const response = await fetch('/api/quota', { cache: 'no-store' });
      if (!response.ok) return;
      setQuota((await response.json()) as QuotaSnapshot);
    } catch {
      // idem
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
    void refreshQuota();
  }, [refreshHistory, refreshQuota]);

  const loadDetail = useCallback(async (id: string): Promise<TranscriptionDetail | null> => {
    try {
      const response = await fetch(`/api/transcriptions/${id}`, { cache: 'no-store' });
      if (!response.ok) return null;
      const payload = (await response.json()) as TranscriptionDetail;
      setDetail(payload);
      return payload;
    } catch {
      return null;
    }
  }, []);

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  /** SSE con el progreso en vivo: es la vía principal (§5). */
  const openStream = useCallback(
    (id: string) => {
      closeStream();
      const source = new EventSource(`/api/transcriptions/${id}/stream`);
      sourceRef.current = source;

      source.addEventListener('chunk_done', (event) => {
        const chunk = JSON.parse((event as MessageEvent<string>).data) as ChunkView;
        setDetail((current) => {
          if (!current || current.id !== id) return current;
          const chunks = [...current.chunks];
          const position = chunks.findIndex((item) => item.idx === chunk.idx);
          if (position >= 0) chunks[position] = chunk;
          else chunks.push(chunk);
          chunks.sort((a, b) => a.idx - b.idx);
          return { ...current, chunks };
        });
      });

      source.addEventListener('status_change', (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          transcription: TranscriptionView;
          chunks: ChunkView[];
        };
        setDetail((current) =>
          current && current.id === id
            ? { ...current, ...payload.transcription, chunks: payload.chunks }
            : current,
        );
        void refreshHistory();
      });

      source.addEventListener('done', () => {
        closeStream();
        void loadDetail(id).then((loaded) => {
          if (loaded?.status === 'done') {
            toast.success('Transcripción lista', { description: loaded.filename });
            notifyFinished(loaded.filename);
          }
        });
        void refreshHistory();
        setBusy(false);
      });

      source.addEventListener('error', (event) => {
        const raw = (event as MessageEvent<string>).data;
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            const payload = JSON.parse(raw) as { message?: string };
            toast.error('La transcripción falló', { description: payload.message });
          } catch {
            toast.error('La transcripción falló');
          }
          closeStream();
          void loadDetail(id);
          setBusy(false);
        }
        // Sin `data` es una desconexión de red: EventSource reconecta solo.
      });

      source.onerror = () => {
        // Reconexión automática de EventSource; no cerramos aquí.
      };
    },
    [closeStream, loadDetail, notifyFinished, refreshHistory],
  );

  useEffect(() => closeStream, [closeStream]);

  const submit = useCallback(
    (file: File) => {
      if (turnstileSiteKey && !turnstileToken) {
        toast.error('Completa la verificación antibot antes de subir');
        return;
      }

      setBusy(true);
      setUploadPercent(0);
      setDetail(null);
      closeStream();

      const form = new FormData();
      // El token va ANTES del fichero: el servidor lo verifica sin haber
      // escrito un solo byte en disco.
      if (turnstileToken) form.append('turnstileToken', turnstileToken);
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/transcriptions');

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          setUploadPercent(Math.round((event.loaded / event.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        setUploadPercent(null);

        let payload: { id?: string; transcription?: TranscriptionView; quota?: QuotaSnapshot; error?: string } = {};
        try {
          payload = JSON.parse(xhr.responseText) as typeof payload;
        } catch {
          payload = { error: 'Respuesta ilegible del servidor' };
        }

        if (xhr.status !== 202 || !payload.id) {
          setBusy(false);
          toast.error('No se pudo encolar el audio', {
            description: payload.error ?? `El servidor respondió ${xhr.status}`,
          });
          void refreshQuota();
          return;
        }

        if (payload.quota) setQuota(payload.quota);
        if (payload.transcription) {
          setDetail({
            ...payload.transcription,
            rawText: null,
            cleanText: null,
            summaryText: null,
            chunks: [],
          });
        }

        openStream(payload.id);
        void refreshHistory();
        toast.success('Audio en cola', { description: file.name });
      });

      xhr.addEventListener('error', () => {
        setUploadPercent(null);
        setBusy(false);
        toast.error('Error de red durante la subida');
      });

      xhr.addEventListener('abort', () => {
        setUploadPercent(null);
        setBusy(false);
      });

      xhr.send(form);
    },
    [closeStream, openStream, refreshHistory, refreshQuota, turnstileSiteKey, turnstileToken],
  );

  const selectFromHistory = useCallback(
    (id: string) => {
      void loadDetail(id).then((loaded) => {
        if (!loaded) return;
        if (!TERMINAL.has(loaded.status)) {
          setBusy(true);
          openStream(id);
        } else {
          setBusy(false);
          closeStream();
        }
      });
    },
    [closeStream, loadDetail, openStream],
  );

  const remaining = quota?.transcriptionsRemaining ?? null;

  return (
    <div className="min-h-screen">
      {/* 1. Barra superior fija */}
      <header className="sticky top-0 z-40 border-b border-line bg-ink-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-3">
          <span className="font-mono text-[13px] font-bold uppercase tracking-micro text-fg">
            TRANSCRIPTOR
          </span>
          <span className="micro" aria-live="polite">
            USOS RESTANTES: {remaining === null ? '—' : remaining}
          </span>
        </div>
      </header>

      {/* 2. Hero corto */}
      <div className="grid-backdrop border-b border-line">
        <div className="mx-auto max-w-[1400px] px-5 py-12 sm:py-16">
          <h1 className="max-w-[16ch] font-bold leading-[1.05] tracking-tightest text-fg [font-size:clamp(40px,6vw,72px)]">
            Audio a texto, sin límite de duración
          </h1>
          <p className="mt-4 max-w-[62ch] text-fg-muted">
            Sube una grabación en español de cualquier duración. Se trocea en silencios, se
            transcribe fragmento a fragmento y se devuelve en tres formas: cruda, editada y
            resumida.
          </p>
        </div>
      </div>

      <main className="mx-auto grid max-w-[1400px] grid-cols-1 gap-5 px-5 py-8 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* Columna izquierda: entrada + historial */}
        <div className="space-y-5">
          <UploadPanel
            busy={busy}
            uploadPercent={uploadPercent}
            maxUploadMb={maxUploadMb}
            disabledReason={
              remaining !== null && remaining <= 0
                ? 'Has agotado los usos de esta hora.'
                : turnstileSiteKey && !turnstileToken
                  ? 'Completa la verificación antibot.'
                  : null
            }
            onSubmit={submit}
          />

          <HistoryPanel
            items={history}
            activeId={detail?.id ?? null}
            onSelect={selectFromHistory}
            onDeleted={(id) => {
              setHistory((current) => current.filter((item) => item.id !== id));
              if (detail?.id === id) {
                closeStream();
                setDetail(null);
                setBusy(false);
              }
              void refreshQuota();
            }}
          />
        </div>

        {/* Columna derecha: progreso + resultado */}
        <div className="space-y-5">
          {detail ? (
            <>
              <ProgressPanel transcription={detail} chunks={detail.chunks} />
              <ResultPanel
                detail={detail}
                onSummaryGenerated={(summaryText) =>
                  setDetail((current) =>
                    current ? { ...current, summaryText, hasSummary: true } : current,
                  )
                }
              />
            </>
          ) : (
            <section className="panel">
              <header className="panel-bar">
                <span className="panel-dots" aria-hidden="true" />
                <span className="micro">TRANSCRIPCIÓN</span>
              </header>
              <div className="space-y-4 p-5">
                <p className="text-sm text-fg-muted">
                  Sin transcripción seleccionada. Sube un audio o elige uno del historial.
                </p>
                <div className="space-y-2" aria-hidden="true">
                  {[100, 84, 92, 66].map((width, index) => (
                    <span
                      key={index}
                      className="skeleton-bar block"
                      style={{ width: `${width}%`, animationDelay: `${index * 110}ms` }}
                    />
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </main>

      {/* 7. Pie mínimo: retención + Turnstile */}
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-5 py-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-[70ch] space-y-2">
            <p className="micro">RETENCIÓN DE DATOS</p>
            <p className="text-sm text-fg-muted">
              El audio original se borra del disco en cuanto termina la transcripción. Los textos
              se conservan {retentionDays} días y luego se eliminan automáticamente. El historial
              se asocia a una cookie anónima de este navegador; no es un mecanismo de seguridad.
            </p>
            <div className="flex items-center gap-3 pt-1">
              <Switch
                id="notify-on-done"
                checked={notifyOnDone}
                onCheckedChange={(checked) => {
                  setNotifyOnDone(checked);
                  if (checked && typeof Notification !== 'undefined') {
                    if (Notification.permission === 'default') {
                      void Notification.requestPermission();
                    } else if (Notification.permission === 'denied') {
                      toast.error('El navegador tiene bloqueadas las notificaciones');
                    }
                  }
                }}
                aria-describedby="notify-hint"
              />
              <label htmlFor="notify-on-done" className="micro cursor-pointer">
                AVISARME AL TERMINAR
              </label>
            </div>
            <p id="notify-hint" className="text-xs text-fg-faint">
              {cleanupEnabledByDefault
                ? 'La edición con Claude se lanza automáticamente al terminar la transcripción.'
                : 'La edición automática está desactivada en el servidor: sólo verás la salida CRUDA.'}
            </p>
          </div>

          <div className="shrink-0">
            <p className="micro mb-2">VERIFICACIÓN</p>
            <Turnstile siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
            {!turnstileSiteKey && (
              <p className="text-xs text-fg-faint">
                Turnstile no configurado (desarrollo local).
              </p>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
