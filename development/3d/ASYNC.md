# Async sketch execution

`sketchAsync`, `isSketchAsync`, `compileSketchAsync`, and `renderAsync` are additive public entry points. Existing synchronous definitions and render/export functions retain their contracts; synchronous entry points diagnose an async definition explicitly. WASM initialization is still host-owned.

The async compiler binds one ordinary toolkit to one execution, awaits the callback, then records its returned tree. Seeds, captured libraries, paper and frame stay local to that execution. Cancellation before or after the await prevents tree recording. Arbitrary user JavaScript cannot be interrupted by an AbortSignal; individual construction operations must also receive the signal. Executions remain single-use after failure or cancellation. Concurrent compile attempts on one execution are rejected.

Studio's runner evaluates both definition types with its existing module, draw and inspection hooks. Its render worker awaits compilation and serializes all requests that read or mutate retained render/plan state. The existing client still coalesces queued renders and terminates the worker for watchdog/preemption. This slice does not add cooperative GPU cancellation to the main Studio worker.

The docs renderer and ink checker await compilation, with one live getting-started example. All previous stable docs hashes must remain unchanged; the new example adds one pinned hash.

Verification:

- Library async tests: sync/async raw vector equivalence, interleaved executions, concurrent ownership, cancellation, rejected callbacks and single-use execution semantics.
- Studio runner tests: awaited module exports, captured pen factories, deterministic seeded draw addresses, and synchronous diagnostic.
- Direct Playwright: the async live example renders actual ink through Studio's real worker, with no page errors. See `playwright-async/report.json` and `async-example.png`.
- Full `pnpm check` runs inside the isolated dev image build. Build and browser logs are task-local.

Follow-up SCENES.md adds deferred line-art scene values and explicit host GPU classification. Still pending: GPU resources on the bound modeling toolkit, GPU modeling/queries through the public sketch workflow, main Studio viewport/camera integration and the remaining M2–M5 requirements. This is the execution boundary, not completion of the 3D public API.

Verified build gate: Rust 10.4s, TS 23.8s, library types 5.3s, Studio types 4.8s, docs 12.3s, existing ink 15.1s, build 38.3s, smoke 2.1s. WASM remains `c21c4ef21cb4091b6019b1aa440f6bea`. The added live example's hash was then pinned; the oracle reports 220/220 stable examples identical, two explicitly unstable, zero added/missing. The existing hardware 3D regression also passes on the source server; its report is `playwright-async-regression/report.json`.
