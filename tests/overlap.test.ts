import { describe, expect, it } from 'vitest';
import { dedupeOverlap, joinChunkTexts } from '@/lib/overlap';

describe('dedupeOverlap', () => {
  it('elimina el prefijo duplicado del segundo fragmento', () => {
    const previous = 'Entonces decidimos migrar toda la base de datos a Postgres el lunes';
    const next = 'a Postgres el lunes por la mañana, antes del despliegue';

    expect(dedupeOverlap(previous, next)).toBe('por la mañana, antes del despliegue');
  });

  it('ignora diferencias de puntuación y mayúsculas', () => {
    const previous = 'y eso fue todo lo que dijo';
    const next = 'Todo lo que dijo. Luego se marchó.';

    expect(dedupeOverlap(previous, next)).toBe('Luego se marchó.');
  });

  it('no recorta cuando sólo coincide una palabra', () => {
    const previous = 'hablamos del presupuesto y';
    const next = 'y ahora pasamos al calendario';

    expect(dedupeOverlap(previous, next)).toBe('y ahora pasamos al calendario');
  });

  it('elige el solape más largo posible', () => {
    const previous = 'uno dos tres cuatro cinco seis';
    const next = 'cuatro cinco seis siete ocho';

    expect(dedupeOverlap(previous, next)).toBe('siete ocho');
  });

  it('no toca el texto cuando no hay solape', () => {
    const previous = 'el informe está terminado';
    const next = 'pasamos al siguiente punto del orden del día';

    expect(dedupeOverlap(previous, next)).toBe('pasamos al siguiente punto del orden del día');
  });

  it('respeta el límite de palabras comparadas', () => {
    const previous = 'a b c d e f g h i j k l m n';
    const next = 'k l m n o p';

    // Con maxWords=10 el solape de 4 palabras (k l m n) cae dentro y se recorta.
    expect(dedupeOverlap(previous, next, 10)).toBe('o p');
    // Con maxWords=3 sólo se comparan las 3 últimas ("l m n") contra las 3
    // primeras ("k l m"): ningún sufijo de una casa con el prefijo de la otra.
    expect(dedupeOverlap(previous, next, 3)).toBe('k l m n o p');
  });

  it('tolera textos vacíos', () => {
    expect(dedupeOverlap('', 'hola mundo')).toBe('hola mundo');
    expect(dedupeOverlap('hola mundo', '')).toBe('');
    expect(dedupeOverlap('   ', '  hola  ')).toBe('hola');
  });

  it('devuelve cadena vacía si el fragmento entero es duplicado', () => {
    expect(dedupeOverlap('uno dos tres', 'dos tres')).toBe('');
  });
});

describe('joinChunkTexts', () => {
  it('une con doble salto de línea y deduplica sólo los solapados', () => {
    const result = joinChunkTexts([
      { idx: 0, hasOverlap: false, text: 'primera parte del audio' },
      { idx: 1, hasOverlap: true, text: 'del audio segunda parte' },
      { idx: 2, hasOverlap: false, text: 'tercera parte' },
    ]);

    expect(result).toBe('primera parte del audio\n\nsegunda parte\n\ntercera parte');
  });

  it('escribe un marcador visible para los fragmentos fallidos', () => {
    const result = joinChunkTexts([
      { idx: 0, hasOverlap: false, text: 'hola' },
      { idx: 1, hasOverlap: false, text: null },
      { idx: 2, hasOverlap: false, text: 'adiós' },
    ]);

    expect(result).toBe('hola\n\n[fragmento 2 no transcrito]\n\nadiós');
  });

  it('no deduplica contra un marcador de fragmento fallido', () => {
    const result = joinChunkTexts([
      { idx: 0, hasOverlap: false, text: null },
      { idx: 1, hasOverlap: true, text: 'fragmento 2 no transcrito seguía la frase' },
    ]);

    expect(result).toBe('[fragmento 1 no transcrito]\n\nfragmento 2 no transcrito seguía la frase');
  });

  it('trata el texto vacío como fragmento no transcrito', () => {
    const result = joinChunkTexts([
      { idx: 0, hasOverlap: false, text: '   ' },
      { idx: 1, hasOverlap: false, text: 'contenido' },
    ]);

    expect(result).toBe('[fragmento 1 no transcrito]\n\ncontenido');
  });

  it('devuelve cadena vacía sin fragmentos', () => {
    expect(joinChunkTexts([])).toBe('');
  });
});
