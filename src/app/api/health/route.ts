import { NextResponse } from 'next/server';
import { blobConfigured } from '@/lib/blob';
import { envPresence, missingImportant, missingRequired } from '@/lib/env-presence';
import { ffmpegAvailable } from '@/lib/ffmpeg';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Estado del despliegue: Postgres, el binario de ffmpeg, el almacén de Blob y
 * qué variables de entorno están definidas.
 *
 * Devuelve BOOLEANOS, jamás los valores (§5).
 *
 * **Esta ruta no importa `@/lib/env` ni `@/db` en el nivel de módulo**, y es
 * deliberado. Ambos construyen su estado al cargarse y lanzan si falta una
 * variable obligatoria, así que importarlos aquí hacía que el health muriera
 * exactamente en el escenario que tiene que diagnosticar: pasó de verdad al
 * desaparecer `DATABASE_URL` del proyecto —la página daba 500, el health
 * también, y no había forma de ver qué faltaba—. La conexión a la base se carga
 * con un import dinámico dentro del `try`.
 */
export async function GET(): Promise<NextResponse> {
  const missing = missingRequired();

  let database = false;
  let databaseError: string | null = null;

  if (missing.length > 0) {
    databaseError = `Faltan variables obligatorias: ${missing.join(', ')}`;
  } else {
    try {
      const { sql } = await import('@/db');
      await sql`SELECT 1`;
      database = true;
    } catch (error: unknown) {
      databaseError = error instanceof Error ? error.message : String(error);
    }
  }

  // Ninguna de estas dos toca `env`, así que son seguras pase lo que pase.
  const blob = blobConfigured();
  const binaries = await ffmpegAvailable().catch(() => ({ ffmpeg: false, path: '(sin resolver)' }));

  const healthy = missing.length === 0 && database && blob;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      // Lista accionable: qué hay que poner en el proyecto para que esto pase
      // a 'ok'. Vacías cuando todo está en su sitio.
      missingRequired: missing,
      missingImportant: missingImportant(),
      database,
      databaseError,
      blob,
      ffmpeg: binaries.ffmpeg,
      ffmpegPath: binaries.path,
      // Sin ninguno de los dos secretos, /api/process queda abierta a cualquiera.
      processProtected:
        Boolean(process.env.CRON_SECRET?.trim()) || Boolean(process.env.PROCESS_SECRET?.trim()),
      env: envPresence(),
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
