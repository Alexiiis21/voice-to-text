import { env } from '../env';
import { PRICING } from '../config';
import { transcribeViaHttp } from './whisper-http';
import type { SttAdapter, SttProviderName, TranscribeResult } from './types';

export { SttError, SttQuotaExhausted } from './types';
export type { SttAdapter, SttProviderName, TranscribeResult } from './types';
export * from './retry';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/** 25 MB es el límite de archivo de ambos proveedores. */
const PROVIDER_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Diez minutos: un fragmento de 10 min a 32 kbps sube en segundos, pero las
 *  colas del proveedor pueden alargarse. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function buildAdapter(name: SttProviderName, apiKey: string): SttAdapter {
  const config =
    name === 'groq'
      ? {
          label: 'Groq',
          endpoint: GROQ_ENDPOINT,
          model: 'whisper-large-v3-turbo',
          price: PRICING.stt.groqPerAudioHour,
        }
      : {
          label: 'OpenAI',
          endpoint: OPENAI_ENDPOINT,
          model: 'whisper-1',
          price: PRICING.stt.openaiPerAudioHour,
        };

  return {
    name,
    label: config.label,
    model: config.model,
    maxFileBytes: PROVIDER_MAX_FILE_BYTES,
    pricePerAudioHourUsd: config.price,
    transcribe(filePath: string, signal?: AbortSignal): Promise<TranscribeResult> {
      return transcribeViaHttp(
        filePath,
        {
          provider: name,
          endpoint: config.endpoint,
          apiKey,
          model: config.model,
          language: 'es',
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
        signal,
      );
    },
  };
}

function apiKeyFor(name: SttProviderName): string | null {
  return name === 'groq' ? env.groqApiKey : env.openaiApiKey;
}

export interface ProviderInfo {
  name: SttProviderName;
  label: string;
  model: string;
  /** true si su clave de API está definida. */
  available: boolean;
  /** Tarifa estimada por hora de audio, para mostrarla en la interfaz. */
  pricePerAudioHourUsd: number;
}

/**
 * Proveedores declarados en `STT_PROVIDER`, en orden, con un booleano de
 * disponibilidad. **Nunca expone las claves**: sólo si están presentes.
 * Es lo que consume el selector del panel de entrada.
 */
export function listProviders(): ProviderInfo[] {
  const declared = env.sttProviders;
  const all: SttProviderName[] = ['groq', 'openai'];
  // Los declarados primero, en su orden; después el resto, por si el usuario
  // define una clave pero olvida añadir el proveedor a STT_PROVIDER.
  const ordered = [...declared, ...all.filter((name) => !declared.includes(name))];

  return ordered.map((name) => {
    const adapter = buildAdapter(name, 'placeholder');
    return {
      name,
      label: adapter.label,
      model: adapter.model,
      available: apiKeyFor(name) !== null,
      pricePerAudioHourUsd: adapter.pricePerAudioHourUsd,
    };
  });
}

/** Proveedores realmente utilizables (con clave), en el orden de `STT_PROVIDER`. */
export function availableProviders(): SttProviderName[] {
  return listProviders()
    .filter((info) => info.available)
    .map((info) => info.name);
}

/**
 * Cadena de proveedores para un trabajo concreto.
 *
 * `preferred` (el que eligió el usuario en la interfaz) va primero si está
 * disponible; detrás van los demás como desbordamiento. Así el free tier de
 * Groq es el camino por defecto y OpenAI sólo se paga cuando Groq se queda sin
 * cuota a mitad de un audio largo.
 */
export function resolveSttChain(preferred?: string | null): SttAdapter[] {
  const usable = availableProviders();

  if (usable.length === 0) {
    const declared = env.sttProviders.join(', ');
    throw new Error(
      `Ningún proveedor STT tiene clave configurada (declarados: ${declared}). ` +
        'Define GROQ_API_KEY y/o OPENAI_API_KEY.',
    );
  }

  const head =
    preferred === 'groq' || preferred === 'openai'
      ? usable.filter((name) => name === preferred)
      : [];

  const ordered = [...head, ...usable.filter((name) => !head.includes(name))];

  return ordered.map((name) => {
    const key = apiKeyFor(name);
    if (key === null) throw new Error(`Falta la clave de ${name}`);
    return buildAdapter(name, key);
  });
}

/** Proveedor por defecto: el primero disponible de `STT_PROVIDER`. */
export function defaultProviderName(): SttProviderName {
  return availableProviders()[0] ?? env.sttProviders[0] ?? 'groq';
}

/** Valida el proveedor pedido desde el cliente. Devuelve null si no vale. */
export function normalizeRequestedProvider(value: string | null | undefined): SttProviderName | null {
  if (value === 'groq' || value === 'openai') {
    return availableProviders().includes(value) ? value : null;
  }
  return null;
}
