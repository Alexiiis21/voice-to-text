/**
 * Empaqueta el worker y el runner de migraciones en `dist/` con esbuild.
 *
 * Motivo: la imagen final sólo lleva el `node_modules` trazado por Next en modo
 * standalone. El worker vive en el mismo contenedor pero fuera de ese árbol, así
 * que se compila a dos ficheros autocontenidos en lugar de arrastrar un
 * `node_modules` completo a la capa final (§9, presupuesto de memoria/imagen).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Varias dependencias (postgres.js, drizzle) usan `require` internamente en
// algunas rutas; el shim de createRequire evita "require is not defined".
const banner = {
  js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
};

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  banner,
  alias: { '@': path.join(root, 'src') },
  define: { 'process.env.NODE_ENV': '"production"' },
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/worker/index.ts')],
  outfile: path.join(root, 'dist/worker.js'),
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/db/migrate.ts')],
  outfile: path.join(root, 'dist/migrate.js'),
});

console.log('[build-server] dist/worker.js y dist/migrate.js listos');
