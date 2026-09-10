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
- **One point atom per job.** `{x, y}` objects are points-as-things —
  identity and metadata ride on them. `[x, y]` pairs are anonymous
  vertices inside loops. Arithmetic takes either spelling and returns a
  fresh pair (`XY` in, `Vec` out). No point class, and no third spelling.
- **An area is an input, not a type.** There is no public `Region` type
  and no `region()` constructor; the engine's contours-plus-winding is an
  internal word. Area consumers (`polygon`, `distanceTo`,
  `force.boundary`, the `bounds` of a point operation) accept loops,
  contour records, one face, a chain material, a shape, or a rect, and
  read closure and winding from the source. Several areas at once — a
  face collection — must name which one it means. `t.within(x, area)` is
  the one word for "only what lies inside": a field is bounded, a material
  is cut at the boundary, a point selection and a face collection are
  filtered. A shape area is lowered by the toolkit, never by a pure
  kernel.
- **The frame rule.** Value methods exist only on resolved data-world
  values (Material, Station, Selection, Face, contour records).
  Anything that needs the sketch frame — paper, units, a shape's own
  transform — is a toolkit function. `station.place(...)` is right;
  `.along()` or `.length` on `circle()` is not: `t.material(circle(…))`
  first.
- **Drawing stays explicit.** `strokes`, `stroke` and `dot` interpret
  geometry as ink. A Material never draws itself, and no value carries a
  display translation that changes what is drawn.
- **One conversion per meaning.** Two doors, one contract each:
  `t.material(shape, { tolerance? })` keeps the boundary's own vertices —
  a rectangle's four corners — and `t.sample(shape, { count?, spacing?,
  tolerance? })` redistributes points along the boundary by arc length,
  which need not land on a corner. `material(points)` is the pure
  constructor. No `toMaterial`/`toRegion` aliases and no third spelling of
  either door.
- **`origin` is the pivot.** `rotate` and `scale` pivot on `origin`
  (`[x, y]`, or `'center'` for the drawable's middle); on the user origin
  when it is unset. Scaling about the middle is an option, never a
  compensating translate.
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
- **Definition of done:** `pnpm check` — one line per gate: Rust tests, TS
  tests, the library typecheck (`src` and `tools`), every docs example
  rendering, the docs ink oracle against
  `packages/occlude/test/fixtures/docs-ink.json`, the root build, and the
  wasm md5 match. Then commit/push. A DELIBERATE ink change re-saves that
  baseline in the same commit, with the reason in the message; the test
  suite and the studio are not typechecked yet (`check.mjs` says so). The
  server serves dist per request, and reports its build id per request, so
  a REBUILD needs no restart; restart only for server.mjs / *-store.mjs
  changes (kill by PID — pkill aborts the shell).
- **Docs are topic pages with live examples.** Every feature gets a
  `ts live` entry on its topic page under docs/ (getting-started, shapes,
  fills, fields, materials, images, plotting; the list is `DOC_PAGES` in
  packages/occlude/src/docsExamples.ts, shared by the site and the
  checker). Explanation, signatures and live sketches stay together on
  the page; do not split into separate guide/reference/sketch layers or
  a page per function. docs/gallery.md is the live page of credited,
  licence-checked classics — never API documentation. Same checker for
  all of them; the checker also reports ink outside the drawable.
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
