import { cookies } from 'next/headers';
import { SESSION_COOKIE } from './config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lee la cookie anónima de sesión. La crea el middleware en el primer acceso;
 * si por algún motivo no está (petición directa a la API sin pasar por la
 * página), devolvemos null y el llamante decide.
 *
 * Esto NO es un mecanismo de seguridad: quien conozca un id de transcripción
 * puede consultarlo. Ver README.
 */
export async function readSessionId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value || !UUID_RE.test(value)) return null;
  return value;
}

export function isValidSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
