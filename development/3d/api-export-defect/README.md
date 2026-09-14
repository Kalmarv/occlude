# Paper composition exported hatch regression

Reproduced from the dev sketch store with seed 42, Letter paper, the saved
`paper-study` camera and 0.25 mm graphite/rust pens in `paper-composition.ts`.
The actual SVG contained 45 zero-length round-cap paths, seven below y=210 mm.
These are visible nib-sized dots even though their geometric length is zero.

The CPU classification exposed positive visible intervals of about 1e-15 on
fully hidden box faces. Reconstructing an edge-attached curve endpoint in
camera coordinates rounded it slightly off its mesh edge. Exact predicates
then correctly classified the rounded point, but that point had lost its
source incidence. Passing the same rounded point to CPU refinement could not
repair the error.

The fix retains the source endpoint's affine terms through camera clipping
and evaluates halfspaces on those terms before rounding the point. Both CPU
classification and GPU uncertainty/cross-pair refinement use that source
representation. It adds no minimum stroke length or global epsilon and does
not change interval union or the 2D planner.

The independent convex-box oracle requires empty visible intervals on the
three rear faces for both projections. Separate negative controls preserve
real tiny endpoint gaps and positive/negative depth separation. Existing
clipped/mirrored hatch tests and 36 NVIDIA hardware precision cases also run.

The fixed exact-sketch hardware SVG has zero zero-length paths. The meaningful
CPU hatch lengths on the visible faces are unchanged to floating-point
precision; hidden-face emitted runs fall from 12/28/13 to zero. Deliberately
updated docs ink baselines are only `three#6` and `three#7`, the two hatch
examples affected by the corrected visibility. Church routing is unchanged:
15,601 chains, 96,037 mm draw, 16,515 mm travel, 381.0 minutes.

Reproduce with Playwright (NVIDIA/Xvfb environment):

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/capture-api-export.mjs
```

Use `OCCLUDE_GPU_URL` for a source server and `OCCLUDE_CAPTURE_PREFIX` for
additional captures. The capture checks the actual exported SVG, rather than
judging only the construction viewport or comparing CPU and GPU outputs.

Validation/deployment: the isolated Docker image passed every `pnpm check`
gate (see `gates.json`; full local log in `build.log`) and was deployed to port 5273. The served-build
Playwright/NVIDIA capture (`served-summary.json`) passes with 18,344 SVG bytes
and zero stray dot paths. The public tunnel redirects a fresh browser to
Cloudflare Access login, so the automated export check used the served origin.
Production container IDs/start times remained unchanged.
