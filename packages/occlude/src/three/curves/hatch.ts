import { orient2d } from 'robust-predicates';
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
    const values=typeof families==='function'?families(Object.freeze({...face,attributes:freezeCurves3(structuredClone(face.attributes))})):families;
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
/** Realized curves retain MODEL coordinates and barycentric ownership, even
 * when an instance is transformed. Faces share a paper-origin ruling lattice
 * across their triangles; folded faces use piecewise triangle support. */
export function realizeHatch3(hatch:HatchSource3,world:Surface3,frame:CameraFrame3,units:UnitCtx):SurfaceCurves3 {
  const surface=hatch.surface,byFace=surface.faces.map(()=>[] as number[]);
  world.triangles.forEach((t,i)=>byFace[t.face].push(i));
  const camera=world.points.map(p=>toCamera3(frame,p.position));
  const segments:SurfaceCurveSegment3[]=[];let rowsVisited=0;
  for(let face=0;face<surface.faces.length;face++) {
    if(!hatch.families[face].length)continue;
    const projected=new Map<number,readonly (readonly [number,number])[]>();
    for(const index of byFace[face]) {
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
    const boundary=new Set(surface.faces[face].vertices.map((v,i,vs)=>edgeKey(v,vs[(i+1)%vs.length])));
    for(const family of hatch.families[face]) {
      const spacing=resolveLen(family.spacing,units),rawPhase=resolveLen(family.offset??0,units);
      const remainder=rawPhase%spacing,phase=remainder<0?remainder+spacing:remainder;
      if(!Number.isFinite(spacing)||spacing<=0||!Number.isFinite(phase)||!Number.isFinite(family.angle))throw new Error('hatch spacing must resolve to positive finite paper length, with finite angle and offset');
      const angle=(family.angle%360)*Math.PI/180,nx=-Math.sin(angle),ny=Math.cos(angle);
      let min=Infinity,max=-Infinity;
      for(const points of projected.values())for(const p of points){const d=nx*p[0]+ny*p[1];min=Math.min(min,d);max=Math.max(max,d);}
      // Rule only the band of the sheet (plus one sheet diagonal of overscan for
      // styles that reach past the edge): a face seen from close by projects far
      // beyond the paper, and rulings out there can never leave ink on it.
      const band=sheetBand(frame,nx,ny);min=Math.max(min,band[0]);max=Math.min(max,band[1]);
      if(!(min<=max))continue;
      // Strict bounds avoid laying hatch on the outer parallel face boundary.
      const first=Math.floor((min-phase)/spacing)+1,last=Math.ceil((max-phase)/spacing)-1;
      if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||rowsVisited+Math.max(0,last-first+1)>hatch.maxSegments)throw new Error(`hatch ruling capacity exceeded (${hatch.maxSegments}); increase spacing or explicit maxSegments`);
      rowsVisited+=Math.max(0,last-first+1);
      for(let row=first;row<=last;row++) {
        const id=JSON.stringify(['hatch',surface.faces[face].id,family.id,row]);
        const attributes={...family.attributes,hatchFamily:family.id,hatchFace:surface.faces[face].id,hatchLine:row,hatchSpacingMm:spacing,hatchAngle:family.angle};
        const plane=rulingPlane(frame,nx,ny,row*spacing+phase,id,attributes);
        const pieces=intersectPlane3(world,plane,[...projected.keys()],{kind:'hatch',maxSegments:hatch.maxSegments-segments.length});
        const points=new Map<SurfaceCurvePoint3,SurfaceCurvePoint3>();
        const modelPoint=(p:SurfaceCurvePoint3):SurfaceCurvePoint3=>{
          let owned=points.get(p);
          if(!owned){const position=p.vertices.reduce((sum,v,i)=>add3(sum,mul3(surface.points[v].position,p.weights[i])),[0,0,0] as Vec3);owned=freezeCurves3({...p,position});points.set(p,owned);}
          return owned;
        };
        for(const raw of pieces) {
          const a=raw.a.vertices.filter((_,i)=>raw.a.weights[i]>0),b=raw.b.vertices.filter((_,i)=>raw.b.weights[i]>0);
          if(a.length===1&&b.length===1&&boundary.has(edgeKey(a[0],b[0])))continue;
          const range=sheetRange(frame,raw.a.position,raw.b.position);
          if(!range)continue;
          const piece=range[0]===0&&range[1]===1?raw:{...raw,a:range[0]===0?raw.a:alongPiece(world,raw,range[0],JSON.stringify([raw.a.id,'sheet'])),b:range[1]===1?raw.b:alongPiece(world,raw,range[1],JSON.stringify([raw.b.id,'sheet']))};
          segments.push(freezeCurves3({...piece,a:modelPoint(piece.a),b:modelPoint(piece.b)}));
        }
      }
    }
  }
  return Object.freeze({surface,segments:Object.freeze(segments)});
}
