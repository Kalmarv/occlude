# Device notes

What the studio needs from a machine today, in one place. Dated
observations, probe transcripts and superseded register names stay in
the [iDraw log](#/idraw-log); read that when something misbehaves, not
while setting up.

## Machines

- **EBB family** (AxiDraw, UUNA TEK iDraw and other EiBotBoard clones):
  the studio's driver. Web Serial (Chrome or Edge, over HTTPS or
  localhost), 9600 baud, `\r` line ends, the board's own `OK`/`!`
  replies as pacing — never a fixed delay.
- **G-code machines**: export only (`exportGcode`, the Export panel);
  no live driver.

## What a profile holds

A machine profile (Machine page; stored server-side beside the pens)
carries the bed size, travel feed, flattening resolution, and for EBB
boards the acceleration for drawing and for pen-up travel, junction
deviation and minimum cruise ratio (look-ahead planning), the servo
pulses for pen up and pen down, the settle time at full lift, an
optional lift map with its margin and settle curve, and whether `LM`
(hardware-interpolated acceleration; firmware ≥ 2.5.3) or `XM` packets
are used. The estimator, the simulation and the driver read the same
profile, so an estimate and a plot disagree only by the physical factors
the calibration log measures.

## Setting up a plot

1. Connect on the Plot panel. The board's step counters are read and
   compared with dead reckoning at connect, every 500 chains and at the
   end; lost commands are healed and reported.
2. Park the carriage at the bed corner the lift map was measured from
   and **Set bed origin**. Place the sheet and **Set paper origin** (an
   offset; nothing is zeroed).
3. **Frame** traces the selected ink's bounding box pen-up at the paper
   offset — the placement check no model can do.
4. Pick the pen to plot (one pen per run; there is no changer). Plot.
   Progress, the estimate and the resume record update as it runs.
5. Pause → jog the pen onto the origin mark → Set origin → Resume is the
   drift-recovery flow. Re-ink pauses park at the paper origin and wait.

## Pen height and pressure

The servo is open loop and the gantry sags, so pen height is set in
pulse units by ink, not by a sensor: the calibration cards on the
Machine page (lift traverse, lift grid, settle sweep) are the procedure.
Pressure is not software-controllable on these boards (see the log,
section 7).

## Known limits

- Physical execution is not deterministic the way generated geometry
  is: the same plan on the same machine varies by pen, paper and
  temperature. The estimator prices commanded moves and settles; wall
  time runs above it by a plot-specific factor that `plotstats --fit`
  learns from the plot log.
- A power loss loses the board's position; re-park at the bed corner and
  Set bed origin before resuming.
- Firmware below 2.5.3 has no `LM`; the driver falls back to `XM`
  packets, with the step-rate limits noted in the log.
