# occlude

A TypeScript library and browser studio for pen-plotter drawings. A sketch is a function that returns shapes; the engine computes which strokes remain visible where shapes hide one another (hidden-line removal on exact vectors, in a Rust/WASM core), and the studio previews, exports and plots the result over Web Serial.

```ts
import { sketch, fill, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8 }, ({ circle, line, times, rnd }) => [
  times(24, (k, t) => line(0, t * 100, 100, t * 100)),        // cut exactly where the discs cover them
  times(12, () => circle(rnd(18, 82), rnd(18, 82), rnd(6, 18), {
    fill: fill('hatch', { angle: rnd(180), spacing: mm(1) }),  // a filled shape hides what lies beneath it
  })),
]);
```

## What it does

- Occlusion on vectors. A shape with a fill or `opaque: true` hides everything earlier in the tree under its area; cuts land at true intersection parameters, so the plot is what a physical layering of opaque shapes leaves visible. `mask()` is hidden-line drawing in one word. In the current version a fill always makes its shape opaque; a texture that does not hide is a planned option, not an existing one.
- The pen width decides what is drawable. Visible runs shorter than the nib become a pen tap or are dropped when a neighbour already covers them; hidden gaps shorter than the nib are inked through. Pens are objects with width, feed and settle time.
- Line character is part of the model. Modifiers run around the occlusion solve: `smooth`, `roughen` and `deform` reshape geometry before it, `dash`, `decimate` and `wobble` distress the surviving ink after it, and their parameters can be fields `(x, y) => number` that vary over the page.
- Reproducible geometry. Every random value comes from the sketch seed, so the same source and seed give the same drawing on screen and in every export. Physical plots vary by pen, paper and machine.
- Curves stay exact through the solve and the SVG export; they are flattened only for G-code and the machine.
- Materials: points with attributes, edges, selections, forces and stepped rules for growth, faces of a planar network, resampling. Plain data in, plain data out.
- Plot time as a design dimension: chained tours, opt-in `bridge` joining, one time estimator shared by export, simulation and the driver, and an EBB/iDraw Web Serial driver with look-ahead motion planning, drift recovery and calibration cards.

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
a click. The **docs** tab serves the topic pages under `docs/`
([Getting started](docs/getting-started.md), [Shapes & layout](docs/shapes.md),
[Fills](docs/fills.md), [Fields & variation](docs/fields.md),
[Materials](docs/materials.md), [Images & imports](docs/images.md),
[Plotting & saving](docs/plotting.md), [Gallery](docs/gallery.md)), every
example rendered live and editable in the browser. The
[architecture notes](docs/architecture.md) and [device notes](docs/device-notes.md)
cover the engine and the machine.

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
pnpm check                  # THE definition of done, one line per gate:
                            #   rust tests · TS tests · library typecheck (src
                            #   and tools) · studio typecheck · every docs
                            #   example renders · docs ink unchanged · build ·
                            #   wasm md5 match
pnpm -r test                # just the TS end-to-end tests (drive the real wasm)
pnpm --filter occlude qa    # property-based seed sweep + adversarial corpus
pnpm --filter occlude docs:check   # every docs example must render (DOCS_PAGE=fills for one page)
pnpm --filter occlude docs:hashes -- --check   # every example's ink vs test/fixtures/docs-ink.json
pnpm --filter occlude store-sweep  # do the studio's STORED sketches still build? (--migrate to
                                   #   compile them as tools/migrate-sketch-source.mjs would leave them)

cd packages/occlude-studio
pnpm build && node server.mjs   # production build, http://localhost:4173
```

A rebuild needs no restart: the server reads `dist` — and its `/api/version`
build id — per request. Restart only for `server.mjs` / `*-store.mjs` changes
(kill by PID; not `pkill`, which aborts the shell).

Benchmarks and golden fixtures:

```sh
cargo bench -p occlude-core --bench geometry
cargo run --release -p occlude-core --example profile5000    # 5000-shape render timing
UPDATE_GOLDEN=1 cargo test -p occlude-core --test golden     # regenerate fixtures (deliberate only)
```

## Credits & prior art

Occlude implements its own engine, but it stands on published work and
open projects. Where a license is copyleft, we used **ideas, protocol
facts, and papers — never code**:

| Project / work | What we took | License |
|---|---|---|
| [saxi](https://github.com/alexrudd2/saxi) | EBB `LM` rate math conventions (steps·2³¹/25kHz, ΔR derivation) verified against its source; formulas are EBB protocol facts. No code. | AGPL-3.0 |
| [EBB / EggBot](https://github.com/evil-mad/EggBot) (Evil Mad Scientist, Brian Schmalz) | The EBB command set our Web Serial driver speaks, via its protocol documentation. No code. | GPL-3.0 |
| [Marlin](https://github.com/MarlinFirmware/Marlin) & [Klipper](https://github.com/Klipper3d/klipper) | Motion-planning concepts: junction deviation, minimum cruise ratio, look-ahead structure. Ideas only. | GPL-3.0 |
| Deussen, Spicker et al., *Weighted Linde-Buzo-Gray Stippling* (SIGGRAPH Asia 2017); [reference impl](https://github.com/MarcSpicker/LindeBuzoGrayStippling) | `scatter(...).settle(n)` implements the paper's algorithm from the paper. No code from the LGPL reference. | paper / LGPL-3.0 |
| Bridson, *Fast Poisson Disk Sampling* (2007) | `scatter` and the stipple fill's blue-noise placement. | paper |
| Jobard & Lefer, *Creating Evenly-Spaced Streamlines of Arbitrary Density* (Eurographics 1997) | `t.streamlines` implements the paper's seeding and separation scheme, with the spacing as a field. Ideas from the paper only. | paper |
| [Cavalier Contours](https://github.com/jbuckmccready/cavalier_contours) | Pinned Rust dependency for line/arc region offsets in native contour fill. | MIT / Apache-2.0 |
| [CGAL](https://www.cgal.org/) | Independent, development-only conic-arrangement reference for `thicken`; not bundled or linked into the library. | Package-specific GPL/LGPL; external test dependency |
| [iOverlay](https://github.com/iShape-Rust/iOverlay) | Pinned Rust dependency for winding normalization and visible-area Boolean operations. | MIT / Apache-2.0 |
| [d3-delaunay](https://github.com/d3/d3-delaunay) (Mike Bostock) | Bundled dependency powering `voronoi`/`triangulate`/`settle`; his weighted-stippling notebook showed the `delaunay.find` accumulation walk. | ISC |
| [robust-predicates](https://github.com/mourner/robust-predicates) (Vladimir Agafonkin, after Shewchuk) | Bundled dependency: the exact `orient2d` predicate behind `planarize()`/`faces()` crossing and contact decisions. | Unlicense (public domain) |
| [commons-math-interpolation](https://github.com/chdh/commons-math-interpolation) (Christian d'Heureuse) | Bundled dependency: the Akima / cubic / linear interpolators behind `shaper()`. | MIT |
| [plotterbench](https://github.com/plotterbench) | Inverse-kinematics golden-test idea (backlog). Ideas only — PolyForm forbids code reuse. | PolyForm Shield |
| Robert Penner / [easings.net](https://easings.net) | The `ease.*` curve catalog (standard formulas). | formulas |
| [p5.js](https://p5js.org), [vpype](https://github.com/abey79/vpype) | API ergonomics and plotter-workflow inspiration, respectively. | — |

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
  Visible runs shorter than the pen nib are bridged, tapped as dots, or
  dropped by exact coverage.
- Planning merges fragments into chains, orders them (nearest-neighbour +
  2-opt), and bridges sub-nib gaps (plus opt-in `bridge` joining at artistic
  tolerances) into a `DrawingPlan` with a content hash. Exports and the
  machine encode ranges of that plan: exact-curve SVG, per-pen G-code, or
  a direct plot over Web Serial; saved results keep a selection's bytes.
- Native builds parallelise the clip layers with rayon; the wasm build is
  single-threaded.
