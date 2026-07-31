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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
