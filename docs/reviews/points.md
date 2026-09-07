# Points, cells and refinement: implementation notes

For the brief in working/points.md. One workflow, one vocabulary: points are material, cells are material, faces are navigable and measurable, the standard refinements are explicit operations, and their ingredients are public.

## Public surface

- `t.scatter(field?, { spacing })` returns point-only `Material` with one computed column, `density`: the field at each point, clamped 0…1. The material holds no field, spacing, bounds or stream. The `Points` class, `t.points`, `.relax()`, `.settle()`, `.cells()`, `.mesh()`, the `ScatterPoint` type and the pure `triangulate()` are removed.
- `t.relax(m, { iterations?, density?, bounds?, resolution? })`: Lloyd relaxation of any material's points within the bounds (default the drawable). Rows, edges and every column are kept; nothing is written.
- `t.settle(m, { density, spacing, iterations?, bounds?, resolution? })`: weighted Linde-Buzo-Gray settling of point-only material (connected input is refused with the way out named). Survivors keep their columns, children copy their parent's (duplicated, not shared out), removed points are gone, and `demand` is written: cell demand over one point's capacity.
- `t.voronoi(sites, { bounds? })` and the pure `voronoi(points, bounds)` return `Material`: corners as vertices, walls as edges, `faces()` as cells. The result answers `cellOf(site)` and `siteOf(face)`, ownership-checked, for the frozen result and its selections only; edited or extracted material throws a message saying to construct again. `connect.triangulate(sites).faces()` are the Delaunay triangles.
- `Faces` and `FaceSelection` gain `edges`, `points` and `boundaryEdges` (selections of the source material in row order) and `measure(field?, { resolution?, bounds? })`, which returns a `FaceMeasurements` with per-face `area`, `centroid`, `integral`, `mean`, `weightedCentroid`, `samples`, and an ownership-checked `forFace(face)`.
- `Material.faces()` is cached: a frozen state has one face collection, so a face from any call is accepted by every consumer of that material's faces.

## The three quantities

`density` (scatter): the field at the point. `demand` (settle): a cell's integrated density divided by the capacity of one point at the spacing, 1 for a full cell; it was the old `w` after settle, numerically unchanged. A face's mean density is `measure(field).mean`, `integral / area`. The old `w` meant the first after scatter and the second after settle; it is not carried forward under that name.

## Numerical evidence

- Scatter at seed 11 reproduces the pre-change positions and densities to nine decimals (fixture test/fixtures/points-baseline.json).
- Relax reproduces the old positions exactly (no randomness).
- Settle from a 12 × 12 grid reproduces the old point count and the sorted multiset of demands to six decimals. Split directions come from the sketch's seeded stream: the old `.settle()` continued the private stream the scatter had been drawing from, an accident of sharing one environment object; `t.settle` draws from the same named stream freshly, so the split directions after a scatter differ from before while the algorithm, thresholds, ordering and capacity are unchanged. This is the one contract change; positions of split children differ, counts and demands do not.
- The raster kernel behind settle and `faces().measure(field)` over Voronoi cells agree cell by cell to six decimals when given the same bounds and resolution (test), so the custom path measures what the standard recipe integrates.
- Voronoi: area of the faces equals the clipping rectangle to 1e-6 on random, collinear, near-coincident and clipped-away inputs; every wall borders one or two faces; cocircular sites collapse to one shared corner of degree 4; duplicate sites give one cell owned by the lowest row; a site outside the rectangle owns its clipped cell when any remains. Walls are never merged by rounding: an original endpoint keeps its exact coordinates (a recomputed `p + t·d` differed by one ulp and once produced a touching, which the planar check refused).
- Faces of a tree: the signed area of a walk is now summed over its simple cycles, so a walk that only retraces (a tree, a spur) is exactly zero. Before, the raw shoelace of such a walk left a residue of about 1e-13 that made a bounded face with no contours out of a branching network; the acceptance sketch below found it (three empty faces, nothing hatched). Regression test in faces.test.ts; no existing docs example changed ink.
- Face navigation: the shared wall of two squares is one edge; a hole's walls are boundary edges of the annulus until the hole's face is selected too; a spur attached to a face's boundary is that face's edge and never a boundary edge; a detached segment floating inside a face belongs to no face, because its walk encloses nothing. That last point is the current representation, documented on the Materials page.
- Measurements: an annulus has area 800 and centroid (15, 15); an off-centre hole shifts the centroid away from it; a constant density integrates to the area and its weighted centre is the centroid; a gradient moves the weighted centre; zero density and signed fields give no weighted centre; non-finite samples are absent.

## Cost (200 × 200 drawable, median of 3)

| Workload | Standard recipe | Custom path (voronoi + measure + move, one round) |
|---|---|---|
| flat, spacing 3, 2,759 points | settle 10 rounds 84 ms (8 ms/round); relax 10 rounds 57 ms | 157 ms |
| flat, spacing 1.5, 10,941 points | settle 10 rounds 231 ms | 399 ms |
| tonal, spacing 3, 1,598 points | settle 10 rounds 60 ms | 119 ms |
| tonal, spacing 1.5, 6,325 points | settle 10 rounds 140 ms | 262 ms |

Voronoi construction alone: 26 ms for 1.6k sites, 91 ms for 2.8k, 267 ms for 11k (5.5k to 22k walls). Measurement over those cells: 82 to 141 ms at resolution 256. One custom round costs about 15 to 20 standard rounds because it builds the full wall network and walks faces, which the kernel never needs; the public ingredients are for rules of your own, not a replacement for the recipe. Fifty settle rounds at spacing 1.5 take 777 ms; resolution 512 raises a ten-round settle from 231 to 296 ms.

## Migrated callers

Docs (Materials point distributions, faces section, three acceptance sketches; Gallery triangular mesh and circles in cells). In the sketches that draw a coloured boundary over a black network the boundary goes down first: ink on ink is dropped, so a boundary stroked after the network it shares walls with would vanish, the api, consolidation and faces tests, and bench/pbench.mts. The gallery's triangular mesh now draws faces in face-walk order rather than Delaunator's triangle order; the set of triangles is the same.

Stored sketches are not rewritten. They need:

| Sketch | Change |
|---|---|
| lbg-stipple.ts | `t.scatter(dark, { spacing }).settle(n)` becomes `t.settle(t.scatter(dark, { spacing }), { density: dark, spacing, iterations: n })`; `pts.map((p) => …)` becomes `pts.points.map(…)`; a dot sized by `p.w` reads `p.demand` |
| contours.ts, contours-2.ts, contours-3.ts, contours-2-multicolor.ts, contours-2-multicolor-3.ts | `t.scatter(density, { spacing }).map(…)` becomes `.points.map(…)`; a `p.w` after scatter reads `p.density` |

## Limitations

- Correspondence lives only on the frozen Voronoi result; no transfer through edits is implemented (invalidation is explicit).
- The inspector lists the result and the sites as materials; it does not draw the site ↔ cell relation.
- Clipping is to a rectangle. Measurement is a midpoint raster sum with the stated error; there is no adaptive integration.
- Face extraction remains unimplemented; face groups and selections stay areas.
