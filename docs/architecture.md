# occlude architecture

Companion to [`plan.md`](../plan.md) (the original spec) and
`fills-fields-spec.md` (the fills/fields redesign and its decision log).
This documents how the implementation actually fits together and where
each responsibility lives.

## The one-sentence model

The plotter is a canvas whose pixel is the pen nib: later opaque shapes
overwrite earlier ones, but the "framebuffer" is a list of vector fragments
and overwriting is done analytically — every cut lands at a true intersection
parameter on the original curve, and flattening happens only at export.

The engine's whole job is ink physics: **it decides what survives to paper,
never what gets drawn.** Patterns, textures, and scalar fields are
sketch-space JS.

## Where things live

```
crates/occlude-core/src/
  vec2, bbox            primitives of the primitives
  primitive             Line / Arc / Cubic: eval, split, bbox, normalise
                        (cusp splitting, colinear-cubic demotion)
  poly                  root finding: Cardano+Newton (cubics),
                        Bernstein subdivision (degree ≤ 6)
  intersect             the pair matrix; coincident overlaps return the other
                        primitive's endpoint projections as split points
  region                contours + winding rule; y-monotone ray casting with
                        a welded chain; O(1) circle fast path; on_boundary
  clip                  split/classify a span partition against one region
  cleanup               nib-width rules (tap/coverage), merge, seam dedupe
  fill                  FillKind (Pending / Custom / Mask) and SuppliedFill —
                        the engine generates NO patterns
  modifier              the modifier tape (pre/post stages) and field grids
  index                 uniform grid; BVH when occluder sizes vary wildly
  pipeline              prepare() → Prepared → finish(): the two passes,
                        rayon-sharded by shape on native
  synth                 synthetic supplied ink for benches, stress scenes and
                        property tests — benchmark input, never a fill
  scene::dump           loads a dump-scene directory (buffers + JS fills
                        sidecar) for replay and the golden test
  gcode, route, motion  chain merge → NN+2-opt tour → bridging → G-code /
                        EBB motion
  svg, raster           exact-curve SVG; PNG raster export
  snap                  the 0.005 mm input grid
  scene                 the buffer protocol (all strides documented at the top)
  wasm_api              thin bindgen wrappers: wasm_prepare / wasm_finish +
                        exports

packages/occlude/src/
  units, matrix         L values (percent/w/h/long/mm), affine transforms
  state                 the sketch singleton: record lists, pen library,
                        transform/clip stacks, seeded Rng, paper hint
  api, shapes           the declarative API: sketch(), shape values, groups,
                        clips, modifiers; compileSketch records them
  fillModule, fills     the fill contract (fillAsset, rulings) and resolution
  fills/*.ts            the built-in fill files (hatch, crosshatch, solid,
                        stipple) — ink-immutable, resolved from the package
  field                 Fields as augmented callables: rotate/translate/scale,
                        within (domain bounds), the vector-field rule
  record                resolve → lower → transform → snap (paper known here);
                        also the frame-less lowering within() uses
  render                scene encoding, the two-pass render, fill jobs,
                        fragment decoding, exports
  isolines, points,     sketch-time generators (marching squares, scatter/
  distance              relax/settle, signed distance)
  draw                  Canvas 2D preview (exact arcs/cubics, no flattening)

packages/occlude-studio/
  server.mjs            production server: dist + the store APIs
  sketch-store.mjs      /api/sketches, pens, profiles, plot log (.ts files)
  fill-store.mjs        /api/fills — the fill library (.ts files); /js strips
  fill-transpile.mjs      types with Node's built-in stripper (the ONE
                          transpile step for stored fills)
  asset-store.mjs       /api/assets — SVGs and images
  src/editor            Monaco + occlude types as extra libs; emit via the
                        TS worker (CommonJS) — the main thread never RUNS it
  src/render-worker     owns the whole sketch runtime: asset + fill preload,
  src/runner              sketch execution, encode, wasm, export state
  src/workerClient      coalescing render requests + the watchdog
  src/preview, panels   paper bench, sketch/fill libraries, pen tray,
                        paper/machine, plot, export
  src/fillEmbed         export embedding + import reconciliation of fills
  src/store             localStorage persistence
```

## The render pipeline (two wasm calls, one runtime)

Everything from sketch execution to the second wasm call happens in ONE
runtime — the studio's render worker, or node for the tools. The main
thread owns the editor only: it emits TypeScript to JS and posts source +
config; results come back as buffers plus decode metadata.

1. **Execute + record (JS)** — the emitted sketch module runs; `sketch()`
   values are recorded with unresolved units and transform-chain
   snapshots. Assets and custom fills the source references (literal
   names) are preloaded first.
2. **Encode (JS)** — `encodeScene` resolves units, lowers to
   lines/arcs/cubics, applies transforms (arcs → cubics only if
   non-conformal), snaps everything to the 0.005 mm grid, rasterises
   modifier fields, and builds flat buffers. Filled shapes get a **fill
   job** (a closure — the scene never crosses a thread) and
   `fill_kind = Pending`.
3. **Pass 1 (Rust, `wasm_prepare`)** — pre-stage modifiers (smooth /
   roughen / deform), sort by z (draw index breaks ties), build regions and
   the occluder index, drop shapes fully inside a later region or fully off
   paper, mark shapes with no later overlap **clean**. Returns a `Prepared`
   handle plus each surviving filled shape's FINAL outline.
4. **Fills (JS)** — each fill job runs against its post-deform outline:
   `fill('name', params)` resolves a fill module (built-ins from the
   package, custom ones from the registry the host filled), inline
   closures run as-is. Randomness is a seeded sub-stream keyed by draw
   order. Output is marks: lines/arcs/cubics/polylines/dots — encoded as
   **chains** (a polyline is one pen stroke) and dots.
5. **Pass 2 (Rust, `wasm_finish`)** — clip the supplied ink to its own
   region, then per primitive: query the index, cut against occluders
   front-to-back, early-outing when nothing is left; clip regions (and the
   paper rect) apply first with polarity inverted. The nib rule judges
   outline contours and fill chains WHOLE. Cleanup: sub-nib pieces become
   tap candidates that exact ink coverage resolves; merge same-origin
   runs; drop coincident duplicates (shared snapped edges draw once).
   Post-stage modifiers (decimate / wobble / dash), bridging, fragments.

A render is atomic: requests coalesce on the main thread while one runs;
the watchdog (a wedged worker) is the only hard interruption. Pass 2 is
sharded by shape with rayon on native builds; generated fill primitives
carry provisional origins that a deterministic serial merge rebases, so
parallel output is bit-identical to serial.

## Fields

A Field is an augmented callable: a plain `(x, y) => value` carrying its
transform and domain bound inside the closure, plus metadata the verbs
propagate (the unbounded twin to rasterise, the bounds to ship as
regions). `rotate`/`translate`/`scale` are explicit verbs (nothing is
ambient); vector fields rotate their arrows and never scale magnitudes.
`within(f, shape)` bounds the domain — absent outside — through the same
lowerer the shape inks with. Sketch-time consumers (isolines, scatter,
fills) call fields directly and exactly. Engine-consumed modifier params
become **field uses**: one raster per field (built over the union of its
uses' pulled-back footprints) plus, per use, a paper→field affine and
domain refs — `align: 'shape'` compiles A = G ∘ C into that affine, so a
thousand halftone dots share one grid, and `within()` bounds are exact
clip regions the engine tests before it samples.

## Robustness invariants worth knowing

- **Snap inputs, never results.** Input coordinates land on a 0.005 mm grid,
  so shared edges compare with `==`. Intersection t-values stay exact floats.
- **"On the boundary" classifies as outside.** A stroke lying exactly on an
  occluder edge stays visible; the resulting double-draw is what seam dedupe
  removes.
- **Half-open ray casting needs exact chains.** Curved contours are pre-cut
  into y-monotone pieces and the chain is *welded* (adjacent pieces forced to
  share bit-identical y at seams) because `sin(2π) ≠ sin(0)` in floats.
- **Roots on subdivision boundaries are checked explicitly.** A root exactly
  at a Bernstein split point is invisible to both children (endpoint touch,
  zero sign variations), so the splitter evaluates the split point itself.
- **The nib is the only tolerance.** Clipping emits every visible piece;
  `judge_runs` groups a contour's or chain's pieces into connected runs
  (pen-down movements) and judges each whole — a sub-nib run is one tap
  candidate, resolved by exact coverage. Everything upstream is exact.
- **Handles have owners.** `Prepared` is consumed by `finish`; the JS side
  frees it by hand only on the fill-throw path.
- **One fill truth, JS.** Rust knows no pattern: the golden renders a
  committed scene whose fills sidecar the product fill modules produced
  (regenerated by the JS-side sentinel test when a fill's ink changes on
  purpose); benches use synthetic lines and dots that are input, not
  product.

## WASM buffer protocol

Documented at the top of `scene.rs`, both directions. In short: primitives
are stride-9 f64 rows (`[kind, ...params]`); shapes are stride-12 u32 rows
pointing into contour, clip and modifier tables; pass 1 returns fill jobs
(`[shape, contour_start, contour_count]` over contour/prim tables); pass 2
takes supplied ink (`fills_index` stride 5 over `fill_chains` stride 2 over
stride-9 prims, plus dot pairs) and returns the extended primitive table
plus stride-6 fragment rows `[origin, t0, t1, pen, shape, flags]`. Pens
and machine profiles cross the boundary as JSON.

## Studio persistence

Sketches, fills, pens, machine profiles, assets, and the plot log live on
the studio server (plain files under `sketches/`, `fills/`, `assets/`),
shared by every browser that reaches it. `localStorage` holds the working
sketch (and a fill draft), the UI layout, and offline caches of pens and
profiles; the sketch saves on every (debounced) run, including runs that
fail. The seed lives in the URL (`?seed=`), which is what makes "copy url"
shareable.
