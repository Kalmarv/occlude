# Analytical CPU/GPU precision fixtures

`packages/occlude/tools/precision-fixtures3.ts` defines 36 cases shared by CPU tests and a browser worker. Expected intervals are authored analytically, rather than copied from either classifier. Each case runs in orthographic and perspective projection. The hardware worker streams one candidate pair at a time, exercising union/refinement across batches, and checks interval count, endpoint parameters and physical paper-space endpoint error.

| Cases (each projection) | Concrete contract |
| --- | --- |
| Uniform scales 1e-9, 1, 1e9 | Scaling camera, geometry and clipping distances preserves the same hidden parameters and 100 mm paper mapping. |
| Translation by [1e12, -1e12, 1e12] | Moving camera and geometry together preserves intervals without large-origin cancellation changing the result for these exactly representable offsets. |
| Coincident triangles | Duplicate occluders have the same union as one; they do not create extra interval splits. |
| Coplanar distinct wire | A wire on another object's plane is not obscured by that plane. |
| Near-coplanar wire, front/behind | A depth difference of 1e-10 is resolved by geometric classification, not erased by the f32 representation or a visual tolerance. |
| Vertex tangent / projected edge contact | A single-point touch creates no positive hidden interval; a line behind a projected triangle edge retains its known nonzero interval. |
| Zero-length wire | Produces no feature and no invented interval. |
| Mirrored, nonuniform scaling | Scaling [-2, 3, 0.5] and matching wire coordinates preserves the analytical visibility despite reversed handedness. |
| Strong depth slope | Perspective depth changes from 1 to 20 along the wire; the hidden interval begins at 11/43. |
| Through-eye clipping | The source range clips to [1/3, 1] at the near plane. Hidden ranges are checked in that clipped feature's coordinates. |
| Near-plane triangle split | One input triangle becomes two clipped triangles, with analytical visibility retained across their artificial diagonal. |
| Thin occluder | A 1e-9 x-scale produces a positive hidden interval much smaller than a nib; it must not disappear. |
| Overlapping occluders | Overlapping shadow intervals form the exact known union. |
| Positive sub-nib gap | Two hidden intervals remain separate despite a visible parameter gap of 5e-9 (orthographic) or 1e-8 (perspective). |

The base triangle is `[-1,-1,-2], [1,-1,-2], [0,1,-2]`, with a wire from `[-2,0,-4]` to `[2,0,-4]`. At y=0 its orthographic shadow spans x=-0.5…0.5, hence parameters 0.375…0.625. Perspective doubles the shadow at depth 4, giving 0.25…0.75. Scaled, translated, duplicate and overlapping variants derive from these bounds. The strong-slope case solves `-3+6t >= -(1+19t)/4`, giving `t >= 11/43`. The near-plane-split perspective case has projected x/depth bounds -0.4…0.25 and therefore wire parameters 0.1…0.75.

CPU tests require endpoint agreement to 12 decimal places. Hardware tests require the exact interval count plus parameter error ≤1e-5 and paper endpoint error ≤0.005 mm on the explicit 100 mm frame. These are additional fixture measurements, not a proof for arbitrary coordinate magnitudes, cameras or geometry. Unrepresentable input details cannot be restored by normalization.

Run from the worktree root:

```sh
pnpm --filter occlude test test/three-precision.test.ts
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-precision.mjs
```

The Playwright driver invokes the bundled benchmark worker from `three.html`; this is a computation harness, not a substitute for main Studio UI verification. It requires a nonfallback hardware adapter. The application geometry/visibility implementation is unchanged by this slice.

Existing coverage remains relevant: `three-visibility.test.ts` provides independent ray checks, through-eye clipping and degenerate triangle volumes; `three-mesh.test.ts` checks shared edges/attributes, all-pairs versus indexed coverage, concave/unsupported topology, near-plane splitting, source-only/occluder-only surfaces, empty scenes and capacity errors. The Blender reference adds 177 independent ray samples and pinned vector comparisons. These sources together support the adversarial-case audit; cancellation and full interleaved-execution acceptance remain separate.

Served-build verification passed all 36 cases on NVIDIA Turing hardware using Chrome 145.0.7632.109. Maximum endpoint errors were 5.960464477539063e-08 in parameter space and 5.9604644775390625e-06 mm on paper. See [hardware report](precision/report.json). The isolated container build passed all `pnpm check` gates; WASM hash remained `8bf0034cb79606aa8d6c7293496a1b7e`.

The runtime still uses a fixed parameter tolerance. Deriving refinement tolerance from paper scale and nib width remains open in the requirements audit; these passing fixtures do not close that implementation requirement.
