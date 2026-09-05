/**
 * Red de seguridad periódica.
 *
 * En Railway estas tres tareas vivían en el arranque y en el bucle del worker.
 * Sin proceso vivo hay que dispararlas desde fuera:
 *
 *   1. Rescatar trabajos que se quedaron en `processing` porque la invocación
 *      murió de golpe (timeout duro, OOM) sin devolverlos a la cola.
 *   2. Barrido de retención (§6).
 *   3. Despertar la cola, que además recoge los trabajos aparcados por cuota
 *      cuya ventana ya se ha abierto.
 *
 * **Aviso sobre el plan Hobby:** ahí Vercel sólo ejecuta los cron una vez al
 * día. Es suficiente para (1) y (2), que son limpieza, pero deja (3) muy lento:
 * un trabajo aparcado por falta de cuota podría esperar horas. Por eso el
 * camino normal de despertar la cola no es este cron sino el disparo directo
 * desde la subida y desde el SSE (ver src/lib/trigger.ts). Con plan Pro se
 * puede bajar el `schedule` de vercel.json a algo por minutos y este cron pasa
 * a ser también un planificador decente.
 */
import { NextResponse } from 'next/server';
import { safeErrorMessage } from '@/lib/redact';
import { triggerProcessing } from '@/lib/trigger';
import * as repo from '@/worker/repo';
import { maybeRunRetentionSweep } from '@/worker/retention';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * El cron de Vercel manda `Authorization: Bearer $CRON_SECRET` cuando la
 * variable existe. Si no se ha configurado, se acepta la cabecera propia.
 */
function authorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    return request.headers.get('authorization') === `Bearer ${cronSecret}`;
  }
  const processSecret = process.env.PROCESS_SECRET?.trim();
  if (processSecret) {
    return request.headers.get('x-process-secret') === processSecret;
  }
  return true;
}

/**
 * Un trabajo se considera perdido cuando lleva en vuelo más del doble del
 * `maxDuration` de `/api/process`. El doble, y no el tiempo justo, para no
 * pisar una invocación que aún esté trabajando.
 */
const STALE_AFTER_MS = 2 * 300 * 1000;

async function run(): Promise<NextResponse> {
  try {
    const requeued = await repo.requeueStaleJobs(STALE_AFTER_MS);
    if (requeued > 0) console.log(`[cron] ${requeued} trabajos atascados devueltos a la cola`);

    const swept = await maybeRunRetentionSweep();

    const pending = await repo.hasClaimableWork();
    if (pending) await triggerProcessing();

    return NextResponse.json({ requeued, swept, pending });
  } catch (error: unknown) {
    const message = safeErrorMessage(error);
    console.error('[cron] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Vercel Cron invoca con GET. */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return run();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return run();
}
