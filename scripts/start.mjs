/**
 * Supervisor de arranque del servicio `web`.
 *
 * Hace tres cosas, en orden:
 *   1. Aplica las migraciones de Drizzle.
 *   2. Levanta el servidor de Next.js (build standalone).
 *   3. Levanta el bucle del worker.
 *
 * Se escribió a mano en lugar de usar `concurrently` por dos razones: una
 * dependencia menos en la imagen final, y el control explícito del orden
 * (migraciones antes que nada) y del apagado (SIGTERM se propaga a los dos
 * hijos y se espera a que el worker termine el fragmento en curso).
 *
 * Ver README, sección "Dos procesos en un servicio".
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const isDev = process.env.NODE_ENV !== 'production';

const SERVER_ENTRY = process.env.NEXT_SERVER_ENTRY ?? path.join(root, '.next/standalone/server.js');
const WORKER_ENTRY = process.env.WORKER_ENTRY ?? path.join(root, 'dist/worker.js');
const MIGRATE_ENTRY = process.env.MIGRATE_ENTRY ?? path.join(root, 'dist/migrate.js');

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function log(scope, message) {
  console.log(`[start:${scope}] ${message}`);
}

function runOnce(entry, scope) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scope} terminó con código ${code}`));
    });
  });
}

function supervise(entry, scope, extraEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });

  children.push(child);
  log(scope, `arrancado (pid ${child.pid})`);

  child.on('exit', (code, signal) => {
    log(scope, `salió (código ${code}, señal ${signal ?? 'ninguna'})`);
    if (!shuttingDown) {
      // Si uno de los dos muere, el contenedor entero debe reiniciarse: es lo
      // que espera el healthcheck de Railway.
      shutdown('SIGTERM', code === 0 ? 1 : (code ?? 1));
    }
  });

  return child;
}

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('main', `apagando (${signal})`);

  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }

  // Margen para que el worker termine el fragmento en curso y devuelva el
  // trabajo a la cola.
  const timer = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 130_000);
  timer.unref();

  let pending = children.filter((child) => child.exitCode === null).length;
  if (pending === 0) process.exit(exitCode);

  for (const child of children) {
    child.on('exit', () => {
      pending -= 1;
      if (pending <= 0) {
        clearTimeout(timer);
        process.exit(exitCode);
      }
    });
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main() {
  if (isDev) {
    log('main', 'NODE_ENV no es production; se asume ejecución en la imagen de todos modos');
  }

  log('migrate', 'aplicando migraciones');
  await runOnce(MIGRATE_ENTRY, 'migrate');

  supervise(SERVER_ENTRY, 'next', {
    PORT: process.env.PORT ?? '3000',
    HOSTNAME: process.env.HOSTNAME ?? '0.0.0.0',
  });

  supervise(WORKER_ENTRY, 'worker');
}

main().catch((error) => {
  console.error('[start:main] error fatal:', error);
  process.exit(1);
});
