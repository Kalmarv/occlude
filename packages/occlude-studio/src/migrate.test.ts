import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS tool
import { migrateSketchSource } from '../tools/migrate-sketch-source.mjs';

describe('migrateSketchSource', () => {
  it('renames the 2026-09-06 vocabulary and rewrites t.polylines calls to an array-preserving material read', () => {
    const src = [
      "import { sketch, region, trace } from 'occlude';",
      'const d = distanceTo(t.loops(center));',
      'const box = t.polylines(rect(50, 25, 26, 14, { rotate: 20, mode: "center" }))[0];',
      "const s = t.polylines(stroke({ pts: [[0, 0], [10, 0]], closed: false })); // t.polylines(x) in a comment",
      'const keep = t.polylines;',
    ].join('\n');
    expect(migrateSketchSource(src)).toBe([
      "import { sketch, polygon, stroke } from 'occlude';",
      'const d = distanceTo(t.material(center).curves().map((c) => c.pts));',
      'const box = t.material(rect(50, 25, 26, 14, { rotate: 20, mode: "center" })).curves().map((c) => c.pts)[0];',
      "const s = t.material(stroke({ pts: [[0, 0], [10, 0]], closed: false })).curves().map((c) => c.pts); // t.polylines(x) in a comment",
      'const keep = t.polylines;',
    ].join('\n'));
  });

  it('balances parentheses through strings and nested calls, and leaves unbalanced text alone', () => {
    expect(migrateSketchSource("t.polylines(path().moveTo(')', 1).build())")).toBe("t.material(path().moveTo(')', 1).build()).curves().map((c) => c.pts)");
    expect(migrateSketchSource('t.polylines(rect(1')).toBe('t.polylines(rect(1');
  });
});
