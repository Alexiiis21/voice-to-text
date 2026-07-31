import { spawn } from 'node:child_process';
import { CHUNKING, NORMALIZE_ARGS } from './config';
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

/** Comprueba que ffmpeg y ffprobe están en el PATH. Usado por /api/health. */
export async function ffmpegAvailable(): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
  const [ffmpeg, ffprobe] = await Promise.all([
    run('ffmpeg', ['-version']).then((r) => r.code === 0).catch(() => false),
    run('ffprobe', ['-version']).then((r) => r.code === 0).catch(() => false),
  ]);
  return { ffmpeg, ffprobe };
}

export interface ProbeResult {
  durationSec: number;
  codec: string;
  sampleRate: number | null;
  channels: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * Valida el archivo con ffprobe. Si no reconoce un stream de audio, lanza:
 * esto es lo que protege de archivos maliciosos disfrazados de audio (§5).
 */
export async function probeAudio(filePath: string): Promise<ProbeResult> {
  const { stdout, stderr, code } = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  if (code !== 0) {
    throw new FfmpegError('ffprobe no pudo leer el archivo', stderr, code);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new FfmpegError('ffprobe devolvió una salida ilegible', stderr, code);
  }

  const audio = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) {
    throw new FfmpegError('El archivo no contiene ningún stream de audio', stderr, code);
  }

  const rawDuration = audio.duration ?? parsed.format?.duration;
  const durationSec = rawDuration === undefined ? Number.NaN : Number.parseFloat(rawDuration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new FfmpegError('No se pudo determinar la duración del audio', stderr, code);
  }

  return {
    durationSec,
    codec: audio.codec_name ?? 'desconocido',
    sampleRate: audio.sample_rate ? Number.parseInt(audio.sample_rate, 10) : null,
    channels: audio.channels ?? null,
  };
}

/**
 * Normaliza a mono 16 kHz mp3 32 kbps. Whisper trabaja internamente a 16 kHz
 * mono, así que no se pierde calidad de reconocimiento y el peso baja ~25×.
 */
export async function normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
  const { stderr, code } = await run('ffmpeg', [
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
  const { stderr, code } = await run('ffmpeg', [
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
  const { stderr, code } = await run('ffmpeg', [
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
