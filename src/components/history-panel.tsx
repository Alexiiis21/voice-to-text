'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Panel } from './panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { TranscriptionView } from '@/lib/api-types';
import { STATUS_LABEL, formatCost, formatDateTime, formatDuration } from '@/lib/utils';

interface HistoryPanelProps {
  items: TranscriptionView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}

export function HistoryPanel({
  items,
  activeId,
  onSelect,
  onDeleted,
}: HistoryPanelProps): React.JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<TranscriptionView | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/transcriptions/${pendingDelete.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `El servidor respondió ${response.status}`);
      }
      onDeleted(pendingDelete.id);
      toast.success('Transcripción borrada');
      setPendingDelete(null);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('No se pudo borrar', { description: message });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Panel label="HISTORIAL" bodyClassName="p-0">
        {items.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">
            Aquí aparecerán las transcripciones de este navegador.
          </p>
        ) : (
          <ScrollArea className="max-h-[520px]">
            <ul>
              {items.map((item) => {
                const selected = item.id === activeId;
                return (
                  <li key={item.id} className="border-b border-line last:border-b-0">
                    <div
                      className={`flex items-start gap-3 px-4 py-3 ${
                        selected ? 'bg-white/[0.04]' : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(item.id)}
                        className="min-w-0 flex-1 text-left transition-colors hover:text-fg"
                        aria-current={selected ? 'true' : undefined}
                      >
                        <span className="block truncate text-sm text-fg" title={item.filename}>
                          {item.filename}
                        </span>
                        <span className="mt-1 block micro">
                          {STATUS_LABEL[item.status] ?? item.status.toUpperCase()} ·{' '}
                          {formatDuration(item.durationSec)} · {formatDateTime(item.createdAt)} ·{' '}
                          {formatCost(item.costUsd)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="micro shrink-0 transition-colors hover:text-accent-to"
                        onClick={() => setPendingDelete(item)}
                        aria-label={`Borrar ${item.filename}`}
                      >
                        BORRAR
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </Panel>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Borrar transcripción</DialogTitle>
          <DialogDescription>
            Se eliminarán el registro y los ficheros asociados de{' '}
            <span className="text-fg">{pendingDelete?.filename}</span>. Esta acción no se puede
            deshacer.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <DialogClose asChild>
              <button type="button" className="btn">
                CANCELAR
              </button>
            </DialogClose>
            <button
              type="button"
              className="btn border-accent-to/60 text-accent-to hover:text-fg"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? 'BORRANDO…' : 'BORRAR'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
