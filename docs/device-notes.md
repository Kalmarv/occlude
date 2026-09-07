# Device notes

What the studio needs from a machine, how the driver moves it, and how the calibration cards produce a profile. Dated observations, probe transcripts and superseded register names stay in the [iDraw log](#/idraw-log); read that when something misbehaves, not while setting up. The practical plotting workflow is on the Plotting & saving page.

## Machines

- EBB family (AxiDraw, UUNA TEK iDraw and other EiBotBoard clones): the studio's driver. Web Serial (Chrome or Edge, over HTTPS or localhost), 9600 baud, `\r` line ends, the board's own `OK` and `!` replies as pacing, never a fixed delay.
- G-code machines: export only (`exportGcode`, the Export panel); no live driver.

## What a profile holds

A machine profile (Machine page; stored server-side beside the pens) carries the bed size, travel feed, flattening resolution, and for EBB boards the acceleration for drawing and for pen-up travel, junction deviation and minimum cruise ratio (look-ahead planning), the servo pulses for pen up and pen down (`penUpPulse` is SC,4 and `penDownPulse` SC,5), the settle time at full lift, an optional lift map with its margin and settle curve, and whether `LM` or `XM` packets are used. The estimator, the simulation and the driver read the same profile, so an estimate and a plot disagree only by the physical factors the calibration log measures.

## Motion

The driver plans motion host-side with look-ahead (junction deviation, minimum cruise ratio) and emits hardware-interpolated constant-acceleration `LM` commands, which the firmware ramps at 25 kHz. Boards below firmware 2.5.3 have no `LM`; the driver falls back to `XM` packets, also selectable by a checkbox, with the step-rate limits noted in the log. Pen-up travel has its own acceleration.

The ETA comes from the planner's actual trapezoids through `estimatePlanMs` and blends toward measured throughput as the plot runs. Physical execution is not deterministic the way generated geometry is: the same plan on the same machine varies by pen, paper and temperature. Wall time runs above the estimate by a plot-specific factor that `plotstats --fit` learns from the plot log.

## Pen cycles

Each pen's `feed` and `penDelay` (the settle at full lift) drive the cycle. With a lift map on the profile, every travel takes the smallest lift that clears along its path, less a margin, and the settle curve scales the pen's settle down for that lift. On hatch and stipple plots this is the largest single time saving, and it is decided per travel and per bed position rather than as a fixed short hop. The driver and the estimator price the cycle through one function, `settleAtLift`, so the ETA stays consistent with what the machine does.

Re-ink pauses: a pen with a `reinkMm` budget pauses at the first stroke boundary past that many drawn millimetres. The carriage parks at the paper origin, the gantry's stiffest corner and clear of wet ink, and waits for Resume. Steppers stay energized while parked, so handling the pen does not shift registration. Pump against a scrap sheet, or unclamp the pen and mark its clamp depth with a tape collar so it re-seats the same way.

## Position

The board's step counters are compared with dead reckoning at connect, every 500 chains and at plot end; lost commands are healed and flagged. Two origins: Set bed origin zeroes the machine at the bed corner the lift map was measured from, the same corner every time; Set paper origin records where the sheet is as an offset without zeroing. Plots draw at the offset, the lift map reads bed coordinates, and Home returns to the bed corner. A power loss loses the board's position; re-park at the bed corner and Set bed origin before resuming.

## Calibration cards

The servo is open loop and the gantry sags, so pen height is set in pulse units by reading ink, not a sensor. Seat the pen on a shim the same way every time, then run the cards on the Machine page in this order:

1. Lift traverse sweeps the raised pen across the whole bed at six lift pulses. Ink between the edge ticks shows where that lift dragged.
2. Lift grid hops within each bed cell at the same pulses. A zigzag joining the dash ends means dragged; the last clean strip is that cell's clearance threshold.
3. Settle by lift finds the settle each lift needs.
4. Down sweep finds the pen-down pulse at which the horn fully releases the pen: the first solid hatch patch.

The cards are read by eye and the counts pasted into the panel (diagonal counts per cell, settle per ladder column); they become the profile's `liftMap` and `settleCurve`. Pressure is not software-controllable on these boards (log, section 7).

Other diagnostics on the same page: a registration probe for step loss, backlash squares, corner ringing at three feeds for junction-deviation tuning, and the `settle-sweep` sketch for a pen's true `penDelay` floor. Download serial log exports the full timestamped command transcript.

## Measured bridge costs

From one shaded A4 piece, for a sense of scale: without bridging about 34,000 lifts and roughly 11 hours; `bridge: mm(0.5)` about 4.4 hours; `mm(0.7)` about 2.9 hours; `mm(1)` about 2.3 hours. The studio's Debug view draws the connectors in red so each tolerance's visible cost can be judged on the drawing itself.
