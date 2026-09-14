# Exact submitted underside camera

The user's camera `eye=[3.487353363430086,5.051254890342219,-7.8269794305909635]`,
`target=[0,0,0.4]` reproduces missing bottom hatch bands in the previous runtime
(`0acbd61`). Earlier saved-camera checks did not cover this defect.
`before/source.ts` preserves the submitted sketch; `before/gpu/saved-view.png`
and `after/gpu/saved-view.png` show the ordinary Studio before and after.

The block bottom is z=-0.8; the tower bottom is z=-0.7999999999999999.
From below, the tower cannot hide the block's exposed bottom. Rounding both
surfaces into camera space reversed depth decisions: 38 bottom hatch segments
were incorrectly hidden in the submitted orthographic view, and 25 in its
perspective variant. Seven mesh-edge intervals were also wrong across the
four-camera check. CPU/GPU agreement alone had missed the geometry error.

The correction retains original world triangles and affine source points
through capture and camera clipping. CPU reference and uncertain GPU cuts
intersect consistent exact world-space shadow halfspaces, including the
near/far slab at the occluding surface hit. Binary64 input is represented
exactly with homogeneous integers; interval roots are ordered exactly and
rounded only at the numeric output boundary. Barycentric weights are normalized
homogeneously to keep supported strokes on their source surface. Definite GPU
work remains f32; this is not a claim of binary64 GPU execution. Submission
capture owns each repeated basis/volume once, preserving refinement cache reuse.
No model coordinates, saved cameras, shader layout or geometric epsilon changed.

Evidence:

- Seven unit regressions cover both projections, clipping, mirrored placement,
  exactly equal planes, and a one-ULP front/equal/behind negative control.
- The independent rational ray/box oracle compares all 96 edges and 1,685 hatch
  segments across four cameras. No differences remain in CPU or hardware GPU
  output. Every exposed block-bottom hatch segment is visible.
- Nine analytic probes in main Studio check GPU one-ULP ordering and sloped
  near-plane intersections. They use ordinary public mesh/polyline/view APIs.
- `ink/ray-oracle.json` independently checks the changed forest documentation
  drawing with exact rational Moller–Trumbore ray/triangle intersections:
  165 interval-interior samples on 80 changed features, 57 old mismatches,
  zero new mismatches. Only `three#16` has a deliberately updated ink hash;
  the other 238 stable examples are unchanged (two examples remain unstable).
- `trace-points.py` accounts for all remaining collapsed SVG paths (3/2/1/2).
  Each matches a positive microscopic visible interval from the independent
  oracle, projected onto the existing 0.005 mm source grid. These real gaps
  are retained, not silently erased. The GPU verifier reports those counts;
  full curve-oracle agreement supersedes its earlier blanket zero-path rule.
- Church before/after: 15,601 chains, 96,037 mm draw, 16,515 mm travel,
  381.0 minutes, bridge 0, Euler 15,593, coincident 18.1 mm.

`gates.json` records the complete build checks. `deployment.json` records the
served dev image, production-container identity checks and read-only demo-store
comparison. `served/`, `probes-served/`, `precision/` and `live/` contain the
final deployed browser checks. Hardware is NVIDIA Turing, nonfallback, via
Playwright and Chrome/Vulkan. The origin check uses localhost:5273; it does
not claim an authenticated check through Cloudflare Access.

Reproduction (repository root unless stated):

```sh
OCCLUDE_PAPER_FIXTURE="$PWD/development/3d/paper-world-depth/after" OCCLUDE_PAPER_ALL_CURVES=1 pnpm --filter occlude exec tsx tools/inspect-paper-box.ts
OCCLUDE_PAPER_FIXTURE=development/3d/paper-world-depth/after python3 development/3d/paper-box-oracle/oracle.py
node development/3d/paper-world-depth/compare-ink.mjs
python3 development/3d/paper-world-depth/check-ink.py
# In packages/occlude-studio, with DISPLAY=:93 and NVIDIA Vulkan available:
OCCLUDE_PAPER_FIXTURE=../../development/3d/paper-world-depth/after OCCLUDE_API_EVIDENCE=../../development/3d/paper-world-depth/served node tools/verify-paper-box-oracle.mjs
node tools/verify-world-depth.mjs
node tools/verify-three-live.mjs
# Back at repository root:
OCCLUDE_PAPER_GPU=development/3d/paper-world-depth/served python3 development/3d/paper-world-depth/trace-points.py
```

Large raw JSON is stored as `.json.gz`; use `gzip -dk path.json.gz` to restore
it for inspection. Generated comparison bundles are excluded. Historical
failed checks are retained separately, including the initial full-build
failure: its exhaustive index oracle omitted source provenance. Passing that
basis fixes the comparison without weakening its exact equality assertion.
