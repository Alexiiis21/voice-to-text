/** Constantes seguras para el cliente. Nada de secretos aquí. */

export const ALLOWED_EXTENSIONS_LABEL = '.ogg .opus .mp3 .m4a .wav .webm .aac .flac';

export const OUTPUT_TABS = [
  { value: 'raw', label: 'CRUDO' },
  { value: 'clean', label: 'EDITADO' },
  { value: 'summary', label: 'RESUMEN' },
] as const;
