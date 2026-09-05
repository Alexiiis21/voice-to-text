/**
 * Redacción de secretos en mensajes destinados a logs o a la interfaz.
 *
 * Módulo puro, cubierto por tests (tests/redact.test.ts).
 *
 * Existe por dos incidentes reales en producción:
 *  - postgres.js volcó la cadena de conexión completa —contraseña incluida— al
 *    fallar el parseo de `DATABASE_URL`.
 *  - El SDK de Anthropic incluyó la `ANTHROPIC_API_KEY` entera en el texto de
 *    un `Headers.append: "…" is an invalid header value`.
 *
 * Ambos acabaron en los logs de despliegue, que se conservan. La regla ahora es
 * que **ningún error de terceros llega a consola sin pasar por aquí**.
 */

/** Patrones de credenciales conocidas. El orden importa: de más a menos específico. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Claves de Anthropic: sk-ant-api03-…
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // Claves de OpenAI: sk-…, sk-proj-…
  /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  // Claves de Groq: gsk_…
  /gsk_[A-Za-z0-9_-]{8,}/g,
  // Claves de Turnstile: 0x4AAA…
  /0x4[A-Za-z0-9_-]{12,}/g,
  // Bearer en cabeceras.
  /(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
];

/** Contraseña dentro de una URL de conexión (postgres://user:PASS@host). */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:@\s/]*:)[^@\s]+(@)/gi;

/**
 * Sustituye cualquier credencial reconocible por `***`.
 *
 * Es deliberadamente agresivo: prefiere ocultar de más a filtrar una clave. Lo
 * que queda sigue bastando para diagnosticar, porque el resto del mensaje
 * (el código de error, la operación) se conserva intacto.
 */
export function redactSecrets(input: string): string {
  if (typeof input !== 'string' || input === '') return input;

  let output = input.replace(URL_CREDENTIALS, '$1***$2');

  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) =>
      prefix === undefined ? '***' : `${prefix}***`,
    );
  }

  return output;
}

/**
 * Mensaje de un error desconocido, ya redactado y acotado.
 *
 * Se usa el `message` y nunca el objeto completo: la propiedad `cause` y los
 * campos internos de algunos SDK arrastran la configuración con credenciales.
 */
export function safeErrorMessage(error: unknown, maxLength = 2000): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).slice(0, maxLength);
}
