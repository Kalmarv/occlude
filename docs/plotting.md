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

`render` options: `paper` (a preset name or `{ paper, landscape }`), `coarsen` (preview coarsening; 1 is exact), `stretch` (fill the paper non-uniformly), `unbounded` (skip the paper clip). The SVG is the plotted drawing rather than the raw fragments: one path per chain in plot order, after the same merge, tour and bridge the G-code and the machine use, with arcs and cubics kept exact. Both exports honour `t.draw`; a range in minutes or a budget needs `timing` from a machine profile.

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
