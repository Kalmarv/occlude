# Device notes

What the studio needs from a machine, how the driver moves it, and how the calibration cards produce a profile. Dated observations, probe transcripts and superseded register names stay in the [iDraw log](#/idraw-log); read that when something misbehaves, not while setting up. The practical plotting workflow is on the Plotting & saving page.

## Machines

- EBB family (AxiDraw, UUNA TEK iDraw and other EiBotBoard clones): the studio's driver. Web Serial (Chrome or Edge, over HTTPS or localhost), 9600 baud, `\r` line ends, the board's own `OK` and `!` replies as pacing, never a fixed delay.
- G-code machines: export only (`exportGcode`, the Export panel); no live driver.

## What a profile holds

A machine profile (Machine page; stored server-side beside the pens) carries the bed size, travel feed, flattening resolution, and for EBB boards the acceleration for drawing and for pen-up travel, junction deviation and minimum cruise ratio (look-ahead planning), the servo pulses for pen up and pen down (`penUpPulse` is SC,4 and `penDownPulse` SC,5), the settle time at full lift, an optional lift map with its margin and settle curve, and whether `LM` or `XM` packets are used. The estimator, the simulation and the driver read the same profile, so an estimate and a plot disagree only by the physical factors the calibration log measures.

## Motion

The driver plans motion host-side with look-ahead (junction deviation, minimum cruise ratio) and emits hardware-interpolated constant-acceleration `LM` commands, which the firmware ramps at 25 kHz. Boards below firmware 2.5.3 have no `LM`; the driver falls back to `XM` packets, also selectable by a checkbox, with the step-rate limits noted in the log. Pen-up travel has its own acceleration.

**The `LM` completion guard — a real firmware trap.** An `LM` axis steps when a 31-bit accumulator overflows; the firmware adds Accel to Rate and Rate to the accumulator every 40 µs, after an initial −Accel/2 adjustment. On a full-speed deceleration to the floor, the continuous maths can put the last step within a fraction of a step of the point where the rate reaches zero, and when rounding lands it on the wrong side **the move never completes and the board's FIFO is wedged for good** — no error, no recovery, a dead plot. It happened in the field: a 252-step deceleration took 251 steps and ran negative. So the driver emulates the firmware for every decelerating block (`lmAxisCompletes` in `ebb.ts`, at most a few thousand ticks) and, while the emulation says it would stall, eases the deceleration toward zero by 1/256 per pass until the axis completes. The block then ends a hair faster than planned — a fraction of a percent of travel speed at the end of a travel, invisible — instead of never ending at all.

The ETA comes from the planner's actual trapezoids through `estimatePlanMs` and blends toward measured throughput as the plot runs. Physical execution is not deterministic the way generated geometry is: the same plan on the same machine varies by pen, paper and temperature. Wall time runs above the estimate by a plot-specific factor that `plotstats --fit` learns from the plot log.

## Pen cycles

Each pen's `feed` and `penDelay` (the settle at full lift) drive the cycle. With a lift map on the profile, every travel takes the smallest lift that clears along its path, less a margin, and the settle curve scales the pen's settle down for that lift. On hatch and stipple plots this is the largest single time saving, and it is decided per travel and per bed position rather than as a fixed short hop. The driver and the estimator price the cycle through one function, `settleAtLift`, so the ETA stays consistent with what the machine does.

Re-ink pauses: a pen with a `reinkMm` budget pauses at the first stroke boundary past that many drawn millimetres. The carriage parks at the bed origin — the corner Set origin zeroed, off the sheet while a paper offset is in play — the gantry's stiffest corner and clear of wet ink, and waits for Resume. Steppers stay energized while parked, so handling the pen does not shift registration. Pump against a scrap sheet, or unclamp the pen and mark its clamp depth with a tape collar so it re-seats the same way.

## Position

The board's step counters are compared with dead reckoning at connect, every `driftCheckEvery` chains (1000 by default, on the Machine page) and at plot end; lost commands are healed and flagged. The check is sparse on purpose: each one drains the FIFO, so checking every 25 chains would cost minutes and visible hitching on a 30 000-chain plot. Two origins: Set bed origin zeroes the machine at the bed corner the lift map was measured from, the same corner every time; Set paper origin records where the sheet is as an offset without zeroing. Plots draw at the offset, the lift map reads bed coordinates, and Home returns to the bed corner. A power loss loses the board's position; re-park at the bed corner and Set bed origin before resuming.

## Calibration cards

The servo is open loop and the gantry sags, so pen height is set in pulse units by reading ink, not a sensor. Seat the pen on a shim the same way every time, then run the cards on the Machine page in this order:

1. Lift traverse sweeps the raised pen across the whole bed at six lift pulses. Ink between the edge ticks shows where that lift dragged.
2. Lift grid hops within each bed cell at the same pulses. A zigzag joining the dash ends means dragged; the last clean strip is that cell's clearance threshold.
3. Settle by lift finds the settle each lift needs.
4. Down sweep finds the pen-down pulse at which the horn fully releases the pen: the first solid hatch patch.

The cards are read by eye and the counts pasted into the panel (diagonal counts per cell, settle per ladder column); they become the profile's `liftMap` and `settleCurve`. Pressure is not software-controllable on these boards (log, section 7).

Other diagnostics on the same page: a registration probe for step loss, backlash squares, corner ringing at three feeds for junction-deviation tuning, and the `settle-sweep` sketch for a pen's true `penDelay` floor. Download serial log exports the full timestamped command transcript.

## What one measured machine looks like

Concrete numbers from the EBB iDraw the cards were designed against, so a
fresh profile has something to compare with. **These are that machine, not
defaults** — the studio ships `penUpPulse: 8600`, `penDownPulse: 18000`,
`seatPulse: 17000` and `liftMarginPulses: 800`, and a tuned machine profile
lives server-side beside the pens.

- **Bed 304.8 × 431.8 mm** (12″ × 17″).
- **Lift map:** 8 × 12 cells. The worst cell needs **13600** and sits at far X,
  middle Y. 54 cells never resolved (they stayed clear to 16000), and row 12
  copies row 11 because the sheet ran out under it.
- **Lift margin 800 pulses** — one ladder rung.
- **Settle curve:** 8600 → 600 ms, 12000 → 600, 12800 → 500, 13600 → 400,
  14400 → 300, 15200 → 200, 16000 → 200. Monotone, and the settle scales with
  lift exactly as the model assumes. **Nothing below 200 ms has ever been
  tested**; that is the floor by choice, not by measurement.
- **All six real pens carry `penDelay` 600** — the settle at full lift, which
  the curve then scales down per travel.
- On this machine the tuned pen-down pulse is **17400**, because the down
  sweep showed the horn releasing completely by 17040. `quickHopMm` is retired:
  the lift map replaced it.

Three findings worth keeping:

1. **The sag is a bowl, not a corner wedge.** It is deepest at middle Y, far X.
   The cutting mat is flat, so what is bending is the frame plus the X
   cantilever. A profile that models sag as a corner tilt will be wrong in the
   middle of the bed.
2. **Travel length matters at full lift.** A sparse, long-travel block needs
   600 ms where dense blocks, tick marks and vertical strokes clear at 500.
   This reverses an earlier finding that only lift height mattered.
3. **The pen-down pulse pays a dead zone on every cycle.** At `penDownPulse`
   18000 the horn has about **2 mm of free travel before it engages the
   slider**, so the lift curve is flat near 18000 and settle — which scales
   with horn travel — pays that dead zone at every lift, at every cycle. Once
   the engagement pulse is known, the down pulse can sit just above it instead.
   At a sagging spot the slider rests higher, so the dead zone shrinks there,
   and the home-corner curve minus the sag map already accounts for that.

**What the map and curve were worth.** Church at seed 42 dropped from **381.0
estimated minutes at full lift to 183.5** with the lift map and settle curve in
the profile. An `lbg-stipple-2` plot run in the deepest part of the bowl came
out with zero drag and zero ghosting, and its wall time was 10.3 minutes
against a model of 10.3 — a ratio of 0.997. That is one plot; the estimator
re-fit against the plot log is only that one plot deep.

## The iDraw H A1

A second, larger machine, and a different world from the EBB iDraw above: a
DrawCore V2.23 board speaking GRBL 1.1h, driven by the studio's GRBL driver
over Web Serial (grbl.ts) or by an exported file. The studio ships it as a
profile preset ("Add preset" on the profile row; `IDRAW_H_A1_PROFILE` in the
studio's store). Everything below was read off the board on 2026-09-16
(working/plotter-report.md, four sessions, nothing written to the board but
`$10=3` for buffer reporting).

- **Frame.** After homing (`$HY` then `$HX`; the board offers single-axis
  homing, and there is no Z switch to hunt for) the head sits at the
  **top-left** with machine 0,0 there, X positive to the right and **Y
  negative down the sheet**: the work area is X 0..594, Y 0..−841. That is
  the profile's `yAxis: 'negative'`; the driver and the export both write
  y' = −y and turn the arcs with it. Soft and hard limits are off, so
  nothing but the two home switches protects the ends of travel.
- **Pen.** A Z axis: **Z0 fully up, Z10 fully down** (85.8 steps/mm, so
  anything not a multiple of 5 mm rounds by up to 0.006). Z5 is mid-travel.
  The heights are the machine's: the profile's `penUp`/`penDown`, which the
  driver, the export and the cards all use (pens carry no Z in the
  studio); the Z ladder card finds the depth that draws at full weight. The
  lift is spring-returned, so a reset or power loss leaves the pen at the
  top. M3/M5 drive the laser channel only.
- **Reset semantics.** Opening or closing the port does not reset the board,
  a soft reset keeps the machine position, and closing the port does not
  stop motion. A soft reset with the pen down **lifts the pen physically
  while the firmware's Z count stays put**; the pen belt then skips if the
  pen-up height is commanded. The profile's `resetLiftsPen` makes the
  driver re-declare the height (`G92 Z`) after every stop and pause instead
  of driving into the stop. Pause is hold → reset → re-declare, so the
  machine is Idle while paused (jog, re-origin, pen up/down all work) and
  resume continues the stroke from where the pen actually stopped.
- **Motion limits.** `$110/$111` 15000/12000 mm/min, `$120/$121` 3000/2000
  mm/s², `$11` 0.010 mm; the profile prices plots with 12000 / 2000 / 0.010
  (the slower axis binds a diagonal), and the driver clamps feeds the way
  the board would silently. Y carries 9 steps (0.090 mm) of backlash
  compensation on reversal, visible in the reported position and not
  accumulating. `$101` = 100 steps/mm measured true over 18 inches.
- **Protocol.** Lines are at most 79 characters; the planner holds 15
  blocks and the serial buffer 128 bytes; `ok` means buffered, not done;
  `G2/G3` work in I/J form (incremental offsets only) and a full circle
  needs an explicit endpoint; check mode (`$C`) still executes `G10`/`G92`
  writes, so never dry-run a file through it. Override bytes sent back to
  back coalesce; the driver does not use them.
- It arrived with a **shipping deviation**: it needed squaring before its
  plots were true.
- The **pen-holder spring was removed.** The same rule as the EBB machine
  applies for a different reason — the pen must rest at a repeatable depth
  rather than be pressed by a spring whose force varies across a sagging bed.

## Measured bridge costs

From one shaded A4 piece, for a sense of scale: without bridging about 34,000 lifts and roughly 11 hours; `bridge: mm(0.5)` about 4.4 hours; `mm(0.7)` about 2.9 hours; `mm(1)` about 2.3 hours. The studio's Debug view draws the connectors in red so each tolerance's visible cost can be judged on the drawing itself.
