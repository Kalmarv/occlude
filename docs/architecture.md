# occlude architecture

This documents how the implementation actually fits together and where
each responsibility lives. The original design notes and the fills/fields
decision log live locally under `working/` (untracked).

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
  plan, fragment        chain merge → nearest-neighbour + 2-opt tour →
                        bridging: the ordered DrawingPlan and its bytes
  gcode, profile        G-code per pen from a plan range; machine profile
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
                        clips, modifiers; compileSketch records them. `origin`
                        is the pivot rotate and scale turn about (`'center'` is
                        the drawable's middle), threaded through composeChain as
                        T(o)·R·S·T(−o) and through the sketch-time conversions
  fillModule, fills     the fill contract (fillAsset, rulings) and resolution
  fills/*.ts            the built-in fill files (hatch, crosshatch, solid,
                        stipple) — ink-immutable, resolved from the package
  field                 Fields as augmented callables: rotate/translate/scale,
                        within (domain bounds), the vector-field rule
  record                resolve → lower → transform → snap (paper known here);
                        also the frame-less lowering within() uses
  render                scene encoding, the two-pass render, fill jobs,
                        fragment decoding, exports
  isolines, streamlines, sketch-time generators (marching squares, evenly
  points, distance      spaced streamlines, scatter/relax/settle, signed
                        distance); shaper: knot curves as functions
  material, relation,   the material vocabulary: vertices with attribute
  query, faces          columns and an edge list, steps and forces,
                        selections and extraction, spatial edge queries,
                        planarization and faces
  plan, motion          the DrawingPlan as a value (selection, resolveDraw,
                        encode/decode), estimatePlanMs and the motion model
  boundary, material    the area contract and the trim: `loopCrossings` finds
                        where an edge crosses a loop (the cut point is taken on
                        the boundary edge, so an axis-aligned frame's ends land
                        exactly on it), `withinMaterial` cuts the outside away
                        and carries each cut vertex's columns by their declared
                        policy; `within` on the toolkit dispatches a field, a
                        material, a point selection or a face collection
  draw                  Canvas 2D preview (exact arcs/cubics, no flattening)
  docsExamples          DOC_PAGES and the live-fence settings shared by the
                        docs site and the checker

packages/occlude-studio/
  server.mjs            production server: dist + the store APIs
  sketch-store.mjs      /api/sketches, pens, profiles, plot log (.ts files);
  sketch-git.mjs          every save a commit, forks and snapshots as refs
  result-store.mjs      /api/results — saved selections: plan bytes, frozen
                        SVG, pens, paper, profile, provenance; immutable
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
  src/drawing           the Drawing panel: reads the sketch's t.plan/t.draw
                        result; ghosts omitted ink in the preview only
  src/docs              the docs site: topic pages, inline editors, lazy
                        whole-drawable previews
  src/fillEmbed         export embedding + import reconciliation of fills
  src/store             localStorage persistence
```

## Build and verification

One toolchain, pinned in three files the tools read themselves:
`rust-toolchain.toml` (rustc 1.98.0 + the `wasm32-unknown-unknown` target,
honoured by rustup natively and in the image), `.node-version` (24.21.0)
and the root `package.json` `packageManager` field (pnpm 10.30.1). The
Dockerfile pins the rest: the `node:24.21.0-bookworm-slim` base image by
digest, wasm-pack 0.13.1 by release-tarball sha256, and the same three
versions as build args. To update: change the pin, rebuild, and let the
wasm gate tell you whether the crate's bytes moved (a compiler bump that
changes the wasm is an ink change to review, not a version bump to wave
through). The reference platform is linux/amd64; the build needs network
access to fetch crates, npm packages, rustup and wasm-pack.

The build order is the one the README gives a developer, because
`occlude-core` is a `link:` dependency on the wasm-pack output: crate
first, then `pnpm install --frozen-lockfile`, then the gates. The wasm is
built with the production feature set (`wasm,contour-sdf`, default
features off); a native `cargo test` runs with `parallel` on, so the two
are different builds of one source and the `wasm` gate is what ties the
bundle to the crate.

**Gate map** — `pnpm check` (`check.mjs`) prints one line per gate; the
Docker `verified` stage runs the identical command after building the wasm
from source, so the studio image exists only when every gate passed:

| gate | command | proves |
|---|---|---|
| rust | `cargo test -p occlude-core` | the engine's unit, property and golden-scene tests |
| ts | `pnpm -r test` | the library and studio vitest suites |
| types | `pnpm --filter occlude typecheck` | `src`, `tools` and `test` compile |
| studio | `pnpm --filter occlude-studio typecheck` | the studio compiles (vite only strips types) and `server.mjs` parses |
| docs | `docs:check` | every `ts live` fence on every topic page renders, with no ink outside the drawable |
| ink | `docs:hashes --check` | every fence renders the bytes in `test/fixtures/docs-ink.json` |
| build | `pnpm build` | the library emits declarations; the studio bundles |
| wasm | md5 in `check.mjs` | the bundled wasm is the crate's build, byte for byte |
| smoke | `pnpm smoke` | a sketch with an arc, a cubic, a contour-filled disc, a hatched rect and a mask renders through the compiled wasm to a parseable SVG (`tools/smoke.ts`); the production server, started on a free port, answers every page, module, worker and the wasm asset the bundles resolve, and the served wasm is the crate's (`tools/smoke-server.mjs`) |

Beyond the gates, the oracles a toolpath-affecting change consults by
hand: `plotstats church.ts --seed 42` (381.0 min, 16 515 travel mm at
0b661f7) and `renderhash --check` over the reference sketches.

**Reproducibility** here means a clean checkout with the pinned toolchain
produces a working build whose geometry is stable — the ink oracle and the
wasm gate are the proof. It does not mean byte-identical bundles: the
studio embeds a build stamp (commit + time) that the compose file passes
in as `OCCLUDE_BUILD_STAMP`, and the plan hash's `engine` field carries it,
so two builds of one commit agree on geometry and disagree on plan hashes
by design (compare geometry and settings separately when checking parity).

**Containers.** `docker-compose.yml` has two services: `studio`, the
verified dist behind `server.mjs` with the sketch, fill, asset and result
libraries bind-mounted from the checkout (one library, shared with a
native server), and `dev` (profile `dev`), vite over bind-mounted sources
from the same verified image — the seed of the eventual containerised dev
build. BuildKit cache mounts keep the cargo registry, the cargo target dir
and the pnpm store across builds, so a source change rebuilds only what
changed; `docker builder prune` returns to the cold path, which must still
pass. Nothing a developer's machine produced enters the context
(`.dockerignore`): no `pkg`, `node_modules`, `target`, `dist`, `.git` or
`working/`.

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

## Materials

`material.ts` holds vertices as typed columns (`x`, `y`, declared
attributes) plus an edge list with its own columns. Every operation
returns a new material; `steps()` freezes the current state, collects the
batch of edits described against `next` (moves, attribute writes, splits,
removals, connections, extensions), validates conflicts and ownership,
and publishes one new state, optionally recording history. Forces are
prepared per state (spatial index built once in `force.nearby`) and
evaluated per point. `relation.ts` is selections, extraction,
`connectedPoints`, `components` and `meanBy`; `query.ts` prepares a grid
over a state's edges for `nearest` and `firstHit` with a wide-box fallback
so long queries stay exact; `faces.ts` planarizes with Shewchuk's
`orient2d` for every orientation decision and reads bounded faces, face
selections and union boundaries. Attribute transfer (interpolate or
nearest for points, copy or distribute for edges) is declared per column
and honoured by split, resample, planarize and append.

## Plan and results

`plan(render(def))` runs merge → tour → bridge once in the core and
returns a `DrawingPlan`: chains with native primitives, the settings that
produced them, and a SHA-256 over both. Everything downstream is a range
of that value: `selectChains`, `selectProgress`, `selectTime` and
`fitDuration` pick one, `resolveDraw` is what `t.draw` goes through, and
`planSvg`, `planGcode` and `planToolpath` encode it. Selections never
re-plan or re-solve visibility. The studio's render worker returns the
plan bytes with every render; the Drawing panel reads the resolved range;
Export, Simulate, Plot and Frame take it; Save result writes the selected
chains as a plan of their own with the frozen SVG, pens, paper, profile
and provenance into the result store, and `/?result=<id>` reopens those
bytes without executing the source. `estimatePlanMs` is the one time
model for the panel, `plotstats`, the simulation and the driver.

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
- **The nib rule judges runs whole.** Clipping emits every visible piece;
  `judge_runs` groups a contour's or chain's pieces into connected runs
  (pen-down movements) and judges each whole — a sub-nib run is one tap
  candidate, resolved by exact coverage. Upstream tolerances are the input
  snap and curve flattening at export, both numerical policies rather
  than artistic ones.
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
fail. The seed rides the URL fragment (`#seed=…`, encoded, so a long seed
with its draw overrides survives the trip), which is what makes "copy url"
shareable; the studio hands it to the render worker, and the library itself
reads `?seed=` when it is the page.
