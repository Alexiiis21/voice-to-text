/**
 * Lectura de los metadatos que ffmpeg escribe en stderr.
 *
 * Módulo puro: sin fs, sin red, sin procesos. Es la pieza que sustituye a
 * `ffprobe -print_format json`, que daba la misma información ya estructurada
 * pero obligaba a empaquetar un segundo binario de ~78 MB en la función (ver
 * ./ffmpeg-bin.ts).
 *
 * El formato que se parsea es la cabecera que ffmpeg imprime siempre al abrir
 * un fichero, antes de hacer nada con él:
 *
 * ```
 * Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/a.m4a':
 *   Duration: 00:03:21.55, start: 0.000000, bitrate: 128 kb/s
 *     Stream #0:0(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s
 * ```
 */

export interface ParsedProbe {
  /** Segundos. `null` si ffmpeg imprimió `Duration: N/A`. */
  durationSec: number | null;
  codec: string;
  sampleRate: number | null;
  channels: number | null;
}

const DURATION_RE = /^\s*Duration:\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/m;

/**
 * `Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, …`
 *
 * El índice, la etiqueta de idioma entre paréntesis y los adornos del códec son
 * todos opcionales según el contenedor, de ahí los grupos no capturantes.
 */
const AUDIO_STREAM_RE =
  /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:\s*([A-Za-z0-9_.\-]+)(.*)$/m;

const SAMPLE_RATE_RE = /(\d+)\s*Hz/;
const CHANNELS_RE = /(\d+)(?:\.\d+)?\s*channels/;

/**
 * Última marca de progreso de un `-f null -`, para los contenedores en los que
 * la cabecera no trae duración (streams de WhatsApp cortados, sobre todo).
 * ffmpeg reescribe la línea con `\r`, así que se busca la última ocurrencia.
 */
const PROGRESS_TIME_RE = /time=\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/g;

function toSeconds(hours: string, minutes: string, seconds: string): number {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number.parseFloat(seconds);
}

/**
 * Extrae los metadatos del audio. Devuelve `null` si no hay ningún stream de
 * audio: eso es lo que protege de un fichero con extensión de audio que en
 * realidad es otra cosa (§5).
 */
export function parseProbeOutput(stderr: string): ParsedProbe | null {
  const stream = AUDIO_STREAM_RE.exec(stderr);
  if (!stream) return null;

  const codec = stream[1] ?? 'desconocido';
  const rest = stream[2] ?? '';

  const durationMatch = DURATION_RE.exec(stderr);
  const durationSec =
    durationMatch &&
    durationMatch[1] !== undefined &&
    durationMatch[2] !== undefined &&
    durationMatch[3] !== undefined
      ? toSeconds(durationMatch[1], durationMatch[2], durationMatch[3])
      : null;

  const rateMatch = SAMPLE_RATE_RE.exec(rest);
  const sampleRate = rateMatch?.[1] !== undefined ? Number.parseInt(rateMatch[1], 10) : null;

  let channels: number | null = null;
  if (/\bmono\b/.test(rest)) channels = 1;
  else if (/\bstereo\b/.test(rest)) channels = 2;
  else {
    const channelsMatch = CHANNELS_RE.exec(rest);
    if (channelsMatch?.[1] !== undefined) channels = Number.parseInt(channelsMatch[1], 10);
  }

  return { durationSec, codec, sampleRate, channels };
}

/**
 * Duración real a partir de la salida de progreso de un decodificado completo.
 * Sólo se usa cuando la cabecera no la traía.
 */
export function parseProgressDuration(stderr: string): number | null {
  let last: number | null = null;
  // `exec` en bucle con la bandera /g: nos quedamos con la última marca, que es
  // la que corresponde al final del fichero.
  for (const match of stderr.matchAll(PROGRESS_TIME_RE)) {
    if (match[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      last = toSeconds(match[1], match[2], match[3]);
    }
  }
  return last !== null && Number.isFinite(last) && last > 0 ? last : null;
}
