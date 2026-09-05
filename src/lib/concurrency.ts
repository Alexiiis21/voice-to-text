/**
 * Ejecución con concurrencia acotada.
 *
 * Módulo puro (sin fs, sin red), cubierto por tests.
 *
 * Existe porque en serverless la latencia deja de ser sólo comodidad: una
 * función tiene `maxDuration`, así que una tanda de llamadas independientes
 * hechas en fila puede no caber donde sí cabe la misma tanda en paralelo. Pero
 * "en paralelo" a pelo tampoco vale: los proveedores tienen límites de
 * peticiones por minuto y lanzar veinte a la vez es la forma rápida de comerse
 * un 429. De ahí el tope.
 */

/**
 * Aplica `worker` a cada elemento con como mucho `limit` en vuelo.
 *
 * **El orden del resultado es el de la entrada**, no el de finalización. Es la
 * diferencia que importa cuando lo que se está paralelizando son trozos
 * consecutivos de un texto: si se devolvieran en orden de llegada, el resumen
 * saldría con las partes barajadas.
 *
 * No atrapa errores: si un trabajo lanza, la promesa entera rechaza. Quien
 * llama decide si eso aborta o si el fallo de una pieza es tolerable (y en ese
 * caso lo captura dentro de su propio `worker`).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const effective = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: effective }, async () => {
    // `cursor++` es seguro sin cerrojo: el bucle de eventos de Node no
    // interrumpe entre la lectura y el incremento, así que dos runners nunca
    // se llevan el mismo índice.
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}
