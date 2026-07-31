import fs from 'node:fs';
import path from 'node:path';
import { SttError, type TranscribeResult } from './types';

export interface WhisperHttpOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  /** Código de idioma ISO-639-1. La app es de transcripción en español. */
  language: string;
  timeoutMs: number;
}

interface WhisperResponse {
  text?: string;
  error?: { message?: string };
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
    throw new SttError(`Error de red hablando con el proveedor STT: ${message}`, null, !aborted);
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
    const retryable = response.status === 429 || response.status >= 500;
    throw new SttError(`STT ${response.status}: ${detail}`, response.status, retryable);
  }

  let parsed: WhisperResponse;
  try {
    parsed = JSON.parse(bodyText) as WhisperResponse;
  } catch {
    throw new SttError('El proveedor STT devolvió una respuesta ilegible', response.status, true);
  }

  if (typeof parsed.text !== 'string') {
    throw new SttError('La respuesta del proveedor STT no incluye texto', response.status, true);
  }

  return { text: parsed.text.trim() };
}
