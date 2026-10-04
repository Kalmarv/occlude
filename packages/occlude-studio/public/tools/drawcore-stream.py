#!/usr/bin/env python3
"""
Stream a long, studio-like plot to the iDraw H (DrawCore V2, GRBL 1.1h) from a
native serial port instead of Chrome's Web Serial, to find out whether the
USB link still wedges when Chrome is not involved.

It sends traffic shaped like the studio's GRBL driver:
  - one line at a time, each waiting for its `ok` (the studio's pacing);
  - `$1=255` at the start (motors locked), `$1=25` back at the end;
  - small closed loops of ~0.6 mm segments at F2000, travels as G1 F8000,
    a G0 hop between loops and a G1 Z… F5000 drop, like `domain-warping`.

Coordinates are machine coordinates (G53 on every motion line), relative to
where the head stands when the script starts, so no work offset on the board
matters and nothing is written to the board's settings except $1, which is
put back. Run it right after a power cycle: the pen's Z is then 0 at its rest
(fully up), so the default heights match the studio's profile:
  up 0.0 (studio penUp 0.5)  hop 6.0 (studio hop 6.5)  down 9.5 (studio penDown 10).

The pattern goes +X (right) and -Y (down the sheet) from the start point.
Put scrap paper there, or pass --down 7 to cycle Z without the nib touching.

Usage:
  pip install pyserial
  python3 drawcore-stream.py /dev/cu.usbmodem201912341 --minutes 30

Or stream a real plot, exactly as the studio would send it: in the studio,
connect, set the origin and seat the pen as for a plot, press "Save G-code as
sent" on the Plot panel, then Disconnect (do NOT power-cycle: the pen height
the studio declared lives in the board until then), and run:
  python3 drawcore-stream.py /dev/cu.usbmodem201912341 --file sketch.gcode

Every line sent and received is written to a log file next to the script.
If the board stops answering, the script says so, stops, and tells you what
to check. Ctrl-C stops cleanly (feed hold, reset, motors released, pen up).
"""

from __future__ import annotations

import argparse
import math
import random
import sys
import time
from datetime import datetime

import serial  # pyserial

REPLY_TIMEOUT_S = 20.0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('port', help='serial port, e.g. /dev/cu.usbmodem201912341')
    ap.add_argument('--minutes', type=float, default=30.0, help='how long to keep plotting (default 30)')
    ap.add_argument('--box', type=float, default=120.0, help='size of the square the loops go in, mm (default 120)')
    ap.add_argument('--up', type=float, default=0.0, help='machine Z for full pen-up (default 0.0)')
    ap.add_argument('--hop', type=float, default=6.0, help='machine Z for the hop between loops (default 6.0)')
    ap.add_argument('--down', type=float, default=9.5, help='machine Z for pen-down (default 9.5; 7 keeps the nib off the paper)')
    ap.add_argument('--feed', type=float, default=2000, help='drawing feed, mm/min (default 2000)')
    ap.add_argument('--travel', type=float, default=8000, help='travel feed, mm/min (default 8000)')
    ap.add_argument('--pen-feed', type=float, default=5000, help='pen-down feed, mm/min (default 5000)')
    ap.add_argument('--idle-delay', type=int, default=25, help="the board's own $1, restored at the end (default 25)")
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--file', help="stream this .gcode file (from the studio's Save G-code as sent) instead of the generated pattern")
    args = ap.parse_args()

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    log_path = f'drawcore-stream-{stamp}.log'
    log = open(log_path, 'w', buffering=1)
    t0 = time.monotonic()

    def note(direction: str, text: str) -> None:
        log.write(f'{time.monotonic() - t0:10.3f} {direction} {text}\n')

    port = serial.Serial(args.port, 115200, timeout=0.05)
    note('<', f'(opened {args.port} with pyserial {serial.VERSION}; dtr={port.dtr} rts={port.rts})')
    buf = b''
    last_rx = time.monotonic()
    sent = 0

    def read_lines() -> list[str]:
        nonlocal buf, last_rx
        chunk = port.read(port.in_waiting or 1)
        if not chunk:
            return []
        last_rx = time.monotonic()
        buf += chunk
        *lines, buf = buf.replace(b'\r', b'\n').split(b'\n')
        out = []
        for raw in lines:
            line = raw.decode('ascii', 'replace').strip()
            if line:
                note('<', line)
                out.append(line)
        return out

    def status(timeout: float = 2.0) -> str | None:
        port.write(b'?')
        note('>', '(realtime ?)')
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for line in read_lines():
                if line.startswith('<'):
                    return line
        return None

    def send(line: str) -> list[str]:
        """Send one line and wait for its ok, as the studio does."""
        nonlocal sent
        port.write((line + '\n').encode('ascii'))
        note('>', line)
        sent += 1
        started = time.monotonic()
        feedback: list[str] = []
        while True:
            for reply in read_lines():
                if reply == 'ok':
                    return feedback
                if reply.startswith('error:') or reply.startswith('ALARM'):
                    raise RuntimeError(f'{reply} after {line}')
                if not reply.startswith('<'):
                    feedback.append(reply)
            if time.monotonic() - started > REPLY_TIMEOUT_S:
                raise TimeoutError(line)

    def stop_cleanly() -> None:
        try:
            port.write(b'!')
            time.sleep(0.5)
            port.write(b'\x18')
            time.sleep(1.0)
            read_lines()
            send(f'$1={args.idle_delay}')
            send(f'G53 G0 Z{args.up:.3f}')
        except Exception as e:  # the link may be the thing that died
            note('<', f'(clean stop incomplete: {e})')

    # Wake up and identify the board.
    time.sleep(0.3)
    port.write(b'\r\n')
    time.sleep(0.2)
    read_lines()
    info = send('$I')
    print('board:', ' '.join(info))
    st = status()
    if not st:
        print('No status report from the board. Is the studio disconnected and the port right?')
        return 2
    mpos = st.split('MPos:')[1].split('|')[0].split(',') if 'MPos:' in st else None
    if not mpos:
        print(f'Unexpected status report: {st}')
        return 2
    x0, y0, z0 = (float(v) for v in mpos[:3])

    if args.file:
        lines = [l.strip() for l in open(args.file) if l.strip() and not l.lstrip().startswith((';', '('))]
        offsets = send('$#')
        g92 = next((o for o in offsets if o.startswith('[G92:')), '[G92:?]')
        print(f'file: {args.file} · {len(lines)} lines · log: {log_path}')
        print(f'board now: {st}  {g92}')
        if g92.endswith(',0.000]'):
            print('note: no pen-height offset on the board (G92 Z is 0). Connect with the studio first,')
            print('then Disconnect without power-cycling, so the pen heights match a studio plot.')
        print('starting in 5 s (Ctrl-C to abort)…')
        time.sleep(5)
        try:
            for i, line in enumerate(lines, 1):
                send(line)
                if i % 500 == 0:
                    print(f'{(time.monotonic() - t0) / 60:6.1f} min · {i}/{len(lines)} lines · all acknowledged')
            print(f'DONE: {len(lines)} lines, no stall. Log: {log_path}')
            return 0
        except TimeoutError as e:
            silent = time.monotonic() - last_rx
            note('<', f'(no reply to {e} after {REPLY_TIMEOUT_S:.0f} s; last byte {silent:.1f} s ago)')
            st2 = status()
            note('<', f'(status after the stall: {st2 or "none"})')
            print()
            print(f'STALL after {sent} lines: no reply to "{e}" in {REPLY_TIMEOUT_S:.0f} s.')
            print(f'Status query after the stall: {st2 or "NO ANSWER"}')
            print(f'Log: {log_path}')
            return 1
        except KeyboardInterrupt:
            print('\nstopping…')
            stop_cleanly()
            print(f'stopped by you after {sent} lines. Log: {log_path}')
            return 130
        except RuntimeError as e:
            print(f'the board refused a line: {e}')
            stop_cleanly()
            return 3
        finally:
            port.close()
            log.close()
    print(f'start: machine X{x0:.3f} Y{y0:.3f} Z{z0:.3f}; log: {log_path}')
    if abs(z0 - args.up) > 0.05:
        print(f'note: machine Z is {z0:.3f}, not {args.up:.3f}. Power-cycle first so the pen heights match.')

    rng = random.Random(args.seed)
    deadline = time.monotonic() + args.minutes * 60
    loops = 0

    def g53(x: float, y: float, feed: float) -> str:
        return f'G53 G1 X{x:.3f} Y{y:.3f} F{feed:.0f}'

    try:
        send('G21 G90 G17')
        send('$1=255')
        send(f'G53 G0 Z{args.up:.3f}')
        while time.monotonic() < deadline:
            # One small closed loop, like an isoline face: radius 0.8–4 mm,
            # 0.6 mm chords, somewhere in the box.
            r = rng.uniform(0.8, 4.0)
            cx = x0 + rng.uniform(5, args.box - 5)
            cy = y0 - rng.uniform(5, args.box - 5)
            n = max(3, int(2 * math.pi * r / 0.6))
            wobble = [rng.uniform(0.85, 1.15) for _ in range(n)]
            pts = [(cx + r * wobble[k] * math.cos(2 * math.pi * k / n),
                    cy + r * wobble[k] * math.sin(2 * math.pi * k / n)) for k in range(n)]
            pts.append(pts[0])
            send(g53(pts[0][0], pts[0][1], args.travel))
            send(f'G53 G1 Z{args.down:.3f} F{args.pen_feed:.0f}')
            for x, y in pts[1:]:
                send(g53(x, y, args.feed))
            send(f'G53 G0 Z{args.hop:.3f}')
            loops += 1
            if loops % 50 == 0:
                mins = (args.minutes * 60 - (deadline - time.monotonic())) / 60
                print(f'{mins:6.1f} min · {loops} loops · {sent} lines · all acknowledged')
        send(f'G53 G0 Z{args.up:.3f}')
        send(f'$1={args.idle_delay}')
        send(g53(x0, y0, args.travel))
        print(f'DONE: {args.minutes} min, {loops} loops, {sent} lines, no stall. Log: {log_path}')
        return 0
    except TimeoutError as e:
        silent = time.monotonic() - last_rx
        note('<', f'(no reply to {e} after {REPLY_TIMEOUT_S:.0f} s; last byte {silent:.1f} s ago)')
        st = status()
        note('<', f'(status after the stall: {st or "none"})')
        print()
        print(f'STALL after {sent} lines / {loops} loops: no reply to "{e}" in {REPLY_TIMEOUT_S:.0f} s.')
        print(f'Status query after the stall: {st or "NO ANSWER"}')
        print('Now, with the plotter still powered: unplug only the USB cable for 5 s, plug it back,')
        print('connect in the studio and Copy debug info. Paste that and this log here.')
        print(f'Log: {log_path}')
        return 1
    except KeyboardInterrupt:
        print('\nstopping…')
        stop_cleanly()
        print(f'stopped by you after {sent} lines / {loops} loops. Log: {log_path}')
        return 130
    except RuntimeError as e:
        print(f'the board refused a line: {e}')
        stop_cleanly()
        return 3
    finally:
        port.close()
        log.close()


if __name__ == '__main__':
    sys.exit(main())
