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
 * Un 401 tiene dos orígenes muy distintos y el mensaje tiene que decir cuál.
 *
 * Este log decía siempre «PROCESS_SECRET no coincide», y costó una tarde:
 * quien rechazaba era la Deployment Protection de Vercel, la función ni se
 * ejecutaba, y el mensaje mandaba a revisar una variable que no tenía nada que
 * ver —definirla no arreglaba nada, claro—. Se distinguen por el cuerpo: el
 * nuestro es `{"error":"No autorizado"}`; el del edge trae `Protected
 * deployment` y un enlace a `vercel.com/sso-api`.
 */
async function explicar401(response: Response): Promise<string> {
  let cuerpo = '';
  try {
    cuerpo = (await response.text()).slice(0, 300);
  } catch {
    // Si el cuerpo no se puede leer nos quedamos sin distinguir, pero el aviso
    // genérico sigue siendo mejor que acusar a una variable al azar.
    return 'No se pudo leer el cuerpo de la respuesta para saber quién lo rechazó.';
  }

  if (cuerpo.includes('Protected deployment') || cuerpo.includes('sso-api')) {
    return (
      'Lo rechazó la Deployment Protection de Vercel, NO la ruta: la función ni ' +
      'llega a ejecutarse, así que PROCESS_SECRET no interviene. Activa ' +
      '«Protection Bypass for Automation» en Settings → Deployment Protection ' +
      '(Vercel inyecta VERCEL_AUTOMATION_BYPASS_SECRET y este disparo la manda ' +
      'sola), o desactiva la protección.'
    );
  }

  return (
    'Lo rechazó la propia ruta: el secreto que enviamos no es el que espera. ' +
    'Revisa PROCESS_SECRET en el proyecto —presente en el mismo entorno que ' +
    'este despliegue— y vuelve a desplegar, que las variables no se aplican en ' +
    'caliente. Ojo también a tener CRON_SECRET sin PROCESS_SECRET: en ese caso ' +
    'el disparo no lleva ninguna credencial que la ruta acepte.'
  );
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

  // Con la Deployment Protection de Vercel activada, el 401 lo pone el edge
  // **antes** de ejecutar la función: `x-process-secret` no llega a mirarse
  // nunca. El navegador pasa porque lleva la cookie del SSO; una llamada de
  // servidor a servidor, no. Esta cabecera es la puerta oficial para la
  // automatización, y el secreto lo inyecta Vercel solo al activarla.
  if (env.automationBypassSecret !== null) {
    headers['x-vercel-protection-bypass'] = env.automationBypassSecret;
  }

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
          (await explicar401(response)),
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
