# occlude

A TypeScript drawing library for pen plotters where **`fill` means fill**.
Filled shapes hide what is beneath them; the library computes the exact
visible strokes (painter's algorithm on vectors, cut at true intersection
parameters) and emits per-pen G-code. Spec: [`plan.md`](./plan.md).

```ts
import { sketch, pen, margin, circle, rect, line, hatch, stipple, mm, render } from 'occlude';

sketch({ aspect: [3, 2], seed: 'url' });
margin(5);
pen('pigma-005-black');

circle(50, 50, 20).fill(hatch(45, mm(1)));      // filled → occludes
circle(60, 50, 20).fill(stipple(0.3), 'stabilo-88-green');
rect(10, 10, 30, 30);                            // stroke only → does not occlude
line(0, 50, 100, 50);                            // cut exactly where fills cover it
```

## Layout

| Package | What it is |
|---|---|
| `crates/occlude-core` | Rust geometry core (→ wasm): intersection matrix, winding, clip, cull, fills, cleanup, SVG/G-code export |
| `packages/occlude` | The TS API: shapes, units, transforms, seeded randomness, recording, wasm bridge |
| `packages/occlude-studio` | Vite app: Monaco editor with live preview, pen library, paper/machine settings, export |

## Development

```sh
# prerequisites: rust (stable), wasm-pack, pnpm
pnpm run build:wasm         # build the wasm package (crates/occlude-core/pkg)
pnpm install

cargo test                  # core: unit + pipeline + property + golden tests
pnpm -r test                # TS API end-to-end tests (drive the real wasm)

cd packages/occlude-studio
pnpm dev                    # the studio, http://localhost:5173
```

Benchmarks (spec §7 targets):

```sh
cargo bench -p occlude-core --bench geometry
cargo run --release -p occlude-core --example profile5000   # 5000-shape render timing
cargo run --release -p occlude-core --example export_bench  # 50k-fragment export timing
```

Golden fixture regeneration (deliberate only):

```sh
UPDATE_GOLDEN=1 cargo test -p occlude-core --test golden
```

## How it works, briefly

- All input geometry is snapped to a 0.005 mm grid at record time, so shared
  edges are exactly coincident. Intersection results are never snapped.
- The sketch records; `render()` resolves units against the chosen paper,
  lowers everything to lines/arcs/cubics, and makes one wasm call.
- The core sorts by z, culls (bbox index, containment, off-paper), generates
  fills lazily for surviving shapes, then cuts every primitive against the
  opaque regions in front of it. Fragments shorter than the pen nib are the
  system's single tolerance: bridged or dropped by physical reasoning.
- Export merges fragments into chains, orders them (nearest-neighbour +
  2-opt), flattens adaptively, and emits grbl-flavoured G-code per pen.

## Known deviations from plan.md

- cubic–cubic intersection uses parameter-interval subdivision + 2D Newton
  polish (with an endpoint-projection fallback for near-coincident curves)
  rather than bezier fat-line clipping. Same contract, simpler failure modes;
  the subdivision fallback the spec called for is the primary path.
- Native builds parallelise layers 3–4 with rayon (spec's "shard by shape").
  The wasm build is single-threaded for now; web workers are the follow-up.
- The "200 noisy polylines over 500 shapes" target (<100 ms) measures ~109 ms
  on the dev machine; the other three §7 targets pass with margin.
