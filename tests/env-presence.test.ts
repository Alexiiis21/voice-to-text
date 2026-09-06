import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envPresence, missingImportant, missingRequired } from '../src/lib/env-presence';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  for (const name of ['DATABASE_URL', 'BLOB_READ_WRITE_TOKEN', 'GROQ_API_KEY', 'DATA_DIR']) {
    delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('env-presence', () => {
  it('no lanza nunca, ni con el entorno completamente vacío', () => {
    // Es la propiedad que justifica que este módulo exista: /api/health tiene
    // que poder contestar precisamente cuando falta la configuración.
    expect(() => envPresence()).not.toThrow();
    expect(() => missingRequired()).not.toThrow();
  });

  it('señala DATABASE_URL cuando no está', () => {
    expect(missingRequired()).toContain('DATABASE_URL');
  });

  it('no la señala cuando está', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d';
    expect(missingRequired()).toEqual([]);
  });

  it('trata una variable vacía o con espacios como ausente', () => {
    // Un campo borrado en el panel de Vercel puede quedar como cadena vacía en
    // vez de desaparecer; contarlo como presente daría un diagnóstico falso.
    process.env.DATABASE_URL = '   ';
    expect(missingRequired()).toContain('DATABASE_URL');
    expect(envPresence().DATABASE_URL).toBe(false);
  });

  it('distingue lo obligatorio de lo importante', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d';
    expect(missingRequired()).toEqual([]);
    expect(missingImportant()).toContain('BLOB_READ_WRITE_TOKEN');
  });

  it('informa de todas las variables seguidas, como booleanos', () => {
    process.env.GROQ_API_KEY = 'gsk_secreto';
    const presencia = envPresence();

    expect(presencia.GROQ_API_KEY).toBe(true);
    expect(presencia.OPENAI_API_KEY).toBe(false);
    // Jamás el valor (§5).
    expect(Object.values(presencia).every((v) => typeof v === 'boolean')).toBe(true);
    expect(JSON.stringify(presencia)).not.toContain('gsk_secreto');
  });
});
