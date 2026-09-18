/**
 * Rewrite rules: a pattern and a replacement, applied to every match at
 * once.
 *
 * A rule is not a new kind of thing. `steps` already hands a rule the
 * frozen state and an edit batch, and an edit over a selection already
 * applies to every member in one go. So `rule.point(p => …).move(…)`
 * BUILDS a `StepRule`, and `m.steps(n, …)` runs it. There is no `rules()`
 * verb, because that would be a second spelling of `steps`.
 *
 * Order does not matter inside one batch. Every rule in an array matches
 * against the same frozen state, and every match edits the same next
 * state — so a point a rule moves is still where it was when the next rule
 * looks at it. `steps(n, [a, b])` is that one batch. `steps(n, a, b)` is
 * the older meaning, two passes, where `b` sees what `a` committed.
 *
 * Randomness is not a rule option. A seeded stream lives on the toolkit,
 * and these factories are pure, so a chance belongs in the predicate:
 * `rule.edge((e) => e.length > 3 && t.chance(0.3)).split()`.
 */

import type { Material, Vertex, Edge } from './material.js';
import type { Next, StepRule, SplitOpts, ChildSpec, Ref } from './steps.js';
import type { PointSelection, EdgeSelection } from './relation.js';
import type { XY } from './vec.js';

/** Tested against every point of the frozen state, with the state itself. */
export type PointMatch = (p: Vertex, cur: Material) => boolean;
/** Tested against every edge of the frozen state, with the state itself. */
export type EdgeMatch = (e: Edge, cur: Material) => boolean;

/** A motif's chain, mapped onto an edge: the first point of the motif goes
 * to the edge's `a`, the last to its `b`, and the rest ride the similarity
 * between them. Anything the motif draws off that line is kept in
 * proportion, so a bump stays a bump whatever the edge's length or angle. */
export interface ReplaceOpts {
  /** Mirror the motif across the edge. Alternate it and a Koch curve grows
   * inward and outward by turns. */
  flip?: boolean | ((e: Edge, cur: Material) => boolean);
}

const asMatch = <T>(m: ((v: T, cur: Material) => boolean) | undefined): ((v: T, cur: Material) => boolean) | undefined => {
  if (m === undefined) return undefined;
  if (typeof m !== 'function') throw new Error('rule: a pattern is a function of the point or edge');
  return m;
};

/** Points that match, and what to do with every one of them. */
class PointRule {
  constructor(private readonly match: PointMatch | undefined) {}

  private select(cur: Material): PointSelection {
    return this.match === undefined ? cur.points : cur.points.filter((p) => this.match!(p, cur));
  }

  /** Displace every match. */
  move(by: XY | ((p: Vertex, cur: Material) => XY)): StepRule {
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.move(sel, typeof by === 'function' ? (p) => (by as (p: Vertex, cur: Material) => XY)(p, cur) : by);
    };
  }

  /** Write attributes on every match. */
  set(attrs: Record<string, number> | ((p: Vertex, cur: Material) => Record<string, number>)): StepRule {
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.set(sel, typeof attrs === 'function' ? (p) => (attrs as (p: Vertex, cur: Material) => Record<string, number>)(p, cur) : attrs);
    };
  }

  /** Grow a child from every match. */
  extrude(spec: (p: Vertex, cur: Material) => ChildSpec | ChildSpec[], opts?: { inherit?: boolean }): StepRule {
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.extrude(sel, (p) => spec(p, cur), opts);
    };
  }

  /** Join every match to the point the callback names. A callback that
   * returns nothing joins nothing, so a rule can skip a match. */
  connect(to: (p: Vertex, cur: Material) => Ref | undefined): StepRule {
    return (cur, next) => {
      for (const p of this.select(cur)) {
        const other = to(p, cur);
        if (other !== undefined) next.connect(p, other);
      }
    };
  }

  /** Delete every match, and the edges that touch it. */
  remove(): StepRule {
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.remove(sel);
    };
  }
}

/** Edges that match, and what to do with every one of them. */
class EdgeRule {
  constructor(private readonly match: EdgeMatch | undefined) {}

  private select(cur: Material): EdgeSelection {
    return this.match === undefined ? cur.edges : cur.edges.filter((e) => this.match!(e, cur));
  }

  /** Put a point in the middle of every match, or at `at` along it. */
  split(opts?: SplitOpts): StepRule {
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.splitEdges(sel, opts);
    };
  }

  /** Write attributes on every match. */
  set(attrs: Record<string, number> | ((e: Edge, cur: Material) => Record<string, number>)): StepRule {
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.setEdges(sel, typeof attrs === 'function' ? (e) => (attrs as (e: Edge, cur: Material) => Record<string, number>)(e, cur) : attrs);
    };
  }

  /** Cut every match, keeping its two points. */
  remove(): StepRule {
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.disconnect(sel);
    };
  }

  /**
   * Replace every match with a motif: the edge goes, and the motif's chain
   * takes its place between the same two points. This is the substitution
   * an L-system is made of — a Koch curve is one motif and four steps.
   */
  replace(motif: Material, opts: ReplaceOpts = {}): StepRule {
    const pts = motif.pts;
    if (pts.length < 2) throw new Error('rule.replace: a motif needs at least two points');
    const [x0, y0] = pts[0];
    const [x1, y1] = pts[pts.length - 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const span = dx * dx + dy * dy;
    if (!(span > 0)) throw new Error('rule.replace: a motif must start and end at different points');
    // The motif in its own frame: along the line from first to last, and
    // across it. Both are fractions of the motif's own span, so the shape
    // rides any edge at any length and any angle.
    const local = pts.slice(1, -1).map(([px, py]) => {
      const ux = px - x0;
      const uy = py - y0;
      return [(ux * dx + uy * dy) / span, (ux * -dy + uy * dx) / span] as [number, number];
    });
    const flip = opts.flip;
    return (cur, next) => {
      const sel = this.select(cur);
      if (sel.length === 0) return;
      next.disconnect(sel);
      for (const e of sel) {
        const ex = e.b.x - e.a.x;
        const ey = e.b.y - e.a.y;
        const across = (typeof flip === 'function' ? flip(e, cur) : flip === true) ? -1 : 1;
        let from: Ref = e.a;
        for (const [along, off] of local) {
          const o = off * across;
          const handle = next.addPoint([e.a.x + along * ex - o * ey, e.a.y + along * ey + o * ex], {});
          next.connect(from, handle);
          from = handle;
        }
        next.connect(from, e.b);
      }
    };
  }
}

/**
 * Patterns. `rule.point()` and `rule.edge()` with no pattern match
 * everything. A face rule is not here: a material is points and edges, and
 * a face is a separate value with its own selection.
 */
export const rule = {
  point: (match?: PointMatch): PointRule => new PointRule(asMatch(match)),
  edge: (match?: EdgeMatch): EdgeRule => new EdgeRule(asMatch(match)),
};

/** @internal One batch from a list of rules: every rule matches the same
 * frozen state, and every edit lands in the same next state. */
export function oneBatch(rules: readonly StepRule[]): StepRule {
  for (const r of rules) if (typeof r !== 'function') throw new Error('steps: a rule list holds rules, and a rule is what rule.point(…) and rule.edge(…) build');
  return (cur: Material, next: Next, k: number) => {
    for (const r of rules) r(cur, next, k);
  };
}
