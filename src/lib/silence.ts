/**
 * Cálculo de puntos de corte a partir de la salida de `ffmpeg -af silencedetect`.
 *
 * Módulo puro: sin fs, sin red, sin ffmpeg. Es una de las dos piezas con
 * lógica no trivial y está cubierta por tests (tests/silence.test.ts).
 */

export interface SilenceInterval {
  /** Inicio del silencio, en segundos desde el comienzo del audio. */
  start: number;
  /** Fin del silencio, en segundos. */
  end: number;
}

export interface Segment {
  /** Índice 0-based del fragmento. */
  idx: number;
  /** Inicio en segundos (ya incluye el solape si lo hay). */
  start: number;
  /** Fin en segundos. */
  end: number;
  /** true si `start` retrocedió para solapar con el fragmento anterior. */
  hasOverlap: boolean;
}

export interface CutPointOptions {
  durationSec: number;
  silences: readonly SilenceInterval[];
  /** Duración objetivo por fragmento (CHUNK_SECONDS). */
  targetSec: number;
  /** Ventana de búsqueda de silencio alrededor del objetivo (±). */
  windowSec: number;
  /** Solape a añadir cuando no hay silencio en la ventana. */
  overlapSec: number;
}

/**
 * Parsea la salida de `silencedetect` en stderr de ffmpeg.
 *
 * Formato emitido por ffmpeg:
 *   [silencedetect @ 0x...] silence_start: 123.456
 *   [silencedetect @ 0x...] silence_end: 125.001 | silence_duration: 1.545
 *
 * Los intervalos sin `silence_end` (silencio que llega hasta el final del
 * fichero) se descartan: no sirven como punto de corte intermedio.
 */
export function parseSilenceLog(stderr: string): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let pendingStart: number | null = null;

  const startRe = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
  const endRe = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = startRe.exec(line);
    if (startMatch?.[1] !== undefined) {
      const value = Number.parseFloat(startMatch[1]);
      if (Number.isFinite(value)) pendingStart = Math.max(0, value);
      // ffmpeg nunca emite start y end en la misma línea, así que seguimos.
      continue;
    }

    const endMatch = endRe.exec(line);
    if (endMatch?.[1] !== undefined && pendingStart !== null) {
      const end = Number.parseFloat(endMatch[1]);
      if (Number.isFinite(end) && end > pendingStart) {
        intervals.push({ start: pendingStart, end });
      }
      pendingStart = null;
    }
  }

  return intervals;
}

/** Punto medio de un silencio: el mejor sitio para cortar dentro de él. */
function midpoint(interval: SilenceInterval): number {
  return (interval.start + interval.end) / 2;
}

/**
 * Divide el audio en segmentos de ~`targetSec`, cortando en silencios cuando
 * hay alguno dentro de ±`windowSec` del objetivo. Si no lo hay, corta en el
 * punto exacto y el siguiente fragmento arranca `overlapSec` antes.
 *
 * El último segmento absorbe el resto si lo que queda no llega a un cuarto del
 * objetivo, para no generar un fragmento residual de dos segundos.
 */
export function computeCutPoints(options: CutPointOptions): Segment[] {
  const { durationSec, silences, targetSec, windowSec, overlapSec } = options;

  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (targetSec <= 0) {
    throw new Error('targetSec debe ser mayor que cero');
  }

  // Un solo fragmento: el audio no llega al objetivo.
  if (durationSec <= targetSec) {
    return [{ idx: 0, start: 0, end: durationSec, hasOverlap: false }];
  }

  const sorted = [...silences]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  const minTail = targetSec / 4;

  let cursor = 0;
  let overlapFromPrevious = false;
  let idx = 0;

  // Cota de seguridad: cada iteración avanza al menos (targetSec - windowSec -
  // overlapSec) segundos, pero un guard explícito evita cualquier bucle infinito
  // ante datos degenerados.
  const maxIterations = Math.ceil(durationSec / Math.max(1, targetSec - windowSec)) + 8;

  while (cursor < durationSec - 1e-6 && idx < maxIterations) {
    const remaining = durationSec - cursor;

    // Lo que queda cabe en un fragmento (o el resto sería demasiado corto).
    if (remaining <= targetSec + minTail) {
      segments.push({ idx, start: cursor, end: durationSec, hasOverlap: overlapFromPrevious });
      break;
    }

    const ideal = cursor + targetSec;
    const lower = ideal - windowSec;
    const upper = ideal + windowSec;

    let bestCut: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const silence of sorted) {
      const candidate = midpoint(silence);
      if (candidate <= cursor) continue;
      if (candidate >= durationSec) break;
      if (candidate < lower) continue;
      if (candidate > upper) break;

      const distance = Math.abs(candidate - ideal);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCut = candidate;
      }
    }

    if (bestCut !== null) {
      segments.push({ idx, start: cursor, end: bestCut, hasOverlap: overlapFromPrevious });
      cursor = bestCut;
      overlapFromPrevious = false;
    } else {
      segments.push({ idx, start: cursor, end: ideal, hasOverlap: overlapFromPrevious });
      cursor = Math.max(0, ideal - overlapSec);
      overlapFromPrevious = true;
    }

    idx += 1;
  }

  return segments.map((segment, index) => ({ ...segment, idx: index }));
}
