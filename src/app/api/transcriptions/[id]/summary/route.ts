import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db, sql } from '@/db';
import { chunks, transcriptions } from '@/db/schema';
import { SUMMARY_MAP_REDUCE_WORDS } from '@/lib/config';
import { anthropicConfigured, summarize, summarizePartial } from '@/lib/claude';
import { toCostString } from '@/lib/cost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Params {
  params: Promise<{ id: string }>;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => token.length > 0).length;
}

/** Agrupa fragmentos en bloques de ~`maxWords` palabras para la etapa "map". */
function groupForMapReduce(parts: readonly string[], maxWords: number): string[] {
  const groups: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const part of parts) {
    const words = countWords(part);
    if (currentWords > 0 && currentWords + words > maxWords) {
      groups.push(current.join('\n\n'));
      current = [];
      currentWords = 0;
    }
    current.push(part);
    currentWords += words;
  }

  if (current.length > 0) groups.push(current.join('\n\n'));
  return groups;
}

/**
 * Genera el resumen si no existe; devuelve el cacheado si ya está.
 *
 * El resumen se paga bajo demanda: no tiene sentido gastarlo en transcripciones
 * que nadie va a resumir (§4).
 */
export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Identificador inválido' }, { status: 400 });
  }

  const [row] = await db.select().from(transcriptions).where(eq(transcriptions.id, id)).limit(1);
  if (!row) {
    return NextResponse.json({ error: 'Transcripción no encontrada' }, { status: 404 });
  }

  if (row.summaryText) {
    return NextResponse.json({ summaryText: row.summaryText, cached: true });
  }

  if (!anthropicConfigured()) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY no está configurada: el resumen no está disponible' },
      { status: 503 },
    );
  }

  const source = row.cleanText ?? row.rawText;
  if (!source || source.trim() === '') {
    return NextResponse.json(
      { error: 'Todavía no hay texto que resumir' },
      { status: 409 },
    );
  }

  const words = countWords(source);
  let summaryText: string;
  let cost = 0;

  try {
    if (words <= SUMMARY_MAP_REDUCE_WORDS) {
      // Una sola llamada sobre el texto completo.
      const call = await summarize(source);
      summaryText = call.text;
      cost += call.costUsd;
    } else {
      // Map-reduce: resumir cada bloque y combinar los resúmenes parciales.
      const chunkRows = await db
        .select()
        .from(chunks)
        .where(eq(chunks.transcriptionId, id))
        .orderBy(asc(chunks.idx));

      const parts = chunkRows
        .map((chunk) => chunk.cleanText ?? chunk.rawText)
        .filter((text): text is string => Boolean(text && text.trim() !== ''));

      const groups =
        parts.length > 0
          ? groupForMapReduce(parts, Math.floor(SUMMARY_MAP_REDUCE_WORDS / 4))
          : groupForMapReduce([source], Math.floor(SUMMARY_MAP_REDUCE_WORDS / 4));

      const partials: string[] = [];
      for (const group of groups) {
        const call = await summarizePartial(group);
        cost += call.costUsd;
        if (call.text !== '') partials.push(call.text);
      }

      if (partials.length === 0) {
        throw new Error('Ninguna etapa parcial del resumen devolvió texto');
      }

      const combined = await summarize(
        `A continuación hay ${partials.length} resúmenes parciales consecutivos de una misma ` +
          `transcripción. Combínalos en un único resumen siguiendo tus instrucciones.\n\n` +
          partials.map((part, index) => `--- Parte ${index + 1} ---\n${part}`).join('\n\n'),
      );
      cost += combined.costUsd;
      summaryText = combined.text;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api] Resumen de ${id} falló:`, message);
    return NextResponse.json({ error: `No se pudo generar el resumen: ${message}` }, { status: 502 });
  }

  await db.update(transcriptions).set({ summaryText }).where(eq(transcriptions.id, id));
  if (cost > 0) {
    await sql`
      UPDATE transcriptions
      SET cost_usd = LEAST(cost_usd + ${toCostString(cost)}::numeric, 99999.99999)
      WHERE id = ${id}
    `;
  }

  return NextResponse.json({ summaryText, cached: false, costUsd: cost });
}
