# occlude

A TypeScript studio for pen-plotter art, built around one idea: **the pen
is the medium, not a renderer of last resort**. On paper every stroke is
real ink — there is no painting over mistakes — so occlude makes `fill`
mean *occlude*: filled shapes hide what lies beneath them, and the engine
computes the exact visible strokes (hidden-line removal on true vectors,
in a Rust/WASM core) instead of simulating a canvas.

A sketch is a pure function from a toolkit to a tree of shapes:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8 }, ({ circle, line, hatch, times, rnd }) => [
  times(24, (k, t) => line(0, t * 100, 100, t * 100)),        // cut exactly where fills cover
  times(12, () => circle(rnd(100), rnd(100), rnd(6, 18), {
    fill: hatch(rnd(180), mm(1)),                              // filled → occludes
  })),
]);
```

## What separates it from other drawing libraries

Creative-coding libraries (p5, paper.js, canvas-sketch) think in pixels:
fill paints over what came before, and a plotter export is an
afterthought that draws every line, hidden or not. Plotter toolchains
(vpype, vsketch) optimise paths but leave the hidden-line problem to you.
Occlude is plotter-native end to end:

- **Fill means occlude.** The painter's algorithm runs on vectors, cut at
  true intersection parameters — what plots is exactly what a physical
  layering of opaque shapes would leave visible. `mask()` gives you
  hidden-line drawing (terrain ridges, overlapping forms) in one word.
- **The nib is the only tolerance.** Visible detail finer than the pen
  width rounds to a pen tap or to nothing, hidden gaps finer than the pen
  width are inked — physical reasoning, not epsilon tuning. Pens are real objects with
  width, feed, and settle time.
- **Line character is part of the model.** An ordered modifier stack runs
  *around* the occlusion solve: `smooth`/`roughen`/`deform` reshape
  geometry before it (changing what is hidden), `dash`/`decimate`/`wobble`
  distress the surviving ink after it, and any scalar parameter can be a
  field `(x, y) => number` that varies over the page.
- **Deterministic to the plot.** Every random value derives from the
  sketch seed — the same seed produces the same drawing on screen,
  in SVG, and on paper, every time.
- **Curves stay exact.** Arcs and béziers are never flattened until
  export; SVG output keeps true curves.
- **Plot time is a design dimension.** Chained tours, opt-in `bridge`
  joining (hatch rows serpentine into single strokes — hours off a dense
  plot), plot-time stats, and a full EBB/iDraw Web Serial driver with
  look-ahead motion planning, drift recovery, and machine diagnostics —
  the browser plots directly, no export round-trip required.

## Getting started

Prerequisites: rust (stable), [wasm-pack](https://rustwasm.github.io/wasm-pack/),
pnpm.

```sh
pnpm run build:wasm    # build the wasm core — required before install
pnpm install
cd packages/occlude-studio
pnpm dev               # the studio, http://localhost:5173
```

Write sketches in the studio's editor (Ctrl+S saves to the server-side
library); the preview re-renders live, the Plot panel drives an
EBB-family machine over Web Serial, and per-pen SVG/G-code/PNG export is
a click. The **docs** tab serves the [reference](docs/reference.md) —
every feature as a live example rendered by the real engine in your
browser, with the full API prose at the bottom. The
[architecture notes](docs/architecture.md) cover the engine;
[`plan.md`](./plan.md) is the original design document.

Headless rendering, for CI or batch work:

```sh
pnpm --filter occlude render sketch.ts --seed 7 --paper A4 --out out.png
pnpm --filter occlude plotstats sketch.ts --seed 7   # lifts, ink/travel mm, plot ETA
```

## Layout

| Package | What it is |
|---|---|
| `crates/occlude-core` | Rust geometry core (→ wasm): intersections, winding, clip, cull, fills, the modifier interpreter, SVG/G-code/PNG export |
| `packages/occlude` | The TS API: the declarative surface, units, transforms, seeded randomness, fields, SVG import (`svg()`), image sampling (`image()`), wasm bridge |
| `packages/occlude-studio` | Browser studio: Monaco editor with live worker-rendered preview, animated plot simulation, pen library, asset store, per-pen export, and a full EBB/iDraw Web Serial driver (look-ahead planning, LM hardware ramps, quick-hop lifts, drift recovery, machine diagnostics) |

## Development

```sh
cargo test                  # core: unit + pipeline + property + golden tests
pnpm -r test                # TS end-to-end tests (drive the real wasm)
pnpm --filter occlude qa    # property-based seed sweep + adversarial corpus
pnpm --filter occlude docs:check   # every reference example must render

cd packages/occlude-studio
pnpm build && node server.mjs   # production build, http://localhost:4173
```

Benchmarks and golden fixtures:

```sh
cargo bench -p occlude-core --bench geometry
cargo run --release -p occlude-core --example profile5000    # 5000-shape render timing
UPDATE_GOLDEN=1 cargo test -p occlude-core --test golden     # regenerate fixtures (deliberate only)
```

## How it works, briefly

- All input geometry is snapped to a 0.005 mm grid at record time, so shared
  edges are exactly coincident. Intersection results are never snapped.
- The sketch compiles to a recording; `render()` resolves units against the
  chosen paper, lowers everything to lines/arcs/cubics, and makes one wasm
  call. Curves stay exact until export.
- The core sorts by z, culls (bbox index, containment, off-paper), applies
  pre-stage modifiers to contours, generates fills lazily for surviving
  shapes, cuts every primitive against the opaque regions in front of it,
  then runs each shape's post-stage modifier program over the final ink.
  Fragments shorter than the pen nib are the system's single tolerance:
  bridged, tapped as dots, or dropped by physical reasoning.
- Export merges fragments into chains, orders them (nearest-neighbour +
  2-opt), bridges sub-nib gaps (plus opt-in `bridge` joining at artistic
  tolerances), flattens adaptively, and emits GRBL-flavoured G-code per pen
  — or plots directly over Web Serial.
- Native builds parallelise the clip layers with rayon; the wasm build is
  single-threaded.
