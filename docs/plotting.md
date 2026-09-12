# Plotting & saving

The route from a sketch to paper: paper and pens, choosing which part of the ordered drawing to plot, export, simulation, saved results, and running the machine. Machine internals and calibration procedures are in the Device notes.

## Paper and pens

Papers: `PAPERS` holds A3 to A6, Letter and Square20; a custom size is `{ paper: { w, h } }`. The studio's Paper panel picks the sheet, landscape, the margin, and the paper colour. Colour paints under the ink in the preview and in both exports so that, say, a white gel pen on black stock reads on screen as it will on paper; it changes nothing about the ink or the plot.

A pen is `{ name, width, color, feed, penDown, penUp, penDelay, reinkMm? }`. `width` in millimetres is what the nib rule reads. Unknown pen names are an error, so a shared sketch fails loudly rather than plotting with the wrong nib. `DEFAULT_PENS` ships a starter set; the studio keeps its own library on the server and hands it to the engine with `setPenLibrary(pens)`. Pens with a `reinkMm` budget (paint markers, dip pens, brushes) pause the plot at the first stroke boundary past that many drawn millimetres and wait for Resume; 0 turns it off.

## The ordered drawing

Rendering produces the visible ink. Planning turns that ink into an order: fragments merge into chains, the chains are toured (nearest neighbour then 2-opt within a budget), and sub-nib gaps are bridged. `plan(render(def))` runs this once and returns a `DrawingPlan`: the chains with their native primitives, the settings that made them, and a hash over both that every export and the machine share.

The sketch states its path settings and which part is drawn:

```ts
t.plan({ optimize: 50_000, bridge: false });   // tour budget (false keeps nearest-neighbour order); bridge gap in mm, or false
t.draw({ progress: [0, 0.3] });                // a fraction of the chains, in plan order
t.draw({ chains: [120, 400] });                // whole chains, half-open
t.draw({ minutes: [0, 20], budget: 20 });      // an interval of the estimated timeline; budget keeps the longest prefix that fits
```

A selection is a contiguous range of one exact plan. It never re-plans, reorders, reverses, merges or re-solves visibility, so dropping later ink does not reveal what it hid. `progress` is a fraction of chains, not of ink, area or time. `minutes` and `budget` use the machine profile's estimate and are quantized to completed chains; the Drawing panel shows the effective boundaries. `ui()` turns any of those numbers into a slider.

The Drawing panel only reads the result: the resolved chain range, the estimate for that range against the whole, the path settings, and a preview-only ghost of the omitted ink that never enters an export. Export, Simulate, Plot and Frame all take the selection.

```ts live
import { sketch, stroke, ui } from 'occlude';

// t.draw chooses a range of the plan's order, not a region of the page.
// The tour starts nearest the origin and works outward, so the first
// 40 % of the chains is the inner part of this spiral; the rest is ghosted.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const part = ui(0.4, { min: 0, max: 1, step: 0.05 });
  t.draw({ progress: [0, part] });
  return t.times(60, (k, u) => {
    const a = u * Math.PI * 6;
    const r = 4 + u * 42;
    const [x, y] = [100 + Math.cos(a) * r * 1.9, 50 + Math.sin(a) * r];
    return stroke([[x - 3, y], [x + 3, y]]);
  });
});
```

## Export

From the studio's Export panel: SVG, G-code per pen, and PNG, all of the current selection. Headless:

```ts
await initOcclude();                          // once, before the first render
const out  = render(def, { paper: 'A4' });    // out.frags, out.prims, out.stats
const jobs = exportGcode(def, { paper: 'A4', profile });   // one job per pen: { pen, penName, gcode, inkMm, travelMm }
const svg  = exportSvg(def, { paper: 'A4', background: '#f6f2ea', onlyPen: 0 });
const png  = exportPng(def, { paper: 'A4', scale: 11.81 }); // ≈ 300 dpi
```

`render` options: `paper` (a preset name or `{ paper, landscape }`), `coarsen` (preview coarsening; 1 is exact), `stretch` (fill the paper non-uniformly), `unbounded` (skip the paper clip). The SVG is the plotted drawing rather than the raw fragments: one path per chain in plot order, after the same merge, tour and bridge the G-code and the machine use, with arcs and cubics kept exact. SVG, G-code and PNG exports honour `t.draw` and the plan’s bridges; a range in minutes or a budget needs `timing` from a machine profile. PNG rasterizes that selected plan at the requested `scale`, and accepts the same `optimize` override.

The plan API is available directly when a tool needs the pieces: `selectChains`, `selectProgress`, `selectTime` and `fitDuration` pick a range; `resolveDraw(plan, req, timing?)` is what `t.draw` goes through; `planSvg`, `planGcode` and `planToolpath` encode a range; `encodePlanBuffer` and `decodePlanBuffer` are the exact bytes, and `openPlan(bytes, settings, hash)` rebuilds a saved plan and refuses a mismatch.

Command line:

```sh
pnpm --filter occlude render sketch.ts --seed 7 --paper A4 --out out.png [--svg out.svg]
pnpm --filter occlude plotstats sketch.ts --seed 7     # pen lifts, ink and travel mm, estimated time, tour bounds
```

`plotstats` is the before-and-after check for any change that affects toolpaths. Plot time everywhere comes from one estimator, `estimatePlanMs`, shared by the driver, the export panel, `plotstats` and the simulation.

## Simulation

Simulate animates the selected plan with the machine profile's timing: the pen's route, lifts and settles in order, at the estimated speed. It is the way to see the order a tour produced and to judge whether a bridge tolerance or a `t.draw` range does what you meant before the machine moves.

## Saved results

Save result keeps exactly the current selection as resolved output: the selected chains as a plan of their own, their frozen SVG, the pens, paper, machine profile and timing, the build stamp, and the sketch source, its hash and the seed as provenance. Records are written whole and are immutable; delete is the only edit. The Results page lists them. Open frozen in studio (`/?result=<id>`) shows, exports and plots the saved bytes without executing the source and without reading the pen library, so later edits to the sketch, the pens or the profile never change what was kept. Only the selection is saved, so a reopened result cannot grow back into the rest of the plan.

## Setting up

1. Connect on the Plot panel (Web Serial, Chrome or Edge, over HTTPS or localhost).
2. Park the carriage at the bed corner the machine's lift map was measured from and Set bed origin. Place the sheet and Set paper origin, which records an offset without zeroing.
3. Frame traces the selected ink's bounding box pen-up at the paper offset. Adjust the sheet until it lands where you want it.
4. Pick the pen to plot. There is no pen changer, so a multi-pen sketch plots one pen per run; "all pens (one run)" plots the whole plan with the installed pen, each chain at its own logical pen's feed and settle.

## Plot, pause, resume

Plot runs the selection. Progress is saved on the server every few chains: the plan hash, the selected range, the executed chain, the pen, the paper offset, and the saved result it ran from if any. After a stop, a crashed tab or a power loss, Resume continues from that chain at the saved offset, provided the current drawing is the saved plan (same hash) with the same range. A plot that ran from a saved result reopens those bytes instead of regenerating. A mismatch refuses rather than guessing; Forget clears the record. After a power loss, re-park at the bed corner and Set bed origin first.

Visible drift mid-plot: Pause, jog the pen onto the origin mark, Set origin, Resume. The interrupted stroke's remainder stays pen-up and the next chain re-inks. A board that stops answering is recovered automatically: emergency stop, position re-read, the chain redone. The estimate blends toward measured throughput as the plot runs.

A draft plot for checking placement and structure: wrap the drawing in `decimate(0.7)` and plot with a fraction of the ink; the seed keeps the full version identical when you remove it.

## Repairing a plot

Three tools in the Plot panel narrow what the *machine* plots without changing the drawing. **Plot only** takes an interval of the plan's own timeline — two handles and two minute fields, resolved exactly as a `minutes` request is, then intersected with the sketch's `t.draw` selection. **Paint region** takes a brush: set its radius in mm, arm it, and each drag lays overlapping dabs; a chain is in when any of its ink lies under any dab, tested on the full toolpath at machine tolerance. The two narrow each other, so neither can widen what would have been plotted, and `Whole plan` clears both. They are studio-only: exports still draw the whole selection, and `Ghost the omitted ink` is how the preview shows what you have cut.

The readout while plotting is `<state> · <pen> · <eta> min left · <drawn> / <total> mm · re-ink in <N> mm`. A pen with a re-ink budget parks at the bed origin mid-plan and waits, which is where you pump, refill or reseat it; Device notes has the procedure.

**Marks** draws a right angle at the sheet's top-left and another at its bottom-right with the selected pen, the legs running inward, so the pair traces the sheet's bounds. For a pen change: marks, tape over them, swap pens, marks again — line the brackets up and the pens are registered. Marks is a plot of its own, so it leaves the progress record alone.

## Calibration

The Machine page holds the machine profile (bed size, feeds, accelerations, servo pulses, settle, optional lift map) and the calibration cards: a registration probe for step loss, backlash squares, corner ringing at three feeds, the pen-height cards (lift traverse, lift grid, settle by lift, down sweep) and a settle sweep for a pen's true delay floor. Download serial log exports the full timestamped command transcript, the first thing to collect when anything misbehaves. The Device notes describe each procedure and what the numbers feed.

## Optional path optimization

In Studio, switch to **Plot → Optimize path** to spend extra computation on a finished drawing. It runs only when you click **Run optimization**, in a separate cancellable worker; it does not rerun your sketch or generate its fills again.

**Auto optimize** searches fitting, joining and ordering settings, then keeps the fastest candidate that passes vector ink checks. Open **Auto settings** to set the maximum local change in nib widths, missing ink percentage and added ink percentage. The defaults are 0.1 nib width locally, 0.1% missing ink and 0.5% added ink, checked separately for every pen. **Alternatives** controls how many proposals are tried (up to 11). **Allow connections** controls whether Auto may add visibility-checked connectors; the manual fitting and gap inputs do not set Auto's search values.

The comparison uses the union of actual pen-width strokes at the active machine's polyline resolution. Overdrawing existing ink can therefore have almost no added-area cost. Area limits are supplemented by a whole-footprint local-distance check, so losing a narrow finger or isolated mark cannot hide inside a good area percentage. The readout gives conservative upper bounds in square millimetres and the tested local-distance limit. SSIM, pixels and raster masks are not used. Numerical ambiguity skips a candidate and retains the original or a previously passing candidate.

Auto runs in the separate cancellable worker. Large drawings can take a minute or more to search; normal render time is unchanged. It currently supports polyline machine profiles, including EBB. For profiles exporting native G2/G3 arc commands, use manual optimization. Footprint comparison does not predict extra ink darkness from overdrawing; review the added strokes and ink-length change before applying. **Difference** shows replaced strokes and proposed connections, not a raster heatmap.

**Run optimization** retains the manual controls:

- **Fit short segments** replaces connected line segments with fewer lines or circular arcs. Maximum deviation is measured in paper millimetres against the original segments, including their interiors. Existing arcs/cubics, taps and sharp turns stay intact. Maximum segment length chooses which lines are eligible; the turn threshold protects corners.
- **Join nearby ends** permits new ink up to the maximum gap. The search extends both ends of each run. Endpoints must belong to one known shape, and the complete connector must pass the engine's visibility checks, including holes, clips and occluders. Contour runs can join when their fill permits connectors; `connectors: false` and shapes with finishing modifiers remain protected. Ambiguous provenance is left separate. Joining requires a live render; saved results can still be fitted and reordered.
- **Improve drawing order** spends additional routing effort on whole chains. It may reverse a chain or move the starting point on a closed loop while preserving its traversal. A routing result that increases pen-up distance is discarded.

This densely sampled wave is a useful fitting example for manual or Auto optimization. Open it in Studio and compare the primitive and machine-command counts before and after fitting:

```ts live
import { sketch, stroke } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 42 }, (t) =>
  t.times(12, (k) => stroke(
    t.times(300, (_, u) => [12 + 76 * u, 10 + 7 * k + 2 * Math.sin(18 * u)]),
  )),
);
```

The comparison reports ETA using the same estimator as plotting, plus internal lifts (excluding the initial lowering/final raising), travel, ink length, primitives and motion commands. Fewer primitives need not mean a faster plot: fitted curves are flattened at the machine's normal resolution, and turns affect speed. Optimization time is separate from plot ETA. The worker compares the requested settings, tighter fitting, and joining/ordering without fitting when applicable. The original is always a candidate: **Use optimized** is available only when the shared estimator predicts a faster plot. A larger tolerance is permission to change more ink, not a promise of greater speed.

**Original**, **Optimized** and **Difference** are preview-only comparisons. In Difference, rose marks replaced ink and teal marks fitted ink or new connections. **Use optimized** makes the candidate the active plan for preview, simulation, SVG/PNG/G-code export, saving results and plotting. **Restore original** restores the original plan and its sketch selection. Changing the sketch creates a new render and discards the candidate.

Optimization starts from the original sketch selection every time; repeated trials do not accumulate fitting error. Applying a candidate makes those selected paths the full active plan and clears chain-based repair selections, since joining or ordering changes chain indices. Settings and source-plan identity are stored with an accepted result. Fitting can move ink within its tolerance; joining adds ink. Only new connectors receive the visibility certificate, and the machine's normal flattening tolerance applies in addition to fitting deviation. Fills and finishing-modifier behavior are unchanged.
