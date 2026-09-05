import { spawn } from 'node:child_process';
import { CHUNKING, NORMALIZE_ARGS } from './config';
import { ffmpegPath } from './ffmpeg-bin';
import { parseProbeOutput, parseProgressDuration } from './probe-parse';
import { parseSilenceLog, type SilenceInterval } from './silence';

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Ejecuta un binario capturando stdout/stderr. No usa shell, así que los
 * argumentos no se interpretan: no hay superficie de inyección aunque un
 * nombre de fichero contenga caracteres raros.
 */
function run(bin: string, args: readonly string[], maxStderrBytes = 4 * 1024 * 1024): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let stderrBytes = 0;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (data: string) => {
      stdout += data;
    });

    child.stderr.on('data', (data: string) => {
      // silencedetect sobre 3 h de audio puede generar mucho stderr; se acota
      // para no hinchar el heap (NODE_OPTIONS=--max-old-space-size=384).
      stderrBytes += Buffer.byteLength(data);
      if (stderrBytes <= maxStderrBytes) stderr += data;
    });

    child.on('error', (error) => {
      reject(new FfmpegError(`No se pudo ejecutar '${bin}': ${error.message}`, '', null));
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

/** Comprueba que el binario de ffmpeg se puede ejecutar. Usado por /api/health. */
export async function ffmpegAvailable(): Promise<{ ffmpeg: boolean; path: string }> {
  const path = ffmpegPath();
  const ffmpeg = await run(path, ['-version'])
    .then((r) => r.code === 0)
    .catch(() => false);
  return { ffmpeg, path };
}

export interface ProbeResult {
  durationSec: number;
  codec: string;
  sampleRate: number | null;
  channels: number | null;
}

/**
 * Valida el archivo y devuelve sus metadatos. Si no hay stream de audio, lanza:
 * esto es lo que protege de archivos maliciosos disfrazados de audio (§5).
 *
 * Antes esto era `ffprobe -print_format json`. Ahora se lee la cabecera que
 * ffmpeg imprime en stderr, porque empaquetar un segundo binario de ~78 MB no
 * cabe en el límite de 250 MB de una función de Vercel (ver ./ffmpeg-bin.ts).
 *
 * `ffmpeg -i fichero` sin fichero de salida termina con código 1 y el mensaje
 * "At least one output file must be specified" **después** de haber volcado la
 * cabecera. Ese código de salida es esperado y se ignora a propósito: lo que
 * decide si el archivo vale es que aparezca un stream de audio, no el código.
 */
export async function probeAudio(filePath: string): Promise<ProbeResult> {
  const { stderr, code } = await run(ffmpegPath(), ['-hide_banner', '-i', filePath]);

  const parsed = parseProbeOutput(stderr);
  if (!parsed) {
    throw new FfmpegError('El archivo no contiene ningún stream de audio', stderr, code);
  }

  let durationSec = parsed.durationSec;

  // Algunos contenedores (notas de voz de WhatsApp truncadas, sobre todo) no
  // traen duración en la cabecera. Sale decodificando entero a /dev/null: es
  // caro, pero sólo ocurre en esos casos y sin duración no se puede trocear.
  if (durationSec === null) {
    const decoded = await run(ffmpegPath(), [
      '-nostdin',
      '-hide_banner',
      '-i',
      filePath,
      '-f',
      'null',
      '-',
    ]);
    durationSec = parseProgressDuration(decoded.stderr);
  }

  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new FfmpegError('No se pudo determinar la duración del audio', stderr, code);
  }

  return {
    durationSec,
    codec: parsed.codec,
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
  };
}

/**
 * Normaliza a mono 16 kHz mp3 32 kbps. Whisper trabaja internamente a 16 kHz
 * mono, así que no se pierde calidad de reconocimiento y el peso baja ~25×.
 */
export async function normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
  const { stderr, code } = await run(ffmpegPath(), [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-map_metadata',
    '-1',
    ...NORMALIZE_ARGS,
    outputPath,
  ]);

  if (code !== 0) {
    throw new FfmpegError('ffmpeg falló al normalizar el audio', stderr, code);
  }
}

/** Primera pasada: detección de silencios sobre el audio ya normalizado. */
export async function detectSilences(filePath: string): Promise<SilenceInterval[]> {
  const filter = `silencedetect=noise=${CHUNKING.silenceNoiseDb}dB:d=${CHUNKING.silenceMinDurSec}`;
  const { stderr, code } = await run(ffmpegPath(), [
    '-nostdin',
    '-hide_banner',
    '-i',
    filePath,
    '-af',
    filter,
    '-f',
    'null',
    '-',
  ]);

  if (code !== 0) {
    // Sin silencios detectados el troceado sigue funcionando: corta en el punto
    // exacto y añade solape. No abortamos el trabajo por esto.
    console.warn('[ffmpeg] silencedetect terminó con error, se continúa sin silencios');
    return [];
  }

  return parseSilenceLog(stderr);
}

/**
 * Extrae un fragmento re-codificando con los mismos parámetros de
 * normalización. `-ss` antes de `-i` hace el seek rápido sobre el mp3.
 */
export async function extractChunk(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  const { stderr, code } = await run(ffmpegPath(), [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    inputPath,
    '-vn',
    '-map_metadata',
    '-1',
    ...NORMALIZE_ARGS,
    outputPath,
  ]);

  if (code !== 0) {
    throw new FfmpegError('ffmpeg falló al extraer el fragmento', stderr, code);
  }
}
