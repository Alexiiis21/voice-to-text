import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { llmCostUsd, type LlmUsage } from './cost';

/**
 * Cliente de Anthropic. Se construye perezosamente: la app tiene que poder
 * arrancar (y transcribir en CRUDO) sin ANTHROPIC_API_KEY.
 */
let client: Anthropic | null = null;

export function anthropicConfigured(): boolean {
  return Boolean(env.anthropicApiKey);
}

function getClient(): Anthropic {
  if (!env.anthropicApiKey) {
    throw new Error('Falta ANTHROPIC_API_KEY');
  }
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 3 });
  return client;
}

export interface LlmCall {
  text: string;
  usage: LlmUsage;
  costUsd: number;
  model: string;
}

const CLEANUP_SYSTEM =
  'Eres un editor de transcripciones en español. Recibes un fragmento de ' +
  'texto crudo producido por un sistema de reconocimiento de voz. Devuelves ' +
  'EXCLUSIVAMENTE ese mismo texto editado: divídelo en párrafos coherentes, ' +
  'corrige puntuación y mayúsculas, arregla errores evidentes de ' +
  'reconocimiento, y elimina muletillas, repeticiones y arranques en falso ' +
  'cuando no aporten nada. No resumas, no parafrasees, no traduzcas, no ' +
  'añadas encabezados ni comentarios tuyos. Conserva el significado y el ' +
  'registro del hablante. El fragmento puede empezar o acabar a mitad de ' +
  'una frase: déjalo así, no lo completes.';

const SUMMARY_SYSTEM =
  'Resumes transcripciones en español. Devuelves, en este orden y sin ' +
  'ningún preámbulo: (1) un párrafo de 3-4 frases con la idea central; ' +
  '(2) una lista de los puntos tratados, en el orden en que aparecen; ' +
  '(3) si los hay, una lista de decisiones tomadas y tareas pendientes con ' +
  'su responsable cuando se mencione. Omite por completo cualquier sección ' +
  'que no aplique al contenido, sin anunciarlo. No inventes nada que no ' +
  'esté en el texto. Escribe en el mismo registro del original.';

const PARTIAL_SUMMARY_SYSTEM =
  'Resumes fragmentos de una transcripción larga en español. Devuelves un ' +
  'resumen denso y factual del fragmento recibido, en prosa, conservando ' +
  'nombres propios, cifras, decisiones y tareas mencionadas. No añadas ' +
  'preámbulos ni encabezados. Este resumen se combinará después con otros, ' +
  'así que no intentes cerrar ni concluir nada.';

function firstText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === 'text') return block.text.trim();
  }
  return '';
}

function toCall(message: Anthropic.Message, model: string): LlmCall {
  const usage: LlmUsage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
  return { text: firstText(message), usage, costUsd: llmCostUsd(model, usage), model };
}

/**
 * EDITADO — `claude-haiku-4-5`, aplicado por fragmento.
 * Peticiones pequeñas, resultado progresivo, paralelizable.
 */
export async function cleanupChunk(rawText: string, signal?: AbortSignal): Promise<LlmCall> {
  const model = env.cleanupModel;
  const response = await getClient().messages.create(
    {
      model,
      max_tokens: 8000,
      system: CLEANUP_SYSTEM,
      messages: [{ role: 'user', content: rawText }],
    },
    { signal },
  );

  const call = toCall(response, model);
  if (response.stop_reason === 'max_tokens') {
    // No truncamos en silencio: se registra y el fragmento crudo sigue intacto.
    throw new Error('La edición del fragmento agotó max_tokens; se conserva el texto crudo');
  }
  if (call.text === '') {
    throw new Error('La edición devolvió texto vacío');
  }
  return call;
}

/**
 * RESUMEN — `claude-sonnet-5`, una sola llamada sobre el texto editado.
 *
 * Nota (§13): el prompt original propone `max_tokens: 4000`. En Claude Sonnet 5
 * el pensamiento adaptativo está activo por defecto y consume el mismo
 * presupuesto de `max_tokens`, así que 4000 corre riesgo de truncar el resumen.
 * Se desactiva el pensamiento explícitamente y se deja margen configurable.
 */
export async function summarize(fullText: string, signal?: AbortSignal): Promise<LlmCall> {
  const model = env.summaryModel;
  const response = await getClient().messages.create(
    {
      model,
      max_tokens: 8000,
      thinking: { type: 'disabled' },
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: fullText }],
    },
    { signal },
  );

  const call = toCall(response, model);
  if (call.text === '') {
    throw new Error('El resumen devolvió texto vacío');
  }
  return call;
}

/** Etapa "map" del resumen en dos etapas para audios muy largos. */
export async function summarizePartial(text: string, signal?: AbortSignal): Promise<LlmCall> {
  const model = env.summaryModel;
  const response = await getClient().messages.create(
    {
      model,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      system: PARTIAL_SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: text }],
    },
    { signal },
  );
  return toCall(response, model);
}
