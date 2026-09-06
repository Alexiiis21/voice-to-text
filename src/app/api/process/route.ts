/**
 * El worker, como función serverless.
 *
 * Sustituye al bucle infinito de `src/worker/index.ts`, que no tiene dónde
 * correr en Vercel. La diferencia de fondo: aquí el tiempo es finito. Una
 * función tiene `maxDuration` y un audio de tres horas no cabe en una sola
 * ejecución, así que el trabajo se hace **a plazos**:
 *
 *   1. Se reclama un trabajo y se procesa con un presupuesto de tiempo.
 *   2. Al agotarse el presupuesto, `processJob` levanta `JobInterrupted` entre
 *      fragmentos —el mismo mecanismo que usaba SIGTERM en Railway—, el trabajo
 *      vuelve a `queued` con los fragmentos ya transcritos guardados, y esta
 *      invocación encadena la siguiente antes de responder.
 *   3. La siguiente invocación lo reclama y sigue por donde iba.
 *
 * O sea: la señal cooperativa de apagado que ya existía para el despliegue en
 * contenedor es exactamente lo que hace falta aquí, sólo que disparada por un
 * reloj en vez de por una señal del sistema.
 */
import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { env } from '@/lib/env';
import { ensureDataDirs } from '@/lib/files';
import { safeErrorMessage } from '@/lib/redact';
import { triggerProcessing } from '@/lib/trigger';
import * as repo from '@/worker/repo';
import { discardAudio, JobDeferred, JobInterrupted, processJob } from '@/worker/process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tope de la función. 300 s es el máximo del plan Hobby con Fluid Compute (y
 * el valor por defecto en Pro). `PROCESS_BUDGET_MS` debe quedar por debajo:
 * la diferencia es el margen para cerrar con orden y encadenar.
 */
export const maxDuration = 300;

/**
 * ¿Viene de quien debe?
 *
 * Dos emisores legítimos: nuestras propias rutas (cabecera `x-process-secret`)
 * y el cron de Vercel (`Authorization: Bearer $CRON_SECRET`). Sin esto la ruta
 * sería un botón público para vaciar la cola y quemar cuota de los proveedores.
 */
function authorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth === `Bearer ${cronSecret}`) return true;
  }

  if (env.processSecret !== null) {
    if (request.headers.get('x-process-secret') === env.processSecret) return true;
  }

  // Sin ningún secreto configurado la ruta queda abierta. Es lo que permite
  // probarla en local, y se avisa en /api/health para que no pase inadvertido
  // en producción.
  return cronSecret === undefined && env.processSecret === null;
}

interface Outcome {
  processed: number;
  deferred: number;
  failed: number;
  interrupted: boolean;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  const inicio = Date.now();

  try {
    await ensureDataDirs();
  } catch (error: unknown) {
    // Si el scratch no se puede crear, nada de lo que sigue va a funcionar.
    // Merece un error explícito y no un fallo raro tres pasos más adelante.
    const message = safeErrorMessage(error);
    console.error(`[process] No se pudo preparar el directorio de trabajo: ${message}`);
    return NextResponse.json({ error: `Scratch no disponible: ${message}` }, { status: 500 });
  }

  const deadline = Date.now() + env.processBudgetMs;
  const stop = { stopped: (): boolean => Date.now() >= deadline };

  const outcome: Outcome = { processed: 0, deferred: 0, failed: 0, interrupted: false };

  console.log(`[process] Invocación iniciada · presupuesto ${env.processBudgetMs} ms`);

  // Varios trabajos por invocación si sobra tiempo: un audio corto no merece
  // una invocación entera para él solo.
  while (!stop.stopped()) {
    const job = await repo.claimNextJob();
    if (!job) {
      if (outcome.processed + outcome.failed + outcome.deferred === 0) {
        console.log('[process] No había nada que reclamar en la cola');
      }
      break;
    }

    console.log(`[process] Reclamado ${job.id} (${job.filename})`);
    const inicioJob = Date.now();

    try {
      await processJob(job, stop);
      outcome.processed += 1;
      console.log(`[process] ${job.id} completado en ${Date.now() - inicioJob} ms`);
    } catch (error: unknown) {
      if (error instanceof JobInterrupted) {
        // Se acabó el presupuesto entre fragmentos. Vuelve a la cola con todo
        // lo transcrito guardado; la siguiente invocación sigue desde ahí.
        console.log(`[process] ${job.id} devuelto a la cola por fin de presupuesto`);
        await repo.requeue(job.id);
        outcome.interrupted = true;
        break;
      }

      if (error instanceof JobDeferred) {
        await repo.deferJob(job.id, error.resumeAfter, error.reason);
        outcome.deferred += 1;
        continue;
      }

      const message = safeErrorMessage(error);
      console.error(`[process] ${job.id} falló: ${message}`);
      await discardAudio(job.id, job.sourceExt, [job.sourceUrl, job.normalizedUrl]);
      await repo.markFailed(job.id, message);
      outcome.failed += 1;
    }
  }

  // Encadenar si queda trabajo reclamable: o porque nos quedamos sin tiempo a
  // mitad, o porque entraron más audios mientras procesábamos éste.
  const pending = outcome.interrupted || (await repo.hasClaimableWork());

  console.log(
    `[process] Invocación terminada en ${Date.now() - inicio} ms · ` +
      `procesados=${outcome.processed} aparcados=${outcome.deferred} ` +
      `fallidos=${outcome.failed} interrumpido=${String(outcome.interrupted)} ` +
      `encadena=${String(pending)}`,
  );

  if (pending) {
    // `after` deja que la respuesta salga primero. Sin esto, el disparo compite
    // con el cierre de la invocación y se pierde a veces.
    after(async () => {
      await triggerProcessing(
        outcome.interrupted ? 'continuación tras fin de presupuesto' : 'queda cola pendiente',
      );
    });
  }

  return NextResponse.json({ ...outcome, chained: pending });
}

/** Sonda manual: `GET` no procesa nada, sólo dice si hay cola. */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return NextResponse.json({ pending: await repo.hasClaimableWork() });
}
