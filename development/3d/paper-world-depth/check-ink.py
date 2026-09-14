"""Independent exact ray/triangle checks of the changed terrain/forest ink.
The float broad phase only rejects well separated misses; ambiguous hits go
through rational Moller-Trumbore, independent of renderer halfspace clipping.
"""
import json
from fractions import Fraction as F
from pathlib import Path
p=Path(__file__).parent/'ink'
old={r['id']:r for r in json.loads((p/'before.svg.json').read_text())}
new=json.loads((p/'after.svg.json').read_text())
w=json.loads((p/'after.svg.world.json').read_text())[0]
def sub(a,b):return tuple(x-y for x,y in zip(a,b))
def dot(a,b):return sum(x*y for x,y in zip(a,b))
def cross(a,b):return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
d=sub(tuple(map(F,w['camera']['eye'])),tuple(map(F,w['camera']['target'])))
df=tuple(map(float,d))
triangles=[]
for r in w['triangles']:
 a,b,c=[tuple(map(F,v)) for v in r['points']];e1=sub(b,a);e2=sub(c,a);h=cross(d,e2);det=dot(e1,h)
 if not det:continue
 af=tuple(map(float,a));ef=tuple(map(float,e1));hf=tuple(map(float,h));e2f=tuple(map(float,e2))
 triangles.append((r['id'],a,e1,e2,h,det,af,ef,e2f,hf,float(det)))
def hidden(point,support):
 pf=tuple(map(float,point))
 for ident,a,e1,e2,h,det,af,ef,e2f,hf,detf in triangles:
  if ident in support:continue
  # Broad phase has a generous uncertainty band only to select exact tests.
  if abs(detf)>1e-8:
   sf=sub(pf,af);uf=dot(sf,hf)/detf;qf=cross(sf,ef);vf=dot(df,qf)/detf;tf=dot(e2f,qf)/detf
   if uf < -1e-8 or vf < -1e-8 or uf+vf > 1+1e-8 or tf < -1e-8:continue
  s=sub(point,a);u=dot(s,h)/det
  if u<0 or u>1:continue
  q=cross(s,e1);v=dot(d,q)/det
  if v<0 or u+v>1:continue
  t=dot(e2,q)/det
  if t>0:return ident
 return None
def endpoints(basis):
 return [tuple(sum(F(term['world'][k])*F(term['weight']) for term in terms)/sum(F(term['weight']) for term in terms) for k in range(3)) for terms in basis]
def contains(spans,t):return any(a<t<b for a,b in spans)
changed=[];samples=0;before_wrong=[];after_wrong=[]
for row in new:
 prev=old[row['id']]
 if len(prev['hidden'])==len(row['hidden']) and all(abs(a-b)<1e-10 for x,y in zip(prev['hidden'],row['hidden']) for a,b in zip(x,y)):continue
 changed.append(row['id']);bounds=sorted(set([0.,1.]+[x for span in prev['hidden']+row['hidden'] for x in span]));ts=[(a+b)/2 for a,b in zip(bounds,bounds[1:]) if b-a>1e-9]
 a,b=endpoints(row['basis'])
 for t in ts:
  ft=F(t);point=tuple(x+(y-x)*ft for x,y in zip(a,b));hit=hidden(point,set(row['support']));samples+=1
  expected=hit is not None;entry={'id':row['id'],'t':t,'hidden':expected,'occluder':hit}
  if contains(prev['hidden'],t)!=expected:before_wrong.append(entry)
  if contains(row['hidden'],t)!=expected:after_wrong.append(entry)
report={'changedFeatures':len(changed),'checkedInteriorSamples':samples,'beforeMismatches':before_wrong,'afterMismatches':after_wrong,'method':'Exact rational Moller-Trumbore on original world triangles; interval interiors separated by >1e-9; conservative float candidate rejection; no renderer predicates.'}
(p/'ray-oracle.json').write_text(json.dumps(report,indent=2)+'\n')
print({k:len(v) if isinstance(v,list) else v for k,v in report.items()},flush=True)
assert not after_wrong
assert before_wrong
