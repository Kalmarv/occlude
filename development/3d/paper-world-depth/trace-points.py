"""Locate collapsed SVG hatch paths among positive world-oracle intervals."""
from pathlib import Path
import json,re,math,os
root=Path(__file__).parent
folder=Path(os.environ.get('OCCLUDE_PAPER_GPU',str(root/'after/gpu')))
oracle=json.loads((root/'after/oracle.json').read_text())
gpu=json.loads((folder/'report.json').read_text())
frame=json.loads((root/'after/cpu.json').read_text())['paper']
results=[]
def snap(x):return math.floor(x/.005+.5)*.005
for expected,actual in zip(oracle['cases'],gpu['results']):
 cam=expected['camera']
 def project(p):
  scale=frame['height']/cam['span'] if cam['kind']=='orthographic' else frame['height']/(-2*p[2]*math.tan(cam['fovDegrees']*math.pi/360))
  return [snap(frame['x']+frame['width']/2+p[0]*scale),snap(frame['y']+frame['height']/2-p[1]*scale)]
 curves={r['id']:r for r in actual['curves']};tiny=[]
 for r in expected['curves']:
  spans=[];lo=0
  for a,b in r['expectedHidden']:
   if a>lo:spans.append([lo,a])
   lo=b
  if lo<1:spans.append([lo,1])
  source=curves[r['id']];a,b=map(project,[source['a'],source['b']])
  for lo,hi in spans:
   if 0<hi-lo<1e-10:
    tiny.append({'id':r['id'],'range':[lo,hi],'points':[[x+(y-x)*t for x,y in zip(a,b)] for t in [lo,hi]]})
 svg=(folder/f"case-{expected['case']}.svg").read_text()
 points=[[float(m[1]),float(m[2])] for m in re.finditer(r'<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"',svg) if m[1]==m[3] and m[2]==m[4]]
 matches=[]
 for point in points:
  def error(r):return max(abs(x-y) for p in r['points'] for x,y in zip(p,point))
  nearest=min(tiny,key=error);distance=error(nearest)
  matches.append({'svgPoint':point,'positiveInterval':nearest,'errorMm':distance})
 results.append({'case':expected['case'],'collapsedPaths':len(points),'matches':matches,'passed':all(r['errorMm']<=.000051 for r in matches)})
report={'passed':all(r['passed'] for r in results),'results':results,'method':'All collapsed SVG paths matched to positive visible intervals from independent world-space box oracle, projected to the existing 0.005mm source grid; no short-interval suppression.'}
(folder/'point-trace.json').write_text(json.dumps(report,indent=2)+'\n')
print({'passed':report['passed'],'cases':[{'case':r['case'],'paths':r['collapsedPaths'],'maxErrorMm':max((m['errorMm'] for m in r['matches']),default=0)} for r in results]})
assert report['passed']
