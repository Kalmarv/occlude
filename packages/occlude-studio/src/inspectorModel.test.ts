import { describe, expect, it } from 'vitest';
import type { InspectionPayload } from 'occlude';
import { InspectorModel, colorFor, columnRange, incidentEdges, otherEnd, pickEdge, pickPoint, prepare, ramp } from './inspectorModel.js';

const identity = (x: number, y: number): [number, number] => [x, y];

function payload(over: Partial<InspectionPayload> = {}): InspectionPayload {
  return {
    name: 'm', n: 4, iteration: 0,
    x: Float64Array.of(0, 10, 10, 0), y: Float64Array.of(0, 0, 10, 10),
    edges: Uint32Array.of(0, 1, 1, 2, 2, 3),
    attrs: { age: Float64Array.of(1, 2, 3, 4) },
    edgeAttrs: { rest: Float64Array.of(2, 2, 2) },
    ...over,
  };
}

describe('columnRange', () => {
  it('reads finite values only and names constant and empty columns', () => {
    expect(columnRange(Float64Array.of(3, 1, 2))).toEqual({ kind: 'range', min: 1, max: 3, finite: 3, missing: 0 });
    expect(columnRange(Float64Array.of(NaN, 1, Infinity, 3))).toEqual({ kind: 'range', min: 1, max: 3, finite: 2, missing: 2 });
    expect(columnRange(Float64Array.of(5, 5, 5))).toEqual({ kind: 'constant', value: 5, finite: 3, missing: 0 });
    expect(columnRange(Float64Array.of(NaN, -Infinity))).toEqual({ kind: 'empty', finite: 0, missing: 2 });
    expect(columnRange(new Float64Array(0))).toEqual({ kind: 'empty', finite: 0, missing: 0 });
  });

  it('colours within the range, one colour for a constant, none for the unavailable', () => {
    const r = columnRange(Float64Array.of(0, 10));
    expect(colorFor(0, r)).toBe(ramp(0));
    expect(colorFor(10, r)).toBe(ramp(1));
    expect(colorFor(5, r)).toBe(ramp(0.5));
    expect(colorFor(NaN, r)).toBeNull();
    expect(colorFor(7, columnRange(Float64Array.of(7, 7)))).toBe(ramp(0.5));
    expect(colorFor(7, columnRange(Float64Array.of(NaN)))).toBeNull();
    expect(ramp(0)).toMatch(/^rgb\(/);
  });
});

describe('prepare and picking', () => {
  it('converts to paper, builds adjacency, and picks points before edges with ties to the lower row', () => {
    const m = prepare(payload(), 3, (x, y) => [x + 100, y + 50]);
    expect(m.px[1]).toBe(110);
    expect(incidentEdges(m, 1)).toEqual([0, 1]);
    expect(incidentEdges(m, 3)).toEqual([2]);
    expect(otherEnd(m, 1, 1)).toBe(2);
    // On top of vertex 1, which lies on edges 0 and 1: the point wins.
    expect(pickPoint(m, 110, 50.2, 0.5)).toBe(1);
    // Midway along edge 0, far from any point.
    expect(pickPoint(m, 105, 50, 0.5)).toBe(-1);
    expect(pickEdge(m, 105, 50.3, 0.5)).toBe(0);
    expect(pickEdge(m, 105, 55, 0.5)).toBe(-1);
    // Equidistant from vertices 0 and 1: the lower row.
    expect(pickPoint(m, 105, 50, 6)).toBe(0);
  });

  it('handles an empty material', () => {
    const m = prepare(payload({ n: 0, x: new Float64Array(0), y: new Float64Array(0), edges: new Uint32Array(0), attrs: {}, edgeAttrs: {} }), 1, identity);
    expect(m.adjStart.length).toBe(1);
    expect(pickPoint(m, 0, 0, 10)).toBe(-1);
    expect(pickEdge(m, 0, 0, 10)).toBe(-1);
  });
});

describe('InspectorModel', () => {
  it('keeps the chosen name across renders when present, clears the selection, ignores stale payloads', () => {
    const im = new InspectorModel();
    im.enabled = true;
    expect(im.onRender(1, [{ name: 'source', points: 4, edges: 3 }, { name: 'grown', points: 9, edges: 8 }])).toBe('source');
    im.choose('grown');
    expect(im.acceptMaterial(prepare(payload({ name: 'grown' }), 1, identity))).toBe(true);
    im.select({ kind: 'point', index: 2 });
    // A newer render: the name survives, the selection does not, the old material waits for its replacement.
    expect(im.onRender(2, [{ name: 'grown', points: 9, edges: 8 }])).toBe('grown');
    expect(im.selection).toBeNull();
    expect(im.material?.executionId).toBe(1);
    // The old execution's payload arriving late is ignored.
    expect(im.acceptMaterial(prepare(payload({ name: 'grown' }), 1, identity))).toBe(false);
    expect(im.acceptMaterial(prepare(payload({ name: 'grown' }), 2, identity))).toBe(true);
    expect(im.material?.executionId).toBe(2);
    // The name vanishes: fall back to the first registered.
    expect(im.onRender(3, [{ name: 'other', points: 1, edges: 0 }])).toBe('other');
    expect(im.material).toBeNull();
    // Nothing registered at all.
    expect(im.onRender(4, [])).toBeNull();
    expect(im.chosen).toBeNull();
  });

  it('colours the selected domain only and pages to the selected row', () => {
    const im = new InspectorModel();
    im.enabled = true;
    im.onRender(1, [{ name: 'm', points: 4, edges: 3 }]);
    im.acceptMaterial(prepare(payload(), 1, identity));
    expect(im.columns()).toEqual(['age']);
    im.attr = 'age';
    expect(im.range()).toMatchObject({ kind: 'range', min: 1, max: 4 });
    im.setDomain('edges');
    expect(im.attr).toBeNull();
    expect(im.columns()).toEqual(['rest']);
    im.attr = 'rest';
    expect(im.range()).toMatchObject({ kind: 'constant', value: 2 });
    expect(im.rowCount()).toBe(3);
    im.select({ kind: 'edge', index: 2 });
    expect(im.page).toBe(0);
    // A column the next material lacks is dropped.
    im.acceptMaterial(prepare(payload({ edgeAttrs: {} }), 1, identity));
    expect(im.attr).toBeNull();
  });

  it('picks through the visibility toggles and resets cleanly', () => {
    const im = new InspectorModel();
    im.enabled = true;
    im.onRender(1, [{ name: 'm', points: 4, edges: 3 }]);
    im.acceptMaterial(prepare(payload(), 1, identity));
    expect(im.pick(10, 0.2, 0.5)).toEqual({ kind: 'point', index: 1 });
    im.showPoints = false;
    // (10, 0.2) lies on edge 1; the corner itself is a tie, which the lower row wins.
    expect(im.pick(10, 0.2, 0.5)).toEqual({ kind: 'edge', index: 1 });
    expect(im.pick(10, 0, 0.5)).toEqual({ kind: 'edge', index: 0 });
    im.showEdges = false;
    expect(im.pick(10, 0.2, 0.5)).toBeNull();
    im.reset();
    expect(im.material).toBeNull();
    expect(im.names).toEqual([]);
    expect(im.executionId).toBe(-1);
  });
});
