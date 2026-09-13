# Reusable classification and stroke styling

`t.classify3(lineArt3(...))` resolves a captured scene during async compilation. Concurrent and subsequent requests for the same scene share one result per execution. Failed requests release their pending entry so an explicit retry can succeed; closed executions cannot adopt late results.

`FeatureSelection3` filters captured classified features. `constructStrokes3` accepts those selections, produces independent line sets from the same visibility, and supports disabling chaining. Selections from another snapshot are rejected. `t.strokes3` explicitly interprets the projected runs as ordinary protected paper strokes with named pens and an ordered array of existing modifiers. Frame inversion keeps paper positions and margins consistent.

The fifth live example in docs/three.md reuses one classification for wobbled visible edges, dashed hidden edges and a separately placed silhouette. Its new ink hash is added deliberately; existing hashes are unchanged. This slice originally started dash phase per constructed run. The subsequent source-chain implementation in PHASE.md now preserves phase across visibility cuts and paper cropping.

Verification: three-style.test.ts covers concurrent sharing, completed reuse, failure retry, snapshot validation, chaining and actual WASM modifier rendering. Playwright checks five public docs examples on NVIDIA hardware, opens the styling example in main Studio, and exports its SVG. The served bundle at port 5273 passed with no JavaScript errors and zero main-thread adapter requests. The styling scene used one GPU dispatch for 50 candidate pairs (49 numerical refinements, 5,600 transferred bytes); its SVG export is 11,824 bytes. Evidence is in playwright-styling/report.json, scene-4.png, studio.png and studio.svg. Preview library and plot-progress APIs return existing 404s; this proof uses captured docs libraries and does not establish save/reopen support.

The church toolpath oracle remains 15,601 chains, 96,037 mm drawing, 16,515 mm travel and 381.0 minutes.

Full isolated-image `pnpm check` passed: Rust 10.5s, TS 21.9s, library types 5.2s, Studio types 4.9s, docs 12.2s, ink 14.6s, build 36.3s, smoke 2.2s. WASM remains `c21c4ef21cb4091b6019b1aa440f6bea`. Original production container IDs and start times remain unchanged.
