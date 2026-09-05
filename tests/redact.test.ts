import { describe, expect, it } from 'vitest';
import { redactSecrets, safeErrorMessage } from '@/lib/redact';

// Valores con la forma real de cada proveedor, pero inventados.
const ANTHROPIC = 'sk-ant-api03-68ppPFHDevHyVsyVEA3EK6cAS5Yj2bB9OBsOJxVAhAtX5gHG4-iftb9yX9tTdWRv';
const OPENAI = 'sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUvWxYz';
const GROQ = 'gsk_AbCdEf0123456789GhIjKlMnOpQrStUvWxYz';
const TURNSTILE_SECRET = '0x4AAAAAAABkMYinukE8nzYS';

describe('redactSecrets', () => {
  it('oculta una clave de Anthropic en el error real que llegó a los logs', () => {
    // Mensaje literal producido por el SDK cuando la clave lleva un salto de
    // línea pegado: volcaba la credencial entera a consola.
    const message = `Headers.append: "${ANTHROPIC}\nCLEANUP_MODEL=claude-haiku-4-5" is an invalid header value.`;
    const safe = redactSecrets(message);

    expect(safe).not.toContain(ANTHROPIC);
    expect(safe).toContain('***');
    // El resto del mensaje se conserva: sigue sirviendo para diagnosticar.
    expect(safe).toContain('is an invalid header value');
    expect(safe).toContain('CLEANUP_MODEL');
  });

  it('oculta claves de OpenAI, Groq y Turnstile', () => {
    expect(redactSecrets(`fallo con ${OPENAI}`)).not.toContain(OPENAI);
    expect(redactSecrets(`fallo con ${GROQ}`)).not.toContain(GROQ);
    expect(redactSecrets(`fallo con ${TURNSTILE_SECRET}`)).not.toContain(TURNSTILE_SECRET);
  });

  it('oculta la contraseña de una URL de conexión', () => {
    const url = 'postgresql://postgres:nixtAELfsmENMKizUoROBlKCfOHCnTnA@host:5432/railway';
    const safe = redactSecrets(`Invalid URL: ${url}`);

    expect(safe).not.toContain('nixtAELfsmENMKizUoROBlKCfOHCnTnA');
    expect(safe).toContain('postgresql://postgres:***@host:5432/railway');
  });

  it('oculta el token de una cabecera Authorization', () => {
    const safe = redactSecrets('authorization: Bearer abcdef0123456789ABCDEF');
    expect(safe).not.toContain('abcdef0123456789ABCDEF');
    expect(safe).toMatch(/Bearer \*\*\*/);
  });

  it('oculta varias credenciales en el mismo mensaje', () => {
    const safe = redactSecrets(`${ANTHROPIC} y también ${GROQ}`);
    expect(safe).not.toContain(ANTHROPIC);
    expect(safe).not.toContain(GROQ);
  });

  it('no toca texto que no contiene secretos', () => {
    const message = 'ffprobe no reconoce ningún stream de audio en el archivo';
    expect(redactSecrets(message)).toBe(message);
  });

  it('tolera entradas vacías', () => {
    expect(redactSecrets('')).toBe('');
  });
});

describe('safeErrorMessage', () => {
  it('extrae y redacta el mensaje de un Error', () => {
    const error = new Error(`Headers.append: "${ANTHROPIC}" is an invalid header value.`);
    const safe = safeErrorMessage(error);

    expect(safe).not.toContain(ANTHROPIC);
    expect(safe).toContain('invalid header value');
  });

  it('acepta valores que no son Error', () => {
    expect(safeErrorMessage('fallo simple')).toBe('fallo simple');
    expect(safeErrorMessage(null)).toBe('null');
  });

  it('acota la longitud', () => {
    expect(safeErrorMessage(new Error('x'.repeat(5000)), 100)).toHaveLength(100);
  });
});
