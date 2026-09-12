# occlude

A creative coding library and browser studio for pen plotters. Build drawings from shapes, noise fields, images and editable geometry; turn them into ink with textures, contour fills and line modifiers. Preview at pen width, compare plot times, export, or send the same drawing to an EBB/iDraw plotter.

TypeScript is the sketchbook. A Rust/WASM engine handles visibility, native contour filling and the shared drawing plan.

```ts
import { sketch, circle, line, fill, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 42 }, (t) => [
  t.times(24, (_, u) => line(0, u * 100, 100, u * 100)),
  t.times(12, () => circle(t.rnd(18, 82), t.rnd(18, 82), t.rnd(6, 18), {
    fill: fill('contour', { spacing: mm(1.1) }),
  })),
]);
```

The discs hide the earlier lines; their contours follow the exposed boundaries. Ordinary coordinates are percentages of the drawable's shorter side. Use `mm()` for physical lengths such as fill spacing.

[Start drawing](docs/getting-started.md) · [Creative workshop](docs/workshop-01-marks.md) · [Gallery](docs/gallery.md) · [Studio guide](docs/studio.md)

## What you can make

- **Layered line drawings.** Filled shapes and `opaque: true` hide earlier ink. `mask(shape)` hides without drawing; clips constrain groups. Visibility uses line, arc and cubic intersections rather than a pixel mask. Currently, assigning a fill also makes a shape opaque.
- **Texture and solid ink.** Hatch, crosshatch, stipple, solid rulings, native contour fills and custom JavaScript patterns. Give outlines and fills different pens, or disable the outline with `stroke: false`.
- **Contour landscapes and grown structures.** Turn noise into isolines, trace fields with streamlines, scatter and settle points, build Voronoi cells, or extract faces from a network. Materials carry editable points, edges and attributes. Combine them with `append`, sample their boundaries, and use `thicken` to give paths width. Draw the result explicitly with `strokes` or `polygon`.
- **Line character.** Smooth, roughen and deform geometry before visibility; dash, decimate and wobble the resulting ink afterward. Fields let the effect vary across the page.
- **Image-driven marks.** Sample images for density, direction or colour, and use those values to place your own geometry. Import SVG as geometry for further composition.
- **A practical plotting workflow.** Live previews, editable pen libraries, per-pen exports, animated simulation, plot ETA and direct Web Serial plotting. Pen width informs tiny-mark cleanup. Routing and optional bridges reduce travel; export, simulation and the driver share one time estimator.

With a given build, the same sketch and seed produce the same ink. Physical results also depend on the pen, paper and machine.

## Contour fills

Contours follow the **final visible area**, including holes, masks and clips. The default spacing is 0.9 times the fill pen's width. Short connections reduce pen lifts, and local cleanup marks cover remnants where contours meet or disappear.

```ts
import { sketch, circle, mask, fill, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8 }, () => [
  circle(50, 50, 38, {
    stroke: false,
    fill: fill('contour', { spacing: mm(1.1), connectors: false }),
  }),
  mask(circle(57, 43, 17)),
]);
```

Use `connectors: false` for separate loops without transition lines. Necessary cleanup marks remain. Spacing wider than the nib creates an open texture; draft quality coarsens spacing. Finishing modifiers retain their normal semantics and can break continuity or move ink beyond the original boundary.

Contour filling can substantially reduce lifts on dense artwork, but fewer lifts do not always mean a faster plot. Use `plotstats` to compare your sketch. See [Fills](docs/fills.md) for live variations and limits, and the [illustrated contour explainer](packages/occlude-studio/public/contour-explained.html) for the geometry and measured comparisons. The explainer is available at `/contour-explained.html` in a running Studio.

## Run the studio

Prerequisites: Node.js, pnpm, stable Rust and [wasm-pack](https://rustwasm.github.io/wasm-pack/).

```sh
git clone https://github.com/Kalmarv/occlude.git
cd occlude
pnpm run build:wasm    # create the local WASM package before installing
pnpm install
pnpm --filter occlude-studio dev
```

Open **http://localhost:5173**. Write a sketch in the editor; the preview updates as you work. Ctrl+S saves to the server-side sketch library. The Docs tab includes live, editable examples, and the Plot panel connects to an EBB-family machine in a browser supporting Web Serial.

For a production build:

```sh
pnpm build
pnpm --filter occlude-studio serve   # http://localhost:4173
```

The production server serves the current `dist` files, so rebuilding the frontend does not require a server restart.

### Learn by making

| Explore | Documentation |
|---|---|
| Your first sketch, units and seeded variation | [Getting started](docs/getting-started.md) |
| Shapes, groups, transforms, masks and clips | [Shapes & layout](docs/shapes.md) |
| Patterns, contour variations and custom fills | [Fills](docs/fills.md) |
| Noise, isolines, sampling and flow | [Fields & variation](docs/fields.md) |
| Geometry, attributes, networks and growth | [Materials](docs/materials.md) |
| Image sampling and SVG geometry | [Images & imports](docs/images.md) |
| Pens, exports, simulation and the machine | [Plotting & saving](docs/plotting.md) |
| A sequence of creative exercises | [Workshop: start with marks](docs/workshop-01-marks.md) |

### Headless rendering and measurements

Run these commands from this checkout; sketch paths are relative to the `packages/occlude` package directory, or can be absolute.

```sh
pnpm --filter occlude render /path/to/sketch.ts --seed 7 --paper A4 --out out.png
pnpm --filter occlude plotstats /path/to/sketch.ts --seed 7
```

`plotstats` reports runs, ink length, pen-up travel and estimated plot time. For a 12 × 12 inch sheet, use `--paper 304.8x304.8`.

## Inside the engine

The sketch records shapes and modifiers. Rendering resolves units into paper space and lowers geometry to lines, arcs and cubics. Input geometry uses a 0.005 mm grid; intersection results are not snapped.

The Rust prepare pass applies pre-stage modifiers and resolves visibility information for surviving fill jobs. JavaScript patterns generate between passes; native contour geometry is generated in Rust from the visible-area Boolean result. The finish pass clips and judges ink, then applies finishing modifiers.

Native contours use a point/segment Voronoi diagram to construct distance levels and vector cleanup marks. Curve conversion has a bounded approximation budget; this is not a claim of exact cubic offsetting. The original visibility kernel remains available for validation. Existing JavaScript fills retain their generation path.

Planning preserves explicit contour runs, merges ordinary fragments, orders chains and applies permitted bridges. Preview, SVG, G-code, simulation and plotting consume the shared plan. SVG retains available curves; machine output approximates them with moves. Native builds can parallelise clipping with Rayon; browser WASM is single-threaded and rendering runs in a worker.

| Location | Responsibility |
|---|---|
| `packages/occlude` | TypeScript sketch API, materials, fields, units, imports, fill resolution and WASM bridge |
| `crates/occlude-core` | Rust/WASM visibility, native fills, modifiers, planning and exports |
| `packages/occlude-studio` | Editor, render worker, live docs, sketch and pen libraries, simulation and device driver |
| `docs` | Topic documentation, live examples, workshop and engineering notes |

See [Architecture](docs/architecture.md) and [Device notes](docs/device-notes.md) for more detail.

## Development

```sh
pnpm check                         # complete repository verification
pnpm -r test                       # library and Studio tests
pnpm --filter occlude qa            # property-based and adversarial geometry checks
pnpm --filter occlude docs:check    # render the live documentation examples
DOCS_PAGE=fills pnpm --filter occlude docs:check
pnpm --filter occlude docs:hashes -- --check
pnpm --filter occlude store-sweep   # compile stored Studio sketches
cargo bench -p occlude-core --bench geometry
cargo run --release -p occlude-core --example profile5000
```

`pnpm check` runs Rust and TypeScript tests, library and Studio typechecks, live docs rendering, the docs ink oracle, production builds and a bundled-WASM hash check. Rebuild WASM after Rust changes with `pnpm run build:wasm`. Golden ink changes should be deliberate and reviewed.

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
| [Boost Voronoi](https://docs.rs/boostvoronoi/0.12.1/boostvoronoi/) | Pinned Rust point/segment Voronoi dependency for analytic distance contours and vector residual cleanup. | BSL-1.0 |
| [Cavalier Contours](https://github.com/jbuckmccready/cavalier_contours) | Pinned Rust dependency for line/arc region offsets in native contour fill. | MIT / Apache-2.0 |
| [robust](https://github.com/georust/robust) | Adaptive orientation predicates for native contour cleanup partition validation. | MIT / Apache-2.0 |
| [Earcut](https://github.com/georust/earcut) | Triangulation of native contour-fill cleanup regions. | MIT / Apache-2.0; upstream Mapbox portions ISC |
| [CGAL](https://www.cgal.org/) | Independent, development-only conic-arrangement reference for `thicken`; not bundled or linked into the library. | Package-specific GPL/LGPL; external test dependency |
| [Javascript Clipper](https://github.com/junmer/clipper-lib) | Integer polygon union for bounded TypeScript `thicken()` | Boost Software License 1.0 (bundled JSBN: BSD) |
| [iOverlay](https://github.com/iShape-Rust/iOverlay) | Pinned Rust dependency for winding normalization, visible-area Booleans, nib sweeps and polygon offset recovery. | MIT / Apache-2.0 |
| [d3-delaunay](https://github.com/d3/d3-delaunay) (Mike Bostock) | Bundled dependency powering `voronoi`/`triangulate`/`settle`; his weighted-stippling notebook showed the `delaunay.find` accumulation walk. | ISC |
| [robust-predicates](https://github.com/mourner/robust-predicates) (Vladimir Agafonkin, after Shewchuk) | Bundled dependency: the exact `orient2d` predicate behind `planarize()`/`faces()` crossing and contact decisions. | Unlicense (public domain) |
| [commons-math-interpolation](https://github.com/chdh/commons-math-interpolation) (Christian d'Heureuse) | Bundled dependency: the Akima / cubic / linear interpolators behind `shaper()`. | MIT |
| [plotterbench](https://github.com/plotterbench) | Inverse-kinematics golden-test idea (backlog). Ideas only — PolyForm forbids code reuse. | PolyForm Shield |
| Robert Penner / [easings.net](https://easings.net) | The `ease.*` curve catalog (standard formulas). | formulas |
| [p5.js](https://p5js.org), [vpype](https://github.com/abey79/vpype) | API ergonomics and plotter-workflow inspiration, respectively. | — |
