# Material-native geometry: public changes and migration

Implementation notes for the conversion brief (working/conversion.md). These are intentional public return-type changes; the generated ink is identical for every migrated example.

## Public changes

- `t.material(shape, { tolerance? })` is new: a shape's boundary as material with the boundary's own vertices (a rectangle's four corners, a regular polygon's vertices, a path's points), curved portions flattened at the tolerance (default 0.05 mm). Closed outlines become rings without a duplicate seam vertex, open ones chains, separate outlines separate components; nothing is welded. Sketch units, before drawing transforms.
- `t.sample` is unchanged in results and options; it now shares its boundary lowering with `t.material`.
- `t.polylines` is removed. Arrays are still reachable through `.curves().map((c) => c.pts)` on any material.
- `t.isolines(field, at, opts)` returns one `Material` for a scalar level or a level array: each contour a chain (a ring when closed), separate contours separate components, in level order then contour order, never joined. Every edge carries `level` as a categorical edge column (transfer `copy`); repeated levels keep their geometry, empty levels add nothing. The marching-squares kernel is untouched.
- `t.streamlines(field, opts)` returns one `Material` of open chains in the kernel's order, no columns.
- `polygon`, `distanceTo` and `force.boundary` share one boundary contract (`boundaryLoops` in boundary.ts): a loop, a list of loops, a contour record or a list of them (a face's contours), or a chain material. A closed chain is a loop, an open chain is closed with a chord as before, separate components are separate loops, isolated points contribute nothing, and a branching material is refused with the way out named (`selectEdges(…).extract()` or `planarize().faces()`). Coordinates pass through untouched; `polygon` keeps its `winding`, `distanceTo` keeps its sign and units.
- `Material.curves()` now returns chains in row order of their first vertex (a stable sort). Materials built from contours therefore draw in contour order whether a contour is open or closed; a single ring, a chain, and a tree with junctions are ordered exactly as before.

## Preserved output

Every docs example that used the changed functions was hashed (fragment geometry, pen and dot flag, in order) before and after. 25 of the 26 pre-existing hashes match after migration. The one that differs is the crossings example on Materials, where `strokes(net)` now draws the frame ring before the chords instead of after: forcing the old chain order reproduces the recorded before-hash exactly, and the order-insensitive hashes are identical, so the ink is unchanged and only the draw order moved. The two new examples (the hexagon's corners on Materials, level-selected contours on Fields & variation) are additions. The library suite passes (334) with new coverage in test/conversion.test.ts: exact corners and n-gon vertices, tolerance, transforms, rectMode and frame, open/closed subpaths without welding, sample unchanged, scalar and array levels with repeats and empties, level selection and copy-on-split, streamline order and editing, equivalent boundaries giving equal distance fields and polygons, holes, chord closure, isolated points, empty input, branching rejection, and a generated material inside a step rule with the boundary consumers.

## Cost

A dense case (40 levels at step 0.5 over a 200 × 100 drawable: 447 contours, 68,283 points): the kernel takes about 80 ms; building the material adds about 3 ms; `strokes(material)` costs about 32 ms more than stamping the contour records directly, because `curves()` builds adjacency and walks 68k vertices. Ordinary contour drawings are far smaller than this. No optimization was attempted here.

## Migration of repository callers

Docs (fields, shapes, materials), the tests, and the checker are migrated. Personal stored sketches under packages/occlude-studio/sketches are NOT rewritten; the following need a change before they run again:

| Sketch | Uses | Change |
|---|---|---|
| contours.ts, contours-2.ts, contours-3.ts, contours-2-multicolor.ts, contours-2-multicolor-3.ts | `isolines(f, levels, opts).map((cs, i) => polygon(cs.map((c) => c.pts), …))`, `distanceTo(t.polylines(center))` | one material: `const m = isolines(f, levels, opts); levels.map((lvl, i) => polygon(m.selectEdges((e) => e.attrs.level === lvl).extract(), …))`; `distanceTo(t.material(center))` |
| contour-portrait.ts, testing-fields.ts | `.isolines(field, at, opts).flat().map((c) => stroke(c))` | `strokes(t.isolines(field, at, opts))` |
| beach-house.ts | `isolines(…).map((c) => t.polygon(c.pts))` | `isolines(…).curves().map((c) => t.polygon(c))` |
| flow-user.ts, flow-portrait.ts | `.streamlines(…).map((c) => stroke(c, { decimate }))` | `strokes(t.streamlines(…), { decimate })` |

`polygon(m.selectEdges(...).extract())` is the per-level area; `.curves().map(polygon)` keeps one area per contour, which is what the old per-contour code did (opaque each, no holes between siblings).

`tools/migrate-sketch-source.mjs` (the store-wide rewrite from the 2026-09-06 renames) now also rewrites `t.polylines(x)` and `t.loops(x)` to `t.material(x).curves().map((c) => c.pts)`, an array-preserving form, so callers that expected arrays keep working without hand edits; `node tools/migrate-sketch-source.mjs < in.ts > out.ts`. The isolines and streamlines result-shape changes are not text-rewritable and stay in the table above.

Boundary detection decides by the first entry: a point (`[x, y]` or `{ x, y }`) means one loop, a loop (possibly empty) or a contour record means a list. A leading empty loop and nested loops of object points are covered by tests.

## Remaining friction

- `polygon(selection)` is not accepted; a selection needs `.extract()` first (or `.curves()`). Accepting anything with `curves()` would also admit selections; deferred so the contract stays "loops, contours, chain material".
- `t.isolines` of a level array in a sketch that wants one area per level still writes the selection by hand; a `byLevel()` convenience was not added, per the brief's rule against grouping frameworks.
- Points (`t.scatter`) and tessellations remain as they were (brief sections 10 and 11).
