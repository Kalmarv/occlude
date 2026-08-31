# occlude

A TypeScript drawing library for pen plotters where **`fill` means fill**.
Filled shapes hide what is beneath them — the library computes the exact
visible strokes (painter's algorithm on vectors, cut at true intersection
parameters, in a Rust/WASM core) and emits per-pen G-code, SVG, and PNG.

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

Beyond the occlusion solve: an ordered **modifier stack** runs around it —
`smooth`, `roughen`, and `deform` reshape geometry *before* the solve (they
change what is hidden), while `dash`, `decimate`, and `wobble` distress the
surviving ink *after* it. Any scalar parameter can be a **field**
(`(x, y) => number`) that varies over the page. Everything is seeded and
deterministic: the same seed plots the same drawing.

Start with the [reference](docs/reference.md) — every feature as a live
example, with the full API prose at the bottom. The
[architecture notes](docs/architecture.md) cover the engine;
[`plan.md`](./plan.md) is the original design document.

## Layout

| Package | What it is |
|---|---|
| `crates/occlude-core` | Rust geometry core (→ wasm): intersections, winding, clip, cull, fills, the modifier interpreter, SVG/G-code/PNG export |
| `packages/occlude` | The TS API: the declarative surface, units, transforms, seeded randomness, fields, SVG import (`svg()`), image sampling (`image()`), wasm bridge |
| `packages/occlude-studio` | Browser studio: Monaco editor with live worker-rendered preview, animated plot simulation, pen library, asset store, per-pen export, and a full EBB/iDraw Web Serial driver (look-ahead planning, LM hardware ramps, quick-hop lifts, drift recovery, machine diagnostics) |

## Development

```sh
# prerequisites: rust (stable), wasm-pack, pnpm
pnpm run build:wasm         # build the wasm package (crates/occlude-core/pkg) — required before install
pnpm install

cargo test                  # core: unit + pipeline + property + golden tests
pnpm -r test                # TS end-to-end tests (drive the real wasm)
pnpm --filter occlude qa    # property-based seed sweep + adversarial corpus

cd packages/occlude-studio
pnpm dev                    # the studio, http://localhost:5173
pnpm build && node server.mjs   # production build, http://localhost:4173
```

Headless rendering:

```sh
pnpm --filter occlude render sketch.ts --seed 7 --paper A4 --out out.png
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
  bridged or dropped by physical reasoning.
- Export merges fragments into chains, orders them (nearest-neighbour +
  2-opt), bridges sub-nib gaps (plus opt-in `bridge` joining at artistic
  tolerances), flattens adaptively, and emits GRBL-flavoured G-code per pen
  — or plots directly over Web Serial.
- Native builds parallelise the clip layers with rayon; the wasm build is
  single-threaded.
