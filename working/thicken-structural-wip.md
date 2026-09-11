# thicken: structural event identity — WIP handoff

Branch `wip/thicken-structural-identity` (commit e86a511). **Not green; do not
merge.** This note records the reproduction, the failing checks, and the
unresolved decisions so the next session can pick up the intersection layer.

## What this branch changes

- Provenance fixes and their regressions (the mover/narrow-gap test, generator
  parameter mapping through coincident merges, contact provenance from a
  covered generator).
- Construction identity inside a hull: the four tangencies
  (`A±`, `B±`) are built once per shape and shared by both the tangent segment
  and the supporting arc.
- Shared source-disc identity across incident hulls: a tangency is keyed by
  `(vertex row, radius, outward normal)`; equal normals share the point,
  different branch directions keep distinct points.
- Proximity-based event identity removed. `Events` merges only at the few-ulp
  representation floor; `shapeContains` discards a piece only when it is
  provably inside (`F_min < -bound`, bound from the evaluation scale).

## 1. Minimal reproduction

```ts
import { material, thicken } from 'occlude';

const kink = material(
  [[0, 0], [10, 0], [20, 0.001]],
  { edges: [[0, 1], [1, 2]] },
);
thicken(kink, { radius: 1 });
// Error: thicken: boundary walk did not close — this input hit a numerical
// degeneracy; nudge a coordinate or change tolerance
```

The three points are almost collinear; the second hull's tangencies at the
middle vertex are genuinely distinct from the first hull's, and the
arrangement has to resolve the near-tangent contact and the sub-resolution arc
between them. Also reproduced by:

- `material([[0,0],[10,0.5],[10,-0.5]], { edges: [[0,1],[0,2]] })`, radius 1
- `material([[0,0],[10,0.001],[10,-0.001]], { edges: [[0,1],[0,2]] })`, radius 1
- `material([[0,0],[10,2],[10,-2]], { edges: [[0,1],[0,2]] })`, radius 1
- exactly collinear `[[0,0],[10,0],[20,0]]` **passes** (normals agree, points
  shared), so the defect is specifically the near-tangent, not-equal case.

Evidence: `packages/occlude/src/thicken.ts` (the structural version on this
branch); commands below.

## 2. Failing checks

```sh
pnpm --filter occlude exec vitest run test/thicken.test.ts
# 25 passed, 5 failed:
#   thicken: geometry and topology > an acute fork, a reversal and unequal
#     branch widths still close
#   thicken: geometry and topology > a self-crossing chain closes its loops
#     without parity cancellation
#   thicken: geometry and topology > subdividing an edge with interpolated
#     position and radius preserves the union
#   thicken: material and callback contract > point creates complete,
#     consistent output rows from source candidates
#   thicken: material and callback contract > repeated calls are identical,
#     in arrays and callback visit order
```

Randomized differential sweep (was 0 crashes before this branch, now 241/800).
Deterministic seed 12345, run with `pnpm --filter occlude exec tsx <file>`:

```ts
// sweep.mts — seed fixed at 12345
import { material, thicken, distanceTo } from 'occlude';

function insideEnvelope(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, x: number, y: number): boolean {
  const qx = x - ax, qy = y - ay, dx = bx - ax, dy = by - ay, dr = rb - ra;
  const A = dx * dx + dy * dy - dr * dr;
  const B = -2 * ((qx * dx + qy * dy) + ra * dr);
  const C = qx * qx + qy * qy - ra * ra;
  const f = (t: number) => A * t * t + B * t + C;
  let best = Math.min(f(0), f(1));
  if (A > 0) best = Math.min(best, f(Math.min(1, Math.max(0, -B / (2 * A)))));
  return best <= 0;
}
let s = 12345;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
let crashes = 0, mismatches = 0, checked = 0;
for (let c = 0; c < 800; c++) {
  const n = 1 + Math.floor(rnd() * 6);
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([Math.round(rnd() * 20), Math.round(rnd() * 20)]);
  const edges: [number, number][] = [];
  for (let i = 1; i < n; i++) if (rnd() < 0.7) edges.push([Math.floor(rnd() * i), i]);
  if (edges.length && rnd() < 0.2) { const e = edges[Math.floor(rnd() * edges.length)]; edges.push(rnd() < 0.5 ? [e[0], e[1]] : [e[1], e[0]]); }
  const radius = pts.map(() => +(rnd() * 4).toFixed(3));
  const m = material(pts, { edges, radius });
  const shapes: [number, number, number, number, number, number][] = [];
  for (const [a, b] of edges) { if (radius[a] <= 0 && radius[b] <= 0) continue; shapes.push([pts[a][0], pts[a][1], pts[b][0], pts[b][1], radius[a], radius[b]]); }
  const onEdge = new Set<number>(); for (const [a, b] of edges) { onEdge.add(a); onEdge.add(b); }
  for (let i = 0; i < n; i++) if (!onEdge.has(i) && radius[i] > 0) shapes.push([pts[i][0], pts[i][1], pts[i][0], pts[i][1], radius[i], radius[i]]);
  let body: ReturnType<typeof thicken>;
  try { body = thicken(m, { radius: (p) => p.radius, tolerance: 0.02 }); }
  catch { crashes++; continue; }
  if (shapes.length === 0) continue;
  const d = distanceTo(body);
  for (let k = 0; k < 400; k++) {
    const x = -4 + rnd() * 30, y = -4 + rnd() * 30;
    const val = d(x, y);
    if (!Number.isFinite(val) || Math.abs(val) < 0.05) continue;
    checked++;
    const cov = shapes.some((sh) => insideEnvelope(sh[0], sh[1], sh[2], sh[3], sh[4], sh[5], x, y));
    if ((val > 0) !== cov) mismatches++;
  }
}
console.log(`crashes=${crashes} checked=${checked} mismatches=${mismatches}`);
```

## 3. Unresolved intersection decisions

The failures are all at a junction where two hulls' tangencies on a shared
source disc are **not equal** (normals differ, e.g. ~1e-6 rad for an almost
straight chain), so they must not be merged. The arrangement has to make these
decisions, and none of them is currently made with an error bound:

1. **Near-tangent segment/segment and segment/arc contact.** Exact `orient2d`
   says "no crossing" for rounded segments whose true supporting lines do
   cross. Decide contact from the line/arc intersection with a bound carried
   from that computation: if the contact falls inside both primitives'
   parameter ranges within the bound, make it a shared split; if it lands
   within the bound of an existing endpoint, reuse that endpoint; if the bound
   exceeds the local feature, raise the explicit degeneracy error.
2. **The sub-resolution arc between two distinct tangencies.** When the two
   tangent lines diverge, the union boundary includes a sliver of the source
   disc between the two tangencies. Which primitive owns it, and whether
   classification keeps it, must follow from the same bound — not from a
   midpoint sign that rounding can flip.
3. **Which hull's arc carries the junction.** `sameCircle` shares arc endpoints
   on an identical disc, but the exposed sliver can fall outside both hulls'
   *far* arcs. Either add the exposed near-arc as a primitive when the junction
   is unresolved, or assemble the junction from the two tangent lines plus the
   disc, chosen by a bounded angular comparison.
4. **Current fallback.** Today the walk throws
   `boundary walk did not close` / `open end`. That is an honest error, but it
   is reached by too many ordinary inputs; it should be reserved for cases
   where the bound genuinely exceeds the local feature.

Not attempted on this branch: higher-precision (double-double or interval)
evaluation of the tangency and intersection arithmetic. That is the likely end
state for (1) and (2) if the bound analysis stays fragile.
