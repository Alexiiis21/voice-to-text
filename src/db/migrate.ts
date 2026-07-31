/**
 * Aplica las migraciones de Drizzle. Se ejecuta en el arranque del contenedor,
 * antes de levantar el servidor y el worker (ver scripts/start.mjs).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[migrate] Falta DATABASE_URL');
  process.exit(1);
}

const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_DIR ?? path.resolve('drizzle');

async function main(): Promise<void> {
  // Una única conexión, cerrada al terminar: no dejar el proceso colgado.
  const client = postgres(databaseUrl as string, { max: 1, prepare: false, onnotice: () => {} });
  try {
    console.log(`[migrate] Aplicando migraciones desde ${migrationsFolder}`);
    await migrate(drizzle(client), { migrationsFolder });
    console.log('[migrate] Migraciones al día');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] Error aplicando migraciones:', error);
  process.exit(1);
});
