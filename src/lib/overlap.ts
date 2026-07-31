/**
 * Eliminación de la duplicación producida por el solape de 1,5 s entre
 * fragmentos consecutivos.
 *
 * Módulo puro. Es la segunda de las dos piezas con lógica no trivial y está
 * cubierta por tests (tests/overlap.test.ts).
 */

/** Normaliza una palabra para comparar: minúsculas, sin puntuación de borde. */
function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFC')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Divide en tokens conservando el texto original de cada uno. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Compara las últimas `maxWords` palabras de `previous` con las primeras de
 * `next` y devuelve `next` sin el prefijo duplicado.
 *
 * Busca el solape más largo posible (de `maxWords` hacia abajo) y exige al
 * menos dos palabras coincidentes: una sola palabra repetida es demasiado
 * común en español ("y", "que", "la") y produciría recortes espurios.
 */
export function dedupeOverlap(previous: string, next: string, maxWords = 10): string {
  const prevTokens = tokenize(previous);
  const nextTokens = tokenize(next);

  if (prevTokens.length === 0 || nextTokens.length === 0) return next.trim();

  const maxCompare = Math.min(maxWords, prevTokens.length, nextTokens.length);
  if (maxCompare < 2) return next.trim();

  const prevNorm = prevTokens.slice(-maxCompare).map(normalizeWord);
  const nextNorm = nextTokens.slice(0, maxCompare).map(normalizeWord);

  for (let size = maxCompare; size >= 2; size -= 1) {
    const tail = prevNorm.slice(prevNorm.length - size);
    const head = nextNorm.slice(0, size);

    let matches = true;
    for (let i = 0; i < size; i += 1) {
      const a = tail[i];
      const b = head[i];
      if (a === undefined || b === undefined || a === '' || a !== b) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return nextTokens.slice(size).join(' ').trim();
    }
  }

  return next.trim();
}

/**
 * Une los textos de los fragmentos con `\n\n`, eliminando la duplicación en
 * aquellos marcados con solape.
 *
 * Los fragmentos fallidos entran como `null` y se sustituyen por un marcador
 * visible: nunca se trunca en silencio (§12).
 */
export function joinChunkTexts(
  parts: readonly { text: string | null; hasOverlap: boolean; idx: number }[],
  maxWords = 10,
): string {
  const out: string[] = [];

  for (const part of parts) {
    if (part.text === null || part.text.trim() === '') {
      out.push(`[fragmento ${part.idx + 1} no transcrito]`);
      continue;
    }

    const text = part.text.trim();
    const previous = out.length > 0 ? out[out.length - 1] : undefined;

    if (part.hasOverlap && previous !== undefined && !previous.startsWith('[fragmento ')) {
      const trimmed = dedupeOverlap(previous, text, maxWords);
      out.push(trimmed === '' ? text : trimmed);
    } else {
      out.push(text);
    }
  }

  return out.join('\n\n');
}
