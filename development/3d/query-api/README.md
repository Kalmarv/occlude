# Prepared queries, reusable forces and target reuse

The public query facade prepares an owned mesh revision once. Scalar and batch
nearest/ray/segment queries preserve typed face information and distinguish
world distance from ray or segment t. Batch fields capture before awaiting;
all result rows retain their original source, including misses and point-contact
segments. Synchronous CPU batches and explicit execution-backed asynchronous
batches share the same result contract. Arbitrary JavaScript forces remain CPU
fields evaluated against each current frozen pass.

Eleven focused tests cover distance/t, bounds, typed face/source data, misses,
empty selections, zero-length segment contact, immutable target revisions,
async input capture, malformed result counts, execution expiry, camera commit,
frozen history, sided plane constraints and nearest projection versus containment.
GPU host tests cover cache hits, least-recently-used eviction, scratch reservation,
cancellation and exactly-once disposal of each allocation. The cache holds at
most four targets; target buffers and per-batch scratch share the query budget.
Targets larger than half that budget occupy the cache alone.

The Studio Playwright test renders the surface-queries live sketch. It checks
289 source rows, 120 ray misses and 193 bounded-nearest misses, identity retention,
non-unit ray distance/t, and typed face attributes. The served verifier checks
ray intersections and nearest distances against independent analytic formulas
for the bounded tilted plane. Both batches dispatch on the
NVIDIA GPU; the first uploads a 96-byte target and the second reuses it with zero
target upload. Model/query work does not rerun on camera commit, and portable
reopen preserves the output/camera. Deliberate number-to-string and
boolean-to-string probes both produce TS2322 in Monaco. Source evidence is in
`source/`; final served evidence is in `served/`.

The A4 capture has one quantized point from a real, fully visible 0.00030914 mm
hatch segment (`tiny-export.json`). It has the full [0,1] visibility interval;
this differs from the erroneous numerical visibility gaps fixed earlier. No
minimum-length suppression is added to hide legitimate small geometry.

The original live source used TypeScript non-null assertions that the headless
live-example adapter does not support. The example now uses ordinary nullish
access instead. This exposed a separate verification bug: docs:hashes --check
reported newly added examples without failing for their compile errors. It now
reports those failures and exits nonzero. A deliberately broken appended example
was rejected; the valid replacement passes. Only three#13 adds an ink baseline;
all 233 prior entries remain unchanged. All nine Docker gates pass (`gates.json`)
and fourteen served live examples pass (`scenes/report.json`).
Church routing stays at 15,601 chains, 96,037 mm draw, 16,515 mm travel, 381.0 min.

Reproduce main Studio checks:

```sh
DISPLAY=:93 OCCLUDE_API_EXAMPLE=queries \
OCCLUDE_API_EVIDENCE=../../development/3d/query-api/served \
pnpm --filter occlude-studio exec node tools/verify-mesh-api.mjs
```

This does not complete the redesign. Curves/profiles/sweep/revolve, M5 demo
migration, the remaining acceptance verification and detailed serialization,
upload, dispatch, readback and refinement timings remain open.
