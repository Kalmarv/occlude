# UUNA TEK iDraw — Integration Facts

Empirically verified 2026-08-26 on the physical device (Mac serial session).
Everything below was measured, not assumed. Saved verbatim 2026-08-29 —
this is the ground-truth reference for the EBB driver in
`packages/occlude-studio/src/ebb.ts`.

## 1. Protocol

- EBB (EiBotBoard / AxiDraw). NOT GRBL. No G-code — G21/G90/M5 → `!8 Err: Unknown command`.
- Banner (`V\r`): `EBBv13_and_above EB Firmware Version 2.8.1`
- USB VID 0x04D8 / PID 0xFD92, "EiBotBoard_" / "SchmalzHaus" (Microchip PIC, native CDC-ACM).

## 2. Serial

- /dev/cu.usbmodem1101 @ 115200 (native USB — baud ignored, but Web Serial requires it).
- No reset on open. No banner. No warmup delay. Proven: SL,42 survived close/reopen; `V\r`
  answered 0 ms after open. No reset-guard delay needed.
- Latency ~2.7 ms to first byte.
- `requestPort({filters:[{usbVendorId:0x04D8,usbProductId:0xFD92}]})` →
  `open({baudRate:115200})`

## 3. Framing

- Terminate every command with `\r`. Success = `OK\r\n`. Errors start with `!`.
- ⚠️ V, QG, QM return data with no OK — special-case or a wait-for-OK pump hangs.
- ⚠️ Line endings inconsistent: QP→`1\n\rOK\r\n`, QB→`0\r\nOK\r\n`. Split on `/[\r\n]+/`,
  drop empties.
- ⚠️ Parser reads only the first 2 chars; one bad line can emit two error lines.
- ⚠️ Board buffers until `\r` — a partial write concatenates onto the next command and
  corrupts it. Always write command+`\r` in one `writer.write()`. (This bit me during
  testing.)
- ✅ A bad line does not abort in-flight motion or flush the queue.

## 4. Pacing — use the board's own backpressure

- FIFO depth 2 (1 executing + 1 queued). Verified: 3 back-to-back 600 ms moves → OK, OK,
  then OK delayed 492 ms.
- Write command → await OK → write next. The board throttles you by withholding OK. No
  character counting needed.

## 5. Kinematics — CoreXY, 100 steps/mm, axes rotated 90°

- steps/mm = 100 (2540 steps/inch) at 1/16 microstepping. Verified across 3″/5.5″/8″ drawn
  lines, all within 0.4%.
- QS reports motor space: axis1 = dx + dy, axis2 = dx − dy. Verified (dx=+800→800,800;
  dy=+800→800,-800; diagonal→1600,0).
- Axis directions (verified by drawing): +dx → up the page / away from operator. +dy → right.
- ⚠️ This is a 90° rotation, not a flip. Flip X/Flip Y flags cannot express it. For
  top-left-origin, y-down paper coords:

```js
// paper mm -> machine steps
const mdx = -pdy * 100;   // paper "down"  = -dx
const mdy =  pdx * 100;   // paper "right" = +dy
// motor-space rate limit: 25,000 steps/s per axis (HARD, errors out)
const a1 = mdx + mdy, a2 = mdx - mdy;
const minMs = Math.max(Math.abs(a1), Math.abs(a2)) / 25;
send(`XM,${Math.max(ms, Math.ceil(minMs))},${mdx},${mdy}\r`);
```

- Max rate: exactly 25,000 steps/s per motor axis. 25 steps/1 ms → OK; 26 →
  `!0 Err: <axis1> step rate > 25K steps/second`.
- ⚠️ Clamp in motor space. A 45° paper diagonal puts all displacement on one motor
  (|a2| = 2×), so its ceiling is ~177 mm/s vs 250 mm/s axis-aligned.
- Accuracy: 3″ square measured 3″×3″ with a 4¼″ diagonal → axes symmetric, CoreXY mixing
  correct (bad mixing = correct sides, skewed diagonal).

## 6. Zeroing / homing

- No limit switches, no encoders. Dead-reckoned from power-on. QS counts commanded steps —
  it cannot detect skipped steps.
- `CS` — zeroes the counters. This is "set origin here".
- `HM,<steps_per_sec>` — returns to 0,0. Verified exact from several positions. ⚠️ After any
  manual carriage move, CS again first or HM drives to the wrong place.
- `EM,1,1` motors on @1/16; `EM,0,0` off.

## 7. Pen — servo via SP, and pressure is NOT software-controllable ⚠️

- SP,1 = UP, SP,0 = DOWN. QP reads back (1=up, 0=down). QG bit 4 (0x10): D0=up, C0=down.
- ⚠️ **CORRECTION (2026-08-30, serial-log-verified): SP,1 (up) drives the servo to the
  SC,4 position; SP,0 (down) drives it to SC,5 — standard EBB register semantics,
  the OPPOSITE of the labels below.** The original session never noticed because both
  registers were always set as a pair, which behaves identically under either reading.
  Field bug that exposed it: code adjusting "SC,5 = up" mid-plot actually raised the
  pen-DOWN target and strokes hovered ~2.4mm above paper. On this machine the HIGHER
  pulse (16000/14200) is pen-down; the LOWER (10000) is pen-up. The app's servoDown/
  servoUp setting NAMES remain as-is (paired writes keep behavior consistent) — but
  any code touching ONE register must use the true mapping.
- `SP,<state>,<ms>` queues a settle delay in the FIFO; OK returns immediately (~53 ms). Use
  `SP,0,700` rather than a host sleep.
- ⚠️ **The servo only lifts. It applies no downforce — the pen rests under its own weight.
  SC,4 positions the arm out of the way; it cannot press.**
  - Consequence: zero pressure margin. A 99 mm line failed to draw at all while a 28 mm
    line 90° away drew fine — bed unevenness of a fraction of a mm breaks contact.
  - **The only fix is mechanical: seat the pen deliberately low so it's preloaded into the
    sheet.** After doing so, an 8″ line drew solid.
  - Your app cannot offer a pen-pressure setting. Surface it as a physical setup step in
    the connect flow.
- ⚠️ SR servo auto-power-off. Verified: SR,3000 → power dropped at exactly 3 s idle.
  Default 60 s. On power-off the pen can sag onto the paper — fatal during a pause. `SR,0`
  disables it (verified).
- ~~Current tuned values: `SC,4,10000` (down, **fully down**), `SC,5,16000` (up, ~5–6 mm
  lift). Lift is ~2× more than needed; SC,5,14200 ≈ 2.5–3 mm would speed up plots.~~ SC is
  write-only — no readback, so persist these in the app.
- ⚠️ **CORRECTION (2026-09-05, hand sweep with the horn watched):** SC,4 is the pen-UP
  pulse and the LOWER pulse is the raised horn. The mechanism lifts furthest at
  **SC,4 = 8600** (below that the horn stalls against its travel limit and bounces back; at
  8600 it holds but audibly strains — 9000 is the quiet retreat if the servo runs hot).
  The horn only FULLY clears the slider at pen-down around **SC,5 = 18000** (the bracket
  stops it at ~18200), so the earlier 14200/16000 "down" pulses still carried part of the
  pen's weight — a likely contributor to the pressure dropouts above. With 8600/18000 the
  pen clears the paper at full X extension, where the old pair could not. Settle (penDelay)
  must be re-swept for the ~2.6× longer swing. The app's profile fields are now named
  `penUpPulse` (SC,4) / `penDownPulse` (SC,5); the old `servoDown`/`servoUp` names were
  inverted and are migrated.

## 8. Connect / plot / stop sequences

```
CONNECT (no delay after open):
  V              ; verify banner
  SR,0           ; servo never powers off  <-- critical
  SC,4,8600      ; pen UP pulse (SP,1 target) — see 2026-09-05 correction above
  SC,5,18000     ; pen DOWN pulse (SP,0 target)
  SP,1           ; ensure up
  EM,1,1         ; motors on, 1/16 microstep
  <user parks carriage; app prompts to seat pen LOW>
  CS             ; set origin

PLOT:  SP,0,700 ... XM,<ms>,<mdx>,<mdy> ... SP,1,700
PAUSE: stop sending (FIFO drains <=2 moves). RESUME: re-issue SP before moving.
STOP:  ES  ->  SP,1  ->  HM,2000
END:   SP,1  ->  HM,2000  ->  EM,0,0
```

## 9. Command set (probed by withholding params — nothing executed)

Supported: A AC AM C CK CS CU EM ES HM I LM MR MW ND NI O PC PD PG PI PO QB QC QG QL QM QN
QP QR QS QT RM S2 SC SE SL SM SN SP SR ST T TP V XM BS

Not supported: CB CN **L3 LT** PM QE QU TR

- `AM,<v_init>,<v_final>,<axis1>,<axis2>` — accelerated move, motor space, min velocity 4.
  Verified working; better than fixed-duration XM if you want accel ramps.
- `ES` — abort + clear FIFO, returns `<interrupted>,<fifo1>,<fifo2>,<rem1>,<rem2>`. Panic
  button.
- `QC` → `0372,0818`; 2nd value = V+ supply. Non-zero = motor power connected → "power
  unplugged" warning.
- `QB` — PRG button state, could drive a physical pause.
- Never send: BL (bootloader, drops the port), R/RB (reset), CU,1,0 (disables OK, breaks
  the handshake).

## 10. Progress reporting

QS is motor space — convert back for the preview animation:

```js
const dx = (a1 + a2) / 2, dy = (a1 - a2) / 2;
const paperX = dy / 100, paperY = -dx / 100;   // mm, top-left origin
```

## 11. Known-unreliable / watch for

- No closed-loop feedback of any kind; QS will happily report a perfect square while the
  pen skipped.
- Pen contact is the weak point, not the motion. If lines drop out mid-plot, it's seating
  depth or bed flatness — not the firmware.
