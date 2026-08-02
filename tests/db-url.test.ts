import { describe, expect, it } from 'vitest';
import {
  assertDatabaseUrl,
  checkDatabaseUrl,
  isRetryableConnectionError,
  redactDatabaseUrl,
} from '@/lib/db-url';

const SECRET = 'nixtAELfsmENMKizUoROBlKCfOHCnTnA';

describe('redactDatabaseUrl', () => {
  it('oculta la contraseña', () => {
    const raw = `postgresql://postgres:${SECRET}@postgres.railway.internal:5432/railway`;
    const redacted = redactDatabaseUrl(raw);

    expect(redacted).toBe('postgresql://postgres:***@postgres.railway.internal:5432/railway');
    expect(redacted).not.toContain(SECRET);
  });

  it('oculta la contraseña también en una URL rota', () => {
    // El caso exacto que llegó a los logs de Railway: host y puerto vacíos.
    const raw = `postgresql://postgres:${SECRET}@:/railway`;
    expect(redactDatabaseUrl(raw)).toBe('postgresql://postgres:***@:/railway');
    expect(redactDatabaseUrl(raw)).not.toContain(SECRET);
  });

  it('no rompe con entradas vacías o sin contraseña', () => {
    expect(redactDatabaseUrl('')).toBe('(vacía)');
    expect(redactDatabaseUrl('postgresql://host:5432/db')).toBe('postgresql://host:5432/db');
  });
});

describe('checkDatabaseUrl', () => {
  it('acepta una URL de Railway bien formada', () => {
    const check = checkDatabaseUrl(
      `postgresql://postgres:${SECRET}@postgres.railway.internal:5432/railway`,
    );

    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.parts).toMatchObject({
      scheme: 'postgresql',
      user: 'postgres',
      host: 'postgres.railway.internal',
      port: '5432',
      database: 'railway',
    });
  });

  it('acepta el esquema corto y la ausencia de puerto', () => {
    expect(checkDatabaseUrl('postgres://u:p@localhost/transcriptor').ok).toBe(true);
  });

  it('detecta el host vacío y sugiere la referencia correcta', () => {
    const check = checkDatabaseUrl(`postgresql://postgres:${SECRET}@:/railway`);

    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('Falta el host');
    expect(check.problems.join(' ')).toContain('${{Postgres.DATABASE_URL}}');
    expect(check.redacted).not.toContain(SECRET);
  });

  it('detecta una referencia de Railway sin resolver', () => {
    const check = checkDatabaseUrl('${{Postgres.DATABASE_URL}}');

    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('sin resolver');
  });

  it('detecta que falta la base de datos', () => {
    const check = checkDatabaseUrl('postgresql://u:p@host:5432');
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('base de datos');
  });

  it('rechaza un esquema que no es Postgres', () => {
    const check = checkDatabaseUrl('mysql://u:p@host:3306/db');
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('postgres://');
  });

  it('rechaza un puerto no numérico', () => {
    const check = checkDatabaseUrl('postgresql://u:p@host:abc/db');
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('numérico');
  });

  it('rechaza la ausencia de la variable', () => {
    expect(checkDatabaseUrl(undefined).ok).toBe(false);
    expect(checkDatabaseUrl(null).ok).toBe(false);
    expect(checkDatabaseUrl('   ').ok).toBe(false);
    expect(checkDatabaseUrl('').problems.join(' ')).toContain('no está definida');
  });
});

describe('assertDatabaseUrl', () => {
  it('no lanza con una URL válida', () => {
    expect(() =>
      assertDatabaseUrl('postgresql://u:p@host:5432/db', 'test'),
    ).not.toThrow();
  });

  it('lanza un error legible que NUNCA incluye la contraseña', () => {
    const raw = `postgresql://postgres:${SECRET}@:/railway`;
    let message = '';
    try {
      assertDatabaseUrl(raw, 'migrate');
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('[migrate]');
    expect(message).toContain('Falta el host');
    expect(message).toContain('***');
    expect(message).not.toContain(SECRET);
  });
});

describe('isRetryableConnectionError', () => {
  it('reintenta ante fallos de red del arranque', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']) {
      expect(isRetryableConnectionError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('no reintenta ante errores de configuración', () => {
    expect(isRetryableConnectionError(new TypeError('Invalid URL'))).toBe(false);
    expect(isRetryableConnectionError(Object.assign(new Error('x'), { code: '28P01' }))).toBe(
      false,
    );
    expect(isRetryableConnectionError(null)).toBe(false);
  });
});
