import { describe, expect, it } from 'vitest';
import { computeCutPoints, parseSilenceLog, type SilenceInterval } from '@/lib/silence';

describe('parseSilenceLog', () => {
  it('extrae pares start/end de la salida real de ffmpeg', () => {
    const stderr = [
      'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers',
      '[silencedetect @ 0x55d1c0] silence_start: 12.3456',
      '[silencedetect @ 0x55d1c0] silence_end: 13.9012 | silence_duration: 1.5556',
      '[silencedetect @ 0x55d1c0] silence_start: 598.02',
      '[silencedetect @ 0x55d1c0] silence_end: 599.44 | silence_duration: 1.42',
      'size=N/A time=00:20:00.00 bitrate=N/A speed=  50x',
    ].join('\n');

    expect(parseSilenceLog(stderr)).toEqual<SilenceInterval[]>([
      { start: 12.3456, end: 13.9012 },
      { start: 598.02, end: 599.44 },
    ]);
  });

  it('descarta un silencio abierto sin silence_end', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 10',
      '[silencedetect @ 0x1] silence_end: 12 | silence_duration: 2',
      '[silencedetect @ 0x1] silence_start: 900',
    ].join('\n');

    expect(parseSilenceLog(stderr)).toEqual([{ start: 10, end: 12 }]);
  });

  it('ignora un silence_end sin start previo y los negativos', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_end: 5 | silence_duration: 1',
      '[silencedetect @ 0x1] silence_start: 20',
      '[silencedetect @ 0x1] silence_end: 19 | silence_duration: -1',
    ].join('\n');

    expect(parseSilenceLog(stderr)).toEqual([]);
  });

  it('devuelve lista vacía cuando no hay silencios', () => {
    expect(parseSilenceLog('nada relevante aquí\notra línea')).toEqual([]);
  });
});

describe('computeCutPoints', () => {
  const base = { targetSec: 600, windowSec: 30, overlapSec: 1.5 } as const;

  it('devuelve un único segmento si el audio no llega al objetivo', () => {
    const segments = computeCutPoints({ ...base, durationSec: 420, silences: [] });
    expect(segments).toEqual([{ idx: 0, start: 0, end: 420, hasOverlap: false }]);
  });

  it('corta en el punto medio del silencio más cercano al objetivo', () => {
    // Dos candidatos en la ventana [570, 630]: 580 y 604. Gana 604.
    const silences: SilenceInterval[] = [
      { start: 578, end: 582 },
      { start: 603, end: 605 },
    ];
    const segments = computeCutPoints({ ...base, durationSec: 1000, silences });

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ idx: 0, start: 0, end: 604, hasOverlap: false });
    expect(segments[1]).toEqual({ idx: 1, start: 604, end: 1000, hasOverlap: false });
  });

  it('ignora silencios fuera de la ventana de ±30 s', () => {
    // 500 y 700 quedan fuera de [570, 630]: corte exacto + solape.
    const silences: SilenceInterval[] = [
      { start: 499, end: 501 },
      { start: 699, end: 701 },
    ];
    const segments = computeCutPoints({ ...base, durationSec: 1300, silences });

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ idx: 0, start: 0, end: 600, hasOverlap: false });
    expect(segments[1]).toEqual({ idx: 1, start: 598.5, end: 1300, hasOverlap: true });
  });

  it('marca hasOverlap sólo en el fragmento que arranca antes', () => {
    const segments = computeCutPoints({ ...base, durationSec: 1900, silences: [] });

    expect(segments.map((s) => s.hasOverlap)).toEqual([false, true, true]);
    expect(segments[1]?.start).toBeCloseTo(598.5, 6);
    expect(segments[2]?.start).toBeCloseTo(1197, 6);
  });

  it('absorbe una cola corta en el último fragmento', () => {
    // 700 s con objetivo 600: quedarían 100 s (< 150 = target/4 + target).
    const segments = computeCutPoints({ ...base, durationSec: 700, silences: [] });
    expect(segments).toEqual([{ idx: 0, start: 0, end: 700, hasOverlap: false }]);
  });

  it('cubre el audio completo sin huecos ni solapes no marcados', () => {
    const silences: SilenceInterval[] = Array.from({ length: 20 }, (_, i) => ({
      start: 590 + i * 601,
      end: 592 + i * 601,
    }));
    const segments = computeCutPoints({ ...base, durationSec: 7200, silences });

    expect(segments[0]?.start).toBe(0);
    expect(segments[segments.length - 1]?.end).toBe(7200);

    for (let i = 1; i < segments.length; i += 1) {
      const prev = segments[i - 1];
      const current = segments[i];
      expect(prev).toBeDefined();
      expect(current).toBeDefined();
      if (!prev || !current) continue;
      // Sin huecos: cada fragmento arranca en el fin del anterior o antes.
      expect(current.start).toBeLessThanOrEqual(prev.end + 1e-9);
      // Y si arranca antes, está marcado como solape.
      if (current.start < prev.end - 1e-9) {
        expect(current.hasOverlap).toBe(true);
      }
      expect(current.end).toBeGreaterThan(current.start);
    }
  });

  it('los índices son consecutivos desde 0', () => {
    const segments = computeCutPoints({ ...base, durationSec: 5000, silences: [] });
    expect(segments.map((s) => s.idx)).toEqual(segments.map((_, i) => i));
  });

  it('devuelve lista vacía ante una duración inválida', () => {
    expect(computeCutPoints({ ...base, durationSec: 0, silences: [] })).toEqual([]);
    expect(computeCutPoints({ ...base, durationSec: Number.NaN, silences: [] })).toEqual([]);
  });
});
