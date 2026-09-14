"""Independent Fraction ray/plane/slab oracle for the rational-seam probe.
No Occlude imports or homogeneous predicate code. The two segment endpoints
and the represented camera are inputs; observed intervals are not read.
"""
import json, sys
from fractions import Fraction as F
r=json.load(sys.stdin)
frame=r['frame'];camera=frame['camera'];delta=F(r['z'])
def endpoint(terms):
    weights=[F(t['weight']) for t in terms]
    points=[[F(int(n),int(t['exactWorld'][3])) for n in t['exactWorld'][:3]] for t in terms]
    return [sum(w*p[k] for w,p in zip(weights,points))/sum(weights) for k in range(3)]
def dot(a,b): return sum(x*y for x,y in zip(a,b))
points=[endpoint(t) for t in r['basis']]
eye=list(map(F,camera['eye']));target=list(map(F,camera['target']));back=list(map(F,frame['back']))
direction=[e-t for e,t in zip(eye,target)]
hits=[]
for p in points:
    # Plane x+y+z=1+delta; positive travel is toward the camera.
    distance=(1+delta-sum(p))/sum(direction)
    q=[x+distance*d for x,d in zip(p,direction)]
    depth=dot(back,[e-x for e,x in zip(eye,q)])
    hits.append([q[0],q[1],q[2]-delta,depth-F(camera['near']),F(camera['far'])-depth,distance])
lo,hi=F(0),F(1)
if all(h[-1]<=0 for h in hits):
    print(json.dumps({'hidden':[],'visible':[[0,1]]}));sys.exit()
for va,vb in zip(*hits):
    if va<0 and vb<0: lo=hi;break
    if va<0: lo=max(lo,-va/(vb-va))
    if vb<0: hi=min(hi,va/(va-vb))
if lo>=hi: result={'hidden':[],'visible':[[0,1]]}
else:
    result={'hidden':[[float(lo),float(hi)]],'visible':([[0,float(lo)]] if lo>0 else [])+([[float(hi),1]] if hi<1 else []),'exactRange':[str(lo),str(hi)]}
print(json.dumps(result))
