import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/db';
import { transcriptions } from '@/db/schema';
import { HISTORY_LIMIT } from '@/lib/config';
import { deleteBlobs, isBlobUrl, statBlob } from '@/lib/blob';
import { validatedExtension } from '@/lib/files';
import { clientIp, readQuota, releaseTranscription } from '@/lib/rate-limit';
import { safeErrorMessage } from '@/lib/redact';
import { readSessionId } from '@/lib/session';
import { toView } from '@/lib/serialize';
import { defaultProviderName, normalizeRequestedProvider } from '@/lib/stt';
import { triggerProcessing } from '@/lib/trigger';

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

interface ConfirmBody {
  blobUrl?: unknown;
  filename?: unknown;
  sttProvider?: unknown;
}

/**
 * Confirma un audio ya subido a Blob y lo encola.
 *
 * El audio **no pasa por aquí**: el navegador lo sube directo a Vercel Blob con
 * un token que emite `/api/blob/upload` (ahí se hacen Turnstile y rate limit).
 * Esta ruta sólo recibe la URL resultante, comprueba que es nuestra y crea la
 * fila. Por eso es rápida y no le afecta el límite de 4,5 MB de cuerpo.
 *
 * Lo que **ya no** se hace aquí, a diferencia del despliegue en contenedor:
 * validar el audio con ffprobe. Para eso habría que descargar el fichero
 * entero, y son cientos de MB; la validación la hace `/api/process` con el
 * `probeAudio` que ya necesita para trocear. Un fichero que no sea audio de
 * verdad se rechaza ahí y la transcripción queda `failed` con el motivo.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const sessionId = (await readSessionId()) ?? randomUUID();
  const ip = clientIp(request.headers);

  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: 'Cuerpo ilegible' }, { status: 400 });
  }

  const blobUrl = typeof body.blobUrl === 'string' ? body.blobUrl : '';
  const rawFilename = typeof body.filename === 'string' ? body.filename : '';

  // Entrada no confiable: sin esta comprobación le pasaríamos a `fetch` una URL
  // arbitraria desde el servidor (SSRF).
  if (!isBlobUrl(blobUrl)) {
    return NextResponse.json({ error: 'La URL del audio no es válida' }, { status: 400 });
  }

  const ext = validatedExtension(rawFilename);
  if (!ext) {
    return NextResponse.json(
      {
        error:
          'Formato no soportado. Formatos válidos: .ogg .opus .mp3 .m4a .wav .webm .aac .flac',
      },
      { status: 400 },
    );
  }

  // Motor elegido en el selector del panel de entrada. Si el cliente manda algo
  // que no está configurado en el servidor, se ignora y se usa el primero de la
  // cadena: el cliente no puede forzar un proveedor sin clave.
  const requestedProvider =
    normalizeRequestedProvider(typeof body.sttProvider === 'string' ? body.sttProvider : null) ??
    defaultProviderName();

  try {
    // `head` va firmado con nuestro token: confirma que el blob existe y es de
    // nuestro almacén, no sólo que la URL tiene la forma correcta.
    const stat = await statBlob(blobUrl);

    if (stat.size === 0) {
      await deleteBlobs([blobUrl]);
      return NextResponse.json({ error: 'El archivo está vacío' }, { status: 400 });
    }

    const [row] = await db
      .insert(transcriptions)
      .values({
        id: randomUUID(),
        sessionId,
        filename: rawFilename.slice(0, 255),
        sourceExt: ext,
        sourceUrl: blobUrl,
        clientIp: ip,
        sizeBytes: stat.size,
        status: 'queued',
        sttProvider: requestedProvider,
      })
      .returning();

    if (!row) throw new Error('No se pudo crear el registro de la transcripción');

    console.log(
      `[api] Encolado ${row.id} · "${row.filename}" · ${Math.round(stat.size / 1024)} KB · ` +
        `motor ${requestedProvider}`,
    );

    // Despertar al procesador. Si esto no consigue disparar, el trabajo se
    // queda en `queued`: `triggerProcessing` lo registra con detalle.
    const disparado = await triggerProcessing(`nueva transcripción ${row.id}`);
    if (!disparado) {
      console.error(
        `[api] ${row.id} está encolado pero NADIE lo va a procesar. ` +
          'Revisa el mensaje de [trigger] justo encima.',
      );
    }

    const quota = await readQuota(ip);
    return NextResponse.json({ id: row.id, transcription: toView(row), quota }, { status: 202 });
  } catch (error: unknown) {
    // La reserva del rate limit se hizo al emitir el token; si no llegamos a
    // encolar, se devuelve.
    await releaseTranscription(ip);
    await deleteBlobs([blobUrl]);

    const message = safeErrorMessage(error);
    console.error('[api] Error encolando el audio:', message);
    return NextResponse.json({ error: `No se pudo encolar el audio: ${message}` }, { status: 500 });
  }
}
