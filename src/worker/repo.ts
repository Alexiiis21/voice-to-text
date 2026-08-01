import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { db, sql } from '@/db';
import { chunks, transcriptions, workerState, type Chunk, type Transcription } from '@/db/schema';
import { toCostString } from '@/lib/cost';

/**
 * Reclama el siguiente trabajo encolado.
 *
 * `FOR UPDATE SKIP LOCKED` sobre el subselect: dos workers (hoy sólo hay uno,
 * pero la vía de escalado del README lo contempla) nunca cogen el mismo
 * trabajo, y ninguno se queda esperando al otro.
 */
export async function claimNextJob(): Promise<Transcription | null> {
  const rows = await sql<Transcription[]>`
    UPDATE transcriptions
    SET status = 'processing',
        started_at = COALESCE(started_at, now()),
        resume_after = NULL,
        error = NULL
    WHERE id = (
      SELECT id FROM transcriptions
      WHERE status = 'queued'
        AND (resume_after IS NULL OR resume_after <= now())
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;

  const row = rows[0];
  if (!row) return null;

  // postgres.js devuelve snake_case; normalizamos al tipo de Drizzle.
  return normalizeTranscription(row as unknown as Record<string, unknown>);
}

function normalizeTranscription(row: Record<string, unknown>): Transcription {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    filename: row.filename as string,
    sourceExt: row.source_ext as string,
    sizeBytes: Number(row.size_bytes),
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    status: row.status as Transcription['status'],
    sttProvider: row.stt_provider as string,
    chunkCount: Number(row.chunk_count),
    rawText: (row.raw_text as string | null) ?? null,
    cleanText: (row.clean_text as string | null) ?? null,
    summaryText: (row.summary_text as string | null) ?? null,
    wordCount: row.word_count === null ? null : Number(row.word_count),
    costUsd: String(row.cost_usd),
    error: (row.error as string | null) ?? null,
    resumeAfter: (row.resume_after as Date | null) ?? null,
    createdAt: row.created_at as Date,
    startedAt: (row.started_at as Date | null) ?? null,
    completedAt: (row.completed_at as Date | null) ?? null,
  };
}

/**
 * Barrido de arranque: devuelve a `queued` cualquier trabajo que quedara en
 * vuelo tras un redespliegue.
 *
 * §9 pide requeue de los trabajos con más de 30 minutos en `processing`. Aquí
 * se requeuean todos: en este despliegue hay exactamente un worker por
 * contenedor, así que en el momento del arranque no puede haber ningún trabajo
 * legítimamente en curso, y esperar 30 minutos sólo retrasaría la recuperación
 * de un audio largo. Documentado en el README.
 */
export async function requeueOrphanedJobs(): Promise<number> {
  const result = await db
    .update(transcriptions)
    .set({ status: 'queued', startedAt: null })
    .where(inArray(transcriptions.status, ['processing', 'editing']))
    .returning({ id: transcriptions.id });
  return result.length;
}

export async function markFailed(id: string, message: string): Promise<void> {
  await db
    .update(transcriptions)
    .set({ status: 'failed', error: message.slice(0, 4000), completedAt: new Date() })
    .where(eq(transcriptions.id, id));
}

export async function requeue(id: string): Promise<void> {
  await db
    .update(transcriptions)
    .set({ status: 'queued', startedAt: null })
    .where(eq(transcriptions.id, id));
}

/**
 * Aparca un trabajo hasta `resumeAfter` porque no hay cuota en ningún
 * proveedor. Vuelve a `queued` conservando `started_at` y los fragmentos ya
 * transcritos: al reanudarse continúa donde lo dejó.
 */
export async function deferJob(id: string, resumeAfter: Date, reason: string): Promise<void> {
  await db
    .update(transcriptions)
    .set({ status: 'queued', resumeAfter, error: reason.slice(0, 4000) })
    .where(eq(transcriptions.id, id));
}

export async function setStatus(
  id: string,
  status: Transcription['status'],
  extra: Partial<Pick<Transcription, 'error' | 'completedAt'>> = {},
): Promise<void> {
  await db.update(transcriptions).set({ status, ...extra }).where(eq(transcriptions.id, id));
}

export async function setDuration(id: string, durationSec: number): Promise<void> {
  await db
    .update(transcriptions)
    .set({ durationSec: Math.round(durationSec) })
    .where(eq(transcriptions.id, id));
}

export async function setChunkCount(id: string, count: number): Promise<void> {
  await db.update(transcriptions).set({ chunkCount: count }).where(eq(transcriptions.id, id));
}

/** Suma atómica al coste acumulado (§9). */
export async function addCost(id: string, amountUsd: number): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  await sql`
    UPDATE transcriptions
    SET cost_usd = LEAST(cost_usd + ${toCostString(amountUsd)}::numeric, 99999.99999)
    WHERE id = ${id}
  `;
}

export async function listChunks(transcriptionId: string): Promise<Chunk[]> {
  return db
    .select()
    .from(chunks)
    .where(eq(chunks.transcriptionId, transcriptionId))
    .orderBy(asc(chunks.idx));
}

export async function insertChunks(
  transcriptionId: string,
  segments: readonly { idx: number; start: number; end: number; hasOverlap: boolean }[],
): Promise<void> {
  if (segments.length === 0) return;
  await db.insert(chunks).values(
    segments.map((segment) => ({
      transcriptionId,
      idx: segment.idx,
      startSec: segment.start.toFixed(3),
      endSec: segment.end.toFixed(3),
      hasOverlap: segment.hasOverlap,
      status: 'pending' as const,
    })),
  );
}

export async function updateChunk(
  id: string,
  values: Partial<
    Pick<Chunk, 'status' | 'rawText' | 'cleanText' | 'attempts' | 'error' | 'sttProvider'>
  >,
): Promise<void> {
  await db.update(chunks).set(values).where(eq(chunks.id, id));
}

export async function setTexts(
  id: string,
  values: Partial<Pick<Transcription, 'rawText' | 'cleanText' | 'wordCount'>>,
): Promise<void> {
  await db.update(transcriptions).set(values).where(eq(transcriptions.id, id));
}

/** Transcripciones más antiguas que `cutoff`, para el barrido de retención. */
export async function findExpired(
  cutoff: Date,
): Promise<{ id: string; sourceExt: string }[]> {
  return db
    .select({ id: transcriptions.id, sourceExt: transcriptions.sourceExt })
    .from(transcriptions)
    .where(lt(transcriptions.createdAt, cutoff));
}

export async function deleteTranscriptionRow(id: string): Promise<void> {
  await db.delete(transcriptions).where(eq(transcriptions.id, id));
}

/** Lee un valor del estado persistido del worker. */
export async function readState(key: string): Promise<string | null> {
  const rows = await db.select().from(workerState).where(eq(workerState.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function writeState(key: string, value: string): Promise<void> {
  await db
    .insert(workerState)
    .values({ key, value })
    .onConflictDoUpdate({ target: workerState.key, set: { value, updatedAt: new Date() } });
}

/** Fragmentos que aún deben procesarse (pendientes o fallidos con reintentos). */
export async function pendingChunks(
  transcriptionId: string,
  maxAttempts: number,
): Promise<Chunk[]> {
  const all = await listChunks(transcriptionId);
  return all.filter((chunk) => chunk.status === 'pending' && chunk.attempts < maxAttempts);
}

export { and, eq };
