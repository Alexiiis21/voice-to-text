/**
 * Resolución del binario de ffmpeg.
 *
 * En el despliegue de Railway ffmpeg venía del `apt-get` del Dockerfile y
 * bastaba con invocarlo por nombre. En Vercel no hay imagen que controlar: el
 * binario tiene que viajar dentro del bundle de la función. Se usa
 * `@ffmpeg-installer/ffmpeg`, que publica un paquete por plataforma como
 * dependencia opcional (`os`/`cpu` en el lockfile), así que npm instala sólo
 * `linux-x64` en Vercel y `win32-x64` en local. No lleva script de instalación,
 * que es justo lo que hace falta: el build de Vercel los tiene bloqueados
 * (`npm warn allow-scripts`), así que `ffmpeg-static` —que descarga el binario
 * en un `postinstall`— se quedaría sin nada que ejecutar.
 *
 * **ffprobe no se empaqueta.** Cada binario ronda los 78 MB y el límite de una
 * función serverless son 250 MB descomprimidos, runtime de Next incluido. Con
 * los dos no cabe con margen, así que la duración y la validación del audio se
 * sacan del propio ffmpeg (ver `probeAudio` en ./ffmpeg.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Cacheado a nivel de módulo: se resuelve una vez por invocación en frío. */
let cached: string | null = null;

/**
 * El paquete es CommonJS y resuelve la ruta en tiempo de carga. Se usa
 * `createRequire` en vez de `require` a secas porque el proyecto es ESM
 * (`"type": "module"`) y el worker se empaqueta con esbuild: ahí `require` no
 * existe como global.
 */
const requireCjs = createRequire(import.meta.url);

function resolveFromInstaller(): string | null {
  try {
    // Si el paquete de la plataforma no está instalado, el módulo lanza al
    // cargarse y aquí sólo queremos caer al fallback.
    const installer = requireCjs('@ffmpeg-installer/ffmpeg') as { path?: string };
    return typeof installer.path === 'string' && installer.path !== '' ? installer.path : null;
  } catch {
    return null;
  }
}

/**
 * Ruta al ejecutable de ffmpeg.
 *
 * Orden: `FFMPEG_PATH` (escotilla para desplegar en cualquier otro sitio) →
 * el paquete de la plataforma → `ffmpeg` del PATH, que es lo que funciona en
 * una máquina de desarrollo con ffmpeg instalado a mano.
 */
export function ffmpegPath(): string {
  if (cached !== null) return cached;

  const override = process.env.FFMPEG_PATH?.trim();
  if (override) {
    cached = override;
    return cached;
  }

  const fromInstaller = resolveFromInstaller();
  if (fromInstaller !== null) {
    cached = makeExecutable(fromInstaller);
    return cached;
  }

  cached = 'ffmpeg';
  return cached;
}

/** Copia de trabajo cuando el binario original no se puede marcar ejecutable. */
const STAGED_BINARY = path.join(os.tmpdir(), 'transcriptor-bin', 'ffmpeg');

/**
 * Devuelve una ruta a un ffmpeg que **se puede ejecutar de verdad**.
 *
 * El problema concreto: `@ffmpeg-installer/linux-x64` da el permiso de
 * ejecución en un `postinstall` (`chmod u+x ffmpeg`), porque los tarballs de
 * npm no conservan ese bit de forma fiable. **Vercel bloquea los install
 * scripts** —lo dice el propio log del build:
 *
 *     npm warn allow-scripts @ffmpeg-installer/linux-x64@4.1.0 (postinstall: chmod u+x ffmpeg)
 *
 * así que en Vercel el binario llega sin permiso de ejecución. Y arreglarlo en
 * caliente con un `chmod` sobre el original tampoco vale: el filesystem de una
 * función es de sólo lectura salvo `/tmp`.
 *
 * De ahí la copia a `/tmp`, que es el único sitio escribible. Cuesta unos
 * cientos de ms la primera vez y nada mientras la instancia siga caliente.
 * Fuera de Vercel no se llega a copiar nunca: el binario ya viene ejecutable o
 * el `chmod` sobre el original funciona.
 */
function makeExecutable(source: string): string {
  if (process.platform === 'win32') return source;

  // 1. ¿Ya se puede ejecutar? Es el caso normal en local y en un contenedor.
  try {
    fs.accessSync(source, fs.constants.X_OK);
    return source;
  } catch {
    // Sigue.
  }

  // 2. ¿Se puede arreglar en el sitio? Vale en cualquier sistema de ficheros
  //    escribible; en Vercel lanzará EROFS y caemos al paso 3.
  try {
    fs.chmodSync(source, 0o755);
    fs.accessSync(source, fs.constants.X_OK);
    return source;
  } catch {
    // Sigue.
  }

  // 3. Copia a /tmp. Si ya está de una invocación anterior en la misma
  //    instancia, se reutiliza.
  try {
    fs.accessSync(STAGED_BINARY, fs.constants.X_OK);
    return STAGED_BINARY;
  } catch {
    // No está todavía.
  }

  try {
    fs.mkdirSync(path.dirname(STAGED_BINARY), { recursive: true });
    fs.copyFileSync(source, STAGED_BINARY);
    fs.chmodSync(STAGED_BINARY, 0o755);
    console.log(`[ffmpeg] Binario preparado en ${STAGED_BINARY}`);
    return STAGED_BINARY;
  } catch (error: unknown) {
    // Sin binario ejecutable no hay nada que hacer, y fallar aquí con el motivo
    // real es mucho más útil que un EACCES suelto a mitad de un trabajo.
    throw new Error(
      `No se pudo preparar el binario de ffmpeg. Origen: ${source}. ` +
        `Causa: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
