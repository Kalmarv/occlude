"""Independent box visibility oracle using exact rational world coordinates.

No triangulation, camera transform, renderer predicates or interval helpers.
The ray-to-eye intersects a closed axis-aligned box at positive ray parameter.
Eliminating that parameter gives affine constraints along each source edge.
Perspective products' quadratic terms cancel exactly. Inputs are the exact
binary floating point numbers captured from the sketch, not decimal-rounded
model approximations. Cameras here are outside each box in all three axes.
"""
from fractions import Fraction as Q
from pathlib import Path
import json
root=Path(__file__).parent
fixture=json.loads((root/'cpu.json').read_text())
objects={o['id']:o for o in fixture['objects']}
for o in objects.values():
    pts=o['surface']['points']
    o['byId']={p['id']:[Q(v) for v in p['position']] for p in pts}
    o['bounds']=[(min(p['position'][i] for p in pts),max(p['position'][i] for p in pts)) for i in range(3)]
    assert len(pts)==8 and all(all(p['position'][i] in o['bounds'][i] for i in range(3)) for p in pts)

def hidden(a,b,bounds,camera):
    eye=[Q(v) for v in camera['eye']]
    lower=[];upper=[];den=[]
    for i,(low,high) in enumerate(bounds):
        if camera['kind']=='perspective':
            d=[eye[i]-p[i] for p in [a,b]]
            assert d[0]*d[1]>0,'camera coordinate crosses this source edge'
        else:
            d=[Q(camera['eye'][i])-Q(camera['target'][i])]*2
            assert d[0]!=0,'this fixture requires nonzero view directions'
        sign=1 if d[0]>0 else -1
        den.append([sign*v for v in d])
        entry,exit=(Q(low),Q(high)) if sign>0 else (Q(high),Q(low))
        lower.append([sign*(entry-p[i]) for p in [a,b]])
        upper.append([sign*(exit-p[i]) for p in [a,b]])
    # λ > 0 and every entry <= every exit. Closed surface tangencies count,
    # but a surface at the source itself (λ=0 only) does not obscure its ink.
    constraints=[(u,True) for u in upper]
    for i in range(3):
        for j in range(3):
            constraints.append(([upper[j][k]*den[i][k]-lower[i][k]*den[j][k] for k in range(2)],False))
    lo,hi=Q(0),Q(1)
    for (va,vb),strict in constraints:
        if va==vb:
            if va<0 or (strict and va==0):return None
            continue
        if va<0:lo=max(lo,va/(va-vb))
        if vb<0:hi=min(hi,va/(va-vb))
        if strict and max(va,vb)<=0:return None
        if lo>=hi:return None
    return lo,hi

def merge(ranges):
    out=[]
    for lo,hi in sorted(r for r in ranges if r):
        if out and lo<=out[-1][1]:out[-1]=(out[-1][0],max(hi,out[-1][1]))
        else:out.append((lo,hi))
    return out

reports=[];differences=[]
for case in fixture['cases']:
    rows=[]
    for r in case['features']:
        f=r['feature'];assert f['range']==[0,1]
        endpoints=[json.loads(k) for k in f['endpoints']]
        a,b=[objects[obj]['byId'][point] for obj,point in endpoints]
        expected=merge([hidden(a,b,o['bounds'],case['camera']) for o in objects.values()])
        # Endpoint error is reported separately from different interval topology.
        approx=[[float(x) for x in span] for span in expected]
        actual=r['hidden']
        error=max([abs(v-actual[i][k]) for i,span in enumerate(approx) for k,v in enumerate(span)],default=0) if len(approx)==len(actual) else None
        row={'id':f['id'],'world':[list(map(float,a)),list(map(float,b))],'expectedHidden':approx,'actualHidden':actual,'actualVisible':r['visible'],'endpointError':error,'bottom':all(p[2]==Q(objects[f['objectId']]['bounds'][2][0]) for p in [a,b])}
        rows.append(row)
        if error is None or error>1e-12:differences.append({'case':case['index'],**row})
    reports.append({'case':case['index'],'camera':case['camera'],'edges':rows})
result={'cases':reports,'differences':differences,'comparedEdges':sum(len(c['edges']) for c in reports)}
(root/'oracle.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'comparedEdges':result['comparedEdges'],'differences':differences},indent=2))
