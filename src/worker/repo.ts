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
    sourceUrl: (row.source_url as string | null) ?? null,
    normalizedUrl: (row.normalized_url as string | null) ?? null,
    clientIp: (row.client_ip as string | null) ?? null,
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

/**
 * Devuelve a la cola los trabajos atascados en vuelo más de `olderThanMs`.
 *
 * Es el equivalente serverless de `requeueOrphanedJobs`, y **no puede ser tan
 * agresivo**: en Railway el arranque del contenedor garantizaba que no había
 * ningún worker vivo, así que se podían requeuear todos. Aquí puede haber una
 * invocación de `/api/process` trabajando legítimamente sobre un trabajo en
 * `processing`, así que sólo se rescata lo que lleva parado más que el
 * `maxDuration` de la función: si sigue ahí después de eso, la invocación murió
 * (timeout duro, OOM) sin poder devolverlo a la cola.
 */
export async function requeueStaleJobs(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await sql<{ id: string }[]>`
    UPDATE transcriptions
    SET status = 'queued', started_at = NULL
    WHERE status IN ('processing', 'editing')
      AND COALESCE(started_at, created_at) < ${cutoff}
    RETURNING id
  `;
  return rows.length;
}

/** ¿Queda algo reclamable ahora mismo? Decide si encadenar otra invocación. */
export async function hasClaimableWork(): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM transcriptions
      WHERE status = 'queued'
        AND (resume_after IS NULL OR resume_after <= now())
    ) AS exists
  `;
  return rows[0]?.exists === true;
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

/**
 * Guarda (o borra) las URLs de Blob. Se pasan sólo las que cambian: escribir
 * `normalizedUrl` no debe pisar `sourceUrl` puesto por otra invocación.
 */
export async function setBlobUrls(
  id: string,
  values: Partial<Pick<Transcription, 'sourceUrl' | 'normalizedUrl'>>,
): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await db.update(transcriptions).set(values).where(eq(transcriptions.id, id));
}

/**
 * Olvida la IP en cuanto se han contabilizado los segundos de audio. La columna
 * existe sólo para cerrar ese cálculo, no como registro (ver el esquema).
 */
export async function clearClientIp(id: string): Promise<void> {
  await db.update(transcriptions).set({ clientIp: null }).where(eq(transcriptions.id, id));
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
): Promise<
  { id: string; sourceExt: string; sourceUrl: string | null; normalizedUrl: string | null }[]
> {
  return db
    .select({
      id: transcriptions.id,
      sourceExt: transcriptions.sourceExt,
      // Normalmente ya están a NULL (el audio se borra al terminar), pero un
      // trabajo que falló de forma rara puede dejar el blob vivo. El barrido es
      // la última red: sin esto el almacenamiento crecería para siempre.
      sourceUrl: transcriptions.sourceUrl,
      normalizedUrl: transcriptions.normalizedUrl,
    })
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
