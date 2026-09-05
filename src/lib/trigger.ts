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
export async function triggerProcessing(): Promise<boolean> {
  const url = processUrl();
  if (url === null) return false;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.processSecret !== null) headers['x-process-secret'] = env.processSecret;

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
    });
    return true;
  } catch (error: unknown) {
    // `TimeoutError` es el camino normal, no un fallo: significa que la función
    // remota está trabajando y no va a contestar en 3 s. Cualquier otro error
    // tampoco debe romper a quien nos llamó.
    const name = (error as { name?: string } | null)?.name;
    if (name !== 'TimeoutError' && name !== 'AbortError') {
      console.warn(
        '[trigger] No se pudo disparar /api/process:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
}
