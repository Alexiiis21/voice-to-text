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
    ensureExecutable(fromInstaller);
    cached = fromInstaller;
    return cached;
  }

  cached = 'ffmpeg';
  return cached;
}

/**
 * Asegura el bit de ejecución.
 *
 * npm conserva los permisos del tarball, así que normalmente ya viene con +x.
 * Pero el bundle de una función serverless se reempaqueta por el camino y hay
 * despliegues donde el bit se pierde; un `chmod` de más no cuesta nada y evita
 * un EACCES a mitad de un trabajo.
 */
function ensureExecutable(binaryPath: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {
      // Sistema de ficheros de sólo lectura: si de verdad falta el permiso, el
      // spawn dará un error claro. No hay nada más que hacer aquí.
    }
  }
}
