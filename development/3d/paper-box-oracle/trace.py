"""Trace sub-grid underside hatch intervals against exact world-space box bounds."""
import oracle
from fractions import Fraction as Q
import json
out=[]
for case in oracle.fixture['cases']:
 for r in case['curves']:
  if not any(b-a<1e-10 for a,b in r['visible']):continue
  f=r['feature'];surface=oracle.objects[f['objectId']]['surface']
  points=[]
  for end in [f['curve']['a'],f['curve']['b']]:
   points.append([sum(Q(w)*Q(surface['points'][v]['position'][k]) for v,w in zip(end['vertices'],end['weights'])) / sum(Q(w) for w in end['weights']) for k in range(3)])
  a,b=points
  expected=oracle.merge([oracle.hidden(a,b,o['bounds'],case['camera']) for o in oracle.objects.values()])
  # Diagnostic negative control only: make the two input bottom coordinates
  # exactly equal, without touching the saved demo or renderer.
  controlled=[]
  for key,o in oracle.objects.items():
   bounds=list(o['bounds'])
   if key=='tower':bounds[2]=(oracle.objects['block']['bounds'][2][0],bounds[2][1])
   controlled.append(oracle.hidden(a,b,bounds,case['camera']))
  shared=oracle.merge(controlled)
  assert len(expected)==len(r['hidden'])==len(shared)==1
  assert 0<expected[0][0]<Q(1,10**12) and shared[0][0]==0
  assert max(abs(float(x)-y) for span,actual in zip(expected,r['hidden']) for x,y in zip(span,actual))<1e-12
  out.append({'sharedBottomControlHidden':[[float(v) for v in s] for s in shared],'case':case['index'],'face':f['attributes']['hatchFace'],'line':f['attributes']['hatchLine'],'worldHidden':[[float(v) for v in s] for s in expected],'rendererHidden':r['hidden'],'worldStart':[float(v) for v in a]})
(oracle.root/'trace.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
