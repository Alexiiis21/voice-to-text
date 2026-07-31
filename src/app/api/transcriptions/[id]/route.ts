import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { chunks, transcriptions } from '@/db/schema';
import { removeTranscriptionFiles } from '@/lib/files';
import { readSessionId } from '@/lib/session';
import { toDetail } from '@/lib/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Params {
  params: Promise<{ id: string }>;
}

/** Estado completo + textos disponibles. */
export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Identificador inválido' }, { status: 400 });
  }

  const [row] = await db.select().from(transcriptions).where(eq(transcriptions.id, id)).limit(1);
  if (!row) {
    return NextResponse.json({ error: 'Transcripción no encontrada' }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(chunks)
    .where(eq(chunks.transcriptionId, id))
    .orderBy(asc(chunks.idx));

  return NextResponse.json(toDetail(row, rows));
}

/** Borra registro y ficheros asociados. Filtrado siempre por `session_id`. */
export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Identificador inválido' }, { status: 400 });
  }

  const sessionId = await readSessionId();
  if (!sessionId) {
    return NextResponse.json({ error: 'Sesión no reconocida' }, { status: 403 });
  }

  const [row] = await db.select().from(transcriptions).where(eq(transcriptions.id, id)).limit(1);
  if (!row) {
    return NextResponse.json({ error: 'Transcripción no encontrada' }, { status: 404 });
  }
  if (row.sessionId !== sessionId) {
    return NextResponse.json(
      { error: 'Esta transcripción pertenece a otra sesión' },
      { status: 403 },
    );
  }

  await removeTranscriptionFiles(row.id, row.sourceExt);
  await db.delete(transcriptions).where(eq(transcriptions.id, id));

  return NextResponse.json({ ok: true });
}
