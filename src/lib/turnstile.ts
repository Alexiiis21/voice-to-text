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
    return { ok: false, reason: `Turnstile rechazó el token (${codes.join(', ') || 'sin detalle'})` };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `No se pudo verificar Turnstile: ${message}` };
  }
}
