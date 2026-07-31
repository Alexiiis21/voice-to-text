import { asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { chunks, transcriptions } from '@/db/schema';
import { SSE_POLL_MS } from '@/lib/config';
import { toChunkView, toView } from '@/lib/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TERMINAL_STATUSES = new Set(['done', 'failed']);

interface Params {
  params: Promise<{ id: string }>;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * SSE con el progreso en vivo.
 *
 * El worker corre en OTRO proceso del mismo contenedor, así que no hay un
 * EventEmitter compartido: esta ruta sondea Postgres cada segundo y emite sólo
 * los cambios. Railway no impone timeout, así que la conexión puede vivir las
 * tres horas que dure una transcripción. Ver README para la alternativa con
 * LISTEN/NOTIFY cuando el worker se separe en su propio servicio.
 */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return new Response('Identificador inválido', { status: 400 });
  }

  const [initial] = await db
    .select()
    .from(transcriptions)
    .where(eq(transcriptions.id, id))
    .limit(1);

  if (!initial) {
    return new Response('Transcripción no encontrada', { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastStatus: string | null = null;
      const seenChunks = new Map<number, string>();

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        } catch {
          closed = true;
        }
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // El cliente ya se fue.
        }
      };

      request.signal.addEventListener('abort', close);

      // Comentario inicial: fuerza el flush de proxies intermedios.
      send('open', { id });

      while (!closed && !request.signal.aborted) {
        try {
          const [row] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, id))
            .limit(1);

          if (!row) {
            send('error', { message: 'La transcripción ha sido borrada' });
            close();
            break;
          }

          const chunkRows = await db
            .select()
            .from(chunks)
            .where(eq(chunks.transcriptionId, id))
            .orderBy(asc(chunks.idx));

          for (const chunk of chunkRows) {
            const previous = seenChunks.get(chunk.idx);
            if (previous !== chunk.status) {
              seenChunks.set(chunk.idx, chunk.status);
              if (chunk.status !== 'pending') {
                send('chunk_done', toChunkView(chunk));
              }
            }
          }

          if (row.status !== lastStatus) {
            lastStatus = row.status;
            send('status_change', {
              status: row.status,
              transcription: toView(row),
              chunks: chunkRows.map(toChunkView),
            });
          }

          if (TERMINAL_STATUSES.has(row.status)) {
            if (row.status === 'failed') {
              send('error', { message: row.error ?? 'La transcripción falló' });
            }
            send('done', { transcription: toView(row), chunks: chunkRows.map(toChunkView) });
            close();
            break;
          }

          // Heartbeat: mantiene viva la conexión a través de proxies.
          send('ping', { t: Date.now() });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          send('error', { message: `Error consultando el estado: ${message}` });
          close();
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, SSE_POLL_MS));
      }

      close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
