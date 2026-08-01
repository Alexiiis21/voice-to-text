/** Constantes de negocio. Cambiarlas aquí, no esparcidas por el código. */

/** Extensiones permitidas en la subida (§5). */
export const ALLOWED_EXTENSIONS = [
  '.ogg',
  '.opus',
  '.mp3',
  '.m4a',
  '.wav',
  '.webm',
  '.aac',
  '.flac',
] as const;

/**
 * MIME types aceptados. Los navegadores son inconsistentes con audio/ogg vs
 * application/ogg y con los contenedores de WhatsApp/Telegram, así que la
 * allowlist es generosa aquí y estricta en la extensión + ffprobe.
 */
export const ALLOWED_MIME_TYPES = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/vorbis',
  'application/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/aacp',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/webm',
  'video/webm',
  'audio/flac',
  'audio/x-flac',
  'application/octet-stream',
]);

/**
 * Rate limit por IP y ventana de 1 hora.
 *
 * §5 pedía 6 horas de audio por hora. Se ha bajado a 2 h porque el tier
 * gratuito de Groq admite **7.200 segundos de audio por hora** en total (y
 * 28.800 al día): aceptar 6 h/hora por IP significaba admitir trabajo que el
 * proveedor no puede completar dentro de la ventana. Con desbordamiento a
 * OpenAI configurado se puede volver a subir; ver README §11.
 */
export const RATE_LIMIT = {
  windowMs: 60 * 60 * 1000,
  maxTranscriptions: 10,
  maxAudioSeconds: 2 * 60 * 60,
} as const;

/**
 * Comportamiento frente a las cuotas del proveedor STT.
 *
 * Un 429 por cuota horaria no es un fallo: es una espera. Si la espera es
 * corta, el worker duerme y sigue. Si es larga, devuelve el trabajo a la cola
 * con una marca `resume_after` y atiende otros mientras tanto; los fragmentos
 * ya transcritos quedan guardados, así que al reanudarse continúa donde lo
 * dejó y un audio de tres horas se completa a través de varias ventanas.
 */
export const QUOTA = {
  /** Por encima de esta espera, el trabajo se aparca en vez de bloquear. */
  deferThresholdSec: 90,
  /** Espera asumida cuando el proveedor no dice cuánto falta. */
  defaultWaitSec: 15 * 60,
  /** Tope de espera: nunca aparcamos un trabajo más de esto. */
  maxWaitSec: 60 * 60,
  /** Tope del backoff exponencial para errores transitorios. */
  transientBackoffCapMs: 30_000,
} as const;

/** Troceado (§2). */
export const CHUNKING = {
  /** Ventana de búsqueda de silencio alrededor del objetivo. */
  searchWindowSec: 30,
  /** Solape añadido cuando no hay silencio en la ventana. */
  overlapSec: 1.5,
  /** Umbral de silencio para `silencedetect`. */
  silenceNoiseDb: -30,
  /** Duración mínima de silencio para `silencedetect`. */
  silenceMinDurSec: 0.4,
  /** Si un fragmento supera esto tras normalizar, se parte por la mitad. */
  maxChunkBytes: 20 * 1024 * 1024,
  /** Profundidad máxima de partición recursiva por tamaño. */
  maxSplitDepth: 4,
  /** Reintentos por fragmento. */
  maxAttempts: 3,
  /** Palabras comparadas para eliminar la duplicación del solape. */
  overlapWords: 10,
} as const;

/** Normalización de audio: mono 16 kHz mp3 32 kbps (§2). */
export const NORMALIZE_ARGS = [
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'libmp3lame',
  '-b:a',
  '32k',
] as const;

/** Bucle del worker (§9, presupuesto). */
export const WORKER = {
  /** Sondeo de la cola cuando está vacía. */
  idlePollMs: 5000,
  /** Concurrencia de la edición con Haiku por fragmento. */
  cleanupConcurrency: 3,
  /** Retención de transcripciones. */
  retentionDays: 30,
  /** Periodicidad del barrido de retención. */
  retentionIntervalMs: 24 * 60 * 60 * 1000,
} as const;

/** Umbral de map-reduce para el resumen (§4). */
export const SUMMARY_MAP_REDUCE_WORDS = 40_000;

/** Tarifas estimadas para la columna `cost_usd` (USD). */
export const PRICING = {
  stt: {
    /** Groq whisper-large-v3-turbo: por hora de audio. */
    groqPerAudioHour: 0.04,
    /** OpenAI whisper-1: $0.006/min = $0.36/h. */
    openaiPerAudioHour: 0.36,
  },
  llm: {
    /** claude-haiku-4-5: $1 / $5 por millón de tokens. */
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
    /** claude-sonnet-5: $3 / $15 por millón de tokens. */
    'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  } as Record<string, { inputPerMTok: number; outputPerMTok: number }>,
  /** Fallback si se configura un modelo desconocido. */
  llmFallback: { inputPerMTok: 3, outputPerMTok: 15 },
} as const;

/** Intervalo de sondeo del SSE contra la base de datos. */
export const SSE_POLL_MS = 1000;

/** Historial devuelto por `GET /api/transcriptions`. */
export const HISTORY_LIMIT = 20;

/** Nombre y vida de la cookie anónima de sesión (§6). */
export const SESSION_COOKIE = 'session_id';
export const SESSION_COOKIE_MAX_AGE = 90 * 24 * 60 * 60;
