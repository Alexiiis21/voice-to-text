/**
 * Validación y redacción de `DATABASE_URL`.
 *
 * Módulo puro, cubierto por tests (tests/db-url.test.ts).
 *
 * Existe por un incidente real en producción: una `DATABASE_URL` compuesta a
 * mano con referencias de Railway (`${{Postgres.PGHOST}}`) que no resolvían
 * dejaba una URL con el host vacío. `postgres.js` respondía con un escueto
 * `TypeError: Invalid URL` **y volcaba la URL completa —contraseña incluida—
 * en los logs de despliegue**. Aquí se hacen las dos cosas que faltaban:
 * decir exactamente qué falta, y no imprimir jamás la credencial.
 */

export interface DatabaseUrlParts {
  scheme: string;
  user: string | null;
  password: string | null;
  host: string;
  port: string | null;
  database: string;
}

export interface DatabaseUrlCheck {
  ok: boolean;
  /** Versión segura para logs: la contraseña sustituida por `***`. */
  redacted: string;
  /** Problemas concretos, en lenguaje accionable. */
  problems: string[];
  parts: DatabaseUrlParts | null;
}

const URL_RE =
  /^(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:(?<user>[^:@/]*)(?::(?<password>[^@]*))?@)?(?<host>[^:/?#]*)(?::(?<port>[^/?#]*))?(?:\/(?<database>[^?#]*))?/;

const VALID_SCHEMES = new Set(['postgres', 'postgresql']);

/**
 * Sustituye la contraseña por `***`. Es tolerante a URLs malformadas: nunca
 * lanza, porque su único cometido es que algo se pueda registrar sin filtrar
 * credenciales.
 */
export function redactDatabaseUrl(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return '(vacía)';
  // Cualquier cosa entre `://usuario:` y el `@` es la contraseña.
  return raw.replace(/(:\/\/[^:@/]*:)[^@]*(@)/, '$1***$2');
}

/**
 * Comprueba que la URL sirve para conectar, y explica qué falla si no.
 *
 * No usa `new URL()` a propósito: ese constructor lanza ante una URL con el
 * host vacío, que es precisamente el caso que hay que diagnosticar.
 */
export function checkDatabaseUrl(raw: string | undefined | null): DatabaseUrlCheck {
  const redacted = redactDatabaseUrl(raw ?? '');

  if (raw === undefined || raw === null || raw.trim() === '') {
    return {
      ok: false,
      redacted,
      problems: ['DATABASE_URL no está definida.'],
      parts: null,
    };
  }

  const value = raw.trim();

  // Referencia de Railway sin resolver: el fallo más común al copiar y pegar.
  if (value.includes('${{') || value.includes('}}')) {
    return {
      ok: false,
      redacted,
      problems: [
        'DATABASE_URL contiene una referencia de Railway sin resolver (`${{…}}`). ' +
          'Comprueba que el nombre del servicio es exacto; usa el desplegable del panel.',
      ],
      parts: null,
    };
  }

  const match = URL_RE.exec(value);
  if (!match?.groups) {
    return {
      ok: false,
      redacted,
      problems: ['DATABASE_URL no tiene forma de URL (se esperaba postgresql://usuario:clave@host:puerto/base).'],
      parts: null,
    };
  }

  const groups = match.groups;
  const parts: DatabaseUrlParts = {
    scheme: groups.scheme ?? '',
    user: groups.user === undefined || groups.user === '' ? null : groups.user,
    password: groups.password === undefined || groups.password === '' ? null : groups.password,
    host: groups.host ?? '',
    port: groups.port === undefined || groups.port === '' ? null : groups.port,
    database: groups.database ?? '',
  };

  const problems: string[] = [];

  if (!VALID_SCHEMES.has(parts.scheme.toLowerCase())) {
    problems.push(
      `El esquema debe ser postgres:// o postgresql://, se recibió "${parts.scheme}://".`,
    );
  }

  if (parts.host === '') {
    problems.push(
      'Falta el host. En Railway suele indicar que DATABASE_URL se compuso a mano con ' +
        'referencias que no resuelven (p. ej. ${{Postgres.PGHOST}}). Usa la referencia ' +
        'completa ${{Postgres.DATABASE_URL}} en su lugar.',
    );
  }

  if (parts.port !== null && !/^\d+$/.test(parts.port)) {
    problems.push(`El puerto debe ser numérico, se recibió "${parts.port}".`);
  }

  if (parts.database === '') {
    problems.push('Falta el nombre de la base de datos al final de la URL.');
  }

  return { ok: problems.length === 0, redacted, problems, parts };
}

/**
 * Valida o lanza con un mensaje legible. El `Error` resultante **no contiene
 * la contraseña**: es seguro dejarlo llegar a los logs.
 */
export function assertDatabaseUrl(raw: string | undefined | null, scope: string): void {
  const check = checkDatabaseUrl(raw);
  if (check.ok) return;

  const detail = check.problems.map((problem) => `  - ${problem}`).join('\n');
  throw new Error(
    `[${scope}] DATABASE_URL no es válida.\n` +
      `  URL recibida (contraseña oculta): ${check.redacted}\n` +
      `${detail}`,
  );
}

/** ¿El fallo es de red y merece reintento, o de configuración y no? */
export function isRetryableConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH'
  );
}
