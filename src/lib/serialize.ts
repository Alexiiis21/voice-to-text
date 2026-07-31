import type { Chunk, Transcription } from '@/db/schema';
import { parseCost } from './cost';

export interface ChunkView {
  idx: number;
  status: Chunk['status'];
  startSec: number;
  endSec: number;
  attempts: number;
  error: string | null;
}

export interface TranscriptionView {
  id: string;
  filename: string;
  sizeBytes: number;
  durationSec: number | null;
  status: Transcription['status'];
  sttProvider: string;
  chunkCount: number;
  wordCount: number | null;
  costUsd: number;
  error: string | null;
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

export function toView(row: Transcription): TranscriptionView {
  return {
    id: row.id,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    durationSec: row.durationSec,
    status: row.status,
    sttProvider: row.sttProvider,
    chunkCount: row.chunkCount,
    wordCount: row.wordCount,
    costUsd: parseCost(row.costUsd),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    hasRaw: Boolean(row.rawText),
    hasClean: Boolean(row.cleanText),
    hasSummary: Boolean(row.summaryText),
  };
}

export function toChunkView(chunk: Chunk): ChunkView {
  return {
    idx: chunk.idx,
    status: chunk.status,
    startSec: Number.parseFloat(chunk.startSec),
    endSec: Number.parseFloat(chunk.endSec),
    attempts: chunk.attempts,
    error: chunk.error,
  };
}

export function toDetail(row: Transcription, chunks: readonly Chunk[]): TranscriptionDetail {
  return {
    ...toView(row),
    rawText: row.rawText,
    cleanText: row.cleanText,
    summaryText: row.summaryText,
    chunks: chunks.map(toChunkView),
  };
}
