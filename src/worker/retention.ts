import { WORKER } from '@/lib/config';
import { removeTranscriptionFiles } from '@/lib/files';
import { purgeOldWindows } from '@/lib/rate-limit';
import * as repo from './repo';

const LAST_SWEEP_KEY = 'retention_last_sweep_at';

/**
 * Barrido de retención: borra transcripciones con más de 30 días y sus
 * ficheros.
 *
 * Se ejecuta como mucho una vez al día comparando contra una marca de tiempo
 * persistida en la base de datos, no contra un `setInterval` que se reinicie
 * con cada deploy (§9).
 */
export async function maybeRunRetentionSweep(force = false): Promise<boolean> {
  const now = Date.now();

  if (!force) {
    const last = await repo.readState(LAST_SWEEP_KEY);
    if (last) {
      const lastMs = Number.parseInt(last, 10);
      if (Number.isFinite(lastMs) && now - lastMs < WORKER.retentionIntervalMs) {
        return false;
      }
    }
  }

  const cutoff = new Date(now - WORKER.retentionDays * 24 * 60 * 60 * 1000);
  const expired = await repo.findExpired(cutoff);

  for (const row of expired) {
    await removeTranscriptionFiles(row.id, row.sourceExt);
    await repo.deleteTranscriptionRow(row.id);
  }

  const purgedWindows = await purgeOldWindows();
  await repo.writeState(LAST_SWEEP_KEY, String(now));

  console.log(
    `[worker] Retención: ${expired.length} transcripciones borradas, ` +
      `${purgedWindows} ventanas de rate limit purgadas`,
  );

  return true;
}
