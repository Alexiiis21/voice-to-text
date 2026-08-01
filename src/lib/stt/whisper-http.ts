import fs from 'node:fs';
import path from 'node:path';
import { parseHumanDuration, parseRetryAfterSeconds } from './retry';
import { SttError, type SttProviderName, type TranscribeResult } from './types';

export interface WhisperHttpOptions {
  provider: SttProviderName;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Código de idioma ISO-639-1. La app es de transcripción en español. */
  language: string;
  timeoutMs: number;
}

interface WhisperResponse {
  text?: string;
  error?: { message?: string; code?: string; type?: string };
}

/**
 * Cliente común para las APIs compatibles con OpenAI Audio Transcriptions
 * (Groq y OpenAI comparten la misma forma de petición y respuesta).
 *
 * El fichero se envía con `fs.openAsBlob`, que produce un Blob respaldado por
 * el fichero en disco: no se carga el fragmento entero en memoria.
 */
export async function transcribeViaHttp(
  filePath: string,
  options: WhisperHttpOptions,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const blob = await fs.openAsBlob(filePath, { type: 'audio/mpeg' });

  const form = new FormData();
  form.append('file', blob, path.basename(filePath));
  form.append('model', options.model);
  form.append('language', options.language);
  form.append('response_format', 'json');
  form.append('temperature', '0');

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(options.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: form,
      signal: combined,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Aborto explícito del apagado limpio: no reintentar.
    const aborted = signal?.aborted === true;
    throw new SttError(
      `Error de red hablando con ${options.provider}: ${message}`,
      null,
      aborted ? 'fatal' : 'transient',
      null,
      options.provider,
    );
  }

  const bodyText = await response.text();

  if (!response.ok) {
    let detail = bodyText.slice(0, 500);
    try {
      const parsed = JSON.parse(bodyText) as WhisperResponse;
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Se queda el texto crudo recortado.
    }

    if (response.status === 429) {
      // Groq indica el tiempo restante en `retry-after`, y cuando no está,
      // dentro del mensaje ("Please try again in 2m59.56s").
      const retryAfter =
        parseRetryAfterSeconds(response.headers.get('retry-after')) ??
        parseHumanDuration(/try again in ([\dhms.]+)/i.exec(detail)?.[1]);

      throw new SttError(
        `Cuota de ${options.provider} agotada: ${detail}`,
        429,
        'quota',
        retryAfter,
        options.provider,
      );
    }

    // 5xx y 408 se reintentan; el resto (401, 400, 413…) no se arregla solo.
    const kind = response.status >= 500 || response.status === 408 ? 'transient' : 'fatal';
    throw new SttError(
      `${options.provider} respondió ${response.status}: ${detail}`,
      response.status,
      kind,
      parseRetryAfterSeconds(response.headers.get('retry-after')),
      options.provider,
    );
  }

  let parsed: WhisperResponse;
  try {
    parsed = JSON.parse(bodyText) as WhisperResponse;
  } catch {
    throw new SttError(
      `${options.provider} devolvió una respuesta ilegible`,
      response.status,
      'transient',
      null,
      options.provider,
    );
  }

  if (typeof parsed.text !== 'string') {
    throw new SttError(
      `La respuesta de ${options.provider} no incluye texto`,
      response.status,
      'transient',
      null,
      options.provider,
    );
  }

  return { text: parsed.text.trim() };
}
