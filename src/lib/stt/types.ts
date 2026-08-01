import type { SttFailureKind } from './retry';

export interface TranscribeResult {
  text: string;
}

export type SttProviderName = 'groq' | 'openai';

export interface SttAdapter {
  /** Identificador guardado en `transcriptions.stt_provider` / `chunks.stt_provider`. */
  readonly name: SttProviderName;
  /** Etiqueta corta para la interfaz. */
  readonly label: string;
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
    /** Cómo debe reaccionar el worker. */
    readonly kind: SttFailureKind,
    /** Segundos indicados por el proveedor antes de reintentar, si los dio. */
    readonly retryAfterSec: number | null = null,
    /** Proveedor que produjo el error. */
    readonly provider: SttProviderName | null = null,
  ) {
    super(message);
    this.name = 'SttError';
  }

  /** Merece la pena reintentar con el mismo proveedor tras una pausa breve. */
  get retryable(): boolean {
    return this.kind === 'transient';
  }
}

/** Todos los proveedores de la cadena están sin cuota. */
export class SttQuotaExhausted extends Error {
  constructor(
    message: string,
    /** Segundos hasta que el proveedor más cercano vuelva a estar disponible. */
    readonly retryAfterSec: number | null,
  ) {
    super(message);
    this.name = 'SttQuotaExhausted';
  }
}
