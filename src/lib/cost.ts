import { PRICING } from './config';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Coste estimado de N segundos de audio con el proveedor STT activo. */
export function sttCostUsd(seconds: number, pricePerAudioHourUsd: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return (seconds / 3600) * pricePerAudioHourUsd;
}

/** Coste estimado de una llamada a Claude. */
export function llmCostUsd(model: string, usage: LlmUsage): number {
  const rate = PRICING.llm[model] ?? PRICING.llmFallback;
  const input = (usage.inputTokens / 1_000_000) * rate.inputPerMTok;
  const output = (usage.outputTokens / 1_000_000) * rate.outputPerMTok;
  return input + output;
}

/** Formatea a la precisión de la columna numeric(10,5). */
export function toCostString(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0.00000';
  return Math.min(value, 99_999.99999).toFixed(5);
}

export function parseCost(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
