// eslint-disable-next-line
// @ts-expect-error node types are not in the studio tsconfig; vitest runs in node
import { readFileSync } from 'node:fs';
// @ts-expect-error see above
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { buildPlan, parseSvg } from './svgImport.js';

describe('svg import', () => {
  test('parses a real splotter export: layers, chains, dimensions', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../test/fixtures/splotter-strokes.svg', import.meta.url)),
      'utf8',
    );
    const svg = parseSvg(text);
    expect(svg.width).toBe(1512);
    expect(svg.height).toBe(835);
    expect(svg.layers.length).toBeGreaterThanOrEqual(1);
    expect(svg.layers[0].name).toBe('silhouettes');
    const chains = svg.layers.reduce((n, l) => n + l.chains.length, 0);
    expect(chains).toBe(77);
    for (const layer of svg.layers) {
      for (const chain of layer.chains) {
        expect(chain.length).toBeGreaterThanOrEqual(4);
        expect(chain.length % 2).toBe(0);
        for (const v of chain) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  test('parses paths with M/L/H/V/Z, absolute and relative', () => {
    const svg = parseSvg(
      '<svg viewBox="0 0 100 100"><g id="a">' +
        '<path d="M 10 10 L 20 10 l 0 10 H 40 V 30 Z"/>' +
        '<path d="m 5 5 l 10 0"/>' +
        '</g></svg>',
    );
    expect(svg.layers[0].chains).toEqual([
      [10, 10, 20, 10, 20, 20, 40, 20, 40, 30, 10, 10],
      [5, 5, 15, 5],
    ]);
  });

  test('rejects transforms and curved paths loudly', () => {
    expect(() =>
      parseSvg('<svg viewBox="0 0 10 10"><g transform="scale(2)"><line x1="0" y1="0" x2="1" y2="1"/></g></svg>'),
    ).toThrow(/transform/);
    expect(() =>
      parseSvg('<svg viewBox="0 0 10 10"><path d="M 0 0 C 1 1 2 2 3 3"/></svg>'),
    ).toThrow(/unsupported path command/);
  });

  test('buildPlan scales into plan format', () => {
    const svg = parseSvg(
      '<svg viewBox="0 0 200 100"><g id="edges"><polyline points="0,0 100,0"/></g></svg>',
    );
    const plan = buildPlan(svg, [0], 150 / svg.width); // 200 units → 150mm
    expect(Array.from(plan)).toEqual([0, 0, 2, 0, 0, 75, 0]);
  });
});
