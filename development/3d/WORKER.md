# 3D worker ownership and verification

The construction worker now owns the GPU device, pipelines, bounded readback
buffers and OffscreenCanvas viewport. The host transfers the canvas once and
submits structured-cloned CPU snapshots. Only owned interval results and plain
adapter/measurement records return to the host. Paper SVG construction still
uses Occlude's existing host-side CPU pipeline in this laboratory.

The host rejects a superseded promise immediately. The worker retains only one
active lease and one latest pending request; it aborts the active request at the
existing upload/dispatch/readback/refinement boundaries. Submitted GPU commands
may finish. Both sides independently check request identity before adoption.
Geometry and camera revision values are captured with each submission.

Cancellation leaves the committed SVG exportable. Restart terminates/disposes the
old worker, replaces the transferred HTML canvas and starts a fresh worker.
Graceful disposal drains submitted work, then releases buffers/device; a three
second termination bound handles a hung worker. A lost session is replaced on a
subsequent request; loss does not silently rerun or adopt the failed request.

## Tests

Five CPU scheduling tests exercise burst coalescing, stale-ID cancellation,
uncooperative late GPU completions, disposal while a lease is outstanding,
synchronous failure followed by an immediate submission, and cancelled pending
requests. These tests deliberately control completion order.

The Playwright harness now checks that ordinary laboratory rendering makes zero
main-thread adapter requests. Its real-worker tests verify two superseded views,
input snapshot ownership, cancellation, invalid-input recovery and restart. It
also drives the visible Restart worker control and records the result. The
existing 128-pair CPU/GPU comparison, direct device-loss test and vector download
remain in the harness.

Hardware source-browser and production-bundle verification passed on NVIDIA/Turing
(Chrome 145). See playwright-worker/report.json and the three screenshots.
The Docker pnpm check passed Rust, TS, both typechecks, docs, unchanged ink,
build, WASM MD5 f74997a8bc946afc3bbaf4c26c313909 and smoke gates. No production
container was recreated; only the isolated occlude-3d-dev-1 service was updated.

The SwiftShader lane remains unverified: its worker reproduction reports
`Instance dropped in popErrorScope`. Retaining extra adapter/GPU references did
not fix the reproduction, so that experimental change was removed. This is an
explicit backend-hardening item; hardware evidence is not used to claim software
adapter correctness.

## Remaining integration

This worker serves the construction laboratory. The full Studio sketch worker
has not yet gained the asynchronous public scene API. Geometry revisions are
explicit metadata, not yet a claim of model/acceleration caching. M2 supplies the
mesh snapshot, conservative candidate index, classified graph and stroke stages;
M3 supplies editable procedural modeling; M4/M5 still have their original scope.

## Reproduce

From packages/occlude-studio with the isolated dev service running:

```sh
OCCLUDE_GPU_EVIDENCE=../../development/3d/playwright-worker xvfb-run -a node tools/verify-three.mjs
```

Use Playwright for future verification, as requested by the user. No ProofShot
session is required. The service remains on 0.0.0.0:5273 with bundled assets for
https://dev-occlude.ivyhq.xyz/three.html.
