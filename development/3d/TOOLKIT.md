# Public procedural 3D toolkit

The existing toolkit binder adds `deform3` and `querySurface3` when used through async compilation. They receive the execution's explicit compute resource and cancellation scope. Calls from synchronous compilation fail clearly; a retained toolkit cannot start modeling after its execution finishes. Inputs are captured at submission, and cancelled/late results are not added to run diagnostics.

`deform3` awaits all fixed-topology displacement/adjacency passes and returns editable geometry. `querySurface3` captures one surface and batches ray, segment and nearest queries against it, returning matching hit arrays. These are explicit materialization boundaries before later CPU edits. Headless operation uses the documented CPU reference; a supplied host lacking an operation fails rather than falling back silently.

The host's deformation, query and visibility operations share its existing lazy device. A host queue serializes complete operations so error scopes, initialization, buffer ownership and disposal cannot overlap incorrectly. Query families in one call share one prepared/uploaded surface; deformation retains the pipeline and uses its existing per-job bounded buffers. Loss resets the retained deformation pipeline when the next explicit request acquires a new device. Disposal stops admission and drains work before releasing the device.

Public geometry exports include grid, face selection/measures, independent extrusion, transforms, frozen passes and owned copies/snapshots. The 3D topic now includes a seeded grid example that independently extrudes separated faces, runs 16 GPU displacement/relaxation passes, queries a ceiling surface, applies the returned constraints on CPU and returns line art.

Evidence:

- `three-toolkit.test.ts`: CPU materialization/query semantics, submission ownership, missing-host rejection, cancellation and closed execution scope; existing kernel CPU/GPU tests remain in place.
- Direct Playwright `verify-scenes.mjs` now runs three topic examples and opens the procedural example in the main Studio. The worker reports 16 deformation dispatches, one query dispatch and one scene visibility dispatch on the NVIDIA adapter. Cached-plan SVG export succeeds; main-thread adapter requests stay zero. See `playwright-toolkit`.
- Prior 222 stable docs hashes remain identical; the new procedural example adds one explicitly pinned hash. CPU f64 reference ink is the docs oracle; GPU numeric refinement is covered separately by browser/kernel checks.
- The same isolated preview-host missing library/machine endpoints documented in SCENES.md remain visible in the browser report. Tests carry the docs' captured libraries and never contact the production plotter service.

Pending: cross-execution geometry/camera caching, main Studio 3D viewport and controls, point/edge/point-cloud/instance API completion, ordered stroke modifier/phase work, M4 hatching and plane sections, and M5 persistence, performance, pinned reference fixtures and handoff. This slice does not complete M3 or the full MVP.

Final isolated-image `pnpm check`: Rust 10.4s, TS 21.4s, library types 5.2s, Studio types 4.9s, docs 12.5s, ink 14.5s, build 35.9s, smoke 2.1s. WASM is unchanged at `c21c4ef21cb4091b6019b1aa440f6bea`. Production container identities/start times remain unchanged.
