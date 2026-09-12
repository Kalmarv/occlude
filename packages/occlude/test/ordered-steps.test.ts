import { describe, it, expect } from "vitest";
import { material, curve, force } from "../src/material.js";
import {
  orderedSteps,
  type OrderedEditor,
} from "../bench/ordered-steps/prototype.js";
import {
  growth,
  ring,
  collisions,
  geometry,
} from "../bench/ordered-steps/fixtures.js";

describe("experimental ordered steps (not public API)", () => {
  it("matches active-tip growth, including attributes and frozen selection membership", () => {
    const old = growth(false),
      fresh = growth(true);
    expect(geometry(fresh)).toEqual(geometry(old));
    expect([...fresh.attrs.active]).toEqual([...old.attrs.active]);
    expect(fresh.n).toBe(101);
    expect(fresh.attrs.active.reduce((a, b) => a + b)).toBe(1);
  });
  it("matches frozen-force movement and after-move subdivision", () => {
    expect(geometry(ring(true))).toEqual(geometry(ring(false)));
  });
  it("preserves force self/connected exclusion for original identities", () => {
    const seed = curve(
      [
        [0, 0],
        [2, 0],
      ],
      { closed: false },
    );
    const out = orderedSteps(seed, 1, (prev, current) => {
      const push = force.attract(prev, { radius: 10, excludeConnected: true });
      current.move(current.points, push);
    });
    expect(out.pts).toEqual(seed.pts);
  });
  it("reads latest values, captures only membership, and never mutates prev", () => {
    const seed = material([[4, 0]], { active: 1 });
    const out = orderedSteps(seed, 1, (prev, current) => {
      const selected = prev.points.filter((p) => p.active === 1);
      current.move(selected, (p) => [p.x, 0]);
      current.move(selected, (p) => [p.x, 0]);
      expect(current.points.at(0).x).toBe(16);
      expect(prev.x[0]).toBe(4);
      const tips = current.points;
      current.extend(tips, (p) => ({
        position: [p.x, 1],
        attributes: { active: 1 },
      }));
      current.set(tips, { active: 0 });
      expect(tips.length).toBe(1);
    });
    expect(out.pts).toEqual([
      [16, 0],
      [16, 1],
    ]);
    expect([...out.attrs.active]).toEqual([0, 1]);
    expect(seed.x[0]).toBe(4);
  });
  it("makes callback iteration order observable without hidden snapshots", () => {
    const out = orderedSteps(
      material([
        [1, 0],
        [2, 0],
      ]),
      1,
      (_, c) => {
        const points = c.points;
        c.move(points, () => [points.at(0).x, 0]);
      },
    );
    expect(out.pts).toEqual([
      [2, 0],
      [4, 0],
    ]);
  });
  it("keeps stable references across removal, supports fresh points and duplicate connections", () => {
    const seed = curve(
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      { closed: false },
    );
    const out = orderedSteps(seed, 1, (prev, c) => {
      const last = prev.vertex(2);
      c.remove(prev.vertex(0));
      c.remove(prev.vertex(0));
      c.move(last, [3, 0]);
      const p = c.addPoint([7, 0]);
      c.move(p, [1, 0]);
      c.connect(last, p);
      c.connect(last, p);
      expect(c.points.length).toBe(3);
      expect(() => c.move(prev.vertex(0), [1, 0])).toThrow(/removed/);
    });
    expect(out.pts).toEqual([
      [1, 0],
      [5, 0],
      [8, 0],
    ]);
    expect(out.edgeCount).toBe(2);
  });
  it("supports edge writes, disconnect/reconnect and updated inheritance", () => {
    const seed = curve(
      [
        [0, 0],
        [10, 0],
      ],
      { closed: false },
    ).edgeAttribute("rest", 10, { transfer: "distribute" });
    const out = orderedSteps(seed, 1, (prev, c) => {
      const e = c.edges.at(0);
      c.setEdge(e, { rest: 20 });
      c.setEdges(c.edges, (e) => ({ rest: e.attrs.rest + 10 }));
      c.disconnect(e);
      c.disconnect(e);
      const replacement = c.connect(prev.vertex(0), prev.vertex(1), {
        rest: 30,
      });
      c.split(replacement);
    });
    expect([...out.edgeAttrs.rest]).toEqual([15, 15]);
  });
  it("supports multi-cuts and later splits on the original edge", () => {
    const seed = curve(
      [
        [0, 0],
        [10, 0],
      ],
      { closed: false, age: [0, 10] },
    ).edgeAttribute("rest", 10, { transfer: "distribute" });
    const out = orderedSteps(seed, 1, (_, c) => {
      const e = c.edges.at(0);
      const cuts = c.split(e, { at: [0.7, 0.2, 0.7] });
      expect(cuts[0]).toBe(cuts[2]);
      expect(cuts.map((p) => p.x)).toEqual([7, 2, 7]);
      const later = c.split(e, { at: 0.5 });
      expect(later.x).toBeCloseTo(5);
    });
    expect([...out.edgeAttrs.rest].reduce((a, b) => a + b)).toBeCloseTo(10);
    expect(out.pts.map((p) => p[0]).sort((a, b) => a - b)).toEqual([
      0, 2, 5, 7, 10,
    ]);
  });
  it("splits captured edges once, allows editing junctions, and handles endpoints", () => {
    const out = orderedSteps(
      curve(
        [
          [0, 0],
          [4, 0],
        ],
        { closed: false },
      ),
      1,
      (_, c) => {
        const e = c.edges.at(0);
        expect(c.split(e, { at: 0 })).toBe(e.a);
        c.move(c.points, (p) => [p.x, 0]);
        c.splitEdges(c.edges.filter((e) => e.length > 5));
        expect(c.edges.length).toBe(2);
        c.move(
          c.points.filter((p) => p.x === 4),
          [0, 1],
        );
      },
    );
    expect(out.pts).toContainEqual([4, 1]);
  });
  it("preserves shared-edge frozen hits as well as updated and grouped queries", () => {
    expect(geometry(collisions("frozen"))).toEqual(
      geometry(collisions("legacy")),
    );
    expect(geometry(collisions("updated"))).toEqual(
      geometry(collisions("legacy")),
    );
    expect(geometry(collisions("grouped"))).toEqual(
      geometry(collisions("legacy")),
    );
  });
  it("resolves original parameters on moved descendants, but never resurrects deleted intervals", () => {
    orderedSteps(
      curve(
        [
          [0, 0],
          [10, 0],
        ],
        { closed: false },
      ),
      1,
      (prev, c) => {
        const original = prev.edge(0);
        const mid = c.split(original);
        c.move(mid, [0, 2]);
        const quarter = c.split(original, { at: 0.25 });
        expect(quarter.x).toBeCloseTo(2.5);
        expect(quarter.y).toBeCloseTo(1);
        expect(c.split(original, { at: 0.5 })).toBe(mid);
        c.disconnect(c.edges.filter((e) => e.a.x === 5));
        expect(() => c.split(original, { at: 0.75 })).toThrow(/deleted/);
      },
    );
  });
  it("supports inherited extension and returns none or multiple children", () => {
    const out = orderedSteps(
      material([[0, 0]], { active: 1, age: 4 }),
      1,
      (_, c) => {
        c.extend(
          c.points,
          (p) => [
            { position: [p.x + 1, 0], attributes: { age: 5 } },
            { position: [p.x - 1, 0] },
          ],
          { inherit: true },
        );
        c.extend(c.points, () => []);
      },
    );
    expect([...out.attrs.age]).toEqual([4, 5, 4]);
  });
  it("rejects foreign/stale refs, closes failed editors, and preserves source on failure", () => {
    const seed = material([[0, 0]]);
    let editor: OrderedEditor | undefined;
    expect(() =>
      orderedSteps(seed, 1, (_, c) => {
        editor = c;
        c.move(c.points, [1, 0]);
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(seed.x[0]).toBe(0);
    expect(() => editor!.points).toThrow(/finished/);
    expect(() =>
      orderedSteps(seed, 1, (_, c) =>
        c.move(material([[0, 0]]).vertex(0), [1, 0]),
      ),
    ).toThrow(/foreign/);
    let ref: import("../src/material.js").Vertex;
    expect(() =>
      orderedSteps(seed, 2, (_, c, k) => {
        if (k === 0) ref = c.points.at(0);
        else c.move(ref, [1, 0]);
      }),
    ).toThrow(/foreign/);
  });
});
