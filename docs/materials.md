# Materials

Geometry as data you can hold: points with attributes, edges between them, selections of parts, rules that move and grow them, the cells they enclose, and drawing the same material several ways.

## Points

### scatter

`t.scatter(field?, { spacing })` — field-modulated Poisson-disk points:
local spacing tightens where the field (0–1) is high, empty where it's 0.
Returns an array-like set of `{ x, y, w }` (w ≈ local demand).
Every island of the field is sampled — a field made of separate bright
patches gets points in all of them, whatever the seed.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const field = (x, y) => Math.max(0, 1 - Math.hypot(x - 50, (y - 25) * 2) / 45);
  return t.scatter(field, { spacing: 1.7 }).map((p) => circle(p.x, p.y, 0.35 + p.w * 0.45));
});
```

### relax / settle

`.relax(n)` — Lloyd relaxation toward field-weighted cell centroids:
spacing evens out, count stays fixed. `.settle(n)` adds population
control — overloaded cells split their point, starved ones lose theirs —
so the count converges to the field's ink budget (the LBG stipple).
Verbs work on ANY lifted array via `t.points(arr, { field?, spacing? })`
— here a plain grid reorganises itself into tone-following blue noise:

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const dark = (x, y) => Math.max(0.03, 1 - Math.hypot(x - 55, (y - 24) * 1.8) / 50);
  const gridPts = t.grid({ cols: 30, rows: 15 }).map((c) => [c.x + c.w / 2, c.y + c.h / 2]);
  return t
    .points(gridPts, { field: dark, spacing: 2.4 })
    .settle(12)
    .map((p) => circle(p.x, p.y, 0.35 + p.w * 0.4));
});
```

### cells / mesh

`.cells()` — the Voronoi cells of the set (one `{ site, pts }` per
point, clipped to the drawable); `.mesh()` — the Delaunay triangulation.
`site` is the input point itself (a scatter point keeps its `w`); `pts`
is the cell's boundary loop. Both return plain data to edit, filter, and
stamp however you like; both also exist as pure imports
(`voronoi(points, bounds)`, `triangulate(points)`) over arbitrary arrays.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const pts = t.scatter({ spacing: 7 }).relax(3);
  return pts.cells().map((c) =>
    polygon(c.pts, t.chance(0.25) ? { fill: fill('hatch', { angle: t.rnd(180), spacing: mm(1.1) }) } : {}),
  );
});
```

```ts live
import { sketch, polygon } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const field = (x, y) => Math.max(0.05, 1 - Math.hypot(x - 50, (y - 25) * 2) / 48);
  return t.scatter(field, { spacing: 4.2 }).mesh().map((tri) => polygon(tri));
});
```

## Material

Geometry you can hold, connect, step, resample and reinterpret. A `Material`
is vertices — `x`, `y` and any named attribute columns — plus an edge
list. A ring, an open chain, a branching tree and an unconnected cloud
are all materials; a `Curve` is a chain the material hands back for drawing.
Meshes are values: every operation returns a new one, so an evolution can
be kept and any state chosen later. Indices are rows of one state, not
identities. Six layers, kept apart:

| layer | what |
|---|---|
| material | `t.sample(shape)`, `material(points)`, `curve(pts)`; `connect.*`; `.attribute()`, `.resample()` |
| numbers | `add sub mul length distance unit limit perp sum sumBy` — tuples out, either spelling in, nothing mutated |
| rules | `.steps(n, (current, next, k) => …)` with collection edits; forces prepared once, evaluated at a point |
| selection | `.selectPoints()`, `.selectEdges()` — source-bound, fixed; `.extract()` for independent material; `connectedPoints`, `components`, `meanBy` |
| areas | `.planarize()` shares crossings on purpose; `.faces()` reads the bounded regions; `select` by area, `boundaries()` of a union |
| drawing | `.curves()`, `segmentRuns`, `extent`, `banding` — then `stroke`, `polygon`, `circle` |

All pure imports except `t.sample`, which reads the paper. The exact
shapes stay exact through the engine; sampling is the one, explicit,
lossy step into this world.

### material

`t.sample(shape, { count | spacing, tolerance? })` — each outline of the
shape becomes a chain: a closed outline a ring, an open one a chain from
end to end, several outlines separate chains in one material. `material(points,
{ edges?, ...columns })` — from tuples or `{x, y}` objects (a scatter
point's `w` becomes a column), unconnected unless edges are given.
`curve(pts, { closed?, ...columns })` — a ring or chain from positions.
`m.attribute(name, constant | p => value, { transfer? })` adds a point
column (with an optional `'nearest'` transfer policy for categorical
values) and returns a new material; `m.edgeAttribute(name, constant | e
=> value)` adds an EDGE column — each edge its own row, so a junction's
three edges can carry three different rest lengths, read as
`edge.attrs.rest`. Access: `m.points` (vertex views `{ index, x, y, ...attrs }`),
`m.pts` (tuples), `m.x`/`m.y`/`m.attrs.age` (the columns), `m.connected(i)`,
`m.degree(i)`, `m.edges`, `m.curves()`.

```ts live
import { sketch, stroke, polygon, circle, material, fill, mm } from 'occlude';

// Attributes ride with the geometry: a scatter's `w` becomes a column,
// a derived `far` column is added, and two interpretations read the same
// material — dots sized by w on the left, the far ones ringed on the right.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const cloud = material(t.scatter((x, y) => 1 - Math.hypot(x - 25, y - 25) / 30, { spacing: 3 }))
    .attribute('far', (p) => Math.hypot(p.x - 25, p.y - 25) > 14 ? 1 : 0);
  return [
    cloud.points.map((p) => circle(p.x, p.y, 0.3 + p.w)),
    cloud.points.filter((p) => p.far).map((p) => circle(p.x + 50, p.y, 1.5)),
  ];
});
```

### connect

`connect.chain(m)` and `connect.ring(m)` join consecutive rows in the
given order (no route is inferred). `connect.nearest(m, { count })` joins
each vertex to its `count` nearest others — undirected, no duplicates,
self excluded, ties to the lower row. `connect.pairs(a, b)` joins row i of
`a` to row i of `b` in one material, lengths must match, coincident points stay
distinct. `connect.triangulate(m)` adds the Delaunay edges. `append(a, b)`
puts two materials in one. (`t.scatter(...).cells()` and `.mesh()` remain the
polygon views: Voronoi cells and Delaunay triangles as loops to stamp.)

```ts live
import { sketch, stroke, circle, material, connect } from 'occlude';

// Two ways to connect one cloud: nearest-3 on the left, Delaunay on the
// right — each edge drawn once through curves().
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const pts = t.scatter({ spacing: 5 }).map((p) => [p.x / 2 + 2, p.y]);
  const left = connect.nearest(material(pts), { count: 3 });
  const right = connect.triangulate(material(pts.map(([x, y]) => [x + 50, y])));
  return [left, right].flatMap((m) => m.curves().map((c) => stroke(c)));
});
```

### vectors

Vectors are tuples `[x, y]`. Every operation accepts either spelling
(`[x, y]` or `{ x, y }`, so a vertex view goes straight in), returns a
fresh tuple, and never mutates an argument. `unit([0, 0])` is `[0, 0]`:
coincident points contribute no direction and no NaN. `mul` is scalar
multiplication only. `limit(v, max)` caps a length. `sumBy(items, fn)` is
the vector total of your function over a collection, accumulated in order.

```ts live
import { sketch, line, circle, sub, mul, unit, length, sumBy } from 'occlude';

// A field of arrows: each one is the sum of pulls toward three anchors,
// each pull a plain function on the vocabulary.
export default sketch({ aspect: [2, 1] }, (t) => {
  const anchors = [{ x: 20, y: 25 }, { x: 60, y: 12 }, { x: 80, y: 40 }];
  const pull = (p, q) => mul(unit(sub(q, p)), 30 / (length(sub(q, p)) + 10));
  return [
    anchors.map((a) => circle(a.x, a.y, 1.5)),
    t.grid({ cols: 20, rows: 10 }).map((c) => {
      const f = sumBy(anchors, (a) => pull(c, a));
      return line(c.cx, c.cy, c.cx + f[0], c.cy + f[1]);
    }),
  ];
});
```

### forces

A force is prepared once with its sources, then evaluated at a point to a
vector; nothing moves until the rule says so. Two callback shapes cover
the field. `p => vector` — wind, drift, a vector field — works in `sum`
as it is. `(p, q) => vector` — an interaction with another point — goes
through `force.nearby`, which finds every source `q` within a radius of
`p` (spatial index built once, for that frozen state) and sums your
contributions:

```ts
const repel = force.nearby(sources, { radius }, (p, q) => {
  const delta = sub(p, q);
  return mul(unit(delta), radius - length(delta));
});
next.move((p) => mul(repel(p), speed));
```

`sources` is a material (then `q` is a vertex view) or any list of points —
the material being moved, or obstacles that stay put. A vertex of the source
material never interacts with itself: membership in that state decides, not
coordinates or an index from another collection. Nothing else is skipped
unless you say so — `excludeConnected: true` on the recipes, or `skip:
force.adjacent(m)` on `nearby`, is the explicit "not what I'm connected
to". The named recipes are short ordinary functions on this mechanism;
copy one beside your own and change it.

| recipe | prepare with | evaluate | vector |
|---|---|---|---|
| `force.tension(m, { rest })` | the state; reads connections | `pull(p)` | toward each connected neighbour by the gap beyond `rest` (slack, not a spring) |
| `force.separation(sources, { radius, excludeConnected? })` | any points; index once | `repel(p)` | away from every source within the radius, linearly to zero at the edge, `radius` when touching. A raw-column kernel: 5 000 points evaluate in 24 ms, the same doubles as the `nearby` form |
| `force.attract(sources, { radius, strength?, excludeConnected? })` | any points; index once | `pull(p)` | toward each source, `strength` when touching, zero at the radius |
| `force.drift(noise, { amount, frequency?, rate? })` | a noise function — pass `t.noise`, it owns no seed | `wander(p, k)` | a direction read from the noise, turning slowly with the iteration (`rate`, default 0.0004: the noise's z axis is steep) |
| `force.boundary(loops, { radius, strength? })` | boundary loops, as `distanceTo` takes them | `keep(p)` | inward within `radius` of the edge and everywhere outside; zero deeper in |
| `force.vortex(centre, { strength, falloff? })` | a point | `swirl(p)` | tangential around the centre, fading as `1 / (1 + d / falloff)` |
| `force.field(vectorField, { strength? })` | a `grad`/`curl`/hand-written field | `flow(p)` | the field at p — the adapter into `sum` |
| `force.relax(m, { amount? })` | the state; reads connections | `smooth(p)` | toward the mean of the connected neighbours (Laplacian smoothing) |
| `force.nearby(sources, { radius, skip? }, (p, q) => v)` | any points; index once | `f(p)` | the sum of your contributions |
| `force.sum(...forces)` | prepared forces | `push(p, k)` | their sum, `k` handed to each (the ones that turn use it) — the speed stays your `mul` |

```ts live
import { sketch, stroke, circle, force, sub, unit, length, mul } from 'occlude';

// nearby — sources need not be the moving geometry: a ring grows among
// six fixed posts that shove it away, so it flows around them. One
// interaction written in place; the posts are drawn as what they are.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const posts = [[20, 12], [50, 8], [80, 14], [22, 38], [52, 42], [80, 36]];
  const shove = force.nearby(posts, { radius: 9 }, (p, q) => {
    const delta = sub(p, q);
    return mul(unit(delta), (9 - length(delta)) * 0.9);
  });
  const wander = force.drift(t.noise, { amount: 0.1 });
  const grown = t.sample(circle(50, 25, 4), { count: 30 }).steps(210, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 1 }), force.separation(cur, { radius: 2.2, excludeConnected: true }), shove, wander);
    next.move((p) => mul(push(p, k), 0.18));
    next.splitEdges((e) => e.length > 1.1 && t.chance(0.3));
  });
  return [posts.map(([x, y]) => circle(x, y, 2)), stroke(grown.contour)];
});
```

```ts live
import { sketch, stroke, curve, force, mul } from 'occlude';

// tension — an open chain pulled taut: the slack pull only acts where a
// link is stretched beyond `rest`, so the zigzag straightens link by link
// while the ends, which have one neighbour each, follow. Every 4th state.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const zigzag = t.times(21, (i) => [8 + i * 4.2, 25 + (i % 2 ? 9 : -9) + t.rnd(-2, 2)]);
  const chain = curve(zigzag, { closed: false });
  const pulled = chain.steps(48, (cur, next) => {
    const pull = force.tension(cur, { rest: 3 });
    next.move((p) => mul(pull(p), 0.05));
  }, { every: 8 });
  return pulled.history.map((h) => stroke(h.material.contour));
});
```

```ts live
import { sketch, circle, material, force, mul } from 'occlude';

// separation — a clump spreads itself into an even, blue-noise scatter:
// each dot moves away from every other within the radius. Left the
// start, right after 40 steps.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const start = material(t.times(120, () => {
    const a = t.rnd(Math.PI * 2); const r = 9 * Math.sqrt(t.rnd());
    return [25 + Math.cos(a) * r, 25 + Math.sin(a) * r];
  }));
  const spread = start.steps(40, (cur, next) => {
    const repel = force.separation(cur, { radius: 7 });
    next.move((p) => mul(repel(p), 0.12));
  });
  return [start.points.map((p) => circle(p.x, p.y, 0.5)), spread.points.map((p) => circle(p.x + 50, p.y, 0.5))];
});
```

```ts live
import { sketch, stroke, circle, material, force, mul } from 'occlude';

// attract — an even field of dots gathers toward three anchors; every
// dot's path over 90 small steps is drawn from the history, so the pull
// reads as a comb of trails bending toward each anchor. The anchors
// are drawn as what they are; the dots start where the trails begin.
export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  const b = t.bounds(); // the grid and the anchors share the drawable's own units
  const anchors = [[0.22 * b.w, 0.6 * b.h], [0.54 * b.w, 0.24 * b.h], [0.82 * b.w, 0.72 * b.h]];
  const toward = force.attract(anchors, { radius: 0.34 * b.w, strength: 1 });
  const dots = material(t.grid({ cols: 24, rows: 12 }).map((c) => [c.cx, c.cy]));
  const gathered = dots.steps(90, (cur, next) => next.move((p) => mul(toward(p), 0.08)), { every: 1 });
  const trail = (i) => gathered.history.map((h) => [h.material.x[i], h.material.y[i]]);
  return [
    anchors.map(([x, y]) => circle(x, y, 1.6, { pen: 'stabilo-88-blue' })),
    dots.points.map((p) => stroke(trail(p.index))),
    dots.points.map((p) => circle(p.x, p.y, 0.3)),
  ];
});
```

```ts live
import { sketch, stroke, circle, material, force } from 'occlude';

// drift — trails under noise alone, three frequencies side by side: the
// same dots, the same amount and rate, and a noise read at 0.008, 0.04
// and 0.25 per mm. Coarse noise carries neighbours along together in
// long arcs; fine noise curls each one on its own. `band` is the sketch's
// column picking the force.
export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const b = t.bounds();
  const drifts = [0.008, 0.04, 0.25].map((frequency) => force.drift(t.noise, { amount: 0.22, frequency }));
  const dots = material(t.grid({ cols: 18, rows: 6 }).map((c) => [c.cx, c.cy])).attribute('band', (p) => Math.min(2, Math.floor((3 * p.x) / b.w)));
  const wandered = dots.steps(100, (cur, next, k) => next.move((p) => drifts[p.band](p, k)), { every: 1 });
  const trail = (i) => wandered.history.map((h) => [h.material.x[i], h.material.y[i]]);
  return [dots.points.map((p) => stroke(trail(p.index))), dots.points.map((p) => circle(p.x, p.y, 0.3))];
});
```

```ts live
import { sketch, stroke, rect, curl, force, sum, mul } from 'occlude';

// vortex + field — the other shape, p => vector, needs no helper. A
// rectangle's outline is carried by a vortex and a curl field with no
// growth at all: the same `.steps()` verb, a different rule. Every 10th
// state is drawn, so the drift reads as nested frames.
export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const swirl = force.vortex({ x: 50, y: 25 }, { strength: 1.6, falloff: 30 });
  const flow = force.field(curl((x, y) => t.noise(x / 30, y / 30) * 3));
  const carried = t.sample(rect(22, 8, 56, 34), { spacing: 1 }).steps(40, (cur, next) => {
    next.move((p) => mul(sum(swirl(p), flow(p)), 0.35));
  }, { every: 10 });
  return carried.history.map((h) => stroke(h.material.contour));
});
```

```ts live
import { sketch, stroke, curve, force, mul } from 'occlude';

// relax — Laplacian smoothing as a force. The rough outline is drawn
// faint where it started; over it, the same outline after 6 and after
// 24 relaxations. Corners go first, the count stays, nothing is resampled.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const rough = curve(t.times(40, (i) => {
    const a = (i / 40) * Math.PI * 2;
    const r = 18 + t.rnd(-5, 5);
    return [50 + Math.cos(a) * r * 1.6, 25 + Math.sin(a) * r];
  }));
  const settled = rough.steps(24, (cur, next) => {
    const smooth = force.relax(cur, { amount: 0.5 });
    next.move((p) => mul(smooth(p), 1));
  }, { every: 6 });
  const at = (i) => settled.history[i].material.contour;
  return [stroke(at(0), { pen: 'pigma-005-black' }), stroke(at(1), { pen: 'stabilo-88-green' }), stroke(at(4), { pen: 'stabilo-88-blue' })];
});
```

```ts live
import { sketch, stroke, circle, rect, force, mul } from 'occlude';

// Kept on the page: `boundary` turns the growth back a little inside the
// frame's edge, `attract` draws it toward three anchors, and the rest is
// the ordinary ring rule. The frame and anchors are drawn as what they are.
export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const frame = rect(4, 4, 92, 42);
  const keep = force.boundary(t.polylines(frame), { radius: 6, strength: 2 });
  const anchors = [[16, 24], [50, 9], [84, 40]];
  const toward = force.attract(anchors, { radius: 40, strength: 0.5 });
  const wander = force.drift(t.noise, { amount: 0.2 });
  const grown = t.sample(circle(50, 25, 4), { count: 30 }).steps(240, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 1 }), force.separation(cur, { radius: 2.2, excludeConnected: true }), keep, toward, wander);
    next.move((p) => mul(push(p, k), 0.18));
    next.splitEdges((e) => e.length > 1.1 && t.chance(0.3));
  });
  return [frame, anchors.map(([x, y]) => circle(x, y, 1.2)), stroke(grown.contour)];
});
```

### steps

`m.steps(n, (current, next, k) => …, { every? })` — THE iteration
operation: run a rule `n` times and return the final material, ready for
further operations. Growth, relaxation, deformation and erosion are
different rules for this one verb; `.steps(1, rule)` is a single
transition. The rule reads `current` (frozen — every callback sees the
same state, no edit changes what a later one reads) and describes `next`,
which starts as a copy:

| edit | meaning |
|---|---|
| `next.move(p => vector, { where? })` / `next.move(ref, vector)` | displacement; several moves add up |
| `next.set(p => attrs, { where? })` / `next.set(ref, attrs)` | write point attributes; the last write of a field wins |
| `next.setEdges(e => attrs, { where? })` / `next.setEdge(edge, attrs)` | write edge attributes (`edge` a row or view); the last write of a field wins |
| `next.addPoint(position, attributes)` → handle | a new vertex; the handle names it within this batch |
| `next.connect(a, b, edgeAttributes?)` | one undirected edge between rows, views or handles; an existing pair is left as it is and needs no attributes |
| `next.disconnect(edge \| e => bool)` | remove an edge, both points stay; repeating it is a no-op |
| `next.remove(ref \| p => bool)` | delete a point and its incident edges; neighbours are never joined; repeating it is a no-op |
| `next.split(edge, { at?, point?, edges? })` → handle | replace an edge with two through a new vertex; at 0 or 1, the existing endpoint. Options are recorded as they are at the call (records copied, callbacks kept) |
| `next.splitEdges(e => bool, { at?, point?, edges? })` | bulk split on the MOVED edges — moves first, then `where` sees each edge as it will be; at 0 or 1 nothing is created (the same rule as `split`) |
| `next.extend(p => spec \| spec[], { where? })` | for each selected vertex, a new child `{ position, attributes }` or a connection `{ to }`, joined to it |

A reference is a row of the current state, a vertex view of the current
state, or a handle from this batch — never a bare number meaning an edge;
edges are passed as views (`cur.edge(i)`, `cur.edges`, a query result).
Views and handles are checked for ownership, not just range: a view of
another material, or a handle from another step, is an error even when
its row happens to exist.

A new point or edge must name every declared column — inheriting is not
a default for something with no source. A split has a source: the
inserted vertex inherits its point attributes by each column's transfer
policy (interpolate unless declared `nearest`), the child edges copy the
parent's edge attributes, and `point` / `edges` overrides merge on top —
a record, or a callback of the moved parent edge (and, for `edges`, the
child's `{ from, to, fraction }` interval). Halve only at a midpoint; for
other parameters conserve a length-like attribute with `fraction`. (The
older `attributes` option is `point` by another name; `parent`, which
rewrote the start vertex, is kept only for the old "edge attribute on
its start vertex" idiom — real edge columns use `edges`.)

Order and conflicts, so a batch is predictable: callbacks and selectors
read the frozen current state; moves and attribute writes apply first;
bulk split predicates and split transfer callbacks read that moved
state; then removals, disconnections, splits (sorted along each original
edge, equal parameters sharing one vertex), added points and connections
resolve, and rows compact once. A removed point that is also moved, set,
split or connected in the same step is a conflict, as are splitting and
disconnecting one edge, or setting attributes on an edge being
disconnected; an explicit disconnect of an edge dying with its point is
allowed. Two different child-edge definitions on one parent in one batch
conflict; the same definition again is fine. A conflicting or malformed
batch throws and publishes nothing.

By default only the final state is kept. `{ every: m }` also captures
iteration 0, every m-th iteration, and the final one — each once, labelled
— on the result's `history` as `{ iteration, material }`; nothing a later
step does can disturb a snapshot, and `iteration` keeps counting across
calls. Each sketch run recomputes from the start: scrubbing an iteration
control re-runs the growth to that point.

```ts live
import { sketch, stroke, circle, force, mul } from 'occlude';

// Differential growth in ten lines: tension + separation + seeded drift,
// split the stretched edges, keep going. This is the ring study.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.12, frequency: 0.1 });
  const grown = t.sample(circle(50, 25, 4), { count: 24 }).attribute('age', 0).steps(150, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 0.8 }), force.separation(cur, { radius: 2, excludeConnected: true }), wander);
    next.move((p) => mul(push(p, k), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 0.9 && t.chance(0.3), { point: { age: 0 } });
  });
  return stroke(grown.contour);
});
```

```ts live
import { sketch, strokes, circle, material, add } from 'occlude';

// Branching through ordinary edits. The frontier is named once — a
// selection of the current state — and drives both edits: the tips
// extend along their heading (bent by noise, pulled back toward up),
// fork now and then, and the same tips hand their activity on. Junctions
// are vertices with three edges; strokes() walks each arm once.
export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const seed = material([[50, 49]], { active: 1, heading: -Math.PI / 2, depth: 0 });
  const tree = seed.steps(30, (cur, next, k) => {
    const tips = cur.selectPoints((p) => p.active === 1 && p.y > 3 && p.x > 3 && p.x < 97);
    next.extend((p) => {
      const turn = t.noise(p.x / 7, p.y / 7, k) * 0.3 - (p.heading + Math.PI / 2) * 0.1;
      const fork = p.depth < 4 && t.chance(0.3);
      const headings = fork ? [p.heading - 0.5 + turn, p.heading + 0.5 + turn] : [p.heading + turn];
      return headings.map((h) => ({
        position: add(p, [Math.cos(h) * 1.6, Math.sin(h) * 1.6]),
        attributes: { active: 1, heading: h, depth: p.depth + (fork ? 1 : 0) },
      }));
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(tree), tree.points.filter((p) => p.active).map((p) => circle(p.x, p.y, 0.5))];
});
```

```ts live
import { sketch, stroke, circle, material, curl, force, sum, mul } from 'occlude';

// A point cloud, no topology at all: forces still work, and the wall
// that deflects it is a separate sampled outline that never moves. A
// band of dots streams left to right on a light noise wind and parts
// around the wall; `mobility`, an ordinary column, scales how far each
// one goes. Sampled obstacle repulsion is not the continuous `boundary`.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const cloud = material(t.scatter({ spacing: 2 }).map((p) => [p.x / 5 + 2, p.y]))
    .attribute('mobility', (p) => 0.6 + 0.4 * t.noise(p.y / 6));
  const wall = t.sample(circle(46, 25, 8), { spacing: 0.8 });
  const avoid = force.separation(wall, { radius: 9 });
  const gusts = force.field(curl((x, y) => t.noise(x / 25, y / 25) * 2));
  const moved = cloud.steps(160, (cur, next) => {
    next.move((p) => mul(sum(avoid(p), gusts(p), [2, 0]), p.mobility * 0.18));
  });
  return [stroke(wall.contour), moved.points.map((p) => circle(p.x, p.y, 0.35))];
});
```

### structure and queries

Structural helpers are ordinary functions over the edit interface;
nothing registers them. Three that come up:

```ts
// prune: drop the tips older than a lifespan, edges and all
next.remove((p) => p.degree === 1 && p.age > lifespan);   // (degree is the sketch's own column)

// replace an edge with a bend through a new junction
function fork(next, edge, position) {
  next.disconnect(edge);
  const junction = next.addPoint(position, { age: 0 });
  next.connect(edge.a, junction, { rest: edge.attrs.rest / 2 });
  next.connect(junction, edge.b, { rest: edge.attrs.rest / 2 });
  return junction;                      // a third branch can connect here
}

// attach a tip to the edge its next step would cross
const edges = query.edges(current);     // prepared once for this state
const hit = edges.firstHit(p, target, { excludeIncident: p });
if (hit) next.connect(p, next.split(hit.edge, { at: hit.t }));
```

`query.edges(material)` prepares a query over a frozen state's sampled
straight edges. `nearest(position, { within })` returns `{ edge,
position, t, distance }` or null — `within` inclusive, ties to the earlier
edge, a zero-length edge is a point with `t = 0`. `firstHit(from, to, {
excludeIncident? })` returns the first edge a straight move would meet,
`{ edge, position, t, along, distance, kind }`, by smallest `along` then
edge order; `kind` is `crossing`, `touch` (endpoint contact, or a
zero-length move) or `overlap` (collinear: the start of the overlapping
interval). `t` is along the source edge in stored a → b order. Queries
return information and never edit; results belong to the state they were
asked of, and the index does not see additions made in the same step.
Preparation builds a grid over the edges; a query as long as a growth
step costs tens of microseconds on 35k edges (a thousand 2 mm `firstHit`
queries: 23 ms), and a query spanning the whole drawing falls back to the
plain scan (about a millisecond each).

```ts live
import { sketch, strokes, circle, material, query, add } from 'occlude';

// Growing tips join what they meet: each tip looks one step ahead with
// firstHit; a hit splits that edge and connects to it, a miss extends.
// The frontier is one selection driving both edits. Junctions are
// ordinary vertices; strokes() walks each arm once.
export default sketch({ aspect: [2, 1], seed: 17 }, (t) => {
  const seeds = material(t.times(7, (i) => [12 + i * 12.5, 46]), { active: 1, heading: -Math.PI / 2 });
  const web = seeds.steps(34, (cur, next, k) => {
    const edges = query.edges(cur);
    const tips = cur.selectPoints((p) => p.active === 1 && p.y > 4);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 8, p.y / 8, k * 0.01) * 0.7;
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
      return { position: target, attributes: { active: 1, heading: h } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(web), web.points.filter((p) => p.active).map((p) => circle(p.x, p.y, 0.5))];
});
```

```ts live
import { sketch, stroke, strokes, circle, force, mul } from 'occlude';

// Prune: a grown ring, faint, and over it what survives two ordinary
// edits after growth — every edge stretched past a breaking length is
// disconnected and every vertex younger than four steps is removed.
// The gaps are the decision, not a rendering fault.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.12, frequency: 0.1 });
  const grown = t.sample(circle(50, 25, 5), { count: 30 }).attribute('age', 0).steps(120, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 0.9 }), force.separation(cur, { radius: 2.2, excludeConnected: true }), wander);
    next.move((p) => mul(push(p, k), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 1.1 && t.chance(0.3), { point: { age: 0 } });
  });
  const cut = grown.steps(1, (cur, next) => {
    next.disconnect((e) => e.length > 1.05);
    next.remove((p) => p.age < 4);
  });
  // the survivors first: ink that coincides with earlier ink is dropped by the engine, so the faint ring must come after
  return [strokes(cut, { pen: 'stabilo-88-blue' }), stroke(grown.contour, { pen: 'pigma-005-black' })];
});
```

### selections, extraction, relations

A selection names part of one state — the points or edges a predicate
picked — without copying positions or changing anything. The predicate
runs once; membership is then fixed. `.points` / `.edges` are the
source's own views (same row numbers, same ownership), so native array
methods do the rest. Independent material is made on purpose with
`extract()`.

| value | meaning |
|---|---|
| `m.selectPoints(p => bool)` / `m.selectEdges(e => bool)` | a source-bound selection: `source`, `size`, `indices` (source rows, ascending, frozen), `has(view)` |
| `sel.has(view)` | true for a selected view OF THE SOURCE; a view of another state is never a member; the other domain's view is an error |
| `sel.union(o)` / `intersect(o)` / `subtract(o)` | new selection, same domain and exact source only — equal rows in different states are not identities |
| `points.extract()` | the selected points and every point column, NO edges (edge columns stay declared, empty) |
| `points.inducedEdges()` | the source edges with both ends selected — existing connections, never new ones |
| `edges.extract()` | the selected edges, their endpoints and both attribute domains; stored orientation kept |
| `edges.points` | the endpoints, each once, source order (not every point of the source) |
| `edges.curves()` | the selected edges as chains, each once; junctions and ends of the SELECTED graph; `indices` are source rows |

Extracted material is a fresh evolution: iteration 0, no history, transfer
policies carried, rows compacted in source order. Nothing is merged,
welded, deduplicated or interpolated on the way. Point extraction keeps
isolated selections; `inducedEdges().extract()` drops a selected point
that has no selected edge — pick the one you mean.

Inside a rule, select from `current`; an outer selection is of another
state and its `has` answers false for `current`'s views. The one place a
current-state selection cannot vouch for a view is `splitEdges`, whose
predicate sees the MOVED edges: iterate `sel.edges` and call
`next.split(e)` per edge instead.

Relations are ordinary functions over what exists: `m.connectedPoints(p)`
is adjacency as views (no spatial search), `meanBy(items, fn)` the scalar
mean (0 of nothing; NaN propagates), `components(m)` one prepared
connected-components pass with `count`, a source-aligned `labels` column
and `label(vertex)`. Distance to other material is `query.edges(...)`
prepared once outside the attribute callback; nearby points are
`neighbours`. Connected and nearby are different questions.

```ts live
import { sketch, strokes, circle, connect, ui } from 'occlude';

// Selection: the edges longer than a threshold drawn heavy, the rest of
// the mesh lightly (the complement is a selection too), and the points
// the long edges touch as dots. Move `longest` and watch membership
// change; nothing is rebuilt.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const longest = ui(9, { min: 3, max: 14, step: 0.5 });
  const mesh = connect.triangulate(t.grid({ cols: 13, rows: 7 }).map((c) => [c.cx + t.rnd(-2.2, 2.2), c.cy + t.rnd(-2, 2)]));
  const long = mesh.selectEdges((e) => e.length > longest);
  return [
    strokes(long.complement(), { pen: 'pigma-005-black' }),
    strokes(long, { pen: 'stabilo-88-blue' }),
    long.points.map((p) => circle(p.x, p.y, 0.9, { pen: 'stabilo-88-blue' })),
  ];
});
```

```ts live
import { sketch, strokes, circle, group, force, mul, ui } from 'occlude';

// Extraction, left to right: the source ring with its selected arc heavy
// and the rest faint; the arc extracted as its own material, alone; the
// extracted arc relaxed on its own, over the faint remainder — the source
// never moves. Placement is the drawing's (a translated group), not the
// material's. `cut` is the selection's height.
export default sketch({ aspect: [3, 1], seed: 11 }, (t) => {
  const cut = ui(48, { min: 20, max: 80, step: 1 });
  const ring = t.sample(circle(50, 50, 34), { count: 48 }).steps(1, (_, next) => next.move(() => [t.rnd(-4, 4), t.rnd(-4, 4)]));
  const arc = ring.selectEdges((e) => e.a.y < cut && e.b.y < cut);
  const piece = arc.extract();                                       // iteration 0, no history, its own rows
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

```ts live
import { sketch, stroke, strokes, circle, group, connect, meanBy, segmentRuns } from 'occlude';

// Relational attributes: the same mesh twice. Three vertices carry
// `hot = 1`, every other vertex 0. Left: edges are drawn heavy only
// where BOTH ends are hot — nothing, since no two hot vertices touch.
// Right: `warmth` is the mean of `hot` over each vertex's connected
// neighbours, and the edges between warm vertices light up: a halo of
// exactly the neighbourhood, derived from the topology, not the position.
export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const b = t.bounds();
  const mesh = connect.triangulate(t.grid({ cols: 9, rows: 8 }).map((c) => [c.cx * 0.48 + t.rnd(-1.2, 1.2), c.cy + t.rnd(-1.4, 1.4)]));
  const hotRows = [12, 39, 61];
  const raw = mesh.attribute('hot', (p) => (hotRows.includes(p.index) ? 1 : 0));
  const warm = raw.attribute('warmth', (p) => meanBy(raw.connectedPoints(p), (q) => q.hot));
  const halo = warm.selectEdges((e) => e.a.warmth > 0 && e.b.warmth > 0);
  const marks = (m) => m.points.filter((p) => p.hot === 1).map((p) => circle(p.x, p.y, 1.1, { pen: 'stabilo-88-blue' }));
  return [
    strokes(raw, { pen: 'pigma-005-black' }),
    segmentRuns(raw, (a, b) => (a.hot === 1 && b.hot === 1 ? 1 : 0)).filter((r) => r.key === 1).map((r) => stroke(r, { pen: 'stabilo-88-blue' })),
    marks(raw),
    group({ translate: [b.w / 2, 0] }, strokes(halo.complement(), { pen: 'pigma-005-black' }), strokes(halo, { pen: 'stabilo-88-blue' }), marks(warm)),
  ];
});
```

```ts live
import { sketch, stroke, circle, material, append, connect, components, segmentRuns } from 'occlude';

// Components: separate chains, a ring, and lone points in one material.
// components() labels each piece once; the pen cycles by label and a
// tally of label + 1 dots sits by the piece's first vertex, so every
// label is readable even where the pens repeat. Isolated vertices are
// pieces too.
export default sketch({ aspect: [2, 1], seed: 14 }, (t) => {
  const chain = (x, y, n) => connect.chain(t.times(n, (k) => [x + k * 3.2, y + t.noise(x + k, y) * 6]));
  let all = append(chain(6, 10, 8), chain(40, 8, 10));
  all = append(all, chain(72, 12, 7));
  all = append(all, chain(10, 34, 12));
  all = append(all, connect.ring(t.times(12, (k) => [66 + Math.cos(k / 12 * Math.PI * 2) * 8, 34 + Math.sin(k / 12 * Math.PI * 2) * 8])));
  all = append(all, material([[50, 22], [88, 42], [30, 46], [92, 20]]));
  const pieces = components(all);
  const labelled = all.attribute('piece', (p) => pieces.label(p), { transfer: 'nearest' });
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  const first = t.times(pieces.count, (label) => labelled.points.find((p) => p.piece === label));
  return [
    segmentRuns(labelled, (a) => a.piece).map((r) => stroke(r, { pen: pens[r.key % 3] })),
    labelled.points.filter((p) => labelled.degree(p) === 0).map((p) => circle(p.x, p.y, 0.5, { pen: pens[p.piece % 3] })),
    first.map((p) => t.times(p.piece + 1, (k) => circle(p.x + k * 1.5, p.y - 3.5, 0.45, { pen: pens[p.piece % 3] }))),
  ];
});
```

```ts live
import { sketch, stroke, circle, rect, query, material, append, ui } from 'occlude';

// Distance as a column: two obstacles' outlines are prepared once as an
// edge query, and every point of an even grid records its distance to
// the nearest sampled edge — a dot's size. Beyond `within` the query
// answers null and the artist's fallback shows as the largest dots.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const within = ui(12, { min: 3, max: 30, step: 1 });
  const box = t.sample(rect(14, 12, 24, 22), { spacing: 1 });
  const disc = t.sample(circle(68, 27, 11), { spacing: 1 });
  const edges = query.edges(append(box, disc));                    // once, outside the callback
  const grid = material(t.times(33 * 16, (i) => [2.5 + (i % 33) * 3, 2.5 + Math.floor(i / 33) * 3]));
  const measured = grid.attribute('distance', (p) => edges.nearest(p, { within })?.distance ?? within);
  return [
    stroke(box.contour), stroke(disc.contour),
    measured.points.filter((p) => p.distance > 0.6).map((p) => circle(p.x, p.y, 0.15 + 1.15 * (p.distance / within))),
  ];
});
```

### planarize, faces, boundaries

The spaces a network encloses are data too. `m.planarize()` is the
explicit step that makes every crossing and every endpoint-on-edge
contact a shared vertex — nothing else planarizes for you, because
connecting lines that merely cross is a decision. `m.faces()` then reads
the bounded regions of that planar state; a tree has none, a ring one, a
square with a diagonal two. Faces are derived data of one state: select
them by measurement, draw their contours, or outline the union of a
selection with the walls between chosen cells removed.

| value | meaning |
|---|---|
| `m.planarize({ point?, edges? })` | independent material: crossings and contacts shared, edges split in order, isolated points kept, iteration 0. Overlaps, duplicate edges, zero-length edges and non-finite input are errors naming the rows |
| `point: (event) => attrs` | resolves competing point attributes at an event (`event.position`, `event.candidates[{ vertex? \| edge?, t?, attrs }]` by vertex then edge row); needed only where candidates disagree |
| `edges: (parent, child) => attrs` | child edge attributes over the parent's, once per child `{ from, to, fraction }` (an unsplit edge has fraction 1) |
| `m.faces()` | the bounded faces of a planar state: `source`, `size`, `iteration`, `faces[]`, `map`, `select(f => bool)`, `boundaries()`. Crossings without a shared vertex are an error that says to planarize |
| `face` | `index`, `area` (outer minus holes), `perimeter` (outer and holes, no retraced branches), `bounds {x, y, w, h}`, `contours` (closed records `polygon` and `stroke` accept) |
| `cells.select(f => bool)` | a fixed-membership face selection: `source` (the collection), `indices`, `size`, `has(face)`, `union / intersect / subtract` within one collection |
| `sel.boundaries()` | closed contours around the union of the selected faces: shared walls omitted, walls against unselected faces or the outside kept, holes kept |

Numbers: orientation is decided exactly (Shewchuk's `orient2d`), so
"crosses", "touches" and "collinear" never depend on an epsilon.
Intersection positions are floating point; the one tolerance is event
consolidation at 1e-9 in edge parameter, and it joins only events proven
to be one point (three lines through a point: each pair's crossing agrees
with the third; a crossing at a vertex: the vertex lies exactly on both
edges). Merely close events stay distinct, and two distinct events on
identical coordinates are rejected as ambiguous. A vertex an edge passes
through (a T-junction) reconciles its attributes against that edge like
a crossing does. Endpoints merge only when exactly coincident; a gap
stays a gap. Contours come out with
the outer boundary at positive signed area and holes negative — use
`winding: 'evenodd'` and holes are unambiguous either way. Bridges and
dangling branches inside a face are not part of its contours or its
perimeter. Isolated points, even one lying on an edge, take part in no
face.

Measured (this machine): 82 grid lines with 1,681 crossings planarize in
18 ms and give 1,600 faces in 33 ms; 400 random chords (18,915 vertices,
36,630 edges) planarize in 118 ms and give 17,716 faces in 355 ms; a
5,967-edge triangulation gives its 3,968 faces in 51 ms. Planarization
sweeps x-sorted edge boxes, so it is O(E log E + overlapping pairs);
face discovery is O(E log E) plus hole assignment across nested
components.

Drawing every face's contours repeats every shared wall. Say what you
mean instead: fill the cells with `stroke: false` and stroke the network
once, or stroke only a selection's `boundaries()`.

```ts live
import { sketch, strokes, circle, polygon, fill, mm, group, rect, line, append } from 'occlude';

// Crossings become cells. Left: a frame and five chords, each an ordinary
// shape sampled to material and appended — the frame alone encloses one
// face, and the chords merely cross it, so faces() would refuse until the
// crossings are shared vertices. Right: the same network planarized;
// every crossing is now a vertex (marked) and each cell it encloses fills
// at its own angle. One chord stops short of the frame: the gap stays a
// gap, so the hatch runs unbroken across it — the two sides are one cell.
export default sketch({ aspect: [2, 1] }, (t) => {
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const net = [
    t.sample(rect(4, 4, 42, 42), { count: 4 }),
    chord(4, 16, 46, 30), chord(12, 4, 30, 46), chord(4, 38, 46, 10), chord(34, 4, 40, 46),
    chord(20, 24, 46, 42), // stops short of the left frame
  ].reduce((a, b) => append(a, b));
  const planar = net.planarize();
  const cells = planar.faces();
  return [
    strokes(net),
    group({ translate: [50, 0] },
      cells.map((f, k) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: (k * 37) % 180, spacing: mm(1.3) }), stroke: false })),
      strokes(planar),
      planar.points.filter((p) => p.index >= net.n).map((p) => circle(p.x, p.y, 0.8, { pen: 'stabilo-88-blue' })),
    ),
  ];
});
```

```ts live
import { sketch, strokes, polygon, fill, mm, connect, ui } from 'occlude';

// Select by area. A jittered grid triangulated into cells; the cells at
// least `minimum` in area fill, the rest stay empty, and the network is
// stroked once. Drag `minimum` and watch membership change.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const minimum = ui(30, { min: 2, max: 60, step: 1, label: 'minimum area' });
  const cells = connect.triangulate(t.grid({ cols: 11, rows: 6 }).map((c) => [c.cx + t.rnd(-3.5, 3.5), c.cy + t.rnd(-3, 3)])).faces();
  const chosen = cells.select((f) => f.area >= minimum);
  return [
    chosen.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 30, spacing: mm(1.4) }), stroke: false })),
    strokes(cells.source, { pen: 'pigma-005-black' }),
  ];
});
```

```ts live
import { sketch, strokes, polygon, fill, mm, group, append, curve, ui } from 'occlude';

// Holes and removed walls. A ring split by a wall, with a smaller ring
// inside: three faces. Left, the chosen faces drawn one by one — shared
// walls are drawn twice, and the inner disk is a hole in the annulus
// halves. Right, `chosen.boundaries()`: the wall between the two chosen
// halves is gone and the hole is kept — until `inner` selects the disk
// too, when that boundary disappears as well.
export default sketch({ aspect: [2, 1] }, (t) => {
  const inner = ui(false, { label: 'select the inner disk' });
  let net = append(curve([[6, 6], [44, 6], [44, 44], [6, 44]], { closed: true }), curve([[18, 18], [32, 18], [32, 32], [18, 32]], { closed: true }));
  net = append(net, curve([[6, 25], [18, 25]], { closed: false }));   // a wall from the frame to the inner ring
  net = append(net, curve([[32, 25], [44, 25]], { closed: false }));
  const cells = net.planarize().faces();
  const chosen = cells.select((f) => f.area > 300 || inner);          // the two halves, and the disk when asked
  const hatch = fill('hatch', { angle: 45, spacing: mm(1.1) });
  return [
    chosen.map((f) => polygon(f.contours, { winding: 'evenodd', fill: hatch })),
    group({ translate: [50, 0] },
      polygon(chosen.boundaries(), { winding: 'evenodd', fill: hatch, stroke: false }),
      strokes(chosen.boundaries(), { pen: 'stabilo-88-blue' }), // after the fill: fills are opaque
    ),
  ];
});
```

```ts live
import { sketch, strokes, polygon, fill, mm, connect, banding } from 'occlude';

// A hatched cellular drawing with no growth in it: a jittered grid
// triangulated, its cells banded by area on their own extent, each band
// hatched at its own spacing and angle — small cells dense, large cells
// open — and the network stroked once over the fills.
export default sketch({ aspect: [2, 1], seed: 33 }, (t) => {
  const cells = connect.triangulate(t.grid({ cols: 14, rows: 7 }).map((c) => [c.cx + t.rnd(-2.6, 2.6), c.cy + t.rnd(-2.4, 2.4)])).faces();
  const band = banding.over(cells.map((f) => f.area), { count: 3 });
  const hatches = [fill('hatch', { angle: 30, spacing: mm(1.3) }), fill('hatch', { angle: 30, spacing: mm(2.6) }), fill('hatch', { angle: 30, spacing: mm(5) })];
  return [
    cells.map((f) => polygon(f.contours, { winding: 'evenodd', fill: hatches[band(f.area)], stroke: false })),
    strokes(cells.source, { pen: 'pigma-005-black' }),
  ];
});
```

### transfer, references, lineage

Three questions, three answers, one table. *Interpolation*: what value
belongs between two samples. *Subdivision*: what each child inherits
from its parent edge. *Reconciliation*: what value belongs where
independent pieces meet. Policies are declared once on the column and
honoured by every operation; a per-operation option overrides for that
call only.

| operation | point columns | edge columns | rows, iteration, history |
|---|---|---|---|
| `attribute(name, v, { transfer? })` / `edgeAttribute(name, v, { transfer? })` | sets the column; `transfer` `'interpolate'` (default) or `'nearest'` (categorical); a value update keeps the declared policy | `transfer` `'copy'` (default, categorical) or `'distribute'` (a quantity: a length share) | rows and iteration kept, history dropped |
| `connect.*`, `withEdges`, `Next.connect` | — | every declared column must be given for a new edge; an existing pair needs nothing | kept |
| `append(a, b, { fill, edgeFill })` | columns must match or be filled; effective policies must agree | same | b's rows after a's; iteration 0, a new lineage |
| `split` / `splitEdges` / `extend` / `addPoint` | the new vertex inherits by the policy (interpolate or nearest along the parent), then `point` overrides; a new point must give every column | children copy or share the parent by the policy, then `edges(parent, child)` overrides | split vertices sit after their edge's start row; iteration +1 per step |
| `resample` | by the policy, or a per-call `transfer: { col: 'nearest' \| number \| fn }` | `'copy'`: the source edge under the new edge's midpoint; `'distribute'`: the sum of each covered source edge's value times the share covered | rows renumbered; iteration kept (a continuation of the same lineage) |
| `planarize` | candidates from every edge through the event by the policy; equal candidates pass, disagreeing ones need `point(event)` — a conflict is evidence, never resolved by picking a side | children copy or share by the policy, then `edges(parent, child)` | iteration 0, a new lineage |
| `extract()` | copied | copied | rows compacted in source order; iteration 0 |

References: a point is a row, a vertex view of this state, or a handle
from this batch; an edge is a row or an edge view (`EdgeRef`). Every
accessor (`degree`, `connected`, `prev`, `next`, `connectedPoints`) takes
a row or a view and refuses a view of another state. `where` on any
collection edit takes a predicate over the current views or a selection
OF THE CURRENT STATE — membership by row, decided when the selection was
made, before any move in the step — so the same selection drives
`extend`, `set`, `remove`, `setEdges`, `disconnect` and `splitEdges`
(whose predicate form sees the moved edges).

Units: `t.sample({ spacing })` resolves a paper length; `resample({
spacing })` is in material units, the coordinates the material holds.
Iteration counts the steps on a lineage; `append`, `extract` and
`planarize` start a new one at 0; history belongs to the `steps` call
that captured it and no derivation carries it.

### resample

`m.resample({ spacing | count, transfer? })` — redistribute a deformed
chain's vertices evenly by arc length. Chains only (a junction is an
error, for now). Open chains keep both endpoints, closed ones their seam
at the first vertex; separate chains stay separate. Corners are NOT
preserved: a new vertex lands on the old polyline, but a corner between
two new vertices is cut. Attributes carry over per `transfer`: linear
interpolation for every column by default; `'nearest'` (ties to the start
vertex), a constant, or a function `(a, b, t) => value` per column say
otherwise — a display curve may interpolate `age`, a simulation point may
want it reset. Each new edge takes the edge attributes of the source edge
under its midpoint. Splitting adds detail and keeps every vertex; resampling
may remove them. Neither smooths.

```ts live
import { sketch, stroke, circle, rect, force, mul } from 'occlude';

// A rectangle's outline pushed around by a vortex, then resampled evenly
// for the pen: left as deformed (vertices drawn), right resampled at 1.5.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const swirl = force.vortex({ x: 25, y: 25 }, { strength: 5, falloff: 6 });
  const bent = t.sample(rect(10, 10, 30, 30), { spacing: 3 }).steps(30, (cur, next) => {
    next.move((p) => mul(swirl(p), 0.3));
  });
  const even = bent.resample({ spacing: 1.5 });
  return [
    stroke(bent.contour), bent.points.map((p) => circle(p.x, p.y, 0.35)),
    stroke({ pts: even.pts.map(([x, y]) => [x + 50, y]), closed: true }),
    even.points.map((p) => circle(p.x + 50, p.y, 0.35)),
  ];
});
```

### segmentRuns, extent, banding

`extent(column)` is `[min, max]` (`[0, 0]` when empty). `banding({ min,
max, count })` is a classifier into `count` equal bands, clamped at both
ends, everything in band 0 for a constant range. `segmentRuns(m, (a, b)
=> key)` classifies every edge by its two vertices (a → b in stored
order) and gathers consecutive equal keys into runs, chain by chain: runs
end at endpoints and junctions, never split across a closed chain's seam,
and meet end to end so together they redraw every edge once; a uniform
closed chain is one closed run. The key type is whatever your classifier
returns. The classification is yours: a vertex attribute needs an
interpretation before it can own an edge — the start vertex's, the end's,
both, or their mean are different drawings. Measurement, classification
and pen assignment stay three separate lines.

```ts live
import { sketch, stroke, circle, force, sum, mul, segmentRuns, extent, banding } from 'occlude';

// The same grown ring, cut into runs by age band: young edges in one pen,
// old ones in another — chosen after the growth, not inside it.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.1, frequency: 0.1 });
  const last = t.sample(circle(50, 25, 5), { count: 24 }).attribute('age', 0).steps(60, (cur, next, k) => {
    const pull = force.tension(cur, { rest: 0.8 });
    const repel = force.separation(cur, { radius: 2, excludeConnected: true });
    next.move((p) => mul(sum(pull(p), repel(p), wander(p, k)), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 0.9 && t.chance(0.3), { point: { age: 0 } });
  });
  const [young, old] = extent(last.attrs.age);
  const band = banding({ min: young, max: old, count: 2 });
  const pens = ['stabilo-88-blue', 'pigma-005-black'];
  return segmentRuns(last, (a, b) => band((a.age + b.age) / 2)).map((r) => stroke(r, { pen: pens[r.key] }));
});
```

### one material, four drawings

Generation runs once; each panel is the same value read differently —
strokes, an attribute as bands, the cells it encloses, its junctions
and tips as marks. Placement is the drawing's (`group` translates), never
the material's.

```ts live
import { sketch, stroke, strokes, circle, polygon, fill, mm, group, material, query, add, segmentRuns, banding } from 'occlude';

export default sketch({ aspect: [2, 2], seed: 7 }, (t) => {
  const seeds = material(t.times(6, (i) => [8 + i * 6.8, 46]), { active: 1, heading: -Math.PI / 2, age: 0 });
  const web = seeds.steps(30, (cur, next, k) => {
    const edges = query.edges(cur);
    const tips = cur.selectPoints((p) => p.active === 1 && p.y > 4 && p.x > 2 && p.x < 48);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 8, p.y / 8, k * 0.01) * 0.7;
      const target = add(p, [Math.cos(h) * 1.4, Math.sin(h) * 1.4]);
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0, age: k } }) };
      const kids = [{ position: target, attributes: { active: 1, heading: h, age: k } }];
      if (t.chance(0.1)) kids.push({ position: add(p, [Math.cos(h + 0.8) * 1.4, Math.sin(h + 0.8) * 1.4]), attributes: { active: 1, heading: h + 0.8, age: k } });
      return kids;
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  // 2. banded by age — the vertex's own column, three pens
  const band = banding.over(web.attrs.age, { count: 3 });
  const pens = ['pigma-01-black', 'stabilo-88-green', 'stabilo-88-blue'];
  // 3. the cells it encloses: a planar copy (crossings need a resolver only if columns disagree — `age` differs, so say what a crossing's age is)
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
