/**
 * Bucle del worker.
 *
 * Vive en el mismo contenedor que el servidor de Next (ver README, §
 * "Dos procesos en un servicio"). Sondea la cola de Postgres cada 5 s cuando
 * está vacía; cuando hay trabajo, itera sin esperar.
 */
import { WORKER } from '@/lib/config';
import { env } from '@/lib/env';
import { ensureDataDirs, removeTranscriptionFiles } from '@/lib/files';
import { sql } from '@/db';
import * as repo from './repo';
import { JobInterrupted, processJob, type StopSignal } from './process';
import { maybeRunRetentionSweep } from './retention';

let shuttingDown = false;
let currentJobId: string | null = null;

const stop: StopSignal = {
  stopped: () => shuttingDown,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tick(): Promise<boolean> {
  const job = await repo.claimNextJob();
  if (!job) return false;

  currentJobId = job.id;
  console.log(`[worker] Reclamado ${job.id} (${job.filename})`);

  try {
    await processJob(job, stop);
  } catch (error: unknown) {
    if (error instanceof JobInterrupted) {
      // Apagado limpio: nada debe quedarse colgado en `processing`.
      console.log(`[worker] ${job.id} devuelto a la cola por apagado`);
      await repo.requeue(job.id);
    } else {
      const message = errorMessage(error);
      console.error(`[worker] ${job.id} falló: ${message}`);
      // El audio se borra siempre al terminar la transcripción, con éxito o
      // sin él (§6). Un fallo duro aborta antes de la limpieza normal, así que
      // se hace aquí.
      await removeTranscriptionFiles(job.id, job.sourceExt);
      await repo.markFailed(job.id, message);
    }
  } finally {
    currentJobId = null;
  }

  return true;
}

async function main(): Promise<void> {
  console.log(
    `[worker] Arrancando · STT=${env.sttProvider} · CHUNK_SECONDS=${env.chunkSeconds} · ` +
      `ENABLE_CLEANUP=${String(env.enableCleanup)}`,
  );

  await ensureDataDirs();

  const requeued = await repo.requeueOrphanedJobs();
  if (requeued > 0) {
    console.log(`[worker] ${requeued} trabajos huérfanos devueltos a la cola`);
  }

  await maybeRunRetentionSweep();

  while (!shuttingDown) {
    try {
      const didWork = await tick();

      if (!didWork) {
        // Cola vacía: dormimos. Un while(true) sin pausa dispara la factura de
        // CPU de Railway sin hacer nada útil (§9).
        await maybeRunRetentionSweep();
        await sleep(WORKER.idlePollMs);
      }
    } catch (error: unknown) {
      console.error('[worker] Error en el bucle principal:', errorMessage(error));
      await sleep(WORKER.idlePollMs);
    }
  }

  console.log('[worker] Cerrando conexiones');
  await sql.end({ timeout: 10 }).catch(() => {});
  process.exit(0);
}

function requestShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    `[worker] ${signal} recibido; se terminará el fragmento en curso` +
      (currentJobId ? ` (${currentJobId})` : ''),
  );

  // Red de seguridad: si el fragmento en curso tarda demasiado, salimos igual.
  const timer = setTimeout(() => {
    console.warn('[worker] Apagado forzado tras 120 s');
    process.exit(0);
  }, 120_000);
  timer.unref();
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection:', reason);
});

main().catch((error: unknown) => {
  console.error('[worker] Error fatal:', error);
  process.exit(1);
});
