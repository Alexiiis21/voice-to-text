'use client';

import { useEffect, useState } from 'react';
import { Panel } from './panel';
import { Progress } from '@/components/ui/progress';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { ChunkView, TranscriptionView } from '@/lib/api-types';
import { STATUS_LABEL, formatCost, formatDuration } from '@/lib/utils';

interface ProgressPanelProps {
  transcription: TranscriptionView;
  chunks: ChunkView[];
}

const ACTIVE_STATUSES = new Set(['queued', 'processing', 'transcribed', 'editing']);

function useElapsed(startedAt: string | null, completedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (completedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [completedAt]);

  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : now;
  return Math.max(0, (end - start) / 1000);
}

function chunkClass(status: ChunkView['status']): string {
  switch (status) {
    case 'done':
      return 'bg-gradient-to-b from-accent-from to-accent-to';
    case 'failed':
      return 'bg-white/[0.10] outline outline-1 outline-accent-to';
    default:
      return 'bg-white/[0.08] animate-bar-pulse';
  }
}

/**
 * Fila de rectángulos, uno por fragmento, que se rellenan conforme se
 * completan. Es el elemento visual central de la app (§8).
 */
export function ProgressPanel({ transcription, chunks }: ProgressPanelProps): React.JSX.Element {
  const elapsed = useElapsed(transcription.startedAt, transcription.completedAt);
  const total = Math.max(transcription.chunkCount, chunks.length);
  const done = chunks.filter((chunk) => chunk.status === 'done').length;
  const failed = chunks.filter((chunk) => chunk.status === 'failed').length;
  const settled = done + failed;
  const percent = total > 0 ? Math.round((settled / total) * 100) : 0;
  const active = ACTIVE_STATUSES.has(transcription.status);
  // Aparcada por falta de cuota en el proveedor: no es un fallo, es una espera.
  const waiting =
    transcription.status === 'queued' &&
    transcription.resumeAfter !== null &&
    new Date(transcription.resumeAfter).getTime() > Date.now();

  return (
    <Panel label="FRAGMENTOS" active={active}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <p className="micro">ESTADO</p>
          <p
            className="text-lg font-bold tracking-tightest text-fg"
            aria-live="polite"
            aria-atomic="true"
          >
            {waiting
              ? 'ESPERANDO CUOTA'
              : (STATUS_LABEL[transcription.status] ?? transcription.status.toUpperCase())}
          </p>
        </div>
        <div className="text-right">
          <p className="micro">TRANSCURRIDO</p>
          <p className="font-mono text-lg text-fg-muted tabular-nums">
            {formatDuration(elapsed)}
          </p>
        </div>
      </div>

      <div className="mt-4">
        {total > 0 ? (
          <TooltipProvider delayDuration={120}>
            <ul
              className="flex flex-wrap gap-1"
              aria-label={`Progreso por fragmentos: ${settled} de ${total}`}
            >
              {Array.from({ length: total }, (_, index) => {
                const chunk = chunks.find((item) => item.idx === index);
                const status: ChunkView['status'] = chunk?.status ?? 'pending';
                return (
                  <li key={index}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={`h-7 w-4 sm:w-5 ${chunkClass(status)}`}
                          aria-label={`Fragmento ${index + 1}: ${status}`}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <span>
                          {`FRAGMENTO ${index + 1} · ${status}`}
                          {chunk ? ` · ${formatDuration(chunk.startSec)}` : ''}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </TooltipProvider>
        ) : (
          <div className="flex gap-1" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <span key={index} className="h-7 w-4 bg-white/[0.08] animate-bar-pulse sm:w-5" />
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <Progress value={percent} aria-label="Progreso global de la transcripción" />
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <span className="micro">
            {settled} / {total || '—'} FRAGMENTOS
            {failed > 0 ? ` · ${failed} FALLIDOS` : ''}
          </span>
          <span className="micro">
            {transcription.durationSec !== null
              ? `${formatDuration(transcription.durationSec)} DE AUDIO · `
              : ''}
            {transcription.sttProvider.toUpperCase()} · {formatCost(transcription.costUsd)}
          </span>
        </div>
      </div>

      {transcription.error && (
        <p
          className={[
            'mt-3 border p-3 text-sm text-fg-muted',
            waiting
              ? 'border-white/[0.14] bg-white/[0.03]'
              : 'border-accent-to/40 bg-accent-to/[0.06]',
          ].join(' ')}
          role="status"
        >
          {waiting && <span className="micro mr-2">EN ESPERA</span>}
          {transcription.error}
        </p>
      )}
    </Panel>
  );
}
