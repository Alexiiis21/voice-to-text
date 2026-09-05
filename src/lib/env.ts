/**
 * Lectura y validación de variables de entorno.
 *
 * Regla dura: ninguna clave secreta puede acabar en el bundle del cliente.
 * Este módulo sólo se importa desde código de servidor (rutas con
 * `runtime = 'nodejs'`, el worker y los scripts de arranque). La única clave
 * pública, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, se lee directamente en el cliente.
 */
import os from 'node:os';
import path from 'node:path';
import { checkDatabaseUrl } from './db-url';

/**
 * Lee una variable saneando los errores de copiar y pegar.
 *
 * Los espacios y saltos de línea al borde se recortan siempre. Un salto de
 * línea **en medio** del valor no se recorta: se rechaza con un error claro,
 * porque casi siempre significa que al pegar en el panel se coló la línea
 * siguiente del `.env`. Pasó de verdad con `ANTHROPIC_API_KEY`, que acabó
 * conteniendo `…clave\nCLEANUP_MODEL=claude-haiku-4-5`; el SDK reventaba mucho
 * más tarde, a mitad de un trabajo, con un críptico `invalid header value`
 * **que además volcaba la clave entera en los logs**.
 */
function clean(name: string, raw: string): string {
  const value = raw.trim();

  if (/[\r\n]/.test(value)) {
    const firstLine = value.split(/[\r\n]/)[0] ?? '';
    throw new Error(
      `La variable ${name} contiene un salto de línea. Suele pasar al pegar en ` +
        'el panel y arrastrar la línea siguiente. Vuelve a pegar sólo el valor ' +
        `(${firstLine.length} caracteres antes del salto).`,
    );
  }

  return value;
}

function str(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return clean(name, raw);
}

function optional(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? null : clean(name, raw);
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

/**
 * `STT_PROVIDER` acepta una lista ordenada separada por comas
 * (`groq,openai`): el primero es el proveedor por defecto y los siguientes son
 * el desbordamiento cuando el anterior se queda sin cuota. Un valor único
 * (`groq`) sigue siendo válido y significa "sin desbordamiento".
 */
function sttProviders(): SttProviderName[] {
  const raw = (process.env.STT_PROVIDER ?? 'groq').toLowerCase();
  const out: SttProviderName[] = [];

  for (const part of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    if (part !== 'groq' && part !== 'openai') {
      throw new Error(
        `STT_PROVIDER sólo admite 'groq' y 'openai' separados por comas, se recibió: ${part}`,
      );
    }
    if (!out.includes(part)) out.push(part);
  }

  return out.length > 0 ? out : ['groq'];
}

const providers = sttProviders();
const provider = providers[0] ?? 'groq';

/**
 * `next build` importa los módulos de las rutas para recolectar metadatos, y
 * eso arrastra la configuración aunque ninguna ruta se prerrenderice (todas son
 * `force-dynamic`). En esa fase no hay base de datos: se usa un placeholder que
 * nunca llega a abrir una conexión (postgres.js conecta de forma perezosa).
 */
const isNextBuild = process.env.NEXT_PHASE === 'phase-production-build';

const BUILD_PLACEHOLDER_DB_URL = 'postgres://build:build@127.0.0.1:5432/build';

/**
 * Durante el build se ignora `DATABASE_URL` si está ausente **o es inválida**.
 *
 * Railway inyecta las variables del servicio también en el build, así que una
 * URL mal formada rompería la compilación además del arranque. Como el build no
 * consulta la base de datos, aquí no aporta nada validarla: el diagnóstico se
 * da en `src/db/index.ts` y en `src/db/migrate.ts`, ya en ejecución, que es
 * donde el usuario puede actuar.
 */
function resolveDatabaseUrl(): string {
  if (!isNextBuild) return str('DATABASE_URL');

  const raw = process.env.DATABASE_URL;
  return checkDatabaseUrl(raw).ok ? clean('DATABASE_URL', raw as string) : BUILD_PLACEHOLDER_DB_URL;
}

/**
 * Directorio de scratch.
 *
 * En Railway era el volumen persistente `/data`. En Vercel el único sitio
 * escribible es `/tmp`, y sólo dentro de la invocación en curso: lo que tiene
 * que sobrevivir va a Blob (ver ./blob.ts). `DATA_DIR` se sigue respetando para
 * poder desplegar en un contenedor con volumen sin tocar código.
 */
const DEFAULT_DATA_DIR = path.join(os.tmpdir(), 'transcriptor');

/**
 * URL base de la propia aplicación, para que `/api/process` pueda re-invocarse
 * cuando un trabajo no cabe en una sola ejecución.
 *
 * `VERCEL_URL` apunta al despliegue concreto, no al alias de producción, y eso
 * es lo que se quiere: la cadena de invocaciones se queda en la misma versión
 * del código aunque se promocione otro despliegue a mitad de un audio largo.
 */
function resolveAppUrl(): string | null {
  const explicit = optional('APP_URL');
  if (explicit !== null) return explicit.replace(/\/+$/, '');

  const vercelUrl = optional('VERCEL_URL');
  if (vercelUrl !== null) return `https://${vercelUrl}`;

  return null;
}

export const env = {
  databaseUrl: resolveDatabaseUrl(),
  dataDir: str('DATA_DIR', DEFAULT_DATA_DIR),

  appUrl: resolveAppUrl(),
  /**
   * Secreto compartido para `/api/process`. Sin él, cualquiera podría vaciar la
   * cola de trabajo a base de peticiones. Si no se define, la ruta sólo acepta
   * la cabecera de cron de Vercel.
   */
  processSecret: optional('PROCESS_SECRET'),
  /**
   * Margen que se reserva antes del `maxDuration` de la función para cerrar el
   * trabajo con orden: guardar el fragmento en curso y encadenar la siguiente
   * invocación. Ver src/app/api/process/route.ts.
   */
  processBudgetMs: int('PROCESS_BUDGET_MS', 240_000),

  /** Cadena ordenada: primario y desbordamientos. */
  sttProviders: providers,
  /** Primer proveedor de la cadena. */
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
    BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    PROCESS_SECRET: Boolean(process.env.PROCESS_SECRET),
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
