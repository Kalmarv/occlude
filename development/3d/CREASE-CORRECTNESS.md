# Camera-independent crease classification

The user reported inconsistent ground-grid lines in the section-towers live example. The edge selector includes crease, silhouette and boundary features. Flat neighboring ground cells should not create a crease; tower-to-ground folds and the outer boundary should. Normal visibility still removes hidden portions.

The prior extractor normalized triangle normals after camera transformation and used `acos(dot)` with `angle > 0`. Camera-space rounding labeled five of the 30 flat interior ground edges in a 6×6 separated-tower reproduction as creases, with angles from about 0.00000085 to 0.00000191 degrees. The reverse error also occurred: a real shallow fold rounded to zero and lost its crease flag.

The extractor now measures crease angles from world geometry. Robust coplanarity predicates identify exact coplanar neighbors; equally oriented coplanar triangles have zero crease angle. Other angles use `atan2(length(cross), dot)` so shallow folds survive without introducing an arbitrary artistic cutoff. Camera-facing silhouette logic remains separate.

Two regressions fail against the committed prior implementation and pass with the fix: all 30 interior flat ground edges stay crease-free across two camera views, and a real shallow fold retains its analytically expected angle across orthographic and perspective cameras. All 12 mesh tests pass. The church before/after logs are identical: 15,601 chains, 96,037 mm drawing, 16,515 mm travel, 381.0 minutes.

The docs ink baseline deliberately changes only `three#6` (sections) and `three#7` (hatch/sections) to remove false ground creases. Every other docs hash is unchanged. This is a correction to feature selection, not a new crease tolerance API.

The user requested that user-controlled crease tolerance be raised in the final handoff and discussed later, along with camera controls. See [USER-FOLLOWUPS.md](USER-FOLLOWUPS.md).

Full isolated `pnpm check` passes: Rust 10.5s, TS 21.0s, library types 5.7s, Studio types 5.0s, docs 12.7s, ink 14.6s, build 36.2s and smoke 2.3s. WASM remains `615f9d1b7a63396d451fd33aac18b559`.

Served-bundle Playwright passes all eight live GPU scenes plus the main Studio construction orbit/zoom/reset/pick checks on nonfallback NVIDIA Turing. Visual inspection of `playwright-crease/scene-6.png` confirms that the stray ground-cell seams are gone while tower bases, outer boundaries and section lines remain. Browser page errors are empty; empty-store API 404s are recorded separately. Production container IDs/start times are unchanged; only isolated dev was deployed.
