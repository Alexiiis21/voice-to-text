import { CHUNKING, QUOTA, WORKER } from '@/lib/config';
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
import {
  backoffDelayMs,
  decideDeferral,
  resolveSttChain,
  SttError,
  SttQuotaExhausted,
  type SttAdapter,
} from '@/lib/stt';
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

/**
 * El trabajo no puede continuar ahora porque no queda cuota en ningún
 * proveedor, pero **no ha fallado**: se aparca y se reanuda solo.
 */
export class JobDeferred extends Error {
  constructor(
    readonly resumeAfter: Date,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'JobDeferred';
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
  adapter: SttAdapter,
  transcriptionId: string,
  idx: number,
  sourcePath: string,
  startSec: number,
  endSec: number,
  depth: number,
  partLabel: string,
): Promise<{ text: string; audioSeconds: number }> {
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
      adapter,
      transcriptionId,
      idx,
      sourcePath,
      startSec,
      middle,
      depth + 1,
      `${partLabel}a`,
    );
    const second = await transcribeRange(
      adapter,
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

interface ChunkOutcome {
  text: string;
  audioSeconds: number;
  adapter: SttAdapter;
}

/**
 * Transcribe un fragmento recorriendo la cadena de proveedores.
 *
 * Por cada proveedor: hasta `maxAttempts` intentos con backoff exponencial
 * para errores transitorios. Un 429 de cuota **no consume intentos**: se salta
 * de inmediato al siguiente proveedor de la cadena (desbordamiento). Si todos
 * se quedan sin cuota, se lanza `SttQuotaExhausted` con la espera más corta de
 * todas, y el llamante decide si dormir o aparcar el trabajo.
 */
async function transcribeChunkWithChain(
  chain: readonly SttAdapter[],
  transcriptionId: string,
  chunk: Chunk,
  sourcePath: string,
): Promise<ChunkOutcome> {
  const start = Number.parseFloat(chunk.startSec);
  const end = Number.parseFloat(chunk.endSec);

  let lastError: unknown = null;
  let quotaWaits: number[] = [];
  let exhaustedByQuota = 0;

  for (const adapter of chain) {
    let attempt = 0;

    while (attempt < CHUNKING.maxAttempts) {
      await repo.updateChunk(chunk.id, { attempts: chunk.attempts + attempt + 1 });

      try {
        const result = await transcribeRange(
          adapter,
          transcriptionId,
          chunk.idx,
          sourcePath,
          start,
          end,
          0,
          '',
        );
        return { ...result, adapter };
      } catch (error: unknown) {
        lastError = error;

        if (error instanceof SttError && error.kind === 'quota') {
          // Sin cuota aquí: no gastamos más intentos con este proveedor,
          // probamos el siguiente de la cadena inmediatamente.
          exhaustedByQuota += 1;
          if (error.retryAfterSec !== null) quotaWaits.push(error.retryAfterSec);
          console.warn(
            `[worker] ${adapter.name} sin cuota en el fragmento ${chunk.idx + 1}` +
              (error.retryAfterSec !== null ? ` (reintentar en ${error.retryAfterSec} s)` : ''),
          );
          break;
        }

        const retryable = !(error instanceof SttError) || error.retryable;
        console.warn(
          `[worker] Fragmento ${chunk.idx + 1} con ${adapter.name} falló ` +
            `(intento ${attempt + 1}/${CHUNKING.maxAttempts}): ${errorMessage(error)}`,
        );

        attempt += 1;
        if (!retryable || attempt >= CHUNKING.maxAttempts) break;
        await sleep(backoffDelayMs(attempt - 1, 1000, QUOTA.transientBackoffCapMs));
      }
    }
  }

  // Todos los proveedores agotados por cuota: es una espera, no un fallo.
  if (exhaustedByQuota === chain.length) {
    quotaWaits = quotaWaits.filter((value) => value > 0);
    const shortest = quotaWaits.length > 0 ? Math.min(...quotaWaits) : null;
    throw new SttQuotaExhausted(
      `Sin cuota en ${chain.map((a) => a.name).join(' ni ')}`,
      shortest,
    );
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
  // Cadena de proveedores: el que pidió el usuario primero, el resto como
  // desbordamiento cuando el anterior se queda sin cuota.
  const chain = resolveSttChain(job.sttProvider);
  console.log(`[worker] ${job.id}: cadena STT = ${chain.map((a) => a.name).join(' → ')}`);

  for (const chunk of allChunks) {
    if (chunk.status === 'done') continue;
    if (chunk.status === 'failed' && chunk.attempts >= CHUNKING.maxAttempts) continue;

    if (stop.stopped()) throw new JobInterrupted();

    try {
      const outcome = await transcribeChunkWithChain(chain, job.id, chunk, normPath);
      await repo.updateChunk(chunk.id, {
        status: 'done',
        rawText: outcome.text,
        sttProvider: outcome.adapter.name,
        error: null,
      });
      await repo.addCost(
        job.id,
        sttCostUsd(outcome.audioSeconds, outcome.adapter.pricePerAudioHourUsd),
      );
    } catch (error: unknown) {
      if (error instanceof SttQuotaExhausted) {
        // No es un fallo del fragmento: es que no hay cuota en ninguna parte.
        // Se aparca el trabajo con una marca de reanudación; el worker sigue
        // con otros y lo retoma solo cuando la ventana se abra. El fragmento
        // en curso queda `pending`, así que se reintenta desde donde estaba.
        const { defer, waitSec } = decideDeferral(
          error.retryAfterSec,
          QUOTA.deferThresholdSec,
          QUOTA.defaultWaitSec,
          QUOTA.maxWaitSec,
        );

        const resumeAt = new Date(Date.now() + waitSec * 1000);
        const doneCount = allChunks.filter((item) => item.status === 'done').length;

        const reason = defer
          ? `Cuota de transcripción agotada (${error.message}). Se reanudará solo ` +
            `sobre las ${resumeAt.toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
            })}. ${doneCount} de ${allChunks.length} fragmentos ya transcritos se conservan.`
          : `Proveedor saturado; reintentando en ${waitSec} s. ` +
            `${doneCount} de ${allChunks.length} fragmentos ya transcritos.`;

        console.log(`[worker] ${job.id} aparcado hasta ${resumeAt.toISOString()}: ${reason}`);
        throw new JobDeferred(resumeAt, reason);
      }

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
