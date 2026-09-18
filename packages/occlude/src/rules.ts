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
 * MATCHING is order-free inside one batch: every rule in an array reads
 * the same frozen state, so a point one rule moves is still where it was
 * when the next one looks at it. EDITING is not, and `stepOnce`'s rules
 * decide it — moves add up, a later `set` overwrites an earlier one, a
 * later `connect` on an existing pair is dropped, and new points keep the
 * order the rules asked for them. `steps(n, [a, b])` is that one batch.
 * `steps(n, a, b)` is the older meaning, two passes, where `b` sees what
 * `a` committed.
 *
 * Randomness is not a rule option: these factories are pure and have no
 * seed of their own. A chance belongs in the pattern, where it runs once
 * for each row: `rule.edge((e) => e.length > 3 && t.chance(0.3)).split()`.
 */

import { inheritEdge } from './material.js';
import type { Material, Vertex, Edge } from './material.js';
import type { Next, StepRule, SplitOpts, ChildSpec, Ref } from './steps.js';
import type { PointSelection, EdgeSelection } from './relation.js';
import type { XY } from './vec.js';

// ---- the seam between the flat world and the mesh -----------------------

/**
 * What a rule needs of a state and of an edit batch. A 2D material and a
 * 3D mesh both satisfy these, and both spell `steps` the same way, so one
 * rule runs in either.
 *
 * The row type is `any` here, and nowhere else. A rule builder never sees
 * the state, so it cannot be told which world it is for; and a function
 * parameter is contravariant, so a constraint naming a concrete row would
 * accept one world and refuse the other. `any` in this one constraint is
 * what lets `Rewrite` be assignable to BOTH `StepRule` and a mesh rule.
 * The artist's own safety comes from the callback, where the row is real.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RuleCollection {
  filter(fn: (row: any, i: number) => boolean): any;
  readonly length: number;
}
export interface RuleState {
  readonly points: RuleCollection;
  readonly edges: RuleCollection;
}
export interface RuleBatch {
  move(selection: any, field: any): void;
  set(target: any, field: any): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * A rule, ready for `steps`. It is generic so that one value fits a
 * material's `steps` and a mesh's `steps` alike — write the rule once, run
 * it in the flat world or on a surface.
 */
export type Rewrite = <S extends RuleState, B extends RuleBatch>(cur: S, next: B, k: number) => void;

/** Tested against every point of the frozen state, with the state itself. */
export type PointMatch = (p: Vertex, cur: Material, k: number) => boolean;
/** Tested against every edge of the frozen state, with the state itself. */
export type EdgeMatch = (e: Edge, cur: Material, k: number) => boolean;

/** A motif's chain, mapped onto an edge: the first point of the motif goes
 * to the edge's `a`, the last to its `b`, and the rest ride the similarity
 * between them. Anything the motif draws off that line is kept in
 * proportion, so a bump stays a bump whatever the edge's length or angle. */
export interface ReplaceOpts {
  /** Mirror the motif across the edge. The callback sees the step, so
   * alternating on `k` grows a Koch curve inward and outward by turns. */
  flip?: boolean | ((e: Edge, cur: Material, k: number) => boolean);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A rule body written against the flat world, handed out as one that runs
 * in either. The body only ever calls words both worlds have. */
const crossWorld = (body: (cur: Material, next: Next, k: number) => void): Rewrite => body as any;
const crossWorldEdges = (body: (cur: Material, next: { setEdges(sel: unknown, field: unknown): void }, k: number) => void): Rewrite => body as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const asMatch = <T>(m: ((v: T, cur: Material, k: number) => boolean) | undefined): ((v: T, cur: Material, k: number) => boolean) | undefined => {
  if (m === undefined) return undefined;
  if (typeof m !== 'function') throw new Error('rule: a pattern is a function of the point or edge');
  return m;
};

/** Points that match, and what to do with every one of them. */
export class PointRule {
  constructor(private readonly match: PointMatch | undefined) {}

  private select(cur: Material, k: number): PointSelection {
    return this.match === undefined ? cur.points : cur.points.filter((p) => this.match!(p, cur, k));
  }

  /** Displace every match. Runs in the flat world and on a mesh alike:
   * `by` is whatever that world calls a displacement. */
  move(by: XY | ((p: Vertex, cur: Material) => XY)): Rewrite {
    return crossWorld((cur, next, k) => {
      const sel = this.select(cur, k);
      if (sel.length === 0) return;
      next.move(sel, typeof by === 'function' ? (p) => (by as (p: Vertex, cur: Material) => XY)(p, cur) : by);
    });
  }

  /** Write attributes on every match. Runs in either world. */
  set(attrs: Record<string, number> | ((p: Vertex, cur: Material) => Record<string, number>)): Rewrite {
    return crossWorld((cur, next, k) => {
      const sel = this.select(cur, k);
      if (sel.length === 0) return;
      next.set(sel, typeof attrs === 'function' ? (p) => (attrs as (p: Vertex, cur: Material) => Record<string, number>)(p, cur) : attrs);
    });
  }

  /** Grow a child from every match. */
  extrude(spec: (p: Vertex, cur: Material) => ChildSpec | ChildSpec[], opts?: { inherit?: boolean }): StepRule {
    return (cur, next, k) => {
      const sel = this.select(cur, k);
      if (sel.length === 0) return;
      next.extrude(sel, (p) => spec(p, cur), opts);
    };
  }

  /** Join every match to the point the callback names. A callback that
   * returns nothing joins nothing, so a rule can skip a match. */
  connect(to: (p: Vertex, cur: Material) => Ref | undefined): StepRule {
    return (cur, next, k) => {
      for (const p of this.select(cur, k)) {
        const other = to(p, cur);
        if (other !== undefined) next.connect(p, other);
      }
    };
  }

  /** Delete every match, and the edges that touch it. */
  remove(): StepRule {
    return (cur, next, k) => {
      const sel = this.select(cur, k);
      if (sel.length === 0) return;
      next.remove(sel);
    };
  }
}

/** Edges that match, and what to do with every one of them. */
export class EdgeRule {
  constructor(private readonly match: EdgeMatch | undefined) {}

  private select(cur: Material, k: number): EdgeSelection {
    return this.match === undefined ? cur.edges : cur.edges.filter((e) => this.match!(e, cur, k));
  }

  /** Put a point in the middle of every match, or at `at` along it. */
  split(opts?: SplitOpts): StepRule {
    return (cur, next, k) => {
      const sel = this.select(cur, k);
      if (sel.length === 0) return;
      next.splitEdges(sel, opts);
    };
  }

  /** Write attributes on every match. Runs in either world. */
  set(attrs: Record<string, number> | ((e: Edge, cur: Material) => Record<string, number>)): Rewrite {
    return crossWorldEdges((cur, next, k) => {
      const sel = this.select(cur, k);
      if (sel.length === 0) return;
      next.setEdges(sel, typeof attrs === 'function' ? (e: Edge) => (attrs as (e: Edge, cur: Material) => Record<string, number>)(e, cur) : attrs);
    });
  }

  /** Cut every match, keeping its two points. */
  remove(): StepRule {
    return (cur, next, k) => {
      const sel = this.select(cur, k);
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
    // The motif's CHAIN, not its rows. A material's row order is an
    // accident of how it was built — `steps` inserts a split point after
    // its edge's start, and an added point goes last — so threading rows
    // would silently draw a different motif than the one on screen.
    const chains = motif.curves();
    if (chains.length !== 1) {
      throw new Error(`rule.replace: a motif is one open chain, and this one has ${chains.length === 0 ? 'none' : String(chains.length)}. Give the motif's points the edges that join them in order.`);
    }
    if (chains[0].closed) throw new Error('rule.replace: a motif is an open chain, and this one is closed');
    const pts = chains[0].pts;
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
    return (cur, next, k) => {
      const sel = this.select(cur, k);
      if (sel.length === 0) return;
      const names = cur.attrNames;
      const edgeNames = cur.edgeAttrNames;
      next.disconnect(sel);
      for (const e of sel) {
        const ex = e.b.x - e.a.x;
        const ey = e.b.y - e.a.y;
        const across = (typeof flip === 'function' ? flip(e, cur, k) : flip === true) ? -1 : 1;
        // A motif point stands between the edge's ends, so it inherits from
        // them the way a split point does: the declared transfer policy,
        // interpolating by default. Every declared column must be given,
        // because a column is never dropped in silence.
        const inherit = (at: number): Record<string, number> => {
          const out: Record<string, number> = {};
          for (const name of names) {
            const va = e.a[name];
            const vb = e.b[name];
            out[name] = cur.transfers[name] === 'nearest' ? (at <= 0.5 ? va : vb) : va + (vb - va) * at;
          }
          return out;
        };
        // A child edge inherits the parent's columns the way a split's
        // children do: 'copy' keeps the value, 'distribute' takes the
        // child's share of the parent.
        const childEdge = edgeNames.length > 0 ? inheritEdge(cur, e.attrs, 1 / (local.length + 1)) : undefined;
        let from: Ref = e.a;
        for (const [along, off] of local) {
          const o = off * across;
          const handle = next.addPoint([e.a.x + along * ex - o * ey, e.a.y + along * ey + o * ex], inherit(along));
          next.connect(from, handle, childEdge);
          from = handle;
        }
        next.connect(from, e.b, childEdge);
      }
    };
  }
}

/**
 * A face of whichever world the rule runs in. A material's face and a
 * mesh's face share `index`, `area`, a centre and `adjacent`; everything
 * else is that world's own, so the row is not narrowed here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type FaceRow = any;
/** Tested against every face of the frozen state, with the state itself. */
export type FaceMatch = (f: FaceRow, cur: FaceRow, k: number) => boolean;

/** Faces that match, and what to do with every one of them. */
export class FaceRule {
  constructor(private readonly match: FaceMatch | undefined) {}

  /**
   * Write attributes on every match.
   *
   * A mesh stores its faces, so this writes their columns. A material does
   * NOT: a face in the flat world is computed from the points and edges
   * every time it is asked for, and it owns no columns, so there is
   * nowhere to write and this says so rather than dropping the values.
   * Move or write the face's own points instead.
   */
  set(attrs: Record<string, number> | ((f: FaceRow, cur: FaceRow) => Record<string, number>)): Rewrite {
    const match = this.match;
    return ((cur: any, next: any, k: number) => {
      if (typeof next.setFaces !== 'function') {
        throw new Error('rule.face().set: this state has no face attributes to write. A face of a material is computed from its points and edges, so it owns no columns — write the face\'s points, or run the rule on a mesh.');
      }
      const all = cur.faces;
      const faces = typeof all === 'function' ? all.call(cur) : all;
      const sel = match === undefined ? faces : faces.filter((f: any) => match(f, cur, k));
      if (sel.length === 0) return;
      next.setFaces(sel, typeof attrs === 'function' ? (f: any) => attrs(f, cur) : attrs);
    }) as any;
  }

  /** Displace the points of every match. Both worlds store their points,
   * so this works in both. */
  move(by: (f: FaceRow, cur: FaceRow) => unknown): Rewrite {
    const match = this.match;
    return ((cur: any, next: any, k: number) => {
      const all = cur.faces;
      const faces = typeof all === 'function' ? all.call(cur) : all;
      for (const f of match === undefined ? faces : faces.filter((g: any) => match(g, cur, k))) {
        next.move(f.points, () => by(f, cur));
      }
    }) as any;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Patterns. `rule.point()`, `rule.edge()` and `rule.face()` with no
 * pattern match everything.
 *
 * A rule that only moves or writes runs in EITHER world: hand it to a
 * material's `steps` or to a mesh's. The rules that change topology —
 * split, extrude, connect, remove, replace — are the flat world's alone,
 * because a mesh edit batch has no per-step topology.
 */
export const rule = {
  point: (match?: PointMatch): PointRule => new PointRule(asMatch(match)),
  edge: (match?: EdgeMatch): EdgeRule => new EdgeRule(asMatch(match)),
  face: (match?: FaceMatch): FaceRule => new FaceRule(asMatch(match)),
};

/** @internal One batch from a list of rules: every rule matches the same
 * frozen state, and every edit lands in the same next state. */
export function oneBatch(rules: readonly StepRule[]): StepRule {
  for (const r of rules) if (typeof r !== 'function') throw new Error('steps: a rule list holds rules, and a rule is what rule.point(…) and rule.edge(…) build');
  return (cur: Material, next: Next, k: number) => {
    for (const r of rules) r(cur, next, k);
  };
}
