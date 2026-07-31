import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/db';
import { transcriptions } from '@/db/schema';
import { ALLOWED_MIME_TYPES, HISTORY_LIMIT } from '@/lib/config';
import { env } from '@/lib/env';
import {
  ensureDataDirs,
  removeQuietly,
  uploadPath,
  validatedExtension,
} from '@/lib/files';
import { probeAudio } from '@/lib/ffmpeg';
import {
  clientIp,
  commitAudioSeconds,
  readQuota,
  releaseTranscription,
  reserveTranscription,
} from '@/lib/rate-limit';
import { readSessionId } from '@/lib/session';
import { toView } from '@/lib/serialize';
import { activeSttProviderName } from '@/lib/stt';
import { verifyTurnstile } from '@/lib/turnstile';
import { parseUpload, UploadError } from '@/lib/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Historial de la sesión (cookie `session_id`), últimas 20. */
export async function GET(): Promise<NextResponse> {
  const sessionId = await readSessionId();
  if (!sessionId) {
    return NextResponse.json({ items: [] });
  }

  const rows = await db
    .select()
    .from(transcriptions)
    .where(eq(transcriptions.sessionId, sessionId))
    .orderBy(desc(transcriptions.createdAt))
    .limit(HISTORY_LIMIT);

  return NextResponse.json({ items: rows.map(toView) });
}

/**
 * Sube un audio y lo encola.
 *
 * Orden estricto: Turnstile → rate limit → escritura en streaming a disco →
 * validación con ffprobe → INSERT con status='queued' → 202 { id }.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Se esperaba multipart/form-data' },
      { status: 400 },
    );
  }

  if (!request.body) {
    return NextResponse.json({ error: 'Petición sin cuerpo' }, { status: 400 });
  }

  const sessionId = (await readSessionId()) ?? randomUUID();
  const ip = clientIp(request.headers);
  const maxBytes = env.maxUploadMb * 1024 * 1024;

  await ensureDataDirs();

  const id = randomUUID();
  let destination: string | null = null;
  let reserved = false;

  try {
    const upload = await parseUpload(request.body, contentType, maxBytes, {
      async onFileStart({ fields, filename, mimeType }) {
        // 1. Turnstile.
        const turnstile = await verifyTurnstile(fields.turnstileToken ?? null, ip);
        if (!turnstile.ok) {
          throw new UploadError(turnstile.reason ?? 'Verificación antibot fallida', 403);
        }

        // 2. Allowlist de extensión y MIME.
        const ext = validatedExtension(filename);
        if (!ext) {
          throw new UploadError(
            'Formato no soportado. Formatos válidos: .ogg .opus .mp3 .m4a .wav .webm .aac .flac',
            400,
          );
        }
        const normalizedMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
        if (normalizedMime !== '' && !ALLOWED_MIME_TYPES.has(normalizedMime)) {
          throw new UploadError(`Tipo MIME no permitido: ${normalizedMime}`, 400);
        }

        // 3. Rate limit por IP.
        const decision = await reserveTranscription(ip);
        if (!decision.allowed) {
          throw new UploadError(decision.reason ?? 'Límite de uso alcanzado', 429);
        }
        reserved = true;

        destination = uploadPath(id, ext);
        return { destination };
      },
    });

    const ext = validatedExtension(upload.filename);
    if (!ext || !destination) {
      throw new UploadError('No se pudo determinar la extensión del archivo', 400);
    }

    if (upload.bytesWritten === 0) {
      throw new UploadError('El archivo está vacío', 400);
    }

    // 4. ffprobe ANTES de encolar: protege de archivos disfrazados de audio.
    let durationSec: number;
    try {
      const probe = await probeAudio(destination);
      durationSec = probe.durationSec;
    } catch {
      throw new UploadError(
        'ffprobe no reconoce ningún stream de audio en el archivo. ' +
          'Comprueba que es un audio válido y no está corrupto.',
        400,
      );
    }

    await commitAudioSeconds(ip, durationSec);

    // 5. Encolar.
    const [row] = await db
      .insert(transcriptions)
      .values({
        id,
        sessionId,
        filename: upload.filename.slice(0, 255),
        sourceExt: ext,
        sizeBytes: upload.bytesWritten,
        durationSec: Math.round(durationSec),
        status: 'queued',
        sttProvider: activeSttProviderName(),
      })
      .returning();

    if (!row) throw new Error('No se pudo crear el registro de la transcripción');

    const quota = await readQuota(ip);
    return NextResponse.json({ id: row.id, transcription: toView(row), quota }, { status: 202 });
  } catch (error: unknown) {
    if (destination) await removeQuietly(destination);
    if (reserved) await releaseTranscription(ip);

    if (error instanceof UploadError) {
      const headers: Record<string, string> = {};
      if (error.status === 429) {
        const quota = await readQuota(ip);
        headers['Retry-After'] = String(quota.resetInSec);
      }
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error('[api] Error subiendo audio:', message);
    return NextResponse.json({ error: `Error procesando la subida: ${message}` }, { status: 500 });
  }
}
