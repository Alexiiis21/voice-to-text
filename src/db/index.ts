import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/lib/env';
import { assertDatabaseUrl } from '@/lib/db-url';
import * as schema from './schema';

/**
 * Una sola instancia por proceso. En el contenedor conviven dos procesos
 * (servidor Next + worker), así que hay dos pools pequeños; con `max: 5` el
 * consumo de conexiones se mantiene muy por debajo del límite del plugin de
 * Postgres de Railway.
 */
const globalForDb = globalThis as unknown as {
  __transcriptorSql?: ReturnType<typeof postgres>;
};

function createClient(): ReturnType<typeof postgres> {
  // Diagnóstico claro y sin credenciales antes de que postgres.js lance un
  // `TypeError: Invalid URL` volcando la cadena de conexión entera.
  assertDatabaseUrl(env.databaseUrl, 'db');

  return postgres(env.databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
    // El SSE y el worker usan sentencias sencillas; desactivar prepare evita
    // problemas con poolers en modo transaction.
    prepare: false,
    onnotice: () => {},
  });
}

export const sql = globalForDb.__transcriptorSql ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__transcriptorSql = sql;
}

export const db = drizzle(sql, { schema });

export { schema };
