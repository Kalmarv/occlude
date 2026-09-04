# occlude — project ethos

Occlude is a plotter-native creative-coding system: the pen is the medium,
not a renderer of last resort. These are the artist's laws. Process notes
and implementation details do not live here.

## Design laws

1. **Occlusion is available, exact, and opt-in.** The point of the project
   is that shapes *can* hide what is beneath them, and the engine computes
   exact visible strokes. Fill does not imply occlude: a texture that does
   not hide, and an opaque mask with no texture, are both first-class.
   When something *is* opaque, it hides — overlays do not erode the
   strokes underneath.

2. **Composable data, generic operations.** Everything interesting is
   data you can hold, iterate, and feed to the next operation. Generators
   and graph nodes return plain, editable geometry (points, curves, meshes,
   chains), not sealed drawings. Named algorithms are recipes, not API
   surface: `scatter(field).settle(n)` is weighted LBG stippling — there
   is no `lbg()`. Generic ops over per-feature specials. If signatures
   diverge, split the function. No mode flags whose options are only
   valid in some modes.

3. **Same program, same seed, same ink.** With a given build, a sketch
   plus seed is reproducible. Changing the code may change existing
   sketches; that is allowed. All randomness flows through seeded streams.

4. **One time model for plot duration.** Anything that talks about how
   long a plot takes uses one estimator. Today that is `estimatePlanMs`.
   Do not grow a second clock.

5. **Preview matches the plot.** What you see at nib width is as close as
   we can get to paper. Preview, export, and the machine agree.

**Routing default, not a law:** the engine does not duplicate edges to
Eulerize a tour. Retrace is allowed when the artist asks for it.

Sub-nib judging, input snapping, dash phase, tour budgets, and field
rasters are implementation numbers. They are not tenants.

## API shape

- One Toolkit surface. Do not maintain a parallel `Toolkit` interface and
  `TOOLKIT_BASE` object by hand — that dual model is a tax, not a feature.
- Pure factories (shapes, fills, modifiers, units, map/ease, svg,
  voronoi/triangulate, and graph nodes that do not read seed or paper)
  are module imports. Anything that reads the seed or the resolved paper
  (rnd/noise/stream, bounds/grid/times, scatter) lives on the toolkit.
- Wasm protocol changes (strides, flags, export signatures) land on both
  sides in the same commit. Buffer strides are documented at the top of
  `scene.rs`.
- Machine state lives in named MachineProfiles (server-side, like pens) —
  never re-grow flat settings.machine/ebb.

## Working agreements

- **Evidence before diagnosis.** Reproduce before theorizing; measure
  instead of estimating. The "stale tab" diagnosis may be played at most
  once per issue.
- **When patches stack, stop and rearchitect.**
- **Definition of done:** tests (Rust + TS) + live reference entry
  (`pnpm --filter occlude docs:check`) + studio build + wasm md5 match
  (`crates/occlude-core/pkg/*.wasm` == `packages/occlude-studio/dist/assets/*.wasm`)
  + commit/push. The server serves dist per request; restart only for
  server.mjs / *-store.mjs changes (kill by PID — pkill aborts the shell).
- **Docs are the reference, singular.** Every feature gets a `ts live`
  entry in docs/reference.md. Do not recreate api.md or guide.md.
  docs/gallery.md is the other live page: classics transposed (credited,
  licence-checked, never API documentation), same checker.
- **Copyleft neighbors:** saxi (AGPL), EggBot (GPL), Spicker stippling
  (LGPL), Marlin/Klipper (GPL) — ideas, protocol facts, and papers only,
  NEVER code. Keep the README credits table current.
- **Oracle:** `pnpm --filter occlude plotstats <sketch> --seed 42`
  (church.ts) before/after any toolpath-affecting change. Golden fixtures
  regenerate only deliberately (`UPDATE_GOLDEN=1`).
- Rejected on principle (don't resurrect): veil/partial occlusion
  (use decimate fields on the content), raster-based coverage,
  channels-as-FieldFn, drawing images, branded algorithm names,
  mode-flag mega-functions, and the fills-redesign's obsoleted machinery
  (mailbox/SAB field sampling, COOP/COEP isolation, mid-pipeline wasm→JS
  fill callback, presence-mask NaN rasters, bleed margins — see
  working/fills-fields-spec.md).
