import { describe, expect, it } from 'vitest';
import { parseProbeOutput, parseProgressDuration } from '../src/lib/probe-parse';

/** Cabecera real de ffmpeg para un m4a estéreo. */
const M4A = `ffmpeg version 4.1 Copyright (c) 2000-2018 the FFmpeg developers
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/a.m4a':
  Metadata:
    major_brand     : M4A
  Duration: 00:03:21.55, start: 0.000000, bitrate: 128 kb/s
    Stream #0:0(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified
`;

/** Nota de voz de WhatsApp: ogg/opus, mono, y sin duración en la cabecera. */
const OGG_SIN_DURACION = `Input #0, ogg, from '/tmp/b.ogg':
  Duration: N/A, start: 0.000000, bitrate: N/A
    Stream #0:0: Audio: opus, 48000 Hz, mono, fltp
At least one output file must be specified
`;

/** Un fichero que no es audio: ffmpeg no encuentra nada que decodificar. */
const NO_ES_AUDIO = `Input #0, png_pipe, from '/tmp/c.mp3':
  Duration: N/A, bitrate: N/A
    Stream #0:0: Video: png, rgba(pc), 512x512, 25 tbr, 25 tbn, 25 tbc
At least one output file must be specified
`;

const BASURA = `/tmp/d.mp3: Invalid data found when processing input
`;

describe('parseProbeOutput', () => {
  it('lee duración, códec, frecuencia y canales de un m4a estéreo', () => {
    const parsed = parseProbeOutput(M4A);
    expect(parsed).not.toBeNull();
    expect(parsed?.durationSec).toBeCloseTo(201.55, 2);
    expect(parsed?.codec).toBe('aac');
    expect(parsed?.sampleRate).toBe(44100);
    expect(parsed?.channels).toBe(2);
  });

  it('reconoce mono y acepta que no haya duración', () => {
    const parsed = parseProbeOutput(OGG_SIN_DURACION);
    expect(parsed).not.toBeNull();
    expect(parsed?.durationSec).toBeNull();
    expect(parsed?.codec).toBe('opus');
    expect(parsed?.channels).toBe(1);
  });

  it('devuelve null si sólo hay vídeo: es la defensa contra ficheros disfrazados', () => {
    expect(parseProbeOutput(NO_ES_AUDIO)).toBeNull();
  });

  it('devuelve null con una entrada que ffmpeg no pudo abrir', () => {
    expect(parseProbeOutput(BASURA)).toBeNull();
  });

  it('lee recuentos de canales poco comunes', () => {
    const salida = `  Duration: 00:00:10.00, start: 0.000000, bitrate: 512 kb/s
    Stream #0:0: Audio: flac, 48000 Hz, 5.1(side), s32 (24 bit)
`;
    expect(parseProbeOutput(salida)?.channels).toBeNull();
  });

  it('no confunde la duración del contenedor con horas de más', () => {
    const salida = `  Duration: 02:15:00.50, start: 0.000000, bitrate: 32 kb/s
    Stream #0:0: Audio: mp3, 16000 Hz, mono, fltp, 32 kb/s
`;
    expect(parseProbeOutput(salida)?.durationSec).toBeCloseTo(8100.5, 2);
  });
});

describe('parseProgressDuration', () => {
  it('se queda con la última marca de progreso', () => {
    const salida = `size=       0kB time=00:00:10.00 bitrate=N/A speed=  20x
size=       0kB time=00:01:40.24 bitrate=N/A speed=  21x
size=       0kB time=00:02:03.51 bitrate=N/A speed=  21x
`;
    expect(parseProgressDuration(salida)).toBeCloseTo(123.51, 2);
  });

  it('devuelve null si no hubo progreso que leer', () => {
    expect(parseProgressDuration('nada que ver aquí')).toBeNull();
  });

  it('descarta un progreso de cero', () => {
    expect(parseProgressDuration('time=00:00:00.00 bitrate=N/A')).toBeNull();
  });
});
