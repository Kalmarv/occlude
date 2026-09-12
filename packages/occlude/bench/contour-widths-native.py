#!/usr/bin/env python3
"""python3 contour-widths-native.py <release contour_widths binary> <scene dump>

One isolated serial-native process per hundredth-mm width, with Studio's 20s
limit. stdout is JSONL. Generate the dump with tools/dump-scene.ts and the
committed fixtures/thicken-contour-residual.ts at 304.8x304.8 mm, seed 42.
"""
import json
import subprocess
import sys

binary, scene = sys.argv[1:]
for n in range(1, 101):
    try:
        result = subprocess.run([binary, scene, str(n)], capture_output=True,
                                text=True, timeout=20, check=False)
        rows = [line for line in result.stdout.splitlines() if line.startswith('{')]
        row = json.loads(rows[-1]) if rows else {
            'width': n / 100, 'error': result.stderr[-1000:] or 'no result'}
    except subprocess.TimeoutExpired:
        row = {'width': n / 100, 'error': '20 second timeout', 'ms': 20000}
    print(json.dumps(row), flush=True)
