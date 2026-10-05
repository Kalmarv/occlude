# /// script
# requires-python = ">=3.9"
# dependencies = ["pyserial>=3.5"]
# ///
"""
drawcore.py — drive the iDraw H (DrawCore V2, GRBL 1.1h) from native serial,
with everything logged, to find out why the USB link drops mid-plot.

  uv run drawcore.py info
  uv run drawcore.py plot sketch.gcode            # a real plot (studio: "Save G-code as sent")
  uv run drawcore.py plot sketch.gcode --check    # same lines, GRBL check mode: no motor moves
  uv run drawcore.py plot sketch.gcode --slow-z 3000   # pen lifts as G1 at 3000 mm/min, not G0
  uv run drawcore.py plot sketch.gcode --max-feed 4000 # every feed capped at 4000 mm/min
  uv run drawcore.py plot sketch.gcode --accel 500     # board accelerations at 500 mm/s² for this run, then put back
  uv run drawcore.py plot sketch.gcode --no-lock       # motors on the board's own idle delay (no $1=255)
  uv run drawcore.py soak --pattern z             # pen lifts only, in place
  uv run drawcore.py soak --pattern xy            # small moves only, pen up
  uv run drawcore.py soak --pattern idle          # link traffic only, nothing moves
  uv run drawcore.py soak --pattern loops         # small closed loops with hops, like domain-warping

The plotter is found by its USB id (1a86:8040); --port overrides. Every line
sent and received goes to drawcore-<time>.log, and on macOS the kernel's USB
log goes to drawcore-<time>-usb.log beside it. When the board stops answering,
the script says what the kernel saw, waits for you to replug the USB cable
(plotter still powered), checks where the head is, and carries on.

Before `plot`: in the studio, connect, set the origin and seat the pen as for
a studio plot, press "Save G-code as sent" on the Plot panel, then Disconnect.
Do not power-cycle: the work origin and pen height stay on the board. If the
pen height is missing (after a power cycle), the script declares it itself,
the way the studio does, with the pen at rest = --pen-up.

`soak` moves relative to where the head stands, in machine coordinates, so no
setup is needed beyond the pen being at rest (power-cycled) and scrap paper
under it (--down 7 keeps the nib off the paper).
"""

from __future__ import annotations

import argparse
import math
import platform
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime

import serial
from serial.tools import list_ports

VID, PID = 0x1A86, 0x8040
BAUD = 115200
USB_PREDICATE = ('senderImagePath CONTAINS[c] "IOUSBHost" OR senderImagePath CONTAINS[c] "AppleUSB" '
                 'OR senderImagePath CONTAINS[c] "USBCDC" OR (process == "kernel" AND eventMessage CONTAINS "USB")')
NUM = r'(-?\d+(?:\.\d+)?)'


class Stall(Exception):
    """No reply to a line within the watchdog."""


class Refused(Exception):
    """error: or ALARM from the board."""


# ---- logging ---------------------------------------------------------------------------------------

class Log:
    def __init__(self, path: str):
        self.path = path
        self.f = open(path, 'w', buffering=1)
        self.t0 = time.monotonic()

    def line(self, direction: str, text: str) -> None:
        self.f.write(f'{time.monotonic() - self.t0:10.3f} {direction} {text}\n')

    def note(self, text: str) -> None:
        self.line('#', text)

    def say(self, text: str = '') -> None:
        print(text)
        if text:
            self.note(text)


class KernelUsbLog:
    """macOS only: `log stream` of the USB drivers, kept in memory and on disk."""

    def __init__(self, path: str):
        self.path = path
        self.lines: list[tuple[float, str]] = []
        self.proc = None
        if platform.system() != 'Darwin' or not shutil.which('log'):
            return
        self.out = open(path, 'w', buffering=1)
        self.proc = subprocess.Popen(['log', 'stream', '--info', '--style', 'compact', '--predicate', USB_PREDICATE],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc and self.proc.stdout
        for raw in self.proc.stdout:
            self.out.write(raw)
            self.lines.append((time.time(), raw.rstrip()))

    @property
    def active(self) -> bool:
        return self.proc is not None

    def errors_since(self, t: float) -> list[str]:
        keys = ('transaction error', 'abortGated', 'hardware connection lost', 'terminateDevice', 'not responding', 'stall')
        return [l for (ts, l) in self.lines if ts >= t and any(k in l for k in keys)]

    def stop(self) -> None:
        if self.proc:
            self.proc.terminate()


# ---- the board -------------------------------------------------------------------------------------

def find_port(explicit: str | None) -> str:
    if explicit:
        return explicit
    ports = list(list_ports.comports())
    for p in ports:
        if p.vid == VID and p.pid == PID:
            return p.device.replace('/dev/tty.', '/dev/cu.')
    for p in ports:
        if 'usbmodem' in p.device or 'wchusbserial' in p.device:
            return p.device.replace('/dev/tty.', '/dev/cu.')
    found = ', '.join(f'{p.device} ({p.vid and hex(p.vid)}:{p.pid and hex(p.pid)})' for p in ports) or 'none'
    raise SystemExit(f'No plotter found (USB 1a86:8040). Serial ports: {found}. Pass --port.')


def plotter_present() -> str | None:
    for p in list_ports.comports():
        if p.vid == VID and p.pid == PID:
            return p.device.replace('/dev/tty.', '/dev/cu.')
    return None


class Board:
    def __init__(self, port: str, log: Log, timeout: float):
        self.port_name = port
        self.log = log
        self.timeout = timeout
        self.ser: serial.Serial | None = None
        self.buf = b''
        self.last_rx = time.monotonic()
        self.last_rx_wall = time.time()
        self.sent = 0

    def open(self) -> None:
        self.ser = serial.Serial(self.port_name, BAUD, timeout=0.05)
        self.log.note(f'opened {self.port_name} (pyserial {serial.VERSION}, dtr={self.ser.dtr}, rts={self.ser.rts})')
        time.sleep(0.3)
        self.ser.write(b'\r\n')
        time.sleep(0.2)
        self.read_lines()

    def close(self) -> None:
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None

    def read_lines(self) -> list[str]:
        assert self.ser
        chunk = self.ser.read(self.ser.in_waiting or 1)
        if not chunk:
            return []
        self.last_rx = time.monotonic()
        self.last_rx_wall = time.time()
        self.buf += chunk
        *lines, self.buf = self.buf.replace(b'\r', b'\n').split(b'\n')
        out = []
        for raw in lines:
            line = raw.decode('ascii', 'replace').strip()
            if line:
                self.log.line('<', line)
                out.append(line)
        return out

    def realtime(self, byte: bytes, label: str) -> None:
        assert self.ser
        self.ser.write(byte)
        self.log.line('>', f'(realtime {label})')

    def status(self, timeout: float = 2.0) -> str | None:
        try:
            self.realtime(b'?', '?')
        except Exception as e:
            self.log.note(f'status write failed: {e}')
            return None
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for line in self.read_lines():
                if line.startswith('<'):
                    return line
        return None

    def send(self, line: str, timeout: float | None = None) -> list[str]:
        """One line, then wait for its ok (the studio's pacing)."""
        assert self.ser
        self.ser.write((line + '\n').encode('ascii'))
        self.log.line('>', line)
        self.sent += 1
        started = time.monotonic()
        limit = self.timeout if timeout is None else timeout
        feedback: list[str] = []
        while True:
            for reply in self.read_lines():
                if reply == 'ok':
                    return feedback
                if reply.startswith('error:') or reply.startswith('ALARM'):
                    raise Refused(f'{reply} after {line}')
                if not reply.startswith('<'):
                    feedback.append(reply)
            if time.monotonic() - started > limit:
                raise Stall(line)


def parse_status(st: str) -> dict:
    out: dict = {'state': st.strip('<>').split('|')[0], 'raw': st}
    for key in ('MPos', 'WPos', 'WCO'):
        m = re.search(key + r':' + NUM + ',' + NUM + ',' + NUM, st)
        if m:
            out[key] = tuple(float(v) for v in m.groups())
    return out


def offsets(board: Board) -> dict[str, tuple[float, float, float]]:
    out = {}
    for line in board.send('$#'):
        m = re.match(r'\[(G5[4-9]|G92):' + NUM + ',' + NUM + ',' + NUM, line)
        if m:
            out[m.group(1)] = tuple(float(v) for v in m.groups()[1:])
    return out


def work_position(board: Board) -> tuple[float, float, float] | None:
    st = board.status()
    if not st:
        return None
    s = parse_status(st)
    if 'WPos' in s:
        return s['WPos']
    if 'MPos' not in s:
        return None
    off = offsets(board)
    g54, g92 = off.get('G54', (0, 0, 0)), off.get('G92', (0, 0, 0))
    return tuple(s['MPos'][i] - g54[i] - g92[i] for i in range(3))


def target_of(line: str) -> dict[str, float]:
    if not re.match(r'^(G53\s+)?G0?[01]\b', line):
        return {}
    return {axis: float(m.group(1)) for axis in 'XYZ' if (m := re.search(r'\b' + axis + NUM, line))}


# ---- reports -----------------------------------------------------------------------------------------

def usb_report() -> str:
    if platform.system() != 'Darwin':
        return ''
    for kind in ('SPUSBHostDataType', 'SPUSBDataType'):
        try:
            out = subprocess.run(['system_profiler', kind], capture_output=True, text=True, timeout=20).stdout
        except Exception:
            continue
        blocks = out.split('\n\n')
        for i, b in enumerate(blocks):
            if 'CDC' in b or '0x1a86' in b.lower():
                return '\n'.join(blocks[max(0, i - 1):i + 1]).strip()
    return ''


def identify(board: Board, log: Log) -> dict:
    info = board.send('$I')
    log.say('board:     ' + ' '.join(info))
    settings = board.send('$$')
    log.say('settings:  ' + ' '.join(settings))
    off = offsets(board)
    log.say('offsets:   ' + '  '.join(f'{k} {v[0]:.3f},{v[1]:.3f},{v[2]:.3f}' for k, v in off.items()))
    log.say('parser:    ' + ' '.join(board.send('$G')))
    st = board.status()
    log.say(f'status:    {st or "NO ANSWER"}')
    idle = next((int(float(s.split('=')[1])) for s in settings if s.startswith('$1=')), 25)
    return {'idle_delay': idle, 'offsets': off, 'status': st, 'settings': settings}


# ---- a stall --------------------------------------------------------------------------------------

class Run:
    def __init__(self, args, log: Log, kern: KernelUsbLog):
        self.args = args
        self.log = log
        self.kern = kern
        self.start = time.monotonic()
        self.stalls: list[str] = []

    def minutes(self) -> float:
        return (time.monotonic() - self.start) / 60

    def stalled(self, board: Board, line: str) -> Board | None:
        """Report the stall; with the user's replug, return a reopened board (or None to stop)."""
        silent = time.monotonic() - board.last_rx
        log = self.log
        log.say()
        log.say(f'*** STALL at {self.minutes():.1f} min, line {board.sent}: no reply to "{line}" '
                f'(last byte {silent:.1f} s ago)')
        st = board.status()
        log.say(f'    status query: {st or "NO ANSWER"}')
        if self.kern.active:
            time.sleep(1.0)
            errs = self.kern.errors_since(board.last_rx_wall - 2)
            if errs:
                log.say(f'    macOS kernel USB log: {len(errs)} error lines since the last byte, first:')
                for e in errs[:6]:
                    log.say('      ' + e[:200])
            else:
                log.say('    macOS kernel USB log: no USB errors since the last byte')
        self.stalls.append(f'{self.minutes():.1f} min · line {board.sent} · "{line}" · status {"answered" if st else "silent"}')
        if st:
            log.say('    the board still answers status: the line or its ok was lost, the link is alive')
            return board
        if self.args.no_wait:
            return None
        board.close()
        log.say('    Unplug the plotter\'s USB cable (keep the plotter POWERED), wait 3 s, plug it back in.')
        log.say('    Waiting up to 3 minutes… (Ctrl-C to stop)')
        gone = False
        end = time.monotonic() + 180
        while time.monotonic() < end:
            present = plotter_present()
            if not present:
                gone = True
            elif gone:
                time.sleep(1.5)
                log.say(f'    plotter back on {present}')
                fresh = Board(present, log, self.args.timeout)
                fresh.sent = board.sent
                fresh.open()
                st = fresh.status()
                log.say(f'    status after replug: {st or "NO ANSWER"}')
                if not st:
                    log.say('    the board itself does not answer after a replug: the 328P stopped, not just the USB chip')
                    return None
                return fresh
            time.sleep(0.3)
        log.say('    no replug seen')
        return None

    def resume_line(self, board: Board, line: str) -> bool:
        """After a replug: True when the line already ran (the head is at its target)."""
        target = target_of(line)
        if not target:
            return False
        if line.startswith('G53'):
            st = board.status()
            pos = parse_status(st).get('MPos') if st else None
        else:
            pos = work_position(board)
        if not pos:
            return False
        done = all(abs(pos['XYZ'.index(a)] - v) < 0.15 for a, v in target.items())
        self.log.say(f'    head at {pos[0]:.3f},{pos[1]:.3f},{pos[2]:.3f} — the line '
                     f'{"ran; carrying on after it" if done else "did not run; sending it again"}')
        return done

    def stream(self, board: Board, lines, total: int | None) -> Board:
        last_report = time.monotonic()
        i = 0
        for line in lines:
            i += 1
            while True:
                try:
                    board.send(line)
                    break
                except Stall:
                    fresh = self.stalled(board, line)
                    if fresh is None:
                        raise SystemExit(self.summary(board, failed=True))
                    board = fresh
                    if self.resume_line(board, line):
                        break
            if time.monotonic() - last_report > 30:
                last_report = time.monotonic()
                pct = f' ({100 * i / total:.0f}%)' if total else ''
                print(f'{self.minutes():6.1f} min · {i}{f"/{total}" if total else ""} lines{pct} · {len(self.stalls)} stalls')
        return board

    def summary(self, board: Board, failed: bool = False) -> str:
        lines = ['', '==== summary ====',
                 f'{"STOPPED" if failed else "finished"} after {self.minutes():.1f} min, {board.sent} lines, {len(self.stalls)} stalls']
        lines += [f'  stall: {s}' for s in self.stalls]
        lines += [f'log: {self.log.path}'] + ([f'kernel USB log: {self.kern.path}'] if self.kern.active else [])
        text = '\n'.join(lines)
        self.log.note(text)
        return text


# ---- commands -------------------------------------------------------------------------------------

def connect(args, log: Log) -> Board:
    port = find_port(args.port)
    log.say(f'port:      {port}')
    board = Board(port, log, args.timeout)
    board.open()
    return board


def ensure_pen_frame(board: Board, log: Log, up: float) -> None:
    """The studio's pen-height declaration, when the board has none (after a power cycle)."""
    off = offsets(board)
    if abs(off.get('G92', (0, 0, 0))[2]) > 1e-6:
        log.say(f'pen:       height already declared (G92 Z {off["G92"][2]:.3f}), as the studio left it')
        return
    st = board.status()
    mz = parse_status(st)['MPos'][2] if st else 0.0
    for form in (f'G10 L20 P1 Z{up:.3f}', f'G92 Z{up:.3f}', f'G92 Z{mz - up:.3f}'):
        board.send(form)
        pos = work_position(board)
        if pos and abs(pos[2] - up) <= 0.01:
            log.say(f'pen:       declared pen-up at Z {up:.3f} with "{form}" (pen assumed at rest)')
            return
    log.say('pen:       WARNING — the board did not take a pen-height declaration; heights may be off')


ACCEL_KEYS = ('$120', '$121', '$122')


def set_accel(board: Board, log: Log, settings: list[str], accel: float | None) -> dict[str, str]:
    """Lower the board's accelerations for this run; return the originals to put back."""
    if not accel:
        return {}
    own = {s.split('=')[0]: s.split('=')[1] for s in settings if s.split('=')[0] in ACCEL_KEYS}
    for key in ACCEL_KEYS:
        board.send(f'{key}={accel:.3f}')
    log.say(f'accel:     {", ".join(f"{k} {v}" for k, v in own.items())} → {accel:.0f} for this run')
    return own


def put_accel_back(board: Board, log: Log, own: dict[str, str]) -> None:
    for key, value in own.items():
        try:
            board.send(f'{key}={value}', 3)
        except Exception as e:
            log.say(f'WARNING: could not put {key} back to {value} ({e}); send "{key}={value}" yourself')
            return
    if own:
        log.say('accel:     put back')


def cmd_info(args, log: Log, kern: KernelUsbLog) -> int:
    board = connect(args, log)
    identify(board, log)
    rep = usb_report()
    if rep:
        log.say('usb:\n' + rep)
    board.close()
    return 0


def restore_and_close(board: Board, log: Log, idle: int, up: float, frame: str) -> None:
    try:
        board.realtime(b'!', 'feed hold')
        time.sleep(0.5)
        board.realtime(b'\x18', 'reset')
        time.sleep(1.0)
        board.read_lines()
        board.send(f'$1={idle}', 3)
        board.send(f'{frame}G0 Z{up:.3f}', 5)
    except Exception as e:
        log.note(f'clean stop incomplete: {e}')
    board.close()


def cmd_plot(args, log: Log, kern: KernelUsbLog) -> int:
    lines = [l.strip() for l in open(args.file) if l.strip() and not l.lstrip().startswith((';', '('))]
    if args.check:
        lines = [l for l in lines if not l.startswith('$')]
    if args.slow_z:
        lines = [re.sub(r'^G0 Z' + NUM + '$', lambda m: f'G1 Z{m.group(1)} F{args.slow_z:.0f}', l) for l in lines]
    if args.max_feed:
        cap = args.max_feed
        lines = [re.sub(r'\bF' + NUM, lambda m: f'F{min(float(m.group(1)), cap):.0f}', l) for l in lines]
    if not args.lock:
        lines = [l for l in lines if not l.startswith('$1=')]
    lines = lines * max(1, args.repeat)
    board = connect(args, log)
    ident = identify(board, log)
    log.say(f'file:      {args.file} · {len(lines)} lines'
            + (' · CHECK MODE (no motion)' if args.check else '') + (f' · pen lifts G1 F{args.slow_z:.0f}' if args.slow_z else '')
            + (f' · feeds capped at {args.max_feed:.0f}' if args.max_feed else '') + (f' · accel {args.accel:.0f}' if args.accel else '')
            + ('' if args.lock else ' · no motor lock'))
    if not args.check:
        ensure_pen_frame(board, log, args.pen_up)
    own_accel = set_accel(board, log, ident['settings'], None if args.check else args.accel)
    log.say('starting in 5 s (Ctrl-C to abort)…')
    time.sleep(5)
    run = Run(args, log, kern)
    if args.check:
        log.say('check mode: ' + (' '.join(board.send('$C')) or 'on'))
    try:
        board = run.stream(board, lines, len(lines))
        if args.check:
            board.send('$C')
        put_accel_back(board, log, own_accel)
        print(run.summary(board))
        board.close()
        return 0
    except KeyboardInterrupt:
        print('\nstopping…')
        put_accel_back(board, log, own_accel)
        restore_and_close(board, log, ident['idle_delay'], args.pen_up, '')
        print(run.summary(board, failed=True))
        return 130
    except Refused as e:
        log.say(f'the board refused a line: {e}')
        put_accel_back(board, log, own_accel)
        restore_and_close(board, log, ident['idle_delay'], args.pen_up, '')
        print(run.summary(board, failed=True))
        return 3
    except SystemExit:
        if own_accel:
            log.say('WARNING: the run ended on a dead link; the accelerations are still lowered. After reconnecting, send: '
                    + ' '.join(f'{k}={v}' for k, v in own_accel.items()))
        raise


def soak_lines(args, start: tuple[float, float, float], rng: random.Random):
    """Endless lines of the chosen pattern, in machine coordinates from the start point."""
    x0, y0, z0 = start
    up, hop, down = z0, z0 + args.hop, z0 + args.down
    lift = (lambda z: f'G53 G1 Z{z:.3f} F{args.slow_z:.0f}') if args.slow_z else (lambda z: f'G53 G0 Z{z:.3f}')
    g1 = lambda x, y, f: f'G53 G1 X{x:.3f} Y{y:.3f} F{f:.0f}'
    if args.pattern == 'idle':
        while True:
            yield '$G'
    if args.pattern == 'z':
        while True:
            yield lift(hop)
            yield f'G53 G1 Z{down:.3f} F{args.pen_feed:.0f}'
    x, y = x0 + args.box / 2, y0 - args.box / 2
    while True:
        if args.pattern == 'xy':
            for _ in range(rng.randint(10, 60)):
                a = rng.uniform(0, 2 * math.pi)
                x = min(max(x + 0.6 * math.cos(a), x0 + 2), x0 + args.box - 2)
                y = min(max(y + 0.6 * math.sin(a), y0 - args.box + 2), y0 - 2)
                yield g1(x, y, args.feed)
            x, y = x0 + rng.uniform(5, args.box - 5), y0 - rng.uniform(5, args.box - 5)
            yield g1(x, y, args.travel)
            continue
        # loops: a small closed shape, a drop, chords at the drawing feed, a hop
        r = rng.uniform(0.8, 4.0)
        cx, cy = x0 + rng.uniform(5, args.box - 5), y0 - rng.uniform(5, args.box - 5)
        n = max(3, int(2 * math.pi * r / 0.6))
        wob = [rng.uniform(0.85, 1.15) for _ in range(n)]
        pts = [(cx + r * wob[k] * math.cos(2 * math.pi * k / n), cy + r * wob[k] * math.sin(2 * math.pi * k / n)) for k in range(n)]
        pts.append(pts[0])
        yield g1(*pts[0], args.travel)
        yield f'G53 G1 Z{down:.3f} F{args.pen_feed:.0f}'
        for px, py in pts[1:]:
            yield g1(px, py, args.feed)
        yield lift(hop)


def cmd_soak(args, log: Log, kern: KernelUsbLog) -> int:
    board = connect(args, log)
    ident = identify(board, log)
    st = parse_status(ident['status']) if ident['status'] else {}
    start = st.get('MPos', (0.0, 0.0, 0.0))
    log.say(f'soak:      pattern {args.pattern} for {args.minutes} min from machine '
            f'{start[0]:.3f},{start[1]:.3f},{start[2]:.3f}' + ('' if args.pattern == 'idle' else
            f' · box {args.box} mm · hop +{args.hop} · down +{args.down}' + (f' · lifts G1 F{args.slow_z:.0f}' if args.slow_z else ' · lifts G0')))
    log.say('starting in 5 s (Ctrl-C to abort)…')
    time.sleep(5)
    run = Run(args, log, kern)
    deadline = time.monotonic() + args.minutes * 60
    gen = soak_lines(args, start, random.Random(args.seed))

    def until_deadline():
        for line in gen:
            if time.monotonic() > deadline:
                return
            yield line
    try:
        board.send('G21 G90 G17')
        if args.lock:
            board.send('$1=255')
        board = run.stream(board, until_deadline(), None)
        board.send(f'G53 G0 Z{start[2]:.3f}')
        if args.lock:
            board.send(f'$1={ident["idle_delay"]}')
        board.send(f'G53 G1 X{start[0]:.3f} Y{start[1]:.3f} F{args.travel:.0f}')
        print(run.summary(board))
        board.close()
        return 0
    except KeyboardInterrupt:
        print('\nstopping…')
        restore_and_close(board, log, ident['idle_delay'], start[2], 'G53 ')
        print(run.summary(board, failed=True))
        return 130


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', help='serial port (default: found by USB id 1a86:8040)')
    ap.add_argument('--timeout', type=float, default=10.0, help='seconds without a reply that count as a stall (default 10)')
    ap.add_argument('--no-wait', action='store_true', help='on a stall, report and stop instead of waiting for a replug')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('info', help='identify the board, its settings, offsets and USB connection')
    p = sub.add_parser('plot', help='stream a .gcode file (studio: Save G-code as sent)')
    p.add_argument('file')
    p.add_argument('--check', action='store_true', help='GRBL check mode: every line parsed and acknowledged, no motion')
    p.add_argument('--slow-z', type=float, help='send pen lifts (G0 Z…) as G1 Z… at this feed, mm/min')
    p.add_argument('--repeat', type=int, default=1)
    p.add_argument('--max-feed', type=float, help='cap every F word at this feed, mm/min')
    p.add_argument('--accel', type=float, help='set $120/$121/$122 to this (mm/s²) for the run; the board\'s own values are put back')
    p.add_argument('--no-lock', dest='lock', action='store_false', help='drop the $1= lines: motors on the board\'s own idle delay')
    p.add_argument('--pen-up', type=float, default=0.5, help='work Z of pen-up, if the script must declare it (default 0.5)')
    s = sub.add_parser('soak', help='a synthetic pattern until a stall or the time is up')
    s.add_argument('--pattern', choices=['loops', 'xy', 'z', 'idle'], default='loops')
    s.add_argument('--minutes', type=float, default=30)
    s.add_argument('--box', type=float, default=120, help='mm square the moves stay in (+X, -Y from the start)')
    s.add_argument('--hop', type=float, default=6.0, help='hop height, mm below rest (machine Z, default 6.0)')
    s.add_argument('--down', type=float, default=9.5, help='pen-down, mm below rest (default 9.5; 7 keeps the nib off paper)')
    s.add_argument('--slow-z', type=float, help='pen lifts as G1 at this feed instead of G0')
    s.add_argument('--feed', type=float, default=2000)
    s.add_argument('--travel', type=float, default=8000)
    s.add_argument('--pen-feed', type=float, default=5000)
    s.add_argument('--no-lock', dest='lock', action='store_false', help='leave the motors on the board\'s own idle delay')
    s.add_argument('--accel', type=float, help='set $120/$121/$122 to this (mm/s²) for the run; the board\'s own values are put back')
    s.add_argument('--seed', type=int, default=1)
    args = ap.parse_args()

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    log = Log(f'drawcore-{stamp}.log')
    kern = KernelUsbLog(f'drawcore-{stamp}-usb.log')
    log.say(f'drawcore.py · {args.cmd} · {platform.platform()} · python {platform.python_version()} · log {log.path}'
            + (f' · kernel USB log {kern.path}' if kern.active else ''))
    try:
        return {'info': cmd_info, 'plot': cmd_plot, 'soak': cmd_soak}[args.cmd](args, log, kern)
    except Stall as e:
        log.say(f'the board did not answer "{e}" while setting up (nothing was plotted). '
                'Replug the USB cable or power-cycle the plotter, then run again.')
        return 1
    finally:
        kern.stop()


if __name__ == '__main__':
    sys.exit(main())
