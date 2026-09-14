# Studio camera commitment

The construction panel's **Commit view** uses the retained paper composition API. It requests a new execution and vector plan for the selected camera, without evaluating the sketch module/function, regenerating meshes, rerunning deformation/queries, or consuming model random draws. The hatch/section composition example now retains its drawing callback. Labels, masks, clips and named styles still pass through the existing paper pipeline.

The request names both the current execution and plan hash. Invalid or obsolete requests fail. Encoding, vector rendering and plan hashing complete before worker state is replaced, so a failed commit leaves the previous plan/export available. Ordinary failed generation now also preserves the preceding worker result. Scene order remains stable across commits; the construction viewport reuses prepared geometry when its captured world arrays are unchanged.

Camera commits use the render client's coalescing/watchdog path. A newer request or editor change sends a job-specific cancellation message; an AbortSignal stops later classification batches and prevents adoption after classification/planning. Cancellation does not restart the retained worker. The previous plan remains exportable. A focused client test verifies cancellation, null settlement, queued-render dispatch and no worker restart even after the normal preemption interval. Browser checks explicitly exercise a canceled camera job and subsequent export.

The camera is captured in the new execution and, through **Save result**, in the persisted result's 3D inputs. Source code is unchanged. Rendering or reopening the sketch still uses its source camera; Copy camera is the explicit route for editing that source configuration. Automatically persisting camera overrides in saved/downloaded sketch configuration remains a separate unfinished part of the project workflow. No claim of full M5 completion or exhaustive cancellation-boundary coverage.

Direct Playwright drives the main Studio on nonfallback NVIDIA Turing: orbit leaves the plan unchanged; Commit view changes the camera, execution and SVG; an instrumented procedural-model counter and normal-render request count remain unchanged. Captured realized objects remain equal, and modeling diagnostics are reused. Invalid, stale and canceled requests leave the committed SVG exportable. Save/reopen checks compare the new camera, exact plan/SVG, paper, pens and timing after changed library fixtures and a later preview-camera move. Test-created results are removed.

The first source-browser run passed commit and persistence. After cancellation was added, a subsequent run passed camera/cancellation checks but encountered `ERR_NETWORK_CHANGED` while loading the frozen result during Docker build activity. This observation is not treated as a successful full round trip; the finished bundle is verified separately.

The final served port-5273 bundle passes the complete Playwright check, including cancellation and persistence. Evidence is in `playwright-camera/`: `report.json`, `camera-commit.json`, `camera-commit.png`, `camera-commit.svg` and `persistence.json`. The model counter remains at two total calls (one in docs, one in Studio); normal Studio render requests remain at one across the camera commit. The temporary saved result is deleted and `/api/results` is empty afterward.

Full isolated `pnpm check` passes: Rust 13.9s, TS 24.1s, library types 5.7s, Studio types 5.1s, docs 13.0s, ink 15.2s, build 38.8s and smoke 2.2s. Existing stable docs hashes and WASM (`615f9d1b7a63396d451fd33aac18b559`) are unchanged. Church remains 15,601 chains, 96,037 mm drawing, 16,515 mm travel and 381.0 minutes. Only the isolated dev service was deployed; original production container IDs/start times are unchanged.

## Camera controls revision (2026-09-15, Claude)

Per the user: the 3D button is a small camera/sketch switch at the bottom
right of the sheet; the construction view is an overlay canvas in exactly the
preview's box, rendering the model into the scene's own viewport rectangle at
the preview's pan/zoom (`Preview.viewTransform`, `onViewChange`), so the UI no
longer shifts between the two; Blender mouse/keyboard controls (`orbit.ts`:
`panCamera3`, `presetCamera3`, `fitCamera3`); Commit writes the camera into the
`view(...)` call (`viewCamera.ts`, `cameraSource`), falling back to `cameras3`
for explicit `lineArt3` scenes. Not done by choice: target editing (moving the
camera does it), the drawing-as-preview idea, camera vocabulary in the API.
Written cameras omit `near`/`far`; the factories recompute their defaults, so
an object beyond the default far distance would need an explicit value.
The first served check showed the top preset writing `up: [0, 1, 0]` into the
sketch and then orbiting about Y; presets now keep the world up (turntable)
and place top/bottom just inside the orbit's pole margin, so screen up is +Y
in a top view and a later orbit still turns about Z.
