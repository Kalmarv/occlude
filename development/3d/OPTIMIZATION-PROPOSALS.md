# 3D optimization proposals

Things measured on `perf/3d-visibility` that pay off but are **not** covered
by the optimization brief's mandate (no API change, no ink change), so they
are the owner's call rather than a commit. Each carries the numbers that
motivate it and what it would break.

## 1. Classify visibility on the CPU, keep the GPU for modeling and the viewport

### What

`three/resolve.ts:80` is the single decision point:

```ts
const result = options.compute3
  ? await options.compute3.classify(snapshot, {...})
  : classifySceneCpu3(snapshot);
```

The Studio always supplies a `compute3`, so it always takes the GPU branch.
The proposal is to let visibility classification use `classifySceneCpu3`
while `compute3` keeps doing GPU modeling (surface evaluation, tone) and
`preview3` keeps drawing the construction viewport.

### Why — measured, not argued

The GPU classifies each pair in f32 and hands every pair its f32 certificate
cannot settle back to the exact CPU refinement. On the woven-vessel that is
1,458,163 of 2,255,812 pairs (65%). So the GPU path pays the candidate
streaming, the packing, 276 dispatches and the readback, **and then still
pays roughly two thirds of the exact bill** — which is the bill this branch
just halved. The CPU path pays the exact bill once.

Measured on the served Studio, warm pass, wall ms from source edit to render
reply, all three columns on the same box and the same real adapter:

| workload | branch point | GPU classify (this branch) | CPU classify | vs GPU |
| --- | --- | --- | --- | --- |
| mapped-plane | 3430 | 3182 | 2942 | −8% |
| primitive-crosshatch | 15777 | 14855 | 13896 | −6% |
| custom-curvature | 5226 | 4767 | 4402 | −8% |
| intersection-assembly | 5167 | 4478 | 3386 | −24% |
| repeated-prototypes | 1074 | 954 | 834 | −13% |
| hatch-density | 30131 | 28443 | 25899 | −9% |
| **woven-vessel** | **watchdog, no reply** | 43662 | **18168** | **−58%** |

Visibility phase alone:

| workload | GPU classify | CPU classify | delta |
| --- | --- | --- | --- |
| mapped-plane | 755 | 386 | −49% |
| primitive-crosshatch | 3491 | 2456 | −30% |
| custom-curvature | 1031 | 674 | −35% |
| intersection-assembly | 1603 | 637 | −60% |
| repeated-prototypes | 216 | 121 | −44% |
| hatch-density | 7190 | 4581 | −36% |
| woven-vessel | 35402 | 9366 | −74% |

The CPU classifier wins on every workload, by 1.4x to 3.8x. Note that it wins
on `intersection-assembly` too, where only 19% of candidates are refined — so
this is not only a refinement-fraction story; the per-pair streaming, packing
and dispatch overhead is dominant on its own.

### What it would break

**It moves ink**, on some sketches. The GPU path accepts f32 interval
endpoints that survive `refinementTargets3` without exact re-evaluation,
clamped by `intervalTolerance3`; the CPU path evaluates every endpoint
exactly. They are therefore not the same answer, and three of the seven
workloads prove it (ink digests captured through the served Studio, same
inputs, only the classifier changed):

| workload | ink | stroke counts |
| --- | --- | --- |
| mapped-plane | unchanged | identical |
| primitive-crosshatch | unchanged | identical |
| custom-curvature | **changed** | identical |
| intersection-assembly | **changed** | identical |
| repeated-prototypes | **changed** | identical |
| hatch-density | unchanged | identical |
| woven-vessel | unchanged | identical |

Every workload keeps the *same number* of prims and frags; what moves is
interval endpoints, by less than the parameter tolerance (half the paper
budget, itself pen width / 20). So this is not a visible change of drawing —
it is the difference between the approximate answer and the exact one, and
the direction of travel is toward exactness, which is design law 1. But it is
an ink change, so it needs a deliberate re-save of
`packages/occlude/test/fixtures/docs-ink.json` with the reason in the commit,
exactly as the working agreements describe.

Other consequences:

- The GPU interval classifier (`compute/webgpu/interval.ts`,
  `intervalShader.ts`, and `classifySceneGpu3`) becomes dead weight on the
  Studio path. Either it is deleted, or it stays reachable and unexercised —
  and an unexercised backend that can disagree with the reference is a
  liability. This is the real decision, and it is an architecture call, not
  an optimization.
- Choosing between the two at runtime by predicted cost would be a mode flag
  whose options are only valid in some modes, which the ethos rejects. If the
  CPU classifier is the right answer, it should be the only answer.
- `refinementTargets3` and the watertight-abutment closing exist to repair
  f32 seams. With no f32 endpoints they have no work to do on this path.

### Recommendation

Take the measurement seriously before taking the change: the GPU classifier
is currently slower than the exact reference on every workload measured, and
the brief's own target (`woven-vessel` inside the 60 s watchdog) is met far
more comfortably by the CPU path — 18.2 s against 43.7 s.

Reproduce with `development/3d/optimization/ink-digest.mjs` for the ink and
`development/3d/benchmark-surface/gpu.mjs` for the timings; the experiment
was a four-line change in `packages/occlude-studio/src/render-worker.ts`
wrapping `GpuSceneCompute3` so that `classify` delegates to
`classifySceneCpu3` from `occlude/3d/advanced`, with everything else — GPU
modeling, GPU tone, `preview3` — untouched. It was never committed;
`optimization/ink-cpuclass.json` is its capture.

## 2. Cull occluders that cannot hide ink (not built; owner parked it 2026-09-15)

Candidate pairs are the cost of exact classification (2.26 M on the vessel
after the depth cutoff). Two exact reductions, neither built:

- **Back faces of closed objects.** For a watertight manifold a back-facing
  triangle never decides visibility: anything behind it is also behind the
  front face of the same solid. Dropping them roughly halves the occluder
  set on spheres, tori, boxes and capped sweeps. Condition: closed manifold,
  decidable per object from topology; open sheets keep both sides.
- **Outside the widened sheet.** Occluder triangles and features entirely
  outside the sheet plus one sheet diagonal (the hatch overscan rule in
  `three/curves/hatch.ts`) can neither hide nor leave ink. Scene-dependent;
  large for scenes that surround the camera.

Object-level occlusion culling (an object wholly behind another) was judged
rare and hard to make exact; not recommended. Measure the back-face share on
the seven workloads before building; the CPU-vs-GPU digest comparison is the
oracle.
