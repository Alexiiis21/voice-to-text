/**
 * Disparo de `/api/process`.
 *
 * En Railway el worker era un bucle: nadie tenía que "despertarlo". En Vercel
 * no hay proceso vivo, así que cada trabajo nuevo tiene que provocar una
 * invocación, y una invocación que se queda sin tiempo tiene que encadenar la
 * siguiente.
 *
 * El disparo es deliberadamente **fire-and-forget**: quien lo llama no espera a
 * que la transcripción termine (tardaría minutos), sólo a que Vercel acepte la
 * petición. Por eso se aborta la espera enseguida —la invocación remota ya está
 * en marcha y no depende de nuestra conexión— y por eso ningún fallo aquí se
 * propaga: si el disparo se pierde, el cron de `/api/cron` recoge el trabajo.
 */
import { env } from './env';

/** Margen para que Vercel acepte la petición y arranque la función. */
const TRIGGER_TIMEOUT_MS = 3000;

export function processUrl(): string | null {
  return env.appUrl === null ? null : `${env.appUrl}/api/process`;
}

/**
 * Pide una invocación de `/api/process`. Devuelve `true` si la petición salió;
 * `false` si no había forma de dispararla (sin `APP_URL`/`VERCEL_URL`, que es
 * el caso de desarrollo local con el worker en su propio proceso).
 */
export async function triggerProcessing(motivo: string): Promise<boolean> {
  const url = processUrl();

  if (url === null) {
    // Antes esto era un `return false` mudo, y era la peor variante posible: el
    // audio se encolaba, nadie lo recogía y no había ni un mensaje que lo
    // explicara. Si no hay a quién llamar, hay que decirlo.
    console.error(
      `[trigger] NO SE PUEDE DISPARAR el procesado (motivo: ${motivo}). ` +
        'No hay APP_URL ni VERCEL_URL, así que el trabajo se quedará en `queued` ' +
        'indefinidamente. Define APP_URL, o arranca el worker con `npm run dev:worker`.',
    );
    return false;
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.processSecret !== null) headers['x-process-secret'] = env.processSecret;

  const inicio = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
    });

    // Un 401 aquí es un fallo de configuración silencioso y mortal: el disparo
    // sale, la cola nunca se vacía y nadie lo nota. Merece log propio.
    if (response.status === 401) {
      console.error(
        `[trigger] /api/process rechazó el disparo con 401 (motivo: ${motivo}). ` +
          'PROCESS_SECRET no coincide entre quien dispara y quien recibe.',
      );
      return false;
    }

    console.log(
      `[trigger] Disparado /api/process (motivo: ${motivo}) → ${response.status} ` +
        `en ${Date.now() - inicio} ms`,
    );
    return true;
  } catch (error: unknown) {
    // `TimeoutError` es el camino normal, no un fallo: significa que la función
    // remota está trabajando y no va a contestar en 3 s.
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      console.log(
        `[trigger] Disparado /api/process (motivo: ${motivo}); sigue trabajando ` +
          'más allá del tiempo de espera, que es lo esperado.',
      );
      return true;
    }

    console.error(
      `[trigger] No se pudo disparar /api/process (motivo: ${motivo}):`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
