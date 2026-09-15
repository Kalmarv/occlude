# 3D performance pass — brief for the optimizing agent

You are optimizing the 3D pipeline of **occlude**, a plotter-native creative
coding library (TypeScript + Rust/WASM core, Studio web app). The 2D side has
already had its optimization pass; **work only on the 3D path** (everything
under `packages/occlude/src/three/`, `packages/occlude/src/compute/webgpu/`,
and the 3D parts of `packages/occlude-studio/src/render-worker.ts`).

Read first: this file, then `CLAUDE.md` at the repository root (the design
laws), then `development/3d/CLAUDE-HANDOFF.md` §4 and
`development/3d/surface-drawing/README.md` §"Visibility and capacity changes"
(what was already measured and fixed), then
`development/3d/benchmark-surface/README.md` (the workloads and baseline
numbers).

## Mission

Make 3D sketches render faster with **no public API change and no ink
change**. The same sketch and seed must produce byte-identical output before
and after every change you keep. Speed is the only thing that may move.

Concrete target: the user's woven-vessel sketch
(`development/3d/visibility-profile/woven-vessel.ts`, also the seventh
workload in `development/3d/benchmark-surface/workloads.mjs`) currently
exceeds Studio's 60 s render watchdog (`RENDER_TIMEOUT_MS` in
`packages/occlude-studio/src/workerClient.ts`); the CPU reference takes about
20 s for its visibility alone (35k features against 33k triangles, hidden
lines requested). Get it comfortably under the watchdog on the served Studio,
then keep going: every workload in `benchmark-surface` is fair game.

## Hard rules

1. **Non-breaking only.** No change to any exported signature, option name,
   default, error message text that tests assert on, or documented behaviour.
   No new required options. If a change would need an API change, do not make
   it; write it up in `development/3d/OPTIMIZATION-PROPOSALS.md` instead
   (what, why, expected gain, what would break).
2. **Same ink.** `pnpm --filter occlude docs:hashes -- --check` must report
   every example ink-identical after each kept change. Do not re-save the
   fixture (`packages/occlude/test/fixtures/docs-ink.json`); a pure
   optimization never changes it. Also run
   `pnpm --filter occlude plotstats <sketch> --seed 42` on
   `packages/occlude-studio/sketches/church.ts` before and after anything that
   touches stroke assembly; the numbers must match.
3. **Measure before and after, on both paths, or the change does not count.**
   Keep a change only when the end-to-end number improves and correctness
   gates stay green. Kernel timings alone are not evidence.
4. **One optimization per commit**, with the before/after numbers in the
   commit message. Revert (do not stack a workaround on) anything that did
   not pay off, and record it in the log so it is not retried.
5. **Work in `/home/kalmarv/containers/occlude-3d` on a new branch** (see
   "Where to work"). Never touch `/home/kalmarv/containers/occlude` (the
   production checkout) or its stores or containers (`occlude-studio-1`,
   `occlude-dev-1`), never deploy production, never merge to `master` or
   `dev`, never operate a plotter.
6. **The machine is shared** (it runs other services). Run benchmarks
   serially under `nice -n 10`, one browser at a time, and kill any orphaned
   `tsx`/`vitest`/Chrome processes you started (by PID; `pkill` patterns are
   too broad on this box).
7. Do not reintroduce capacity caps. All count/byte budgets default to
   unlimited by the owner's decision; only explicit options may cap.
8. Do not "nudge numbers" (tolerances, epsilons, thresholds) to make
   something faster or a test pass. Exactness is the product.

## Keep a log

Create `development/3d/OPTIMIZATION-LOG.md` on the first change and append to
it for every attempt, kept or not:

```
## <n>. <short title>            <commit or "reverted">
Hypothesis: what was slow and why.
Change: files, mechanism (2–4 lines).
Before / after: workload, pass (cold/warm), CPU ms, Studio wall ms, visibility ms,
  candidates, refinements (table or one line per workload).
Correctness: vitest, docs:check, ink --check, plotstats (all "unchanged"), plus
  any GPU-vs-CPU byte comparison you ran.
Verdict: kept / reverted, and why.
```

A summary table at the top (workload × before × after, both paths) is the
deliverable the owner reads first. Proposals that need an API change go to
`OPTIMIZATION-PROPOSALS.md`, not the log.

## Where to work

- Checkout: `/home/kalmarv/containers/occlude-3d`. It is the isolated 3D dev
  checkout (its own Compose project, port and stores), not production. It
  currently sits on `feat/3d-webgpu` at the tip of `origin/dev`, and `dev`
  equals `master`. Create your branch there from `origin/dev`, for example
  `git checkout -b perf/3d origin/dev`, and make every commit on it. Push it
  as its own branch (`git push -u origin perf/3d`); never push to `dev` or
  `master`. The owner merges.
- Untracked files `development/3d/md` and `development/3d/api-3d.md` are the
  owner's notes: never stage or delete them. `development/3d/benchmark-surface/cpu.json`
  may already carry uncommitted changes from an earlier run; treat the
  committed version as the historical baseline and do not revert it.
- Node 22+, pnpm, the Rust toolchain from `rust-toolchain.toml` and Docker
  are installed and the WASM is built (`crates/occlude-core/pkg`); nothing to
  set up. Playwright is installed in this checkout's
  `packages/occlude-studio/node_modules` (not a workspace dependency, so keep
  it out of commits). Browser scripts are run from that directory with
  `node --input-type=module < script.mjs` so `import 'playwright'` resolves.
  The system Chrome is `/usr/bin/google-chrome`.
- `pnpm check` runs the nine verification gates (`check.mjs`): Rust tests,
  TS tests, library typecheck, Studio typecheck, docs examples, ink oracle,
  root build, WASM md5 match, server smoke. It is the definition of done; run
  it before every push. Fast loops while iterating:
  - `pnpm --filter occlude typecheck` and `pnpm --filter occlude-studio typecheck`
  - `pnpm --filter occlude exec vitest run test/three-*.test.ts` (3D tests)
  - `pnpm --filter occlude docs:check` (every docs example renders)
  - `pnpm --filter occlude docs:hashes -- --check` (ink identical)
- The docs live examples must be plain JS-compatible TypeScript (the loader
  strips types naively); do not add type annotations inside ```ts live fences.

### The served dev Studio (GPU path)

The GPU visibility path (WebGPU interval classification) only runs in a
browser, so the GPU numbers come from the served Studio. The service belongs
to this checkout and you may rebuild and recreate it freely:

```sh
cd /home/kalmarv/containers/occlude-3d
export OCCLUDE_BUILD_STAMP="$(git rev-parse --short HEAD)-<label>"
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
```

Facts that matter:

- The container (`occlude-3d-dev-1`, host port 5273, host networking) runs
  `server.mjs` from the image `occlude-3d-dev:latest`, serving the `dist`
  that was built **inside the image**. The bind mounts cover only
  `packages/occlude/src`, `packages/occlude-studio/src`, `docs` and the
  stores under `packages/occlude-studio/dev-store/`; `dist` is not mounted.
  So editing the working tree or running `pnpm build` on the host changes
  nothing that is served: **every GPU measurement needs the Docker build and
  `up -d` above.** (The note in `CLAUDE.md` that a rebuild needs no restart
  refers to the native `pnpm --filter occlude-studio serve` path.)
- The build is the verified build: it runs the nine gates and takes about
  four minutes; if a gate fails there is no image, which is the point.
- The stamp is baked into the bundle at build time and shown in the page
  footer (`#status-build`). Use a distinct `<label>` per measured change and
  pass the same string as `OCCLUDE_STAMP` to the GPU runner, which waits for
  it, so you can never measure a stale image by accident.
- The stores under `dev-store/` are this checkout's own (sketches, fills,
  assets, results); the production stores are elsewhere and never mounted
  here.

Browser automation: Playwright with the system Chrome on the Xvfb display
`:93` with the NVIDIA adapter (RTX 2060). Check it with
`xdpyinfo -display :93`; start one with `Xvfb :93 -screen 0 1920x1080x24 &`
if absent. The launch flags that get a real WebGPU adapter are in
`development/3d/benchmark-surface/gpu.mjs` (`--enable-unsafe-webgpu`,
Vulkan, `VK_DRIVER_FILES` pointing at the NVIDIA ICD, `headless:false` on
Xvfb). Headless Chrome gives a software fallback adapter, which is not the
measurement you want; the Studio reports the adapter in the render reply
(`three.adapter.isFallbackAdapter`), so assert on it.

The render worker's stats (`reply.three.scenes[*]`: candidates, dispatches,
refinements, wallMs, gpuMs; `reply.three.modeling[*]`: per operation backend,
dispatches, transferBytes, wallMs) are what the GPU runner records. Use
them; add more counters to the stats objects if you need them (that is not
an API change as long as existing fields stay).

### Iterate on the CPU first

The CPU reference runner (`cpu.mts`, run with `tsx`) imports straight from
`packages/occlude/src`, so it sees your working tree immediately. The
practical loop is: change, typecheck, `three-*` tests, `docs:hashes --check`,
CPU numbers; only when a change survives all of that, do the Docker build
and the GPU run. Expect one GPU measurement per kept change, not per
experiment.

### The benchmark runners

- CPU reference, all workloads, cold then warm in one process:
  `cd packages/occlude && nice -n 10 npx tsx ../../development/3d/benchmark-surface/cpu.mts`
  writes `benchmark-surface/cpu.json`.
- GPU (served Studio, after the Docker build and `up -d`):
  `cd packages/occlude-studio && DISPLAY=:93 OCCLUDE_STAMP=<stamp> nice -n 10 node --input-type=module < ../../development/3d/benchmark-surface/gpu.mjs`
  writes `benchmark-surface/gpu.json` (it waits for the served stamp, edits
  the sketch source in the editor, and times source edit to render reply).
- The committed `cpu.json`/`gpu.json` are from an older stamp
  (`bae1191-surface-final`, before depth-cutoff pruning and the API batch).
  Before your first change, run both runners on the current tip and save the
  results as `cpu-baseline.json` and `gpu-baseline.json`; those are the
  numbers you compare against. Copy the runners rather than editing them in
  place if you change what they record. Run each workload at least twice and
  report cold and warm; note run-to-run noise.
- Profiling: `node --cpu-prof` around the CPU runner, or Chrome's
  `page.tracing` / `CDP Profiler` from Playwright for the worker. Flame
  graphs of the vessel before you change anything.

## Where the time goes (measured, not guessed)

From the last session's profiles (`benchmark-surface/README.md`,
`surface-drawing/README.md`):

- **3D visibility on dense scenes** (`packages/occlude/src/three/visibility/`
  `index.ts`, `scene.ts`, `interval.ts`, `worldInterval.ts`;
  `packages/occlude/src/compute/webgpu/interval.ts`, `intervalShader.ts`,
  `scene.ts`; feature snapshot in `packages/occlude/src/three/features/snapshot.ts`).
  Candidate pairs (feature × occluder triangle) are generated after a depth
  cutoff prune; the GPU classifies intervals in batches, uncertain pairs are
  refined exactly on the CPU (bigint homogeneous arithmetic in
  `packages/occlude/src/three/geometry/exact.ts` and
  `three/visibility/precision.ts`). Refinement is now 30–80% of candidates;
  the rest of the wall time is candidate streaming as per-pair objects,
  packing into GPU buffers, readback, and the finalize/merge of hidden
  intervals per feature. First things to try, in the order the previous
  session ranked them:
  1. Stream candidates in typed arrays (feature index, triangle index) instead
     of per-pair JS objects; pack straight into the staging buffer.
  2. Decide clearly separated pairs entirely on the GPU (a wider certificate
     so fewer pairs come back as uncertain); keep the exact CPU refinement as
     the fallback, never drop it.
  3. Split classification across workers by feature range (the pipeline
     already runs in a worker; check `render-worker.ts` and the
     `StageEvent3` draft channel before adding more).
  4. Better broad phase than depth cutoff: a BVH or screen-space grid over
     occluder triangles per feature, built once per view.
  5. Interval merge/finalize: avoid re-sorting per feature; the hidden
     ranges are already produced in order per batch.
- **The surface tracer** (`packages/occlude/src/three/surface/trace.ts`,
  `three/api/hatch.ts`, the occupancy test and `SurfaceLocation3` contexts in
  `three/geometry/location.ts`): CPU-bound; per-step location objects and
  the occupancy neighbourhood test dominate. Hatch at 80k segments is 12–13 s.
  Ideas: a flat occupancy grid keyed by triangle with typed arrays, fewer
  allocations per step, reuse of the per-triangle context cache (already
  keyed by placement object).
- **Mapping and intersections** (`three/api/mapping.ts`, `three/curves/*`,
  `network.ts` with exact bigint nodes): the exact arithmetic is the contract;
  optimize allocation and indexing around it, not the arithmetic itself.
- **Modeling on the GPU** (`compute/webgpu/surfaceEvaluate.ts`, tone in
  `three/surface/evaluate.ts`): transfer bytes per dispatch are recorded;
  batching is already in place. Lower priority.
- **Studio round trip**: `packages/occlude-studio/src/render-worker.ts`
  posts stage drafts (`StageEvent3`) and the final strokes; check structured
  clone sizes (`transferBytes`) and prefer transferable buffers. The WASM
  finish and planning are the 2D side and are out of scope unless a 3D
  change moves their input.

Ideas the owner has already rejected (do not spend time on them): tiled or
multi-core finish inside the WASM core (a core redesign; planning is global),
raster-based coverage, reintroducing default caps, float nudging.

## Correctness oracles you must run for every kept change

- `pnpm --filter occlude exec vitest run` (all TS tests; the `three-*` files
  include exact-geometry, intersection and visibility oracles).
- `pnpm --filter occlude docs:check` and `docs:hashes -- --check`: every
  docs example renders and every hash is unchanged.
- For visibility changes: the CPU reference is the byte oracle for the GPU
  path. Render the seven workloads and the 3D docs examples headlessly (CPU)
  and through the served Studio (GPU), export SVG on both, and diff the
  stroke paths; there is no other oracle for the GPU classification, so keep
  this comparison script in `development/3d/optimization/` and report its
  result in the log for every kept change.
- Church routing stats (`plotstats`) unchanged.
- `pnpm check` green before every push.

## Deliverables

- Commits on your `perf/...` branch in `occlude-3d`, pushed as that branch,
  one per kept optimization, each with numbers.
- `development/3d/OPTIMIZATION-LOG.md` (every attempt, kept or reverted, with
  the before/after table at the top).
- `development/3d/OPTIMIZATION-PROPOSALS.md` (only if you found gains that
  need an API change; each with expected gain and what breaks).
- Updated `development/3d/benchmark-surface/cpu.json` / `gpu.json` for the
  final state beside the `*-baseline.json` you recorded first.
- A short final report: what got faster by how much on both paths, what did
  not work, and the top three remaining opportunities.
