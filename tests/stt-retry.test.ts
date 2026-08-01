import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  decideDeferral,
  parseHumanDuration,
  parseRetryAfterSeconds,
} from '@/lib/stt/retry';

describe('parseRetryAfterSeconds', () => {
  it('acepta la forma de delta en segundos', () => {
    expect(parseRetryAfterSeconds('120')).toBe(120);
    expect(parseRetryAfterSeconds('  0 ')).toBe(0);
  });

  it('acepta la forma de fecha HTTP y la convierte a segundos restantes', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    expect(parseRetryAfterSeconds('Fri, 31 Jul 2026 10:05:00 GMT', now)).toBe(300);
  });

  it('devuelve 0 si la fecha ya pasó, nunca un negativo', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    expect(parseRetryAfterSeconds('Fri, 31 Jul 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('devuelve null cuando falta o es ilegible', () => {
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds(undefined)).toBeNull();
    expect(parseRetryAfterSeconds('')).toBeNull();
    expect(parseRetryAfterSeconds('pronto')).toBeNull();
  });
});

describe('parseHumanDuration', () => {
  it('lee los formatos que Groq mete en el mensaje de error', () => {
    expect(parseHumanDuration('7.66s')).toBe(8);
    expect(parseHumanDuration('2m59.56s')).toBe(180);
    expect(parseHumanDuration('1h13m24s')).toBe(4404);
    expect(parseHumanDuration('45m')).toBe(2700);
  });

  it('devuelve null cuando no hay duración', () => {
    expect(parseHumanDuration(null)).toBeNull();
    expect(parseHumanDuration('')).toBeNull();
    expect(parseHumanDuration('enseguida')).toBeNull();
  });
});

describe('backoffDelayMs', () => {
  it('crece exponencialmente desde la base', () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
  });

  it('respeta el tope', () => {
    expect(backoffDelayMs(10, 1000, 30_000)).toBe(30_000);
  });
});

describe('decideDeferral', () => {
  const threshold = 90;
  const fallback = 900;
  const max = 3600;

  it('aparca el trabajo cuando la espera supera el umbral', () => {
    // Caso real: cuota horaria de Groq agotada, quedan 40 minutos.
    expect(decideDeferral(2400, threshold, fallback, max)).toEqual({
      defer: true,
      waitSec: 2400,
    });
  });

  it('no aparca cuando la espera es corta', () => {
    expect(decideDeferral(15, threshold, fallback, max)).toEqual({
      defer: false,
      waitSec: 15,
    });
  });

  it('usa el valor por defecto si el proveedor no dice cuánto falta', () => {
    expect(decideDeferral(null, threshold, fallback, max)).toEqual({
      defer: true,
      waitSec: 900,
    });
    expect(decideDeferral(0, threshold, fallback, max)).toEqual({
      defer: true,
      waitSec: 900,
    });
  });

  it('nunca aparca más allá del tope', () => {
    expect(decideDeferral(99_999, threshold, fallback, max)).toEqual({
      defer: true,
      waitSec: 3600,
    });
  });

  it('el umbral es exclusivo: justo en el límite no aparca', () => {
    expect(decideDeferral(90, threshold, fallback, max).defer).toBe(false);
    expect(decideDeferral(91, threshold, fallback, max).defer).toBe(true);
  });
});
