import { orient2d } from 'robust-predicates';
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
import { resolveLen, type L, type UnitCtx } from '../../units.js';
import { measureFaces3, snapshotSurface3, type FaceMeasure3 } from '../geometry/model.js';
import type { Attributes3, Surface3 } from '../geometry/surface.js';
import { clipTriangle3, toCamera3, toPaper3, type CameraFrame3 } from '../camera.js';
import { add3, mul3, type Triangle3, type Vec3 } from '../math.js';
import { intersectPlane3, type Plane3 } from './plane.js';
import { freezeCurves3, type SurfaceCurvePoint3, type SurfaceCurveSegment3, type SurfaceCurves3 } from './surface.js';

export interface HatchFamily3 {
  readonly id:string;
  /** Physical paper spacing; bare numbers retain normal drawable-percent units. */
  readonly spacing:L;
  /** Degrees in paper coordinates, clockwise from right. */
  readonly angle:number;
  readonly offset?:L;
  readonly attributes?:Attributes3;
}
export interface HatchSource3 {
  readonly surface:Surface3;
  readonly families:readonly (readonly HatchFamily3[])[];
  readonly maxSegments:number;
}
function validateFamilies3(values:readonly HatchFamily3[]):void {
  if(new Set(values.map(v=>v.id)).size!==values.length||values.some(v=>!v.id||!Number.isFinite(v.angle)))throw new Error('hatch families need unique IDs per face and finite angles');
  for(const value of values) {
    const spacing=resolveLen(value.spacing,{innerW:100,innerH:100}),offset=resolveLen(value.offset??0,{innerW:100,innerH:100});
    if(!Number.isFinite(spacing)||spacing<=0||!Number.isFinite(offset))throw new Error('hatch spacing must be positive and finite, with a finite offset');
  }
}
/** Capture per-face drawing intent now; generate at the resolved camera/paper.
 * A second family is crosshatch. Callbacks run once against frozen model rows. */
export function hatch3(input:Surface3,families:readonly HatchFamily3[]|((face:FaceMeasure3)=>readonly HatchFamily3[]),options:{maxSegments?:number}={}):HatchSource3 {
  const surface=snapshotSurface3(input),maxSegments=options.maxSegments??Infinity;
  if(!(maxSegments===Infinity||Number.isSafeInteger(maxSegments))||maxSegments<1)throw new Error('hatch maxSegments must be a positive integer or Infinity');
  const rows=measureFaces3(surface).map(face=>{
    const values=typeof families==='function'?families(Object.freeze({...face,attributes:freezeCurves3(face.attributes)})):families;
    validateFamilies3(values);
    return values.map(value=>freezeCurves3(structuredClone(value)));
  });
  return freezeCurves3({surface,families:rows,maxSegments});
}
export function validateHatch3(hatch:HatchSource3,surface:Surface3):void {
  if(hatch.surface!==surface)throw new Error('hatch belongs to a different captured surface; draw hatch.surface or regenerate it');
  if(hatch.families.length!==surface.faces.length||!(hatch.maxSegments===Infinity||Number.isSafeInteger(hatch.maxSegments))||hatch.maxSegments<1)throw new Error('invalid captured hatch families or capacity');
  hatch.families.forEach(validateFamilies3);
}
const edgeKey=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
/** A paper ruling lifts to a plane through the eye (perspective), or a parallel
 * plane (orthographic). Intersecting source triangles gives exact perspective
 * weights without screen-linear interpolation of world positions. */
function rulingPlane(frame:CameraFrame3,nx:number,ny:number,offset:number,id:string,attributes:Attributes3):Plane3 {
  const cx=frame.paper.x+frame.paper.width/2,cy=frame.paper.y+frame.paper.height/2;
  const base=add3(mul3(frame.right,nx),mul3(frame.up,-ny));
  if(frame.camera.kind==='orthographic') {
    const c=(nx*cx+ny*cy-offset)*frame.camera.span/frame.paper.height;
    return {id,normal:base,origin:add3(frame.camera.eye,mul3(base,-c)),attributes};
  }
  const focal=frame.paper.height/(2*Math.tan(frame.camera.fovDegrees*Math.PI/360));
  return {id,normal:add3(base,mul3(frame.back,-(nx*cx+ny*cy-offset)/focal)),origin:frame.camera.eye,attributes};
}

/** Rulings cost the paper, not the face: a face seen from close by projects far
 * beyond the sheet, and rulings out there (or the parts of a ruling out there)
 * can never leave ink on it. The sheet is widened by one sheet diagonal on
 * every side so styles that reach past the edge keep their anchors. */
function sheetOverscan(frame:CameraFrame3):number{return Math.hypot(frame.paper.width,frame.paper.height);}
/** The widened sheet's extent along a ruling normal. */
function sheetBand(frame:CameraFrame3,nx:number,ny:number):readonly [number,number] {
  const r=frame.paper,overscan=sheetOverscan(frame);
  const d=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,y])=>nx*x+ny*y);
  return [Math.min(...d)-overscan,Math.max(...d)+overscan];
}
/** Parameters of the part of a world segment that projects inside the widened
 * sheet: the four side constraints are linear in camera space under either
 * projection, so this is Liang–Barsky. Near/far are left to the features. */
function sheetRange(frame:CameraFrame3,a:Vec3,b:Vec3):readonly [number,number]|null {
  const r=frame.paper,c=frame.camera,overscan=sheetOverscan(frame),aspect=r.width/r.height;
  const ca=toCamera3(frame,a),cb=toCamera3(frame,b);
  const x=[-1-2*overscan/r.width,1+2*overscan/r.width],y=[-1-2*overscan/r.height,1+2*overscan/r.height];
  // f(p) >= 0 inside, for each side; perspective scales by depth d = -z.
  const sides:((p:Vec3)=>number)[]=c.kind==='orthographic'
    ?[p=>x[1]*c.span*aspect-2*p[0],p=>2*p[0]-x[0]*c.span*aspect,p=>y[1]*c.span-2*p[1],p=>2*p[1]-y[0]*c.span]
    :(()=>{const k=1/Math.tan(c.fovDegrees*Math.PI/360);return [(p:Vec3)=>x[1]*aspect*-p[2]-k*p[0],(p:Vec3)=>k*p[0]-x[0]*aspect*-p[2],(p:Vec3)=>y[1]*-p[2]-k*p[1],(p:Vec3)=>k*p[1]-y[0]*-p[2]];})();
  let lo=0,hi=1;
  for(const side of sides){
    const va=side(ca),vb=side(cb);
    if(va<0&&vb<0)return null;
    if(va<0)lo=Math.max(lo,va/(va-vb));
    if(vb<0)hi=Math.min(hi,va/(va-vb));
  }
  return lo<hi?[lo,hi]:null;
}
/** A point part-way along a ruling piece, in the piece's own triangle. */
function alongPiece(world:Surface3,piece:SurfaceCurveSegment3,t:number,id:string):SurfaceCurvePoint3 {
  const tri=world.triangles[piece.triangles[0]].vertices;
  const bary=(p:SurfaceCurvePoint3):Vec3=>{const w=[0,0,0];p.vertices.forEach((v,i)=>{const k=tri.indexOf(v);if(k<0)throw new Error('ruling piece vertex outside its triangle');w[k]+=p.weights[i];});return w as unknown as Vec3;};
  const wa=bary(piece.a),wb=bary(piece.b),weights=wa.map((v,i)=>v+(wb[i]-v)*t) as unknown as Vec3;
  return freezeCurves3({id,position:add3(piece.a.position,mul3(add3(piece.b.position,mul3(piece.a.position,-1)),t)),vertices:[tri[0],tri[1],tri[2]] as const,weights});
}
/** Group ruling pieces of one plane into runs joined at shared nodes, oriented
 * head to tail, with `chainId` and arclength `range`. A node touched by more
 * than two pieces (a non-manifold seam) ends the runs there. */
function chainPieces(pieces:readonly SurfaceCurveSegment3[]):SurfaceCurveSegment3[][] {
  const byNode=new Map<string,number[]>();
  pieces.forEach((piece,i)=>{for(const id of [piece.a.id,piece.b.id]){const rows=byNode.get(id)??[];rows.push(i);byNode.set(id,rows);}});
  const used=new Set<number>(),chains:SurfaceCurveSegment3[][]=[];
  const flip=(p:SurfaceCurveSegment3):SurfaceCurveSegment3=>({...p,a:p.b,b:p.a});
  const next=(node:string,from:number)=>{const rows=byNode.get(node)!;return rows.length===2?rows.find(r=>r!==from&&!used.has(r)):undefined;};
  // Walk backward from a piece to the run's tail, then forward collecting.
  const walk=(start:number):SurfaceCurveSegment3[]=>{
    let head=start,headNode=pieces[start].a.id,guard=0;
    for(;;){const prev=next(headNode,head);if(prev===undefined||prev===start||++guard>pieces.length)break;head=prev;headNode=pieces[prev].a.id===headNode?pieces[prev].b.id:pieces[prev].a.id;}
    const run:SurfaceCurveSegment3[]=[];let row:number|undefined=head,entry=headNode;
    while(row!==undefined&&!used.has(row)){used.add(row);const p=pieces[row],oriented=p.a.id===entry?p:flip(p);run.push(oriented);entry=oriented.b.id;row=next(entry,row);}
    return run;
  };
  // Deterministic order: runs start at the lowest piece id not yet used.
  const order=pieces.map((_,i)=>i).sort((x,y)=>compare(pieces[x].id,pieces[y].id));
  for(const i of order){if(used.has(i))continue;const run=walk(i);
    const lengths=run.map(p=>Math.hypot(...p.b.position.map((v,k)=>v-p.a.position[k])));const total=lengths.reduce((a,b)=>a+b,0);
    let at=0;const chainId=JSON.stringify(['hatch-run',run[0].id]);
    chains.push(run.map((p,k)=>{const from=total>0?at/total:0;at+=lengths[k];const to=total>0?Math.min(1,at/total):1;return freezeCurves3({...p,chainId,range:[from,to] as const});}));
  }
  return chains;
}
/** Realized curves retain MODEL coordinates and barycentric ownership, even
 * when an instance is transformed. Faces with the same family, spacing, angle
 * and phase share one paper-origin lattice and are ruled together, so a
 * ruling is one chain across every face it crosses (its pieces share nodes at
 * the edges between faces); folded faces use piecewise triangle support. */
export function realizeHatch3(hatch:HatchSource3,world:Surface3,frame:CameraFrame3,units:UnitCtx):SurfaceCurves3 {
  const surface=hatch.surface,byFace=surface.faces.map(()=>[] as number[]);
  world.triangles.forEach((t,i)=>byFace[t.face].push(i));
  const camera=world.points.map(p=>toCamera3(frame,p.position));
  const segments:SurfaceCurveSegment3[]=[];let rowsVisited=0;
  // Group faces by lattice: same family, spacing, phase and angle rule together.
  interface Group {readonly key:string;readonly family:HatchFamily3;readonly spacing:number;readonly phase:number;readonly angle:number;readonly faces:number[]}
  const groups=new Map<string,Group>();
  for(let face=0;face<surface.faces.length;face++)for(const family of hatch.families[face]) {
    const spacing=resolveLen(family.spacing,units),rawPhase=resolveLen(family.offset??0,units);
    const remainder=rawPhase%spacing,phase=remainder<0?remainder+spacing:remainder;
    if(!Number.isFinite(spacing)||spacing<=0||!Number.isFinite(phase)||!Number.isFinite(family.angle))throw new Error('hatch spacing must resolve to positive finite paper length, with finite angle and offset');
    const angle=family.angle%360,key=JSON.stringify([family.id,spacing,phase,angle]);
    let group=groups.get(key);if(!group){group={key,family,spacing,phase,angle,faces:[]};groups.set(key,group);}
    group.faces.push(face);
  }
  for(const group of groups.values()) {
    const {family,spacing,phase}=group;
    // Projected, near/far-clipped, non-degenerate triangles of every face in the group.
    const projected=new Map<number,readonly (readonly [number,number])[]>();
    for(const face of group.faces)for(const index of byFace[face]) {
      const tri=world.triangles[index].vertices.map(i=>camera[i]) as unknown as Triangle3;
      const points: (readonly [number,number])[]=[];
      for(const clipped of clipTriangle3(tri,frame.camera.near,frame.camera.far)) {
        const p=clipped.map(v=>toPaper3(frame,v));
        const extent=Math.max(...p.flatMap(a=>p.map(b=>Math.hypot(a[0]-b[0],a[1]-b[1]))));
        if(Math.abs(orient2d(...p[0],...p[1],...p[2]))<=64*Number.EPSILON*extent*extent)continue;
        points.push(...p);
      }
      if(points.length)projected.set(index,points);
    }
    if(!projected.size)continue;
    // The group's outer boundary: polygon edges belonging to exactly one of its
    // faces. A ruling lying on it is the face outline, already drawn; one lying
    // on an edge between two grouped faces is interior and stays.
    const edgeCount=new Map<string,number>();
    for(const face of group.faces)for(const [i,v] of surface.faces[face].vertices.entries()){const k=edgeKey(v,surface.faces[face].vertices[(i+1)%surface.faces[face].vertices.length]);edgeCount.set(k,(edgeCount.get(k)??0)+1);}
    const boundary=new Set([...edgeCount].filter(([,n])=>n===1).map(([k])=>k));
    const faceOf=(triangle:number)=>surface.faces[world.triangles[triangle].face].id;
    const theta=group.angle*Math.PI/180,nx=-Math.sin(theta),ny=Math.cos(theta);
    let min=Infinity,max=-Infinity;
    for(const points of projected.values())for(const p of points){const d=nx*p[0]+ny*p[1];min=Math.min(min,d);max=Math.max(max,d);}
    // Rule only the band of the sheet (plus one sheet diagonal of overscan for
    // styles that reach past the edge): a face seen from close by projects far
    // beyond the paper, and rulings out there can never leave ink on it.
    const band=sheetBand(frame,nx,ny);min=Math.max(min,band[0]);max=Math.min(max,band[1]);
    if(!(min<=max))continue;
    // Strict bounds avoid laying hatch on the outer parallel boundary.
    const first=Math.floor((min-phase)/spacing)+1,last=Math.ceil((max-phase)/spacing)-1;
    if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||rowsVisited+Math.max(0,last-first+1)>hatch.maxSegments)throw new Error(`hatch ruling capacity exceeded (${hatch.maxSegments}); increase spacing or explicit maxSegments`);
    rowsVisited+=Math.max(0,last-first+1);
    // Each triangle takes part only in the rows its projection spans, so the
    // plane tests cost the same as ruling face by face did.
    const rowTriangles=new Map<number,number[]>();
    for(const [index,points] of projected){
      let lo=Infinity,hi=-Infinity;for(const p of points){const d=nx*p[0]+ny*p[1];lo=Math.min(lo,d);hi=Math.max(hi,d);}
      const from=Math.max(first,Math.ceil((lo-phase)/spacing)),to=Math.min(last,Math.floor((hi-phase)/spacing));
      for(let row=from;row<=to;row++){const rows=rowTriangles.get(row);if(rows)rows.push(index);else rowTriangles.set(row,[index]);}
    }
    for(let row=first;row<=last;row++) {
      const triangles=rowTriangles.get(row);if(!triangles)continue;
      // One plane, one chain, for the row across every face of the group.
      const id=JSON.stringify(['hatch',group.key,row]);
      const attributes={...family.attributes,hatchFamily:family.id,hatchLine:row,hatchSpacingMm:spacing,hatchAngle:family.angle};
      const plane=rulingPlane(frame,nx,ny,row*spacing+phase,id,attributes);
      const pieces=intersectPlane3(world,plane,triangles,{kind:'hatch',maxSegments:hatch.maxSegments-segments.length});
      const points=new Map<SurfaceCurvePoint3,SurfaceCurvePoint3>();
      const modelPoint=(p:SurfaceCurvePoint3):SurfaceCurvePoint3=>{
        let owned=points.get(p);
        if(!owned){const position=p.vertices.reduce((sum,v,i)=>add3(sum,mul3(surface.points[v].position,p.weights[i])),[0,0,0] as Vec3);owned=freezeCurves3({...p,position});points.set(p,owned);}
        return owned;
      };
      const kept:SurfaceCurveSegment3[]=[];
      for(const raw of pieces) {
        const a=raw.a.vertices.filter((_,i)=>raw.a.weights[i]>0),b=raw.b.vertices.filter((_,i)=>raw.b.weights[i]>0);
        if(a.length===1&&b.length===1&&boundary.has(edgeKey(a[0],b[0])))continue;
        const range=sheetRange(frame,raw.a.position,raw.b.position);
        if(!range)continue;
        const piece=range[0]===0&&range[1]===1?raw:{...raw,a:range[0]===0?raw.a:alongPiece(world,raw,range[0],JSON.stringify([raw.a.id,'sheet'])),b:range[1]===1?raw.b:alongPiece(world,raw,range[1],JSON.stringify([raw.b.id,'sheet']))};
        kept.push({...piece,attributes:{...piece.attributes,hatchFace:faceOf(piece.triangles[0])},a:modelPoint(piece.a),b:modelPoint(piece.b)});
      }
      // Pieces that share a node (an edge crossing between two triangles, of one
      // face or of neighbouring faces) are one line on the surface. Walk each
      // such run head to tail: one chain, ranges by arclength, so the stroke
      // constructor joins it into one pen-down stroke.
      for(const chain of chainPieces(kept))segments.push(...chain);
    }
  }
  return Object.freeze({surface,segments:Object.freeze(segments)});
}
