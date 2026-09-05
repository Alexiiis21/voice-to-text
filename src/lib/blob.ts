/**
 * Almacenamiento de audio en Vercel Blob.
 *
 * Sustituye al volumen `/data` de Railway. La diferencia que manda sobre todo
 * el diseño: en Vercel **no hay disco compartido entre invocaciones**. `/tmp`
 * existe, es escribible y sobrevive dentro de una misma invocación (y a veces
 * entre invocaciones calientes), pero no se puede contar con él: la función que
 * recibe la subida y la que procesa el audio pueden ser instancias distintas.
 *
 * Reparto de papeles:
 *   - Blob guarda lo que tiene que sobrevivir entre invocaciones: el audio
 *     original y el normalizado.
 *   - `/tmp` es sólo scratch de la invocación en curso (ver ./files.ts).
 *
 * Nota de privacidad: Vercel Blob sólo ofrece `access: 'public'`. Las URLs
 * llevan un sufijo aleatorio y son inadivinable, pero cualquiera con la URL
 * puede descargar el audio mientras exista. Por eso se borran en cuanto
 * termina la transcripción, igual que hacía el volumen (§6).
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { del, head, put } from '@vercel/blob';

/** Host de los blobs públicos. Se valida antes de aceptar una URL del cliente. */
const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

export function originalKey(id: string, ext: string): string {
  return `originals/${id}${ext}`;
}

export function normalizedKey(id: string): string {
  return `normalized/${id}.mp3`;
}

/**
 * ¿La URL apunta a nuestro almacén?
 *
 * El cliente sube directamente a Blob y luego nos manda la URL, así que la URL
 * es entrada no confiable: sin esta comprobación, `POST /api/transcriptions`
 * sería un SSRF —le pasaríamos cualquier URL a `fetch` desde el servidor—.
 * La pertenencia real al almacén la confirma después `statBlob`, que va
 * firmado con nuestro token.
 */
export function isBlobUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname.endsWith(BLOB_HOST_SUFFIX);
}

export interface BlobStat {
  size: number;
  contentType: string | null;
}

/**
 * Metadatos del blob. Lanza si no existe o no pertenece a nuestro almacén: va
 * autenticado con `BLOB_READ_WRITE_TOKEN`, así que es la comprobación de
 * propiedad de verdad.
 */
export async function statBlob(url: string): Promise<BlobStat> {
  const meta = await head(url);
  return { size: meta.size, contentType: meta.contentType ?? null };
}

/** Descarga un blob a un fichero local, en streaming. */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar el audio (HTTP ${response.status})`);
  }
  // `Readable.fromWeb` evita materializar el audio entero en memoria: un
  // original de 500 MB reventaría el heap de la función.
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
}

/** Sube un fichero local a Blob y devuelve su URL pública. */
export async function uploadFile(
  key: string,
  localPath: string,
  contentType: string,
): Promise<string> {
  const result = await put(key, createReadStream(localPath), {
    access: 'public',
    contentType,
    // La clave ya lleva el uuid de la transcripción: no hace falta sufijo, y
    // sin él la clave es determinista y se puede reescribir en un reintento.
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return result.url;
}

/**
 * Borra blobs ignorando los que ya no están.
 *
 * Se llama en la ruta de limpieza y en la de error, donde un fallo al borrar no
 * debe tapar el error original que trajo hasta aquí.
 */
export async function deleteBlobs(urls: readonly (string | null | undefined)[]): Promise<void> {
  const present = urls.filter((url): url is string => typeof url === 'string' && url !== '');
  if (present.length === 0) return;

  try {
    await del(present);
  } catch (error: unknown) {
    console.warn(
      '[blob] No se pudieron borrar algunos blobs:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** ¿Hay token de Blob configurado? Usado por /api/health. */
export function blobConfigured(): boolean {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return typeof token === 'string' && token.trim() !== '';
}
