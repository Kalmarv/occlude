# occlude — spec v0.2

A TypeScript drawing library for pen plotters where `fill` means fill. Filled shapes hide what is beneath them; the library computes the exact visible strokes and emits per-pen G-code.

## Goals

- p5-like ergonomics with modern TS conventions: terse, positional, module-level functions, no global mutable state leaking into user code.
- Correct hidden-line removal across shapes, fills, and pens, in draw order.
- Exact geometry. Cuts happen at true intersection parameters on the original curves. Flatten only at export.
- Fast enough for thousands of filled shapes in a live preview. Geometry core in Rust/WASM.
- Paper-independent sketches. Coordinates are relative; paper and pens are chosen in the UI.

## Non-goals (v1)

- Stroke occlusion. Strokes never hide anything; only fills do.
- Transparency / alpha. Everything is opaque or nothing.
- Merging adjacent same-pen fills into one region (needs polygon boolean; punted).
- Text.
- Plotter serial bridge and live plotting (v2).
- Editing shapes after the sketch has run. Re-run the sketch instead.

## Decisions (resolved)

| Question | Decision |
|---|---|
| Grid snap resolution | Fixed 0.005 mm at export scale. Revisit when machine profiles land. |
| `.fill()` on an open path | Throws. Fill requires a closed region. |
| Hatch spacing unit | Fixed mm. Default 3× current pen width. |
| Occluder definition | The fill region only. Stroke width does not dilate it. |
| Execution model | Deferred. Sketch records; `render()` does all geometry. |
| Stacking | Draw order, overridable per shape with `.z(n)`. |
| Cross-pen occlusion | Always. Pen is a label on fragments, ignored by clipping. |

## Assumptions

- pnpm, Vite, Vitest, wasm-pack, Criterion for Rust benches, Monaco for the editor.
- Packages: `occlude-core` (Rust crate → wasm), `occlude` (TS API), `occlude-studio` (Vite app).
- Target firmware: grbl-flavoured G-code (G0/G1, pen via M3/M5 or Z). Machine limits configured in UI.

---

## 1. Mental model

Treat the plotter as a canvas whose pixel is the pen nib. Painter's algorithm applies: later opaque shapes overwrite earlier ones. The "framebuffer" is a list of vector fragments rather than pixels, and overwriting is done analytically by cutting fragments at exact intersection points.

Where the analogy holds:
- Detail below one nib width is not a line, it is a dot. Fragments shorter than the nib are dropped. This is the system's single tolerance and it has a physical meaning.
- Fill is just ink generated inside a region, then subject to the same overwriting as everything else.

Where it breaks:
- A raster has no z-fighting; a vector buffer does. Coincident edges are resolved by snapping all input to a fixed grid so that "nearly equal" becomes "exactly equal".
- Overwriting is not O(1). Cost scales with how much geometry sits under the new shape. Hence deferral, culling, and indexing.

## 2. Coordinate system & units

- Default unit: **percent of the short side** of the canvas. `circle(50, 50, 20)` is centred with radius 20% of the short side.
- Tagged unit wrappers return a branded number resolved at render:
  - `w(n)` percent of width
  - `h(n)` percent of height
  - `long(n)` percent of long side
  - `mm(n)` real millimetres — for anything physical (hatch spacing, stipple spacing, min sizes)
- `sketch({ aspect })` fixes composition. `aspect: [3, 2] | 'square' | 'paper'` (`'paper'` = whatever paper is selected). Export letterboxes onto the chosen paper; the export dialog can override to stretch.
- `margin(n)`: percent inset. `w`, `h`, `grid`, and default coords measure inside the margin. Outside-margin coords are still allowed (bleed).
- Options: `origin: 'topLeft' | 'center'` (default `'topLeft'`), `yUp: boolean` (default `false`).
- Preview resolution is independent of sketch units. There is no `width`/`height` in pixels anywhere in user code.

### Snapping

All input geometry (endpoints and control points) is snapped to a 0.005 mm grid at record time, in paper space. Consequences:
- Shared edges between shapes compare with `==`, not epsilon.
- Intersection *results* (t-values, split points) are not snapped; they stay exact floats. Only user input is snapped.

## 3. API surface

```ts
import {
  sketch, pen, margin,
  circle, ellipse, rect, line, polygon, path,
  hatch, crosshatch, stipple,
  w, h, long, mm,
  rnd, pick, chance, prob, noise, map, norm, invert,
  push, clip, grid, noisyLine,
  render, exportGcode,
} from 'occlude';

sketch({ aspect: [3, 2], seed: 'url' });
margin(5);
pen('pigma-005-black');                       // current pen from library

circle(50, 50, 20).fill(hatch(45, mm(1)));    // filled → occludes
circle(60, 50, 20).fill(stipple(0.3), 'stabilo-green');
rect(10, 10, 30, 30);                         // stroke only → does not occlude
line(0, 50, 100, 50);
path().moveTo(10, 10).bezierTo(20, 0, 40, 0, 50, 10).arcTo(30, 30, 20).close().fill(hatch());

push({ translate: [x, y], rotate: deg, scale: s }, () => { ... });
clip(circle(50, 50, 40), () => { ... });      // everything inside is restricted to the region

const frags = render();                       // preview
const jobs  = exportGcode({ paper: 'A4', optimize: true });
```

### Shapes

All shape functions return a `Shape` and record it immediately. Positional args are the primary form; an object form exists for shapes with many options (`path`, `polygon`).

| Function | Signature |
|---|---|
| `circle` | `(x, y, r)` |
| `ellipse` | `(x, y, rx, ry, rotation?)` |
| `rect` | `(x, y, w, h, radius?)` |
| `line` | `(x1, y1, x2, y2)` |
| `polygon` | `(x, y, sides, r, rotation?)` or `(points: [x,y][])` |
| `path` | `()` → builder: `moveTo lineTo arcTo bezierTo quadTo close` |

Chainable methods (mutate in place, return the shape):
- `.fill(spec, pen?)` — makes the shape opaque. Pen defaults to the current pen. Throws on open paths.
- `.stroke(pen | false)` — outline pen; `false` for fill-only.
- `.pen(p)` — sets stroke and fill pen.
- `.z(n)` — explicit stacking override; default z is draw index.
- `.noStroke()` alias for `.stroke(false)`.

`push(transform, fn)` scopes a transform to the callback. No unbalanced push/pop possible. Nesting composes.

`clip(shape, fn)` restricts shapes created inside `fn` to the region. Implemented as the same clipping operation with polarity inverted. Clip regions do not occlude.

### Fills

`FillSpec = (region, ctx) => Primitive[]`. Built-ins:

| Fill | Signature | Notes |
|---|---|---|
| `hatch` | `(angle = 0, spacing = mm(3 × penWidth), offset = 0)` | Parallel lines |
| `crosshatch` | `(angles = [0, 90], spacing?, offset?)` | n hatch passes |
| `stipple` | `(density = 0.5, minDist = mm(2 × penWidth))` | Poisson-disk points, drawn as dots |

Fills are not designed to produce solid black. They are texture. Custom fills are plain functions and go through the normal occlusion path.

### Pens

Library persisted by the studio as JSON:

```json
{
  "name": "pigma-005-black",
  "width": 0.2,
  "color": "#111111",
  "feed": 3000,
  "penDown": 0,
  "penUp": 5,
  "penDelay": 100
}
```

- `pen(name)` sets the current pen. Throws if unknown so shared sketches fail loudly.
- `pen({ ...inline })` defines an ad-hoc pen for this sketch only.
- Pen is a label on every fragment. Occlusion ignores it. Export groups by pen.

### Random & noise

- `sketch({ seed })`: `'url'` reads `?seed=`, falls back to crypto random and logs the seed. A number or string is used directly.
- `rnd(n)` → `[0, n)`, `rnd(a, b)` → `[a, b)`, `rnd()` → `[0, 1)`.
- `pick(arr)`, `chance(p) → boolean`, `prob(p, fn, elseFn?)`.
- `noise(x, y?, z?)`: seeded simplex, same seed stream as `rnd`.
- `map(v, a, b, c, d)`, `norm(v, a, b)` → 0..1, `invert(v, max, min = 0)`.

### Layout helpers

- `grid({ cols, rows, gap? })` → `{ x, y, w, h, i, j }[]` inside the margin.
- `noisyLine(x1, y1, x2, y2, { points, scale, amplitude, offset })`.
- `polygon(x, y, sides, r)` is the `ngon`.

## 4. Geometry model

### Primitives

- **Line**: p0, p1
- **Arc**: centre, radius, start angle, sweep (signed)
- **Cubic**: p0, c0, c1, p1

Circles are two arcs. Ellipses, rounded rects, quads lower to arcs/cubics. Polygons and rects are lines. Quadratic beziers are elevated to cubics.

### Region

Closed contour list of primitives, plus:
- `winding: 'nonzero' | 'evenodd'` (default nonzero)
- `convex: bool` (computed at record time)
- `bbox`
- Multiple contours allowed (holes, compound paths).

### Fragment

One primitive, possibly a sub-range `[t0, t1]` of an original primitive, plus `penId` and `shapeId`. Fragments carry a reference to their origin so merging after clipping is exact.

### Core operations

**`intersect(subject, region) → t[]`**
Crossing parameters on the subject against every primitive in the region. Dispatch by type pair:

| Pair | Method |
|---|---|
| line–line | closed form |
| line–arc | closed form (quadratic) |
| arc–arc | closed form |
| line–cubic | cubic polynomial roots (Cardano + Newton polish) |
| arc–cubic | degree-6 polynomial root find |
| cubic–cubic | bezier clipping; bbox subdivision fallback when curves are near-coincident |

Post-process: sort, dedupe within epsilon (vertex hits produce a double root), drop t outside `[0, 1]`.

**`inside(point, region) → bool`**
Winding number by horizontal ray cast against region primitives, half-open edge rule (edge counts only if it spans the ray's y as `[y0, y1)`). Convex fast path: half-plane test against each edge. Ray-vs-arc and ray-vs-cubic are line–arc / line–cubic intersections.

**`split(primitive, t[]) → pieces`**
De Casteljau for cubics, parameter split for arcs and lines. Pieces are exact primitives, not polylines.

**`classify(pieces, region, keepInside) → pieces`**
Midpoint (t = 0.5 of each piece) → `inside`. Keep outside for occlusion, inside for clip. A point *on* the boundary classifies as outside.

**`cleanup(fragments, threshold)`**
1. Drop pieces shorter than `threshold` (default: nib width of that fragment's pen). Neighbour rule: both neighbours visible → bridge (merge across); both hidden → delete; mixed → delete.
2. Merge consecutive visible pieces from the same origin primitive into one fragment.
3. Drop near-duplicate overlapping fragments (double-drawn seams) where two fragments from different shapes are colinear/coincident within threshold.

### Edge cases handled by construction

| Case | Handling |
|---|---|
| Line through polygon vertex | Two roots at same t → dedupe |
| Ray cast through vertex or tangent | Half-open edge rule |
| Tangent / near-tangent | Produces zero-length or tiny piece → cleanup drops it → draws through |
| Coincident boundary | Snapping makes it exact; "on" = outside |
| No intersections | Always run midpoint test (fully inside / fully outside / encloses region) |
| Cubic cusps, loops, collapsed control points | Detect (zero derivative) and split at cusp before root finding; degenerate cubics demoted to lines |
| Near-coincident cubic–cubic | Bezier clipping non-convergence → subdivision fallback |
| Shape's own stroke vs own fill | Stroke is never clipped by its own shape |
| Holes / compound paths | Multi-contour regions with winding rule |
| Self-intersecting fill | Winding rule decides |
| Off-paper geometry | Paper rect is the outermost clip |

## 5. Render pipeline

Deferred. The sketch records; nothing is clipped until `render()`. Immediate-mode is API feel only. Draw index is the default z.

### Layer 1 — Record

- Flat typed arrays: `Float64Array` coords, primitive table (type, offset, count), shape table (primitive range, bbox, fill spec id, stroke pen, fill pen, z, convex flag, transform applied).
- Snap to grid at record time.
- bbox computed at record time.
- Single WASM call with the whole buffer. No per-shape FFI.

### Layer 2 — Cull

- Sort shapes by z.
- Bbox index over opaque regions. Uniform grid by default; BVH when size variance is high (few huge + many tiny).
- Drop shapes fully contained by a later opaque region. Cheap exact tests: circle-in-circle, rect-in-rect, convex-in-convex; general case via bbox then all-vertices-inside + no-edge-crossings.
- Drop shapes entirely off-paper (after margin/bleed rules).
- Mark shapes whose bbox overlaps no later opaque region as **clean**. Clean shapes skip clipping entirely and go straight to output. In most sketches this is the majority.

### Layer 3 — Fills

Generated lazily, only for surviving shapes, only within the visible bbox (shape bbox minus any fully-covering later region).

- **hatch**: for convex regions, emit chords already clipped to the region (closed-form line–region endpoints), no self-clip pass. For concave regions, generate spanning lines and clip to region. Prefilter occluders by projecting their bbox onto the hatch normal; only lines whose offset falls inside an occluder's projected range are tested against it.
- **crosshatch**: n hatch passes.
- **stipple**: Bridson Poisson-disk in visible bbox; each point is one `inside` test, no intersection. Emitted as zero-length fragments with a `dot` flag; export turns them into pen-down/pen-up.
- Fill density is in mm, so hatch count scales with paper size. Preview coarsens; export is exact.

### Layer 4 — Clip

For each stroke or fill primitive of a non-clean shape:
1. Query index for later opaque regions overlapping the primitive's bbox.
2. Sort front to back.
3. For each occluder: segment-level bbox prefilter (a 2000-vertex polyline against a circle tests only nearby segments), then `intersect`, `split`, `classify`.
4. Early-out when the subject is fully consumed.
5. Each primitive is visited exactly once. Fragments are never revisited by later shapes (that is the whole point of deferral).

Clip regions (`clip()`) apply first, with polarity inverted, then occluders.

### Layer 5 — Cleanup & output

- `cleanup` (§4).
- Output: fragment list with pen id, shape id, origin primitive, `[t0, t1]`. Preview draws this directly.

### Export

1. Merge fragments sharing endpoints (occlusion often splits a line and leaves both halves visible, sometimes as separate fragments from adjacent origins).
2. Group by pen.
3. Tour per pen: grid-accelerated nearest-neighbour, then 2-opt with a time budget. Consider reversing fragments to reduce pen-up travel.
4. Flatten arcs/cubics adaptively: tolerance = min(machine resolution, nib / 4). Arcs may emit G2/G3 if the profile supports it.
5. G-code per pen: header (units, absolute, feed), pen up, travel, pen down, draw, pen up, footer. Dots: pen down, delay, pen up.

Preview mode: coarser hatch/stipple, no tour, no flatten (Canvas 2D draws arcs and cubics natively). Same code, different tolerance parameters.

### Parallelism

After culling, shapes are independent. Layers 3–4 shard by shape across web workers (or wasm threads if available). Render always runs off the main thread.

## 6. Studio

- **Editor**: Monaco, TS with `occlude` types loaded for completion. Live re-run on change (debounced ~150 ms), errors surfaced inline and in a status bar. Sketch source persisted locally; import/export as `.ts`.
- **Preview**: Canvas 2D. Renders fragments with real pen width and colour on a paper-coloured background at the selected paper size and aspect. Pan/zoom.
- **Debug toggle**: hidden fragments ghosted, occluder outlines, shape bboxes, fragment endpoints as dots, clean/culled shapes tinted, per-layer timings.
- **Pens panel**: CRUD on the pen library, persisted locally, import/export JSON. Selecting a pen previews its stroke.
- **Paper & machine panel**: paper presets (A-series, Letter, custom), orientation, margin default, machine profile (bed size, feed limits, pen up/down commands).
- **Export panel**: per-pen G-code download, SVG download (all pens or per pen), fragment count and estimated plot time per pen.
- Seed controls: show current seed, re-roll, copy shareable URL.

## 7. Performance targets

| Scenario | Target |
|---|---|
| 500 filled circles, hatch | render < 20 ms |
| 5,000 filled shapes, hatch | render < 200 ms |
| 200 noisy polylines (2k vertices) over 500 shapes | render < 100 ms |
| 50k fragments | export incl. tour < 2 s |

Benchmark suite with synthetic stress sketches, one per layer:
- dense circle field (cull, hatch)
- long noisy polylines crossing many shapes (segment prefilter)
- cubic-heavy blobs overlapping (cubic–cubic)
- fine stipple under partial occluders (point classify)
- everything buried under one big shape (containment cull)
- few huge + thousands tiny (index choice)

Micro-benchmarks per intersection pair and per `inside` variant.

## 8. Tests

- Unit: every intersection pair, including vertex hits, exact tangents, near-tangents at multiple scales, coincident edges, cusps, loops, degenerate cubics.
- Property (proptest): random shapes and occluders, assert:
  - no output fragment midpoint lies inside a later opaque region
  - no fragment shorter than threshold
  - total visible length is non-increasing as occluders are added
  - result is invariant to shape-list order when z is fixed
- Golden: fixed-seed sketches rendered to SVG and diffed.
- Fuzz: random near-degenerate inputs must never panic or produce NaN.

## 9. Milestones

1. **Core**: primitives, intersection matrix, winding, split/classify/cleanup, benches, proptests, fuzz. SVG out. No TS.
2. **API**: TS surface, recording, snapping, deferred render, index, cull, hatch. Vite playground, no editor.
3. **Studio**: Monaco editor, live preview with pens, debug view, pen library, paper settings.
4. **Fills & export**: stipple, crosshatch, clip(), tour, flatten, per-pen G-code, SVG export.
5. **v2**: serial bridge (Node, WebSocket), live plotting, machine profiles from `$$`, pen-change prompts.
