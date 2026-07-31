export interface TranscribeResult {
  text: string;
}

export interface SttAdapter {
  /** Identificador guardado en `transcriptions.stt_provider`. */
  readonly name: 'groq' | 'openai';
  /** Modelo Whisper concreto. */
  readonly model: string;
  /** Tamaño máximo por archivo aceptado por el proveedor, en bytes. */
  readonly maxFileBytes: number;
  /** Tarifa estimada por hora de audio, en USD. */
  readonly pricePerAudioHourUsd: number;
  /** Transcribe un fragmento ya normalizado. */
  transcribe(filePath: string, signal?: AbortSignal): Promise<TranscribeResult>;
}

export class SttError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** true si reintentar tiene sentido (429, 5xx, red). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SttError';
  }
}
