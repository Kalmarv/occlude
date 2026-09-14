# Observable 3D execution phases

The CPU/GPU visibility, deformation and surface-query paths now report
`stats.timings`. Parent operations merge exclusive child phases without also
adding the child's wall duration. Capture/structured cloning, setup, queued
host work, packing, upload submission, command submission, readback wait/copy,
CPU refinement, candidate gathering, finalization and validation waits are
separate. Unattributed time remains visible. Shader timestamps remain separate
and non-additive. Full field definitions and a live example are in
[`docs/three.md`](../../../docs/three.md#measuring-3d-execution).

Scope is explicit: view totals run from feature/hatch realization through
classification; modeling totals run from toolkit input capture through result
and validation completion. Earlier mesh/view construction, final 2D finishing,
planning and worker messaging are outside those windows. The workload also
measures view construction and the CPU feature snapshot separately. No claim
is made to isolate physical PCIe transfer duration: writeBuffer measures host
submission; mapAsync waits for GPU work and transfer completion. Existing
narrower outer `wallMs` fields are preserved. Query/deform kernels have no shader
timestamp field; their absence does not mean zero GPU execution time.

[`MEASUREMENTS.md`](MEASUREMENTS.md) summarizes the final served sample. It was
run after all other verification browser processes finished. The two nearest
batches deliberately overlap in submission so queue time is exercised. Cold
host setup, cache misses/hits, zero-iteration deformation and an empty batch
are covered. The recorded reload starts a new worker; it is not a warm-device
render. The sample identifies CPU preparation costs and does not establish a
universal GPU speedup or performance ranking.

`workload.ts` is a reproducible advanced inspection sketch, not a published
store demo. It checks 289 points against analytic plane nearest/ray/segment
answers, twelve fixed GPU deformation passes, complete source-row identity,
GPU/CPU visibility interval agreement under the existing 1e-5 parameter policy,
and zero-work paths. The CPU comparison is an agreement check, not an independent
visibility oracle; existing visibility regressions and all prior ink baselines
remain in force. Modeling and scene reports must have finite, nonnegative
exclusive phases whose sum (including unattributed work) matches wall time.
A small floating-arithmetic allowance is used only in timing assertions.

The deterministic unit timing test uses an independent fake clock schedule to
check nested accounting without summing child wall time twice. CPU integration
checks phase boundaries and unchanged repeated SVG. Existing cancellation,
query-cache and visibility tests pass. No shader, geometric predicate,
precision threshold, transfer layout or plotting-time estimator changed.

Source and served main Studio Playwright runs use NVIDIA Vulkan and a
non-fallback WebGPU adapter. They verify actual queued/cached/empty batch
behavior, typed editor diagnostics, camera exploration preserving export,
commit without model rerun, and exact repeated ink despite different timing
values. `source/` and `served/` contain the reports, SVG and screenshots.
The served screenshot was visually inspected. `scenes/` records all nineteen
live examples passing; its expected empty-library/progress 404s are retained.

All nine Docker `pnpm check` gates pass (`gates.json`, local `build.log`). The
new live example is `three#18`; all 240 prior ink fixture entries are unchanged.
WASM md5 is `8bf0034cb79606aa8d6c7293496a1b7e`. Church seed 42 is unchanged
before/after: 15,601 chains, 96,037 draw mm, 16,515 travel mm, 381.0 min,
bridge 0, Euler 15,593, coincident 18.1 mm. The isolated dev build is deployed;
production container IDs remain unchanged. Public Cloudflare authentication
was not retested. The fresh paper bottom artifact and full requirement audit
remain open.

Reproduce from the isolated worktree root, with no other GPU verifier running:

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-phase-timings.mjs
```
