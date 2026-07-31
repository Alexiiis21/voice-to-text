import { env } from '../env';
import { PRICING } from '../config';
import { transcribeViaHttp } from './whisper-http';
import type { SttAdapter, TranscribeResult } from './types';

export { SttError } from './types';
export type { SttAdapter, TranscribeResult } from './types';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/** 25 MB es el límite de archivo de ambos proveedores. */
const PROVIDER_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Diez minutos: un fragmento de 10 min a 32 kbps sube en segundos, pero las
 *  colas del proveedor pueden alargarse. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function groqAdapter(apiKey: string): SttAdapter {
  return {
    name: 'groq',
    model: 'whisper-large-v3-turbo',
    maxFileBytes: PROVIDER_MAX_FILE_BYTES,
    pricePerAudioHourUsd: PRICING.stt.groqPerAudioHour,
    transcribe(filePath: string, signal?: AbortSignal): Promise<TranscribeResult> {
      return transcribeViaHttp(
        filePath,
        {
          endpoint: GROQ_ENDPOINT,
          apiKey,
          model: 'whisper-large-v3-turbo',
          language: 'es',
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
        signal,
      );
    },
  };
}

function openaiAdapter(apiKey: string): SttAdapter {
  return {
    name: 'openai',
    model: 'whisper-1',
    maxFileBytes: PROVIDER_MAX_FILE_BYTES,
    pricePerAudioHourUsd: PRICING.stt.openaiPerAudioHour,
    transcribe(filePath: string, signal?: AbortSignal): Promise<TranscribeResult> {
      return transcribeViaHttp(
        filePath,
        {
          endpoint: OPENAI_ENDPOINT,
          apiKey,
          model: 'whisper-1',
          language: 'es',
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
        signal,
      );
    },
  };
}

/**
 * Adaptador intercambiable de speech-to-text. Por defecto Groq
 * (whisper-large-v3-turbo); alternativa OpenAI (whisper-1).
 */
export function getSttAdapter(): SttAdapter {
  if (env.sttProvider === 'openai') {
    if (!env.openaiApiKey) {
      throw new Error('STT_PROVIDER=openai pero falta OPENAI_API_KEY');
    }
    return openaiAdapter(env.openaiApiKey);
  }

  if (!env.groqApiKey) {
    throw new Error('STT_PROVIDER=groq pero falta GROQ_API_KEY');
  }
  return groqAdapter(env.groqApiKey);
}

/** Nombre del proveedor activo sin construir el adaptador (no exige la clave). */
export function activeSttProviderName(): 'groq' | 'openai' {
  return env.sttProvider;
}
