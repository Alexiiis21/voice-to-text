'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from './panel';
import { Progress } from '@/components/ui/progress';
import { ALLOWED_EXTENSIONS_LABEL } from '@/lib/client-config';
import { formatBytes, formatDuration } from '@/lib/utils';
import type { ProviderInfo } from '@/lib/api-types';

interface UploadPanelProps {
  busy: boolean;
  uploadPercent: number | null;
  disabledReason: string | null;
  maxUploadMb: number;
  providers: ProviderInfo[];
  provider: string;
  onProviderChange: (name: string) => void;
  onSubmit: (file: File) => void;
}

export function UploadPanel({
  busy,
  uploadPercent,
  disabledReason,
  maxUploadMb,
  providers,
  provider,
  onProviderChange,
  onSubmit,
}: UploadPanelProps): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!file) {
      setObjectUrl(null);
      setDurationSec(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    setDurationSec(null);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Pegado con Ctrl+V en cualquier punto de la página.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const pasted = event.clipboardData?.files?.[0];
      if (pasted) {
        event.preventDefault();
        setFile(pasted);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  }, []);

  const tooLarge = useMemo(
    () => (file ? file.size > maxUploadMb * 1024 * 1024 : false),
    [file, maxUploadMb],
  );

  const blocked = busy || disabledReason !== null || tooLarge;

  return (
    <Panel label="ENTRADA" active={!busy && file !== null}>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Zona para soltar o seleccionar un archivo de audio"
        className={[
          'flex min-h-[132px] cursor-pointer flex-col items-center justify-center gap-2',
          'border border-dashed px-4 py-6 text-center transition-colors',
          dragging
            ? 'border-accent-from bg-white/[0.04]'
            : 'border-white/[0.14] hover:border-white/25 hover:bg-white/[0.02]',
        ].join(' ')}
      >
        <span className="micro">ARRASTRA · PEGA CON CTRL+V · O HAZ CLIC</span>
        <span className="text-sm text-fg-muted">{ALLOWED_EXTENSIONS_LABEL}</span>
        <span className="micro">MÁXIMO {maxUploadMb} MB · SIN LÍMITE DE DURACIÓN</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.ogg,.opus,.mp3,.m4a,.wav,.webm,.aac,.flac"
        className="sr-only"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) setFile(selected);
          event.target.value = '';
        }}
      />

      {file && (
        <div className="mt-4 space-y-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <div className="col-span-2 min-w-0 sm:col-span-3">
              <dt className="micro">ARCHIVO</dt>
              <dd className="truncate text-sm text-fg" title={file.name}>
                {file.name}
              </dd>
            </div>
            <div>
              <dt className="micro">TAMAÑO</dt>
              <dd className="text-sm text-fg-muted">{formatBytes(file.size)}</dd>
            </div>
            <div>
              <dt className="micro">DURACIÓN</dt>
              <dd className="text-sm text-fg-muted">{formatDuration(durationSec)}</dd>
            </div>
            <div>
              <dt className="micro">TIPO</dt>
              <dd className="truncate text-sm text-fg-muted">{file.type || 'desconocido'}</dd>
            </div>
          </dl>

          {objectUrl && (
            <audio
              controls
              preload="metadata"
              src={objectUrl}
              onLoadedMetadata={(event) => {
                const value = event.currentTarget.duration;
                setDurationSec(Number.isFinite(value) ? value : null);
              }}
            />
          )}

          {tooLarge && (
            <p className="text-sm text-accent-to" role="alert">
              El archivo pesa {formatBytes(file.size)} y el máximo son {maxUploadMb} MB.
            </p>
          )}
        </div>
      )}

      {uploadPercent !== null && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="micro">SUBIENDO</span>
            <span className="micro">{uploadPercent}%</span>
          </div>
          <Progress value={uploadPercent} aria-label="Progreso de la subida" />
        </div>
      )}

      {/* Selector de motor. Los proveedores sin clave en el servidor se
          muestran desactivados: la interfaz no puede forzar uno sin credencial. */}
      {providers.length > 0 && (
        <div className="mt-4">
          <p className="micro mb-2" id="motor-label">
            MOTOR DE TRANSCRIPCIÓN
          </p>
          <div
            role="radiogroup"
            aria-labelledby="motor-label"
            className="inline-flex border border-line"
          >
            {providers.map((item) => {
              const selected = item.name === provider;
              return (
                <button
                  key={item.name}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!item.available || busy}
                  onClick={() => onProviderChange(item.name)}
                  title={
                    item.available
                      ? `${item.model} · ~$${item.pricePerAudioHourUsd.toFixed(2)}/hora de audio`
                      : `Falta la clave de API de ${item.label} en el servidor`
                  }
                  className={[
                    'font-mono text-[11px] uppercase tracking-micro px-4 py-2',
                    'border-r border-line last:border-r-0 transition-colors',
                    'disabled:opacity-30 disabled:pointer-events-none',
                    selected ? 'bg-ink-950 text-fg' : 'text-fg-faint hover:text-fg-muted',
                  ].join(' ')}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-fg-faint">
            {providers.filter((item) => item.available).length > 1
              ? 'Si el motor elegido se queda sin cuota a mitad, los fragmentos restantes pasan al otro automáticamente.'
              : 'Sin cuota, el trabajo se aparca y se reanuda solo cuando la ventana se abre.'}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-accent"
          disabled={!file || blocked}
          onClick={() => {
            if (file && !blocked) onSubmit(file);
          }}
        >
          {busy ? 'PROCESANDO…' : 'TRANSCRIBIR'}
        </button>

        {file && !busy && (
          <button type="button" className="btn" onClick={() => setFile(null)}>
            QUITAR
          </button>
        )}

        {disabledReason && (
          <span className="text-sm text-fg-faint" role="status">
            {disabledReason}
          </span>
        )}
      </div>
    </Panel>
  );
}
