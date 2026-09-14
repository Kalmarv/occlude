# Shared supported-curve graph checkpoint

Parent: `e9e4e60` on isolated `feat/3d-webgpu`. This is a foundation checkpoint
within the complete `3dpt2.md` assignment, not completion of M6 or M7.

## Delivered code

- `geometry/exact.ts` extracts the original homogeneous world-depth arithmetic
  and adds canonical rational point encoding, correctly rounded evaluation,
  affine interpolation and exact triangle-incidence weights. JSON uses decimal
  integer strings; no rounded point is promoted to construction authority.
- `curves/network.ts` owns prototype/placement bindings and multi-source graphs.
  Source labels do not establish ownership. Segments require both endpoints to
  lie exactly in every declared support triangle. Isolated tangent contacts are
  supported nodes, not zero-length strokes. Branches and distinct exact points
  survive even when floating display coordinates coincide.
- Defaults bound sources (100000), nodes/segments (250000 each), support storage
  (1000000 conservative entries), encoded exact data (64000000 bytes) and input
  coordinate components (32768 bits). These are capacity limits, not claims of
  constant memory for arbitrary scenes. Binding triangles are lazy weak caches.
- Legacy section/paper-hatch inputs normalize to this same graph at capture.
  Their camera interpolation arithmetic and public generated-curve records stay
  compatible. A curve exempts its actual supporting triangles, not its complete
  planar face. The old section assertion now checks the exact support count.
- Scene capture resolves graph supports against actual captured object bindings.
  Missing, mismatched and ambiguous placements diagnose instead of selecting a
  same-label or same-prototype object. New feature kinds are intersection,
  mapped, trace and isoline. Exact source coordinates survive near/far clipping
  into the existing world-interval path. The current GPU certificate only covers
  binary source positions, so rational graph candidates explicitly refine on CPU.
- `SurfaceCurves` exposes points/edges as existing collections; extraction keeps
  the complete reference graph. `view` and ordinary `strokes` render the result.
  Unselected graph segments remain projected reference data, preserving phase
  and branch breaks without dispatching visibility for those unselected segments.
- Explicit `.rebind(mesh)` or `.rebind([meshA, meshB])` retains affine support,
  IDs, attributes and source parameters through unchanged authoring incidence.
  Mirrors remap source vertex identity. All supports at a shared node must still
  agree exactly; independent intersection-input motion requires regeneration.
  Old captures never change and no nearest-point projection occurs.
- Feature snapshots and classified scenes retain a single indexed graph registry;
  individual features store only graph/segment indices. Structured cloning and
  JSON therefore remain linear in geometry rather than repeating the complete
  network at each feature. Contact-only graphs are retained as well.
- Studio persistence records each canonical generated graph once, including its
  exact data and both-source provenance, alongside the existing committed plan.
- Placed surface locations now evaluate represented transformed vertices and
  their derivatives. Transforming an already interpolated model point could
  disagree at large translations; a 1e16 fixture distinguishes the two cases.

## Verification

Focused exact, network and renderer tests include rational thirds, subnormals,
actual two-source support, hidden portions caused by other faces on both source
objects, unrelated coplanar occluders, ambiguous placements, branch selection,
full source phase, ordinary view, mirrored rebind and separated-support rejection.
A Studio test checks rational multi-source JSON persistence.

Local full tests before the registry regression: 914 library tests / 91 files;
168 Studio tests / 22 files. The registry adds one library test (915 total).
The stable docs comparison preserves all 244 prior hashes; `three#24` is the only
addition. Existing two unstable examples remain marked unstable. The new live
example demonstrates the advanced carrier using a known exact seam; it does not
claim to implement a mesh-intersection generator.

Church after: 15601 chains / 96037 draw mm / 16515 travel mm / 381.0 min,
bridge 0 / Euler 15593 / coincident 18.1 mm, unchanged from the parent evidence.

All nine Docker gates pass on the final runtime code, including 915 library
and 168 Studio tests. All 25 live docs examples pass main Studio imports,
Monaco diagnostics, SVG generation and nonfallback NVIDIA execution. Screenshot
`live/example-24.png` was inspected; the two sheets and rust shared seam render.
Four rational-seam GPU probes match the independent `Fraction` ray/plane/slab
oracle exactly, including near clipping and a one-ULP raised occluder.

The initial rational probe assumed the raised clipped case was hidden over all
of [0,1]. It failed on a visible interval ending at 9.133536167931288e-15.
`rational-oracle.py` independently derives that exact cutoff as
121524004218727359/13305252421883396217392371810250 from the represented camera
and retained source terms. No renderer tolerance or suppression was added.
The failed initial expectation and corrected oracle results are both retained
in `rational/`; the corrected browser run compares complete intervals exactly.

Served stamp: `e9e4e60-supported-curves`; image:
`sha256:9ac77dcc5e3e589ec473bdb319f8e35c22e4d647b617d423c51c9ea90de6e17d`.
WASM remains `8bf0034cb79606aa8d6c7293496a1b7e`. No production or store writes.

All four paper-box cameras pass: 96 edges and 1685 supported curves, zero
interval error, full curve coverage. The report is compressed as
`paper/report.json.gz`. Existing tiny/zero-length SVG paths are recorded, not
blanket-suppressed. All nine additional world-depth probes pass.

```sh
OCCLUDE_BUILD_STAMP=e9e4e60-supported-curves docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
# From packages/occlude-studio:
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/supported-curves/live node --input-type=module < ../../development/3d/supported-curves/verify-live.mjs
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/supported-curves/rational node --input-type=module < ../../development/3d/supported-curves/verify-rational.mjs
DISPLAY=:93 OCCLUDE_PAPER_FIXTURE=../../development/3d/paper-world-depth/after OCCLUDE_API_EVIDENCE=../../development/3d/supported-curves/paper node tools/verify-paper-box-oracle.mjs
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/supported-curves/world-depth node tools/verify-world-depth.mjs
```

## Remaining assignment

Next: actual M6 spatial candidates and exact triangle contacts, contact-class
policy, coplanar-overlap boundaries without tessellation diagonals, exact graph
assembly/chaining, ordinary placement-bound inputs, cancellation and independent
geometry oracles. Source curve resampling/trimming and query/location consumers
still need implementation. Public graph construction here is advanced access,
not a substitute for ergonomic M6/M7 generators.

M7 primitive/custom coordinates, vector mappings, image bridge, generic tangent
tracing, curvature estimate, surface-aware spacing, tone/crosshatch/isolines and
useful GPU evaluation remain required. So do selected M8 region extrusion, docs
reordering, final Studio acceptance A–E workflows and six-workload performance
reports. Existing deferrals in the assignment are unchanged.
