# thicken numerical-core replacement

11 September 2026. Baseline: `c458786` (geometry unchanged from `01745ac`).

The previous core combined rounded endpoint lines with analytical disc tangents
and used exact equality of those rounded points as junction identity. This
replacement keeps one analytical construction through intersection, event
identity, domain checking, ordering and classification. It does not weld nearby
points, flatten contributions before their union, or reinterpret `tolerance` as
a grid size.

## Implementation

`algebraic.ts` is an internal, filtered real-arithmetic arena. Inputs are their
exact binary64 dyadic values. Binary64 interval filters are followed by 96/192-bit
integer interval filters, then an exact tower of quadratic extensions. The exact
sign algorithm reduces `a + b√r` to lower-level signs; inversion checks zero norms
so dependent radicals are supported too. Precision exhaustion is never equality.
The subnormal export test specifically covers scaling-factor underflow.

`thicken-arrangement.ts` constructs authoritative unit-normal tangent supports
and endpoint circles. Intersections retain their algebraic roots; an event is
shared only after exact coordinate equality. Coincident intervals preserve their
owners. Lines use exact coordinate order; circles use half-plane/cross-product
order. No `atan2` value establishes incidence or interval order.

Open interval witnesses are certified to lie between adjacent events. Circle
witnesses use rational stereographic parameters, allowing the quadratic hull
membership classifier to stay rational. The boundary successor map must be a
permutation before traversal. Source candidates and their own edge parameters
survive coincident geometry; the existing callback tests remain.

Tessellation is last. Its rational circle samples have a bounded angular step.
When independently rounded coordinates would collapse distinct columns or rows,
export preserves their exact order using adjacent representable coordinates.
Displacements are checked against the export portion of the boundary tolerance.
The exported polygons are checked for orientation changes, crossings, unintended
contacts and overlapping intervals. An unresolved export or resource limit is an
explicit error, not an invented closing edge or discarded loop.

The public call remains `thicken(material, { radius, tolerance?, point? })`,
synchronous and immediately usable from a module import. There is no new WASM
initialization, public parameter, renderer coupling or protocol change. The
existing Rust/WASM renderer still consumes the resulting Material normally.

## Independent evidence

- A development-only adapter uses **CGAL 6.2.1 conic arrangements** and CORE
  algebraic arithmetic. Ten fixtures agree in vertex count, atomic interval
  count and exposed interval count, including tilted unequal-radius tangents,
  a zero-radius tip, containment, coincident supports, multi-way junctions,
  contacts, positive sub-ULP overlap and the reported mixed-support family.
- The CGAL adapter itself fails on extreme near-containment
  `0 0 1 0 1 1.9999999999999998`. Both 5.6 and 6.2.1 were tested. This is recorded
  explicitly; it is **not** counted as a passing reference fixture or evidence
  that CGAL is a drop-in production backend. The production case has its own
  analytically known cap and independent integer-membership checks.
- An independent test oracle decodes input bits itself and evaluates the
  quadratic envelope minimum with BigInt integers. It shares no production
  roots, predicates or crossing tables.
- All ten reported A/B combinations pass: depth 1 with radii 1–5 and depth 3
  with radii 0.1–1, on 100, 200, 210, 297 and 304.8 mm square papers. Tests use
  actual toolkit lowering and check the resulting Material against the oracle.
- The existing 800-case membership corpus remains. Added metamorphic checks
  cover exact dyadic subdivision, duplication, reversal, reflection and a
  representable-value sweep across tangency. Existing provenance, selections,
  narrow gaps, translated geometry and repeated-call tests also pass.

This is tested numerical software, not a claim of formal verification or a
promise that every finite mathematical arrangement fits in ordinary doubles.

## Measurements

Node 24.21.0 on Linux x86_64 under KVM, reporting an AMD Ryzen 5 3600 and eight
vCPUs. One warmup followed by three samples; default tolerance 0.05. These are
geometry-call timings, **not plot ETA**.

| Input | Before median | After median / slowest | Result vertices / loops |
|---|---:|---:|---:|
| One variable-radius capsule | 0.48 ms | 4.15 / 5.35 ms | 37 / 1 |
| A, 100 mm, 100 edges | Open-end error | 218 / 240 ms | 752 / 30 |
| A, 304.8 mm, 100 edges | 12.50 ms; returned | 198 / 218 ms | 768 / 34 |
| B, 304.8 mm, 2,500 edges | Open-end error | 7,952 / 8,458 ms | 9,488 / 1,054 |

The exact core is materially slower on inputs the old implementation could
return. Correctness is the purpose of this replacement. The benchmark process
peaked at 1,223,916 KiB RSS across all warmups and samples; this is a process-wide
high-water mark, not an isolated per-call memory measurement. Large overlapping
inputs remain expensive. Allocation caches are bounded; deterministic guards
limit construction work to 20 million expression nodes and a single arc to one
million tessellation segments. There is no approximate fallback.

An instrumented B/100 mm run at tolerance 0.01 measured approximately 0.17 s
support construction, 4.66 s intersections, 0.36 s ordering/partitioning, 5.03 s
classification and 1.24 s export, totaling 11.46 s for 27,523 arrangement events,
48,002 atomic intervals and 6,565 exposed intervals. The candidate search uses
bounding boxes, but sweep overlap and exact arithmetic can still dominate.

Playwright rendered A/100 mm, A/304.8 mm and B/304.8 mm in Studio with status
`ok` and no browser errors. Observed cold page-to-render times were approximately
4.6, 4.5 and 13.0 seconds, including application loading and rendering.

Church's shared plotstats are unchanged: 15,601 chains, 96,037 mm ink,
16,515 mm travel, and 381.0 estimated minutes.

## Reproduction and release checks

See [the reference instructions](exact-reference/README.md), committed
[reference fixtures](exact-reference/fixtures.json), and
[raw benchmark results](exact-reference/benchmark-results.json).

```sh
pnpm --filter occlude exec vitest run test/thicken.test.ts test/thicken-exact.test.ts test/algebraic.test.ts
pnpm --filter occlude exec tsx bench/exact-reference/benchmark.mts
pnpm --filter occlude exec tsx bench/exact-reference/probe.mts 304.8 3 0.1 1
node packages/occlude/bench/exact-reference/studio.cjs
pnpm --filter occlude plotstats ../occlude-studio/sketches/church.ts --seed 42
pnpm check
```

`benchmark.mts --baseline <path>` accepts a baseline module saved beside
`src/thicken.ts`, so it shares the same Material class. The comparison above used
`git show c458786:packages/occlude/src/thicken.ts`; remove that temporary module
after the comparison. `studio.cjs` accepts `STUDIO_URL` and `EXPECTED_BUILD`.
It requires Playwright's Chromium and `playwright-core` in the environment.

The full repository check passes Rust, TypeScript tests, both typechecks, all
216 live examples, documentation ink, the production build and WASM MD5 parity.
Only `materials#37`, `materials#38` and `materials#39` ink goldens were deliberately
updated for the checked tessellation. The renderer WASM remains
`6af6e4baf4a9b095d8564e5cfe1941cf`.
