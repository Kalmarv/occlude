# Progressive rendering investigation

## User-directed first version: replace the draft at stage boundaries

The user proposed publishing unprocessed lines at the existing stages, with each
stage replacing the previous preview. This is the preferred first implementation,
simpler than the per-feature exact streaming explored below. The useful sequence
is projected source lines → 3D-visible lines → interpreted strokes → finished
paper composition → final planned drawing. Where two stages are too close or a
representation is unavailable, combine their checkpoints rather than add work
solely to manufacture a preview. Each event replaces a disposable draft for the
current render ID. Only final adoption updates saved/exportable output.

This version does not require incremental WASM, stable partial toolpaths, or an
`onFeatureComplete` classifier. Those are optional future latency improvements.
A pre-scene sketch checkpoint is also optional, needed only for showing geometry
during user code before it returns a view; it must not block automatic drafts once
the scene exists. Preserve final output, request cancellation and bounded/throttled
transfers. The investigation below records deeper options, not prerequisites for
this stage-replacement version. No progressive runtime implementation is landed.

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

### Progress accompanies stage replacement

Add a separate worker event channel carrying the current render ID, stage and
optional completed/total counts. It must not resolve the final render promise.
Progress is useful during assets and user-code execution before lines exist,
and while a long stage retains the previous draft. Do not make progress-only
reporting the first delivered version of the user's visible-lines request.

Publish bounded replacement snapshots when available: projected source geometry,
3D visibility output, interpreted strokes, finished paper fragments, and the
final planned result. Closely spaced boundaries can share a snapshot. Internal
stages that contain only candidates or bookkeeping need no artificial picture.
Only final adoption updates lastRun/lastPlan and exportable data.

### Smallest useful line preview

There is no safe exact final-ink stream today. A defensible draft preview can be added at a clearly provisional stage, but the earliest useful checkpoint depends on where the wait occurs:

* For long async modeling inside the user sketch, add an explicit opt-in sketch checkpoint: the sketch supplies a camera/frame and publishes a captured view or source line set before awaiting the expensive operation. The worker can post that checkpoint as a draft and continue the same run. This requires a defined snapshot identity and camera contract, and the sketch author must choose a meaningful checkpoint. It is the only way to show lines during a wait that precedes the returned tree.
* An automatic modeling-input preview could inspect a partially built surface or input scene, but it would need to know which camera, projection, paper frame, and interpretation to use. The current worker cannot infer that safely from arbitrary user JavaScript, so this is a larger API design and should not be promised as the first version.

* Once a `LineArtScene3` has been captured, project its source feature segments/wires and send them in bounded batches as **source geometry**. This can show that geometry exists while classification continues, but it includes occluded and later-discarded portions.
* After one feature's complete 3D visibility classification, convert that feature to strokes and send it as a provisional **classified** layer. This is a stronger exact-3D checkpoint than source geometry, while later scenes and the global 2D render still finish.

The payload must identify `renderId`, scene identity/order, camera/frame, a monotonically increasing `draftRevision`, and a `kind` such as `source` or `classified`. The UI should label or visually distinguish it as “draft” and discard it on a newer render or final adoption. Never put draft bytes into `lastPlan`, exports, freeze, or the retained result.

The first actual line version publishes whole-stage replacements. Neither the
optional pre-scene checkpoint nor per-feature completion is a prerequisite.
Per-feature classified chunks can reduce latency later when classification itself
is the long stage. All drafts are replaced by the final RenderResult and are
clearly provisional. Do not rerun user styling callbacks to manufacture drafts:
each callback must retain its existing execution and randomness semantics.

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

1. Add a draft/progress event channel and disposable preview layer, keyed by the
   active render ID. Preserve existing final adoption, export and cancellation.
2. Publish projected source lines after scene capture, then replace them after
   3D visibility, stroke interpretation, paper finishing and final planning where
   those boundaries expose useful drawable data. Include paper/camera/scene frame
   and composition placement; combine nearby checkpoints to avoid wasted work.
3. Throttle and bound geometry transfers. Discard obsolete events and remove the
   draft on success, failure, cancellation or worker replacement.
4. Verify initially blank renders, edits over an existing result, cancellation,
   multi-view composition and unchanged final ink/plan/export.
5. Profile time to first lines. Only then consider optional author checkpoints
   for pre-scene work, per-feature visibility events, or native incremental APIs.

Whole-stage replacement is the recommended first version. It does not require
stable partial toolpaths or incremental WASM. Keep the previous committed preview
under the draft and commit only the final result. Long user-code work before a
view exists remains a distinct limitation; progress reporting covers that interval
unless the author explicitly provides an earlier view.

## Test strategy

Use worker-client tests for ordered progress, obsolete render filtering, worker replacement, and retained-preview behavior. Add focused tests for ordered stage replacement and drafts proving revisions from an old render cannot replace a newer one. Per-feature/checkpoint tests apply only if those optional extensions are implemented. Keep final render/plan oracle tests unchanged: a progressive feature must not alter exact `RenderResult`, plan hash, SVG/G-code, or seed reproducibility. Browser verification should exercise an initially blank render, an explicit pre-scene checkpoint, a render over an old result, cancellation while a GPU batch is pending, and a late message from a terminated worker.

## Implemented: stage replacement (Claude, 2026-09-14)

The first version above is landed as a separate `draft` message channel:

- Library: `compileSketchAsync(def, inputs, { onStage })` and `commitCamera3(..., { onStage })`
  call the listener from `classifyForRun3` with `StageEvent3 { stage: 'source' |
  'classified', scene, paper, segments, total }`: projected source lines right
  after feature capture (hidden portions included), then the 3D-visible
  intervals after classification. Segments are paper-mm `[x0, y0, x1, y1, ...]`,
  uniformly subsampled above 200,000 so a transfer stays bounded. Nothing is
  recorded from these events; the result, plan and exports are unchanged
  (`test/three-stage-events.test.ts` compares a listened and a silent compile).
- Worker: each render posts `{ type: 'draft', id, revision, stage, ... }` at
  `assets`, `sketch`, per-scene `source`/`classified`, `render`, and `finished`
  (copies of the finished prims/frags before planning, transferred). Drafts are
  skipped once the job's signal is aborted and never touch retained/export state
  or the staged candidate.
- Client: `render(req, isCurrent, onDraft)` forwards drafts of the pending
  render only, in rising revision order, while it is current and not obsolete;
  a draft never resolves the render promise, and messages from a terminated
  worker are ignored as before (`workerClient.test.ts`).
- Preview: `setDraft` keeps a disposable layer above the retained result (scene
  lines in draft blue, or the finished paper drawing in its pens), fits the
  sheet when nothing is retained yet, and is cleared by `setResult`, by the
  final reply, by an error and by cancellation. The status line names the stage.

- Modeling progress: `compileSketchAsync(..., { onProgress })` receives
  `ModelingProgress3 { operation, done, total?, detail? }` from `t.hatch` (accepted
  traces per family), `t.mapSurface` (input segments) and `t.intersections`
  (placement pairs). The worker forwards them as `draft` messages with stage
  `modeling`, throttled to one per 100 ms; the status line shows the operation
  and counts during the long `await` before any view exists. Counts are work
  units, not time; results are unchanged (`three-stage-events.test.ts`).

Not implemented (optional later work): an author checkpoint before the sketch
returns a view, per-feature classified chunks, incremental WASM finish or
partial plans.
