/**
 * Aplica las migraciones de Drizzle. Se ejecuta en el arranque del contenedor,
 * antes de levantar el servidor y el worker (ver scripts/start.mjs).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import {
  assertDatabaseUrl,
  isRetryableConnectionError,
  redactDatabaseUrl,
} from '@/lib/db-url';

const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_DIR ?? path.resolve('drizzle');

/** El plugin de Postgres de Railway puede tardar en aceptar conexiones. */
const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMigrations(databaseUrl: string): Promise<void> {
  // Una única conexión, cerrada al terminar: no dejar el proceso colgado.
  const client = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  // Falla rápido y con un mensaje útil si la URL está mal formada. Reintentar
  // un error de configuración no sirve de nada y sólo alarga el crash-loop.
  assertDatabaseUrl(databaseUrl, 'migrate');

  console.log(`[migrate] Base de datos: ${redactDatabaseUrl(databaseUrl as string)}`);
  console.log(`[migrate] Aplicando migraciones desde ${migrationsFolder}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await runMigrations(databaseUrl as string);
      console.log('[migrate] Migraciones al día');
      return;
    } catch (error: unknown) {
      const cause = (error as { cause?: unknown }).cause ?? error;

      if (!isRetryableConnectionError(cause) || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const delay = BASE_DELAY_MS * attempt;
      const code = (cause as NodeJS.ErrnoException).code;
      console.warn(
        `[migrate] Postgres todavía no acepta conexiones (${code}); ` +
          `reintento ${attempt}/${MAX_ATTEMPTS - 1} en ${delay / 1000} s`,
      );
      await sleep(delay);
    }
  }
}

main().catch((error: unknown) => {
  // El mensaje de assertDatabaseUrl ya viene redactado; para el resto sólo se
  // imprime el mensaje, nunca el objeto completo, que en postgres.js incluye
  // la cadena de conexión con la contraseña.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[migrate] Error aplicando migraciones: ${message}`);
  process.exit(1);
});
