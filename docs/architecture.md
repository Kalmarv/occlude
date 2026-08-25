# occlude architecture

Companion to [`plan.md`](../plan.md) (the spec). This documents how the
implementation actually fits together and where each responsibility lives.

## The one-sentence model

The plotter is a canvas whose pixel is the pen nib: later opaque shapes
overwrite earlier ones, but the "framebuffer" is a list of vector fragments
and overwriting is done analytically — every cut lands at a true intersection
parameter on the original curve, and flattening happens only at export.

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
  cleanup               nib-width rules (bridge/delete), merge, seam dedupe
  fill                  hatch (global phase), Bridson stipple (seeded PCG32)
  index                 uniform grid; BVH when occluder sizes vary wildly
  pipeline              render(): the five layers, rayon-sharded by shape
  gcode                 chain merge → NN+2-opt tour → flatten → grbl G-code
  svg                   exact-curve SVG (arcs/cubics unflattened)
  snap                  the 0.005 mm input grid
  wasm_api              flat typed-array protocol, one call per render

packages/occlude/src/
  units, matrix         L values (percent/w/h/long/mm), affine transforms
  state                 the sketch singleton: record lists, pen library,
                        transform/clip stacks, seeded Rng
  shapes, fills         the user-facing recording API
  record                resolve → lower → transform → snap (paper known here)
  render                buffer encoding, the wasm call, fragment decoding
  draw                  Canvas 2D preview (exact arcs/cubics, no flattening)

packages/occlude-studio/src/
  editor                Monaco + occlude types as extra libs; emit via the
                        TS worker (CommonJS)
  runner                require-shim execution of the emitted sketch
  preview, panels       paper bench, pen tray, paper/machine, export
  store                 localStorage persistence
```

## The render pipeline (one wasm call)

1. **Record (TS)** — shapes hold unresolved units and transform-chain
   snapshots. `render(paper)` resolves units, lowers to lines/arcs/cubics,
   applies transforms (arcs → cubics only if non-conformal), snaps everything
   to the 0.005 mm grid, and encodes flat buffers (stride-9 f64 primitives,
   u32 shape/contour/fill tables).
2. **Cull (Rust)** — sort by z (draw index breaks ties), build a bbox index
   over opaque regions, drop shapes fully inside one later region or fully
   off paper, and mark shapes with no later overlap **clean** (they skip
   clipping entirely).
3. **Fills** — generated only for surviving shapes. Hatch offsets are
   multiples of spacing in paper space, so same-spec fills align across
   shapes. Stipple is deterministic from the sketch seed.
4. **Clip** — per primitive: query the index, then cut against occluders
   front-to-back, early-outing when nothing is left. A span partition of
   [0, 1] tracks visibility so cleanup can see hidden gaps. Clip regions
   (and the paper rect) apply first with polarity inverted.
5. **Cleanup** — pieces shorter than the pen nib: both neighbours visible →
   bridge, else delete. Merge same-origin runs. Drop coincident duplicate
   fragments from different shapes (shared snapped edges draw once).

Layers 3–4 are sharded by shape with rayon on native builds; generated fill
primitives carry provisional origins that a deterministic serial merge
rebases, so parallel output is bit-identical to serial. The wasm build runs
sequentially (web workers are the planned follow-up).

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
- **The nib is the only tolerance.** Sub-nib fragments are dropped or bridged
  because they physically render as dots; everything upstream is exact.

## WASM buffer protocol

Documented in `wasm_api.rs`. In short: primitives are stride-9 f64 rows
(`[kind, ...params]`), shapes are stride-10 u32 rows pointing into contour and
fill-param tables, and the result is the (extended) primitive table plus
stride-6 fragment rows `[origin, t0, t1, pen, shape, flags]`. Pens and machine
profiles cross the boundary as JSON.

## Studio persistence

Everything is `localStorage`, keyed `occlude.sketch`, `occlude.pens`,
`occlude.settings`; the sketch saves on every (debounced) run, including runs
that fail. The seed lives in the URL (`?seed=`), which is what makes "copy
url" shareable. Storage is per browser *and per origin* — `localhost:5173`
and `192.168.1.68:5173` are different origins with separate sketches.
