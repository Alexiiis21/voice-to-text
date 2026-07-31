'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from './panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OUTPUT_TABS } from '@/lib/client-config';
import type { OutputMode, TranscriptionDetail } from '@/lib/api-types';

interface ResultPanelProps {
  detail: TranscriptionDetail;
  onSummaryGenerated: (summaryText: string) => void;
}

function textFor(detail: TranscriptionDetail, mode: OutputMode): string | null {
  switch (mode) {
    case 'raw':
      return detail.rawText;
    case 'clean':
      return detail.cleanText;
    case 'summary':
      return detail.summaryText;
  }
}

function fileNameFor(detail: TranscriptionDetail, mode: OutputMode): string {
  const base = detail.filename.replace(/\.[^.]+$/, '') || 'transcripcion';
  const suffix = mode === 'raw' ? 'crudo' : mode === 'clean' ? 'editado' : 'resumen';
  return `${base}.${suffix}.txt`;
}

function LoadingBars(): React.JSX.Element {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[100, 92, 97, 74, 88, 60].map((width, index) => (
        <span
          key={index}
          className="skeleton-bar block"
          style={{ width: `${width}%`, animationDelay: `${index * 90}ms` }}
        />
      ))}
    </div>
  );
}

export function ResultPanel({
  detail,
  onSummaryGenerated,
}: ResultPanelProps): React.JSX.Element {
  const [mode, setMode] = useState<OutputMode>('raw');
  const [copied, setCopied] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const text = textFor(detail, mode);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // El resumen se genera bajo demanda, la primera vez que se abre la pestaña.
  const requestSummary = useCallback(async () => {
    if (detail.summaryText || summaryLoading) return;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const response = await fetch(`/api/transcriptions/${detail.id}/summary`, {
        method: 'POST',
      });
      const payload = (await response.json()) as { summaryText?: string; error?: string };
      if (!response.ok || !payload.summaryText) {
        throw new Error(payload.error ?? `El servidor respondió ${response.status}`);
      }
      onSummaryGenerated(payload.summaryText);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setSummaryError(message);
      toast.error('No se pudo generar el resumen', { description: message });
    } finally {
      setSummaryLoading(false);
    }
  }, [detail.id, detail.summaryText, onSummaryGenerated, summaryLoading]);

  const onCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast.error('El navegador bloqueó el acceso al portapapeles');
    }
  }, [text]);

  const onDownload = useCallback(() => {
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameFor(detail, mode);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [detail, mode, text]);

  const emptyMessage = ((): string => {
    if (mode === 'raw') return 'Todavía no hay transcripción cruda.';
    if (mode === 'clean') {
      return detail.status === 'done'
        ? 'La edición no está disponible para esta transcripción. Usa la pestaña CRUDO.'
        : 'La versión editada se genera al terminar la transcripción.';
    }
    return summaryError ?? 'Pulsa para generar el resumen.';
  })();

  return (
    <Panel label="TRANSCRIPCIÓN" active={detail.status === 'done'} bodyClassName="p-4 sm:p-5">
      <Tabs
        value={mode}
        onValueChange={(value) => {
          const next = value as OutputMode;
          setMode(next);
          if (next === 'summary') void requestSummary();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList aria-label="Modo de salida">
            {OUTPUT_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex items-center gap-2">
            <button type="button" className="btn" onClick={() => void onCopy()} disabled={!text}>
              {copied ? 'COPIADO ✓' : 'COPIAR'}
            </button>
            <button type="button" className="btn" onClick={onDownload} disabled={!text}>
              DESCARGAR .TXT
            </button>
          </div>
        </div>

        {OUTPUT_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <ScrollArea className="h-[420px] border border-line bg-ink-950 lg:h-[52vh]">
              <div className="p-4">
                {tab.value === 'summary' && summaryLoading ? (
                  <LoadingBars />
                ) : textFor(detail, tab.value) ? (
                  <p className="whitespace-pre-wrap text-[15px] leading-[1.75] text-fg">
                    {textFor(detail, tab.value)}
                  </p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-fg-muted">{emptyMessage}</p>
                    {tab.value === 'summary' && !summaryLoading && (
                      <button type="button" className="btn" onClick={() => void requestSummary()}>
                        GENERAR RESUMEN
                      </button>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>

      <p className="mt-3 micro">
        {detail.wordCount !== null ? `${detail.wordCount} PALABRAS · ` : ''}
        {detail.chunkCount} FRAGMENTOS · {detail.sttProvider.toUpperCase()}
      </p>
    </Panel>
  );
}
