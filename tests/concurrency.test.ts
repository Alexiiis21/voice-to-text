import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/lib/concurrency';

function defer(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('devuelve los resultados en el orden de entrada, no en el de finalización', async () => {
    // El primero es el más lento a propósito: si se devolviera por orden de
    // llegada, saldría el último. Es exactamente el fallo que barajaría las
    // partes de un resumen.
    const retardos = [40, 5, 30, 1, 20];

    const salida = await mapWithConcurrency(retardos, 3, async (ms, index) => {
      await defer(ms);
      return index;
    });

    expect(salida).toEqual([0, 1, 2, 3, 4]);
  });

  it('nunca supera el límite de trabajos en vuelo', async () => {
    let enVuelo = 0;
    let pico = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (value) => {
      enVuelo += 1;
      pico = Math.max(pico, enVuelo);
      await defer(2);
      enVuelo -= 1;
      return value;
    });

    expect(pico).toBeLessThanOrEqual(4);
    expect(pico).toBeGreaterThan(1);
  });

  it('procesa cada elemento exactamente una vez', async () => {
    const vistos: number[] = [];
    await mapWithConcurrency([10, 20, 30, 40, 50], 2, async (value) => {
      vistos.push(value);
      return value;
    });
    expect(vistos.toSorted((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it('acepta una lista vacía', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });

  it('trata un límite mayor que la lista sin crear runners de más', async () => {
    const salida = await mapWithConcurrency([1, 2], 99, async (value) => value * 2);
    expect(salida).toEqual([2, 4]);
  });

  it('propaga el error de un trabajo', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error('fallo en el segundo');
        return value;
      }),
    ).rejects.toThrow('fallo en el segundo');
  });
});
