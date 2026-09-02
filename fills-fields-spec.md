# Redesign spec: declarative fills, fields as citizens

Status: agreed design, revision four. Three internal adversarial rounds
(fills-fields-spec-review{,-2,-3}.md) plus two external reviews
(feedback-web.md) — the externals broke the frame the internals audited
within: the sketch-on-main-thread split was an accident, not a
constraint, and most of revision three's machinery existed to
compensate for it. All rulings by the artist, 2026-09-01/02, in the
decision log. Not yet implemented. Deliberately implementation-free —
read the actual code before deciding where anything goes. Where this
spec and the code's reality disagree about what's possible, stop and
ask.

## The organizing idea

The engine's entire job is ink physics: **it decides what survives to
paper, never what gets drawn.** A filled shape hides what's beneath
it; lines get trimmed where a region covers them; marks smaller than
the nib can't exist. Everything *generative* — patterns, textures,
scalar fields — is sketch-space: visible, composable, forkable code.

Two structural principles underneath:

- **One runtime owns all the JS.** The render worker owns the entire
  sketch runtime: sketch execution, field closures, fill code, scene
  encoding, the wasm instance, and export state. The main thread owns
  the editor and UI only. Closures are not serialized and never cross
  a thread — they stay inside the runtime that owns them, which is
  the same runtime the engine lives in.
- **Nothing crosses to the engine as code.** Rust sees opaque
  fill-use ids, final regions, generated primitives, and raster
  grids — never JS functions, params, or Field values. The worker
  keeps the registry that resolves ids to code.

## Part 1 — the runtime

1. **Worker-owned execution.** The studio posts emitted sketch JS,
   pens, paper config, and asset bytes to the render worker; the
   worker runs the sketch, encodes the scene, drives wasm, and posts
   results (including `seedUsed`, errors, and anything the UI shows)
   back. The main thread never executes sketch code. Consequences:
   - Runaway sketch code can no longer freeze the tab — the worker
     watchdog covers what the crash sentinel used to; the sentinel
     machinery retires.
   - Execution and rendering are serial on one thread: no
     re-entrancy, no interleaving, no execution-version protocols.
   - The studio becomes the headless case. Node render() and the
     studio worker run the identical path: fills and field sampling
     are ordinary same-thread function calls everywhere.
   - The docs page's worker gets the same runner.
   - Plumbing owed: asset registry populated in the worker,
     ui()-scan/seed/error results posted back (ui() is a static
     source scan with runtime identity — no coupling). Verified
     against the code: `__occlude.result()` already reads the posted
     worker result; the only synchronous main-thread reads are
     currentSeed() and the pre-run setters (pens, paper, URL seed) —
     these become fields on the render request and the posted
     result. Every render request carries pens/paper/JS so a
     respawned worker self-heals; the worker reports asset misses.
   - **A render is atomic from the worker's perspective.** New
     requests coalesce on the main thread while one runs; a
     superseded result is discarded and the newest request starts.
     The watchdog is the only hard interruption. No mid-render
     cancellation machinery, ever — that is the species of
     complexity this revision deleted.

## Part 2 — fills

2. **Engine contract.** The engine keeps exactly: opacity
   (`fill()`/`mask()`), clipping arbitrary primitives to a region,
   occlusion, and coverage judgment against the nib. It generates no
   patterns at all, ever — `solid()` included.

3. **Fills are functions; fill *assets* are capture-free modules.**
   Capture-freedom is a storage and UI requirement, never an
   execution one. Two forms, one contract:
   - **Inline fills** are ordinary closures in the sketch — they just
     work, like customFill today, since fills execute in the same
     runtime as the sketch. No enforcement machinery.
   - **Fill assets** are standalone files with a declared parameter
     interface — capture-free by construction (a file can't capture a
     sketch local), which is what makes them storable, shareable, and
     what lets the studio auto-generate param UI:

     ```ts
     export default fillAsset({
       params: { density: 1, field: field() },
       generate(region, params, ctx) { /* return marks */ },
     });
     ```

   - A fill use in the tree is data: `fill('stipple', { density:
     1.4, field: grain })` (asset names are literals — computed names
     defeat scanning and import rewiring). Fill assets import nothing
     beyond occlude itself — self-contained files are what make
     export embedding complete.

4. **Execution: two passes, one leg.** The stage boundaries, stated
   exactly so nothing migrates by accident (**Rust does not lower** —
   lowering/encoding stays worker JS, as today):

   ```
   worker JS:   sketch execution → tree emission → lowering/encoding
                → raster construction
   wasm pass 1: pre-stage modifiers → sort → region build → cull
   worker JS:   fills (lazy, survivors only)
   wasm pass 2: own-region clipping → occlusion → cleanup →
                post-modifiers → bridging → output
   ```

   Pass 1 returns a boxed handle that pass 2 consumes (no
   module-level wasm state; the state's lifetime is one synchronous
   call frame in one message handler — nothing can interleave) plus
   compact per-survivor records ({shape id, fill-use id, contour
   ranges, bbox} over a shared modified prim table — not full region
   copies). The region a fill sees is the intrinsic post-deform,
   post-cull outline — before paper clipping, explicit clips, and
   occlusion (an occluder must not regenerate the pattern beneath
   it).
   - **Between passes**: the worker runs fills as ordinary JS —
     lazily (only survivors), with direct access to Field closures.
     Fill errors are plain JS exceptions; timeouts are the worker
     watchdog (in node, the caller owns the timeout — a synchronous
     JS loop cannot be interrupted in-thread; worker_threads or a
     subprocess if a tool needs a hard one).
   - **Pass 2**: clip and occlude with supplied prims through the
     existing prim-range slot (FillKind::Custom's mechanism,
     preserved and renamed). This is the ONE leg: native consumers
     (replay, goldens, benches) feed the identical slot from scene
     dumps — no FillProvider abstraction, no wasm→JS callbacks, no
     exception-through-wasm contract, no registry-reload-on-respawn.
   - Region queries during generation (contains, outline) are
     answered by the wasm instance (export `region_contains` — an
     indexed Region already lives there) rather than a parallel JS
     implementation. If per-sample calls measure slow, question the
     need before optimizing: pass-2 clipping is exact regardless, and
     the custom-fill contract has always treated contains as an
     efficiency aid, not correctness.
   - Fills always see the outline as inked (deform correctness),
     generation is lazy, and boundary-relative fills track deformed
     shapes. The data-space idiom stays the power tool when the
     artist holds points: warp the loops, build rings from warped
     loops.

5. **Marks.** Fill output is lines/arcs/cubics/polylines plus a
   first-class **dot** — an intentional tap, never routed through tap
   resolution, occludable, boundary-filtered engine-side. Dot is a
   fill-output tag mapping to the existing zero-length-geometry +
   dot-flag machinery, NOT a fourth geometry primitive (a new
   Primitive variant would spread branches through length/eval/clip
   everywhere). Zero-length lines remain crumbs with crumb semantics.
   The fat-dot idiom (tiny circle + auto-tapped pinhole) is
   coverage-owned physics, untouched.

6. **Determinism.** Fills are pure functions of (region, params,
   ctx); Fields are pure functions of (x, y) — both are documented
   contract obligations with no runtime enforcement (save-time lint
   is the cheap future option). Fill randomness comes from ctx's
   seeded sub-stream, keyed `${seedUsed}:fill:${order}` exactly as
   today — draw-order-keyed (inserting a shape earlier re-rolls later
   fills; matches existing behavior), isolated from the sketch's main
   stream, and since the sketch runs in the worker, `seedUsed` never
   crosses any protocol. ctx carries `penWidth` and `coarsen` (an
   optional draft-quality hint).

   The migration breaks determinism deliberately: (1) stipple
   re-rolls once (engine RNG → sub-streams); (2) the align
   unification changes shape-aligned fills inside transformed groups;
   (3) fills re-implemented in JS differ from Rust arithmetic in the
   last decimal places — visually identical, bit-different;
   bit-reproduction is explicitly not required. All one-time; law 7
   is absolute again afterward.

7. **Protocol.** Sheds the hatch and stipple fill kinds. Keeps the
   prim-range slot (supplied prims, pass 2) and mask. Adds: the
   pass-1 "surviving outlines" return, the dot tag in supplied-prim
   encoding, and the field-bound contour reference for rasters (rule
   12). Fill params, Field values, and seeds never enter the
   protocol — the worker's registry resolves an opaque fill-use id.
   Both sides of every protocol change land in one commit.

8. **Storage** (build DEFERRED until the runtime works — separable
   project):
   - **Built-in fills live immutable in the package**, and their
     names are **ink-immutable forever**: once `hatch` ships, any
     ink-affecting change requires a new asset name (append-only
     identities) or an explicitly sanctioned law-7 break — otherwise
     a package upgrade would silently change every saved sketch that
     says `fill('hatch')`, and "law 7 is absolute again" would be a
     lie. Editing one clones it into your library — clone-to-edit.
     Tests, docs, and CI resolve built-ins from the package: hermetic
     by construction, no seeding, no virgin-machine story. NOTE:
     built-ins-in-package is prerequisite to migration step 2 (the
     docs/tests rewrite needs resolvable built-ins), and since they
     compile with the package, step 2 needs zero transpile
     machinery — the transpile decision governs server-stored user
     fills only (step 4).
   - **Custom fills live on the server**, beside sketches, in the
     fills section: draft fills edit silently; referenced fills warn
     with the actual list of using sketches (determined by scanning
     the sketch directory at warn time, never a maintained index) —
     Clone default, Edit-anyway deliberate. Editing through the
     warning is transitively an edit to those sketches; law 7 governs
     replots-without-edits.
   - **Exports embed resolved fill source**; import applies a
     content-equality short-circuit (identical code reuses the name),
     genuine mismatches take a fresh name with the sketch rewired —
     byte-identical plots, never a prompt or overwrite.
   - Param values live as literals at the sketch call site (existing
     ui()-style literal editing); the panel reads the declared
     interface. The transpile step for stored fills (save-time emit
     vs worker-side transpiler) is decided at implementation — it
     determines how studio, node, docs, and imports execute the same
     source, so decide it once, for all four.
   - **Transpile decision (2026-09-02, implementation):** neither
     save-time emit nor a worker-side transpiler. The `.ts` file is the
     only stored artefact; types are stripped AT READ TIME by Node's
     built-in `stripTypeScriptTypes` (strip-only mode: annotations
     become whitespace, line numbers survive, non-erasable syntax is
     refused) in ONE module, `occlude-studio/fill-transpile.mjs`. The
     studio server applies it on `GET /api/fills/<name>/js` for the
     browser runtimes (studio worker, docs page — same worker); the
     node tools call the same function in-process. Everything after
     the strip — the ESM→CJS rewrite (the docs examples' own
     `liveExampleToJs`), the occlude-only import check, evaluation,
     registration — is `loadFillModule` in the package, shared by
     all consumers; a draft being edited in the studio takes the same
     entry with the editor's TS-worker emit as its JS. Rejected: save-
     time emit (a stored .js goes stale the moment the .ts is edited
     with any other tool, and the store is a plain directory by
     design); bundling TypeScript/esbuild into the worker (megabytes
     of transpiler shipped to every tab to run four-line files).

## Part 3 — fields

9. **A Field is an augmented callable** — a function carrying hidden
   transform/domain metadata (`FieldFn & { … }`), thin by design.
   `rotate(grain, 30)` returns something you can still CALL, and
   direct invocation honors its own transform and domain — so
   lambdas genuinely remain the composition language:

   ```ts
   const a = rotate(grain, 30);
   const b = (x, y) => a(x, y) * falloff(x, y);   // just works
   ```

   Bare lambdas lift automatically; every existing sketch keeps
   working; no combinator API. A Field lambda is still a closure —
   the invariant is not "no closures," it is "closures stay inside
   the runtime that owns them." Fields are pure functions of (x, y):
   contract, like fills.

10. **Transforms.** Two composing mechanisms, neither ambient:
    - Explicit verbs: `rotate(field, θ)`, `translate(field, …)`,
      `scale(field, …)`.
    - Anchoring at the point of use: `align: 'paper'` (default)
      samples in paper coordinates; `align: 'shape'` anchors the
      field to the shape. **Exact definition, so transform-order
      bugs cannot breed**: let G be the full accumulated explicit
      transform at the use — group transforms AND shape-level
      transform opts, which ride the same push() machinery, so
      `group({rotate: 30}, circle(…))` and `circle(…, {rotate: 30})`
      anchor identically — excluding coordinates intrinsic to the
      geometry; let C translate to the shape's intrinsic bbox
      centre. Shape-aligned sampling uses A = G ∘ C; a paper point p
      samples the field at A⁻¹·p. Coordinate-placed shapes (G =
      identity) keep today's halftone behavior; transformed motifs
      carry their texture, rotation included. One `align` meaning.
    - **`align` reaches both consumers.** Field params are anchored
      by the runtime; a fill's OWN geometry (hatch's ruling is not a
      field) is anchored by the fill itself — so `ctx.anchor`
      carries the same A. One value, two consumers; `align` lives on
      the fill use (applying to all its field params) and on each
      modifier param object.
    - **Vector fields, all transforms**: sample through L⁻¹,
      transform the direction by the linear part L and renormalize,
      preserve the magnitude — transforms act on **coordinates and
      directions, never on magnitudes**. For pure rotation this is
      the iron-filings-photo rule (V' = R·V(R⁻¹p)); a flip mirrors
      the arrows; uniform scale leaves directions untouched
      automatically (sI·V ∥ V); non-uniform scale tilts directions
      with the squash, exactly as squashing the photo would. A 2mm
      wobble is 2mm at any motif size — the pen didn't change.
      Wanting untransformed semantics (paper-pinned wind under a
      rotated motif) is expressed by NOT transforming the field.

11. **Domain bounds and the absence convention.** `within(field,
    shape)` bounds a field — its own verb, not a clip overload.
    Nested bounds are a conjunction (present iff inside every bound);
    no intersection geometry is ever computed. Outside its domain a
    field is absent; absence is any non-finite/undefined sample. The
    mapping: **generators make nothing** (isolines: no contour —
    domain-edge contours truncate open, like the paper edge; scatter:
    no points) and **modifiers touch nothing** (decimate keeps all
    ink; wobble/roughen zero amplitude; deform zero displacement).
    Explicit finite values are always instructions. `within()` is the
    exact mechanism, with per-runtime implementations stated plainly:
    **engine consumers** get the bound as vector contours
    (clip-region format, indexed Region::inside) — vector-exact
    edges; **sketch-time JS consumers** (isolines, scatter — which
    sample before pass 1 exists) use a JS point-in-shape test, their
    output naturally limited by sampling precision anyway. The
    scaffold needs no nearest-real machinery: **rasterize the inner
    field ignoring the bound** — out-of-domain cells naturally hold
    f's own continuation, so interpolation never tapers at the
    boundary; where f itself is non-finite, store the do-nothing
    value. Domain controls applicability; the raster controls
    magnitude. Hand-rolled NaN in a lambda is accident-safety only:
    fail-soft, no pseudo-geometric edge guarantee — if the edge
    matters, that's what `within()` is for. Closing isoline contours
    along an arbitrary curved bound is a separate future geometry
    feature (parked); v1 ships open-truncation.

12. **Field carriers — one semantics, two carriers.** JS consumers
    (isolines, scatter, fills) call the field function directly —
    same thread, exact. Engine-consumed modifier params
    (decimate/wobble/deform) ride rasters built at encode time in
    the worker — and **the transform stays outside the grid**: an
    engine field use is (grid id + per-use sampling transform +
    domain refs), with Rust evaluating
    grid.sample(A⁻¹ · paperPoint). One raster per underlying field,
    shared across every shape that uses it — a thousand
    shape-anchored halftone dots share one grid with a thousand tiny
    transforms, not a thousand grids (baking the transform into the
    grid would be a per-shape raster explosion measured in
    gigabytes). Transforms are data, so nothing executable crosses.
    Grid extent and resolution under scaling are decided at
    implementation, with **shape-aligned modifier field ×
    profile5000** on the mandatory measurement list by name. The
    shared reader unifies transform, anchoring, and absence
    semantics across both carriers; resolution may differ per
    consumer.

## Migration and sequencing

Separable projects, in order; each lands whole:

1. **Worker unification** — move runSketch + encodeScene into the
   render worker; retire the crash sentinel; post back seed/errors/
   results. No API or protocol change; pure architecture. (Also
   independently valuable: fixes tab freezes today.)
2. **Fill execution** — two-pass pipeline, fills as worker JS,
   protocol sheds hatch/stipple, dot tag, **built-in fill assets
   land in the package here** (prerequisite: the docs/tests rewrite
   to `fill('hatch', {…})` needs them resolvable; they compile with
   the package — zero transpile machinery in this step). Clean
   break, no sugar. All fill-bearing goldens and baselines
   regenerate deliberately; cross-migration comparisons interpreted,
   not diffed. **Regression gate: fill-free sketches through
   two-pass with zero supplied prims are byte-identical to today's
   single pass** — the cheapest, strongest test of the restructure,
   independent of every sanctioned break. Measure first, by name:
   profile5000; shape-aligned modifier field × profile5000; JS
   hatch's boundary-overshoot clipping cost vs Rust's closed-form
   convex chord path; region_contains-over-wasm vs JS containment.
3. **Field citizenship** — Field value, verbs, align, within,
   absence, vector-field law, shared reader.
4. **Storage/studio** — fills section, clone-to-edit, warn-on-edit,
   export embedding, import short-circuit, saved-sketch conversion
   (owed: studio flags dead fill calls on open, offers per-sketch
   rewrite, artist eyeballs the re-rolled stipple in a plotted
   diff).

## Parked, with reasons (do not build; revisit triggers stated)

- **Drawable fields** (stack of value-carrying shapes). Lambdas
  compose better; unique value is machine-legibility nothing needs.
  Trigger: a felt need for studio handles on field pieces.
- **Batch field evaluation / distance-transform acceleration** —
  until the shared reader exists.
- **Exact isoline closure along arbitrary curved bounds** — a real
  geometry feature (contour/boundary intersection pairing with
  topology); v1 truncates open.
- **The mailbox (SharedArrayBuffer/Atomics field sampling), COOP/COEP
  isolation, the mid-pipeline wasm→JS callback, the FillProvider
  two-leg seam, presence-mask NaN rasters, bleed margins** — designs
  from earlier revisions, each obsoleted by the worker-owned runtime
  and the two-pass pipeline. Recorded so they are not reinvented;
  obsolete, not pending.

## Laws touched — the honest ledger

Broken, with sanction ("the law wins until the artist says
otherwise," and the artist said otherwise, on the record):

- **Law 7, three times, once each**: stipple re-roll; align
  unification (narrowed by the bbox-centre rule — coordinate-placed
  halftone fills are unchanged; only shape-aligned fills inside
  transformed groups change); JS-reimplementation ulp drift. All
  one-time; law 7 absolute again after migration.

Bent, knowingly:

- **Law 3 adjacency**: modifier field values ride grids (as today);
  every ink and boundary decision stays exact vector math. Raster
  coverage stays rejected, uncrossed.
- **Law 5, twice**: one field semantics, two carriers (direct call
  for JS consumers, rasters for Rust inner loops — forced by native
  having no JS); fills as an asset class with rules images don't
  have (warn-on-edit, embedding, literal names) — justified because
  fills are code that determines ink.
- **Law 9 exposure**: fill and field purity are contract, not
  machinery; an impure one breaks preview/export parity with nothing
  to catch it. Accepted; lint is the future remedy.

Requiring CLAUDE.md amendments at implementation: the API-rules
example list (hatch/stipple as pure factories — deleted); scene.rs
protocol notes; the rejected list gains this spec's parked/obsolete
designs as do-not-resurrect items.

Strengthened: law 1 (absence is law 1 for values), law 2, law 6
(fills become plain, forkable, parameterized code — the largest
single win), and the engine contract now fits in one sentence.

## Costs, surfaced honestly

- Three one-time sanctioned ink changes (ledger).
- Fill *assets* lose lexical capture (declared params) — the price
  of storability and the param UI; inline fills keep closures.
- Worker unification is real plumbing (assets, results, docs runner)
  and its "nothing needs synchronous sketch state" premise must be
  verified in code, not assumed.
- Two-pass state lives one synchronous call frame (pass 1 returns a
  boxed handle pass 2 consumes; nothing interleaves on the worker's
  event loop). The only requirement is that pass 1 not depend on
  prior state — already true. No abort machinery exists or is
  needed.
- The clean break costs a migration debt to saved sketches,
  deferred with a named obligation.
- Storage remains a small package manager (scan-at-warn, embedding,
  rewiring) — deliberately last in sequence.

## Decision log

1. (2026-09-01) Fills become recipes: visible code, editable in a
   studio fills section.
2. (2026-09-01) Stipple re-roll: accepted.
3. (2026-09-01) Engine line: `solid()` is a recipe; the engine never
   draws patterns.
4. (2026-09-01) Fields become citizens: transforms, clipping, one
   shared reader, lambdas lift.
5. (2026-09-01) Drawable fields parked; Field skeleton thin.
6. (2026-09-01, review W1) Explicit field transforms + per-use
   `align`, `'paper'` default; no creation-context inheritance.
7. (2026-09-01, review W2a) First-class dot; fat-dot idiom stays
   coverage-owned.
8. (2026-09-02, dataflow rethink) Fills as declared-input code the
   engine schedules, never main-thread closures. Artist: "the whole
   time we were designing around closures when all we needed to do
   was just make a function."
9. (2026-09-02, W4) Warn-on-edit, no versioning; Clone default;
   exports embed; import mismatches take a fresh name.
10. (2026-09-02, W5) Absence convention: generators make nothing,
    modifiers touch nothing; explicit finite values honored;
    `within` is the domain verb.
11. (2026-09-02, tail) `within` confirmed; coarsen in ctx; RNG
    draw-order-keyed; no sugar for the old fill API; purity is
    contract.
12. (2026-09-02, rounds two/three) Domain edge = paper-edge policy;
    ONE align meaning (ink change sanctioned); dot protocol slot;
    scan-at-warn-time; content-equality import; the mailbox era —
    see entry 15.
13. (2026-09-02, round three) NaN presence-mask exactness (superseded
    by entry 15's rollback); prim-range slot survives; two-pass
    reconsidered.
14. (2026-09-02, external reviews adopted) Sketch runtime moves into
    the render worker — the mailbox, COOP/COEP, abort protocol,
    watchdog pets, and the three-carrier bend all die with the
    main-thread split they compensated for. Execution and storage
    de-fused: inline closure fills allowed; capture-freedom is a
    storage/UI rule. Rust sees opaque fill-use ids. align:'shape' =
    bbox-centre ∘ group transform (halftone preserved). Storage
    reopened by the artist: built-ins immutable in the package,
    clone-to-edit; custom fills on the server; storage built last.
15. (2026-09-02, final rulings) (a) Two-pass over the mid-pipeline
    callback — one supplied-prims leg for wasm and native alike.
    (b) NaN holes are fail-soft only; presence-mask machinery cut
    ("I'll just use 0"). (c) Vector fields: rotation rotates the
    arrows (V' = R·V(R⁻¹p)); translation moves the pattern; scaling
    never scales amplitudes — the un-transformed variant remains
    expressible by not transforming the field. (d) Fill assets
    import nothing beyond occlude itself.
16. (2026-09-02, external round two folded) Renders are atomic — no
    mid-pass abort, ever. Rust does not lower; explicit stage list.
    Raster transform lives OUTSIDE the grid (one grid per field,
    per-use transform as data — kills the per-shape raster
    explosion). align:'shape' gets an exact matrix (A = G ∘ C, shape
    opts included) and reaches fills' own geometry via ctx.anchor.
    Scaffold = rasterize the inner field ignoring the bound (the
    peek-under design, returned as the simpler option). Field is an
    augmented callable. Built-ins move to migration step 2;
    transpile decision scoped to user fills. Fill-free byte-identity
    regression gate restored. TWO EXTENSIONS MADE ON THE ARTIST'S
    BEHALF, flagged for veto: (i) shipped fill names are
    ink-immutable forever — ink-affecting changes to a built-in
    require a NEW name (defends law 7 against package upgrades);
    (ii) the vector rule generalized to all linear transforms —
    direction by L renormalized, magnitude preserved (subsumes the
    rotation ruling; a flip mirrors arrows, non-uniform scale tilts
    them like squashing the photo).
