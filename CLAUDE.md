# occlude — project ethos

Occlude is a plotter-native creative-coding system: the pen is the medium,
not a renderer of last resort. These laws were earned, mostly the hard way.
When a proposal conflicts with one, the law wins until the artist says otherwise.

## Design laws

1. **Physical truth beats formal convenience.** Ink cannot be erased,
   overlays cannot erode strokes beneath them, and a pen CAN tap a dot.
   Every abstraction must survive contact with paper. When the artist's
   material intuition says the physics is wrong, it has always been right —
   re-derive instead of defending.
2. **Fill means occlude.** Filled shapes hide what's beneath; the engine
   computes exact visible strokes. Strokes never occlude (stroke-footprint
   is a backlogged opt-in, not a default).
3. **The nib is the only tolerance.** Sub-nib decisions are made by exact
   ink COVERAGE (vector distance queries, never rasterising), not by length
   heuristics or epsilon knobs. Closed contours are judged whole.
4. **Never double-draw ink.** Crossing an inked line is fine; retracing one
   is forbidden. No Eulerizing by edge duplication, ever. (Deliberate
   exception: the backlash diagnostic overtraces on purpose.)
5. **One mechanism, not a special.** Generic transforms over per-feature
   ones (svg uses the same rotate as everything). Named algorithms are
   recipes, not API surface: `scatter(field).settle(n)` IS weighted LBG
   stippling — there is no `lbg()`. No mode flags whose options are only
   valid in some modes; if signatures diverge, split the function.
6. **Composable data over sealed features.** Generators return plain,
   editable data (`Points`, cells, image samples) and the artist stamps
   shapes; `image()` samples and never draws. Verbs work on arbitrary
   arrays — repurposing tools in unintended ways is half the point of
   generative art.
7. **Deterministic to the plot.** Same seed, same ink, forever. Re-renders
   must never reshuffle (the URL-less seed is sticky per session). All
   randomness flows through seeded streams, including inside helpers.
8. **Plot time is a design dimension.** Every feature prices its pen
   cycles. There is ONE time model — `estimatePlanMs` in occlude/motion.ts —
   shared by the plot ETA, plotstats, and the export panel; never grow a
   second one. Completed plots log to /api/plotlog; `plotstats --fit`
   learns wall-time corrections.
9. **The preview is ink-truth.** WYSIWYG at nib width; preview, export,
   and paper must agree. Preview (canvas drawFragments) and export (Rust
   raster) are SEPARATE paths — verify visual bugs in the actual studio
   via playwright, on the user's paper size; headless proof is not preview
   proof.

## API shape rules

- Pure factories (shapes, fills, modifiers, units, map/ease, ui, svg,
  voronoi/triangulate) are module imports; anything reading the seed or
  the resolved paper (rnd/noise/stream, bounds/grid/times, scatter/points)
  lives only on the toolkit. The toolkit also carries the pure set.
- `TOOLKIT_BASE` (object) and `Toolkit` (interface) in api.ts are
  maintained SEPARATELY — update both or Monaco flags the new function.
- Wasm protocol changes (strides, flags) must land on both sides in the
  same commit; buffer strides are documented at the top of scene.rs
  (wasm_api.rs is a thin bindgen wrapper over it).
- Machine state lives in named MachineProfiles (server-side, like pens) —
  never re-grow flat settings.machine/ebb. Controls read the active
  profile at event time; profile-bound UI rebuilds on switch.

## Working agreements

- **Evidence before diagnosis.** Reproduce before theorizing; measure
  instead of estimating (settle iterations, plot times, void scans). The
  "stale tab" diagnosis may be played at most once per issue.
- **When patches stack, stop and rearchitect.** The artist will call "don't
  layer small fixes on small fixes" — ideally get there first.
- **Definition of done:** tests (Rust + TS) + live reference entry
  (`pnpm --filter occlude docs:check`) + studio build + wasm md5 match
  (`crates/occlude-core/pkg/*.wasm` == `packages/occlude-studio/dist/assets/*.wasm`)
  + commit/push. The server serves dist per request; restart only for
  server.mjs / *-store.mjs changes (kill by PID — pkill aborts the shell).
- **Docs are the reference, singular.** Every feature gets a `ts live`
  entry in docs/reference.md (executed in-browser and by docs:check).
  api.md and guide.md were deliberately deleted — do not recreate them.
- **Copyleft neighbors:** saxi (AGPL), EggBot (GPL), Spicker stippling
  (LGPL), Marlin/Klipper (GPL) — ideas, protocol facts, and papers only,
  NEVER code. Keep the README credits table current.
- **Oracle:** `pnpm --filter occlude plotstats <sketch> --seed 42`
  (church.ts) before/after any toolpath-affecting change. Golden fixtures
  regenerate only deliberately (UPDATE_GOLDEN=1).
- Rejected on principle (don't resurrect): veil/partial occlusion
  (overlays can't erode ink — use decimate fields on the content),
  raster-based coverage, channels-as-FieldFn, drawing images, branded
  algorithm names, mode-flag mega-functions.
