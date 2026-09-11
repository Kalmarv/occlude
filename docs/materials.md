# Materials

Geometry as data you can hold: points with attributes, edges between them, selections of parts, rules that move and grow them, the regions they enclose, and drawing one material several ways. The page runs from sampled points, through connections and selections, to movement and growth, then faces and resampling, and ends with a worked study that reads one material four ways.

## Point distributions

`t.scatter(field?, { spacing })` places Poisson-disk points over the drawable and returns point-only material with one computed column, `density`: the field's value at each point, 0 to 1. Where the field is high the local spacing tightens; where it is 0 nothing is placed, and every island of the field is sampled. The material remembers nothing about the field or the spacing; the refinement operations take them as inputs.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const field = (x, y) => Math.max(0, 1 - Math.hypot(x - 100, (y - 50) * 2) / 90);
  return t.scatter(field, { spacing: 3.4 }).points.map((p) => circle(p.x, p.y, 0.7 + p.density * 0.9));
});
```

Two standard refinements, both explicit about what they read:

| Operation | Effect |
|---|---|
| `t.relax(m, { iterations?, density?, bounds?, resolution? })` | Lloyd relaxation: each point moves to the density-weighted centroid of its cell within the bounds (default the drawable). Count, edges and every column are kept; nothing is written. |
| `t.settle(m, { density, spacing, iterations?, bounds?, resolution?, point? })` | Weighted Linde-Buzo-Gray settling: relaxation plus population control. A point whose cell holds more demand than one point's capacity at `spacing` splits, a starved one dies, so the count converges to the density's ink budget. Point-only input; survivors keep their columns, children copy their parent's merged with `point` (a partial record of declared columns, or a callback of the splitting parent: `point: (parent) => ({ age: 0 })` resets a child's age and keeps its species), and `demand` is written: cell demand over capacity, 1 for a full cell. |

Three quantities, three names: `density` is the field at a point, `demand` a cell's integrated density over one point's capacity, and a cell's mean density is `integral / area` from `faces().measure(field)` below. Left, a plain grid; right, the same grid after twelve settle passes over a tone field, dots sized by demand.

```ts live
import { sketch, circle, material } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const dark = (x, y) => Math.max(0.03, 1 - Math.hypot(x - 50, (y - 50) * 1.8) / 50);
  const grid = material(t.grid({ cols: 15, rows: 15 }).map((c) => [c.cx / 2, c.cy]));
  const settled = t.settle(grid, { density: dark, spacing: 4.8, iterations: 12 });
  return [
    grid.points.map((p) => circle(p.x, p.y, 0.6)),
    settled.points.map((p) => circle(p.x + 100, p.y, 0.7 + p.demand * 0.8)),
  ];
});
```

`t.voronoi(sites, { bounds? })` builds the Voronoi cells of a point set as material: its vertices are the cell corners, its edges the walls, and `faces()` reads the cells. Adjacent cells share their corners and one wall, the clipping rectangle (the drawable by default) is explicit, and the result relates to its sites in both directions: `cells.cellOf(site)` gives a site's face, `cells.siteOf(face)` a face's site vertex, both checked against the exact site material. Sites can be a material, its `points`, or a filtered selection of them: a selection keeps its source as the sites, so `cellOf` answers for that source's vertices and unselected rows have no cell. Cocircular sites (a grid, a regular polygon) meet at one shared corner. Sites and corners are different point sets: the sites are your input, the corners are what the cells are made of. Delaunay connectivity stays a connection between the sites, `connect.triangulate(sites)`, whose `faces()` are the triangles. The pure form `voronoi(points, bounds)` takes explicit bounds. Left, the cells of the points in the left half, filled at random; right, the triangles of the points in the right half.

```ts live
import { sketch, polygon, fill, mm, strokes, connect } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const pts = t.relax(t.scatter({ spacing: 9 }), { iterations: 3 });
  const left = pts.points.filter((p) => p.x < 96);
  const right = pts.points.filter((p) => p.x > 104);
  const cells = t.voronoi(left, { bounds: { x: 0, y: 0, w: 98, h: 100 } });
  return [
    cells.faces().map((f) => polygon(f, t.chance(0.25) ? { fill: fill('hatch', { angle: t.rnd(180), spacing: mm(1.1) }), stroke: false } : { stroke: false })),
    strokes(cells),
    strokes(connect.triangulate(right)),
  ];
});
```

A cell is not a live construction: moving a site or a wall does not rebuild anything, and material edited or extracted from the result has no correspondence any more (asking gives an error that says so). Construct the cells again when the sites have moved.

### Density-driven stippling

Scatter, settle toward a tone, then one custom relaxation pass written from the same ingredients the standard recipe uses: the cells of the current points, their density-weighted centres from `measure`, and a partial move toward them. The declared `side` column survives settling and picks the pen; the computed `demand` sizes the dots. With the material layer on in the debug menu, `seeds`, `settled` and `nudged` are all there to inspect.

```ts live
import { sketch, circle, mul, sub } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const tone = (x, y) => Math.max(0, 1 - Math.hypot(x - 100, (y - 50) * 1.6) / 70) * (0.6 + 0.4 * t.noise(x / 20, y / 20));
  const seeds = t.scatter(tone, { spacing: 3 }).attribute('side', (p) => (p.x < 100 ? 0 : 1));
  const settled = t.settle(seeds, { density: tone, spacing: 3, iterations: 20 });
  const nudged = settled.steps(2, (current, next) => {
    const cells = t.voronoi(current);
    const measured = cells.faces().measure(tone, { resolution: 200 });
    next.move((p) => {
      const face = cells.cellOf(p);
      const target = face ? measured.forFace(face).weightedCentroid : null;
      return target ? mul(sub(target, p), 0.3) : [0, 0];
    });
  });
  return nudged.points.map((p) => circle(p.x, p.y, 0.35 + 0.45 * Math.min(1.5, p.demand), { pen: p.side ? 'stabilo-88-blue' : 'pigma-005-black' }));
});
```

## Material

A material is a set of vertices, each with `x`, `y` and any named attribute columns, plus an edge list. A ring, an open chain, a branching tree and an unconnected cloud are all materials. Every operation returns a new material, so an evolution can be kept and any state chosen later. Indices are rows of one state, not identities that persist across states.

| Layer | Vocabulary |
|---|---|
| making | `t.sample(shape)`, `material(points)`, `curve(pts)`, `connect.*`, `.attribute()`, `.resample()` |
| vectors | `add sub mul length distance unit limit perp dot cross fromAngle angleOf sum sumBy`: tuples in either spelling, tuples out, nothing mutated; angles in radians |
| rules | `.steps(n, (current, next, k) => …)` with the collection edits; forces prepared once and evaluated at a point |
| collections | `.points`, `.edges`, `.faces()`: iterate, `length`, `at`, `map`, `filter` (a selection), `groupBy` (selections by key); `.extract()` for independent material; `connectedPoints`, `components`, `meanBy` |
| areas | `.planarize()` shares crossings on purpose; `.faces()` reads the enclosed regions; `boundaries()` outlines a union |
| drawing | `.curves()`, `.along()` for stations to place things at, `strokes()`, `segmentRuns`, `extent`, `banding`, then `stroke`, `polygon`, `circle` |

All are pure imports except `t.sample`, which reads the paper. Shapes stay exact through the engine; sampling is the one explicit lossy step into this vocabulary.

### Making a material

Two conversions take a shape into material. `t.material(shape, { tolerance? })` keeps the boundary's own vertices: a rectangle's four corners, a regular polygon's vertices, a path's points, with curved portions flattened at the tolerance (default 0.05 mm). `t.sample(shape, { count | spacing, tolerance? })` redistributes points along the boundary by arc length instead, so four samples of a rectangle need not land on its corners. Both make a ring from a closed outline (without a duplicate seam vertex), a chain from an open one, and separate chains for separate outlines, welding nothing. `material(points, { edges?, ...columns })` builds one from tuples or `{ x, y }` objects (a scatter point's `w` becomes a column), unconnected unless edges are given, and `curve(pts, { closed?, ...columns })` makes a ring or chain from positions. `material(existingMaterial)` returns that value unchanged; nonempty constructor options with an existing material are rejected. Use `.attributes(...)` or `.withEdges(...)` to edit it. `t.isolines` and `t.streamlines` return material too, so field-generated contours arrive ready for the same operations.

A hexagon's corners pulled toward the centre by an amount that alternates around the ring. Nothing is computed by hand: the corners are the material's rows, and the drawing is the polygon of the result.

```ts live
import { sketch, ngon, polygon, strokes, sub, mul } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const corners = t.material(ngon(100, 50, 6, 40));
  const star = corners.steps(1, (cur, next) => {
    next.move((p) => mul(sub([100, 50], p), p.index % 2 ? 0.45 : 0), { where: () => true });
  });
  return [strokes(corners, { pen: 'pigma-005-black' }), polygon(star, { pen: 'stabilo-88-blue' })];
});
```

`m.attribute(name, constant | p => value, { transfer? })` adds a point column and returns a new material; `m.attributes({ a: …, b: … }, { transfer?: { a: … } })` adds several at once, every initializer reading the material as it is, so no column sees another's new value. `m.edgeAttribute(name, constant | e => value)` and `m.edgeAttributes({ … })` do the same for edge columns, each edge its own row. Read `m.points` (vertex views `{ index, x, y, ...attrs }`), `m.pts` (tuples), `m.x`, `m.y` and `m.attrs.age` (the columns), `m.connected(i)`, `m.degree(i)`, `m.edges` and `m.curves()`.

```ts live
import { sketch, circle, material } from 'occlude';

// A scatter's density is a column, a derived column is added, and two
// readings of the same material sit side by side: dots sized by w on
// the left, the far ones ringed on the right.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const cloud = t.scatter((x, y) => 1 - Math.hypot(x - 50, y - 50) / 60, { spacing: 6 })
    .points.filter((p) => p.x < 98).extract()
    .attribute('far', (p) => Math.hypot(p.x - 50, p.y - 50) > 28 ? 1 : 0);
  return [
    cloud.points.map((p) => circle(p.x, p.y, 0.6 + p.density * 2)),
    cloud.points.filter((p) => p.far).map((p) => circle(p.x + 100, p.y, 3)),
  ];
});
```

### Connections

`connect.chain(m)` and `connect.ring(m)` join consecutive rows in the given order. `connect.nearest(m, { count })` joins each vertex to its `count` nearest others, undirected and without duplicates. `connect.pairs(a, b)` joins row i of `a` to row i of `b` in one material. `connect.triangulate(m)` adds the Delaunay edges. `append(a, b, { fill?, edgeFill? })` puts two materials in one: both need the same columns, or `fill: { active: 0 }` says what the side without `active` gets, and only that side; a missing column with no fill is an error, never a silent zero. A column both sides declare must agree on its transfer policy; a column one side declares keeps that side's policy for the filled rows too.

```ts live
import { sketch, stroke, material, connect } from 'occlude';

// Two ways to connect one cloud: nearest-3 on the left, Delaunay on the right.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const pts = t.scatter({ spacing: 10 }).points.map((p) => [p.x / 2 + 2, p.y]);
  const left = connect.nearest(material(pts), { count: 3 });
  const right = connect.triangulate(material(pts.map(([x, y]) => [x + 100, y])));
  return [left, right].flatMap((m) => m.curves().map((c) => stroke(c)));
});
```

### Vectors

Vectors are tuples `[x, y]`. Every operation accepts `[x, y]` or `{ x, y }` (so a vertex view goes straight in), returns a fresh tuple and mutates nothing. `unit([0, 0])` is `[0, 0]`, so coincident points contribute no direction and no NaN. `mul` is scalar multiplication; `limit(v, max)` caps a length; `sumBy(items, fn)` totals a vector function over a collection. `dot(a, b)` and `cross(a, b)` are the two products, the cross a signed number: positive when `b` lies on the side `perp(a)` points to, negative on the other, zero when parallel or when either is the zero vector, so `Math.sign(cross(heading, toward))` is the side test a steering rule needs. `fromAngle(radians)` is the unit vector `[cos, sin]` and `angleOf(v)` its inverse through `atan2`, both in radians from +x toward +y; `angleOf([0, 0])` is 0.

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

## Collections and selections

`m.points`, `m.edges` and `m.faces()` are geometry collections: iterate them, read `length`, take `at(i)`, `map` to an ordinary array, `find`, `filter` and `groupBy`. `filter` returns a selection: the same kind of collection, bound to the same state, holding the rows the predicate picked in source order, so it filters, iterates, maps and groups again like the whole. Nothing is copied or changed; views are the source's own, with their ownership. `groupBy(classifier)` splits a collection into an array of selections by key, in first-occurrence order, each carrying its `key`; the key is the classification that made the group, not a column, and a later state knows nothing of it. Independent material is made on purpose with `extract()`.

A selection is consumed where its domain makes sense: `strokes(edges)` draws the selected chains, and `polygon`, `distanceTo` and `force.boundary` take an edge selection as a boundary of its own topology, so a ring picked out of a network is an area even though the network is not. A point selection contributes only the edges that already join its members. Faces are areas already: draw them one by one with `cells.map((f) => polygon(f))` or outline their union with `boundaries()`. A face collection is not one area, so it must say which. The same goes for a shape: `polygon(circle(50, 50, 20))` reads the circle's boundary as an area, so a clip needs no separately named value.

| Value | Meaning |
|---|---|
| `coll.filter(v => bool)` | a selection of the same source: `source`, `length`, `indices` (source rows, ascending), `has(view)`, `complement()` |
| `coll.groupBy(v => key)` | selections by key, first-occurrence order, rows in source order, keys compared as a Map compares them; each has `key` |
| `sel.union(o)`, `intersect(o)`, `subtract(o)` | a new selection over the same source; equal rows in different states are not the same thing |
| `points.extract()` | the selected points with every point column and no edges |
| `points.inducedEdges()` | the source edges with both ends selected |
| `edges.extract()` | the selected edges, their endpoints and both attribute domains |
| `edges.points` | the endpoints, each once, in source order, as a point selection |
| `edges.curves()` | the selected edges as chains, each edge once; junctions and ends are those of the selected graph |

Extracted material is a fresh evolution at iteration 0 with no history and its rows compacted in source order. Nothing is merged, welded or interpolated on the way. Inside a rule, filter `current` and pass the selection as `where`; a selection of another state is refused there.

```ts live
import { sketch, strokes, circle, connect, ui } from 'occlude';

// Edges longer than a threshold drawn heavy, the rest light (the
// complement is a selection too), and the points the long edges touch.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const longest = ui(18, { min: 6, max: 28, step: 1 });
  const mesh = connect.triangulate(t.grid({ cols: 13, rows: 7 }).map((c) => [c.cx + t.rnd(-4.4, 4.4), c.cy + t.rnd(-4, 4)]));
  const long = mesh.edges.filter((e) => e.length > longest);
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
  const arc = ring.edges.filter((e) => e.a.y < cut && e.b.y < cut);
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
  const halo = warm.edges.filter((e) => e.a.warmth > 0 && e.b.warmth > 0);
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

`query.edges(material)` prepares a query over a frozen state's edges. `nearest(position, { within, excludeIncident? })` returns `{ edge, position, t, distance }` or null; with `excludeIncident` a tip senses the nearest line that is not its own stem. `firstHit(from, to, { excludeIncident? })` returns the first edge a straight move would meet, `{ edge, position, t, along, distance, kind }`, with `kind` one of `crossing`, `touch` or `overlap`. Queries return information and never edit; results belong to the state they were asked of, and the index does not see additions made in the same step. Prepare once per state, outside the callback that uses it.

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
| `next.extend(p => spec \| spec[], { where?, inherit? })` | for each selected vertex, a new child `{ position, attributes }` or a connection `{ to }`, joined to it; with `inherit: true` a child starts from its parent's columns and `attributes` are overrides, and a `to` target is never changed |

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
| `force.boundary(boundary, { radius, strength? })` | a boundary: loops, contour records or a chain material (see Fields & variation) | inward within `radius` of the edge and everywhere outside |
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
  const cloud = material(t.scatter({ spacing: 4 }).points.map((p) => [p.x / 5 + 4, p.y]))
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
import { sketch, strokes, circle, material, add, mul, fromAngle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const seed = material([[100, 98]], { active: 1, heading: -Math.PI / 2, depth: 0 });
  const tree = seed.steps(30, (cur, next, k) => {
    const tips = cur.points.filter((p) => p.active === 1 && p.y > 6 && p.x > 6 && p.x < 194);
    next.extend((p) => {
      const turn = t.noise(p.x / 14, p.y / 14, k) * 0.3 - (p.heading + Math.PI / 2) * 0.1;
      const fork = p.depth < 4 && t.chance(0.3);
      const headings = fork ? [p.heading - 0.5 + turn, p.heading + 0.5 + turn] : [p.heading + turn];
      return headings.map((h) => ({
        position: add(p, mul(fromAngle(h), 3.2)),
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
import { sketch, strokes, circle, material, query, add, mul, fromAngle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 17 }, (t) => {
  const seeds = material(t.times(7, (i) => [24 + i * 25, 94]), { active: 1, heading: -Math.PI / 2 });
  const web = seeds.steps(34, (cur, next, k) => {
    const edges = query.edges(cur);
    const tips = cur.points.filter((p) => p.active === 1 && p.y > 8 && p.x > 6 && p.x < 194);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 16, p.y / 16, k * 0.01) * 0.7;
      const target = add(p, mul(fromAngle(h), 3));
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
      return { position: target, attributes: { active: 1, heading: h } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(web), web.points.filter((p) => p.active).map((p) => circle(p.x, p.y, 1))];
});
```

### Inspecting a material

With the Material layer on in the studio's debug menu, every variable in the sketch that holds a material, or the stations of `along()`, is listed under its own name: `seed` and `tree` below, with no call needed. Choosing one overlays its points and edges on the drawing, and a declared column colours the chosen domain (point columns colour points, edge columns colour edges, the other stays neutral). Clicking a point or edge shows its row, coordinates and columns, with its incident edges and connected rows as links. Rows are indices in that state, not identities that survive a step, and the overlay shows the material's own coordinates: a `group({ translate })` around the strokes moves the ink, not the overlay.

The listing follows variable names, so a name assigned twice keeps its last value, and a variable inside a step callback shows the state of the last step, not every iteration. It is not history. `t.inspect(label, material)` registers a material under a label of your choosing, for an expression that never lands in a variable or a name that should read differently; it draws nothing, changes nothing and consumes no randomness. With the layer off, neither the listing nor the call costs anything, and the plan and exports are identical either way.

The question this answers here: which points are still active tips after thirty steps, and where did the tree stop growing? Choose `tree`, colour points by `active`, and the tips light up; click one to see its heading and depth.

```ts live
import { sketch, strokes, material, add, mul, fromAngle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const seed = material([[100, 98]], { active: 1, heading: -Math.PI / 2, depth: 0 });
  const tree = seed.steps(30, (cur, next, k) => {
    const tips = cur.points.filter((p) => p.active === 1 && p.y > 6 && p.x > 6 && p.x < 194);
    next.extend((p) => {
      const turn = t.noise(p.x / 14, p.y / 14, k) * 0.3 - (p.heading + Math.PI / 2) * 0.1;
      const fork = p.depth < 4 && t.chance(0.3);
      const headings = fork ? [p.heading - 0.5 + turn, p.heading + 0.5 + turn] : [p.heading + turn];
      return headings.map((h) => ({
        position: add(p, mul(fromAngle(h), 3.2)),
        attributes: { active: 1, heading: h, depth: p.depth + (fork ? 1 : 0) },
      }));
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return strokes(tree);   // no dots for the tips: the inspector shows them
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
| `m.faces()` | the bounded faces as a collection: iterate, `length`, `at`, `map`, `filter`, `groupBy`, `boundaries()`; crossings without a shared vertex are an error that says to planarize |
| `face` | `index`, `area` (outer minus holes), `perimeter`, `bounds`, `contours` (closed records, for consumers that want them one by one — `polygon` and `distanceTo` take the face itself); and its own `edges`, `points`, `boundaryEdges`: the collection's navigation restricted to one face (`for (const e of f.edges)`) |
| `cells.filter(f => bool)` | a fixed-membership face selection with `union`, `intersect`, `subtract` |
| `cells.edges`, `sel.edges` | every source edge incident to the (selected) faces, once, as an edge selection: shared walls included, and a spur inside a face counts as that face's edge |
| `cells.points`, `sel.points` | the endpoints of those edges, once |
| `cells.facesOf(edge)` | the faces on the two sides of a source edge: two for a wall between cells, one for an outer wall or a spur, none for an edge no face touches; the reverse of `face.edges` |
| `cells.boundaryEdges`, `sel.boundaryEdges` | edges between the selected union and its exterior: walls between two selected faces are excluded, a hole's boundary stays |
| `sel.boundaries()` | closed contours around the union of the selected faces: a drawing view of the same boundary |
| `cells.measure(field?, { resolution?, bounds? })` | per-face geometric `area` and `centroid` (holes respected) and, given a field, its `integral`, `mean` and density-weighted `weightedCentroid`; `forFace(face)` looks one up |

A detached segment floating inside a face belongs to no face: its walk encloses nothing, so `edges` leaves it out and `boundaryEdges` never sees it.

Measurements are midpoint sums on a square raster (cells of the long side of `bounds` over `resolution`, default 256; bounds default to the measured faces' box), each raster centre inside a face contributing its sample times the cell area, non-finite samples absent. The error scales with the cell size. A density-weighted centre needs a nonnegative field with positive total; with a negative sample or zero total it is null, while a signed field still has an integral and a mean. A measurement is a frozen result about its exact faces, not geometry, and does not follow later edits.

Orientation is decided exactly (Shewchuk's `orient2d`), so crossing, touching and collinear never depend on an epsilon. Endpoints merge only when exactly coincident; a gap stays a gap. Contours come out with the outer boundary at positive area and holes negative, so the default `'evenodd'` handles them either way. Drawing every face's contours repeats every shared wall; fill the cells with `stroke: false` and stroke the network once, or stroke only a selection's `boundaries()`.

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
      cells.map((f, k) => polygon(f, { fill: fill('hatch', { angle: (k * 37) % 180, spacing: mm(1.3) }), stroke: false })),
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
  const chosen = cells.filter((f) => f.area > 1200 || inner);
  const hatch = fill('hatch', { angle: 45, spacing: mm(1.1) });
  return [
    chosen.map((f) => polygon(f, { fill: hatch })),
    group({ translate: [100, 0] },
      polygon(chosen.boundaries(), { fill: hatch, stroke: false }),
      strokes(chosen.boundaries(), { pen: 'stabilo-88-blue' }),
    ),
  ];
});
```

### Editable cellular drawing

Voronoi cells as ordinary material. The large cells are selected; their internal walls are the edges the selection has that are not on its boundary, and one structural edit disconnects them, so the rooms open into each other. The edited material draws like any other; it is no longer anyone's Voronoi cell, and asking it for a site is an error by design.

```ts live
import { sketch, strokes, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const sites = t.relax(t.scatter({ spacing: 14 }), { iterations: 2 });
  const cells = t.voronoi(sites);
  const rooms = cells.faces().filter((f) => f.area > 260);
  const internal = rooms.edges.filter((e) => !rooms.boundaryEdges.has(e));
  const rows = new Set(internal.indices);
  const opened = cells.steps(1, (cur, next) => next.disconnect((e) => rows.has(e.index)));
  // The boundary goes down first: ink laid on ink already there is dropped,
  // so the black walls yield to the blue boundary where they coincide.
  return [
    rooms.map((f) => polygon(f, { fill: fill('hatch', { angle: 30, spacing: mm(1.6) }), stroke: false })),
    strokes(rooms.boundaryEdges, { pen: 'stabilo-88-blue' }),
    strokes(opened, { pen: 'pigma-005-black' }),
  ];
});
```

### Branching responding to enclosed space

Trunks grow up from the bottom edge and now and then throw a side branch; a tip that meets a wall joins it, and every join encloses a region. After the growth the network is planarized (two tips that crossed in the same step become a shared vertex; the resolver settles their conflicting headings) and its faces are measured against a light field. The bright, roomy cells are hatched and their outline drawn in blue, laid down before the black network so the shared walls keep the blue (ink on ink is dropped), which is a drawing decision the enclosed space made. A network that encloses nothing is drawn as it is.

```ts live
import { sketch, strokes, polygon, fill, mm, material, query, add, mul, fromAngle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 17 }, (t) => {
  const seeds = material(t.times(9, (i) => [16 + i * 21, 94]), { active: 1, heading: -Math.PI / 2 });
  const web = seeds.steps(50, (cur, next, k) => {
    const edges = query.edges(cur);
    const tips = cur.points.filter((p) => p.active === 1 && p.y > 8 && p.x > 6 && p.x < 194);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 16, p.y / 16, k * 0.01) * 0.5;
      const headings = t.chance(0.08) ? [h, h + (t.chance(0.5) ? 1.2 : -1.2)] : [h];
      return headings.map((hh) => {
        const target = add(p, mul(fromAngle(hh), 3));
        const hit = edges.firstHit(p, target, { excludeIncident: p });
        if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
        return { position: target, attributes: { active: 1, heading: hh } };
      });
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  const planar = web.planarize({ point: () => ({ active: 0, heading: 0 }) });
  const enclosed = planar.faces();
  if (enclosed.length === 0) return strokes(web);
  const light = (x, y) => Math.max(0, 1 - Math.hypot(x - 70, y - 40) / 90);
  const measured = enclosed.measure(light, { resolution: 200 });
  const lit = enclosed.filter((f) => f.area > 25 && measured.forFace(f).mean > 0.5);
  return [
    lit.map((f) => polygon(f, { fill: fill('hatch', { angle: 60, spacing: mm(1.2) }), stroke: false })),
    strokes(lit.boundaryEdges, { pen: 'stabilo-88-blue' }),
    strokes(planar, { pen: 'pigma-005-black' }),
  ];
});
```

### Hatched cells

A jittered grid triangulated, its cells grouped by area band, each band hatched at its own spacing so small cells read dense and large cells open, and the network stroked once over the fills. The groups are face selections keyed by band; drag `minimum` to leave the smallest cells empty.

```ts live
import { sketch, strokes, polygon, fill, mm, connect, banding, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 33 }, (t) => {
  const minimum = ui(40, { min: 0, max: 160, step: 5, label: 'minimum area' });
  const cells = connect.triangulate(t.grid({ cols: 14, rows: 7 }).map((c) => [c.cx + t.rnd(-5.2, 5.2), c.cy + t.rnd(-4.8, 4.8)])).faces();
  const band = banding.over(cells.map((f) => f.area), { count: 3 });
  const spacing = [mm(1.3), mm(2.6), mm(5)];
  return [
    cells.filter((f) => f.area >= minimum).groupBy((f) => band(f.area)).map((group) =>
      group.map((f) => polygon(f, { fill: fill('hatch', { angle: 30, spacing: spacing[group.key] }), stroke: false }))),
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

`m.along({ spacing | count, transfer? })` or plain `m.along()` is the other side of resampling: it reads evenly spaced *stations* off the chains and leaves the material alone. Blender calls it curve to points. A station is plain data, owned by no state: `x, y`, the unit `tangent` of the segment under it, the `normal`, the `heading` in radians, arc length `s` from the chain's start and its fraction `u`, the chain's whole `length`, the `chain` and whether it is `closed`. Point columns arrive in `attrs` by each column's transfer policy (per-call `transfer` overrides, as in `resample`), edge columns in `edgeAttrs` by theirs: `'copy'` is the edge under the station, `'distribute'` the sum over the run of chain nearer this station than its neighbours, so the stations' shares add up to the chain's total. Same sampling rules as `resample`: open chains include both ends, closed ones start at the seam and never repeat it, each chain is walked on its own, isolated vertices give nothing, a junction is an error. With neither `spacing` nor `count`, `along()` is a station at every vertex in walk order, the chain's own corners as `t.material` keeps them, with the vertex's own column values; a station on a vertex, however it got there, takes the bisector of the two segments meeting as its tangent. Use `resample` when the material itself must be even; use `along` to put things on it. Stations are not drawn, but a variable holding them appears in the studio's Material layer like a material, with a vertex per station, the walk as edges, and `heading`, `s`, `u`, `length`, `chain` and the transferred columns to colour by; `stationsMaterial(stations)` is that conversion for a sketch that wants to draw or connect them. Point-column transfer policies travel in the station’s plain-data `transfers` record and survive conversion; per-call sampling overrides do not change those source policies. Conversion rejects a name shared by point and edge columns, or incompatible point policies across stations: rename the source column or reconcile policies explicitly. Edge samples become vertex values; their original edge-conservation rule does not become a vertex interpolation rule.

**`station.place(content, opts?)`** is what to put things on it *with*, and it is the whole placement story in one call: `content` is any drawable, stood at the station and turned to its heading. `offset: [alongTangent, alongNormal]` moves in the station's own frame (in the material's units), so it stays normal to the curve whatever the extra rotation; `rotate` adds degrees to the heading; `scale` is local, applied before that rotation, and a negative number mirrors. The frame is `T(position + tangent·ot + normal·on) · R(heading + rotate) · S(scale)` — the motif's own options ride inside it, and the station is not mutated.

A warped ring drawn as itself, with a square stamped at every station, turned to the curve's heading and sized by a `weight` column that was declared on four vertices and interpolated onto the stations. The ring keeps its own vertices; nothing was resampled.

```ts live
import { sketch, circle, polygon, rect } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const ring = t.sample(circle(100, 50, 30), { count: 64 })
    .attribute('weight', (p) => 0.5 + 0.5 * Math.sin(Math.atan2(p.y - 50, p.x - 100) * 2))
    .steps(1, (cur, next) => {
      next.move((p) => [Math.sin(p.y / 6) * 9, Math.cos(p.x / 7) * 5]);
    });
  const stamps = ring.along({ spacing: 5 }).map((st) => {
    const size = 1.5 + 3 * st.attrs.weight;
    return st.place(rect(-size / 2, -size / 2, size, size, { opaque: true }));
  });
  return [polygon(ring), stamps];
});
```

Two rows of marks, mirrored across the spine and pushed off it: one call per side, no trigonometry in the sketch.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.sample(circle(100, 50, 30), { count: 48 })
    .along({ spacing: 6 })
    .map((st) =>
      [1, -1].map((side) =>
        st.place(circle(0, 0, 2.5), { offset: [0, 7 * side], scale: [1, side] }),
      ),
    ),
);
```

Attributes carry across operations by a policy declared once on the column and honoured everywhere; a per-operation option overrides for that call.

| Operation | Point columns | Edge columns | Rows and iteration |
|---|---|---|---|
| `attribute`, `edgeAttribute` with `{ transfer? }` | `'interpolate'` (default) or `'nearest'` for categorical values | `'copy'` (default) or `'distribute'` for a quantity shared by length | rows and iteration kept, history dropped |
| `connect.*`, `next.connect` | | every declared column must be given for a new edge | kept |
| `append(a, b, { fill, edgeFill })` | columns must match or be filled | same | b's rows after a's; iteration 0 |
| `split`, `splitEdges`, `extend`, `addPoint` | a split vertex inherits by the policy, then `point` overrides; a new point must give every column | children copy or share the parent, then `edges(parent, child)` overrides | iteration +1 per step |
| `resample` | by the policy, or a per-call `transfer: { col: 'nearest' \| constant \| fn }` | `'copy'` takes the source edge under the new edge's midpoint; `'distribute'` sums each covered source edge's share | rows renumbered; iteration kept |
| `along` | into each station's `attrs` by the policy, or a per-call `transfer` | into `edgeAttrs`: `'copy'` takes the edge under the station; `'distribute'` sums the share of chain nearer this station than its neighbours | no rows: stations are plain data; the material is untouched |
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
import { sketch, stroke, strokes, circle, polygon, fill, mm, group, material, query, add, mul, fromAngle, segmentRuns, banding } from 'occlude';

export default sketch({ aspect: [2, 2], seed: 7 }, (t) => {
  const seeds = material(t.times(8, (i) => [8 + i * 4.8, 44]), { active: 1, heading: -Math.PI / 2, age: 0 });
  const web = seeds.steps(30, (cur, next, k) => {
    const edges = query.edges(cur);
    const tips = cur.points.filter((p) => p.active === 1 && p.y > 8 && p.x > 5 && p.x < 45);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 8, p.y / 8, k * 0.01) * 0.7;
      const target = add(p, mul(fromAngle(h), 1.2));
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0, age: k } }) };
      const kids = [{ position: target, attributes: { active: 1, heading: h, age: k } }];
      if (t.chance(0.14)) kids.push({ position: add(p, mul(fromAngle(h + 0.8), 1.2)), attributes: { active: 1, heading: h + 0.8, age: k } });
      return kids;
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  const band = banding.over(web.attrs.age, { count: 3 });
  const pens = ['pigma-01-black', 'stabilo-88-green', 'stabilo-88-blue'];
  // a crossing's age is a decision, because the two edges' ages disagree
  const planar = web.planarize({ point: (ev) => ({ active: 0, heading: 0, age: Math.max(...ev.candidates.map((c) => c.attrs.age)) }) });
  const cells = planar.faces().filter((f) => f.area > 3);
  return [
    strokes(web),
    group({ translate: [50, 0] }, segmentRuns(web, (a, b) => band((a.age + b.age) / 2)).map((r) => stroke(r, { pen: pens[r.key] }))),
    group({ translate: [0, 50] }, cells.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: mm(1) }), stroke: false })), strokes(planar, { pen: 'pigma-005-black' })),
    group({ translate: [50, 50] }, strokes(web, { pen: 'pigma-005-black' }),
      web.points.filter((p) => web.degree(p) > 2).map((p) => circle(p.x, p.y, 0.7, { pen: 'stabilo-88-blue' })),
      web.points.filter((p) => web.degree(p) === 1).map((p) => circle(p.x, p.y, 0.4))),
  ];
});
```

## Inside an area

One verb says "only this much of it": **`t.within(x, area)`**. A field takes it as a domain bound (see [Fields & variation](#/fields)); everything else keeps only what lies inside.

A material is **cut**: an edge is split where it crosses the boundary and the part outside is dropped, so a chord drawn long enough to be sure of reaching the frame ends *on* the frame, and the ink stops there. The same eighteen chords through one point, twice: as drawn on the left, trimmed to the frame on the right. Nothing crosses the frame, and the trimmed ends are exactly on its edges.

```ts live
import { sketch, strokes, line, rect, append } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const panel = (cx) => rect(cx - 45, 10, 90, 80);
  const chordsAt = (cx) => t.times(18, (k) => {
    const a = (k / 18) * Math.PI * 2;
    return t.sample(line(cx + Math.cos(a) * 120, 50 + Math.sin(a) * 120, cx - Math.cos(a) * 120, 50 - Math.sin(a) * 120), { count: 2 });
  }).reduce((a, b) => append(a, b));
  return [
    strokes(chordsAt(50), { pen: 'pigma-005-black' }),
    strokes(t.within(chordsAt(150), panel(150)), { pen: 'pigma-005-black' }),
    strokes(t.material(panel(50)), { pen: 'pigma-05-black' }),
    strokes(t.material(panel(150)), { pen: 'pigma-05-black' }),
  ];
});
```

A cut vertex takes its columns by the column's declared policy — `'interpolate'` by default, `'nearest'` for a category — exactly as `split` and `resample` do, an edge column is copied or (declared `'distribute'`) given its share of the source edge, `iteration` is kept and history is dropped. A point lying exactly on the boundary counts as **outside**, the rule the engine's own clip uses, so a run lying along the edge does not survive.

| `x` | What comes back |
|---|---|
| a Material | a new Material, edges cut at the boundary and the outside dropped (rows renumbered, columns kept) |
| a point selection | a **selection** of the points inside, of the same source: it chains with `.filter` and still works as `{ where }` in a step rule |
| a face collection | the faces lying entirely inside — nothing is clipped, so a face that the boundary cuts through is not kept |
| a field | the field, absent outside (the original meaning) |

`area` is anything an area consumer takes: a shape (lowered here, so it agrees with what the shape inks), a face, loops, a chain material or a selection.

`within` reads the **fill** of the area, not its contours. A shape's own rule decides what is filled: under `'nonzero'`, an interior contour — a nested loop wound the same way — has fill on both sides and is not a boundary at all, so a point on it is inside, a material edge along it is not cut, and a face may cross or enclose it. A genuine hole, or an exterior edge, is a boundary: a point or a run lying along it is out, and a face whose interior covers one is refused. Loops and faces carry no rule of their own and read even-odd.

Keeping points inside an area has its own option on the point operations: `bounds` is the numeric envelope a raster needs, `within` is the area. For a rectangle the two are the same run; for anything else — a disc, a face, a traced contour — the operation works over the area's box and the result is trimmed to the area, so counts near a curved boundary thin out. A disc of evenly spaced dots, with nothing outside it:

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const disc = circle(100, 50, 34);
  const dots = t.scatter(() => 1, { spacing: 5, within: disc });
  return [dots.points.map((p) => circle(p.x, p.y, 0.6)), disc];
});
```

A face collection answers with `{ faces: … }`. `'contained'` (the default) keeps the cells that lie inside the area — a cell whose wall runs along the boundary belongs to it — and refuses one whose interior covers excluded space, which is how a cell that spans a hole is caught even though all its corners are inside. `'centroid'` keeps the cells whose *centre* is inside, so a cell the boundary cuts through is kept whole and its ink reaches past the edge. The same nine-cell grid and the same frame, whose right and bottom edges cut the far cells past their centres: one cell on the left, all four on the right.

```ts live
import { sketch, strokes, label, polygon, fill, mm, line, rect, append, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const square = (x0) => t.material(rect(x0, 6, 88, 88));
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const hatch = fill('hatch', { angle: 45, spacing: mm(1.4) });
  const panel = (x0, faces) => {
    const frame = rect(x0, 6, 56, 56);
    const network = [square(x0), chord(x0, 50, x0 + 88, 50), chord(x0 + 44, 6, x0 + 44, 94)]
      .reduce((a, b) => append(a, b))
      .planarize();
    return [
      t.within(network.faces(), frame, { faces }).map((f) => polygon(f, { fill: hatch, stroke: false })),
      strokes(network, { pen: 'pigma-005-black' }),
      strokes(t.material(frame), { pen: 'pigma-05-black' }),
    ];
  };
  return [
    panel(6, 'contained'),
    group({ translate: [100, 0] }, panel(6, 'centroid')),
  ];
});
```

## Thickness

**`thicken(source, opts)`** gives points and connections thickness and hands back an ordinary boundary **Material**. Each participating vertex carries a radius; each participating edge sweeps the disc at one end into the disc at the other with the radius interpolated linearly along it. Because centre and radius both interpolate linearly, that swept area is exactly the convex hull of the two discs — two common tangent segments and the two exposed arcs — so the combined coverage has an analytic boundary of straight intervals and circular arcs, with no circle sampling and no raster step. Holes and point contacts fall out of the geometry, not out of a tolerance.

It is a module import, pure like `distanceTo`: no sketch frame, seed, pen or paper is read, and the result is a new Material (iteration 0, no history) that `polygon`, `strokes`, `along`, `distanceTo`, `t.within` and the material inspection paths already accept.

```ts live
import { sketch, material, thicken, polygon, strokes, distanceTo, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 4 }, (t) => {
  const tree = material(
    [[50, 86], [50, 62], [33, 44], [68, 43], [22, 23], [42, 20], [80, 21]],
    {
      edges: [[0, 1], [1, 2], [1, 3], [2, 4], [2, 5], [3, 6]],
      radius: [5, 3.8, 2.2, 2.3, 0.3, 0.4, 0.3],
      age: [6, 5, 3, 3, 0, 0, 0],
    },
  );

  const body = thicken(tree, {
    radius: (p) => p.radius,
    tolerance: 0.05, // material units; mm() remains appropriate for ink spacing
  });
  const d = distanceTo(body);

  return [
    strokes(t.isolines(d, [-2, -4])),
    polygon(body, { fill: fill('hatch', { angle: 30, spacing: mm(0.8) }) }),
  ];
});
```

The operation knows nothing about roots, branches, age or pressure. `radius` is a number, or a callback read off the source's own vertex views — its real attributes (`p.radius`), never a wrapper. It runs exactly once per participating vertex, in source row order, and its results are cached; along an edge the two cached radii interpolate linearly whatever the column's transfer policy says. `radius` and `tolerance` are resolved material-coordinate numbers: an unresolved length such as `mm(1)` is refused rather than read against global paper.

What participates:

| `source` | vertices | edges |
|---|---|---|
| a Material | every vertex, isolated ones as bare discs | every edge |
| a point selection | every selected vertex, including selected vertices with no selected neighbour | existing edges whose **both** endpoints are selected |
| an edge selection | the endpoints of the selected edges only | the selected edges only |

That middle row matters: `tree.points.extract()` drops connectivity, so thickening it makes a union of discs, while thickening `tree.points` keeps the induced connections. Same tree, same radii, one word apart:

```ts live
import { sketch, material, thicken, polygon, fill, mm, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const chain = material([[30, 28], [100, 28], [170, 28]], { edges: [[0, 1], [1, 2]], radius: 12 });
  const hatch = fill('hatch', { angle: 45, spacing: mm(0.9) });
  return [
    polygon(thicken(chain, { radius: (p) => p.radius }), { fill: hatch }),
    group({ translate: [0, 46] }, polygon(thicken(chain.points.extract(), { radius: (p) => p.radius }), { fill: hatch })),
  ];
});
```

Without `point` the result carries **no columns** — this is a generative conversion, not a topology-preserving edit, so nothing is inherited and no source vertex keeps its identity. With `point`, the callback runs once for each final boundary vertex, after ordering and tessellation, and returns that row's complete record:

```ts live
import { sketch, material, thicken, polygon, strokes, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 11 }, (t) => {
  const tree = material(
    [[50, 90], [50, 64], [32, 46], [70, 45], [20, 24], [44, 20], [82, 22]],
    {
      edges: [[0, 1], [1, 2], [1, 3], [2, 4], [2, 5], [3, 6]],
      radius: [5, 3.8, 2.2, 2.3, 0.3, 0.4, 0.3],
      age: [6, 5, 3, 3, 0, 0, 0],
    },
  );

  const body = thicken(tree, {
    radius: (p) => p.radius,
    point: ({ candidates }) => ({ age: Math.max(...candidates.map((c) => c.attrs.age)) }),
  });

  return [
    polygon(body, { fill: fill('hatch', { angle: 30, spacing: mm(0.9) }), stroke: false }),
    strokes(body, { pen: 'pigma-05-black' }),
    body.points.filter((p) => p.age <= 2 && body.degree(p) > 0)
      .map((p) => circle(p.x, p.y, 0.6, { pen: 'stabilo-88-blue' })),
  ];
});
```

`event.position` is the generated boundary vertex; `event.candidates` names what produced it in the **original** source (or the selection's `.source`): a surviving arc gives a vertex row, a surviving tangent gives the edge row and the stored `a → b` parameter recovered from the tangent primitive, normalized to a vertex at `t = 0` or `1`. Candidate attributes interpolate by each source column's declared policy, independently of the linear computed radius.

One distinction worth keeping straight: thickening an already thickened **boundary** is a new band around those boundary edges, not a dilation of the previously filled interior — the boundary has no memory of the fill. Radii are the source's own units; `tolerance` (default `0.05`) only bounds the arc tessellation, so a tolerance larger than a radius never deletes the disc. Invalid sources, options, radii and callback records name the offending row or key with a `thicken:` error, and same values give the same arrays and callback order on a given build.
