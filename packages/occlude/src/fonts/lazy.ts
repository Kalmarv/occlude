/**
 * A bundled face parses the first time a sketch asks it anything, not when
 * the module loads: a `Font` is a plain record, so the deferred one is the
 * same record with getters in front of the parse. Importing `occlude/fonts`
 * therefore costs the font data and nothing else.
 */

import { strokeFont, type Font, type Glyph } from '../strokeFont.js';

/** The face `source()` describes, under the name the library gives it —
 * a `.jhf` file carries no name of its own, and an SVG font's internal
 * name is the foundry's, not the word a sketch writes. */
export function lazyFont(name: string, source: () => string): Font {
  let parsed: Font | undefined;
  const of = (): Font => (parsed ??= strokeFont(source()));
  return {
    get name(): string { return name; },
    get unitsPerEm(): number { return of().unitsPerEm; },
    get ascent(): number { return of().ascent; },
    get descent(): number { return of().descent; },
    get capHeight(): number | undefined { return of().capHeight; },
    get xHeight(): number | undefined { return of().xHeight; },
    glyph: (ch: string): Glyph | undefined => of().glyph(ch),
    advance: (ch: string): number => of().advance(ch),
    kern: (a: string, b: string): number => of().kern(a, b),
    has: (ch: string): boolean => of().has(ch),
  };
}
