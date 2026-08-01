/**
 * Tipos compartidos entre servidor y cliente.
 *
 * Se declaran aquí, sueltos, para que el bundle del cliente no arrastre nada
 * de Drizzle ni del esquema de base de datos.
 */

export type TranscriptionStatus =
  | 'queued'
  | 'processing'
  | 'transcribed'
  | 'editing'
  | 'done'
  | 'failed';

export type ChunkStatus = 'pending' | 'done' | 'failed';

export interface ChunkView {
  idx: number;
  status: ChunkStatus;
  startSec: number;
  endSec: number;
  attempts: number;
  sttProvider: string | null;
  error: string | null;
}

/** Motor de transcripción ofrecido en el selector del panel de entrada. */
export interface ProviderInfo {
  name: 'groq' | 'openai';
  label: string;
  model: string;
  /** true si su clave de API está definida en el servidor. */
  available: boolean;
  pricePerAudioHourUsd: number;
}

export interface TranscriptionView {
  id: string;
  filename: string;
  sizeBytes: number;
  durationSec: number | null;
  status: TranscriptionStatus;
  sttProvider: string;
  chunkCount: number;
  wordCount: number | null;
  costUsd: number;
  error: string | null;
  /** Si está aparcada por falta de cuota, cuándo se reanuda. */
  resumeAfter: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  hasRaw: boolean;
  hasClean: boolean;
  hasSummary: boolean;
}

export interface TranscriptionDetail extends TranscriptionView {
  rawText: string | null;
  cleanText: string | null;
  summaryText: string | null;
  chunks: ChunkView[];
}

export interface QuotaSnapshot {
  transcriptionsUsed: number;
  transcriptionsRemaining: number;
  audioSecondsUsed: number;
  audioSecondsRemaining: number;
  resetInSec: number;
}

export type OutputMode = 'raw' | 'clean' | 'summary';
