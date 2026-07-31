import busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Readable as NodeReadable } from 'node:stream';

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadHandlers {
  /**
   * Se invoca justo antes de empezar a escribir el fichero, con los campos de
   * texto ya recibidos. Debe lanzar `UploadError` para rechazar la subida
   * (Turnstile, rate limit, extensión no permitida) y devolver la ruta de
   * destino si todo está bien.
   */
  onFileStart(info: {
    fields: Record<string, string>;
    filename: string;
    mimeType: string;
  }): Promise<{ destination: string }>;
}

export interface UploadResult {
  fields: Record<string, string>;
  filename: string;
  mimeType: string;
  destination: string;
  bytesWritten: number;
}

/**
 * Parsea un `multipart/form-data` escribiendo el fichero **en streaming a
 * disco**. En ningún momento se materializa el cuerpo completo en memoria:
 * pueden ser cientos de MB (§12).
 *
 * El cliente debe enviar los campos de texto ANTES del fichero (así lo hace
 * `FormData` respetando el orden de `append`), de modo que la verificación de
 * Turnstile y el rate limit ocurren antes de escribir un solo byte.
 */
export function parseUpload(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  maxBytes: number,
  handlers: UploadHandlers,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: { 'content-type': contentType },
        limits: { files: 1, fields: 10, fieldSize: 8 * 1024, fileSize: maxBytes },
      });
    } catch (error: unknown) {
      reject(new UploadError(`Cabecera multipart inválida: ${String(error)}`, 400));
      return;
    }

    const source: NodeReadable = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    const fields: Record<string, string> = {};

    let settled = false;
    let sawFile = false;
    let pending: Promise<void> | null = null;
    let result: UploadResult | null = null;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      source.unpipe(bb);
      source.destroy();
      reject(error);
    };

    const succeed = (): void => {
      if (settled) return;
      if (!result) {
        settled = true;
        reject(new UploadError('La petición no incluye ningún archivo', 400));
        return;
      }
      settled = true;
      resolve(result);
    };

    bb.on('field', (name: string, value: string) => {
      if (Object.keys(fields).length < 10) fields[name] = value;
    });

    bb.on('file', (_name: string, fileStream: NodeReadable, info: busboy.FileInfo) => {
      if (sawFile) {
        fileStream.resume();
        return;
      }
      sawFile = true;

      // Pausa síncrona: nada se escribe hasta que la verificación termina.
      fileStream.pause();

      let truncated = false;
      fileStream.on('limit', () => {
        truncated = true;
      });

      pending = (async () => {
        const { destination } = await handlers.onFileStart({
          fields,
          filename: info.filename,
          mimeType: info.mimeType,
        });

        let bytesWritten = 0;
        fileStream.on('data', (chunk: Buffer) => {
          bytesWritten += chunk.length;
        });

        await pipeline(fileStream, createWriteStream(destination));

        if (truncated) {
          throw new UploadError(
            `El archivo supera el máximo permitido de ${Math.round(maxBytes / (1024 * 1024))} MB`,
            413,
          );
        }

        result = {
          fields,
          filename: info.filename,
          mimeType: info.mimeType,
          destination,
          bytesWritten,
        };
      })();

      pending.catch(fail);
    });

    bb.on('error', (error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    bb.on('close', () => {
      if (pending) {
        pending.then(succeed).catch(fail);
      } else {
        fail(new UploadError('La petición no incluye ningún archivo', 400));
      }
    });

    source.on('error', (error: Error) => fail(error));
    source.pipe(bb);
  });
}
