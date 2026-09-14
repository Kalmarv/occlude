# Progressive rendering investigation

## The blank interval

Studio currently has one render transaction. `main.ts` marks the preview stale and starts an elapsed-time ticker at [packages/occlude-studio/src/main.ts:238-253](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/main.ts:238), then awaits one `RenderClient.render()` promise at [main.ts:260-279](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/main.ts:260). With no `lastResult`, the canvas stays blank; with one, the old result stays dimmed until the final reply. The timer is useful status, but it does not carry geometry.

The client sends one `render` message and expects one decoded `RenderReply` ([workerClient.ts:201-285](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/workerClient.ts:201)). The worker does not post anything while that request is running. It awaits assets/fills and `runSketchAsync`, then `renderEncoded`, `planDrawing`, and the transfer of copies ([render-worker.ts:168-253](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/render-worker.ts:168)). The watchdog is 60 seconds and covers this whole interval ([workerClient.ts:71-79](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/workerClient.ts:71)).

There are therefore two different requests hiding behind “progressive rendering”:

1. **Progress reporting:** publish stage, counts, and elapsed work while preserving atomic final adoption. This addresses the blank-screen anxiety and is the smallest safe change.
2. **Progressive lines:** publish drawable geometry before the full render completes. This requires an explicitly provisional representation and commit rules; it cannot be obtained by merely forwarding timing events.

## Existing stage and batch boundaries

`runSketchAsync` awaits `compileSketchAsync` and only returns an encoded scene afterwards ([packages/occlude-studio/src/runner.ts:122-131](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/runner.ts:122)). `compileSketchAsync` awaits the user's async sketch, resolves every 3D drawing, and only then calls `emit` ([packages/occlude/src/api.ts:1261-1289](/home/kalmarv/containers/occlude-3d/packages/occlude/src/api.ts:1261)). The ordinary synchronous sketch function also cannot be observed while it is executing: user JavaScript returns a tree once. This ordering matters for long `await t.intersections(...)`, `await t.hatch(...)`, or similar modeling work inside the sketch: the worker has no `LineArtScene3`, view, or drawable lines to send until the user's function resolves.

For 3D, `resolveTree3` walks arrays sequentially. A `Drawing3` first calls `classifyForRun3`, then interprets the classified view as strokes ([packages/occlude/src/three/resolve.ts:17-41](/home/kalmarv/containers/occlude-3d/packages/occlude/src/three/resolve.ts:17)). Classification does have useful internal boundaries: `classifySceneGpu3` collects candidate pairs, flushes every `pairCapacity` (default 8,192), then performs topology refinement and a final `finish` ([packages/occlude/src/three/visibility/scene.ts:31-77](/home/kalmarv/containers/occlude-3d/packages/occlude/src/three/visibility/scene.ts:31)). The refinement records are indexed by feature and compare neighboring intervals belonging to that same feature; there is no evidence here that feature A's refinement waits on feature B's intervals. This makes an exact 3D chunk possible at feature completion: once all candidate pairs for one feature have been processed and that feature's close interval neighbors refined, its visible intervals can be finalized and converted to strokes. The current implementation does not expose that boundary because it accumulates all features and calls `finish` once. A completed feature is still only a 3D visibility result: later 2D composition, fills, paper clipping, and global planning can change what is finally shown.

The GPU host serializes classify jobs and awaits each GPU submission/readback ([packages/occlude/src/compute/webgpu/scene.ts:41-84](/home/kalmarv/containers/occlude-3d/packages/occlude/src/compute/webgpu/scene.ts:41)); the interval implementation checks the abort signal between batches. This is a good hook for progress events and cancellation, but not by itself a line-streaming API.

After 3D resolution, the worker calls `renderEncoded`. WASM preparation, fill jobs, and the finish pass are one synchronous call sequence ([packages/occlude/src/wasmRender.ts:113-167](/home/kalmarv/containers/occlude-3d/packages/occlude/src/wasmRender.ts:113)). It then plans the complete drawing with `wasm_plan` and hashes the result ([render-worker.ts:137-149, 194-200](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/render-worker.ts:137)). Exact plot preview and exports depend on that final plan, including merge, tour, and bridge decisions. A prefix of the eventual plan is not stable while the whole set is unknown.

## What can be shown

### Minimal first version: progress only

Add a `progress` worker message carrying `{ renderId, stage, completed?, total?, detail? }`. Suggested stages are `assets`, `sketch`, `3d-capture`, `3d-classify`, `3d-refine`, `encode`, `fills`, `visibility`, `plan`, and `complete`; counts should be optional because some stages have no honest denominator. Forward the message through `RenderClient` to a callback supplied by `main.ts`, and let the existing status ticker show the latest stage and counts.

The worker should emit at stage transitions and after each 3D classification flush, throttled to animation-friendly frequency. This reuses existing boundaries and `PhaseClock3` data without changing the final `RenderReply`. Progress is advisory: it must never mutate `last`, `lastRun`, `lastPlan`, or the preview's committed result.

This version helps even when the first render has no retained image. It is also useful for diagnosing whether time is spent in user code, GPU setup/readback, WASM/fills, or planning. Do not report a percentage for the full run unless the denominator is real; “classifying · 3,276 candidate pairs” is more truthful than “51%”.

### Smallest useful line preview

There is no safe exact final-ink stream today. A defensible draft preview can be added at a clearly provisional stage, but the earliest useful checkpoint depends on where the wait occurs:

* For long async modeling inside the user sketch, add an explicit opt-in sketch checkpoint: the sketch supplies a camera/frame and publishes a captured view or source line set before awaiting the expensive operation. The worker can post that checkpoint as a draft and continue the same run. This requires a defined snapshot identity and camera contract, and the sketch author must choose a meaningful checkpoint. It is the only way to show lines during a wait that precedes the returned tree.
* An automatic modeling-input preview could inspect a partially built surface or input scene, but it would need to know which camera, projection, paper frame, and interpretation to use. The current worker cannot infer that safely from arbitrary user JavaScript, so this is a larger API design and should not be promised as the first version.

* Once a `LineArtScene3` has been captured, project its source feature segments/wires and send them in bounded batches as **source geometry**. This can show that geometry exists while classification continues, but it includes occluded and later-discarded portions.
* After one feature's complete 3D visibility classification, convert that feature to strokes and send it as a provisional **classified** layer. This is a stronger exact-3D checkpoint than source geometry, while later scenes and the global 2D render still finish.

The payload must identify `renderId`, scene identity/order, camera/frame, a monotonically increasing `draftRevision`, and a `kind` such as `source` or `classified`. The UI should label or visually distinguish it as “draft” and discard it on a newer render or final adoption. Never put draft bytes into `lastPlan`, exports, freeze, or the retained result.

The first actual line version should pair stage progress with complete per-feature classified stroke chunks when a scene has already been captured. It can reuse `constructStrokes3`/`strokesForRun3` and avoids pretending that a raw GPU batch is final. For the earlier user-code wait, an explicit sketch checkpoint is the viable route; source segments are a useful fallback after that checkpoint when classification itself is the long stage. All drafts must be replaced by the exact final `RenderResult` and must not claim plot fidelity.

## Protocol and authority work

The worker protocol needs a separate event channel (or a `progress`/`draft` union) that does not resolve the render promise. `workerClient.ts` needs a listener and a way to associate events with the current request; events from a terminated worker must be ignored just as stale bitmaps are closed today ([workerClient.ts:95-106](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/workerClient.ts:95)).

Cancellation already has the right shape: the client marks a pending render obsolete and sends `cancel-render`; the worker aborts its `AbortController` ([workerClient.ts:215-224](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/workerClient.ts:215), [render-worker.ts:355-367](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/render-worker.ts:355)). Progress and draft handlers must check the same request id and abort state. A draft from an obsolete request must not repaint the current editor, including during the 1.5-second preemption/worker respawn path.

Final adoption is already staged: the worker stores a candidate and adopts it only on `accept-render`; the client rejects stale replies and sends `discard-render` ([render-worker.ts:162-166, 204-215](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/render-worker.ts:162)). Extend that authority rule to drafts: drafts are disposable and keyed by render id; only the final current reply clears the draft layer. Keep the old committed preview beneath the draft where one exists. If no old result exists, show the draft or a paper-colored canvas with the stage status.

Retained old previews matter because a long new render must not erase a known-good result. The current `preview.setStale(true)` behavior already expresses this policy ([main.ts:245-252](/home/kalmarv/containers/occlude-3d/packages/occlude-studio/src/main.ts:245)). A draft layer should sit above it and be removed on cancel/error/final replacement.

## GPU visibility batches and a genuine stream

To stream classified lines genuinely, classification would need a callback such as `onFeatureComplete` from `classifySceneGpu3`, carrying immutable results only after all candidate pairs for that feature and its same-feature topology refinement are complete. A plain `onBatch` callback is too early: later batches for that feature can reveal additional hidden intervals and change earlier line segments. The feature callback is more promising than arbitrary object partitioning and should be investigated first. It still needs backpressure or throttling so `postMessage` and structured-clone costs do not dominate GPU work.

A per-feature visibility chunk can be exact for the 3D visibility calculation if its complete candidate set is known and its local refinement is finished. It is still provisional for the 2D result: `resolveTree3` may have later scenes in composition order, and the WASM finish pass can clip/occlude/fill the combined paper drawing. The existing feature snapshot deliberately retains source segments for continuous phase ([packages/occlude/src/three/features/snapshot.ts:44](/home/kalmarv/containers/occlude-3d/packages/occlude/src/three/features/snapshot.ts:44)); emitted chunks must preserve that source phase and stable feature identity. Partitioning by objects remains a separate approximation risk if it drops cross-object candidate pairs.

WASM is a harder boundary. `wasm_prepare` and `wasm_finish` expose no incremental callback, and fill generation is invoked between them. Exact occlusion, fill ordering, paper clipping, and fragment stats become available only after finish. Planning is similarly global: a partial plan would alter tour and bridge decisions when later fragments arrive. A real final-geometry stream therefore needs new chunked native APIs, stable fragment identity, incremental fill/occlusion state, and a final reconciliation pass. It should be treated as a separate project after progress and explicitly provisional drafts prove useful.

## Bounded implementation sequence

1. Add progress events only at existing worker stage boundaries and GPU flushes; add stale-id filtering and tests for cancellation, coalescing, respawn, and “old preview remains visible”.
2. Instrument the 3D path with counts/timings from `FeatureSnapshot3`, candidate batches, and final refinement. Keep all state worker-owned.
3. Define and implement an explicit sketch checkpoint for long pre-scene async modeling, including its camera/frame and snapshot identity. Add a disposable draft layer in the preview.
4. Add an `onFeatureComplete` visibility hook and send complete classified feature strokes as drafts; fall back to explicitly labeled projected source geometry after a checkpoint if classification has not completed. Bound message size and throttle updates.
5. Validate that draft events never affect plan/export/freeze/inspection/camera commit and that a final or canceled render removes them under all stale-result paths.
6. Only then evaluate native/WASM chunking. Define exactness and reconciliation semantics first, then add chunk identity, cross-chunk occlusion handling, and a final plan rebuild.

Relative effort is low for progress reporting, moderate for a disposable per-scene draft layer, and high for genuine exact chunked rendering because it crosses worker protocol, 3D classification, WASM, plan identity, and UI authority. No precise duration is implied.

## Recommendation

Pair progress events with the earliest honest line checkpoint. For long waits inside user code, make an explicit opt-in sketch checkpoint the first line-producing feature; after a scene exists, add exact-per-feature 3D visibility drafts. Retain the previous committed preview underneath all drafts. Do not expose raw GPU batch intervals or a partial WASM/plan result as final ink. The current architecture cannot automatically stream lines before a sketch returns because the sketch owns arbitrary async work and provides no camera/view checkpoint; even after that point, exact 2D visibility/fill/plan adoption remains atomic.

## Test strategy

Use worker-client tests for ordered progress, obsolete render filtering, worker replacement, and retained-preview behavior. Add focused 3D tests that assert progress flush counts, abort between batches, and per-feature completion only after all that feature's candidate pairs/refinement; add checkpoint and draft tests proving revisions from an old render cannot replace a newer one. Keep final render/plan oracle tests unchanged: a progressive feature must not alter exact `RenderResult`, plan hash, SVG/G-code, or seed reproducibility. Browser verification should exercise an initially blank render, an explicit pre-scene checkpoint, a render over an old result, cancellation while a GPU batch is pending, and a late message from a terminated worker.
