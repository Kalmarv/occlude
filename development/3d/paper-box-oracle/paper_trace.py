"""Independent box edges through the saved orthographic paper frame and clip/mask.

Uses the world-space box oracle's intervals, independently projects original
world endpoints, applies the existing 0.005 mm input grid to the full source
edge, then clips the selected interval to the paper composition rectangles.
No renderer projection, stroke assembly, clipping or SVG generation helpers.
"""
from pathlib import Path
import json,math,re
root=Path(__file__).parent
fixture=json.loads((root/'cpu.json').read_text())
case=json.loads((root/'oracle.json').read_text())['cases'][0]
cam=case['camera'];frame=fixture['paper']
def unit(v):
 d=math.hypot(*v);return [x/d for x in v]
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
back=unit([a-b for a,b in zip(cam['eye'],cam['target'])])
right=unit(cross(cam['up'],back));up=cross(back,right)
def snap(x):return math.floor(x/.005+.5)*.005
def project(p):
 d=[x-y for x,y in zip(p,cam['eye'])];scale=frame['height']/cam['span']
 return [snap(frame['x']+frame['width']/2+sum(x*y for x,y in zip(d,right))*scale),snap(frame['y']+frame['height']/2-sum(x*y for x,y in zip(d,up))*scale)]
def rectangle(x,y,w,h):
 scale=215.9*.9/100;offset=215.9*.05
 return [snap(offset+x*scale),snap(offset+y*scale),snap(offset+(x+w)*scale),snap(offset+(y+h)*scale)]
def intersect(a,b,rect):
 lo,hi=0.,1.
 for k in range(2):
  delta=b[k]-a[k]
  if delta==0:
   if a[k]<rect[k] or a[k]>rect[k+2]:return None
  else:
   u,v=sorted([(rect[k]-a[k])/delta,(rect[k+2]-a[k])/delta]);lo=max(lo,u);hi=min(hi,v)
  if lo>=hi:return None
 return lo,hi
def mix(a,b,t):return [x+(y-x)*t for x,y in zip(a,b)]
clip=rectangle(4,6,92,112);mask=rectangle(52,76,44,17)
svg=(root/'gpu/case-0.svg').read_text()
body=re.search(r'<g[^>]*data-pen="graphite"[^>]*>(.*?)</g>',svg,re.S)[1]
actual=[]
for d in re.findall(r'<path d="([^"]+)"',body):
 if re.fullmatch(r'M[\d. -]+L[\d. -]+',d):actual.append([[float(v) for v in p.split()] for p in d[1:].split('L')])
rows=[];matched=set()
for edge in case['edges']:
 a,b=[project(p) for p in edge['world']]
 visible=[];lo=0
 for x,y in edge['expectedHidden']:
  if x>lo:visible.append((lo,x))
  lo=y
 if lo<1:visible.append((lo,1))
 for u,v in visible:
  start,end=mix(a,b,u),mix(a,b,v)
  span=intersect(start,end,clip)
  if not span:continue
  ca,cb=[mix(start,end,t) for t in span]
  removed=intersect(ca,cb,mask)
  ranges=[(0,1)] if removed is None else [(0,removed[0]),(removed[1],1)]
  for lo,hi in ranges:
   if lo>=hi:continue
   projected=[mix(ca,cb,lo),mix(ca,cb,hi)]
   def error(other):return min(max(abs(x-y) for p,q in zip(projected,order) for x,y in zip(p,q)) for order in [other,other[::-1]])
   index=min(range(len(actual)),key=lambda i:error(actual[i]));closest=actual[index];distance=error(closest)
   assert index not in matched,'two expected fragments matched one output fragment'
   matched.add(index)
   rows.append({'id':edge['id'],'world':edge['world'],'bottom':edge['bottom'],'expected':projected,'actual':closest,'errorMm':distance})
report={'passed':all(r['errorMm']<=.000051 for r in rows),'segments':rows,'maxErrorMm':max(r['errorMm'] for r in rows)}
(root/'paper-trace.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':report['passed'],'segments':len(rows),'maxErrorMm':report['maxErrorMm'],'bottom':[r for r in rows if r['bottom']]},indent=2))
assert report['passed']
