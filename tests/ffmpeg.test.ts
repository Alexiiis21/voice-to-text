/**
 * Test de integración del binario de ffmpeg.
 *
 * Ejecuta ffmpeg de verdad, no un doble. Cubre justo lo que más se puede
 * romper al desplegar: que `@ffmpeg-installer/ffmpeg` resuelva un binario
 * ejecutable para esta plataforma, y que `probeAudio` siga rechazando un
 * fichero que no es audio ahora que esa comprobación la hace ffmpeg en vez de
 * ffprobe.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegPath } from '../src/lib/ffmpeg-bin';
import { normalizeAudio, probeAudio } from '../src/lib/ffmpeg';

let dir: string;
let wav: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriptor-test-'));
  wav = path.join(dir, 'tono.wav');

  // 7 s de tono estéreo a 44,1 kHz, generados por el propio ffmpeg.
  execFileSync(ffmpegPath(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=7:sample_rate=44100',
    '-ac',
    '2',
    wav,
  ]);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ffmpeg', () => {
  it('resuelve un binario ejecutable para esta plataforma', () => {
    const salida = execFileSync(ffmpegPath(), ['-version'], { encoding: 'utf8' });
    expect(salida).toContain('ffmpeg version');
  });

  it('probeAudio devuelve la duración y el formato reales', async () => {
    const probe = await probeAudio(wav);
    expect(probe.durationSec).toBeCloseTo(7, 1);
    expect(probe.sampleRate).toBe(44100);
    expect(probe.channels).toBe(2);
  });

  it('normaliza a mono 16 kHz mp3', async () => {
    const mp3 = path.join(dir, 'tono.norm.mp3');
    await normalizeAudio(wav, mp3);

    const probe = await probeAudio(mp3);
    expect(probe.codec).toBe('mp3');
    expect(probe.sampleRate).toBe(16000);
    expect(probe.channels).toBe(1);
    // El mp3 sale unas centésimas más largo que el original: el encoder añade
    // padding al principio y al final. Es esperado y no afecta al troceado.
    expect(probe.durationSec).toBeGreaterThanOrEqual(7);
    expect(probe.durationSec).toBeLessThan(7.3);
    // El recorte de peso es el motivo de normalizar: 32 kbps mono contra
    // 1.411 kbps estéreo.
    expect(fs.statSync(mp3).size).toBeLessThan(fs.statSync(wav).size / 10);
  });

  it('rechaza un fichero que no es audio aunque tenga extensión de audio', async () => {
    const falso = path.join(dir, 'falso.mp3');
    fs.writeFileSync(falso, 'esto no es audio, ni de lejos');
    await expect(probeAudio(falso)).rejects.toThrow(/no contiene ningún stream de audio/);
  });
});
