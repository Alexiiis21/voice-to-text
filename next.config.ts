import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Imagen final mínima en Railway: sólo el server + las dependencias trazadas.
  output: 'standalone',
  // Ancla el trazado a este proyecto: si hay otro lockfile más arriba en el
  // árbol, Next elige ese directorio como raíz y el standalone sale mal.
  outputFileTracingRoot: path.resolve(import.meta.dirname),
  reactStrictMode: true,
  poweredByHeader: false,
  // Estos paquetes usan APIs nativas de Node y no deben pasar por el bundler del server.
  serverExternalPackages: ['postgres', 'busboy'],
  eslint: {
    dirs: ['src', 'scripts'],
  },
};

export default nextConfig;
