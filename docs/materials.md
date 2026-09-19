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

### snap

`m.snap(field, { radius, samples? })` gives every point a look around: it
moves to wherever `field` is greatest inside `radius` of where it stood, or
stays put if that is already the best place it can see. A lattice is regular
and a scatter is even, and neither knows anything about what is underneath;
snapping puts the marks **on** the feature — the dark of an eye, the crest of
a ridge, the edge of a shape — instead of beside it.

Greatest, always. There is no option to seek the least, because there does not
need to be one: a field is a function, and `m.snap((x, y) => -f(x, y), …)` is
the other direction. The same goes for anything else you want it to prefer —
`snap` never learns a second mode, it reads whatever field it is handed.

It is a same-world method like `thicken` and `oscillate`: no seed, no paper,
distances in the material's own coordinates. The look around is a fixed spiral
of `samples` offsets over the disc (48 by default) plus the point's own
position, so the same input always gives the same output. Non-finite samples
are absent, so a field can decline to answer somewhere and no point will be
moved there. Structure is untouched — edges, columns and row order all
survive; this moves points, it does not add, remove or reconnect them.

```ts live
import { sketch, circle, line, strokes, material } from 'occlude';

// A lattice knows nothing about what it is sitting on. Give every point a look
// 7 units around itself and let it move to the best place it can see, and the
// lattice breaks: the points leave the flat ground and collect on the ridge.
// Each tail shows where a point came from.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const ridge = (x, y) => t.noise(x / 58, y / 58);
  const lattice = material(t.grid({ cols: 17, rows: 9 }).map((c) => [c.cx, c.cy]));
  const moved = lattice.snap(ridge, { radius: 9 });
  return [
    strokes(t.isolines(ridge, [0.15, 0.45], { step: 0.8 }), { pen: 'stabilo-88-blue' }),
    lattice.points.map((p) => line(p.x, p.y, moved.x[p.index], moved.y[p.index])),
    moved.points.map((p) => circle(p.x, p.y, 1)),
  ];
});
```

The pattern is not in the scatter, which is even and knows nothing. It is
entirely in where each point decides to go.

```ts live
import { sketch, strokes, connect } from 'occlude';

// Marbling. An even scatter has no pattern in it at all; the pattern is
// entirely in where each point decides to go. This field's maxima are not
// peaks but LINES — a cosine through a warped coordinate, so its crests are
// wavy bands eight units apart — and given four units to look around, every
// point slides off the flats and onto the nearest crest. The cloud
// reorganises itself into filaments, which a nearest-neighbour join then
// draws. Nothing traced a contour: the points found them.
export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const warp = (x, y) => t.noise(x / 44, y / 60) * 30 + t.noise(x / 13, y / 13) * 3;
  const grain = (x, y) => Math.cos(((y + warp(x, y)) * Math.PI * 2) / 8);
  const settled = t.scatter({ spacing: 1.3 }).snap(grain, { radius: 4, samples: 140 });
  return strokes(connect.nearest(settled, { count: 2 }));
});
```

Composed with the rest of the toolkit. Sites strung along a line give cells
that fan out across it, and the shape columns then hatch each cell along its
own axis — a ruling that follows a structure nobody drew.

```ts live
import { sketch, strokes, polygon, fill, mm, degrees } from 'occlude';

// Composed: the same crests, but the points are Voronoi sites now. Sites
// strung along a line give cells that fan out ACROSS it — long, thin, and
// splayed either side of the crest they grew from — and each cell is then
// hatched along its own principal axis, so the ruling follows a structure
// nobody drew. Snap made the sites, the sites made the shapes, and the shapes
// chose the angle.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const warp = (x, y) => t.noise(x / 46, y / 62) * 30;
  const grain = (x, y) => Math.cos(((y + warp(x, y)) * Math.PI * 2) / 19);
  const sites = t.scatter({ spacing: 3.1 }).snap(grain, { radius: 9, samples: 200 });
  const cells = t.voronoi(sites);
  const measured = cells.faces().measure();
  return [
    measured.map((r) => polygon(r.face, {
      fill: fill('hatch', { angle: degrees(r.orientation), spacing: mm(0.4 + r.inscribedRadius * 0.22) }),
      stroke: false,
    })),
    strokes(cells, { pen: 'stabilo-88-blue' }),
  ];
});
```

Poked: `radius` is how far a point may look, so make it enormous. Let nearly
every point on the sheet see the same few summits and an even scatter collapses
into a handful of piles — the field's maxima, drawn by whatever fell into them.

```ts live
import { sketch, circle, line, material, strokes } from 'occlude';

// Poked: `radius` is how far a point may look, so make it enormous. At 4 units
// every point tidies itself onto the nearest crest. At 45 nearly every point
// on the sheet can see the same few summits, and an even scatter collapses
// into a handful of piles — the field's maxima, drawn by the points that fell
// into them. The tails are where they came from.
export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  const land = (x, y) => t.noise(x / 42, y / 42);
  const cloud = t.scatter({ spacing: 4.4 });
  const gathered = cloud.snap(land, { radius: 45, samples: 700 });
  return [
    strokes(t.isolines(land, [0.2, 0.5], { step: 0.9 }), { pen: 'stabilo-88-blue' }),
    cloud.points.map((p) => line(p.x, p.y, gathered.x[p.index], gathered.y[p.index])),
    gathered.points.map((p) => circle(p.x, p.y, 0.8)),
  ];
});
```

And in three dimensions, where finding the top of something is the whole job.
The contours are real plane sections through the mesh, not lines drawn on a
picture of it, and the cairns stand on summits nobody located by hand: an even
lattice was simply allowed to walk uphill until it could see nothing higher.

```ts live
import { sketch, pen, mm, material } from 'occlude';
import { plane, sphere, view, orthographic } from 'occlude/3d';

// A survey. The land is a height field; the contours are real plane sections
// through the mesh, not lines drawn on a picture of it; and the cairns stand
// on the summits, which nobody located by hand — an even lattice of points was
// simply allowed to walk uphill until it could see nothing higher.
export default sketch({ seed: 12, pens: {
  ink: pen({ width: mm(0.28), color: '#18202A' }),
  contour: pen({ width: mm(0.16), color: '#56626A' }),
} }, (t) => {
  const height = (x, y) => t.noise(x / 2.4, y / 2.4) * 1.3;
  const lattice = material(t.times(20, (i) => t.times(20, (j) => [-3.6 + i * 0.38, -3.6 + j * 0.38])).flat());
  // Uphill until nothing higher is in sight; many points arrive at the same
  // summit, so keep one cairn per place.
  const found = lattice.snap(height, { radius: 1.5, samples: 260 }).points;
  const summits = [];
  for (const p of found) if (!summits.some(([sx, sy]) => Math.hypot(sx - p.x, sy - p.y) < 0.5)) summits.push([p.x, p.y]);
  const land = plane(8, 8).subdivide(6).displace((p) => [0, 0, height(p.x, p.y)]);
  return view([
    land.style({ creaseAngle: 180 }),
    ...summits.map(([x, y]) => sphere(0.11, { segments: 16, rings: 10 }).translate([x, y, height(x, y) + 0.11])),
  ], {
    camera: orthographic({ eye: [5, -7, 5.5], target: [0, 0, 0.2], span: 8.6 }),
    stroke: 'ink',
    sections: t.times(11, (k) => ({ origin: [0, 0, -1.2 + k * 0.24], normal: [0, 0, 1], stroke: 'contour' })),
  });
});
```

### quadtree

`t.quadtree(points, { capacity?, depth?, bounds? })` puts detail where the
points are. A cell holding more than `capacity` of them (1 by default) splits
into four, and its children do the same, until every cell is within its
allowance or the subdivision has gone `depth` splits deep (12). A scatter
driven by a picture therefore gives a lattice that is fine on the picture's
detail and coarse on its flats, with nobody deciding where the detail is.

Both limits are termination rules rather than budgets: coincident points can
never be separated, so without a depth the splitting would not stop.

What comes back is the subdivision as ordinary Material — the outer rectangle,
plus the cross that split each cell that split. Not four walls per cell:
adjacent cells of different sizes would then lay one long edge over two short
ones, and a collinear overlap is the one thing `planarize` cannot resolve.
Crosses meet their neighbours end-on or at a T, which planarize turns into a
shared vertex, so `planarize().faces()` gives the cells and `strokes()` draws
the lattice. Points outside `bounds` take no part in it.

```ts live
import { sketch, strokes, circle } from 'occlude';

// The lattice puts its detail where the points are. A cell holding more than
// three of them splits into four, and its children do the same, so the cloud
// decides the resolution — nobody chose where the fine squares go.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const pts = t.scatter((x, y) => Math.max(0.02, 1 - Math.hypot(x - 78, y - 50) / 52), { spacing: 3.2 });
  return [
    strokes(t.quadtree(pts, { capacity: 3 })),
    pts.points.map((p) => circle(p.x, p.y, 0.55, { pen: 'stabilo-88-blue' })),
  ];
});
```

An adaptive mosaic, from two readings of one photograph doing different jobs.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

// An adaptive mosaic. The points are scattered where the photograph has
// detail, so the tiles come out small on an eye and large on a flat coat;
// then every tile is filled at a spacing taken from its own tone. Two
// readings of one picture doing different jobs — one decides how big a tile
// is, the other how dark it is — and no lattice is drawn at all: the tiling
// is visible only because neighbouring tiles rule at different densities.
export default sketch({ aspect: [1, 1], seed: 2 }, (t) => {
  const img = t.image('ivy.png', { x: 4, y: 4, width: 92 });
  const dark = img.field('dark', { area: 1.1 });
  const edge = img.field('edge', { area: 0.5 });
  const detail = t.scatter((x, y) => 0.04 + Math.pow(Math.min(1, edge(x, y) * 9), 2.2) * 0.96, { spacing: 1.2 });
  return t.quadtree(detail, { capacity: 2, bounds: { x: 4, y: 4, w: 92, h: 92 } })
    .planarize().faces().measure()
    .map((r) => {
      const tone = dark(r.inscribedCentre[0], r.inscribedCentre[1]);
      return tone < 0.2 ? null : polygon(r.face, {
        fill: fill('hatch', { angle: 45, spacing: mm(0.45 + Math.pow(1 - tone, 0.7) * 5.5) }),
        stroke: false,
      });
    });
});
```

Composed with the rest of the toolkit: the lattice is Material, so it can be
cut to a shape and swung like anything else.

```ts live
import { sketch, strokes, circle } from 'occlude';

// Composed: the lattice is Material like anything else, so it can be cut and
// it can be shaken. `t.within` trims it to a disc — the cells at the rim come
// back as the partial walls they are — and `oscillate` then swings every
// remaining wall, at a wavelength short enough that a small cell still gets a
// few waves and an amplitude that keeps the wobble inside its own cell. An
// adaptive mosaic with the ruler put away.
export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const swarm = (x, y) => Math.max(0, t.noise(x / 24, y / 24)) + Math.max(0, t.noise(x / 8, y / 8)) * 0.5;
  const pts = t.scatter((x, y) => 0.03 + swarm(x, y) * 0.97, { spacing: 3 });
  const lens = circle(100, 50, 46);
  const lattice = t.within(t.quadtree(pts, { capacity: 3 }), lens);
  return [
    strokes(lattice.oscillate({ wavelength: 2.2, amplitude: 0.45 })),
    strokes(t.material(lens).oscillate({ wavelength: 2.6, amplitude: 0.5 }), { pen: 'stabilo-88-blue' }),
  ];
});
```

Poked: nothing says the points have to be a cloud. Hand the lattice the
vertices of a **drawing** and it subdivides around the ink — so the quadtree
stops being a way to index a scatter and becomes a way to measure where a
drawing keeps its detail.

```ts live
import { sketch, strokes, circle, material } from 'occlude';

// Poked: nothing says the points have to be points. Hand the lattice the
// VERTICES OF A DRAWING and it subdivides around the ink — fine where the
// curve turns and coarse in the empty middle — so the quadtree stops being a
// way to index a cloud and becomes a way to measure where a drawing keeps its
// detail. The curve is drawn over its own lattice.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const spiral = t.times(900, (k, u) => {
    const a = u * Math.PI * 9;
    const r = 6 + u * 38 + Math.sin(a * 3) * 3;
    return [100 + Math.cos(a) * r * 1.7, 50 + Math.sin(a) * r];
  });
  const ink = material(spiral);
  return [
    strokes(t.quadtree(ink, { capacity: 1, depth: 7 }), { pen: 'stabilo-88-blue' }),
    ink.points.map((p) => circle(p.x, p.y, 0.25)),
  ];
});
```

And in three dimensions. The subdivision decides the plan and the picture
decides the elevation; what the drawing is made of is the skyline, because the
blocks hide one another and only the lines that survive are drawn.

```ts live
import { sketch, pen, mm } from 'occlude';
import { box, view, orthographic } from 'occlude/3d';

// A city of tone. The lattice is fine where the photograph has detail and
// coarse where it is flat, and every cell is then raised into a block as tall
// as that patch is dark — so the subdivision decides the plan and the picture
// decides the elevation. What the drawing is actually made of is the skyline:
// the blocks hide one another, and only the lines that survive are drawn.
export default sketch({ seed: 3, pens: { ink: pen({ width: mm(0.24), color: '#18202A' }) } }, (t) => {
  const img = t.image('ivy.png', { x: 0, y: 0, width: 100 });
  const dark = img.field('dark', { area: 1.4 });
  const edge = img.field('edge', { area: 0.6 });
  const detail = t.scatter((x, y) => 0.03 + Math.pow(Math.min(1, edge(x, y) * 9), 1.1) * 0.97, { spacing: 1.7 });
  const cells = t.quadtree(detail, { capacity: 2, bounds: { x: 0, y: 0, w: 100, h: 100 } }).planarize().faces();
  return view(cells.measure().results.map((r) => {
    const b = r.face.bounds;
    const tone = dark(r.inscribedCentre[0], r.inscribedCentre[1]);
    const h = 0.15 + tone * tone * 3.4;
    return box([(b.w / 100) * 9, (b.h / 100) * 9, h])
      .translate([((b.x + b.w / 2) / 100 - 0.5) * 9, ((b.y + b.h / 2) / 100 - 0.5) * 9, h / 2]);
  }), {
    camera: orthographic({ eye: [7, -9, 6.5], target: [0, 0, 0.6], span: 12.5 }),
    stroke: 'ink',
  });
});
```

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
    next.move(current.points, (p) => {
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
| rules | `.steps(n, (current, next, k) => …)` with the collection edits, or the shorthand `.steps(n, { move: p => [dx, dy], set })` over every point; forces prepared once and evaluated at a point |
| collections | `.points`, `.edges`, `.faces()`: iterate, `length`, `at`, `map`, `filter` (a selection), `groupBy` (selections by key); `.adjacent()`, `.connected()`, `.components()`; `.extract()` for independent material; `meanBy` |
| areas | `.planarize()` shares crossings on purpose; `.faces()` reads the enclosed regions; `boundaryEdges` and `contours()` outline a union as walls or as loops |
| drawing | `.curves()`, `.along()` for stations to place things at, `strokes()`, `segmentRuns`, `extent`, `banding`, then `stroke`, `polygon`, `circle` |

All are pure imports except `t.sample`, which reads the paper. Shapes stay exact through the engine; sampling is the one explicit lossy step into this vocabulary.

### Making a material

Two conversions take a shape into material. `t.material(shape, …, { tolerance? })` keeps each boundary's own vertices: a rectangle's four corners, a regular polygon's vertices, a path's points, with curved portions flattened at the tolerance (default 0.05 mm); several shapes become several outlines of one material, so `t.material(...circles).planarize().faces()` are the pieces their overlaps cut. `t.sample(shape, { count | spacing, tolerance? })` redistributes points along the boundary by arc length instead, so four samples of a rectangle need not land on its corners. Both make a ring from a closed outline (without a duplicate seam vertex), a chain from an open one, and separate chains for separate outlines, welding nothing. `material(points, { edges?, ...columns })` builds one from tuples or `{ x, y }` objects (a scatter point's `w` becomes a column), unconnected unless edges are given, and `curve(pts, { closed?, ...columns })` makes a ring or chain from positions. `material(existingMaterial)` returns that value unchanged; nonempty constructor options with an existing material are rejected. Use `.attributes(...)` or `.withEdges(...)` to edit it. `t.isolines` and `t.streamlines` return material too, so field-generated contours arrive ready for the same operations.

A hexagon's corners pulled toward the centre by an amount that alternates around the ring. Nothing is computed by hand: the corners are the material's rows, and the drawing is the polygon of the result.

```ts live
import { sketch, ngon, polygon, strokes, sub, mul } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const corners = t.material(ngon(100, 50, 6, 40));
  const star = corners.steps(1, (cur, next) => {
    next.move(cur.points, (p) => mul(sub([100, 50], p), p.index % 2 ? 0.45 : 0));
  });
  return [strokes(corners, { pen: 'pigma-005-black' }), polygon(star, { pen: 'stabilo-88-blue' })];
});
```

`m.attribute(name, constant | p => value, { transfer? })` adds a point column and returns a new material; `m.attributes({ a: …, b: … }, { transfer?: { a: … } })` adds several at once, every initializer reading the material as it is, so no column sees another's new value. `m.edgeAttribute(name, constant | e => value)` and `m.edgeAttributes({ … })` do the same for edge columns, each edge its own row. Read `m.points` (vertex views `{ index, x, y, ...attrs }`), `m.pts` (tuples), `m.x`, `m.y` and `m.attrs.age` (the columns), `p.adjacent` on a vertex view, `m.edges` and `m.curves()`.

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

`connect.chain(m)` and `connect.ring(m)` join consecutive rows in the given order. `connect.nearest(m, { count })` joins each vertex to its `count` nearest others, undirected and without duplicates. `connect.pairs(a, b)` joins row i of `a` to row i of `b` in one material. `connect.triangulate(m)` adds the Delaunay edges. `append(a, b, …, { fill?, edgeFill? })` puts several materials in one, in the order given (`append(pile, ...circles.map((c) => t.material(c)))` piles a list): all need the same columns, or `fill: { active: 0 }` says what a side without `active` gets, and only that side; a missing column with no fill is an error, never a silent zero. A column both sides declare must agree on its transfer policy; a column one side declares keeps that side's policy for the filled rows too.

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

### tour

`connect.tour(m, { cost?, closed?, candidates? })` finds one route through every row, visiting each once, and returns it as a chain — or a ring with `closed`. The rows are not reordered: the route is in the edges, so every column stays where it was.

`cost(a, b)` is what the route tries to spend less of, read from two vertex views. It defaults to the distance between them, and **anything else makes a different drawing out of the same points**: `cost: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * (1 + 5 * (1 - img.lum(…)))` makes crossing pale paper expensive, so the line that merely joins the dots prefers to run through the picture and the travel becomes the ink.

The starting route is nearest-neighbour by plain distance — a start, not an answer — and `cost` then drives the improvement: 2-opt, first improvement, repeated until no exchange helps, and then a sweep for self-crossings, which are undone wherever the exchange pays for itself. Under the default cost that leaves none at all, the familiar property of a 2-opt tour; under a cost that rewards travelling over something, a crossing that is genuinely the cheaper route is kept, because it is. Two details are worth knowing. Exchanges are tried between each row and its `candidates` nearest neighbours (12 by default) rather than every pair, and those neighbours are chosen by **distance** whatever `cost` says: right for a cost that is mostly about travel, and a real limit on one that is not, which is improved only among geometric neighbours. And reversing a run leaves an undirected cost alone, so `cost` is taken to be symmetric; an asymmetric one still runs, it just is not what is being minimised. The result is deterministic: the same rows and the same cost give the same route.

The same forty points, twice — joined in the order they were made, and joined by a tour.

```ts live
import { sketch, strokes, connect, circle, group } from 'occlude';

// The same forty points, twice. Left: joined in the order they were made.
// Right: joined by a tour. The rows did not move — only the edges did.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const pts = t.scatter({ spacing: 13, within: circle(48, 50, 42) });
  const marks = (m) => m.points.map((p) => circle(p.x, p.y, 0.9));
  return [
    strokes(connect.chain(pts), { pen: 'stabilo-88-blue' }), marks(pts),
    group({ translate: [104, 0] }, strokes(connect.tour(pts)), marks(pts)),
  ];
});
```

A fish in one unbroken line. The silhouette is nothing but a density, and the tour threads every point of it onto a single route; the pen goes down once and does not lift until the drawing is finished. The one long chord across the tail root is the honest cost of that promise — there is no second way through.

```ts live
import { sketch, strokes, connect } from 'occlude';

// A fish in one unbroken line. The silhouette is only a density: points go
// where there is fish and nowhere else, packed tighter toward the head and
// kept out of the eye altogether, and one tour then visits every one of them.
// The pen goes down once and does not lift until the drawing is finished.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  // A lens of two circles, pointed at the mouth and at the tail root.
  const body = (x, y) => Math.hypot(x - 88, y - 31.5) < 40.5 && Math.hypot(x - 88, y - 68.5) < 40.5;
  const tail = (x, y) => x >= 120 && x <= 160 && Math.abs(y - 50) <= (x - 120) * 0.6;
  const dorsal = (x, y) => x >= 84 && x <= 118 && y <= 34 && 34 - y <= (118 - x) * 0.55;
  const ventral = (x, y) => x >= 80 && x <= 110 && y >= 66 && y - 66 <= (110 - x) * 0.6;
  const eye = (x, y) => Math.hypot(x - 68, y - 43) < 5;
  const density = (x, y) =>
    (body(x, y) || tail(x, y) || dorsal(x, y) || ventral(x, y)) && !eye(x, y)
      ? 0.38 + 0.62 * Math.max(0, 1 - (x - 50) / 78)
      : 0;
  return strokes(connect.tour(t.scatter(density, { spacing: 1.8 })));
});
```

Composed with the rest of the toolkit: the cost is the drawing. Points settle where the photograph is dark, and the tour is told that crossing pale paper is expensive, so the leaves come out as the negative space the line declines to enter.

```ts live
import { sketch, strokes, connect } from 'occlude';

// The cost is the drawing. Points settle where the photograph is dark, and
// the tour is then told that crossing pale paper is expensive — so the line
// that merely joins the dots prefers to run through the picture, and the
// travel becomes the ink. One pen-down for the whole plate.
export default sketch({ aspect: [1, 1], seed: 4 }, (t) => {
  const img = t.image('ivy.png', { x: 6, y: 4, width: 88 });
  const dark = img.field('dark', { area: 1.2 });
  const density = (x, y) => { const d = dark(x, y); return d < 0.42 ? 0 : 0.25 + 0.75 * ((d - 0.42) / 0.58); };
  const pts = t.settle(t.scatter(density, { spacing: 2.1 }), { density, spacing: 2.1, iterations: 8 });
  const route = connect.tour(pts, {
    cost: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * (1 + 5 * (1 - dark((a.x + b.x) / 2, (a.y + b.y) / 2))),
  });
  return strokes(route);
});
```

Poked: a cost with nothing to do with where the points are. Each point carries a `shade`, and the route is asked only to keep consecutive shades close — so the tour stops being a route and becomes a **sort**, and the line you see is the sorted order made visible. It is a sequencer that happens to be usually asked about distance.

```ts live
import { sketch, strokes, connect, circle, material } from 'occlude';

// Poked: a cost with nothing to do with where the points are. Each point
// carries a `shade`, and the route is asked only to keep consecutive shades
// close — so the tour stops being a route and becomes a SORT, and the line
// you see is the sorted order made visible. The dots are drawn at their
// shade, so you can read the sort off the page.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const pts = material(t.times(150, () => {
    const x = t.rnd(10, 190);
    const y = t.rnd(10, 90);
    return { x, y, shade: t.noise(x / 40, y / 40) * 0.5 + 0.5 };
  }));
  const sorted = connect.tour(pts, { cost: (a, b) => Math.abs(a.shade - b.shade) });
  return [
    strokes(sorted, { pen: 'stabilo-88-blue' }),
    pts.points.map((p) => circle(p.x, p.y, 0.5 + p.shade * 2.4)),
  ];
});
```

And in three dimensions, where the point is simply that a route is a path. The shortest way round a hundred scattered points becomes the spine of a solid: swept into a tube it is one closed rope that must pass over and under itself, and every crossing is the drawing telling you the order it was threaded in.

```ts live
import { sketch, pen, mm, connect, circle as disc } from 'occlude';
import { circle, polyline, sweep, view, orthographic } from 'occlude/3d';

// A tour is a route, and a route is a path — so the shortest way round a
// hundred scattered points becomes the spine of a solid. Swept into a tube it
// is a single closed rope that has to pass over and under itself, and the
// classifier decides which: everything crossing here is the drawing telling
// you the order it was threaded in.
export default sketch({ seed: 21, pens: { ink: pen({ width: mm(0.3), color: '#18202A' }) } }, (t) => {
  const route = connect.tour(t.scatter({ spacing: 8.5, within: disc(100, 50, 46) }), { closed: true });
  let pts = route.curves()[0].pts.map(([x, y]) => [x, y]);
  // A tour turns hard; a rope does not. Two Laplacian passes round it off.
  for (let pass = 0; pass < 2; pass++) {
    pts = pts.map(([x, y], k) => {
      const [px, py] = pts[(k + pts.length - 1) % pts.length];
      const [nx, ny] = pts[(k + 1) % pts.length];
      return [(px + 2 * x + nx) / 4, (py + 2 * y + ny) / 4];
    });
  }
  const path = polyline(pts.map(([x, y]) => [(x - 100) / 17, (y - 50) / 17, t.noise(x / 34, y / 34) * 2.1]), { closed: true });
  return view(sweep(circle(0.1, { segments: 16 }), path), {
    camera: orthographic({ eye: [3.5, 6, 3.4], target: [0, 0, 0], span: 6.4 }),
    stroke: 'ink',
    creaseAngle: 180,
  });
});
```

### tree

`connect.tree(m, { cost? })` is the cheapest network that reaches every row:
no cycles, no choices, exactly one path between any two points. Where `tour`
visits everything in a line, this **branches** — which is what a root, a
river, a nervous system and a lightning strike all look like, because all of
them are cheapest-connection problems.

`cost(a, b)` is `tour`'s idea again and defaults to the distance. The
candidate edges are the Delaunay ones, which is exactly right for distance —
the Euclidean minimum spanning tree is always a subgraph of the Delaunay
triangulation, so nothing is lost — and a restriction for any other cost,
which is then minimised over those candidates rather than over every pair.
Rows at the same position take part: Delaunay keeps only the first at a
position, so the rest are joined to it and the tree still reaches every row.
With fewer than three distinct positions, or all of them collinear, there is
no triangulation to draw on and every pair becomes a candidate.

The result is a tree, so `faces()` finds nothing in it, `strokes` walks each
arm, and `p.adjacent.length` tells a tip from a fork.

```ts live
import { sketch, strokes, circle, connect } from 'occlude';

// The tree and the triangulation it was chosen from. The tree goes down
// first in black and the triangulation over it in blue, so every edge the two
// share stays black — ink laid on ink already there is dropped — and what is
// left in blue is exactly the edges the tree did not take. The cheapest tree
// that reaches everything is always a subgraph of the Delaunay edges, which
// is why those are the only candidates it has to consider.
export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const pts = t.relax(t.scatter({ spacing: 15 }), { iterations: 2 });
  const tree = connect.tree(pts);
  return [
    strokes(tree),
    strokes(connect.triangulate(pts), { pen: 'stabilo-88-blue' }),
    tree.points.map((p) => circle(p.x, p.y, p.adjacent.length > 2 ? 1.4 : 1)),
  ];
});
```

A drainage, from a height field and a cost that makes high ground expensive.

```ts live
import { sketch, strokes, connect } from 'occlude';

// A drainage. The land is a height field; the points are scattered thickly in
// the low ground and thinly on the tops; and the cost of joining two of them
// is their distance made dearer by how high they sit. The cheapest tree that
// still reaches every point therefore runs along the valleys and crosses a
// ridge only when it has no other way of reaching what is beyond it — which
// is what a river system is. The contours are the same field, drawn faintly.
export default sketch({ aspect: [2, 1], seed: 17 }, (t) => {
  const land = (x, y) => t.noise(x / 46, y / 46) * 0.5 + 0.5;
  const pts = t.scatter((x, y) => { const h = land(x, y); return h > 0.54 ? 0 : 0.25 + Math.pow((0.54 - h) / 0.54, 1.1) * 0.75; }, { spacing: 2.6 });
  const rivers = connect.tree(pts, {
    cost: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * (1 + Math.pow((land(a.x, a.y) + land(b.x, b.y)) / 2, 2) * 7),
  });
  return [
    strokes(t.isolines(land, [0.56, 0.68, 0.8], { step: 0.9 }), { pen: 'stabilo-88-blue' }),
    strokes(rivers),
  ];
});
```

Composed with the rest of the toolkit. A tree has exactly one path between any
two points, so every point knows how much of the tree lies beyond it — walk
out from the mouth once and count. That count is a radius, and `thicken` turns
the network into an area whose trunk is broad because everything upstream
drains through it.

```ts live
import { sketch, polygon, strokes, connect, fill, mm } from 'occlude';

// Composed: the same drainage, given width. A tree has exactly one path
// between any two points, so every point knows how much of the tree lies
// beyond it — walk out from the mouth once and count. That count is a radius,
// `thicken` turns the network into an area, and the trunk comes out broad
// because everything upstream drains through it. The tree was never told
// which end was the sea; the traversal decided.
export default sketch({ aspect: [2, 1], seed: 17 }, (t) => {
  const land = (x, y) => t.noise(x / 46, y / 46) * 0.5 + 0.5;
  const pts = t.scatter((x, y) => { const h = land(x, y); return h > 0.54 ? 0 : 0.25 + Math.pow((0.54 - h) / 0.54, 1.1) * 0.75; }, { spacing: 3.2 });
  const rivers = connect.tree(pts, {
    cost: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * (1 + Math.pow((land(a.x, a.y) + land(b.x, b.y)) / 2, 2) * 7),
  });
  // The mouth is the lowest point; walk out from it and count what is behind.
  let mouth = 0;
  for (let i = 1; i < rivers.n; i++) if (land(rivers.x[i], rivers.y[i]) < land(rivers.x[mouth], rivers.y[mouth])) mouth = i;
  const parent = new Int32Array(rivers.n).fill(-1);
  const seen = new Uint8Array(rivers.n);
  const order = [mouth];
  seen[mouth] = 1;
  for (let k = 0; k < order.length; k++) for (const w of rivers.points.at(order[k]).adjacent.indices) if (!seen[w]) { seen[w] = 1; parent[w] = order[k]; order.push(w); }
  const drains = new Float64Array(rivers.n).fill(1);
  for (let k = order.length - 1; k > 0; k--) drains[parent[order[k]]] += drains[order[k]];
  const measured = rivers.attribute('drains', (p) => drains[p.index]);
  return [
    polygon(measured.thicken({ radius: (p) => 0.14 + Math.pow(p.drains, 0.42) * 0.3 }), {
      fill: fill('hatch', { angle: 30, spacing: mm(0.5) }),
    }),
    strokes(t.isolines(land, [0.56, 0.72], { step: 0.9 }), { pen: 'stabilo-88-blue' }),
  ];
});
```

Poked: ask for the cheapest tree under a cost that is cheapest when the edge is
longest. The result still has to be a tree, so it cannot simply join everything
to everything — it reaches across the sheet for every single edge instead.

```ts live
import { sketch, strokes, connect, group, rect } from 'occlude';

// Poked: the cost is asked for the cheapest tree, so hand it a cost that is
// cheapest when the edge is longest. Left, the minimum: short hops, a plausible
// root. Right, the same points and the same verb under a negated distance —
// the MOST expensive tree that still reaches everything, which has to stay a
// tree and so cannot simply connect everything to everything. It reaches
// across the sheet for every single edge.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const pts = t.relax(t.scatter({ spacing: 11 }), { iterations: 2 });
  const shrunk = t.within(pts, rect(2, 2, 92, 96));
  return [
    strokes(connect.tree(shrunk)),
    group({ translate: [102, 0] }, strokes(connect.tree(shrunk, { cost: (a, b) => -Math.hypot(a.x - b.x, a.y - b.y) }), { pen: 'stabilo-88-blue' })),
  ];
});
```

And in three dimensions. The cost is the distance *through* a mound rather
than across the page, so the cheapest network has to climb it; each arm is a
chain, a chain is a path, and every one of them is swept into a tube that has
to decide what is in front of what.

```ts live
import { sketch, pen, mm, connect, circle as disc } from 'occlude';
import { circle, polyline, sweep, view, orthographic } from 'occlude/3d';

// A tree is a tree. The points sit on a mound — high in the middle, low at the
// rim — and the cost of joining two of them is their distance THROUGH that
// mound, not across the page, so the cheapest network that reaches all of them
// has to climb. Each arm of the result is a chain, and a chain is a path, so
// every one of them is swept into a tube: a thicket that has to decide what is
// in front of what.
export default sketch({ seed: 6, pens: { ink: pen({ width: mm(0.26), color: '#18202A' }) } }, (t) => {
  const mound = (x, y) => 3.4 * Math.exp(-Math.pow(Math.hypot(x - 50, y - 50) / 26, 2));
  const world = (x, y) => [(x - 50) / 12, (y - 50) / 12, mound(x, y)];
  const pts = t.relax(t.scatter({ spacing: 5, within: disc(50, 50, 45) }), { iterations: 2, within: disc(50, 50, 44) });
  const thicket = connect.tree(pts, {
    cost: (a, b) => {
      const [ax, ay, az] = world(a.x, a.y);
      const [bx, by, bz] = world(b.x, b.y);
      return Math.hypot(ax - bx, ay - by, az - bz);
    },
  });
  return view(thicket.curves().filter((c) => c.pts.length > 1).map((c) =>
    sweep(circle(0.085, { segments: 12 }), polyline(c.pts.map(([x, y]) => world(x, y))))), {
    camera: orthographic({ eye: [5, -7.5, 3.1], target: [0, 0, 1.4], span: 8.2 }),
    stroke: 'ink',
    creaseAngle: 180,
  });
});
```

### trails

`strokes` breaks a chain at every junction, because a vertex where three or
four edges meet has no single way onward. That is correct and it is expensive:
a plain grid comes off the plotter as one stroke per edge pair, and a Voronoi
web as one per wall, even though a pen could run straight through most of
them.

`m.trails()` re-wires the same drawing so it lifts as few times as it
can. A *trail* is a walk that uses no edge twice, and the fewest trails
covering a connected network is `max(1, odd / 2)`, where `odd` counts its
odd-degree vertices — every trail has two ends, and only an odd vertex can be
one. This reaches that floor exactly.

| network | chains | trails |
|---|---|---|
| 9 × 6 grid | 89 | 11 |
| Voronoi of 100 sites | 153 | 51 |
| Delaunay of 40 points | 102 | 8 |

It is a re-wiring, not a drawing mode: a junction is split into one degree-2
vertex per passing pair, which leaves the ink exactly where it was and lets the
ordinary chain walk sail through. **No edge is ever drawn twice** — this
reaches the minimum without retracing, which the routing default forbids.
Pairing odd vertices along shortest paths and duplicating those edges would buy
a single closed circuit at the cost of ink, and belongs behind an explicit
request rather than here.

A network with no odd vertex at all — every crossing of two closed curves is a
degree-4 vertex, so an arrangement of closed curves qualifies — comes back as
**one closed loop**.

The split vertices sit on top of one another, which is exactly what they are:
one place the pen passes through twice. That makes the result a *drawing*
rather than a structure, and `faces()` will rightly refuse it. Keep the
original to ask questions of, and trail the copy to plot it.

Each faint line below is the pen travelling with its nib up.

```ts live
import { sketch, strokes, line, label, circle, append } from 'occlude';

// The same ink, routed two ways. Each faint line is the pen travelling with
// its nib UP, from where one stroke ended to where the next begins. Left: the
// ordinary chain walk, which must break at every junction. Right: the same
// network re-wired into trails, which pass straight through one.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const web = (cx) => {
    const rings = t.times(5, (k) => {
      const a = (k / 5) * Math.PI * 2;
      return t.sample(circle(cx + Math.cos(a) * 14, 50 + Math.sin(a) * 14, 22), { count: 90 });
    });
    return rings.reduce((p, q) => append(p, q)).planarize();
  };
  const travel = (m) => {
    const cs = m.curves();
    return t.times(Math.max(0, cs.length - 1), (k) => {
      const a = cs[k].pts[cs[k].pts.length - 1];
      const b = cs[k + 1].pts[0];
      return line(a[0], a[1], b[0], b[1], { pen: 'stabilo-88-blue' });
    });
  };
  const plain = web(50);
  const trailed = web(150).trails();
  return [
    strokes(plain), travel(plain), label(`CHAINS ${plain.curves().length}`, 12, 94, 4),
    strokes(trailed), travel(trailed), label(`TRAILS ${trailed.curves().length}`, 112, 94, 4),
  ];
});
```

Sixteen closed curves, overlapping. Every crossing is degree four, so the whole
arrangement has no odd vertex anywhere — and the entire plate is one pen-down.

```ts live
import { sketch, strokes, curve, append } from 'occlude';

// Soap. Sixteen closed curves, overlapping, planarized into one network — and
// because every crossing of two closed curves is a vertex of degree four, the
// whole arrangement has no odd vertex anywhere in it. A network with no odd
// vertex is a single closed trail, so this entire plate is ONE pen-down: the
// nib goes down at the top left and does not come up until the drawing is
// finished. The chain walk would have lifted it about two hundred times.
export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const bubbles = t.times(16, (k) => {
    const a = k * 2.39996;                      // the golden angle, so they never line up
    const r = 8 + Math.sqrt(k / 16) * 30;
    const cx = 100 + Math.cos(a) * r * 1.5;
    const cy = 50 + Math.sin(a) * r * 0.9;
    const rad = 13 + t.noise(k * 3.1, 0) * 9;
    return curve(t.times(120, (j) => {
      const th = (j / 120) * Math.PI * 2;
      const wob = 1 + t.noise(Math.cos(th) * 1.6 + k * 7, Math.sin(th) * 1.6) * 0.16;
      return [cx + Math.cos(th) * rad * wob, cy + Math.sin(th) * rad * wob];
    }), { closed: true });
  });
  const net = bubbles.reduce((p, q) => append(p, q)).planarize();
  const one = net.trails();
  console.error(`chains=${net.curves().length} trails=${one.curves().length} closed=${one.curves().filter((c) => c.closed).length}`);
  return strokes(one);
});
```

Composed with the rest of the toolkit: the fill layer and the stroke layer are
routed separately, and only the strokes care.

```ts live
import { sketch, strokes, polygon, fill, mm, degrees } from 'occlude';

// Composed: the fill layer and the stroke layer are routed separately, and
// only the strokes care. The cells are settled against a photograph and
// hatched at their own axis; their walls are one network, which the chain walk
// would lift the pen a hundred and sixty times to draw and which comes out
// here in a few dozen unbroken runs. Identical ink, a fraction of the lifting.
export default sketch({ aspect: [1, 1], seed: 6 }, (t) => {
  const img = t.image('ivy.png', { x: 4, y: 4, width: 92 });
  const dark = img.field('dark', { area: 1.1 });
  const density = (x, y) => 0.12 + dark(x, y) * 0.88;
  const sites = t.settle(t.scatter(density, { spacing: 5.4 }), { density, spacing: 5.4, iterations: 10 });
  const cells = t.voronoi(sites);
  const measured = cells.faces().measure();
  const walls = cells.trails();
  console.error(`walls: chains=${cells.curves().length} trails=${walls.curves().length}`);
  return [
    measured.map((r) => polygon(r.face, {
      fill: fill('hatch', { angle: degrees(r.orientation), spacing: mm(0.58 + Math.pow(1 - dark(...r.inscribedCentre), 0.8) * 3) }),
      stroke: false,
    })),
    strokes(walls, { pen: 'pigma-005-black' }),
  ];
});
```

Poked: swing the trails and the routing becomes visible in the ink. Because a
junction is now two rows, its two passes wobble independently and come apart,
so the network unravels into the runs the pen actually draws.

```ts live
import { sketch, strokes, circle, append } from 'occlude';

// Poked: swing the trails, and the routing becomes visible in the ink. At a
// crossing the pen passes through twice, and after the re-wiring those two
// passes are two separate rows — so each wobbles on its own and they come
// apart. The drawing is now a picture of its own stroke order: everywhere the
// line doubles, that is one place the nib went through and came back.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const rings = t.times(4, (k) => {
    const a = (k / 4) * Math.PI * 2;
    return t.sample(circle(100 + Math.cos(a) * 17, 50 + Math.sin(a) * 17, 26), { count: 140 });
  });
  const net = rings.reduce((p, q) => append(p, q)).planarize();
  return strokes(net.trails().oscillate({ wavelength: 30, amplitude: 4.5 }));
});
```

And in three dimensions, where a pen-down run becomes a length of glass. One
trail, so one tube: bent once, never cut, and the classifier decides which
length is in front where it passes through itself.

```ts live
import { sketch, pen, mm, circle as disc, append } from 'occlude';
import { circle, polyline, sweep, view, orthographic } from 'occlude/3d';

// A trail is a pen-down run, and a pen-down run is a path — so each one can be
// bent into glass. Six overlapping rings planarize into a network with no odd
// vertex anywhere, which is a single closed trail, so this whole sign is ONE
// tube: bent once, never cut. Where it passes through itself the classifier
// decides which length of glass is in front.
export default sketch({ seed: 2, pens: { ink: pen({ width: mm(0.3), color: '#18202A' }) } }, (t) => {
  const rings = t.times(6, (k) => {
    const a = (k / 6) * Math.PI * 2;
    return t.sample(disc(50 + Math.cos(a) * 15, 50 + Math.sin(a) * 15, 24), { count: 150 });
  });
  const net = rings.reduce((p, q) => append(p, q)).planarize();
  const runs = net.trails().curves();
  // The tube leans in and out of the sheet as it goes, so the crossings have
  // something to decide.
  const lift = (x, y) => t.noise(x / 26, y / 26) * 0.9;
  return view(runs.filter((c) => c.pts.length > 2).map((c) =>
    sweep(circle(0.11, { segments: 14 }),
      polyline(c.pts.map(([x, y]) => [(x - 50) / 11, (y - 50) / 11, lift(x, y)]), { closed: c.closed }))), {
    camera: orthographic({ eye: [3.2, -7.2, 5.4], target: [0, 0, 0], span: 8.8 }),
    stroke: 'ink',
    creaseAngle: 180,
  });
});
```

### unimpeded

`connect.unimpeded(m, { room })` joins two rows when they are each other's
neighbours — when the space between them is empty enough that nothing else has
a better claim.

`room` is how much empty space a pair needs. The region tested is the
intersection of two discs of radius `room × d / 2`, pushed apart along the
pair, where `d` is the distance between them; the edge survives when no other
row lies inside it. At `room` 1 that region is the disc having the pair as its
diameter; at 2 it is the intersection of the two discs of radius `d` centred on
each. Those are the two classical answers, but this is **one continuous knob,
not two named graphs**, and the interesting values are the ones between.

| room | on 167 relaxed points |
|---|---|
| Delaunay (all candidates) | 486 edges |
| 1 | 421 |
| 2 | 254 |
| `connect.tree` | 166 |
| 3.5 | 118 — already fewer than a spanning tree can have |

Up to `room` 2 the result still contains every edge of `connect.tree`, so it is
connected whenever the cloud is. Past 2 that guarantee goes: the region grows
wide enough to veto edges the spanning tree needed, and the lattice falls into
pieces. That is a real property of the family rather than a defect, and the
fourth sketch below shows exactly which edges it costs.

`room` may also be a **field**, read at the middle of each pair — the one place
both rows agree on — so one lattice can be a close mesh where it matters and a
sparse filigree elsewhere. Candidates are the Delaunay edges, which loses
nothing, since every edge of this family is one; with fewer than three distinct
positions, or all of them collinear, there is no triangulation to draw on and
every pair is considered instead.

```ts live
import { sketch, strokes, circle, connect, label, group } from 'occlude';

// One cloud, one knob. `room` is how much empty space a pair needs before they
// count as each other's neighbours: at 1 the region tested is the disc having
// the pair as its diameter, at 2 it is the two discs of radius `d` centred on
// each. Everything survives at the left and almost nothing at the right, and
// the values in between are the useful ones.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const dish = circle(23, 40, 19);
  const pts = t.relax(t.scatter({ spacing: 8, within: dish }), { iterations: 2, within: dish });
  const shown = [['DELAUNAY', null], ['ROOM 1', 1], ['ROOM 2', 2], ['ROOM 4', 4]];
  return shown.map(([text, room], i) => group({ translate: [i * 49, 0] }, [
    strokes(room === null ? connect.triangulate(pts) : connect.unimpeded(pts, { room })),
    pts.points.map((p) => circle(p.x, p.y, 0.7, { pen: 'stabilo-88-blue' })),
    label(text, 5, 68, 3.2, { pen: 'stabilo-88-blue' }),
  ]));
});
```

One cloud, evenly spread, and one graded answer to how much room a pair needs.

```ts live
import { sketch, strokes, circle, connect } from 'occlude';

// A veil. One cloud, evenly spread, and one graded answer to the question of
// how much room a pair needs: almost none at the centre, a great deal at the
// rim. So the same points are a close mesh in the middle and come apart into
// filigree at the edge — and nothing was thinned, masked or faded to do it.
// The lattice simply stops agreeing that distant pairs are neighbours.
export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const veil = circle(100, 50, 46);
  const pts = t.relax(t.scatter({ spacing: 3.4, within: veil }), { iterations: 3, within: veil });
  const room = (x, y) => 1 + Math.pow(Math.min(1, Math.hypot(x - 100, y - 50) / 46), 2.2) * 2.1;
  return strokes(connect.unimpeded(pts, { room }));
});
```

Composed with the rest of the toolkit: the photograph chooses where the rows go
*and* which of them are neighbours.

```ts live
import { sketch, strokes, connect, circle } from 'occlude';

// Composed: the picture decides how much room a pair needs. The points settle
// against a photograph, so there are already more of them where it is dark;
// then `room` reads the same photograph, so the dark places also get a closer
// mesh and the light ones a looser one. Two readings, one of them choosing
// where the rows go and the other choosing which of them are neighbours.
export default sketch({ aspect: [1, 1], seed: 4 }, (t) => {
  const img = t.image('ivy.png', { x: 3, y: 3, width: 94 });
  const dark = img.field('dark', { area: 1.1 });
  const lens = circle(50, 50, 47);
  const density = (x, y) => 0.14 + dark(x, y) * 0.86;
  const pts = t.settle(t.scatter(density, { spacing: 2.4, within: lens }), { density, spacing: 2.4, iterations: 8, within: lens });
  return strokes(connect.unimpeded(pts, { room: (x, y) => 1 + Math.pow(1 - dark(x, y), 1.5) * 1.9 }));
});
```

Poked: push past the guarantee and watch it go.

```ts live
import { sketch, strokes, connect, circle, label, group } from 'occlude';

// Poked: push past the guarantee and watch it go. The lattice goes down first
// in black and the cheapest spanning tree over it in blue — and ink laid on
// ink already there is dropped, so a tree edge the lattice also has comes out
// BLACK, and blue is left showing only where the lattice lost an edge the tree
// needed. Up to room 2 there is no blue at all, because up to 2 that cannot
// happen. Past 2 the guarantee goes, and you can see exactly which edges it
// took with it.
export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const dish = circle(24, 44, 21);
  const pts = t.relax(t.scatter({ spacing: 3.6, within: dish }), { iterations: 2, within: dish });
  return [1, 2, 3, 5].map((room, i) => group({ translate: [i * 49, 0] }, [
    strokes(connect.unimpeded(pts, { room }), { pen: 'pigma-005-black' }),
    strokes(connect.tree(pts), { pen: 'stabilo-88-blue' }),
    label(`ROOM ${room}`, 5, 72, 3.2, { pen: 'stabilo-88-blue' }),
  ]));
});
```

And in three dimensions, where the lattice is chosen flat and then lifted —
through `.trails()` first, so the frame is a few long members rather than
a hundred little struts.

```ts live
import { sketch, pen, mm, connect, circle as disc } from 'occlude';
import { circle, polyline, sweep, view, orthographic } from 'occlude/3d';

// A space frame. The lattice is chosen flat — `room` decides which pairs are
// close enough to be worth a member — and then lifted onto a dome. Passing it
// through `.trails()` first means the frame is made of a few long members
// rather than a hundred little struts, which is what you would actually build
// it out of, and each of those runs is swept into a tube that has to decide
// what it stands in front of.
export default sketch({ seed: 5, pens: { ink: pen({ width: mm(0.26), color: '#18202A' }) } }, (t) => {
  const plan = disc(50, 50, 42);
  const pts = t.relax(t.scatter({ spacing: 9, within: plan }), { iterations: 3, within: plan });
  const frame = connect.unimpeded(pts, { room: 1.45 }).trails();
  const dome = (x, y) => 2.6 * Math.cos(Math.min(1, Math.hypot(x - 50, y - 50) / 44) * Math.PI / 2);
  const world = (x, y) => [(x - 50) / 9, (y - 50) / 9, dome(x, y)];
  return view(frame.curves().filter((c) => c.pts.length > 1).map((c) =>
    sweep(circle(0.07, { segments: 10 }), polyline(c.pts.map(([x, y]) => world(x, y)), { closed: c.closed }))), {
    camera: orthographic({ eye: [6, -8, 4.6], target: [0, 0, 1.1], span: 10.4 }),
    stroke: 'ink',
    creaseAngle: 180,
  });
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

A selection is consumed where its domain makes sense: `strokes(edges)` draws the selected chains, and `polygon`, `distanceTo` and `force.boundary` take an edge selection as a boundary of its own topology, so a ring picked out of a network is an area even though the network is not. A point selection contributes only the edges that already join its members. Faces are areas already: draw them one by one with `cells.map((f) => polygon(f))` or outline their union with `contours()`. A face collection is not one area, so it must say which. The same goes for a shape: `polygon(circle(50, 50, 20))` reads the circle's boundary as an area, so a clip needs no separately named value.

| Value | Meaning |
|---|---|
| `coll.filter(v => bool)` | a selection of the same source: `source`, `length`, `indices` (source rows, ascending), `has(view)`, `complement()` |
| `coll.groupBy(v => key)` | selections by key, first-occurrence order, rows in source order, keys compared as a Map compares them; each has `key` |
| `sel.union(o)`, `intersect(o)`, `subtract(o)` | a new selection over the same source; equal rows in different states are not the same thing |
| `points.extract()` | the selected points with every point column and no edges |
| `points.edges` | the source edges with both ends selected |
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
  const ring = t.sample(circle(50, 50, 34), { count: 48 }).steps(1, (_, next) => next.move(_.points, () => [t.rnd(-4, 4), t.rnd(-4, 4)]));
  const arc = ring.edges.filter((e) => e.a.y < cut && e.b.y < cut);
  const piece = arc.extract();
  const smooth = piece.steps(60, (cur, next) => {
    const relax = force.relax(cur);
    next.move(cur.points.filter((p) => p.adjacent.length === 2), (p) => mul(relax(p), 0.5));
  });
  const ends = (m) => m.points.filter((p) => p.adjacent.length === 1).map((p) => circle(p.x, p.y, 1.2));
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

`p.adjacent` is adjacency as views and `p.edges` the same neighbourhood as edges, so `p.edges.length` is the degree. `meanBy(items, fn)` is a scalar mean (0 of nothing). A whole selection says the same words: `sel.adjacent()` one step out, `sel.connected()` all the way out, and `sel.components()` the pieces. Connected and nearby are different questions; nearby is a spatial query, below.

```ts live
import { sketch, strokes, circle, group, connect, meanBy } from 'occlude';

// Three vertices carry hot = 1. warmth is the mean of hot over each
// vertex's connected neighbours, so the edges between warm vertices
// outline exactly the neighbourhood, derived from the topology.
export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const mesh = connect.triangulate(t.grid({ cols: 9, rows: 8 }).map((c) => [c.cx * 0.48 + t.rnd(-2.4, 2.4), c.cy + t.rnd(-2.8, 2.8)]));
  const hot = [12, 39, 61];
  const raw = mesh.attribute('hot', (p) => (hot.includes(p.index) ? 1 : 0));
  const warm = raw.attribute('warmth', (p) => meanBy(p.adjacent, (q) => q.hot));
  const halo = warm.edges.filter((e) => e.a.warmth > 0 && e.b.warmth > 0);
  const marks = (m) => m.points.filter((p) => p.hot === 1).map((p) => circle(p.x, p.y, 2.2, { pen: 'stabilo-88-blue' }));
  return [
    strokes(raw, { pen: 'pigma-005-black' }), marks(raw),
    group({ translate: [100, 0] }, strokes(halo.complement(), { pen: 'pigma-005-black' }), strokes(halo, { pen: 'stabilo-88-blue' }), marks(warm)),
  ];
});
```

```ts live
import { sketch, stroke, circle, material, append, connect, segmentRuns } from 'occlude';

// Separate chains, a ring and lone points in one material.
// points.components() gives each piece once and the pen cycles by its key;
// isolated vertices are pieces too.
export default sketch({ aspect: [2, 1], seed: 14 }, (t) => {
  const chain = (x, y, n) => connect.chain(t.times(n, (k) => [x + k * 6.4, y + t.noise(x + k, y) * 12]));
  let all = append(chain(12, 20, 8), chain(80, 16, 10));
  all = append(all, chain(144, 24, 7));
  all = append(all, chain(20, 68, 12));
  all = append(all, connect.ring(t.times(12, (k) => [132 + Math.cos(k / 12 * Math.PI * 2) * 16, 68 + Math.sin(k / 12 * Math.PI * 2) * 16])));
  all = append(all, material([[100, 44], [176, 84], [60, 92], [184, 40]]));
  const pieceOf = new Map();
  all.points.components().forEach((piece) => { for (const i of piece.indices) pieceOf.set(i, piece.key); });
  const labelled = all.attribute('piece', (p) => pieceOf.get(p.index), { transfer: 'nearest' });
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  return [
    segmentRuns(labelled, (a) => a.piece).map((r) => stroke(r, { pen: pens[r.key % 3] })),
    labelled.points.filter((p) => p.adjacent.length === 0).map((p) => circle(p.x, p.y, 1, { pen: pens[p.piece % 3] })),
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

`m.steps(n, pass, ...morePasses, { every? })` runs one or more edit passes per iteration and returns the final material. Each pass receives `(prev, next, k)`: `prev` is frozen, and `next` batches edits to a copy. A completed pass becomes the following pass's input. All passes receive the same `k` within an iteration; only then does the sequence repeat. Most sketches need one pass.

Selections are explicit targets. Use `prev.points` or `prev.edges` for all elements, or `.filter(...)` for a subset. A selection belongs to one pass: select again from the next pass's input, rather than carrying references across resolved edits.

| Edit | Meaning |
|---|---|
| `next.move(points, vectorOrCallback)`, `next.move(ref, vector)` | displacement; several moves add up |
| `next.set(points, attrsOrCallback)`, `next.set(ref, attrs)` | write point attributes; the last write of a field wins |
| `next.setEdges(edges, attrsOrCallback)`, `next.setEdge(edge, attrs)` | write edge attributes |
| `next.addPoint(position, attributes)` → handle | a new vertex; the handle names it within this pass |
| `next.connect(a, b, edgeAttributes?)` | one undirected edge between rows, views or handles |
| `next.disconnect(edgesOrEdge)` | remove edges; their points stay |
| `next.remove(pointsOrRef)` | delete points and their incident edges; neighbours are never joined |
| `next.split(edge, { at?, point?, edges? })` → reference | replace an edge with two through a new vertex; endpoint cuts return the existing endpoint |
| `next.splitEdges(edges, { at?, point?, edges? })` | split an explicit selection of input edges |
| `next.extrude(points, p => spec \| spec[], { inherit? })` | add children `{ position, attributes }` or connect to existing targets `{ to }`; `[]` adds none; `inherit: true` starts new children from their parents' attributes |

To inspect completed movement before splitting, use two passes:

```ts
const grown = ring.steps(
  40,
  (prev, next) => {
    const push = force.attract(prev, { radius: 10, strength: 0.5 });
    next.move(prev.points, push);
  },
  (prev, next) => {
    next.splitEdges(prev.edges.filter(e => e.length > 5));
  },
);
```

Filtering `prev.edges` in the first pass would inspect the original lengths, even if the filter follows `next.move`. The second pass inspects moved lengths. Multiple tips hitting the same edge should stay in one pass: their split requests are resolved together, so they can share the same frozen query and edge references.

Migration: `extend` is now `extrude(points, spec, options)`. Callback-first edits, `{ where }`, and predicate arguments to `remove`, `disconnect`, and `splitEdges` have been removed. Move the condition into `.filter(...)`. Code that relied on the old after-movement `splitEdges(predicate)` behavior needs a following pass, as above.

A reference is a row of the current state, a vertex view of it, or a handle from this batch. Views are checked for ownership: a view of another material or a handle from another step is an error even when its row exists. A new point or edge must name every declared column. A split has a source, so the inserted vertex inherits by each column's transfer policy and the child edges copy the parent's edge attributes, with `point` and `edges` overrides on top.

Within a batch: callbacks read the frozen state; moves and attribute writes apply first; removals, disconnections, splits, added points and connections resolve and rows compact once. Conflicting edits (removing a point that is also moved or connected, splitting and disconnecting one edge) throw and publish nothing.

By default only the final state is kept. `{ every: m }` also records the initial state, every m-th complete iteration and the final one after all its passes finish, on the result's `history` as `{ iteration, material }`. Each sketch run recomputes from the start, so scrubbing an iteration control re-runs the growth to that point.

### forces

A force is prepared once with its sources, then evaluated at a point to give a vector; nothing moves until the rule says so. A force is only a function `p => vector`, so an interaction of your own is a function too: take the neighbourhood with `points.near`, and sum your contributions with `sumBy`.

```ts
const repel = (p) => sumBy(sources.points.near(p, { radius }), (q) => {
  const delta = sub(p, q);
  return mul(unit(delta), radius - length(delta));
});
next.move(prev.points, (p) => mul(repel(p), speed));
```

`sources` is any material: the one being moved, or obstacles that stay put. A vertex is never its own neighbour, and a point of another state is just a position. `.subtract(p.adjacent)` leaves out the points `p` is joined to; the recipes say `excludeConnected: true` for the same thing. The named recipes are short functions on this mechanism:

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
    next.move(cur.points, (p) => mul(push(p, k), 0.15));
    next.set(cur.points, (p) => ({ age: p.age + 1 }));
  }, (cur, next, k) => {
    next.splitEdges(cur.edges.filter((e) => e.length > 1.8 && t.chance(0.3)), { point: { age: 0 } });
  });
  return stroke(grown.contour);
});
```

Sources need not be the moving geometry. Here a ring grows among six fixed posts that shove it away, with the interaction written in place over `points.near`.

```ts live
import { sketch, stroke, circle, force, material, sub, unit, length, mul, sumBy } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const posts = material([[40, 24], [100, 16], [160, 28], [44, 76], [104, 84], [160, 72]]);
  const shove = (p) => sumBy(posts.points.near(p, { radius: 18 }), (q) => {
    const delta = sub(p, q);
    return mul(unit(delta), (18 - length(delta)) * 0.9);
  });
  const wander = force.drift(t.noise, { amount: 0.2 });
  const grown = t.sample(circle(100, 50, 8), { count: 30 }).steps(210, (cur, next, k) => {
    const push = force.sum(force.tension(cur, { rest: 2 }), force.separation(cur, { radius: 4.4, excludeConnected: true }), shove, wander);
    next.move(cur.points, (p) => mul(push(p, k), 0.18));
  }, (cur, next, k) => {
    next.splitEdges(cur.edges.filter((e) => e.length > 2.2 && t.chance(0.3)));
  });
  return [posts.points.map((q) => circle(q.x, q.y, 4)), stroke(grown.contour)];
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
    next.move(cur.points, (p) => mul(pull(p), 0.05));
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
  const gathered = dots.steps(90, (cur, next) => next.move(cur.points, (p) => mul(toward(p), 0.16)), { every: 1 });
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
  const wandered = dots.steps(55, (cur, next, k) => next.move(cur.points, (p) => drifts[p.band](p, k)), { every: 1 });
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
    next.move(cur.points, (p) => mul(sum(avoid(p), gusts(p), [4, 0]), p.mobility * 0.18));
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
    next.move(cur.points, (p) => mul(smooth(p), 1));
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
    next.extrude(tips, (p) => {
      const turn = t.noise(p.x / 14, p.y / 14, k) * 0.3 - (p.heading + Math.PI / 2) * 0.1;
      const fork = p.depth < 4 && t.chance(0.3);
      const headings = fork ? [p.heading - 0.5 + turn, p.heading + 0.5 + turn] : [p.heading + turn];
      return headings.map((h) => ({
        position: add(p, mul(fromAngle(h), 3.2)),
        attributes: { active: 1, heading: h, depth: p.depth + (fork ? 1 : 0) },
      }));
    });
    next.set(tips, { active: 0 });
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
    next.extrude(tips, (p) => {
      const h = p.heading + t.noise(p.x / 16, p.y / 16, k * 0.01) * 0.7;
      const target = add(p, mul(fromAngle(h), 3));
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
      return { position: target, attributes: { active: 1, heading: h } };
    });
    next.set(tips, { active: 0 });
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
    next.extrude(tips, (p) => {
      const turn = t.noise(p.x / 14, p.y / 14, k) * 0.3 - (p.heading + Math.PI / 2) * 0.1;
      const fork = p.depth < 4 && t.chance(0.3);
      const headings = fork ? [p.heading - 0.5 + turn, p.heading + 0.5 + turn] : [p.heading + turn];
      return headings.map((h) => ({
        position: add(p, mul(fromAngle(h), 3.2)),
        attributes: { active: 1, heading: h, depth: p.depth + (fork ? 1 : 0) },
      }));
    });
    next.set(tips, { active: 0 });
  });
  return strokes(tree);   // no dots for the tips: the inspector shows them
});
```

### Editing a structure

Structural helpers are ordinary functions over the edit interface:

```ts
// prune: drop the tips older than a lifespan, edges and all
next.remove(prev.points.filter(p => p.adjacent.length === 1 && p.age > lifespan));

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
    next.move(cur.points, (p) => mul(push(p, k), 0.15));
    next.set(cur.points, (p) => ({ age: p.age + 1 }));
  }, (cur, next, k) => {
    next.splitEdges(cur.edges.filter((e) => e.length > 2.2 && t.chance(0.3)), { point: { age: 0 } });
  });
  const cut = grown.steps(1, (cur, next) => {
    next.disconnect(cur.edges.filter((e) => e.length > 2.1));
    next.remove(cur.points.filter((p) => p.age < 4));
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
| `m.faces()` | the bounded faces as a collection: iterate, `length`, `at`, `map`, `filter`, `groupBy`; crossings without a shared vertex are an error that says to planarize. Rows and collections read the same way: `face.edges` and `cells.edges` |
| `face` | `index`, `area` (outer minus holes), `perimeter`, `bounds`, `centroid` (holes respected; field-weighted centres come from `measure()`), `contours()` (closed records, for consumers that want them one by one — `polygon` and `distanceTo` take the face itself); its own `edges`, `points`, `boundaryEdges`: the collection's navigation restricted to one face (`strokes(f.boundaryEdges)` is its outline); and `adjacent`, the faces across its walls as a selection |
| `cells.filter(f => bool)` | a fixed-membership face selection with `union`, `intersect`, `subtract` |
| `cells.edges`, `sel.edges` | every source edge incident to the (selected) faces, once, as an edge selection: shared walls included, and a spur inside a face counts as that face's edge |
| `cells.points`, `sel.points` | the endpoints of those edges, once |
| `edge.faces` | the faces on the two sides of a source edge, once the material's faces have been read: two for a wall between cells, one for an outer wall or a spur, none for an edge no face touches; the reverse of `face.edges` |
| `cells.adjacent()`, `sel.adjacent()`, `face.adjacent` | the faces across the walls of the (selected) faces, one hop: neighbours share a wall, not merely a corner, and a selected neighbour is collected too, so `sel.adjacent().subtract(sel)` is the ring outside |
| `cells.boundaryEdges()`, `sel.boundaryEdges()` | edges between the selected union and its exterior: walls between two selected faces are excluded, a hole's boundary stays |
| `cells.contours()`, `sel.contours()` | closed contours around the same union boundary, as loops: what `polygon` reads for the union |
| `cells.measure(field?, { resolution?, bounds?, precision? })` | per-face geometric `area`, `centroid`, `orientation`, `elongation`, `inscribedCentre` and `inscribedRadius` (holes respected) and, given a field, its `integral`, `mean` and density-weighted `weightedCentroid`; `forFace(face)` looks one up |

A detached segment floating inside a face belongs to no face: its walk encloses nothing, so `edges` leaves it out and `boundaryEdges` never sees it.

Measurements are midpoint sums on a square raster (cells of the long side of `bounds` over `resolution`, default 256; bounds default to the measured faces' box), each raster centre inside a face contributing its sample times the cell area, non-finite samples absent. The error scales with the cell size. `integral` is that sum; `mean` is the average of the samples that fell inside, which keeps it within the field's own range however small the face is, and is `NaN` for a face that caught no sample at all — a region too small for the raster reports no measurement rather than a zero. A density-weighted centre needs a nonnegative field with positive total; with a negative sample or zero total it is null, while a signed field still has an integral and a mean. A measurement is a frozen result about its exact faces, not geometry, and does not follow later edits.

Orientation is decided exactly (Shewchuk's `orient2d`), so crossing, touching and collinear never depend on an epsilon. Endpoints merge only when exactly coincident; a gap stays a gap. Contours come out with the outer boundary at positive area and holes negative, so the default `'evenodd'` handles them either way. Drawing every face's contours repeats every shared wall; fill the cells with `stroke: false` and stroke the network once, or stroke only a selection's `contours()`.

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

Holes and removed walls. A frame split by a wall, with a smaller ring inside: three faces. Left, the chosen faces drawn one by one, so shared walls repeat and the inner square is a hole in each half. Right, `chosen.contours()`: the wall between the two chosen halves is gone and the hole kept, until `inner` selects the disk too.

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
      polygon(chosen.contours(), { fill: hatch, stroke: false }),
      strokes(chosen.contours(), { pen: 'stabilo-88-blue' }),
    ),
  ];
});
```

### The shape of a face

Four of a measurement's columns are exact from the contours and need no field, so `cells.measure()` with nothing in it still answers *what shape is this region*.

| Column | Meaning |
|---|---|
| `orientation` | the principal axis of the face's area, in radians like every other computed angle (`degrees(r.orientation)` for a `rotate` or a hatch `angle`) |
| `elongation` | `1 −` minor/major of the equivalent ellipse: 0 for a disc or a square, approaching 1 for a sliver — the column that says how much to trust `orientation` |
| `inscribedCentre` | the centre of the largest circle that fits inside the face, holes respected |
| `inscribedRadius` | that circle's radius, 0 for a face with no interior |

Orientation and elongation come from the face's area second moments, summed over its contours with their winding, so a hole subtracts its own moments rather than being patched around. A face whose moments are isotropic has no principal axis and reports `orientation` 0 with `elongation` 0, instead of an arbitrary angle you might have believed.

The inscribed circle is found by branch and bound on the exact distance to the contours. Distance to a boundary is 1-Lipschitz, so a square cell can only hold a better centre than the best one found so far if the distance at its own centre plus its half diagonal beats it; cells that cannot are discarded whole and the rest are quartered, best first. That makes it exact input to exact output, with no seed and no raster: the same face always gives the same circle. `precision` (default the face's bounding-box diagonal over 4096) is the slack left on the radius.

Two things worth knowing before you use it. The inscribed centre is **not** the centroid — in a crescent the centroid can lie outside the region entirely, while the inscribed centre is by construction the point furthest from any wall, which is where a label or a mark wants to go. And the largest circle is not the widest band: in a square ring it sits in a corner, tangent to two outer walls and the hole's nearest corner.

Three overlapping circles make nine regions of five different shapes, which is the smallest picture that shows all of this at once. Watch where the crescents' circles land.

```ts live
import { sketch, strokes, circle, line, append } from 'occlude';

// Three overlapping circles make nine regions of five different shapes.
// The inscribed circle finds the roomy part of a crescent, which is
// nowhere near its centroid, and the axis says which way the crescent runs.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const net = [circle(72, 58, 34), circle(128, 58, 34), circle(100, 34, 34)]
    .map((c) => t.sample(c, { count: 160 }))
    .reduce((a, b) => append(a, b));
  return [
    strokes(net),
    net.planarize().faces().measure().map((r) => {
      const [x, y] = r.inscribedCentre;
      const reach = r.inscribedRadius * 0.8;
      return [
        circle(x, y, r.inscribedRadius, { pen: 'stabilo-88-blue' }),
        line(x - Math.cos(r.orientation) * reach, y - Math.sin(r.orientation) * reach,
             x + Math.cos(r.orientation) * reach, y + Math.sin(r.orientation) * reach, { pen: 'stabilo-88-blue' }),
      ];
    }),
  ];
});
```

A drawing from these four columns and nothing else. The venation is authored — a midrib, secondaries sweeping to the margin, tertiaries linking them — and every areole it encloses then answers for itself: hatched along its own principal axis, so the grain follows the veins rather than the page, and at a spacing set by the circle it can hold, so the crowded areoles near the tip come out dark and the roomy ones by the midrib stay open. The blisters are inscribed circles drawn opaque, which is why the hatch stops cleanly at them instead of being eroded.

```ts live
import { sketch, strokes, polygon, curve, append, fill, mm, degrees, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const B = [22, 86], T = [184, 18];
  const mid = (u) => [B[0] + (T[0] - B[0]) * u, B[1] + (T[1] - B[1]) * u + 7 * Math.sin(Math.PI * u)];
  const nrm = (u) => { const a = mid(Math.min(1, u + 0.01)), b = mid(Math.max(0, u - 0.01)); const d = Math.hypot(a[0] - b[0], a[1] - b[1]); return [-(a[1] - b[1]) / d, (a[0] - b[0]) / d]; };
  const wid = (u) => 27 * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.82)), 0.8);
  const off = (u, s) => { const m = mid(u), n = nrm(u); return [m[0] + n[0] * s, m[1] + n[1] * s]; };
  const N = 9, J = 6;
  // One secondary vein: leaves the midrib at u and sweeps out to the margin.
  // The last point is snapped onto an outline vertex, so the vein meets the
  // margin at a shared point instead of crossing it and leaving a spike.
  const rim = (i, s) => off(i / 69, wid(i / 69) * s);
  const sec = (k, j, s) => {
    const u = k / (N + 1) + (j / J) * 0.085;
    return j === J ? rim(Math.round(u * 69), s) : off(u, wid(u) * (j / J) * s);
  };

  const parts = [
    curve([...t.times(70, (k) => rim(k, 1)), ...t.times(68, (k) => rim(68 - k, -1))], { closed: true }),
    curve(t.times(60, (k) => mid(k / 59))),
  ];
  for (let k = 1; k <= N; k++) {
    for (const s of [1, -1]) {
      parts.push(curve(t.times(J + 1, (j) => sec(k, j, s))));
      // Tertiaries JOIN their neighbours at shared vertices, bowing outward.
      if (k < N) {
        const a = sec(k, 4, s), b = sec(k + 1, 3, s);
        parts.push(curve([a, ...t.times(3, (i, f) => {
          const g = 0.25 + f * 0.5;
          return [a[0] + (b[0] - a[0]) * g + (a[1] - b[1]) * 0.13 * s, a[1] + (b[1] - a[1]) * g - (a[0] - b[0]) * 0.13 * s];
        }), b]));
      }
    }
  }
  const net = parts.reduce((a, b) => append(a, b)).planarize();
  const measured = net.faces().measure();
  return [
    measured.map((r) => polygon(r.face, { fill: fill('hatch', { angle: degrees(r.orientation), spacing: mm(0.26 + r.inscribedRadius * 0.17) }), stroke: false })),
    strokes(net, { pen: 'pigma-005-black' }),
    measured.results.filter((r) => r.inscribedRadius > 3.6).map((r) => circle(r.inscribedCentre[0], r.inscribedCentre[1], r.inscribedRadius * 0.55, { opaque: true, pen: 'stabilo-88-blue' })),
  ];
});
```

Composed with the rest of the toolkit: a photograph, `scatter` and `relax` for the cells, `t.within` to trim them to a disc, and these columns for the marks. Each mark is bounded by its own cell's inscribed circle, so — however dark the picture gets — **no two marks can ever touch**. That is a guarantee no amount of tuning a dot size will give you, and it comes from the region, not from the mark.

```ts live
import { sketch, circle, group, degrees } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const img = t.image('ivy.png', { x: 6, y: 4, width: 88 });
  const dark = img.field('dark', { area: 1.1 });
  const disc = circle(50, 50, 44);
  const cells = t.within(t.voronoi(t.relax(t.scatter({ spacing: 3.2, within: disc }), { iterations: 2, within: disc })), disc);
  return cells.faces().measure().results.map((r) => {
    const [x, y] = r.inscribedCentre;
    const d = dark(x, y);
    const size = r.inscribedRadius * Math.min(1, d * 1.3);
    if (size < 0.2) return null;
    // Tone twice over: the mark grows to fill its cell, and darker cells
    // carry more rings inside that same bound. Nothing can ever collide.
    const rings = d > 0.7 ? 2 : 1;
    return group({ rotate: degrees(r.orientation), scale: [1, 1 - r.elongation], origin: [x, y] },
      t.times(rings, (k) => circle(x, y, (size * (k + 1)) / rings, { pen: 'pigma-005-black' })));
  });
});
```

Poked: a measurement is a table, and its columns are ordinary values, so they can be fed back into the verb that produced them. Lift one generation's inscribed centres with `material(points)` and they are the sites for the next generation's cells — a relaxation that moves each site to its cell's *incentre* rather than its centroid. It is not a named algorithm anywhere and it is three lines here, and it converges on something Lloyd does not: a near circle packing. The pale cells are where it started and the dark ones where it settled.

```ts live
import { sketch, strokes, circle, material } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  let sites = t.scatter({ spacing: 15 });
  const generations = [];
  for (let g = 0; g < 4; g++) {
    const cells = t.voronoi(sites);
    generations.push(cells);
    // The incentres of this generation are the sites of the next one.
    sites = material(cells.faces().measure().map((r) => [...r.inscribedCentre]));
  }
  const last = generations[generations.length - 1];
  return [
    strokes(generations[0], { pen: 'stabilo-88-blue' }),
    strokes(last, { pen: 'pigma-005-black' }),
    last.faces().measure().map((r) => circle(r.inscribedCentre[0], r.inscribedCentre[1], r.inscribedRadius, { pen: 'pigma-005-black' })),
  ];
});
```

And in three dimensions. The cells are measured flat, in the chart the surface
carries, and one scale is drawn inside each cell's inscribed circle — so no two
scales can overlap, and `mapSurface` carries that guarantee onto the form,
where the pod occludes the far side of its own skin. The form is described by
its silhouette and its scales alone: `creaseAngle: 180` asks for no folds.

```ts live
import { sketch, pen, mm, curve, rect } from 'occlude';
import { sphere, mapSurface, style, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 11, pens: {
  ink: pen({ width: mm(0.35), color: '#18202A' }),
  scale: pen({ width: mm(0.22), color: '#A84932' }),
} }, (t) => {
  const CHART = { x: 0, y: 0, width: 100, height: 100 };
  const field = rect(0, 0, 100, 100);
  const cells = t.within(t.voronoi(t.relax(t.scatter({ spacing: 4.4, within: field }), { iterations: 2, within: field }), { bounds: { x: 0, y: 0, w: 100, h: 100 } }), field);
  // One scale per cell, bounded by the circle that cell can hold and turned
  // onto its own axis. Each sits inside its own cell, so no two can overlap —
  // and the chart carries that guarantee onto the form.
  const scales = cells.faces().measure().results.filter((r) => r.inscribedRadius > 0.7).map((r) => {
    const [cx, cy] = r.inscribedCentre;
    const a = r.orientation;
    const rx = r.inscribedRadius * 0.94;
    const ry = rx * (1 - r.elongation * 0.8);
    return curve(t.times(24, (k, u) => {
      const th = u * Math.PI * 2;
      const px = Math.cos(th) * rx;
      const py = Math.sin(th) * ry;
      return [cx + px * Math.cos(a) - py * Math.sin(a), cy + px * Math.sin(a) + py * Math.cos(a)];
    }), { closed: true });
  });
  const pod = sphere(1.6, { segments: 72, rings: 36 })
    .displace((p) => 0.06 * t.noise(p.x * 1.4, p.y * 1.4, p.z * 1.4));
  // creaseAngle 180 draws no folds, so the form is its silhouette and the
  // scales wrapping it; the marks carry their own pen.
  return view([pod, style(mapSurface(pod, scales, { frame: CHART }), { stroke: 'scale' })], {
    camera: orthographic({ eye: [5, 3.4, 1.1], target: [0, 0, 0], span: 4 }),
    stroke: 'ink',
    creaseAngle: 180,
  });
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
  const internal = rooms.edges.subtract(rooms.boundaryEdges());
  const opened = cells.steps(1, (_cur, next) => next.disconnect(internal));
  // The boundary goes down first: ink laid on ink already there is dropped,
  // so the black walls yield to the blue boundary where they coincide.
  return [
    rooms.map((f) => polygon(f, { fill: fill('hatch', { angle: 30, spacing: mm(1.6) }), stroke: false })),
    strokes(rooms.boundaryEdges(), { pen: 'stabilo-88-blue' }),
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
    next.extrude(tips, (p) => {
      const h = p.heading + t.noise(p.x / 16, p.y / 16, k * 0.01) * 0.5;
      const headings = t.chance(0.08) ? [h, h + (t.chance(0.5) ? 1.2 : -1.2)] : [h];
      return headings.map((hh) => {
        const target = add(p, mul(fromAngle(hh), 3));
        const hit = edges.firstHit(p, target, { excludeIncident: p });
        if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
        return { position: target, attributes: { active: 1, heading: hh } };
      });
    });
    next.set(tips, { active: 0 });
  });
  const planar = web.planarize({ point: () => ({ active: 0, heading: 0 }) });
  const enclosed = planar.faces();
  if (enclosed.length === 0) return strokes(web);
  const light = (x, y) => Math.max(0, 1 - Math.hypot(x - 70, y - 40) / 90);
  const measured = enclosed.measure(light, { resolution: 200 });
  const lit = enclosed.filter((f) => f.area > 25 && measured.forFace(f).mean > 0.5);
  return [
    lit.map((f) => polygon(f, { fill: fill('hatch', { angle: 60, spacing: mm(1.2) }), stroke: false })),
    strokes(lit.boundaryEdges(), { pen: 'stabilo-88-blue' }),
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
    next.move(cur.points, (p) => mul(swirl(p), 0.3));
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
      next.move(cur.points, (p) => [Math.sin(p.y / 6) * 9, Math.cos(p.x / 7) * 5]);
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
| `split`, `splitEdges`, `extrude`, `addPoint` | a split vertex inherits by the policy, then `point` overrides; a new point must give every column | children copy or share the parent, then `edges(parent, child)` overrides | iteration +1 per step |
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
    next.move(cur.points, (p) => mul(sum(pull(p), repel(p), wander(p, k)), 0.15));
    next.set(cur.points, (p) => ({ age: p.age + 1 }));
  }, (cur, next, k) => {
    next.splitEdges(cur.edges.filter((e) => e.length > 1.8 && t.chance(0.3)), { point: { age: 0 } });
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
    next.extrude(tips, (p) => {
      const h = p.heading + t.noise(p.x / 8, p.y / 8, k * 0.01) * 0.7;
      const target = add(p, mul(fromAngle(h), 1.2));
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0, age: k } }) };
      const kids = [{ position: target, attributes: { active: 1, heading: h, age: k } }];
      if (t.chance(0.14)) kids.push({ position: add(p, mul(fromAngle(h + 0.8), 1.2)), attributes: { active: 1, heading: h + 0.8, age: k } });
      return kids;
    });
    next.set(tips, { active: 0 });
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
      web.points.filter((p) => p.adjacent.length > 2).map((p) => circle(p.x, p.y, 0.7, { pen: 'stabilo-88-blue' })),
      web.points.filter((p) => p.adjacent.length === 1).map((p) => circle(p.x, p.y, 0.4))),
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
| a point selection | a **selection** of the points inside, of the same source: it chains with `.filter` and can be passed directly to edits such as `next.move(selection, displacement)` |
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

## Oscillation

`m.oscillate({ wavelength, amplitude, shape?, phase?, steps? })` swings a chain from side to side as it goes. It is a same-world method like `thicken`: no seed, no paper, and `wavelength` and `amplitude` are numbers in the material's own coordinates — or **fields** read at each sample, which is the whole point, because then tone drives them. The result is ordinary Material with the source's own columns, so it strokes, resamples, planarizes, thickens and is occluded like anything else.

| Option | Meaning |
|---|---|
| `wavelength` | distance along the chain for one whole cycle; a number or a field, positive wherever a chain goes |
| `amplitude` | how far it swings to either side; a number or a field. 0 leaves the chain alone, negative mirrors the waveform |
| `shape` | the waveform: phase in `[0, 1)` to `−1…1`. Default `sin(2πu)` |
| `phase` | where in the cycle every chain starts, in cycles. Default 0 |
| `steps` | samples per wavelength, at least 4. Default 16 |

Why this earns its place on a plotter: a hatch that darkens by *wiggling* is one continuous pen-down stroke, where a hatch that darkens by crowding is many strokes with a pen lift between each. Ink for ink, the wiggle is far cheaper to draw.

Two details are load-bearing. Phase is **integrated** along the chain, `φ(s) = ∫ ds/λ`, not computed as `s/λ` — with a wavelength that varies those differ, and only the integral keeps the swings continuous instead of jumping wherever λ changes. And a **closed chain rounds its total to a whole number of cycles** (never below one), so a ring's wave meets its own seam rather than showing a step; an open chain keeps exactly the wavelength it asked for.

`shape` is a plain function, so the waveforms are recipes rather than options: `(u) => u < 0.5 ? 4 * u - 1 : 3 - 4 * u` is a triangle, `(u) => u < 0.5 ? 1 : -1` a square, `(u) => 2 * u - 1` a sawtooth. A junction is an error, as it is for `along` and `resample`: a branch has no single side to swing to.

One chain each — a plain swing, a wavelength that stretches, an amplitude that grows, and a ring that comes back to meet itself.

```ts live
import { sketch, strokes, curve, circle } from 'occlude';

// One chain each: a plain swing, a wavelength that stretches, an amplitude
// that grows, and a ring — whose wave comes back to meet its own seam.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => [
  strokes(curve([[12, 16], [188, 16]]).oscillate({ wavelength: 9, amplitude: 4 })),
  strokes(curve([[12, 38], [188, 38]]).oscillate({ wavelength: (x) => 2.5 + (x / 200) * 16, amplitude: 4 })),
  strokes(curve([[12, 60], [188, 60]]).oscillate({ wavelength: 9, amplitude: (x) => 0.3 + (x / 200) * 7 })),
  strokes(t.sample(circle(100, 81, 12), { count: 200 }).oscillate({ wavelength: 6, amplitude: 2.6 })),
]);
```

Distance, drawn as texture. Every ridge is the same construction; what changes is how hard it wiggles and how tightly, so the far ones read as haze and the near ones as scrub. The amplitude is a field, which is why the scrub clumps into bushes instead of running at one height, and each ridge carries an opaque mask with no texture at all, so it simply hides the country behind it. Every mark on the page is one continuous pen-down stroke.

```ts live
import { sketch, strokes, polygon, curve } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const K = 8;
  const out = [];
  for (let k = 0; k < K; k++) {
    const u = k / (K - 1);
    const base = 31 + k * 7.6;
    const spine = curve(t.times(120, (j, f) => {
      const x = -6 + f * 212;
      return [x, base - t.noise(x * (0.012 + u * 0.01) + k * 4.1, k * 2.3) * (4 + u * 13)];
    }));
    // Near ground is scrub: short wavelength, wide swing. Distance smooths
    // and stretches it until the far ridges are almost a clean line.
    // Amplitude is a field, so the scrub clumps along the ridge instead of
    // running at one height: bushes here, bare ground there.
    const reach = 0.1 + u * u * 4.6;
    const scrub = spine.oscillate({
      wavelength: 13 - u * 10.8,
      amplitude: (x) => reach * (0.18 + Math.max(0, t.noise(x * 0.055 + k * 7, k * 3)) * 1.5),
      phase: k * 0.31,
    });
    const pts = scrub.curves()[0].pts;
    out.push(
      // An opaque mask with no texture: the ridge hides what stands behind it.
      polygon([...pts, [206, 101], [-6, 101]], { opaque: true, stroke: false }),
      strokes(scrub),
    );
  }
  return out;
});
```

Composed with the rest of the toolkit. One distance field does two jobs at once: its `curl` gives the streamlines their direction, and its value gives the oscillation its wavelength and amplitude — so the water's texture and its path cannot disagree, being the same function read twice.

```ts live
import { sketch, strokes, polygon, circle, rect, append, curl, distanceTo } from 'occlude';

// Two stones in a stream. The streamlines come from the curl of the stones'
// shared distance field, so they take the shape of both and merge between
// them; the oscillation reads that same field, so the water is turbulent
// close in and glassy far off; and the stones go down opaque last, which is
// why the flow stops dead at them instead of eroding.
export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  const stones = [rect(68, 50, 30, 17, { rotate: 24, mode: 'center' }), circle(130, 56, 11)];
  const d = distanceTo(append(t.material(stones[0]), t.material(stones[1])));
  const out = (x, y) => Math.max(0, -d(x, y));
  const lines = t.streamlines(t.within(curl(d), circle(100, 50, 105)), { spacing: 1.6 });
  return [
    strokes(lines.oscillate({
      wavelength: (x, y) => 1.7 + out(x, y) * 0.55,
      amplitude: (x, y) => 1.05 * Math.exp(-Math.pow(out(x, y) / 13, 2)),
    })),
    stones.map((s) => polygon(t.material(s), { opaque: true })),
  ];
});
```

Poked: an amplitude far larger than the ring it swings on. The wave turns the ring inside out and crosses itself, so the output stops being a line and becomes a network — planarize it and it has faces, and the shape columns above then hatch each petal along its own axis. Neither operation knows about the other.

```ts live
import { sketch, strokes, polygon, circle, fill, mm, degrees } from 'occlude';

// Poked: an amplitude far larger than the ring it swings on. The wave turns
// the ring inside out and crosses itself, so the output stops being a line
// and becomes a network — planarize it and it has faces, which can be read
// and filled by the room each one holds.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const ring = t.sample(circle(100, 50, 21), { count: 900 });
  const knot = ring.oscillate({ wavelength: 11, amplitude: 27 }).planarize();
  const measured = knot.faces().measure();
  return [
    measured.results.filter((r) => r.inscribedRadius > 1.2).map((r) =>
      polygon(r.face, { fill: fill('hatch', { angle: degrees(r.orientation), spacing: mm(0.3 + r.inscribedRadius * 0.2) }), stroke: false })),
    strokes(knot, { pen: 'stabilo-88-blue' }),
  ];
});
```

And in three dimensions. The bands are ordinary 2D chains, oscillated flat
against a roughness field and then mapped onto a globe, so the latitude lines
buckle over the rough ground and run smooth over the calm — a relief map made
of nothing but a wavelength and an amplitude that read the page. The globe
hides its own far side.

```ts live
import { sketch, pen, mm, curve } from 'occlude';
import { sphere, mapSurface, style, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 9, pens: {
  ink: pen({ width: mm(0.32), color: '#18202A' }),
  relief: pen({ width: mm(0.2), color: '#2F5D7C' }),
} }, (t) => {
  const CHART = { x: 0, y: 0, width: 100, height: 100 };
  // Where the ground is rough the latitude lines buckle, and buckle tightly.
  const rough = (x, y) => Math.max(0, t.noise(x / 17, y / 17) * 1.15 - 0.08);
  const bands = t.times(38, (k, u) => curve(t.times(300, (j, f) => [f * 100, 7 + u * 86])).oscillate(
    { wavelength: (x, y) => 2.2 + (1 - rough(x, y)) * 7, amplitude: (x, y) => rough(x, y) * 1.5 },
  ));
  const globe = sphere(1.6, { segments: 96, rings: 48 });
  return view([globe, style(mapSurface(globe, bands, { frame: CHART }), { stroke: 'relief' })], {
    camera: orthographic({ eye: [5, 2.6, 1.6], target: [0, 0, 0], span: 3.9 }),
    stroke: 'ink',
    creaseAngle: 180,
  });
});
```

## Interlacing

Occlusion in this project is *computed*: exact, from geometry, in draw order. A
knot diagram is the opposite kind of object — a curve plus a decision at every
crossing, authored rather than derived. No amount of exact geometry gives you
that, because the two strands are in the same plane and neither is in front.
Which one is on top is information the drawing **carries**, not information it
contains.

`m.interlace({ gap, over? })` adds that information. Every proper crossing of
two non-adjacent edges is found, `over` is asked which strand is on top, and
the one underneath loses `gap` of its length, centred on the crossing. What
comes back is ordinary Material — shorter, in more pieces — which strokes,
resamples and plots like anything else. Nothing about occlusion changed, and
nothing here consults it.

| Option | Meaning |
|---|---|
| `gap` | how much of the under strand is removed, in the material's own coordinates |
| `over(c)` | `true` when strand A is on top. Default alternates along each chain |

The crossing `c` carries `x`, `y`, which chains the two strands belong to
(`chainA`, `chainB`), how far along each it happened (`alongA`, `alongB`) and
how many crossings each had already met (`nthA`, `nthB`). The default —
alternating — is what makes woven work look woven, and is what a Celtic knot or
a three-strand braid is doing. `over: () => true` is a plain painter's order
instead, and any rule you can write over those fields is available: the point
is that the decision is data.

A zero `gap` removes nothing and therefore splits nothing. Two adjacent
segments of one chain meet at a vertex rather than crossing, and are never
counted; a strand crossing *itself* elsewhere is.

Like `thicken` and `oscillate` this is a same-world method: no seed, no paper,
and `gap` is a length in the material's own coordinates.

```ts live
import { sketch, strokes, curve, append, label, group } from 'occlude';

// One crossing, three ways. The geometry is identical in all three — two
// straight lines meeting at a point — and the only thing that differs is what
// `over` returns. Nothing about occlusion is involved: both strands are in the
// same plane, neither is in front, and which one is on top is information the
// drawing carries rather than information it contains.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const pair = (cx) => append(
    curve([[cx - 22, 34], [cx + 22, 66]]),
    curve([[cx - 22, 66], [cx + 22, 34]]),
  );
  const shown = [
    ['gap: 0', (m) => m.interlace({ gap: 0 })],
    ['over: () => true', (m) => m.interlace({ gap: 7, over: () => true })],
    ['over: () => false', (m) => m.interlace({ gap: 7, over: () => false })],
  ];
  return shown.map(([text, fn], i) => {
    const cx = 36 + i * 64;
    return [strokes(fn(pair(cx))), label(text, cx - 24, 78, 3.2, { pen: 'stabilo-88-blue' })];
  });
});
```

Eight rings, and a list of decisions.

```ts live
import { sketch, strokes, circle, append } from 'occlude';

// A knot panel. Eight rings on a circle, each overlapping its neighbours, and
// every crossing decided by the rule that a strand which went under last time
// goes over this time — which is all that "woven" means. The whole figure is
// one geometric arrangement plus a list of decisions; take the decisions away
// and it is a pile of circles.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const N = 8;
  const rings = t.times(N, (k) => {
    const a = (k / N) * Math.PI * 2;
    return t.sample(circle(100 + Math.cos(a) * 28, 50 + Math.sin(a) * 28, 17), { count: 260 });
  }).reduce((p, q) => append(p, q));
  return strokes(rings.interlace({ gap: 2.6 }));
});
```

Composed with the rest of the toolkit: grown by a rule rather than drawn, with
nothing keeping the strands apart, so they are allowed to run over one another;
wobbled by `oscillate`; and only then told which of them is on top.

```ts live
import { sketch, strokes, material, curl, add, mul, fromAngle } from 'occlude';

// Composed: a tangle that was grown, not drawn. Each strand is a tip with a
// heading, extruded one step at a time and steered toward the curl of a noise
// field — the rule is four lines of `steps`, and nothing in it keeps a strand
// off another, so for once they run over one another. `oscillate` gives each
// a wobble; `interlace` then decides, at every one of the crossings that made,
// which strand is on top. Three operations that know nothing about each
// other, and a nest at the end of it.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const flow = curl((x, y) => t.noise(x / 40, y / 40));
  const seeds = material(
    t.times(26, (k) => { const a = (k / 26) * Math.PI * 2; return [100 + Math.cos(a) * 44, 50 + Math.sin(a) * 24]; }),
    { heading: t.times(26, (k) => (k / 26) * Math.PI * 2 + Math.PI), tip: 1 },
  );
  const grown = seeds.steps(150, (cur, next) => {
    const tips = cur.points.filter((p) => p.tip === 1);
    next.extrude(tips, (p) => {
      const [dx, dy] = flow(p.x, p.y);
      const heading = p.heading * 0.75 + Math.atan2(dy, dx) * 0.25;
      return { position: add(p, mul(fromAngle(heading), 1.1)), attributes: { heading, tip: 1 } };
    });
    next.set(tips, { tip: 0 });
  });
  const wobbled = grown.oscillate({ wavelength: 13, amplitude: 1.6 });
  return strokes(wobbled.interlace({ gap: 2.2 }));
});
```

Poked: `over` does not have to alternate, and it does not have to be about the
strands at all. Here it asks *where the crossing is*, so a shape appears in the
cloth that no line follows and nothing shades.

```ts live
import { sketch, strokes, curve, append } from 'occlude';

// Poked: the crossings carry the picture. This is a plain plaid, evenly
// spaced, every strand identical — and `over` is not alternating but asks
// where it is. All the warp is laid down first and all the weft after, so
// `chainA < N` says which of the two strands at a crossing is the warp; inside
// the disc the warp passes over, outside it the weft does. The disc is
// therefore never drawn. No line follows it, nothing is shaded and nothing is
// occluded: it exists only as a change in which strand is on top.
export default sketch({ aspect: [1, 1], seed: 1 }, (t) => {
  const N = 26;
  const at = (k) => 3 + (k / (N - 1)) * 94;
  const warp = t.times(N, (k) => curve([[1, at(k)], [99, at(k)]]));
  const weft = t.times(N, (k) => curve([[at(k), 1], [at(k), 99]]));
  const cloth = [...warp, ...weft].reduce((p, q) => append(p, q));
  return strokes(cloth.interlace({
    gap: 1.7,
    over: (c) => (c.chainA < N) === (Math.hypot(c.x - 50, c.y - 52) < 31),
  }));
});
```

And in three dimensions, which is the experiment worth doing at least once: the
same trefoil, on the left as a flat curve that is **told** which strand is on
top, and on the right as a real tube in space where the classifier is told
nothing and works it out. The two diagrams agree, and only one of them needed a
third dimension to exist.

```ts live
import { sketch, pen, mm, strokes, curve, label, group } from 'occlude';
import { circle, polyline, sweep, view, orthographic } from 'occlude/3d';

// The same knot, decided two ways. On the left it is flat: one closed curve
// that crosses itself three times, and `interlace` is TOLD which strand is on
// top at each crossing. On the right it is a real tube in space, tied into an
// actual trefoil, seen from directly above — and nobody tells the classifier
// anything, it works out what hides what. The two diagrams agree, which is the
// whole point: authoring and computing are different representations of the
// same drawing, and only one of them needs the third dimension to exist.
export default sketch({ seed: 1, pens: {
  ink: pen({ width: mm(0.4), color: '#18202A' }),
} }, (t) => {
  const P = 300;
  const pt = (k) => {
    const a = (k / P) * Math.PI * 2;
    return [Math.sin(a) + 2 * Math.sin(2 * a), Math.cos(a) - 2 * Math.cos(2 * a), -Math.sin(3 * a)];
  };
  const flat = curve(t.times(P, (k) => { const [x, y] = pt(k); return [26 + x * 5.2, 46 + y * 5.2]; }), { closed: true });
  return [
    group({}, strokes(flat.interlace({ gap: 2.1 }), { pen: 'ink' }), label('AUTHORED', 13, 80, 3.4, { pen: 'ink' })),
    group({ translate: [25, -4] },
      view(sweep(circle(0.16, { segments: 14 }), polyline(t.times(P, pt), { closed: true })), {
        camera: orthographic({ eye: [0, -1.1, 12], target: [0, 0, 0], span: 19 }),
        stroke: 'ink',
        creaseAngle: 180,
      })),
    label('COMPUTED', 61, 80, 3.4, { pen: 'ink' }),
  ];
});
```

## Thickness

**`source.thicken(opts)`** turns points and connections into filled ribbons, beaded outlines, and perforated networks. Start with native material from `t.scatter`, `t.sample`, `t.voronoi`, or `t.streamlines`, then choose a radius — the full width is twice that radius. Overlapping parts join into one area; isolated points become discs, and openings between connections can remain as holes.

Finite negative radii clamp to zero, including values returned by a radius field. This lets a field fade thickness out without a render error. Clamping happens at source vertices before interpolation along edges; it does not shrink an existing filled area. `NaN` and infinite radii remain errors.

The result is an ordinary boundary **Material**. Draw it with `polygon` and a fill, trace it with `strokes`, sample its outline with `along`, or use `distanceTo` and `t.isolines` for contour bands. `thicken` is a method on the material; drawing and filling remain explicit.

Use `polygon(body, { fill: fill('hatch') })` to fill the combined area while preserving its holes. `strokes(body, { fill: … })` creates a separate filled shape for **each** boundary, including the hole boundaries; it does not fill the compound area.

### Cellular lace

Turn Voronoi walls into a continuous cut-paper lattice. A relaxed scatter supplies the cells; a radius that grows down the page makes the openings gradually smaller. The hatch fills the thickened walls while the holes stay empty. Try changing the scatter spacing, the relaxation count, or the radius field.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 19 }, (t) => {
  const sites = t.relax(t.scatter({ spacing: 14 }), { iterations: 3 });
  const lace = t.voronoi(sites, { bounds: { x: 7, y: 7, w: 86, h: 86 } });
  const body = lace.thicken({ radius: (p) => 0.45 + 1.5 * p.y / 100 });
  return polygon(body, {
    fill: fill('hatch', { angle: 35, spacing: mm(0.6) }),
    pen: 'stabilo-88-blue',
  });
});
```

The operation knows nothing about roots, branches, age or pressure. `radius` is a number, or a callback read off the source's own vertex views — its real attributes (`p.radius`), never a wrapper. It runs exactly once per participating vertex, in source row order, and its results are cached; along an edge the two cached radii interpolate linearly whatever the column's transfer policy says. `radius` and `tolerance` are resolved material-coordinate numbers: an unresolved length such as `mm(1)` is refused rather than read against global paper.

What participates:

| `source` | vertices | edges |
|---|---|---|
| a Material | every vertex, isolated ones as bare discs | every edge |
| a point selection | every selected vertex, including selected vertices with no selected neighbour | existing edges whose **both** endpoints are selected |
| an edge selection | the endpoints of the selected edges only | the selected edges only |

### A ribbon or a string of beads

Sample a circle, then vary the radius in six waves around its rim. On the left, the point selection keeps the ring's connections and makes a scalloped ribbon. On the right, `.extract()` drops connectivity and the same samples become overlapping beads. Increase the sample count to bring the beads together; change the wave count to reshape the ornament.

```ts live
import { sketch, circle, polygon, fill, mm, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const ring = t.sample(circle(50, 50, 34), { count: 30 })
    .attribute('radius', (p) => 2 + 2.8 * (1 + Math.cos(6 * Math.atan2(p.y - 50, p.x - 50))) / 2);
  const body = (source) => polygon(source.thicken({ radius: (p) => p.radius }), {
    fill: fill('hatch', { angle: 45, spacing: mm(0.65) }),
  });
  return [body(ring.points), group({ translate: [100, 0] }, body(ring.points.extract()))];
});
```

### Flow ribbons with a carried attribute

Streamlines already arrive as connected material. Here a smooth wave controls both ribbon width and a `tone` column. The `point` callback carries that tone onto the new boundary; a point selection then accents just the high-tone stretches in blue. Change the flow field or the width wave to move between woven bands and broad calligraphic marks.

Without `point` the result carries **no columns** — this is a generative conversion, not a topology-preserving edit, so nothing is inherited and no source vertex keeps its identity. With `point`, the callback runs once for each final boundary vertex, after ordering and tessellation, and returns that row's complete record:

```ts live
import { sketch, curl, rect, polygon, strokes, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const flow = t.within(curl((x, y) => t.noise(x / 55, y / 55)), rect(6, 6, 188, 88));
  const threads = t.streamlines(flow, { spacing: 9, step: 2 })
    .attribute('tone', (p) => (1 + Math.sin(p.x / 13 + p.y / 19)) / 2);
  const ribbons = threads.thicken({
    radius: (p) => 0.45 + 2.3 * p.tone,
    point: ({ candidates }) => ({ tone: Math.max(...candidates.map((c) => c.attrs.tone)) }),
  });
  return [
    polygon(ribbons, { fill: fill('hatch', { angle: 60, spacing: mm(0.7) }), stroke: false }),
    strokes(ribbons.points.filter((p) => p.tone > 0.7).edges.extract(), { pen: 'stabilo-88-blue' }),
  ];
});
```

`event.position` is the generated boundary vertex; `event.candidates` names what produced it in the **original** source (or the selection's `.source`): endpoint-cap samples give a vertex row; side samples give the edge row with its recovered `a → b` envelope parameter, normalized to a vertex at `t = 0` or `1`. Attribution uses the boundary approximation budget. Candidate attributes interpolate by each source column's declared policy, independently of the linear computed radius.

One distinction worth keeping straight: thickening an already thickened **boundary** is a new band around those boundary edges, not a dilation of the previously filled interior — the boundary has no memory of the fill. Radii are the source's own units; `tolerance` (default `0.05`) is a total approximation budget in material units. It includes polygonal curve approximation and integer-grid rounding. The grid becomes finer for small radii, so an isolated disc is retained even when the requested tolerance exceeds its radius. Invalid sources, options, radii and callback records name the offending row or key with a `thicken:` error, and same values give the same arrays and callback order on a given build.

Thickening samples the endpoint discs, takes their convex hulls, and unions those polygons with Clipper in TypeScript. Curve approximation uses at most one quarter of `tolerance`; the power-of-two grid is no larger than `min(tolerance / 64, smallest positive radius / 1024)`. Gaps, overlaps and holes near the approximation scale may change connectivity or disappear: exact sub-tolerance topology is not promised. No renderer or WASM initialization is needed. `point` callbacks receive deterministic source attribution within the approximation budget; intersection positions and candidate sets can differ from the former analytical implementation. Construction, coordinate-range and provenance budgets produce explicit errors instead of partial output.

## Cages

`deform(field)` moves every point on its own. That is the right tool for grain
and drift and the wrong one for "pull this corner out": a field never sees more
than one point at a time, so it cannot know that a stroke should turn as it
stretches, or that a hatch should stay evenly spaced.

A cage can. `m.warp({ from, to })` writes every point of the material once as
a fixed weighted blend of the cage's corners — mean value coordinates, a closed
form with no solve, defined everywhere in the plane — and then re-evaluates the
blend against the moved corners. Move a corner and the whole drawing follows
it: strokes turn, spacing opens and closes, and a circle comes out as a
believable squashed circle rather than a sheared one.

| Option | Meaning |
|---|---|
| `from` | the cage as it was: one loop of corners, or a material to read one from |
| `to` | the same cage, moved — the same number of corners, in the same order |

There is no cage *type*. A cage is two loops, the way an area here is an input
rather than a type, and either loop can be a plain array of `[x, y]` or any
material a chain can be read from. Structure is untouched: edges, columns, row
order and chain membership all survive, because this moves points and nothing
else.

Two things follow from that, and both matter in practice. **`warp` moves
vertices**, so a straight line with two of them comes out straight however
violently the cage is pulled; `resample` first and the line bends. And **mean
value coordinates reproduce affine maps exactly**, so a cage whose corners only
move in x leaves every horizontal line horizontal — if you want a hatch to tip,
the cage has to tip.

Points outside the cage are carried too, and honestly: the coordinates are
defined out there, so a drawing does not have to be contained. They are only
*well behaved* near the cage, and a point far outside a badly moved cage can be
sent somewhere surprising. That is a property of the coordinates, not a missing
check. A cage that folds over itself is likewise not refused, and not
recommended.

Like `thicken`, `oscillate` and `interlace` this is a same-world method: no
seed, no paper, no units.

The same lattice twice, with one corner of the cage dragged:

```ts live
import { sketch, strokes, curve, append, connect, material, group, label } from 'occlude';

// The blue quadrilateral is the cage: four corners, and on the right the
// bottom-right one has been dragged. Every point of the lattice was written
// once as a weighted blend of those four corners, so moving one of them is the
// whole edit — nothing was re-laid out, and the lines bow rather than shear,
// because each point follows all four corners at once and no two points are
// the same blend.
//
// The lattice is resampled first. `warp` moves vertices and nothing else, so a
// line with only two of them can only ever come out straight: give it points
// where you want it to bend.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const rest = [[4, 14], [86, 14], [86, 86], [4, 86]];
  const pulled = [[4, 14], [86, 14], [62, 94], [4, 86]];
  const lattice = [
    ...t.times(9, (k) => curve([[8, 18 + k * 8], [82, 18 + k * 8]])),
    ...t.times(9, (k) => curve([[8 + k * 9.2, 18], [8 + k * 9.2, 82]])),
  ].reduce((p, q) => append(p, q)).resample({ spacing: 1.2 });
  const panel = (cage, x, text) => group({ translate: [x, 0] }, [
    strokes(lattice.warp({ from: rest, to: cage })),
    strokes(connect.ring(material(cage)), { pen: 'stabilo-88-blue' }),
    label(text, 4, 8, 3.2, { pen: 'stabilo-88-blue' }),
  ]);
  return [panel(rest, 2, 'THE CAGE'), panel(pulled, 104, 'ONE CORNER MOVED')];
});
```

### Thrown, not sheared

Four vessels, one drawing. The hatch is made once, flat, and each pot is that
drawing read through a different cage.

```ts live paper=200x100
import { sketch, rect, curve, append, strokes, group } from 'occlude';

// The hatch is the throwing rings, so it crowds at the foot and the neck where
// the wall pulls in, opens across the belly, and tips where the axis leans.
// Generating the hatch after the warp would have given four sets of straight
// parallel lines; generating it once and moving it is what makes these look
// turned on a wheel rather than sheared.
//
// The rest cage is a rectangle read as (side, height); the destination lays
// those coordinates on a curved spine, so a cross-section at height v sits
// ACROSS the axis rather than level. That part matters: mean value coordinates
// reproduce affine maps exactly, so a cage that only moves x would leave every
// ring horizontal. The rings bend because the axis bends.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const N = 30;
  const rest = [];
  for (let i = 0; i <= N; i++) rest.push([40, (i / N) * 80]);
  for (let i = 1; i <= N; i++) rest.push([40 - (i / N) * 40, 80]);
  for (let i = 1; i <= N; i++) rest.push([0, 80 - (i / N) * 80]);
  for (let i = 1; i < N; i++) rest.push([(i / N) * 40, 0]);

  const hatch = t
    .times(30, (k) => curve([[0.4, 1.5 + k * 2.65], [39.6, 1.5 + k * 2.65]]))
    .reduce((p, q) => append(p, q))
    .resample({ spacing: 1.1 });
  const wall = t.sample(rect(0, 0, 40, 80), { spacing: 1.1 });

  // half-width and lateral sway of the axis, by height (0 at the foot, 1 at the lip)
  const forms = [
    { r: (v) => 4 + 13 * Math.sin(Math.PI * (0.14 + 0.74 * v)), sway: (v) => 1.5 * Math.sin(Math.PI * v) },
    { r: (v) => 5 + 11 * Math.sin(Math.PI * v ** 0.6) - 3 * v ** 6, sway: (v) => -3 * Math.sin(Math.PI * v) },
    { r: (v) => 13 - 8 * v + 4.5 * Math.sin(Math.PI * 2.1 * v), sway: (v) => 3 * Math.sin(Math.PI * 1.5 * v) },
    { r: (v) => 4 + 12 * (1 - (1 - v) ** 2.1) * (1 - 0.68 * v ** 4) + 5 * v ** 9, sway: (v) => 2.5 * v ** 1.6 },
  ];

  return forms.map((f, i) => {
    const spine = (v) => [20 + f.sway(v), 72 * v];
    const cage = rest.map(([x, y]) => {
      const v = y / 80;
      const [ax, ay] = spine(Math.min(1, v + 0.004));
      const [bx, by] = spine(Math.max(0, v - 0.004));
      const len = Math.hypot(ax - bx, ay - by);
      const [nx, ny] = [(ay - by) / len, -(ax - bx) / len];
      const [cx, cy] = spine(v);
      const u = x / 20 - 1;
      return [cx + nx * f.r(v) * 1.1 * u, cy + ny * f.r(v) * 1.1 * u];
    });
    return group({ translate: [22 + i * 48, 14] }, [
      strokes(hatch.warp({ from: rest, to: cage })),
      strokes(wall.warp({ from: rest, to: cage }), { pen: 'stabilo-88-blue' }),
    ]);
  });
});
```

### Nine petals from one panel

Cells, settling, `within`, an opaque mask and a cage, in a drawing where the
structure is authored once and placed nine times.

```ts live paper=140x140
import { sketch, rect, circle, polygon, strokes, group } from 'occlude';

// There is exactly ONE panel of cell structure here: points scattered and
// settled against a field that wants them crowded at the base, their Voronoi
// cells clipped to a rectangle. Every petal is that panel read through a
// different cage, so the cells stretch along the petal, fan out across it and
// lean with the twist — a whole vein system for the price of one.
//
// Each petal also lays down an opaque mask of its own silhouette before its
// cells, so the petal in front hides the one behind it rather than tangling
// with it. That is the composition: the cage supplies the shape, the occluder
// supplies the depth, and the cells never knew about either.
export default sketch({ aspect: [1, 1], seed: 7 }, (t) => {
  const PW = 40;
  const PH = 100;
  const panel = { x: 0, y: 0, w: PW, h: PH };
  const toward = (x, y) => 0.12 + 0.88 * (1 - y / PH) ** 1.6;
  const sites = t.within(
    t.settle(t.scatter(toward, { spacing: 7 }), { density: toward, spacing: 7, iterations: 14, bounds: panel }),
    rect(0, 0, PW, PH),
  );
  const veins = t.voronoi(sites, { bounds: panel });
  const edge = t.sample(rect(0, 0, PW, PH), { spacing: 1.2 });

  const N = 34;
  const rest = [];
  for (let i = 0; i <= N; i++) rest.push([PW, (i / N) * PH]);
  for (let i = 1; i <= N; i++) rest.push([PW - (i / N) * PW, PH]);
  for (let i = 1; i <= N; i++) rest.push([0, PH - (i / N) * PH]);
  for (let i = 1; i < N; i++) rest.push([(i / N) * PW, 0]);

  const L = t.height * 0.4;
  const r0 = t.height * 0.06;

  const petal = (k) => {
    const twist = 0.5 + 0.22 * Math.sin(k * 1.7);
    const fat = 0.85 + 0.2 * Math.sin(k * 2.3);
    const cage = rest.map(([x, y]) => {
      const v = y / PH;
      const r = r0 + v * L * (0.9 + 0.2 * Math.sin(k * 1.1));
      const hw = t.height * 0.1 * fat * (0.25 * (1 - v) ** 1.5 + 0.8 * Math.sin(Math.PI * v ** 0.8) ** 0.75);
      const lean = twist * v * v * t.height * 0.09;
      return [t.cx + (x / (PW / 2) - 1) * hw + lean, t.cy - r];
    });
    const outline = edge.warp({ from: rest, to: cage });
    return group({ rotate: k * 40, origin: [t.cx, t.cy] }, [
      polygon(outline, { opaque: true, stroke: false }),
      strokes(veins.warp({ from: rest, to: cage })),
      strokes(outline, { pen: 'stabilo-88-blue' }),
    ]);
  };

  return [
    t.times(9, (k) => petal(k)),
    circle(t.cx, t.cy, r0 * 1.05, { opaque: true }),
    t.within(t.scatter(() => 1, { spacing: 2.6 }), circle(t.cx, t.cy, r0 * 0.92)).points.map((p) => circle(p.x, p.y, 0.55)),
  ];
});
```

### The cage that does not move

A cage is two loops and nothing more — so the loops are free to be the *same*
loop, read differently.

```ts live paper=140x140
import { sketch, strokes, curve, append, material, connect } from 'occlude';

// The cage does not move. Only the correspondence does.
//
// `from` and `to` are the SAME square here, corner for corner — nothing is
// stretched anywhere new, and every corner still lands on a corner of the same
// square. But `to` is rolled by a few places, so corner 0 answers to what
// corner 3 used to answer to, and the interior is wrung around the ring while
// the boundary stays exactly where it was.
//
// Six square bands of one lattice, each rolled one place further than the band
// outside it: the frame is rigid, the cloth inside it is being twisted, and
// every band's own border is still exactly the square it was cut from.
export default sketch({ aspect: [1, 1], seed: 2 }, (t) => {
  const N = 48;
  const ringOf = (s) => {
    const half = s / 2;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const u = (i / N) * 4;
      const side = Math.floor(u);
      const f = u - side;
      if (side === 0) pts.push([t.cx - half + f * s, t.cy - half]);
      else if (side === 1) pts.push([t.cx + half, t.cy - half + f * s]);
      else if (side === 2) pts.push([t.cx + half - f * s, t.cy + half]);
      else pts.push([t.cx - half, t.cy + half - f * s]);
    }
    return pts;
  };
  const square = (s) => [
    [t.cx - s / 2, t.cy - s / 2],
    [t.cx + s / 2, t.cy - s / 2],
    [t.cx + s / 2, t.cy + s / 2],
    [t.cx - s / 2, t.cy + s / 2],
  ];

  const lattice = t
    .times(41, (k) => {
      const u = 4 + k * 2.3;
      return append(curve([[4, u], [96, u]]), curve([[u, 4], [u, 96]]));
    })
    .reduce((a, b) => append(a, b))
    .resample({ spacing: 0.8 });

  const sides = [92, 78, 64, 50, 36, 22, 8];
  return [
    sides.slice(0, -1).map((s, i) => {
      const cage = ringOf(s);
      const rolled = cage.map((_, j) => cage[(j + i) % N]);
      // the band between this square and the next one in, cut as one area
      const band = t.within(lattice, [square(s), square(sides[i + 1])]);
      return strokes(band.warp({ from: cage, to: rolled }));
    }),
    sides.map((s) => strokes(connect.ring(material(square(s).map(([x, y]) => ({ x, y })))), { pen: 'stabilo-88-blue' })),
  ];
});
```

### Three pots, one decoration, three cages

A surface chart is an ordinary 2D plane, so a cage works on it exactly as it
works on paper — and `mapSurface` then puts the result on the pot.

```ts live paper=150x120
import { sketch, curve, rect, append, pen, mm } from 'occlude';
import { polyline, revolve, mapSurface, view, perspective, style } from 'occlude/3d';

// The ornament — a diaper lattice with a dot in every diamond — is drawn once,
// flat, on a plain rectangle. A revolve stores its surface as a chart of
// (turn, height), and a cage turns that rectangle into a shield, an ogee leaf
// or a wavy banner. `mapSurface` lays whichever panel it is onto the pot, where
// the wall curls it away from us and the geometry hides what has turned past
// the silhouette.
//
// Nothing about the ornament knows it is going onto a pot, and nothing about
// the pot knows what is being painted on it. The cage is the whole of the
// design step, and it happens in flat chart coordinates where it is easy to
// think about.
export default sketch({ aspect: [5, 4], seed: 5, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  paint: pen({ width: mm(0.2), color: '#1B4FA0' }),
} }, (t) => {
  const R = (s) => 0.3 + 0.7 * Math.sin(Math.PI * (0.12 + 0.8 * s)) ** 1.25 - 0.28 * s ** 5;
  const Z = (s) => -1.3 + 2.5 * s;
  const M = 120;
  const meridian = [[0, 0, Z(0)]];
  for (let i = 0; i <= M; i++) meridian.push([R(i / M), 0, Z(i / M)]);

  const V0 = 0.3;
  const V1 = 0.8;
  const U0 = 0.38;
  const U1 = 0.62;
  const cols = 4;
  const rows = 5;
  const parts = [];
  for (let k = -rows; k <= cols + rows; k++) {
    parts.push(curve([[U0 + ((U1 - U0) * k) / cols, V0], [U0 + ((U1 - U0) * (k + rows)) / cols, V1]]));
    parts.push(curve([[U0 + ((U1 - U0) * k) / cols, V0], [U0 + ((U1 - U0) * (k - rows)) / cols, V1]]));
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = U0 + ((U1 - U0) * (c + (r % 2 ? 0.5 : 0))) / cols;
      const v = V0 + ((V1 - V0) * (r + 0.5)) / rows;
      parts.push(curve(t.times(11, (j) => [
        u + 0.006 * Math.cos((j / 10) * Math.PI * 2),
        v + 0.012 * Math.sin((j / 10) * Math.PI * 2),
      ])));
    }
  }
  // the lattice is generated past the panel on purpose, then cut to it: the
  // cage is only well behaved on what it encloses
  const flatAll = t
    .within(parts.reduce((p, q) => append(p, q)), rect(U0, V0, U1 - U0, V1 - V0))
    .resample({ spacing: 0.004 });
  const flatEdge = t.sample(rect(U0, V0, U1 - U0, V1 - V0), { spacing: 0.004 });

  const N = 30;
  const rest = [];
  for (let i = 0; i <= N; i++) rest.push([U1, V0 + ((V1 - V0) * i) / N]);
  for (let i = 1; i <= N; i++) rest.push([U1 - ((U1 - U0) * i) / N, V1]);
  for (let i = 1; i <= N; i++) rest.push([U0, V1 - ((V1 - V0) * i) / N]);
  for (let i = 1; i < N; i++) rest.push([U0 + ((U1 - U0) * i) / N, V0]);

  const uc = (U0 + U1) / 2;
  const cages = [
    // a shield: broad at the shoulder, drawn in towards the foot
    (a, b) => [uc + (a - 0.5) * (U1 - U0) * (0.42 + 0.72 * b ** 0.6), V0 + (V1 - V0) * b],
    // an ogee leaf, leaning with the turn of the wheel
    (a, b) => [
      uc + (a - 0.5) * (U1 - U0) * (0.34 + 0.8 * Math.sin(Math.PI * b ** 0.85) ** 0.7) + 0.055 * (b - 0.5),
      V0 + (V1 - V0) * b,
    ],
    // a banner: full width, but the rows ride a wave around the pot
    (a, b) => [
      uc + (a - 0.5) * (U1 - U0),
      V0 + (V1 - V0) * (0.12 + 0.76 * b) + 0.075 * Math.sin(Math.PI * 2 * a),
    ],
  ];

  const pot = (k, x, y, s, turn) => {
    const to = rest.map(([u, v]) => cages[k]((u - U0) / (U1 - U0), (v - V0) / (V1 - V0)));
    const panel = append(flatAll.warp({ from: rest, to }), flatEdge.warp({ from: rest, to }));
    const body = revolve(polyline(meridian), { segments: 72 }).scale(s).rotate([0, 0, turn]).translate([x, y, 0]);
    return [body, style(mapSurface(body, panel), { stroke: 'paint' })];
  };

  return view(
    [...pot(0, -1.8, 0.7, 1, 104), ...pot(1, 0.7, -1.0, 0.84, 78), ...pot(2, 2.5, 1.7, 0.7, 96)],
    { camera: perspective({ eye: [2.2, -9.2, 2.6], target: [0.2, 0, 0], fovDegrees: 30 }), stroke: 'ink' },
  );
});
```


## Envelopes

Curve stitching, string art, the mod-n chord pile, guilloché, a ruled surface
seen flat, the caustic in a coffee cup — all of them are one idea. You never
compute the curve you want. You draw a *family* of straight lines, and the
shape appears in the gaps as the curve every one of them is tangent to. Draw
the chord from `(t, 0)` to `(0, k − t)` for every `t` and a parabola is there;
place `n` points on a circle and join `k` to `m·k mod n` and an epicycloid is
there.

What has never been available is that curve **itself**, as geometry: to draw it
heavier than the family, to cut with it, to hang something else off it.
`m.envelope()` returns it.

The textbook definition wants calculus — solve `F(x, y, t) = 0` and
`∂F/∂t = 0` together — and calculus is not what a drawing has. A drawing has a
family in an order, so the definition used here is the discrete one that needs
nothing else: **the envelope of a family is where neighbouring members cross.**
Two consecutive chords of a parabola meet on the parabola; make the family
denser and the meeting points close onto the true curve. The family's own
resolution is the accuracy, which is honest, and is also exactly what the
plotted drawing shows.

The family is the chains of `m`, **in the order they are stored**, which is the
order `append` put them in. Neighbouring means neighbouring in that order, so a
family assembled out of order has a different envelope and is not wrong to. A
family member is one chain: reduce a level set to its largest contour before it
joins a family, or the offshore rocks are interleaved with the members and
"neighbouring" stops meaning anything.

A pair of neighbours may cross more than once, and then the envelope has that
many branches — both are real. Branches are carried from one pair to the next
**by order** along the earlier member, never by distance: ordering is a property
the family already has, where a "nearest" rule would need a tolerance, and a
tolerance here would be a number invented to paper over the fact that nobody
said what the family was. Where a pair crosses fewer times than the pair before
it the extra branches end, and where it crosses more they begin.

This works when the family is **regular** — neighbours crossing a few times,
near where they touch. Rays off a smooth wall are regular. A wandering
coastline sampled through time is not: consecutive contours cross each other
forty times and the result, while it is exactly what was asked for, is not a
tideline. That question is about a hull, not an envelope.

Every vertex carries `member`: the index of the earlier of the two family
members that crossed there. Fading a family by `member`, or cutting each member
at the point where it touched, is then an ordinary column read — the last
sketch below draws nothing else.

Two members that share an endpoint **meet** without crossing, and are not
reported: a pencil of lines through one hub has no envelope, and its hub is the
one place it is provably tangent to nothing.

Like `thicken`, `oscillate`, `interlace` and `warp` this is a same-world
method: no seed, no paper, no units.

```ts live paper=140x140
import { sketch, strokes, curve, append, group } from 'occlude';

// Curve stitching, four times over. Every black line is straight and none of
// them touches the curve at the corner — but the curve is the only thing the
// eye sees, because every one of them is tangent to it. The blue is that
// curve as GEOMETRY: `envelope` reads the family and returns where
// neighbouring members cross, which for a family of chords is what they are
// all tangent to. Nothing solved for √x + √y = √k; the family was drawn, and
// the curve was found in it.
export default sketch({ aspect: [1, 1], seed: 1 }, (t) => {
  const corner = (ox, oy, sx, sy) => {
    const fam = t
      .times(33, (i) => {
        const u = i / 32;
        return curve([[ox + sx * 44 * u, oy], [ox, oy + sy * 44 * (1 - u)]]);
      })
      .reduce((a, b) => append(a, b));
    return [strokes(fam), strokes(fam.envelope(), { pen: 'stabilo-88-blue' })];
  };
  return [
    corner(6, 6, 1, 1),
    corner(94, 6, -1, 1),
    corner(94, 94, -1, -1),
    corner(6, 94, 1, -1),
  ];
});
```

### A rose window

```ts live paper=140x140
import { sketch, strokes, append, material, connect, circle, polygon, group } from 'occlude';

// A rose window. Every black line is straight, and every curve in the tracery
// is one nobody drew: place n points on a circle, join k to m·k, and the pile
// of chords is tangent to an epicycloid with m−1 cusps. The stone is the
// envelope; the leading is the family.
export default sketch({ aspect: [1, 1], seed: 4 }, (t) => {
  const pile = (cx, cy, R, n, m) =>
    t
      .times(n, (k) => {
        const a = (k / n) * Math.PI * 2 - Math.PI / 2;
        const b = ((m * k) % n / n) * Math.PI * 2 - Math.PI / 2;
        return connect.chain(
          material([
            { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) },
            { x: cx + R * Math.cos(b), y: cy + R * Math.sin(b) },
          ]),
        );
      })
      .reduce((p, q) => append(p, q));

  const band = (R, n, m) => {
    const fam = pile(t.cx, t.cy, R, n, m);
    return [strokes(fam), strokes(fam.envelope(), { pen: 'stabilo-88-blue' })];
  };

  // Each band is laid down, then the next ring in is made opaque over it, so
  // the leading of one band never tangles with the tracery of the next.
  return [
    band(46, 126, 7),
    circle(t.cx, t.cy, 30.5, { opaque: true }),
    band(29, 84, 5),
    circle(t.cx, t.cy, 15.8, { opaque: true }),
    band(15, 54, 3),
    circle(t.cx, t.cy, 46),
  ];
});
```

### The light in a dented bowl

```ts live paper=180x120
import { sketch, strokes, append, material, connect, polygon } from 'occlude';

// The light in a dented bowl.
//
// The mirror is not a circle: it is a level set of noise, so its curvature
// changes all the way round. A parallel beam comes in from the left, each ray
// bounces once off the wall, and the caustic — the bright curve the light
// piles up on — is `envelope` of the reflected rays. A round bowl gives the
// tidy two-cusped nephroid in every optics book. A dented one gives this: a
// cusp wherever the wall's curvature turns, which is a fact about the bowl
// that nothing else in the drawing states.
//
// The family has to be regular for an envelope to mean anything — neighbours
// crossing once, near where they touch. Rays off a smooth wall are exactly
// that, which is why they are the family here and the wobbling wall is not.
export default sketch({ aspect: [3, 2], seed: 14 }, (t) => {
  const field = (x, y) =>
    t.noise(x / 46, y / 46) + 0.42 -
    1.3 * Math.hypot((x - t.cx) / (t.width * 0.4), (y - t.cy) / (t.height * 0.46)) ** 2;
  const all = t.isolines(field, 0, { close: true, step: 0.6 });
  const pieces = all.points.components();
  const biggest = pieces.reduce((a, b) => (b.length > a.length ? b : a));
  const bowl = biggest.edges.extract().resample({ spacing: 0.7 });

  const wall = bowl.curves()[0].pts;
  const n = wall.length;
  const rays = wall
    .map(([px, py], i) => {
      const [ax, ay] = wall[(i + n - 1) % n];
      const [bx, by] = wall[(i + 1) % n];
      // the wall's own tangent, and the normal pointing out of the bowl
      const tl = Math.hypot(bx - ax, by - ay);
      const nx = (by - ay) / tl;
      const ny = -(bx - ax) / tl;
      const out = field(px + nx, py + ny) < field(px - nx, py - ny) ? 1 : -1;
      const [ox, oy] = [nx * out, ny * out];
      const dot = ox; // the beam is (1, 0)
      if (dot <= 0.02) return null;
      const rx = 1 - 2 * dot * ox;
      const ry = -2 * dot * oy;
      return connect.chain(material([{ x: px, y: py }, { x: px + rx * 78, y: py + ry * 78 }]));
    })
    .filter(Boolean)
    .reduce((a, b) => append(a, b));

  return [
    strokes(t.within(rays, bowl)),
    // the caustic is cut to the bowl too: where two neighbouring rays run
    // nearly parallel their crossing runs off to infinity, which is true and
    // is not part of the picture
    strokes(t.within(rays.envelope(), bowl), { pen: 'stabilo-88-blue' }),
    strokes(bowl),
  ];
});
```

### The curve that is not drawn

```ts live paper=140x140
import { sketch, strokes, append, material, connect, circle } from 'occlude';

// The curve is not drawn.
//
// Two hundred chords of a circle, k joined to 2k, whose envelope is a
// cardioid. Instead of drawing that cardioid, every chord is CUT at the point
// where it touches it — the envelope's `member` column says which chord each
// tangency belongs to, so each line knows exactly where to stop. What is left
// is a family that ends in mid-air along a curve with no ink on it at all, and
// the eye draws the cardioid anyway.
//
// This is the poke: the envelope came back as ordinary material with ordinary
// columns, so it can be used to decide something about the drawing instead of
// being drawn.
export default sketch({ aspect: [1, 1], seed: 6 }, (t) => {
  const N = 220;
  const R = 44;
  const at = (k) => {
    const a = ((k % N) / N) * Math.PI * 2 - Math.PI / 2;
    return [t.cx + R * Math.cos(a), t.cy + R * Math.sin(a)];
  };
  const chords = t
    .times(N, (k) => {
      const [ax, ay] = at(k);
      const [bx, by] = at(2 * k);
      return connect.chain(material([{ x: ax, y: ay }, { x: bx, y: by }]));
    })
    .reduce((p, q) => append(p, q));

  // where each chord touches the curve nobody is drawing
  const touch = new Map();
  for (const p of chords.envelope().points) touch.set(p.member, [p.x, p.y]);

  const cut = t
    .times(N, (k) => {
      const stop = touch.get(k);
      if (!stop) return null;
      const [ax, ay] = at(k);
      return connect.chain(material([{ x: ax, y: ay }, { x: stop[0], y: stop[1] }]));
    })
    .filter(Boolean)
    .reduce((p, q) => append(p, q));

  return [strokes(cut), circle(t.cx, t.cy, R, { pen: 'stabilo-88-blue' })];
});
```

### Straight steel, curved tower

```ts live paper=180x120
import { sketch, append, material, connect, pen, mm } from 'occlude';
import { polyline, circle as ring3, plane, revolve, mapSurface, view, perspective, style } from 'occlude/3d';

// A cooling tower, and the drawing it was made from, lying on the floor under
// it.
//
// Every strut is STRAIGHT. The waist is not a strut and never was: it is the
// curve all of them are tangent to, which is what makes a hyperboloid
// buildable out of straight steel. The same fact drawn twice — once as the
// object, once as the construction on the floor, where the family is the
// struts' shadow and the blue curve is `envelope` of it.
//
// The tower is a skin ruled by those same straight lines, so the struts on the
// far side are hidden and the floor drawing is cut where the tower stands on
// it. The skin's waist is the envelope, again: r0 = R·cos(skew/2), and it sits
// a whisker inside the struts so that the steel reads as steel on a surface
// rather than fighting it for the same pixels.
export default sketch({ aspect: [3, 2], seed: 8, pens: {
  ink: pen({ width: mm(0.28), color: '#18202A' }),
  found: pen({ width: mm(0.32), color: '#1B4FA0' }),
} }, (t) => {
  const N = 34;
  const R = 1.15;
  const H = 1.5;
  const skew = Math.PI * 0.62;

  // the object: N straight struts between two rings, each turned by `skew`
  const struts = t.times(N, (k) => {
    const a = (k / N) * Math.PI * 2;
    const b = a + skew;
    return polyline([
      [R * Math.cos(a), R * Math.sin(a), -H],
      [R * Math.cos(b), R * Math.sin(b), H],
    ]);
  });
  const rims = [ring3(R).translate([0, 0, -H]), ring3(R).translate([0, 0, H])];

  // the surface those straight struts rule. Its waist is r0 = R·cos(skew/2) —
  // the same circle the floor drawing found as an envelope — and it is here to
  // do the hiding: without it the far struts would show through, because a
  // curve occludes nothing.
  const r0 = R * Math.cos(skew / 2);
  const skin = revolve(
    polyline(t.times(41, (k) => {
      const z = -H + (2 * H * k) / 40;
      return [Math.sqrt(r0 * r0 + (z / H) ** 2 * (R * R - r0 * r0)), 0, z];
    })),
    { segments: 72 },
  ).scale(0.994).style({ creaseAngle: 180 });

  // the construction, in the floor's chart: the same family seen from above,
  // which is a set of chords of a circle
  const chords = t
    .times(N * 2, (k) => {
      const a = (k / (N * 2)) * Math.PI * 2;
      const b = a + skew;
      return connect.chain(
        material([
          { x: 0.17 + 0.215 * Math.cos(a), y: 0.63 + 0.215 * Math.sin(a) },
          { x: 0.17 + 0.215 * Math.cos(b), y: 0.63 + 0.215 * Math.sin(b) },
        ]),
      );
    })
    .reduce((a, b) => append(a, b));
  const waist = chords.envelope();

  const floor = plane(5.4).translate([0, 0, -H]);

  return view(
    [
      floor,
      style(mapSurface(floor, chords), { stroke: 'ink' }),
      style(mapSurface(floor, waist), { stroke: 'found' }),
      skin,
      ...struts,
      ...rims,
    ],
    { camera: perspective({ eye: [3.1, -4.4, 1.9], target: [0, 0, -0.2], fovDegrees: 40 }), stroke: 'ink' },
  );
});
```
