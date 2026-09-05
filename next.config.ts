import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  /**
   * `standalone` sólo tiene sentido fuera de Vercel.
   *
   * Es lo que produce el `server.js` autocontenido que arranca
   * `scripts/start.mjs` dentro del contenedor. En Vercel estorba: la plataforma
   * empaqueta cada ruta como su propia función y el trazado ya lo hace ella.
   * Condicionarlo mantiene vivo el camino del Dockerfile por si hace falta
   * volver a un contenedor, sin penalizar el despliegue normal.
   */
  output: process.env.VERCEL ? undefined : 'standalone',

  // Ancla el trazado a este proyecto: si hay otro lockfile más arriba en el
  // árbol, Next elige ese directorio como raíz y el trazado sale mal.
  outputFileTracingRoot: path.resolve(import.meta.dirname),

  /**
   * El binario de ffmpeg tiene que viajar dentro de la función que lo ejecuta.
   *
   * El trazado automático de Next no lo encuentra: `@ffmpeg-installer/ffmpeg`
   * resuelve la ruta del paquete de la plataforma en tiempo de ejecución
   * (`createRequire` sobre un nombre construido con `os.platform()`), y un
   * analizador estático no puede seguir eso. Sin esta inclusión explícita el
   * despliegue construye bien y luego falla en ejecución con un ENOENT.
   *
   * Se incluye **sólo en `/api/process`**, que es la única ruta que lo ejecuta.
   * Son 68 MB en Linux y el límite de una función serverless son 250 MB
   * descomprimidos, así que repartirlo por rutas que no lo usan es peso muerto:
   * `/api/cron` no llega a ffmpeg por ninguna vía de import (sólo toca la base
   * de datos y Blob), y `/api/health` sólo pregunta por él —y por eso reporta
   * `ffmpeg: false`, que ahí es lo esperado—.
   */
  outputFileTracingIncludes: {
    '/api/process': ['./node_modules/@ffmpeg-installer/**/*'],
  },

  reactStrictMode: true,
  poweredByHeader: false,
  // Estos paquetes usan APIs nativas de Node y no deben pasar por el bundler del server.
  serverExternalPackages: ['postgres', '@ffmpeg-installer/ffmpeg'],
  eslint: {
    dirs: ['src', 'scripts'],
  },
};

export default nextConfig;
