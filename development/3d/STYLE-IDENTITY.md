# Stable source/style/pass randomness

The acceptance audit reproduced an ordering bug through actual planning: reversing 20 selected 3D wire rows changed which wires survived `decimate(0.5)`. The previous Rust coin flip included global shape and primitive-table indices. Canonical feature construction alone did not protect artists who reordered the resulting stroke values or removed another selected source.

The 3D paper adapter now hashes the complete source-chain reference ID, line-set ID, named pen and optional nonempty pass ID into a stable u32 key. This uses the existing string-seed hash without constructing or consuming a random stream. The normal sketch seed remains part of the final random key. `t.strokes3(runs, { modifiers, pass: 'ink-a' })` provides an explicit identity for an interpretation; it does not introduce a repetition generator.

That key travels with source ranges through the ordinary shape recorder and the TS/WASM scene protocol. Shape f64 stride 6 appends the source seed; -1 retains legacy behavior. Rust still accepts strides 2, 3 and 5, and ordinary 2D scenes still emit their existing stride. Both the encoder and decoder validate the key. Direct Rust inputs also require source ranges when a source seed is present.

For source-linked shapes, decimation uses the stable key and the fragment's source traversal coordinate. That coordinate survives wobble/dash-generated primitive replacement. Wobble combines the sketch seed with the same source/style/pass key. Ordinary shapes without a key preserve their previous algorithm and ink. The drawing/plot pipeline remains unchanged: modifiers still precede routing, and existing source gaps stay protected.

The key belongs to a complete selected source chain. Removing an unrelated source or reordering rows leaves it unchanged; changing that chain's topology or line-set/pen/pass identity may legitimately change it. A different pass ID can produce a different authored interpretation without consuming procedural-model random draws. Color changes within the same named pen do not replace its identity.

`three-style-identity.test.ts` reproduces the original bug and now verifies planned primitives for reordered rows, removal of an earlier unrelated source, ordered wobble/decimation, changed pass IDs and changed sketch seeds. It also tests both sides of key validation and unchanged rendering of a legacy stride-5 source record versus a stride-6 record with no seed. Existing phase/planned-gap and retained-camera regressions pass alongside it.

Only docs ink `three#4` and `three#5` deliberately change: their 3D wobble now uses the source/style/pass seed, and the first example demonstrates an explicit pass. All other docs hashes remain unchanged, including every 2D example. The church oracle before/after remains 15,601 chains, 96,037 mm drawing, 16,515 mm travel and 381.0 minutes.

Served verification: [Studio order/filter report](playwright-style-identity/report.json) compares the actual planned SVG in both row orders and after removing an unrelated source. Eight strokes survive with identical geometry. [Full 3D regression evidence](playwright-identity-regression/report.json) covers all live examples; companion camera-config and persistence reports verify retained commit, downloaded camera configuration and saved-result reopening under changed libraries. The two changed live-example screenshots were visually inspected, and the named visibility demo's SVG/screenshot/report were refreshed.

The complete isolated-container `pnpm check` passes all gates. Rebuilt WASM is `8bf0034cb79606aa8d6c7293496a1b7e`. Only isolated dev was deployed; production container IDs/start times remain unchanged. No plotter was connected.
