import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, SESSION_COOKIE_MAX_AGE } from '@/lib/config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Genera la cookie `session_id` en el primer acceso. httpOnly, sameSite=lax,
 * 90 días (§6). Es el único mecanismo de historial: no hay autenticación.
 */
export function middleware(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const existing = request.cookies.get(SESSION_COOKIE)?.value;

  if (!existing || !UUID_RE.test(existing)) {
    response.cookies.set({
      name: SESSION_COOKIE,
      value: crypto.randomUUID(),
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE,
    });
  }

  return response;
}

export const config = {
  /**
   * **`/api/` queda fuera a propósito.**
   *
   * Originalmente era por un límite: Next.js trunca a 10 MB el cuerpo de toda
   * petición que atraviese el middleware, y `POST /api/transcriptions` recibía
   * el audio entero en multipart. Eso ya no aplica —el audio va directo del
   * navegador a Blob y por las rutas sólo pasa JSON pequeño—, pero la exclusión
   * se mantiene porque sigue siendo lo correcto por otro motivo: este
   * middleware sólo existe para crear la cookie `session_id`, que ya se genera
   * al cargar la página. Las rutas de API se limitan a leerla, así que
   * ejecutarlo en cada una sería latencia por nada.
   */
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};
