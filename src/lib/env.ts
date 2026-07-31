/**
 * Lectura y validación de variables de entorno.
 *
 * Regla dura: ninguna clave secreta puede acabar en el bundle del cliente.
 * Este módulo sólo se importa desde código de servidor (rutas con
 * `runtime = 'nodejs'`, el worker y los scripts de arranque). La única clave
 * pública, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, se lee directamente en el cliente.
 */

function str(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`La variable ${name} debe ser un entero, se recibió: ${raw}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export type SttProviderName = 'groq' | 'openai';

function sttProvider(): SttProviderName {
  const raw = (process.env.STT_PROVIDER ?? 'groq').toLowerCase();
  if (raw !== 'groq' && raw !== 'openai') {
    throw new Error(`STT_PROVIDER debe ser 'groq' u 'openai', se recibió: ${raw}`);
  }
  return raw;
}

const provider = sttProvider();

/**
 * `next build` importa los módulos de las rutas para recolectar metadatos, y
 * eso arrastra la configuración aunque ninguna ruta se prerrenderice (todas son
 * `force-dynamic`). En esa fase no hay base de datos: se usa un placeholder que
 * nunca llega a abrir una conexión (postgres.js conecta de forma perezosa).
 */
const isNextBuild = process.env.NEXT_PHASE === 'phase-production-build';

export const env = {
  databaseUrl: str(
    'DATABASE_URL',
    isNextBuild ? 'postgres://build:build@127.0.0.1:5432/build' : undefined,
  ),
  dataDir: str('DATA_DIR', '/data'),

  sttProvider: provider,
  groqApiKey: optional('GROQ_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),

  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  cleanupModel: str('CLEANUP_MODEL', 'claude-haiku-4-5'),
  summaryModel: str('SUMMARY_MODEL', 'claude-sonnet-5'),
  enableCleanup: bool('ENABLE_CLEANUP', true),

  // 600 s con Groq, 300 s con OpenAI (whisper-1 tiene límites de archivo más
  // estrictos). Si no se define, se elige según el proveedor activo.
  chunkSeconds: int('CHUNK_SECONDS', provider === 'openai' ? 300 : 600),
  maxUploadMb: int('MAX_UPLOAD_MB', 500),

  turnstileSiteKey: optional('NEXT_PUBLIC_TURNSTILE_SITE_KEY'),
  turnstileSecretKey: optional('TURNSTILE_SECRET_KEY'),
} as const;

/** Presencia de variables (booleanos, jamás los valores). Usado por /api/health. */
export function envPresence(): Record<string, boolean> {
  return {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    DATA_DIR: Boolean(process.env.DATA_DIR),
    STT_PROVIDER: Boolean(process.env.STT_PROVIDER),
    GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    CLEANUP_MODEL: Boolean(process.env.CLEANUP_MODEL),
    SUMMARY_MODEL: Boolean(process.env.SUMMARY_MODEL),
    ENABLE_CLEANUP: Boolean(process.env.ENABLE_CLEANUP),
    CHUNK_SECONDS: Boolean(process.env.CHUNK_SECONDS),
    MAX_UPLOAD_MB: Boolean(process.env.MAX_UPLOAD_MB),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
    TURNSTILE_SECRET_KEY: Boolean(process.env.TURNSTILE_SECRET_KEY),
  };
}
