import { NextResponse } from 'next/server';
import { sql } from '@/db';
import { blobConfigured } from '@/lib/blob';
import { envPresence } from '@/lib/env';
import { ffmpegAvailable } from '@/lib/ffmpeg';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Estado del despliegue: Postgres, el binario de ffmpeg, el almacén de Blob y
 * qué variables de entorno están definidas.
 *
 * Devuelve BOOLEANOS, jamás los valores (§5).
 *
 * Ojo: esta ruta **no lleva el binario de ffmpeg en su bundle** (ver
 * `outputFileTracingIncludes` en next.config.ts, que sólo lo incluye en las
 * rutas que lo ejecutan). En Vercel, por tanto, `ffmpeg: false` aquí es lo
 * esperado y no significa que el procesado esté roto. En un contenedor, donde
 * ffmpeg está en el PATH, sí da true.
 */
export async function GET(): Promise<NextResponse> {
  let database = false;
  let databaseError: string | null = null;

  try {
    await sql`SELECT 1`;
    database = true;
  } catch (error: unknown) {
    databaseError = error instanceof Error ? error.message : String(error);
  }

  const binaries = await ffmpegAvailable();
  const blob = blobConfigured();

  // ffmpeg queda fuera del veredicto por lo dicho arriba: la salud que se puede
  // comprobar desde aquí es la base de datos y el almacén.
  const healthy = database && blob;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
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
