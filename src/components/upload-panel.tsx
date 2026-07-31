'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from './panel';
import { Progress } from '@/components/ui/progress';
import { ALLOWED_EXTENSIONS_LABEL } from '@/lib/client-config';
import { formatBytes, formatDuration } from '@/lib/utils';

interface UploadPanelProps {
  busy: boolean;
  uploadPercent: number | null;
  disabledReason: string | null;
  maxUploadMb: number;
  onSubmit: (file: File) => void;
}

export function UploadPanel({
  busy,
  uploadPercent,
  disabledReason,
  maxUploadMb,
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
