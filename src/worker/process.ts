import { CHUNKING, WORKER } from '@/lib/config';
import { env } from '@/lib/env';
import {
  chunkPath,
  fileExists,
  fileSize,
  normalizedPath,
  removeQuietly,
  removeTranscriptionFiles,
  uploadPath,
} from '@/lib/files';
import { detectSilences, extractChunk, normalizeAudio, probeAudio } from '@/lib/ffmpeg';
import { computeCutPoints } from '@/lib/silence';
import { joinChunkTexts } from '@/lib/overlap';
import { getSttAdapter, SttError } from '@/lib/stt';
import { sttCostUsd } from '@/lib/cost';
import { anthropicConfigured, cleanupChunk } from '@/lib/claude';
import type { Chunk, Transcription } from '@/db/schema';
import * as repo from './repo';

/** Señal cooperativa de apagado. El worker termina el fragmento en curso. */
export interface StopSignal {
  stopped(): boolean;
}

export class JobInterrupted extends Error {
  constructor() {
    super('Trabajo interrumpido por apagado limpio');
    this.name = 'JobInterrupted';
  }
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => token.length > 0).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Transcribe un tramo de audio. Si el fragmento extraído supera el límite del
 * proveedor (~25 MB) o `maxChunkBytes`, se parte por la mitad recursivamente.
 *
 * El fragmento se borra del disco en cuanto se ha subido y guardado el texto:
 * nunca se materializan los N fragmentos a la vez (§2, §12).
 */
async function transcribeRange(
  transcriptionId: string,
  idx: number,
  sourcePath: string,
  startSec: number,
  endSec: number,
  depth: number,
  partLabel: string,
): Promise<{ text: string; audioSeconds: number }> {
  const adapter = getSttAdapter();
  const durationSec = Math.max(0.05, endSec - startSec);
  const outPath = chunkPath(transcriptionId, idx, `-d${depth}${partLabel}`);

  await extractChunk(sourcePath, outPath, startSec, durationSec);

  const sizeLimit = Math.min(CHUNKING.maxChunkBytes, adapter.maxFileBytes);
  const size = await fileSize(outPath);

  if (size > sizeLimit) {
    await removeQuietly(outPath);

    if (depth >= CHUNKING.maxSplitDepth) {
      throw new Error(
        `El fragmento ${idx + 1} sigue superando ${sizeLimit} bytes tras ${depth} particiones`,
      );
    }

    const middle = startSec + durationSec / 2;
    const first = await transcribeRange(
      transcriptionId,
      idx,
      sourcePath,
      startSec,
      middle,
      depth + 1,
      `${partLabel}a`,
    );
    const second = await transcribeRange(
      transcriptionId,
      idx,
      sourcePath,
      middle,
      endSec,
      depth + 1,
      `${partLabel}b`,
    );

    return {
      text: [first.text, second.text].filter((part) => part !== '').join(' '),
      audioSeconds: first.audioSeconds + second.audioSeconds,
    };
  }

  try {
    const result = await adapter.transcribe(outPath);
    return { text: result.text, audioSeconds: durationSec };
  } finally {
    await removeQuietly(outPath);
  }
}

/** Reintentos con backoff exponencial: hasta `maxAttempts` por fragmento. */
async function transcribeChunkWithRetries(
  transcriptionId: string,
  chunk: Chunk,
  sourcePath: string,
): Promise<{ text: string; audioSeconds: number }> {
  const start = Number.parseFloat(chunk.startSec);
  const end = Number.parseFloat(chunk.endSec);
  let lastError: unknown = null;

  for (let attempt = chunk.attempts; attempt < CHUNKING.maxAttempts; attempt += 1) {
    await repo.updateChunk(chunk.id, { attempts: attempt + 1 });

    try {
      return await transcribeRange(transcriptionId, chunk.idx, sourcePath, start, end, 0, '');
    } catch (error: unknown) {
      lastError = error;

      const retryable = !(error instanceof SttError) || error.retryable;
      const remaining = CHUNKING.maxAttempts - attempt - 1;

      console.warn(
        `[worker] Fragmento ${chunk.idx + 1} falló (intento ${attempt + 1}/${CHUNKING.maxAttempts}): ${errorMessage(error)}`,
      );

      if (!retryable || remaining <= 0) break;
      await sleep(1000 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Ejecuta `tasks` con concurrencia acotada. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Procesa un trabajo de principio a fin. Lanza `JobInterrupted` si llega
 * SIGTERM entre fragmentos; el llamante lo devuelve a `queued`.
 */
export async function processJob(job: Transcription, stop: StopSignal): Promise<void> {
  const originalPath = uploadPath(job.id, job.sourceExt);
  const normPath = normalizedPath(job.id);

  // ── 1. Normalizar ────────────────────────────────────────────────────────
  if (!(await fileExists(normPath))) {
    if (!(await fileExists(originalPath))) {
      throw new Error('El archivo de audio ya no está en disco');
    }
    console.log(`[worker] Normalizando ${job.id}`);
    await normalizeAudio(originalPath, normPath);
  }

  // ── 2. Duración ──────────────────────────────────────────────────────────
  const probe = await probeAudio(normPath);
  if (job.durationSec === null) {
    await repo.setDuration(job.id, probe.durationSec);
  }

  // ── 3. Puntos de corte ───────────────────────────────────────────────────
  let allChunks = await repo.listChunks(job.id);

  if (allChunks.length === 0) {
    const silences = await detectSilences(normPath);
    const segments = computeCutPoints({
      durationSec: probe.durationSec,
      silences,
      targetSec: env.chunkSeconds,
      windowSec: CHUNKING.searchWindowSec,
      overlapSec: CHUNKING.overlapSec,
    });

    if (segments.length === 0) {
      throw new Error('No se pudo calcular ningún fragmento a partir del audio');
    }

    await repo.insertChunks(job.id, segments);
    await repo.setChunkCount(job.id, segments.length);
    allChunks = await repo.listChunks(job.id);
    console.log(`[worker] ${job.id}: ${segments.length} fragmentos, ${silences.length} silencios`);
  }

  // ── 4. Transcribir fragmento a fragmento ─────────────────────────────────
  const adapter = getSttAdapter();

  for (const chunk of allChunks) {
    if (chunk.status === 'done') continue;
    if (chunk.status === 'failed' && chunk.attempts >= CHUNKING.maxAttempts) continue;

    if (stop.stopped()) throw new JobInterrupted();

    try {
      const { text, audioSeconds } = await transcribeChunkWithRetries(job.id, chunk, normPath);
      await repo.updateChunk(chunk.id, { status: 'done', rawText: text, error: null });
      await repo.addCost(job.id, sttCostUsd(audioSeconds, adapter.pricePerAudioHourUsd));
    } catch (error: unknown) {
      // Nunca abortamos el trabajo entero por un fragmento (§2).
      const message = errorMessage(error);
      await repo.updateChunk(chunk.id, { status: 'failed', error: message.slice(0, 2000) });
      console.error(`[worker] Fragmento ${chunk.idx + 1} de ${job.id} descartado: ${message}`);
    }
  }

  // ── 5. Concatenar ────────────────────────────────────────────────────────
  allChunks = await repo.listChunks(job.id);
  const rawText = joinChunkTexts(
    allChunks.map((chunk) => ({
      idx: chunk.idx,
      hasOverlap: chunk.hasOverlap,
      text: chunk.status === 'done' ? chunk.rawText : null,
    })),
    CHUNKING.overlapWords,
  );

  await repo.setTexts(job.id, { rawText, wordCount: countWords(rawText) });
  await repo.setStatus(job.id, 'transcribed');

  const anyDone = allChunks.some((chunk) => chunk.status === 'done');
  if (!anyDone) {
    await removeTranscriptionFiles(job.id, job.sourceExt);
    throw new Error('Ningún fragmento se pudo transcribir');
  }

  // ── 6. Edición con Haiku, por fragmento ──────────────────────────────────
  const shouldClean = env.enableCleanup && anthropicConfigured();

  if (shouldClean) {
    await repo.setStatus(job.id, 'editing');

    const editable = allChunks.filter(
      (chunk) => chunk.status === 'done' && chunk.rawText !== null && chunk.cleanText === null,
    );

    let cleanupCost = 0;
    await mapWithConcurrency(editable, WORKER.cleanupConcurrency, async (chunk) => {
      if (stop.stopped()) return;
      try {
        const call = await cleanupChunk(chunk.rawText ?? '');
        await repo.updateChunk(chunk.id, { cleanText: call.text });
        cleanupCost += call.costUsd;
      } catch (error: unknown) {
        // El CRUDO es el fallback: si la edición falla no se pierde nada.
        console.warn(
          `[worker] Edición del fragmento ${chunk.idx + 1} falló: ${errorMessage(error)}`,
        );
      }
    });

    await repo.addCost(job.id, cleanupCost);

    const edited = await repo.listChunks(job.id);
    const cleanText = joinChunkTexts(
      edited.map((chunk) => ({
        idx: chunk.idx,
        hasOverlap: chunk.hasOverlap,
        // Si un fragmento no se pudo editar, cae al crudo. No se pierde texto.
        text: chunk.status === 'done' ? (chunk.cleanText ?? chunk.rawText) : null,
      })),
      CHUNKING.overlapWords,
    );

    await repo.setTexts(job.id, { cleanText, wordCount: countWords(cleanText) });
  }

  // ── 7. Borrar el audio del disco y cerrar ────────────────────────────────
  await removeTranscriptionFiles(job.id, job.sourceExt);

  const failedCount = allChunks.filter((chunk) => chunk.status === 'failed').length;
  await repo.setStatus(job.id, 'done', {
    completedAt: new Date(),
    error:
      failedCount > 0
        ? `${failedCount} de ${allChunks.length} fragmentos no se pudieron transcribir`
        : null,
  });

  console.log(`[worker] ${job.id} terminado (${failedCount} fragmentos fallidos)`);
}
