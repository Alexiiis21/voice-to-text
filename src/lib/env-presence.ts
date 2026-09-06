/**
 * Inventario de variables de entorno, **sin validar nada**.
 *
 * Vive separado de `./env.ts` a propósito, y la razón es una avería real.
 *
 * `env.ts` construye su objeto `env` al importarse y lanza si falta una
 * variable obligatoria. En un contenedor eso era exactamente lo que se quería:
 * el proceso no arrancaba, el healthcheck lo veía y el despliegue se marcaba
 * como fallido. En serverless el efecto es otro: **cada ruta** que importe
 * `env`, aunque sea de forma indirecta, revienta al cargarse — y eso incluía a
 * `/api/health`, cuyo único trabajo es decirte qué falta. Con `DATABASE_URL`
 * borrada del proyecto, la página daba 500 y el health también, así que no
 * había forma de diagnosticarlo desde la propia app.
 *
 * Este módulo no importa `./env.ts` ni nada que lo importe: sólo lee
 * `process.env`. No puede lanzar, así que el health siempre puede contestar.
 *
 * Devuelve BOOLEANOS, jamás los valores (§5).
 */

/** Sin estas, la aplicación no puede funcionar en absoluto. */
const REQUIRED = ['DATABASE_URL'] as const;

/**
 * Necesarias para el flujo completo, pero su ausencia degrada en vez de
 * impedir el arranque: sin Blob no hay subidas, sin clave STT no hay
 * transcripción, sin secreto `/api/process` queda abierta.
 */
const IMPORTANT = ['BLOB_READ_WRITE_TOKEN'] as const;

const TRACKED = [
  'DATABASE_URL',
  'DATA_DIR',
  'BLOB_READ_WRITE_TOKEN',
  'PROCESS_SECRET',
  'CRON_SECRET',
  'APP_URL',
  'STT_PROVIDER',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLEANUP_MODEL',
  'SUMMARY_MODEL',
  'ENABLE_CLEANUP',
  'CHUNK_SECONDS',
  'MAX_UPLOAD_MB',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
] as const;

function present(name: string): boolean {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() !== '';
}

export function envPresence(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of TRACKED) out[name] = present(name);
  return out;
}

/** Obligatorias que faltan. Si devuelve algo, la app no puede servir nada. */
export function missingRequired(): string[] {
  return REQUIRED.filter((name) => !present(name));
}

/** Importantes que faltan. La app arranca, pero con funciones caídas. */
export function missingImportant(): string[] {
  return IMPORTANT.filter((name) => !present(name));
}
