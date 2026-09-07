# Materials

Geometry as data you can hold: points with attributes, edges between them, selections of parts, rules that move and grow them, the regions they enclose, and drawing one material several ways. The page runs from sampled points, through connections and selections, to movement and growth, then faces and resampling, and ends with a worked study that reads one material four ways.

## Point distributions

`t.scatter(field?, { spacing })` places Poisson-disk points over the drawable. Where the field (0 to 1) is high the local spacing tightens; where it is 0 nothing is placed. Every island of the field is sampled. Each point is `{ x, y, w }`, with `w` the local demand.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const field = (x, y) => Math.max(0, 1 - Math.hypot(x - 100, (y - 50) * 2) / 90);
  return t.scatter(field, { spacing: 3.4 }).map((p) => circle(p.x, p.y, 0.7 + p.w * 0.9));
});
```

`.relax(n)` runs Lloyd relaxation toward field-weighted cell centroids: spacing evens out and the count stays fixed. `.settle(n)` adds population control, splitting the point of an overloaded cell and removing a starved one, so the count converges to the field's ink budget (weighted Linde-Buzo-Gray stippling). Both work on any array lifted with `t.points(arr, { field?, spacing? })`. Left, a plain grid; right, the same grid after twelve settle passes over a tone field.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const dark = (x, y) => Math.max(0.03, 1 - Math.hypot(x - 50, (y - 50) * 1.8) / 50);
  const gridPts = t.grid({ cols: 15, rows: 15 }).map((c) => [c.cx / 2, c.cy]);
  return [
    gridPts.map(([x, y]) => circle(x, y, 0.6)),
    t.points(gridPts, { field: dark, spacing: 4.8 }).settle(12).map((p) => circle(p.x + 100, p.y, 0.7 + p.w * 0.8)),
  ];
});
```

`.cells()` gives the Voronoi cells of a set, one `{ site, pts }` per point clipped to the drawable, and `.mesh()` its Delaunay triangles. Both are plain data to filter and stamp; both also exist as pure imports over any array, `voronoi(points, bounds)` with the bounds to clip to, and `triangulate(points)`. Left, the cells of the points in the left half, clipped to it; right, the triangles of the points in the right half.

```ts live
import { sketch, polygon, fill, mm, voronoi, triangulate } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const pts = t.scatter({ spacing: 9 }).relax(3);
  const left = pts.filter((p) => p.x < 96);
  const right = pts.filter((p) => p.x > 104);
  return [
    voronoi(left, { x: 0, y: 0, w: 98, h: 100 }).map((c) =>
      polygon(c.pts, t.chance(0.25) ? { fill: fill('hatch', { angle: t.rnd(180), spacing: mm(1.1) }) } : {})),
    triangulate(right).map((tri) => polygon(tri)),
  ];
});
```

## Material

A material is a set of vertices, each with `x`, `y` and any named attribute columns, plus an edge list. A ring, an open chain, a branching tree and an unconnected cloud are all materials. Every operation returns a new material, so an evolution can be kept and any state chosen later. Indices are rows of one state, not identities that persist across states.

| Layer | Vocabulary |
|---|---|
| making | `t.sample(shape)`, `material(points)`, `curve(pts)`, `connect.*`, `.attribute()`, `.resample()` |
| vectors | `add sub mul length distance unit limit perp sum sumBy`: tuples in either spelling, tuples out, nothing mutated |
| rules | `.steps(n, (current, next, k) => …)` with the collection edits; forces prepared once and evaluated at a point |
| selection | `.selectPoints()`, `.selectEdges()`, `.extract()`, `connectedPoints`, `components`, `meanBy` |
| areas | `.planarize()` shares crossings on purpose; `.faces()` reads the enclosed regions; `boundaries()` outlines a union |
| drawing | `.curves()`, `strokes()`, `segmentRuns`, `extent`, `banding`, then `stroke`, `polygon`, `circle` |

All are pure imports except `t.sample`, which reads the paper. Shapes stay exact through the engine; sampling is the one explicit lossy step into this vocabulary.

### Making a material

`t.sample(shape, { count | spacing, tolerance? })` turns each outline of a shape into a chain: a closed outline becomes a ring, an open one a chain from end to end, several outlines separate chains in one material. `material(points, { edges?, ...columns })` builds one from tuples or `{ x, y }` objects (a scatter point's `w` becomes a column), unconnected unless edges are given. `curve(pts, { closed?, ...columns })` makes a ring or chain from positions.

`m.attribute(name, constant | p => value, { transfer? })` adds a point column and returns a new material; `m.edgeAttribute(name, constant | e => value)` adds an edge column, each edge its own row. Read `m.points` (vertex views `{ index, x, y, ...attrs }`), `m.pts` (tuples), `m.x`, `m.y` and `m.attrs.age` (the columns), `m.connected(i)`, `m.degree(i)`, `m.edges` and `m.curves()`.

```ts live
import { sketch, circle, material } from 'occlude';

// A scatter's w becomes a column, a derived column is added, and two
// readings of the same material sit side by side: dots sized by w on
// the left, the far ones ringed on the right.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const cloud = material(t.scatter((x, y) => 1 - Math.hypot(x - 50, y - 50) / 60, { spacing: 6 }).filter((p) => p.x < 98))
    .attribute('far', (p) => Math.hypot(p.x - 50, p.y - 50) > 28 ? 1 : 0);
  return [
    cloud.points.map((p) => circle(p.x, p.y, 0.6 + p.w * 2)),
    cloud.points.filter((p) => p.far).map((p) => circle(p.x + 100, p.y, 3)),
  ];
});
```

### Connections

`connect.chain(m)` and `connect.ring(m)` join consecutive rows in the given order. `connect.nearest(m, { count })` joins each vertex to its `count` nearest others, undirected and without duplicates. `connect.pairs(a, b)` joins row i of `a` to row i of `b` in one material. `connect.triangulate(m)` adds the Delaunay edges. `append(a, b)` puts two materials in one.

```ts live
import { sketch, stroke, material, connect } from 'occlude';

// Two ways to connect one cloud: nearest-3 on the left, Delaunay on the right.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const pts = t.scatter({ spacing: 10 }).map((p) => [p.x / 2 + 2, p.y]);
  const left = connect.nearest(material(pts), { count: 3 });
  const right = connect.triangulate(material(pts.map(([x, y]) => [x + 100, y])));
  return [left, right].flatMap((m) => m.curves().map((c) => stroke(c)));
});
```

### Vectors

Vectors are tuples `[x, y]`. Every operation accepts `[x, y]` or `{ x, y }` (so a vertex view goes straight in), returns a fresh tuple and mutates nothing. `unit([0, 0])` is `[0, 0]`, so coincident points contribute no direction and no NaN. `mul` is scalar multiplication; `limit(v, max)` caps a length; `sumBy(items, fn)` totals a vector function over a collection.

```ts live
import { sketch, line, circle, sub, mul, unit, length, sumBy } from 'occlude';

// Each arrow is the sum of pulls toward three anchors.
export default sketch({ aspect: [2, 1] }, (t) => {
  const anchors = [{ x: 40, y: 50 }, { x: 120, y: 24 }, { x: 160, y: 80 }];
  const pull = (p, q) => mul(unit(sub(q, p)), 60 / (length(sub(q, p)) + 20));
  return [
    anchors.map((a) => circle(a.x, a.y, 3)),
    t.grid({ cols: 20, rows: 10 }).map((c) => {
      const f = sumBy(anchors, (a) => pull(c, a));
      return line(c.cx, c.cy, c.cx + f[0], c.cy + f[1]);
    }),
  ];
});
```

## Selections

A selection names part of one state, the points or edges a predicate picked, without copying positions or changing anything. The predicate runs once and membership is then fixed. `.points` and `.edges` are the source's own views, so array methods do the rest. Independent material is made on purpose with `extract()`.

| Value | Meaning |
|---|---|
| `m.selectPoints(p => bool)`, `m.selectEdges(e => bool)` | a source-bound selection: `source`, `size`, `indices` (source rows, ascending), `has(view)`, `complement()` |
| `sel.union(o)`, `intersect(o)`, `subtract(o)` | a new selection over the same source; equal rows in different states are not the same thing |
| `points.extract()` | the selected points with every point column and no edges |
| `points.inducedEdges()` | the source edges with both ends selected |
| `edges.extract()` | the selected edges, their endpoints and both attribute domains |
| `edges.points` | the endpoints, each once, in source order |
| `edges.curves()` | the selected edges as chains, each edge once; junctions and ends are those of the selected graph |

Extracted material is a fresh evolution at iteration 0 with no history and its rows compacted in source order. Nothing is merged, welded or interpolated on the way. Inside a rule, select from `current`; a selection of another state answers `has` false for the current state's views.

```ts live
import { sketch, strokes, circle, connect, ui } from 'occlude';

// Edges longer than a threshold drawn heavy, the rest light (the
// complement is a selection too), and the points the long edges touch.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const longest = ui(18, { min: 6, max: 28, step: 1 });
  const mesh = connect.triangulate(t.grid({ cols: 13, rows: 7 }).map((c) => [c.cx + t.rnd(-4.4, 4.4), c.cy + t.rnd(-4, 4)]));
  const long = mesh.selectEdges((e) => e.length > longest);
  return [
    strokes(long.complement(), { pen: 'pigma-005-black' }),
    strokes(long, { pen: 'stabilo-88-blue' }),
    long.points.map((p) => circle(p.x, p.y, 1.8, { pen: 'stabilo-88-blue' })),
  ];
});
```

```ts live
import { sketch, strokes, circle, group, force, mul, ui } from 'occlude';

// Extraction, left to right: a ring with a selected arc heavy; the arc
// extracted as a material of its own; that piece relaxed on its own over
// the faint remainder. The source never moves. Placement is the drawing's
// (translated groups), not the material's.
export default sketch({ aspect: [3, 1], seed: 11 }, (t) => {
  const cut = ui(48, { min: 20, max: 80, step: 1 });
  const ring = t.sample(circle(50, 50, 34), { count: 48 }).steps(1, (_, next) => next.move(() => [t.rnd(-4, 4), t.rnd(-4, 4)]));
  const arc = ring.selectEdges((e) => e.a.y < cut && e.b.y < cut);
  const piece = arc.extract();
  const smooth = piece.steps(60, (cur, next) => {
    const relax = force.relax(cur);
    next.move((p) => mul(relax(p), 0.5), { where: (p) => cur.degree(p) === 2 });
  });
  const ends = (m) => m.points.filter((p) => m.degree(p) === 1).map((p) => circle(p.x, p.y, 1.2));
  const faint = { pen: 'pigma-005-black' };
  const heavy = { pen: 'stabilo-88-blue' };
  return [
    strokes(arc.complement(), faint), strokes(arc, heavy),
    group({ translate: [100, 0] }, strokes(piece, heavy), ends(piece)),
    group({ translate: [200, 0] }, strokes(arc.complement(), faint), strokes(smooth, heavy), ends(smooth)),
  ];
});
```

### Relations

`m.connectedPoints(p)` is adjacency as views, `meanBy(items, fn)` a scalar mean (0 of nothing), and `components(m)` one connected-components pass with `count`, a `labels` column and `label(vertex)`. Connected and nearby are different questions; nearby is a spatial query, below.

```ts live
import { sketch, strokes, circle, group, connect, meanBy } from 'occlude';

// Three vertices carry hot = 1. warmth is the mean of hot over each
// vertex's connected neighbours, so the edges between warm vertices
// outline exactly the neighbourhood, derived from the topology.
export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const mesh = connect.triangulate(t.grid({ cols: 9, rows: 8 }).map((c) => [c.cx * 0.48 + t.rnd(-2.4, 2.4), c.cy + t.rnd(-2.8, 2.8)]));
  const hot = [12, 39, 61];
  const raw = mesh.attribute('hot', (p) => (hot.includes(p.index) ? 1 : 0));
  const warm = raw.attribute('warmth', (p) => meanBy(raw.connectedPoints(p), (q) => q.hot));
  const halo = warm.selectEdges((e) => e.a.warmth > 0 && e.b.warmth > 0);
  const marks = (m) => m.points.filter((p) => p.hot === 1).map((p) => circle(p.x, p.y, 2.2, { pen: 'stabilo-88-blue' }));
  return [
    strokes(raw, { pen: 'pigma-005-black' }), marks(raw),
    group({ translate: [100, 0] }, strokes(halo.complement(), { pen: 'pigma-005-black' }), strokes(halo, { pen: 'stabilo-88-blue' }), marks(warm)),
  ];
});
```

```ts live
import { sketch, stroke, circle, material, append, connect, components, segmentRuns } from 'occlude';

// Separate chains, a ring and lone points in one material. components()
// labels each piece once and the pen cycles by label; isolated vertices
// are pieces too.
export default sketch({ aspect: [2, 1], seed: 14 }, (t) => {
  const chain = (x, y, n) => connect.chain(t.times(n, (k) => [x + k * 6.4, y + t.noise(x + k, y) * 12]));
  let all = append(chain(12, 20, 8), chain(80, 16, 10));
  all = append(all, chain(144, 24, 7));
  all = append(all, chain(20, 68, 12));
  all = append(all, connect.ring(t.times(12, (k) => [132 + Math.cos(k / 12 * Math.PI * 2) * 16, 68 + Math.sin(k / 12 * Math.PI * 2) * 16])));
  all = append(all, material([[100, 44], [176, 84], [60, 92], [184, 40]]));
  const pieces = components(all);
  const labelled = all.attribute('piece', (p) => pieces.label(p), { transfer: 'nearest' });
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  return [
    segmentRuns(labelled, (a) => a.piece).map((r) => stroke(r, { pen: pens[r.key % 3] })),
    labelled.points.filter((p) => labelled.degree(p) === 0).map((p) => circle(p.x, p.y, 1, { pen: pens[p.piece % 3] })),
  ];
});
```

### Spatial queries

`query.edges(material)` prepares a query over a frozen state's edges. `nearest(position, { within })` returns `{ edge, position, t, distance }` or null. `firstHit(from, to, { excludeIncident? })` returns the first edge a straight move would meet, `{ edge, position, t, along, distance, kind }`, with `kind` one of `crossing`, `touch` or `overlap`. Queries return information and never edit; results belong to the state they were asked of, and the index does not see additions made in the same step. Prepare once per state, outside the callback that uses it.

```ts live
import { sketch, stroke, circle, rect, query, material, append, ui } from 'occlude';

// Distance as a column: two outlines are prepared once as an edge query,
// and every point of a grid records its distance to the nearest edge as
// a dot size. Beyond `within` the query answers null.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const within = ui(24, { min: 6, max: 60, step: 2 });
  const box = t.sample(rect(28, 24, 48, 44), { spacing: 2 });
  const disc = t.sample(circle(136, 54, 22), { spacing: 2 });
  const edges = query.edges(append(box, disc));
  const grid = material(t.times(33 * 16, (i) => [5 + (i % 33) * 6, 5 + Math.floor(i / 33) * 6]));
  const measured = grid.attribute('distance', (p) => edges.nearest(p, { within })?.distance ?? within);
  return [
    stroke(box.contour), stroke(disc.contour),
    measured.points.filter((p) => p.distance > 1.2).map((p) => circle(p.x, p.y, 0.3 + 2.3 * (p.distance / within))),
  ];
});
```

## Movement and growth

### steps

`m.steps(n, (current, next, k) => …, { every? })` runs a rule `n` times and returns the final material. Growth, relaxation, deformation and erosion are different rules for this one verb; `.steps(1, rule)` is a single transition. The rule reads `current`, which is frozen so every callback sees the same state, and describes `next`, which starts as a copy:

| Edit | Meaning |
|---|---|
| `next.move(p => vector, { where? })`, `next.move(ref, vector)` | displacement; several moves add up |
| `next.set(p => attrs, { where? })`, `next.set(ref, attrs)` | write point attributes; the last write of a field wins |
| `next.setEdges(e => attrs, { where? })`, `next.setEdge(edge, attrs)` | write edge attributes |
| `next.addPoint(position, attributes)` → handle | a new vertex; the handle names it within this batch |
| `next.connect(a, b, edgeAttributes?)` | one undirected edge between rows, views or handles |
| `next.disconnect(edge \| e => bool)` | remove an edge; both points stay |
| `next.remove(ref \| p => bool)` | delete a point and its incident edges; neighbours are never joined |
| `next.split(edge, { at?, point?, edges? })` → handle | replace an edge with two through a new vertex |
| `next.splitEdges(e => bool, { at?, point?, edges? })` | bulk split on the moved edges: moves apply first, then the predicate sees each edge as it will be |
| `next.extend(p => spec \| spec[], { where? })` | for each selected vertex, a new child `{ position, attributes }` or a connection `{ to }`, joined to it |

A reference is a row of the current state, a vertex view of it, or a handle from this batch. Views are checked for ownership: a view of another material or a handle from another step is an error even when its row exists. A new point or edge must name every declared column. A split has a source, so the inserted vertex inherits by each column's transfer policy and the child edges copy the parent's edge attributes, with `point` and `edges` overrides on top.

Within a batch: callbacks read the frozen state; moves and attribute writes apply first; bulk split predicates read that moved state; then removals, disconnections, splits, added points and connections resolve and rows compact once. Conflicting edits (removing a point that is also moved or connected, splitting and disconnecting one edge) throw and publish nothing.

By default only the final state is kept. `{ every: m }` also records iteration 0, every m-th iteration and the final one on the result's `history` as `{ iteration, material }`. Each sketch run recomputes from the start, so scrubbing an iteration control re-runs the growth to that point.

### forces

A force is prepared once with its sources, then evaluated at a point to give a vector; nothing moves until the rule says so. Two callback shapes: `p => vector` for a wind, drift or vector field, and `(p, q) => vector` for an interaction with another point, which goes through `force.nearby`. That finds every source `q` within a radius of `p` from an index built once for the frozen state, and sums your contributions:

```ts
const repel = force.nearby(sources, { radius }, (p, q) => {
  const delta = sub(p, q);
  return mul(unit(delta), radius - length(delta));
});
next.move((p) => mul(repel(p), speed));
```

`sources` is a material or any list of points: the material being moved, or obstacles that stay put. A vertex of the source material never interacts with itself. `excludeConnected: true` on the recipes, or `skip: force.adjacent(m)` on `nearby`, excludes connected neighbours. The named recipes are short functions on this mechanism:

| Recipe | Prepared with | Vector |
|---|---|---|
| `force.tension(m, { rest })` | the state; reads connections | toward each connected neighbour by the gap beyond `rest` (slack, not a spring) |
| `force.separation(sources, { radius, excludeConnected? })` | any points | away from every source within the radius, linearly to zero at the edge |
| `force.attract(sources, { radius, strength?, excludeConnected? })` | any points | toward each source, `strength` when touching, zero at the radius |
| `force.drift(noise, { amount, frequency?, rate? })` | a noise function (pass `t.noise`) | a direction read from the noise, turning slowly with the iteration |
| `force.boundary(loops, { radius, strength? })` | boundary loops | inward within `radius` of the edge and everywhere outside |
| `force.vortex(centre, { strength, falloff? })` | a point | tangential around the centre, fading with distance |
| `force.field(vectorField, { strength? })` | a `grad`, `curl` or hand-written field | the field at p |
| `force.relax(m, { amount? })` | the state; reads connections | toward the mean of the connected neighbours (Laplacian smoothing) |
| `force.sum(...forces)` | prepared forces | their sum; the iteration `k` is handed to each |

### Growth

Differential growth in a few lines: tension, separation and seeded drift, with stretched edges split. This ring is reused later on the page for banding.

```ts live
import { sketch, stroke, circle, force, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.24, frequency: 0.05 });
  const grown = t.sample(circle(100, 50, 8), { count: 24 }).attribute('age', 0).steps(150, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 1.6 }), force.separation(cur, { radius: 4, excludeConnected: true }), wander);
    next.move((p) => mul(push(p, k), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 1.8 && t.chance(0.3), { point: { age: 0 } });
  });
  return stroke(grown.contour);
});
```

Sources need not be the moving geometry. Here a ring grows among six fixed posts that shove it away, with the interaction written in place through `force.nearby`.

```ts live
import { sketch, stroke, circle, force, sub, unit, length, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const posts = [[40, 24], [100, 16], [160, 28], [44, 76], [104, 84], [160, 72]];
  const shove = force.nearby(posts, { radius: 18 }, (p, q) => {
    const delta = sub(p, q);
    return mul(unit(delta), (18 - length(delta)) * 0.9);
  });
  const wander = force.drift(t.noise, { amount: 0.2 });
  const grown = t.sample(circle(100, 50, 8), { count: 30 }).steps(210, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 2 }), force.separation(cur, { radius: 4.4, excludeConnected: true }), shove, wander);
    next.move((p) => mul(push(p, k), 0.18));
    next.splitEdges((e) => e.length > 2.2 && t.chance(0.3));
  });
  return [posts.map(([x, y]) => circle(x, y, 4)), stroke(grown.contour)];
});
```

Tension alone straightens a chain link by link, because the pull acts only where a link is stretched beyond `rest`. Every eighth state is drawn.

```ts live
import { sketch, stroke, curve, force, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const zigzag = t.times(21, (i) => [16 + i * 8.4, 50 + (i % 2 ? 18 : -18) + t.rnd(-4, 4)]);
  const chain = curve(zigzag, { closed: false });
  const pulled = chain.steps(48, (cur, next) => {
    const pull = force.tension(cur, { rest: 6 });
    next.move((p) => mul(pull(p), 0.05));
  }, { every: 8 });
  return pulled.history.map((h) => stroke(h.material.contour));
});
```

### Paths and drift

Attraction gathers an even field of dots toward three anchors; each dot's path over ninety small steps is drawn from the history.

```ts live
import { sketch, stroke, circle, material, force, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  const b = t.bounds();
  const anchors = [[0.22 * b.w, 0.6 * b.h], [0.54 * b.w, 0.24 * b.h], [0.82 * b.w, 0.72 * b.h]];
  const toward = force.attract(anchors, { radius: 0.34 * b.w, strength: 1 });
  const dots = material(t.grid({ cols: 24, rows: 12 }).map((c) => [c.cx, c.cy]));
  const gathered = dots.steps(90, (cur, next) => next.move((p) => mul(toward(p), 0.16)), { every: 1 });
  const trail = (i) => gathered.history.map((h) => [h.material.x[i], h.material.y[i]]);
  return [
    anchors.map(([x, y]) => circle(x, y, 3.2, { pen: 'stabilo-88-blue' })),
    dots.points.map((p) => stroke(trail(p.index))),
    dots.points.map((p) => circle(p.x, p.y, 0.6)),
  ];
});
```

Drift under noise alone, at three frequencies side by side. Coarse noise carries neighbours along together in long arcs; fine noise curls each one on its own. The `band` column picks the force.

```ts live
import { sketch, stroke, circle, material, force } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const b = t.bounds();
  const drifts = [0.004, 0.02, 0.12].map((frequency) => force.drift(t.noise, { amount: 0.32, frequency }));
  const dots = material(t.grid({ cols: 18, rows: 6 }).map((c) => [c.cx, c.cy])).attribute('band', (p) => Math.min(2, Math.floor((3 * p.x) / b.w)));
  const wandered = dots.steps(55, (cur, next, k) => next.move((p) => drifts[p.band](p, k)), { every: 1 });
  const trail = (i) => wandered.history.map((h) => [h.material.x[i], h.material.y[i]]);
  return [dots.points.map((p) => stroke(trail(p.index))), dots.points.map((p) => circle(p.x, p.y, 0.6))];
});
```

A point cloud with no topology at all: a band of dots streams left to right on a light noise wind and parts around a wall, which is a separate sampled outline that never moves. `mobility`, an ordinary column, scales how far each dot goes.

```ts live
import { sketch, stroke, circle, material, curl, force, sum, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const cloud = material(t.scatter({ spacing: 4 }).map((p) => [p.x / 5 + 4, p.y]))
    .attribute('mobility', (p) => 0.6 + 0.4 * t.noise(p.y / 12));
  const wall = t.sample(circle(92, 50, 16), { spacing: 1.6 });
  const avoid = force.separation(wall, { radius: 18 });
  const gusts = force.field(curl((x, y) => t.noise(x / 50, y / 50) * 8));
  const moved = cloud.steps(160, (cur, next) => {
    next.move((p) => mul(sum(avoid(p), gusts(p), [4, 0]), p.mobility * 0.18));
  });
  return [stroke(wall.contour), moved.points.map((p) => circle(p.x, p.y, 0.7))];
});
```

### Smoothing

`force.relax` is Laplacian smoothing as a force: corners go first, the count stays, nothing is resampled. The rough outline is drawn faint where it started, then after six and after twenty-four relaxations.

```ts live
import { sketch, stroke, curve, force, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const rough = curve(t.times(40, (i) => {
    const a = (i / 40) * Math.PI * 2;
    const r = 36 + t.rnd(-10, 10);
    return [100 + Math.cos(a) * r * 1.6, 50 + Math.sin(a) * r];
  }));
  const settled = rough.steps(24, (cur, next) => {
    const smooth = force.relax(cur, { amount: 0.5 });
    next.move((p) => mul(smooth(p), 1));
  }, { every: 6 });
  const at = (i) => settled.history[i].material.contour;
  return [stroke(at(0), { pen: 'pigma-005-black' }), stroke(at(1), { pen: 'stabilo-88-green' }), stroke(at(4), { pen: 'stabilo-88-blue' })];
});
```

### Branching

Branching through ordinary edits. The frontier is a selection of the current state that drives both edits: the tips extend along their heading, bent by noise and pulled back toward up, fork now and then, and hand their activity to their children. Junctions are vertices with three edges; `strokes()` walks each arm once.

```ts live
import { sketch, strokes, circle, material, add } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const seed = material([[100, 98]], { active: 1, heading: -Math.PI / 2, depth: 0 });
  const tree = seed.steps(30, (cur, next, k) => {
    const tips = cur.selectPoints((p) => p.active === 1 && p.y > 6 && p.x > 6 && p.x < 194);
    next.extend((p) => {
      const turn = t.noise(p.x / 14, p.y / 14, k) * 0.3 - (p.heading + Math.PI / 2) * 0.1;
      const fork = p.depth < 4 && t.chance(0.3);
      const headings = fork ? [p.heading - 0.5 + turn, p.heading + 0.5 + turn] : [p.heading + turn];
      return headings.map((h) => ({
        position: add(p, [Math.cos(h) * 3.2, Math.sin(h) * 3.2]),
        attributes: { active: 1, heading: h, depth: p.depth + (fork ? 1 : 0) },
      }));
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(tree), tree.points.filter((p) => p.active).map((p) => circle(p.x, p.y, 1))];
});
```

Growing tips that join what they meet: each tip looks one step ahead with `firstHit`; a hit splits that edge and connects to it, a miss extends.

```ts live
import { sketch, strokes, circle, material, query, add } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 17 }, (t) => {
  const seeds = material(t.times(7, (i) => [24 + i * 25, 94]), { active: 1, heading: -Math.PI / 2 });
  const web = seeds.steps(34, (cur, next, k) => {
    const edges = query.edges(cur);
    const tips = cur.selectPoints((p) => p.active === 1 && p.y > 8 && p.x > 6 && p.x < 194);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 16, p.y / 16, k * 0.01) * 0.7;
      const target = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
      return { position: target, attributes: { active: 1, heading: h } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(web), web.points.filter((p) => p.active).map((p) => circle(p.x, p.y, 1))];
});
```

### Editing a structure

Structural helpers are ordinary functions over the edit interface:

```ts
// prune: drop the tips older than a lifespan, edges and all
next.remove((p) => p.degree === 1 && p.age > lifespan);

// replace an edge with a bend through a new junction
function fork(next, edge, position) {
  next.disconnect(edge);
  const junction = next.addPoint(position, { age: 0 });
  next.connect(edge.a, junction, { rest: edge.attrs.rest / 2 });
  next.connect(junction, edge.b, { rest: edge.attrs.rest / 2 });
  return junction;
}
```

A grown ring, faint, and over it what survives two edits after growth: every edge stretched past a breaking length is disconnected and every vertex younger than four steps is removed. The gaps are the decision.

```ts live
import { sketch, stroke, strokes, circle, force, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.24, frequency: 0.05 });
  const grown = t.sample(circle(100, 50, 10), { count: 30 }).attribute('age', 0).steps(200, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 1.8 }), force.separation(cur, { radius: 4.4, excludeConnected: true }), wander);
    next.move((p) => mul(push(p, k), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 2.2 && t.chance(0.3), { point: { age: 0 } });
  });
  const cut = grown.steps(1, (cur, next) => {
    next.disconnect((e) => e.length > 2.1);
    next.remove((p) => p.age < 4);
  });
  // survivors first: ink coinciding with earlier ink is dropped, so the faint ring comes after
  return [strokes(cut, { pen: 'stabilo-88-blue' }), stroke(grown.contour, { pen: 'pigma-005-black' })];
});
```

## Faces and boundaries

The regions a network encloses are data too. `m.planarize()` makes every crossing and every endpoint-on-edge contact a shared vertex; nothing else does this for you, because connecting lines that merely cross is a decision. `m.faces()` then reads the bounded regions of that planar state: a tree has none, a ring one, a square with a diagonal two.

| Value | Meaning |
|---|---|
| `m.planarize({ point?, edges? })` | independent material with crossings and contacts shared and edges split in order; overlaps, duplicate edges and zero-length edges are errors naming the rows |
| `point: (event) => attrs` | resolves competing point attributes at an event; needed only where the candidates disagree |
| `edges: (parent, child) => attrs` | child edge attributes over the parent's |
| `m.faces()` | the bounded faces: `faces[]`, `map`, `select(f => bool)`, `boundaries()`; crossings without a shared vertex are an error that says to planarize |
| `face` | `index`, `area` (outer minus holes), `perimeter`, `bounds`, `contours` (closed records `polygon` and `stroke` accept) |
| `cells.select(f => bool)` | a fixed-membership face selection with `union`, `intersect`, `subtract` |
| `sel.boundaries()` | closed contours around the union of the selected faces: shared walls omitted, holes kept |

Orientation is decided exactly (Shewchuk's `orient2d`), so crossing, touching and collinear never depend on an epsilon. Endpoints merge only when exactly coincident; a gap stays a gap. Contours come out with the outer boundary at positive area and holes negative, so `winding: 'evenodd'` handles them either way. Drawing every face's contours repeats every shared wall; fill the cells with `stroke: false` and stroke the network once, or stroke only a selection's `boundaries()`.

```ts live
import { sketch, strokes, circle, polygon, fill, mm, group, rect, line, append } from 'occlude';

// Left: a frame and five chords, sampled and appended. The frame alone
// encloses one face and the chords merely cross it. Right: the same
// network planarized; every crossing is a vertex (marked) and each cell
// fills at its own angle. One chord stops short of the frame, so the
// hatch runs unbroken across the gap: the two sides are one cell.
export default sketch({ aspect: [2, 1] }, (t) => {
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const net = [
    t.sample(rect(8, 8, 84, 84), { count: 4 }),
    chord(8, 32, 92, 60), chord(24, 8, 60, 92), chord(8, 76, 92, 20), chord(68, 8, 80, 92),
    chord(40, 48, 92, 84),
  ].reduce((a, b) => append(a, b));
  const planar = net.planarize();
  const cells = planar.faces();
  return [
    strokes(net),
    group({ translate: [100, 0] },
      cells.map((f, k) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: (k * 37) % 180, spacing: mm(1.3) }), stroke: false })),
      strokes(planar),
      planar.points.filter((p) => p.index >= net.n).map((p) => circle(p.x, p.y, 1.6, { pen: 'stabilo-88-blue' })),
    ),
  ];
});
```

Holes and removed walls. A frame split by a wall, with a smaller ring inside: three faces. Left, the chosen faces drawn one by one, so shared walls repeat and the inner square is a hole in each half. Right, `chosen.boundaries()`: the wall between the two chosen halves is gone and the hole kept, until `inner` selects the disk too.

```ts live
import { sketch, strokes, polygon, fill, mm, group, append, curve, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const inner = ui(false, { label: 'select the inner square' });
  let net = append(curve([[12, 12], [88, 12], [88, 88], [12, 88]], { closed: true }), curve([[36, 36], [64, 36], [64, 64], [36, 64]], { closed: true }));
  net = append(net, curve([[12, 50], [36, 50]], { closed: false }));
  net = append(net, curve([[64, 50], [88, 50]], { closed: false }));
  const cells = net.planarize().faces();
  const chosen = cells.select((f) => f.area > 1200 || inner);
  const hatch = fill('hatch', { angle: 45, spacing: mm(1.1) });
  return [
    chosen.map((f) => polygon(f.contours, { winding: 'evenodd', fill: hatch })),
    group({ translate: [100, 0] },
      polygon(chosen.boundaries(), { winding: 'evenodd', fill: hatch, stroke: false }),
      strokes(chosen.boundaries(), { pen: 'stabilo-88-blue' }),
    ),
  ];
});
```

### Hatched cells

A jittered grid triangulated, its cells banded by area, each band hatched at its own spacing so small cells read dense and large cells open, and the network stroked once over the fills. Drag `minimum` to leave the smallest cells empty.

```ts live
import { sketch, strokes, polygon, fill, mm, connect, banding, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 33 }, (t) => {
  const minimum = ui(40, { min: 0, max: 160, step: 5, label: 'minimum area' });
  const cells = connect.triangulate(t.grid({ cols: 14, rows: 7 }).map((c) => [c.cx + t.rnd(-5.2, 5.2), c.cy + t.rnd(-4.8, 4.8)])).faces();
  const chosen = cells.select((f) => f.area >= minimum);
  const band = banding.over(cells.map((f) => f.area), { count: 3 });
  const hatches = [fill('hatch', { angle: 30, spacing: mm(1.3) }), fill('hatch', { angle: 30, spacing: mm(2.6) }), fill('hatch', { angle: 30, spacing: mm(5) })];
  return [
    chosen.map((f) => polygon(f.contours, { winding: 'evenodd', fill: hatches[band(f.area)], stroke: false })),
    strokes(cells.source, { pen: 'pigma-005-black' }),
  ];
});
```

## Resampling and transfer

`m.resample({ spacing | count, transfer? })` redistributes a chain's vertices evenly by arc length. Chains only. Open chains keep both endpoints and closed ones their seam; corners between two new vertices are cut. Splitting adds detail and keeps every vertex; resampling may remove them; neither smooths. `spacing` here is in material units, the coordinates the material holds.

```ts live
import { sketch, stroke, circle, rect, force, mul } from 'occlude';

// A rectangle's outline carried by a vortex and a curl field with no growth,
// then resampled evenly for the pen: left as deformed with its vertices,
// right resampled at 3 units.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const swirl = force.vortex({ x: 50, y: 50 }, { strength: 10, falloff: 12 });
  const bent = t.sample(rect(20, 20, 60, 60), { spacing: 6 }).steps(30, (cur, next) => {
    next.move((p) => mul(swirl(p), 0.3));
  });
  const even = bent.resample({ spacing: 3 });
  return [
    stroke(bent.contour), bent.points.map((p) => circle(p.x, p.y, 0.7)),
    stroke({ pts: even.pts.map(([x, y]) => [x + 100, y]), closed: true }),
    even.points.map((p) => circle(p.x + 100, p.y, 0.7)),
  ];
});
```

Attributes carry across operations by a policy declared once on the column and honoured everywhere; a per-operation option overrides for that call.

| Operation | Point columns | Edge columns | Rows and iteration |
|---|---|---|---|
| `attribute`, `edgeAttribute` with `{ transfer? }` | `'interpolate'` (default) or `'nearest'` for categorical values | `'copy'` (default) or `'distribute'` for a quantity shared by length | rows and iteration kept, history dropped |
| `connect.*`, `next.connect` | | every declared column must be given for a new edge | kept |
| `append(a, b, { fill, edgeFill })` | columns must match or be filled | same | b's rows after a's; iteration 0 |
| `split`, `splitEdges`, `extend`, `addPoint` | a split vertex inherits by the policy, then `point` overrides; a new point must give every column | children copy or share the parent, then `edges(parent, child)` overrides | iteration +1 per step |
| `resample` | by the policy, or a per-call `transfer: { col: 'nearest' \| constant \| fn }` | `'copy'` takes the source edge under the new edge's midpoint; `'distribute'` sums each covered source edge's share | rows renumbered; iteration kept |
| `planarize` | candidates from every edge through the event; disagreeing ones need `point(event)` | children copy or share, then `edges(parent, child)` | iteration 0 |
| `extract()` | copied | copied | rows compacted in source order; iteration 0 |

### Runs and bands

`extent(column)` is `[min, max]`. `banding({ min, max, count })` classifies into `count` equal bands, and `banding.over(values, { count })` does the same from the values' own extent. `segmentRuns(m, (a, b) => key)` classifies every edge by its two vertices and gathers consecutive equal keys into runs, chain by chain, so together the runs redraw every edge once. A vertex attribute needs an interpretation before it can own an edge: the start's, the end's or their mean are different drawings.

The grown ring from above, cut into runs by age band and drawn in two pens, chosen after the growth rather than inside it.

```ts live
import { sketch, stroke, circle, force, sum, mul, segmentRuns, extent, banding } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.2, frequency: 0.05 });
  const last = t.sample(circle(100, 50, 10), { count: 24 }).attribute('age', 0).steps(150, (cur, next, k) => {
    const pull = force.tension(cur, { rest: 1.6 });
    const repel = force.separation(cur, { radius: 4, excludeConnected: true });
    next.move((p) => mul(sum(pull(p), repel(p), wander(p, k)), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 1.8 && t.chance(0.3), { point: { age: 0 } });
  });
  const [young, old] = extent(last.attrs.age);
  const band = banding({ min: young, max: old, count: 2 });
  const pens = ['stabilo-88-blue', 'pigma-005-black'];
  return segmentRuns(last, (a, b) => band((a.age + b.age) / 2)).map((r) => stroke(r, { pen: pens[r.key] }));
});
```

## One material, four drawings

Generation runs once; each panel is the same value read differently: its strokes, an attribute as bands, the cells it encloses, and its junctions and tips as marks. Placement is the drawing's, through translated groups, never the material's.

```ts live
import { sketch, stroke, strokes, circle, polygon, fill, mm, group, material, query, add, segmentRuns, banding } from 'occlude';

export default sketch({ aspect: [2, 2], seed: 7 }, (t) => {
  const seeds = material(t.times(8, (i) => [8 + i * 4.8, 44]), { active: 1, heading: -Math.PI / 2, age: 0 });
  const web = seeds.steps(30, (cur, next, k) => {
    const edges = query.edges(cur);
    const tips = cur.selectPoints((p) => p.active === 1 && p.y > 8 && p.x > 5 && p.x < 45);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 8, p.y / 8, k * 0.01) * 0.7;
      const target = add(p, [Math.cos(h) * 1.2, Math.sin(h) * 1.2]);
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0, age: k } }) };
      const kids = [{ position: target, attributes: { active: 1, heading: h, age: k } }];
      if (t.chance(0.14)) kids.push({ position: add(p, [Math.cos(h + 0.8) * 1.2, Math.sin(h + 0.8) * 1.2]), attributes: { active: 1, heading: h + 0.8, age: k } });
      return kids;
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  const band = banding.over(web.attrs.age, { count: 3 });
  const pens = ['pigma-01-black', 'stabilo-88-green', 'stabilo-88-blue'];
  // a crossing's age is a decision, because the two edges' ages disagree
  const planar = web.planarize({ point: (ev) => ({ active: 0, heading: 0, age: Math.max(...ev.candidates.map((c) => c.attrs.age)) }) });
  const cells = planar.faces().select((f) => f.area > 3);
  return [
    strokes(web),
    group({ translate: [50, 0] }, segmentRuns(web, (a, b) => band((a.age + b.age) / 2)).map((r) => stroke(r, { pen: pens[r.key] }))),
    group({ translate: [0, 50] }, cells.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 45, spacing: mm(1) }), stroke: false })), strokes(planar, { pen: 'pigma-005-black' })),
    group({ translate: [50, 50] }, strokes(web, { pen: 'pigma-005-black' }),
      web.points.filter((p) => web.degree(p) > 2).map((p) => circle(p.x, p.y, 0.7, { pen: 'stabilo-88-blue' })),
      web.points.filter((p) => web.degree(p) === 1).map((p) => circle(p.x, p.y, 0.4))),
  ];
});
```
