import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';
import { ALLOWED_EXTENSIONS } from './config';

export const UPLOADS_DIR = path.join(env.dataDir, 'uploads');
export const CHUNKS_DIR = path.join(env.dataDir, 'chunks');

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(CHUNKS_DIR, { recursive: true });
}

/**
 * Extrae y valida la extensión del nombre que envía el cliente.
 * Devuelve null si no está en la allowlist. El nombre del cliente NUNCA se usa
 * para construir una ruta; sólo para decidir la extensión (§5).
 */
export function validatedExtension(clientFilename: string): string | null {
  const dot = clientFilename.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = clientFilename.slice(dot).toLowerCase();
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/** Ruta del audio original. El nombre lo genera el servidor: uuid + extensión. */
export function uploadPath(id: string, ext: string): string {
  return path.join(UPLOADS_DIR, `${id}${ext}`);
}

/** Ruta del audio normalizado (mono 16 kHz mp3 32 kbps). */
export function normalizedPath(id: string): string {
  return path.join(UPLOADS_DIR, `${id}.norm.mp3`);
}

/** Ruta temporal de un fragmento. Se borra en cuanto se sube. */
export function chunkPath(id: string, idx: number, suffix = ''): string {
  return path.join(CHUNKS_DIR, `${id}-${String(idx).padStart(4, '0')}${suffix}.mp3`);
}

/** Borra un fichero ignorando ENOENT. */
export async function removeQuietly(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      console.warn(`[files] No se pudo borrar ${filePath}:`, error);
    }
  }
}

/** Borra todos los ficheros asociados a una transcripción. */
export async function removeTranscriptionFiles(id: string, ext: string | null): Promise<void> {
  if (ext) await removeQuietly(uploadPath(id, ext));
  await removeQuietly(normalizedPath(id));

  // Fragmentos huérfanos de un trabajo interrumpido.
  try {
    const entries = await fs.readdir(CHUNKS_DIR);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${id}-`))
        .map((name) => removeQuietly(path.join(CHUNKS_DIR, name))),
    );
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') console.warn('[files] No se pudo listar chunks/:', error);
  }
}

export async function fileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
