# Plotting & saving

Paper and pens, the ordered drawing and choosing a range of it, export, simulation, saved results, and running the machine.

## Render & export

```ts
await initOcclude();                         // once, before the first render
const out  = render(def, { paper: 'A4' });   // out.frags, out.prims, out.stats
const jobs = exportGcode(def, { paper: 'A4', profile: { zMode: true } });
const svg  = exportSvg(def, { paper: 'A4', background: '#f6f2ea', onlyPen: 0 });
const png  = exportPng(def, { paper: 'A4', scale: 11.81 });  // ≈ 300 dpi
```

- `render` options: `paper` (preset name or `{ paper, landscape }`),
  `coarsen` (preview coarsening; 1 = exact), `stretch` (fill the paper,
  non-uniform), `unbounded` (skip the paper clip).
- `exportGcode` returns one job per pen:
  `{ pen, penName, gcode, inkMm, travelMm }`. `optimize` sets the 2-opt
  tour budget (`false` disables, a number overrides). Plot time is not on
  the job: `estimatePlanMs` over the toolpath is the one model (law 4),
  shared by the driver, the export panel, plotstats and the simulation.
- `exportSvg` is the plotted drawing, not the raw fragments: one `<path>` per
  chain the pen draws, in plot order, after the same merge → tour → bridge
  the G-code and the machine run (law 5 — preview, export and machine
  agree). Curves stay exact (arcs and cubics, no flattening); sub-nib gaps
  the nib physically spans are inked as bridges. `tourBudget` matches
  `optimize`; default 200 000.
- **The ordered plan as a value.** `plan(render(def))` runs the merge →
  tour → bridge ONCE and returns a `DrawingPlan`: its chains with native
  primitives (arcs stay arcs, dots stay dots), the settings that made it,
  and a SHA-256 `planHash` over both — the identity every export and the
  machine share. Path optimization is the plan's, not an exporter's, and
  the sketch states it: `t.plan({ optimize: 50_000, bridge: false })`
  (`optimize` = tour budget, `false` keeps nearest-neighbour order;
  `bridge` = draw through sub-nib gaps, `false` never, a number is the
  gap in mm); `plan(r, opts)` takes the same options directly. Which part
  is drawn is the sketch's too — `t.draw({ progress | chains | minutes,
  budget? })`, resolved by `resolveDraw(plan, r.draw, timing?)`; the
  exports honour it. Selections are
  contiguous chain ranges of one exact plan and never re-plan, reorder,
  reverse, merge or re-solve — dropping later ink does not reveal what it
  hid: `selectChains(p, { from, to })` (half-open, whole chains),
  `selectProgress(p, { from: 0, to: 0.3 })` (a fraction OF CHAINS: floor
  of f·N, 1 → N), `selectTime(p, flat, { fromMs, toMs }, schedule)` (an
  interval of the full timeline quantized to completed chains — the start
  may resolve earlier than asked; a chain the interval ends inside is
  excluded), `standaloneEstimate(...)` (a middle interval pays its own
  travel-in and final lift — not a difference of timestamps) and
  `fitDuration(p, flat, sel, { budgetMs }, penOf, timing)` (the longest
  prefix of the selection that fits, priced from one schedule with the
  terminal-lift rule, empty when the first chain alone does not fit).
  Then `planSvg(p, sel, pens)`, `planGcode(p, sel, pens, profile)` and
  `planToolpath(p, sel, tolerance)` encode that range; the full selection
  is byte-for-byte the `exportSvg` output. `encodePlanBuffer(chains)` /
  `decodePlanBuffer` are the exact bytes; `openPlan(bytes, settings,
  hash)` rebuilds a saved plan and refuses a mismatch.
```ts live
import { sketch, stroke, ui } from 'occlude';

// The plan is an order, and t.draw chooses a range OF THAT ORDER — not a
// region of the page. Forty short strokes laid out as a spiral: the tour
// starts nearest the origin and works outward, so the first 40 % of the
// chains is the inner part of the spiral — heavy here, the rest ghosted
// as the docs page shows an ordered selection. Drag `part` in the studio.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const part = ui(0.4, { min: 0, max: 1, step: 0.05 });
  t.draw({ progress: [0, part] });
  return t.times(40, (k, u) => {
    const a = u * Math.PI * 5;
    const r = 3 + u * 20;
    const [x, y] = [50 + Math.cos(a) * r * 1.8, 25 + Math.sin(a) * r];
    return stroke([[x - 1.5, y], [x + 1.5, y]]);
  });
});
```

- Headless CLI: `pnpm --filter occlude render <sketch.ts> --seed N --paper A4
  --out x.png [--svg x.svg]`.
- A `Fragment` is `{ origin, t0, t1, pen, shape, dot, bridge, geom }` — a
  sub-range of an original primitive with exact geometry in paper mm
  (`bridge` marks connectors inserted by the bridge opt).
  `drawFragments(ctx, frags, pens)` paints them on a Canvas 2D context
  scaled to 1 unit = 1 mm.
- Plot statistics: `pnpm --filter occlude plotstats <sketch.ts…> [--seed N]`
  reports pen lifts, ink/travel mm, estimated plot time, and optimization
  bounds per sketch — the before/after oracle for toolpath changes.

## Pens & paper

- Pens: `{ name, width, color, feed, penDown, penUp, penDelay, reinkMm? }` —
  width in mm is the system's one tolerance. Unknown pen names throw, so shared
  sketches fail loudly. `DEFAULT_PENS` ships a starter set; the studio
  persists its own library server-side and injects it via
  `setPenLibrary(pens)`.
- Papers: `PAPERS` has A3–A6, Letter, Square20; custom sizes via
  `{ paper: { w, h } }`.
- Paper colour: the studio's Paper panel carries the stock you actually
  loaded (natural white through kraft and black, or any colour by hand).
  It paints under the ink in the preview AND in both exports — the preview
  is ink-truth, so a white gel pen on black stock reads on screen the way
  it will on paper. It changes nothing about the ink or the plot, so
  setting it never re-renders.

## Plotting from the studio

The Plot panel drives an EBB-family (AxiDraw/iDraw) machine over Web
Serial. What's under the hood, briefly, so its knobs make sense:

- **Motion**: host-side look-ahead planning (junction deviation, min-cruise)
  emitted as hardware-interpolated constant-acceleration `LM` commands
  (25 kHz ramps in firmware; falls back to `XM` packets below firmware
  2.5.3 or via the checkbox). Separate acceleration for pen-up travel.
- **Pen cycles**: per-pen `feed` and `penDelay` (the settle at FULL lift).
  With a **lift map** on the machine profile, every travel takes the
  smallest lift that clears along its path (less a margin), and the
  **settle curve** scales the pen's settle down for that lift — the big
  lever on hatch/stipple plots, now per travel and per bed position rather
  than a fixed 40% hop within a distance. Driver and estimator price the
  cycle through one function (`settleAtLift`), so the ETA stays honest.
- **Re-ink pauses**: pens with a `reinkMm` budget (paint markers that need
  pumping, dip pens, brushes) auto-pause at the first stroke boundary past
  that many drawn mm: the carriage parks at the paper origin — the
  gantry's stiffest corner, clear of wet ink — and waits for Resume.
  Steppers stay energized while parked, so handling the pen won't shift
  registration; pump against a scrap sheet, or unclamp the pen and mark
  its clamp depth with a tape collar so it re-seats identically. 0 = off.
- **Position integrity**: the board's step counters are checked against
  dead reckoning at connect, every 500 chains, and at plot end — lost
  commands are healed automatically and flagged. Visible drift mid-plot:
  Pause → jog the pen onto the origin mark → Set origin → Resume (the
  interrupted stroke's remainder stays pen-up; the next chain re-inks).
- **Two origins**: *Set bed origin* zeroes the machine at the bed corner
  the lift map was measured from (same corner every time); *Set paper
  origin* records where the sheet is as an offset, without zeroing. Plots
  draw at the offset; the map reads bed coordinates; Home returns to the
  bed corner.
- **Drawing as code**: which part of the ordered plan is drawn is the
  sketch's own statement, not a panel setting — `t.draw({ progress: [0,
  ui(0.3)] })` (a fraction OF CHAINS, not ink, area or time), `t.draw({
  chains: [120, 400] })` (whole chains, half-open), `t.draw({ minutes:
  [0, 20] })` (an interval of the full plan's estimated timeline,
  quantized to completed chains; the readout shows the effective
  boundaries) and `budget: 20` (keep the longest prefix of that range
  whose standalone estimate fits — a middle stretch pays its own
  travel-in and final lift). Path optimization is the plan's, in code
  too: `t.plan({ optimize: 50_000, bridge: false })`. `ui()` makes any of
  those numbers a slider. The Drawing panel only READS the result: the
  resolved chain range and count (so two nearby values that choose the
  same drawing say so), the standalone ETA against the full plan, the
  path settings — and toggles a preview-only ghost of the omitted ink,
  which never enters exports. Selecting never re-solves visibility,
  reorders, reverses or re-bridges: ink a later shape hid stays hidden
  when that shape is dropped. Export (SVG, G-code, the per-pen table),
  Simulate, Plot and Frame all take the selection; Frame frames the
  selected ink. Headless exports honour `t.draw` too (`exportSvg` /
  `exportGcode`; a range in minutes or a budget needs `timing`).
- **Save result**: keeps exactly this selection as resolved output — the
  selected chains as a plan of their own (exact bytes), the frozen SVG of
  them, pens, paper, machine profile and timing, build stamp, and the
  sketch, source hash and seed as provenance — published only once every
  part is written; records are immutable (delete is the only edit). The
  Results page lists them; *Open frozen in studio* (`/?result=<id>`) shows,
  exports and plots the saved bytes without executing the source and
  without reading the mutable pen library, so later edits to the sketch,
  the pens or the profile never change what was kept. Only the selection
  is saved: a reopened result cannot grow back into the rest of the plan.
- **Resume**: progress (the plan hash, the selected range, the executed
  chain and its full-plan row, pen, paper offset, and the saved result it
  ran from, if any) is saved on the server every few chains. After a
  stop, a crashed tab, or a power loss, *Resume* carries on from that
  chain at the saved offset — only when the current drawing IS the saved
  plan (same hash) with the same range selected; a plot that ran from a
  saved result reopens those bytes instead of regenerating. A mismatch
  refuses rather than pretending. After a power loss, re-park at the bed
  corner and Set bed origin first. *Forget* clears it. A board that stops
  answering mid-plot is recovered automatically (emergency stop, position
  re-read, the chain redone).
- **Pen changes**: no changer — multi-pen sketches plot one pen per run
  via the Plot-pen select; "all pens (one run)" runs a whole multi-pen
  plan with the installed pen, each chain using its own logical pen's
  feed/settle.
- **Diagnostics** (Machine page → Calibration): registration probe (step loss),
  backlash squares, corner ringing at three feeds (junction-deviation
  tuning), plus the `settle-sweep` sketch for finding a pen's true
  `penDelay` floor. **Download serial log** exports the full timestamped
  command transcript — the first artifact to grab when anything misbehaves.
- **Pen-height cards** (Machine page → Calibration, in run order): the servo is open loop and
  the gantry sags, so the only sensor is ink. Seat the pen on a shim the
  same way every time, then let the paper answer in pulse units: the
  **lift traverse** sweeps the raised pen across the whole bed at six lift
  pulses (ink between the edge ticks = where that lift dragged; minutes),
  the **lift grid** hops within each bed cell at the same pulses (a zigzag
  joining the dash ends = dragged; the last clean strip is that cell's
  clearance threshold; the slow truth for short hops), **settle × lift** finds the settle each
  lift needs, and the **down sweep** finds the pen-down pulse at which the
  horn fully releases the pen (first solid hatch patch). The cards are read
  by eye and pasted into the panel (diagonal counts per cell; settle per
  ladder column) to become the profile's `liftMap` and `settleCurve`.
  Machine profile fields are `penUpPulse` (SC,4) and `penDownPulse` (SC,5).
- **ETA**: totals come from the planner's actual trapezoids and blend
  toward measured throughput as the plot runs — the number is honest.
- **Draft plots**: `decimate(0.7, everything)` makes a fast structural
  test plot with a fraction of the ink budget; the seed keeps it
  reproducible when you re-plot the full version.

Real bridge numbers from a shaded A4 piece, for calibration: no bridge
≈ 34,000 lifts / ~11 h; `bridge: mm(0.5)` ≈ 4.4 h; `mm(0.7)` ≈ 2.9 h;
`mm(1)` ≈ 2.3 h — the Debug view's red connectors show what each
tolerance costs visually.
