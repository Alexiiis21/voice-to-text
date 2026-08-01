/**
 * Política de reintentos y espera frente a los límites del proveedor STT.
 *
 * Módulo puro: sin red, sin reloj propio salvo el que se le inyecta. Está
 * cubierto por tests (tests/stt-retry.test.ts).
 *
 * El motivo de que esto exista: los límites de Groq en el tier gratuito son
 * **por hora** (7.200 segundos de audio) y **por día** (28.800). Un backoff
 * exponencial de 1 s / 2 s / 4 s no sirve de nada contra una ventana horaria:
 * agota los intentos en segundos y marca el fragmento como fallido. Hay que
 * distinguir "el proveedor está saturado un momento" de "se te acabó la cuota
 * hasta dentro de 40 minutos".
 */

/** Cómo debe reaccionar el worker ante un error del proveedor. */
export type SttFailureKind =
  /** 5xx, red, timeout: reintentar en breve con el mismo proveedor. */
  | 'transient'
  /** 429: cuota o rate limit. Probar otro proveedor o esperar. */
  | 'quota'
  /** 4xx que no se arregla reintentando (401, 400, archivo inválido). */
  | 'fatal';

/**
 * Interpreta la cabecera `Retry-After`. Acepta las dos formas del RFC 9110:
 * delta en segundos (`"120"`) o fecha HTTP (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 *
 * Devuelve null si falta o es ilegible, para que el llamante aplique su
 * propio valor por defecto.
 */
export function parseRetryAfterSeconds(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;

  const trimmed = header.trim();
  if (trimmed === '') return null;

  // Forma 1: delta en segundos.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
  }

  // Forma 2: fecha HTTP.
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.ceil((asDate - nowMs) / 1000));
  }

  return null;
}

/**
 * Groq devuelve el tiempo restante en formatos como `7.66s`, `2m59.56s` o
 * `1h13m24s` dentro del cuerpo del error, no siempre en `Retry-After`.
 */
export function parseHumanDuration(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?/.exec(text);
  if (!match) return null;

  const hours = match[1] === undefined ? 0 : Number.parseFloat(match[1]);
  const minutes = match[2] === undefined ? 0 : Number.parseFloat(match[2]);
  const seconds = match[3] === undefined ? 0 : Number.parseFloat(match[3]);

  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? Math.ceil(total) : null;
}

/** Backoff exponencial con tope, para errores transitorios. */
export function backoffDelayMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  if (attempt < 0) return baseMs;
  return Math.min(capMs, baseMs * 2 ** attempt);
}

export interface DeferDecision {
  /** true si el worker debe soltar el trabajo y reanudarlo más tarde. */
  defer: boolean;
  /** Segundos a esperar antes de volver a intentarlo. */
  waitSec: number;
}

/**
 * Decide qué hacer cuando **todos** los proveedores de la cadena están sin
 * cuota.
 *
 * Esperas cortas se absorben en el propio worker (dormir y seguir). Esperas
 * largas —el caso de la cuota horaria de Groq— no: bloquear el worker media
 * hora dejaría parada la cola entera. En ese caso el trabajo vuelve a `queued`
 * con una marca `resume_after` y el worker sigue con otros trabajos. Los
 * fragmentos ya transcritos están guardados, así que al reanudarse continúa
 * donde lo dejó.
 */
export function decideDeferral(
  retryAfterSec: number | null,
  thresholdSec: number,
  defaultWaitSec: number,
  maxWaitSec: number,
): DeferDecision {
  const wait = Math.min(
    maxWaitSec,
    retryAfterSec === null || retryAfterSec <= 0 ? defaultWaitSec : retryAfterSec,
  );
  return { defer: wait > thresholdSec, waitSec: wait };
}
