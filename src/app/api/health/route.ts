import { NextResponse } from 'next/server';
import { sql } from '@/db';
import { envPresence } from '@/lib/env';
import { ffmpegAvailable } from '@/lib/ffmpeg';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Healthcheck de Railway: conexión a Postgres, presencia de ffmpeg/ffprobe en
 * el PATH y qué variables de entorno están definidas.
 *
 * Devuelve BOOLEANOS, jamás los valores (§5).
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
  const healthy = database && binaries.ffmpeg && binaries.ffprobe;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      database,
      databaseError,
      ffmpeg: binaries.ffmpeg,
      ffprobe: binaries.ffprobe,
      env: envPresence(),
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
