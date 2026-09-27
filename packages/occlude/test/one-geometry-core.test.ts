/**
 * The one geometry (Stage F, F1b-core): typed columns on every domain, a
 * `z` point column, stated polygon faces with corners, the internal
 * constructor doors the 3D layer builds through, derivation links on the
 * value, and ids internal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { append, curve, distanceTo, force, material, point, polygon, strokes, type Material } from '../src/index.js';
import { materialFromParts, partsOfMaterial, type Vertex } from '../src/material.js';
import { Column, kinds } from '../src/column.js';
import { identity } from '../src/placement.js';
import { spaceOf } from '../src/space.js';
import { grid } from '../src/layout.js';
import { plane } from '../src/three/api/index.js';
import { square } from './helpers/shapes.js';
import { toolkit } from './helpers/run.js';

/** A ring of four points and four edges. */

/** A placement to keep in a column: the frame of a point of `along`. */
const somePlacement = () => square().along({ count: 4 }).points.at(1).placement();

/** A cube: 8 points, 6 quads (outward), its 12 edges added by the door. */
function cube(cols = false): Material {
  const x = [0, 1, 1, 0, 0, 1, 1, 0];
  const y = [0, 0, 1, 1, 0, 0, 1, 1];
  const z = [0, 0, 0, 0, 1, 1, 1, 1];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return materialFromParts({
    x, y, z,
    faces: quads.map((loop, f) => ({
      loop,
      ...(cols ? { cols: { side: f, lit: f % 2 === 0, name: `f${f}`, n: [0, 0, f] } } : {}),
      ...(cols ? { corners: loop.map((p, k) => ({ uv: [k, p], seam: k === 0 })) } : {}),
    })),
  });
}

/** The stated faces of a value, read back. */
const stated = (m: Material) => partsOfMaterial(m).faces;

describe('typed columns on points, edges and faces', () => {
  it('a column takes its kind from the value: boolean, string, vector, reference, placement', () => {
    const place = somePlacement();
    const m = square();
    const anchor = m.points.at(0);
    const g = m.points.set({ ground: true, tag: 'a', n: [0, 0, 1], parent: anchor, frame: place });
    const p = g.points.at(2);
    expect(p.ground).toBe(true);
    expect(p.tag).toBe('a');
    expect(p.n).toEqual([0, 0, 1]);
    expect(Object.isFrozen(p.n)).toBe(true);
    // A reference reads as the row it names, in the state that holds it.
    expect(p.parent).toBe(g.points.at(0));
    expect(p.frame).toBe(place);
    // Each is a column of its own, read by name on every row.
    expect(Object.keys(p)).toEqual(['index', 'x', 'y', 'ground', 'tag', 'n', 'parent', 'frame']);
  });

  it('a function names the kind with its first value, and a write reaches only the rows it names', () => {
    const g = square().points.set('high', (p: Vertex) => p.y > 5);
    expect(g.points.map((p) => p.high)).toEqual([false, false, true, true]);
    const h = g.points.set('high', false, (p: Vertex) => p.x > 5);
    expect(h.points.map((p) => p.high)).toEqual([false, false, false, true]);
    // An edge column of strings, set on some edges.
    const e = square().edges.set('kind', 'wall').edges.set('kind', 'door', (e) => e.index === 1);
    expect(e.edges.map((r) => r.kind)).toEqual(['wall', 'door', 'wall', 'wall']);
  });

  it('refuses a policy a kind cannot follow, by name', () => {
    expect(() => square().points.set('ground', true, { transfer: 'interpolate' })).toThrow(/never interpolates/);
    expect(() => square().edges.set('kind', 'wall', { transfer: 'distribute' })).toThrow(/never shares out/);
    // 'nearest' and 'copy' say what happens anyway, and are taken.
    expect(square().points.set('ground', true, { transfer: 'nearest' }).transfers.ground).toBe('nearest');
  });

  it('a split carries a non-interpolating kind by the parent value, and a vector interpolates', () => {
    const m = square();
    const h = m.points.set({ tag: (p: Vertex) => `p${p.index}`, lit: (p: Vertex) => p.index === 1, parent: m.points.at(3), n: (p: Vertex) => [p.index, 0] })
      .edges.set({ kind: (e) => `e${e.index}` });
    const cut = h.split(h.edges.at(0), 0.25);
    const mid = cut.points.at(cut.points.length - 1);
    // Edge 0 runs point 0 → point 1; a quarter of the way is nearer point 0.
    expect(mid.tag).toBe('p0');
    expect(mid.lit).toBe(false);
    expect(mid.parent).toBe(cut.points.at(3));
    expect(mid.n).toEqual([0.25, 0]);
    // Both children copy the parent's string.
    const kids = cut.edges.filter((e) => e.a === mid || e.b === mid);
    expect(kids.map((e) => e.kind)).toEqual(['e0', 'e0']);
  });

  it('typed columns ride through add, remove, extract, append and a transform', () => {
    const g = square().points.set({ tag: 'a', lit: true });
    const added = g.points.add([5, 5], { tag: 'new', lit: false });
    expect(added.points.at(4).tag).toBe('new');
    expect(added.points.at(4).lit).toBe(false);
    expect(() => g.points.add([5, 5], { tag: 3, lit: true } as never)).toThrow(/'tag' holds a string a row/);
    const less = added.points.remove(added.points.at(0));
    expect(less.points.map((p) => p.tag)).toEqual(['a', 'a', 'a', 'new']);
    const part = added.points.filter((p) => p.index > 2).extract();
    expect(part.points.map((p) => p.tag)).toEqual(['a', 'new']);
    const both = append(g, square().points.set({ tag: 'b', lit: false }));
    expect(both.points.map((p) => p.tag)).toEqual(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']);
    expect(() => append(g, square())).toThrow(/has no column 'tag'/);
    expect(append(g, square(), { fill: { tag: 'c', lit: false } }).points.at(5).tag).toBe('c');
    expect(g.translate([1, 1]).points.at(0).tag).toBe('a');
  });

  it('a point value and an edge value carry typed columns into the rows they become', () => {
    const m = square();
    const q = point([5, 5], { tag: 'q', lit: true });
    const g = m.points.add(q).edges.add([m.points.at(0), q], { kind: 'spoke' });
    expect(g.points.at(4).tag).toBe('q');
    expect(g.edges.at(4).kind).toBe('spoke');
  });

  it('face columns take any kind, and refuse a second', () => {
    const g = grid({ w: 20, h: 10 }, { cols: 2, rows: 1 });
    const h = g.faces.set({ lit: (f) => f.index === 0, name: 'cell', n: [1, 2, 3] });
    expect(h.faces.map((f) => f.lit)).toEqual([true, false]);
    expect(h.faces.at(1).name).toBe('cell');
    expect(h.faces.at(1).n).toEqual([1, 2, 3]);
    expect(() => h.faces.set('lit', 2)).toThrow(/'lit' holds a boolean a row/);
    // A face nothing wrote reads the fallback, else the kind's default.
    const one = g.faces.set('name', 'only', g.faces.at(0));
    expect(one.faces.map((f) => f.name)).toEqual(['only', '']);
    expect(g.faces.set('name', 'x', g.faces.at(0), { fallback: 'none' }).faces.at(1).name).toBe('none');
  });
});

/** The one write, on a value in the plane and on a sheet in space: what
 * `points.set` promises does not depend on where the value lives. */
describe.each([
  ['in the plane', (): Material => square()],
  ['in space', (): Material => plane(2, 2).subdivide(2)],
])('points.set %s', (_, make) => {
  it('writes a number, a string, a boolean and a vector on every point', () => {
    const m = make().points.set({ h: (p: Vertex) => p.x + p.y, name: 'a', on: true, dir: [0, 0, 1] });
    expect(m.points.every((p) => p.h === p.x + p.y && p.name === 'a' && p.on === true)).toBe(true);
    expect(m.points.at(0).dir).toEqual([0, 0, 1]);
    expect(Object.isFrozen(m.points.at(0).dir)).toBe(true);
  });

  it('writes only where a predicate, a selection or one row says', () => {
    const m = make().points.set('h', 0);
    const right = m.points.filter((p) => p.x > 0);
    expect(m.points.set('h', 1, (p: Vertex) => p.x > 0).points.filter((p) => p.h === 1).indices).toEqual(right.indices);
    expect(m.points.set('h', 2, right).points.filter((p) => p.h === 2).indices).toEqual(right.indices);
    expect(m.points.set('h', 3, m.points.at(3)).points.filter((p) => p.h === 3).indices).toEqual([3]);
  });

  it('reads a selection of an earlier state of the same rows', () => {
    const first = make().points.set('h', 0);
    const picked = first.points.filter((p) => p.x <= 0);
    const later = first.move([0, 1]);
    expect(later.points.set('h', 1, picked).points.filter((p) => p.h === 1).indices).toEqual(picked.indices);
  });

  it('reads every function against the rows as they were before the write', () => {
    const m = make().points.set({ u: 1, w: 2 });
    expect(m.points.set({ u: (p: Vertex) => p.w, w: (p: Vertex) => p.u }).points.every((p) => p.u === 2 && p.w === 1)).toBe(true);
    const spike = m.points.set('u', (p: Vertex) => (p.index === 2 ? 9 : 0));
    const spread = spike.points.set('u', (p: Vertex) => Math.max(p.u, ...p.adjacent.map((q) => q.u)));
    expect(spread.points.filter((p) => p.u === 9).length).toBe(1 + spike.points.at(2).adjacent.length);
  });

  it('a new column written on some rows is the kind\'s default on the rest', () => {
    const out = make().points.set('tag', 'top', (p: Vertex) => p.y > 0);
    expect(out.points.filter((p) => p.y <= 0).every((p) => p.tag === '')).toBe(true);
    expect(out.points.filter((p) => p.y > 0).every((p) => p.tag === 'top')).toBe(true);
  });

  it('keeps one kind per column, and refuses another kind, a position that is not a number and a reserved name, by name', () => {
    const g = make().points.set('ground', true);
    expect(() => g.points.set('ground', 1)).toThrow(/'ground' holds a boolean a row, and this value is a number/);
    expect(() => g.points.set('ground', (p: Vertex) => (p.index === 2 ? 'x' : true))).toThrow(/'ground' holds a boolean/);
    const n = make().points.set('n', [1, 2]);
    expect(() => n.points.set('n', [1, 2, 3])).toThrow(/holds a vector of 2 a row, and this value is a vector of 3/);
    expect(() => make().points.set('z', true)).toThrow(/'z' is a position, a number/);
    expect(() => make().points.set('bad', { a: 1 } as never)).toThrow(/a number, a boolean, a string, a list of numbers, a row or a placement/);
    expect(() => make().points.set('id', 1)).toThrow(/'id' is a reserved field of a point/);
  });
});

describe('a z column: the one geometry in space', () => {
  it('material() of [x, y, z] makes it; rows answer z; a move with a 3-vector and a set write it', () => {
    const m = material([[0, 0, 1], [1, 0, 2], [1, 1, 3]]);
    expect(m.points.map((p) => p.z)).toEqual([1, 2, 3]);
    expect(m.attrs.z).toBeInstanceOf(Float64Array);
    const moved = m.move([0, 0, 10]);
    expect(moved.points.map((p) => [p.x, p.y, p.z])).toEqual([[0, 0, 11], [1, 0, 12], [1, 1, 13]]);
    const byFn = m.move((p) => [1, 0, -p.z]);
    expect(byFn.points.map((p) => p.z)).toEqual([0, 0, 0]);
    expect(m.points.set('z', 7).points.map((p) => p.z)).toEqual([7, 7, 7]);
    // A move in the plane leaves z as it is.
    expect(m.move([1, 1]).points.map((p) => p.z)).toEqual([1, 2, 3]);
  });

  it('a value in the plane has none until a 3D step gives it one; a new point needs its z', () => {
    const flat = square();
    expect(flat.points.at(0).z).toBeUndefined();
    const lifted = flat.move([0, 0, 2], flat.points.at(0));
    expect(lifted.points.map((p) => p.z)).toEqual([2, 0, 0, 0]);
    // A new point of a 3D value names its z: a 3-place gives it, a pair is refused by name.
    expect(lifted.points.add([5, 5, 9]).points.at(4).z).toBe(9);
    expect(() => lifted.points.add([5, 5])).toThrow(/must give 'z'/);
    // An edge measures in 3D, a split interpolates z.
    const e = material([[0, 0, 0], [3, 0, 4]], { edges: [[0, 1]] });
    expect(e.edges.at(0).length).toBe(5);
    expect(e.split(e.edges.at(0)).points.at(2).z).toBe(2);
    // Extrude grows level with its point, or by the offset's third number.
    expect(e.extrude(e.points.at(1), [1, 0]).points.at(2).z).toBe(4);
    expect(e.extrude(e.points.at(1), [1, 0, -4]).points.at(2).z).toBe(0);
  });

  it('a value in space that states no faces has no area: every area consumer reads it as empty, and none throws', () => {
    const t = toolkit({ aspect: [1, 1] });
    const flat = curve([[10, 10], [20, 10], [20, 20], [10, 20]], { closed: true });
    const lifted = flat.move([0, 0, 1]);
    const open = curve([[10, 10, 1], [20, 10, 1], [20, 20, 1]]);
    expect(flat.contours()).toHaveLength(1);
    expect(flat.curves.at(0).contours()).toHaveLength(1);
    expect(flat.curves.contours()).toHaveLength(1);
    for (const v of [lifted, open]) {
      expect(v.faces.length).toBe(0);
      expect(v.contours()).toEqual([]);
      // Nor has a curve of it, or its curves.
      expect(v.curves.at(0).contours()).toEqual([]);
      expect(v.curves.contours()).toEqual([]);
      // Nothing to fill, nothing inside, nothing to measure to.
      for (const area of [v, v.edges, v.curves.at(0)]) expect(polygon(area).geom).toMatchObject({ kind: 'path', cmds: [] });
      expect(t.within(t.scatter({ spacing: 5 }), v).n).toBe(0);
      expect(t.within(() => 1, v)(15, 15)).toBeNaN();
      expect(t.distanceTo(v)(15, 15)).toBe(-Infinity);
      expect(distanceTo(v)(15, 15)).toBe(-Infinity);
      expect(force.boundary(v, { radius: 5 })([15, 15])).toEqual([0, 0]);
      // Its chains are still ink.
      expect(strokes(v).length).toBeGreaterThan(0);
    }
    // A value in space with stated faces keeps its contours.
    const quad = plane(20);
    expect(quad.faces.length).toBe(1);
    expect(quad.contours()).toHaveLength(1);
    expect(polygon(quad).geom).not.toMatchObject({ cmds: [] });
  });
});

describe('stated polygon faces with corners', () => {
  it('a mesh states its faces: loops of point rows, any size, with a corner per face-vertex pair', () => {
    const c = cube(true);
    expect(c.points.length).toBe(8);
    expect(c.edges.length).toBe(12);
    expect(c.faces.length).toBe(6);
    expect(c.corners.length).toBe(24);
    const k = c.corners.at(5);
    // Face 1 is [4, 5, 6, 7]: its second corner is at point 5.
    expect(k.face).toBe(c.faces.at(1));
    expect(k.point).toBe(c.points.at(5));
    expect(k.uv).toEqual([1, 5]);
    expect(k.seam).toBe(false);
    expect(c.faces.at(3).side).toBe(3);
    expect(c.faces.at(2).lit).toBe(true);
    expect(c.faces.at(4).name).toBe('f4');
    expect(c.faces.at(5).n).toEqual([0, 0, 5]);
    // Relations: the corners' points and faces, and a face selection's corners.
    expect(c.corners.filter((q) => q.point.index === 0).faces.length).toBe(3);
    expect(c.faces.at(1).index).toBe(1);
    expect(c.faces.filter((f) => f.index < 2).corners.length).toBe(8);
    expect(c.corners.slice(0, 4).points.indices).toEqual([0, 1, 2, 3]);
  });

  it('corner columns take any kind and are kept through a move and a set; an edge write drops them', () => {
    const c = cube();
    expect(c.corners.at(0).uv).toBeUndefined();
    const lit = c.corners.set({ uv: (q) => [q.index, 0], hard: (q) => q.face.index === 0 });
    expect(lit.corners.at(3).uv).toEqual([3, 0]);
    expect(lit.corners.filter((q) => q.hard).length).toBe(4);
    expect(() => lit.corners.set('hard', 1)).toThrow(/'hard' holds a boolean a row/);
    expect(() => lit.corners.set('uv', [0, 0], { transfer: 'nearest' } as never)).toThrow(/takes no options/);
    // A move keeps the edges, so the faces and their corners stay.
    const moved = lit.move([0, 0, 1]).points.set('w', 1);
    expect(moved.faces.length).toBe(6);
    expect(moved.corners.length).toBe(24);
    expect(moved.corners.at(3).uv).toEqual([3, 0]);
    // A corner of an earlier state is found by its face and point.
    expect(moved.corners.has(lit.corners.at(7))).toBe(true);
    // An edge write changes the edges: the statement and its corners go.
    const cut = lit.edges.remove(lit.edges.at(0));
    expect(cut.stated).toBeUndefined();
    expect(cut.corners.length).toBe(0);
  });

  it('a geometry with no stated faces has no corners: an empty selection', () => {
    expect(square().corners.length).toBe(0);
    expect([...square().corners]).toEqual([]);
    expect(() => cube().corners.adjacent()).toThrow(/corner has no neighbours/);
  });
});

describe('the internal constructor doors', () => {
  it('materialFromParts and partsOfMaterial round-trip', () => {
    const place = somePlacement();
    const x = [0, 2, 2, 0];
    const y = [0, 0, 2, 2];
    const z = [1, 1, 1, 1];
    const m = materialFromParts({
      x, y, z,
      pointCols: { w: Float64Array.from([1, 2, 3, 4]), up: kinds.vector(3).from([[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]]) },
      edges: [0, 1, 1, 2],
      edgeCols: { crease: kinds.boolean.from([true, false]) },
      faces: [{ loop: [0, 1, 2, 3], cols: { frame: place, h: 2 }, corners: [{ uv: [0, 0] }, { uv: [1, 0] }, undefined, { uv: [0, 1] }] }],
      ids: { points: [101, 102, 103, 104], edges: [201, 202] },
    });
    const back = partsOfMaterial(m);
    expect([...back.x]).toEqual(x);
    expect([...back.y]).toEqual(y);
    expect([...back.z!]).toEqual(z);
    expect(Object.keys(back.pointCols)).toEqual(['w', 'up']);
    expect(back.pointCols.w).toBeInstanceOf(Column);
    // The loop's two missing sides were added after the given edges.
    expect([...back.edges]).toEqual([0, 1, 1, 2, 2, 3, 3, 0]);
    expect([...back.ids.points]).toEqual([101, 102, 103, 104]);
    expect([...back.ids.edges].slice(0, 2)).toEqual([201, 202]);
    expect(m.edges.map((e) => e.crease)).toEqual([true, false, false, false]);
    const faces = back.faces!;
    expect(faces.loops).toEqual([[0, 1, 2, 3]]);
    // Face columns come back as columns of the kind each holds.
    const values = (c: { length: number; get(i: number): unknown }) => Array.from({ length: c.length }, (_, i) => c.get(i));
    expect(values(faces.cols.frame)).toEqual([place]);
    expect(values(faces.cols.h)).toEqual([2]);
    expect([...faces.corners.point]).toEqual([0, 1, 2, 3]);
    expect(m.corners.map((q) => q.uv)).toEqual([[0, 0], [1, 0], [0, 0], [0, 1]]);
    // The parts, read back, build the same value again.
    const again = materialFromParts({
      x: back.x, y: back.y, z: back.z, pointCols: back.pointCols, edges: back.edges, edgeCols: back.edgeCols,
      faces: faces.loops.map((loop, f) => ({ loop, cols: { frame: faces.cols.frame.get(f) as never, h: faces.cols.h.get(f) as number } })),
      ids: back.ids,
    });
    expect(again.points.map((p) => [p.x, p.y, p.z, p.w, p.up])).toEqual(m.points.map((p) => [p.x, p.y, p.z, p.w, p.up]));
    expect(values(partsOfMaterial(again).faces!.cols.frame)).toEqual([place]);
    expect(again.faces.at(0).frame).toBe(place);
  });

  it('refuses wrong parts by name', () => {
    expect(() => materialFromParts({ x: [0, 1], y: [0] })).toThrow(/2 x and 1 y/);
    expect(() => materialFromParts({ x: [0, 1, 1], y: [0, 0, 1], faces: [{ loop: [0, 1] }] })).toThrow(/loop of 2 points/);
    expect(() => materialFromParts({ x: [0, 1, 1], y: [0, 0, 1], faces: [{ loop: [0, 1, 7] }] })).toThrow(/names point 7/);
    expect(() => materialFromParts({ x: [0, 1, 1], y: [0, 0, 1], faces: [{ loop: [0, 1, 2], cols: { a: 1 } }, { loop: [0, 2, 1], cols: { a: 'b' } }] })).toThrow(/would hold a number and a string/);
  });

  it('links the rows it makes to where they came from, on the value', () => {
    const input = cube();
    const m = materialFromParts({
      x: [0, 1, 0], y: [0, 0, 1],
      source: { points: { source: { of: input, domain: 'faces', rows: [0, 1, 2] } } },
    });
    expect(m.points.at(1).source).toBe(input.faces.at(1));
  });
});

describe('links live on the value', () => {
  it('a split keeps its links and node in the value, and a write carries them', () => {
    const m = square();
    const cut = m.split(m.edges.at(0));
    expect(cut.points.at(4).source).toBe(m.edges.at(0));
    const moved = cut.move([1, 0]);
    expect(moved.points.at(4).source).toBe(m.edges.at(0));
  });
});

describe('ids are internal', () => {
  /** The members a published type declares, read as syntax from the
   * declarations the build emits (stripInternal). The index signature on a
   * row type types any name as a number, so an `@ts-expect-error` on
   * `p.id` cannot say this; the member list can. */
  const members = (file: string, name: string): string[] => {
    const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
    const text = ts.transpileDeclaration(readFileSync(path, 'utf8'), { fileName: file, compilerOptions: { stripInternal: true, declaration: true } }).outputText;
    const out: string[] = [];
    const take = (list: ts.NodeArray<ts.TypeElement | ts.ClassElement>) => {
      for (const m of list) if (m.name !== undefined && ts.isIdentifier(m.name)) out.push(m.name.text);
    };
    const parts = (t: ts.TypeNode): void => {
      if (ts.isTypeLiteralNode(t)) take(t.members);
      else if (ts.isIntersectionTypeNode(t)) t.types.forEach(parts);
      else if (ts.isParenthesizedTypeNode(t)) parts(t.type);
    };
    ts.forEachChild(ts.createSourceFile(`${file}.d.ts`, text, ts.ScriptTarget.Latest), (node) => {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text === name) take(node.members);
      if (ts.isTypeAliasDeclaration(node) && node.name.text === name) parts(node.type);
    });
    expect(out.length, `${name} declared in ${file}`).toBeGreaterThan(0);
    return out;
  };

  it('m.pointOf, m.edgeOf, p.id, e.id and e.root are absent from the typings', () => {
    const material = members('material.ts', 'Material');
    expect(material).toContain('split');
    expect(material).not.toContain('pointOf');
    expect(material).not.toContain('edgeOf');
    expect(members('material.ts', 'Vertex')).toContain('adjacent');
    expect(members('material.ts', 'Vertex')).not.toContain('id');
    // Lineage is identity: an edge's root is internal as its id is.
    expect(members('material.ts', 'Edge')).toContain('center');
    expect(members('material.ts', 'Edge')).not.toContain('root');
    expect(members('material.ts', 'Edge')).not.toContain('id');
    expect(members('tables.ts', 'PointValue')).toContain('x');
    expect(members('tables.ts', 'PointValue')).not.toContain('id');
  });

  it('a sketch never needs them: the value is the name', () => {
    const m = square();
    const later = m.split(m.edges.at(0));
    // A row of an earlier state is found by holding it.
    expect(later.points.has(m.points.at(2))).toBe(true);
    expect(later.points.without(m.points).length).toBe(1);
  });
});

describe('the 3D words: called where the core declares them', () => {
  it('a shared word is told apart by what it takes', () => {
    const flat = square();
    // The plane's words stay the plane's.
    expect(flat.translate([1, 2]).points.at(0).x).toBe(1);
    expect(flat.rotate(90).points.length).toBe(4);
    expect(flat.scale(2).points.at(1).x).toBe(20);
    expect(flat.translate([1, 2]).points.at(0).z).toBeUndefined();
    // A 3-vector, angles, an axis or three factors are words of space.
    expect(flat.translate([1, 2, 3]).points.at(0).z).toBe(3);
    const c = cube();
    const at = (m: Material) => m.points.map((p) => [p.x, p.y, p.z]);
    // On a value in space a number of degrees turns about z, and one factor
    // scales all three axes, about the same pivot as the vector forms.
    expect(at(c.translate([2, 0, 0]).rotate(90))).toEqual(at(c.translate([2, 0, 0]).rotate('z', 90)));
    expect(at(c.translate([2, 0, 0]).scale(2))).toEqual(at(c.translate([2, 0, 0]).scale([2, 2, 2])));
    expect(c.extrude(c.faces.filter((f) => f.index === 0), 0.5).faces.length).toBe(10);
    expect(() => flat.extrude(flat.faces, 1)).toThrow('extrude: faces extrude in space — a value with z');
  });

  it('a motion that is not finite moves nothing, in the plane and in space', () => {
    const flat = square(), c = cube();
    for (const m of [flat.translate([NaN, 0]), flat.rotate(NaN), flat.scale(Infinity), flat.rotate(90, { origin: [NaN, 0] })]) expect(m).toBe(flat);
    for (const m of [c.translate([NaN, 0, 0]), c.rotate('z', NaN), c.rotate([0, NaN, 0]), c.scale([1, NaN, 1]), c.scale(2, { origin: [NaN, 0, 0] })]) expect(m).toBe(c);
  });

  it('row words in space: face normal, area and centroid on the fixed triangles, 3D edge centre, point faces and corners', () => {
    const c = cube();
    expect(c.faces.at(2).normal).toEqual([0, -1, 0]);
    expect(c.faces.at(2).area).toBe(1);
    expect(c.faces.at(1).centroid).toEqual([0.5, 0.5, 1]);
    const e = c.edges.at(0);
    expect(e.center.length).toBe(3);
    expect(c.points.at(0).faces.length).toBe(3);
    expect(c.points.at(0).corners.length).toBe(3);
    // Selections of points and edges answer no `faces`: that word is the area protocol's.
    expect('faces' in c.points).toBe(false);
    expect(c.edges.at(0).faces.length).toBe(2);
    // A face in the plane looks up.
    expect(grid({ w: 10, h: 10 }, { cols: 1, rows: 1 }).faces.at(0).normal).toEqual([0, 0, 1]);
  });

  it('length: every edge, summed, in the value’s space and in 3D with a z', () => {
    expect(square().length).toBe(40);
    expect(material([[0, 0, 0], [3, 0, 4]], { edges: [[0, 1]] }).length).toBe(5);
  });

  it('the kernel’s row names ride beside the ids, and a row a write makes has none', () => {
    const m = materialFromParts({ x: [0, 1, 1], y: [0, 0, 1], edges: [0, 1], keys: { points: ['a', 'b', 'c'], edges: ['ab'] }, faces: [{ loop: [0, 1, 2] }] });
    expect(partsOfMaterial(m).keys.points).toEqual(['a', 'b', 'c']);
    expect(partsOfMaterial(m).keys.edges).toEqual(['ab', '', '']);
    expect(partsOfMaterial(m.move([1, 0])).keys.points).toEqual(['a', 'b', 'c']);
    const split = m.split(m.edges.at(0));
    expect(partsOfMaterial(split).keys.points).toEqual(['a', 'b', 'c', '']);
    expect(partsOfMaterial(m.points.filter((p) => p.index > 0).extract()).keys.points).toEqual(['b', 'c']);
    // Nothing a sketch reads names them: not a column, not on a row.
    expect(Object.keys(m.points.at(0))).toEqual(['index', 'x', 'y']);
    expect(stated(m)!.ids.faces).toHaveLength(1);
  });

  it('a source read row by row answers each row the first time it asks', () => {
    const input = cube();
    let reads = 0;
    const m = materialFromParts({ x: [0, 1], y: [0, 0], source: { points: (r) => { reads++; return r === 0 ? input.faces.at(4) : undefined; } } });
    expect(m.points.at(0).source).toBe(input.faces.at(4));
    expect(m.points.at(0).source).toBe(input.faces.at(4));
    expect(m.points.at(1).source).toBeUndefined();
    expect(m.points.set('w', 1).points.at(0).source).toBe(input.faces.at(4));
    expect(reads).toBe(2);
  });
});

describe('a column of the row’s own wins over a row word', () => {
  it('a tangent the library keeps reads as the column; a sketch writes none', () => {
    // 3D `along` keeps each point's tangent as a column: there is no
    // heading in space.
    const m = materialFromParts({ x: [0, 1], y: [0, 0], z: [0, 0], pointCols: { tangent: kinds.vector(3).from([[1, 0, 0], [0, 0, 1]]) } });
    expect(m.points.at(0).tangent).toEqual([1, 0, 0]);
    expect(m.points.at(1).tangent).toEqual([0, 0, 1]);
    expect(() => m.points.set('tangent', [0, 1, 0])).toThrow(/'tangent' is a reserved field of a point/);
    // Without one, the words read the heading, as before.
    const along = square().along({ count: 4 }).points.at(1);
    expect(along.tangent.length).toBe(2);
    expect(typeof along.placement().point).toBe('function');
  });
});

describe('a face answers its corners', () => {
  it('round its loop, and none for a face read off the picture', () => {
    const c = cube().corners.set('heat', (q) => q.index);
    expect(c.faces.at(1).corners.map((q) => q.index)).toEqual([4, 5, 6, 7]);
    expect(c.faces.at(1).corners.mean('heat')).toBe(5.5);
    expect(c.corners.at(5).face.corners.length).toBe(4);
    expect(material([[0, 0], [1, 0], [0, 1]], { edges: [[0, 1], [1, 2], [2, 0]] }).faces.at(0).corners.length).toBe(0);
  });
});

describe('one write reads its record row by row on every domain', () => {
  it('points, edges, faces and corners: each row, its fields in record order', () => {
    const order = (write: (next: () => number) => Material, read: (m: Material) => number[][]) => {
      let k = 0;
      return read(write(() => k++));
    };
    const g = grid({ w: 20, h: 10 }, { cols: 2, rows: 1 });
    expect(order((n) => g.faces.set({ a: n, b: n }), (m) => m.faces.map((f) => [f.a, f.b]))).toEqual([[0, 1], [2, 3]]);
    expect(order((n) => square().points.set({ a: n, b: n }), (m) => m.points.slice(0, 2).map((p) => [p.a, p.b]))).toEqual([[0, 1], [2, 3]]);
    expect(order((n) => square().edges.set({ p: n, q: n }), (m) => m.edges.slice(0, 2).map((e) => [e.p, e.q]))).toEqual([[0, 1], [2, 3]]);
    expect(order((n) => cube().corners.set({ a: n, b: n }), (m) => m.corners.slice(0, 2).map((c) => [c.a, c.b]))).toEqual([[0, 1], [2, 3]]);
  });
});

describe('near on a value in space', () => {
  it('points.near measures in space, nearest first, ties by row; a point of the value is not its own neighbour', () => {
    const c = cube();
    // Points 0 and 4 share x and y; only z tells them apart.
    expect(c.points.near([0, 0, 0.9], { radius: 0.5 }).indices).toEqual([4]);
    expect(c.points.near({ x: 0, y: 0, z: 0 }, { radius: 1.01 }).indices).toEqual([0, 1, 3, 4]);
    expect(c.points.near(c.points.at(0), { radius: 1.01 }).indices).toEqual([1, 3, 4]);
    expect(c.points.near([0.1, 0, 0], { radius: 1.2 }).indices).toEqual([0, 1, 3, 4]);
    expect(c.points.filter((p) => p.z === 1).near([0, 0, 0], { radius: 1.01 }).indices).toEqual([4]);
    expect(() => c.points.near([0, 0], { radius: 1 })).toThrow(/points.near: this value is in space/);
  });

  it('edges.near measures to the whole segment in space', () => {
    const c = cube();
    const near = c.edges.near([0.5, 0, 0.05], { radius: 0.1 });
    expect(near.length).toBe(1);
    const e = near.at(0);
    expect([e.a.index, e.b.index].sort()).toEqual([0, 1]);
    // The top edge above it is as near in x and y, and far in space.
    expect(c.edges.near([0.5, 0, 1], { radius: 0.1 }).map((q) => [q.a.z, q.b.z])).toEqual([[1, 1]]);
    expect(() => c.edges.near([0.5, 0], { radius: 0.1 })).toThrow(/edges.near: this value is in space/);
  });

  it('a value in the plane measures as it always has', () => {
    expect(square().points.near([0, 0], { radius: 10.5 }).indices).toEqual([0, 1, 3]);
  });
});

describe('a transfer by column after the record form of set', () => {
  it('points: { transfer: { b: … } } declares b alone; a split follows each column its way', () => {
    const m = curve([[0, 0], [10, 0]]).points.set({ a: (p: Vertex) => p.x, b: (p: Vertex) => p.x }, { transfer: { b: 'nearest' } });
    expect(m.transfers).toEqual({ b: 'nearest' });
    const cut = m.split(m.edges.at(0), 0.3);
    const mid = cut.points.at(2);
    expect(mid.a).toBeCloseTo(3);
    expect(mid.b).toBe(0);
    // With a where, the record still comes last; the default restores.
    const back = m.points.set({ a: 1, b: 1 }, m.points.at(0), { transfer: { b: 'interpolate' } });
    expect(back.transfers).toEqual({});
  });

  it('edges and faces take the record too', () => {
    const e = square().edges.set({ w: 1, v: 2 }, { transfer: { v: 'distribute' } });
    expect(e.edgeTransfers).toEqual({ v: 'distribute' });
    const f = cube().faces.set({ h: 1, k: 2 }, { transfer: { k: 'drop' } });
    expect(f.faceAttrs.h.transfer).toBe('nearest');
    expect(f.faceAttrs.k.transfer).toBe('drop');
  });

  it('refuses a record in the one-column form, a column the write does not write, and a wrong word', () => {
    const m = square();
    expect(() => m.points.set('b', 1, { transfer: { b: 'nearest' } } as never)).toThrow(/one column's transfer is a word/);
    expect(() => m.points.set({ a: 1 }, { transfer: { b: 'nearest' } })).toThrow(/transfer names 'b', and this write does not write it/);
    expect(() => m.points.set({ a: 1 }, { transfer: { a: 'copy' } } as never)).toThrow(/the transfer of 'a' is 'interpolate' or 'nearest'/);
    expect(() => m.points.set({ x: 1 }, { transfer: { x: 'nearest' } })).toThrow(/a position has no transfer policy/);
    expect(() => m.points.set({ t: true }, { transfer: { t: 'interpolate' } })).toThrow(/never interpolates/);
    expect(() => cube().faces.set({ h: 1 }, { transfer: { h: 'copy' } } as never)).toThrow(/the transfer of 'h' is 'nearest' or 'drop'/);
  });
});

describe('a face has one word for its middle', () => {
  it('face.center refuses by name, and is no column name', () => {
    const c = cube(true);
    const f = c.faces.at(0);
    expect(() => (f as unknown as { center: unknown }).center).toThrow(/a face's middle is its centroid/);
    expect(Object.keys({ ...f })).not.toContain('center');
    expect(() => c.faces.set('center', 1)).toThrow(/'center' is a reserved field of a face/);
  });
});

describe('extracting stated faces keeps the statement', () => {
  it('four side faces of a box come back as those four faces, with their columns, corners, ids and names', () => {
    const c = cube(true);
    const sides = c.faces.filter((f) => f.index >= 2);
    const out = sides.extract();
    expect(out.stated).toBeDefined();
    expect(out.faces.length).toBe(4);
    expect(out.points.length).toBe(8);
    expect(out.edges.length).toBe(12);
    expect(out.faces.map((f) => f.side)).toEqual([2, 3, 4, 5]);
    expect(out.faces.map((f) => f.name)).toEqual(['f2', 'f3', 'f4', 'f5']);
    expect(out.corners.length).toBe(16);
    expect(out.corners.map((q) => q.uv)).toEqual(sides.corners.map((q) => q.uv));
    const before = stated(c)!;
    const after = stated(out)!;
    expect([...after.ids.faces!]).toEqual([2, 3, 4, 5].map((f) => before.ids.faces![f]));
    expect([...after.ids.corners!]).toEqual([...before.ids.corners!].slice(8));
    // The loops name the extracted rows: the same places.
    const place = (m: Material, p: number) => [m.x[p], m.y[p], m.attrs.z[p]];
    expect(after.loops.map((l) => l.map((p) => place(out, p)))).toEqual(before.loops.slice(2).map((l) => l.map((p) => place(c, p))));
    // The rows keep their identity: the selection finds its members.
    expect(out.points.intersect(sides.points).length).toBe(8);
  });

  it('one face, and one face of a selection, keep it too; a value read off the picture extracts as it did', () => {
    const c = cube(true);
    const top = c.faces.at(1).extract();
    expect(top.stated).toBeDefined();
    expect(top.faces.length).toBe(1);
    expect(top.points.length).toBe(4);
    expect(top.faces.at(0).name).toBe('f1');
    expect(top.corners.map((q) => q.uv)).toEqual(c.faces.at(1).corners.map((q) => q.uv));
    const flat = square().faces.extract();
    expect(flat.stated).toBeUndefined();
    expect(flat.faces.length).toBe(1);
  });
});

describe('a fixed triangulation per stated face', () => {
  /** Two quads side by side, the first with a fixed triangulation. */
  const pair = () => materialFromParts({
    x: [0, 1, 2, 2, 1, 0], y: [0, 0, 0, 1, 1, 1], z: [0, 0, 0, 0, 0, 0],
    faces: [{ loop: [0, 1, 4, 5], triangles: [0, 1, 2, 0, 2, 3], cols: { h: 1 } }, { loop: [1, 2, 3, 4] }],
  });

  it('is stated with the loops and read back', () => {
    const m = pair();
    expect(m.stated!.triangles).toEqual([[0, 1, 2, 0, 2, 3], undefined]);
    expect(stated(m)!.triangles).toEqual([[0, 1, 2, 0, 2, 3], undefined]);
    expect(stated(cube())!.triangles).toBeUndefined();
  });

  it('is kept by every write that keeps the faces, by extract and by append; an edge write drops it', () => {
    const m = pair();
    const kept = m.move([0, 0, 1]).points.set('w', 1).faces.set('k', 2).corners.set('uv', [0, 0]);
    expect(stated(kept)!.triangles).toEqual([[0, 1, 2, 0, 2, 3], undefined]);
    expect(stated(m.faces.at(0).extract())!.triangles).toEqual([[0, 1, 2, 0, 2, 3]]);
    expect(stated(m.faces.filter((f) => f.index === 1).extract())!.triangles).toBeUndefined();
    // (A face column on both sides is refused by append; the second pair has none.)
    const other = materialFromParts({ x: [0, 1, 2, 2, 1, 0], y: [0, 0, 0, 1, 1, 1], z: [0, 0, 0, 0, 0, 0], faces: [{ loop: [0, 1, 4, 5], triangles: [0, 1, 2, 0, 2, 3] }, { loop: [1, 2, 3, 4] }] });
    const both = append(m, other);
    expect(both.faces.length).toBe(4);
    expect(stated(both)!.triangles).toEqual([[0, 1, 2, 0, 2, 3], undefined, [0, 1, 2, 0, 2, 3], undefined]);
    expect(stated(both)!.loops[2]).toEqual([6, 7, 10, 11]);
    expect(m.edges.remove(m.edges.at(0)).stated).toBeUndefined();
  });

  it('refuses a wrong triangulation by name', () => {
    const at = (triangles: number[]) => () => materialFromParts({ x: [0, 1, 1, 0], y: [0, 0, 1, 1], faces: [{ loop: [0, 1, 2, 3], triangles }] });
    expect(at([0, 1])).toThrow(/2 triangle corners — three a triangle/);
    expect(at([0, 1, 4])).toThrow(/loop position 4, and its loop has 4 points/);
  });
});

describe('append joins stated faces', () => {
  it('two stated values: both statements, ids kept or re-minted on a collision; a side read off the picture drops it', () => {
    const a = cube(true);
    const b = cube().corners.set('uv', [7, 7]);
    const both = append(a, b);
    expect(both.faces.length).toBe(12);
    expect(both.corners.length).toBe(48);
    expect(both.corners.at(5).uv).toEqual(a.corners.at(5).uv);
    expect(both.corners.at(29).uv).toEqual([7, 7]);
    // A corner column one side lacks takes its kind's default there.
    expect(both.corners.at(29).seam).toBe(false);
    expect(both.faces.at(8).side).toBe(0);
    const ids = stated(both)!.ids.faces!;
    expect([...ids].slice(0, 6)).toEqual([...stated(a)!.ids.faces!]);
    expect([...ids].slice(6)).toEqual([...stated(b)!.ids.faces!]);
    const k = cube();
    const self = stated(append(k, k))!.ids.faces!;
    expect(new Set(self).size).toBe(12);
    expect(append(a, square(), { fill: { z: 0 } }).stated).toBeUndefined();
    expect(append(a, material([[5, 5, 5]])).faces.length).toBe(6);
  });
});

describe('a value in space has the faces it states, or none', () => {
  it('a closed curve in space, or a box\'s top edges extracted, answers no faces; 2D still walks', () => {
    const ring = material([[0, 0, 0], [1, 0, 1], [1, 1, 0], [0, 1, 1]]);
    const closed = curve([[0, 0], [1, 0], [1, 1], [0, 1]], { closed: true }).points.set('z', (p: Vertex) => p.x);
    expect(closed.faces.length).toBe(0);
    expect(closed.points.at(0).faces.length).toBe(0);
    expect(ring.faces.length).toBe(0);
    const top = cube().faces.at(1).edges.extract();
    expect(top.edges.length).toBe(4);
    expect(top.faces.length).toBe(0);
    expect(square().faces.length).toBe(1);
  });
});

describe('transform keeps the two dimensions apart', () => {
  it('a placement of the plane on a value in space is refused by name', () => {
    const plane2 = identity(spaceOf({ curvature: 0 }).model);
    expect(() => cube().transform(plane2 as never)).toThrow('transform takes a placement of 3D space — an observer, or one of a honeycomb\'s placements; a placement of the plane moves sketch points');
    expect(square().transform(plane2).points.length).toBe(4);
  });
});
