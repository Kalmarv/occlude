# Common mesh primitive expansion

Sphere, cylinder, cone and torus use the same immutable Mesh as plane, box and
raw imports. Pole and periodic seam points are shared; cylinder/cone caps share
their rim points with the sides. Caps are optional. Dimensions, resolutions,
non-pinched torus radii and total allocation budgets are validated explicitly.
There is no analytic surface retained behind the mesh: subdivision preserves
its piecewise polygon surface.

Four focused tests independently check edge incidence, oriented boundary
cancellation, Euler characteristic (2 for closed sphere/cylinder/cone, 0 for
torus), nondegenerate triangles, positive oriented volume, analytic vertex
loci, open cap boundaries, minimal resolutions and invalid/budget diagnostics.
The same attribute/subdivision/frozen-step workflow runs on each primitive
without mutating its input. Library typechecking passes.

All nine Docker `pnpm check` gates pass (`gates.json`). Only the two appended
live examples three#10 and three#11 add ink baselines; all 230 prior entries
remain identical. Church routing remains 15,601 chains, 96,037 mm draw,
16,515 mm travel and 381.0 minutes. The first build attempt failed fetching
Docker registry metadata (TLS timeout); the successful retry ran every gate.

Playwright uses Chrome with the NVIDIA Turing Vulkan/WebGPU adapter under
DISPLAY=:93. The catalog and full terrain acceptance sketch both render on
the source server; final served evidence is in `served/`. The terrain sketch
is now live in docs/three.md and its source remains in api-examples/terrain.ts.
No speedup claim is implied by shader time: the terrain still performs
substantial CPU refinement, as recorded in the report.

Reproduce against the served isolated dev origin:

```sh
DISPLAY=:93 OCCLUDE_GPU_EVIDENCE=../../development/3d/primitives-api/served \
pnpm --filter occlude-studio exec node tools/verify-scenes.mjs
```

This completes the four named mesh primitives, not the whole redesign.
Curves/profiles/sweep/revolve, shared instances, prepared queries/forces,
M5 demo migration and detailed GPU phase timings remain open.
