#!/usr/bin/env python3
"""Re-run committed CGAL reference fixtures, reporting unsupported input separately."""
import json
import pathlib
import subprocess
import sys

binary = sys.argv[1]
fixtures = json.loads(pathlib.Path(__file__).with_name('fixtures.json').read_text())
for fixture in fixtures:
    data = '\n'.join(' '.join(map(repr, row)) for row in fixture['inputs']) + '\n'
    result = subprocess.run([binary], input=data, text=True, capture_output=True,
                            timeout=30, check=True)
    actual = json.loads(result.stdout)
    assert actual == fixture['expected'], (fixture['name'], actual, fixture['expected'])
    print('PASS', fixture['name'], actual)

result = subprocess.run([binary], input='0 0 1 0 1 1.9999999999999998\n',
                        text=True, capture_output=True, timeout=30)
if result.returncode:
    print('REFERENCE LIMITATION: near-containment rejected by CGAL conic adapter')
    print(result.stderr.strip())
else:
    print('Near-containment now returns; inspect and qualify before adding a golden:', result.stdout)
