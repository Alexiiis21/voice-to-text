import { sql } from '@/db';
import { RATE_LIMIT } from './config';

export interface QuotaSnapshot {
  transcriptionsUsed: number;
  transcriptionsRemaining: number;
  audioSecondsUsed: number;
  audioSecondsRemaining: number;
  /** Segundos hasta que se abre la siguiente ventana. */
  resetInSec: number;
}

/**
 * Inicio de la ventana horaria actual, como ISO 8601.
 *
 * Se pasa como texto y no como `Date` a propósito: el cliente está configurado
 * con `prepare: false` (compatibilidad con poolers en modo transaction), y en
 * ese modo postgres.js delega la inferencia de tipos al servidor y no sabe
 * serializar un `Date` en las consultas crudas. Postgres infiere `timestamptz`
 * por el contexto de la comparación y parsea el literal sin problema.
 */
function currentWindowStart(now = new Date()): string {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return start.toISOString();
}

function resetInSec(now = new Date()): number {
  const start = new Date(currentWindowStart(now)).getTime();
  const end = start + RATE_LIMIT.windowMs;
  return Math.max(0, Math.ceil((end - now.getTime()) / 1000));
}

/**
 * Extrae la IP del cliente. Railway pone la IP real en `x-forwarded-for`.
 * Se toma la primera entrada, que es la del cliente original.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 100);
  }
  return headers.get('x-real-ip')?.slice(0, 100) ?? 'unknown';
}

interface RateLimitRow {
  count: number;
  audio_seconds: number;
}

/** Lee el consumo de la ventana actual sin modificar nada. */
export async function readQuota(ip: string): Promise<QuotaSnapshot> {
  const windowStart = currentWindowStart();
  const rows = await sql<RateLimitRow[]>`
    SELECT count, audio_seconds
    FROM rate_limits
    WHERE ip = ${ip} AND window_start = ${windowStart}
  `;

  const row = rows[0];
  const used = row?.count ?? 0;
  const seconds = row?.audio_seconds ?? 0;

  return {
    transcriptionsUsed: used,
    transcriptionsRemaining: Math.max(0, RATE_LIMIT.maxTranscriptions - used),
    audioSecondsUsed: seconds,
    audioSecondsRemaining: Math.max(0, RATE_LIMIT.maxAudioSeconds - seconds),
    resetInSec: resetInSec(),
  };
}

export interface RateLimitDecision {
  allowed: boolean;
  reason: string | null;
  retryAfterSec: number;
  quota: QuotaSnapshot;
}

/**
 * Reserva una transcripción en la ventana actual: 10 transcripciones y 6 horas
 * de audio por hora e IP.
 *
 * La reserva del contador se hace antes de conocer la duración (aún no hemos
 * ejecutado ffprobe); `commitAudioSeconds` la completa después. Es un UPSERT
 * atómico: dos peticiones simultáneas de la misma IP no pueden colarse.
 */
export async function reserveTranscription(ip: string): Promise<RateLimitDecision> {
  const windowStart = currentWindowStart();

  const rows = await sql<RateLimitRow[]>`
    INSERT INTO rate_limits (ip, window_start, count, audio_seconds)
    VALUES (${ip}, ${windowStart}, 1, 0)
    ON CONFLICT (ip, window_start) DO UPDATE
      SET count = rate_limits.count + 1
      WHERE rate_limits.count < ${RATE_LIMIT.maxTranscriptions}
        AND rate_limits.audio_seconds < ${RATE_LIMIT.maxAudioSeconds}
    RETURNING count, audio_seconds
  `;

  const retryAfter = resetInSec();
  const row = rows[0];

  if (!row) {
    const quota = await readQuota(ip);
    const reason =
      quota.audioSecondsRemaining <= 0
        ? `Se han superado las ${RATE_LIMIT.maxAudioSeconds / 3600} horas de audio por hora`
        : `Se han superado las ${RATE_LIMIT.maxTranscriptions} transcripciones por hora`;
    return { allowed: false, reason, retryAfterSec: retryAfter, quota };
  }

  return {
    allowed: true,
    reason: null,
    retryAfterSec: retryAfter,
    quota: {
      transcriptionsUsed: row.count,
      transcriptionsRemaining: Math.max(0, RATE_LIMIT.maxTranscriptions - row.count),
      audioSecondsUsed: row.audio_seconds,
      audioSecondsRemaining: Math.max(0, RATE_LIMIT.maxAudioSeconds - row.audio_seconds),
      resetInSec: retryAfter,
    },
  };
}

/** Suma los segundos de audio una vez ffprobe ha dado la duración real. */
export async function commitAudioSeconds(ip: string, seconds: number): Promise<void> {
  const windowStart = currentWindowStart();
  const rounded = Math.max(0, Math.round(seconds));
  await sql`
    UPDATE rate_limits
    SET audio_seconds = audio_seconds + ${rounded}
    WHERE ip = ${ip} AND window_start = ${windowStart}
  `;
}

/** Devuelve la reserva si la petición acaba rechazada después de reservarla. */
export async function releaseTranscription(ip: string): Promise<void> {
  const windowStart = currentWindowStart();
  await sql`
    UPDATE rate_limits
    SET count = GREATEST(0, count - 1)
    WHERE ip = ${ip} AND window_start = ${windowStart}
  `;
}

/** Limpia ventanas antiguas. Lo llama el barrido diario del worker. */
export async function purgeOldWindows(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await sql`DELETE FROM rate_limits WHERE window_start < ${cutoff}`;
  return result.count;
}
