import { env } from './env';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

export interface TurnstileResult {
  ok: boolean;
  reason: string | null;
}

/**
 * Traduce los códigos de siteverify a algo accionable.
 *
 * `timeout-or-duplicate` es con diferencia el más frecuente: los tokens son de
 * un solo uso y caducan a los 300 s. El cliente pide uno nuevo tras cada
 * subida, pero una pestaña abierta mucho rato o un doble envío pueden llegar
 * aquí igualmente.
 */
function explainCodes(codes: readonly string[]): string {
  if (codes.includes('timeout-or-duplicate')) {
    return 'La verificación antibot ha caducado o ya se había usado. Recarga la página e inténtalo de nuevo.';
  }
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    return 'TURNSTILE_SECRET_KEY no es válida o falta en el servidor.';
  }
  if (codes.includes('invalid-input-response') || codes.includes('missing-input-response')) {
    return 'No se recibió una respuesta válida del widget antibot.';
  }
  if (codes.includes('bad-request')) {
    return 'Cloudflare rechazó la petición de verificación (bad-request).';
  }
  if (codes.includes('internal-error')) {
    return 'Cloudflare tuvo un error interno verificando el token. Vuelve a intentarlo.';
  }
  return `Verificación antibot fallida (${codes.join(', ') || 'sin detalle'}).`;
}

/**
 * Verifica el token de Turnstile contra Cloudflare.
 *
 * Si `TURNSTILE_SECRET_KEY` no está definida, la verificación se salta y se
 * registra un aviso. Esto permite `docker compose up` en local sin dar de alta
 * un sitio en Cloudflare; en Railway la variable es obligatoria (§10) y
 * /api/health la expone como booleano.
 */
export async function verifyTurnstile(
  token: string | null,
  remoteIp: string | null,
): Promise<TurnstileResult> {
  if (!env.turnstileSecretKey) {
    console.warn('[turnstile] TURNSTILE_SECRET_KEY no definida: verificación desactivada');
    return { ok: true, reason: null };
  }

  if (!token) {
    return { ok: false, reason: 'Falta el token de Turnstile' };
  }

  const body = new URLSearchParams({ secret: env.turnstileSecretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { ok: false, reason: `Cloudflare respondió ${response.status}` };
    }

    const parsed = (await response.json()) as SiteverifyResponse;
    if (parsed.success === true) return { ok: true, reason: null };

    const codes = parsed['error-codes'] ?? [];
    return { ok: false, reason: explainCodes(codes) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `No se pudo verificar Turnstile: ${message}` };
  }
}
