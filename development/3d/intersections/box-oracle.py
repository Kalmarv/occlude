"""Independent exact oracle for contacts between axis-aligned box surfaces.

Coordinates are converted with Fraction.from_float, preserving the represented
binary64 values. The implementation has no Occlude imports or predicates.
"""
from fractions import Fraction as F
import json, math, sys

def q(v): return F.from_float(float(v))
def box(lo, hi): return tuple((q(lo[i]), q(hi[i])) for i in range(3))
def faces(b):
    for axis in range(3):
        for side in (0, 1): yield axis, b[axis][side], [i for i in range(3) if i != axis], b
def enc(v): return str(v.numerator) if v.denominator == 1 else f'{v.numerator}/{v.denominator}'
def point(p): return [enc(x) for x in p]
def endpoint(axis, fixed, value):
    p = [None, None, None]; p[axis] = value
    for i, x in fixed.items(): p[i] = x
    return tuple(p)

def contacts(a, b):
    segments, points = set(), set()
    for ax, av, au, _ in faces(a):
        for bx, bv, bu, _ in faces(b):
            if ax == bx:
                if av != bv: continue
                u, v = au
                lo_u, hi_u = max(a[u][0], b[u][0]), min(a[u][1], b[u][1])
                lo_v, hi_v = max(a[v][0], b[v][0]), min(a[v][1], b[v][1])
                if lo_u > hi_u or lo_v > hi_v: continue
                fixed = {ax: av}
                if lo_u == hi_u and lo_v == hi_v: points.add(tuple({**fixed, u:lo_u, v:lo_v}[i] for i in range(3)))
                elif lo_u == hi_u:
                    for x, y in ((lo_v, hi_v),): segments.add((endpoint(v, {**fixed, u:lo_u}, x), endpoint(v, {**fixed, u:lo_u}, y)))
                elif lo_v == hi_v:
                    segments.add((endpoint(u, {**fixed, v:lo_v}, lo_u), endpoint(u, {**fixed, v:lo_v}, hi_u)))
                else:
                    segments.update(((endpoint(u, {**fixed, v:lo_v}, lo_u), endpoint(u, {**fixed, v:lo_v}, hi_u)), (endpoint(u, {**fixed, v:hi_v}, lo_u), endpoint(u, {**fixed, v:hi_v}, hi_u)), (endpoint(v, {**fixed, u:lo_u}, lo_v), endpoint(v, {**fixed, u:lo_u}, hi_v)), (endpoint(v, {**fixed, u:hi_u}, lo_v), endpoint(v, {**fixed, u:hi_u}, hi_v))) )
            else:
                # Intersection line is parallel to the remaining axis.
                rem = ({0,1,2} - {ax,bx}).pop()
                if not (a[bx][0] <= bv <= a[bx][1] and b[ax][0] <= av <= b[ax][1]): continue
                lo, hi = max(a[rem][0], b[rem][0]), min(a[rem][1], b[rem][1])
                if lo > hi: continue
                fixed = {ax: av, bx: bv}
                if lo == hi: points.add(endpoint(rem, fixed, lo))
                else: segments.add((endpoint(rem, fixed, lo), endpoint(rem, fixed, hi)))
    # Canonicalize and merge collinear adjacent intervals.
    rows = {}
    for a0, b0 in segments:
        axis = next(i for i in range(3) if a0[i] != b0[i]); fixed = tuple(a0[i] for i in range(3) if i != axis)
        lo, hi = sorted((a0[axis], b0[axis])); rows.setdefault((axis, fixed), []).append((lo, hi))
    merged = []
    for (axis, fixed), intervals in rows.items():
        out = []
        for lo, hi in sorted(intervals):
            if out and lo <= out[-1][1]: out[-1] = (out[-1][0], max(out[-1][1], hi))
            else: out.append((lo, hi))
        for lo, hi in out:
            aa = list(fixed); bb = list(fixed); ai = [i for i in range(3) if i != axis]
            aa.insert(axis, lo); bb.insert(axis, hi); merged.append((tuple(aa), tuple(bb)))
    covered = set()
    for p in points:
        if any(all(min(a0[i], b0[i]) <= p[i] <= max(a0[i], b0[i]) for i in range(3)) for a0,b0 in merged): continue
        covered.add(p)
    return {'segments': [[point(x), point(y)] for x,y in sorted(merged)], 'points': [point(x) for x in sorted(covered)]}

def fixtures():
    u = math.nextafter(1.0, math.inf); z = math.nextafter(0.0, math.inf)
    cases = [
      ('identical', box([-1,-1,-1],[1,1,1]), box([-1,-1,-1],[1,1,1])),
      ('offset', box([0,0,0],[2,2,2]), box([1,0,0],[3,2,2])),
      ('shared-face', box([0,0,0],[1,1,1]), box([1,0,0],[2,1,1])),
      ('edge', box([0,0,0],[1,1,1]), box([1,1,0],[2,2,1])),
      ('vertex', box([0,0,0],[1,1,1]), box([1,1,1],[2,2,2])),
      ('disjoint', box([0,0,0],[1,1,1]), box([2,0,0],[3,1,1])),
      ('ulp-gap', box([0,0,0],[1,1,1]), box([u,0,0],[u+1,1,1])),
      ('nested', box([-2,-2,-2],[2,2,2]), box([-1,-1,-1],[1,1,1])),
      ('scale-small', box([-2**-20,-2**-20,-2**-20],[2**-20,2**-20,2**-20]), box([-2**-20,-2**-20,-2**-20],[2**-20,2**-20,2**-20])),
      ('scale-large', box([-2**20,-2**20,-2**20],[2**20,2**20,2**20]), box([-2**20,-2**20,-2**20],[2**20,2**20,2**20])),
    ]
    for i in range(30):
        x, y, z0 = (i % 5 - 2) * .25, ((i * 3) % 5 - 2) * .25, ((i * 7) % 5 - 2) * .25
        cases.append((f'generic-{i:02d}', box([-1,-1,-1],[1,1,1]), box([x,y,z0],[x+1.5,y+1.5,z0+1.5])))
    return [{'id': name, 'a': [[float(x) for x in row] for row in aa], 'b': [[float(x) for x in row] for row in bb], 'expected': contacts(aa,bb)} for name,aa,bb in cases]

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--fixtures': print(json.dumps(fixtures(), separators=(',', ':')))
    else:
        data = json.load(sys.stdin)
        aa = tuple(tuple(q(x) for x in row) for row in data['a'])
        bb = tuple(tuple(q(x) for x in row) for row in data['b'])
        print(json.dumps(contacts(aa, bb)))
