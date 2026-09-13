import { snapshotSurface3 } from '../geometry/model.js';
import type { Attributes3, Surface3 } from '../geometry/surface.js';
import { dot3, finite3, lerp3, sub3, unit3, type Vec3 } from '../math.js';

export interface SectionPlane3 { readonly id:string; readonly origin:Vec3; readonly normal:Vec3; readonly attributes?:Attributes3 }
/** Barycentric source position; original vertex indices survive instance transforms. */
export interface SurfaceCurvePoint3 { readonly id:string; readonly position:Vec3; readonly vertices:readonly [number,number,number]; readonly weights:Vec3 }
export interface SurfaceCurveSegment3 {
  readonly id:string;
  readonly kind:'section';
  readonly a:SurfaceCurvePoint3;
  readonly b:SurfaceCurvePoint3;
  readonly triangles:readonly number[];
  readonly attributes:Readonly<Attributes3>;
}
/** Draw against this exact owned surface; a new model needs newly generated curves. */
export interface SurfaceCurves3 { readonly surface:Surface3; readonly segments:readonly SurfaceCurveSegment3[] }
const key=(...parts:(string|number)[])=>JSON.stringify(parts);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};

/** Validate source ownership before any support IDs can bypass self-occlusion. */
export function validateSurfaceCurves3(curves:SurfaceCurves3,surface:Surface3):void {
  if(curves.surface!==surface)throw new Error('surface curves belong to a different captured surface; draw curves.surface or regenerate the curves');
  const ids=new Set<string>(),points=new Map<string,string>();
  for(const segment of curves.segments) {
    if(!segment.id||ids.has(segment.id)||segment.kind!=='section')throw new Error('surface curves need unique segment IDs and a supported kind');
    ids.add(segment.id);
    if(!segment.triangles.length||segment.triangles.some(i=>!Number.isSafeInteger(i)||i<0||i>=surface.triangles.length))throw new Error('surface curve has invalid triangle support');
    for(const p of [segment.a,segment.b]) {
      finite3(p.position);finite3(p.weights);
      if(!p.id||p.vertices.length!==3||p.vertices.some(i=>!Number.isSafeInteger(i)||i<0||i>=surface.points.length)||p.weights.some(w=>w<0||w>1)||Math.abs(p.weights.reduce((a,b)=>a+b,0)-1)>32*Number.EPSILON)throw new Error('surface curve has invalid barycentric source point');
      const expected=p.vertices.reduce((sum,v,i)=>sum.map((n,k)=>n+surface.points[v].position[k]*p.weights[i]),[0,0,0]);
      const scale=Math.max(...p.vertices.flatMap(v=>surface.points[v].position.map(Math.abs)),...p.position.map(Math.abs));
      if(expected.some((n,k)=>Math.abs(n-p.position[k])>64*Number.EPSILON*scale))throw new Error('surface curve position disagrees with its captured source weights');
      const identity=JSON.stringify([p.vertices,p.weights,p.position]),previous=points.get(p.id);
      if(previous!==undefined&&previous!==identity)throw new Error('surface curve endpoint ID refers to different source positions');
      points.set(p.id,identity);
      for(const index of segment.triangles)if(p.vertices.some((v,i)=>p.weights[i]>0&&!surface.triangles[index].vertices.includes(v)))throw new Error('surface curve point is outside its declared triangle support');
    }
  }
}

/** Mesh-plane sections in model coordinates. Coplanar patches contribute their
 * boundary, not triangulation diagonals; isolated tangent vertices emit no line.
 * Topological endpoint IDs connect pieces, never a screen-space proximity test. */
export function section3(input:Surface3,planes:readonly SectionPlane3[],options:{tolerance?:number;maxSegments?:number}={}):SurfaceCurves3 {
  const surface=snapshotSurface3(input),segments:SurfaceCurveSegment3[]=[];
  const max=options.maxSegments??1_000_000;
  if(!Number.isSafeInteger(max)||max<1)throw new Error('section maxSegments must be a positive integer');
  if(options.tolerance!==undefined&&(!Number.isFinite(options.tolerance)||options.tolerance<0))throw new Error('section tolerance must be finite and nonnegative');
  if(new Set(planes.map(p=>p.id)).size!==planes.length||planes.some(p=>!p.id))throw new Error('section planes require unique nonempty IDs');
  for(const plane of [...planes].sort((a,b)=>compare(a.id,b.id))) {
    finite3(plane.origin);finite3(plane.normal);const normal=unit3(plane.normal);
    const local=surface.points.map(p=>sub3(p.position,plane.origin));
    const scale=local.reduce((a,p)=>Math.max(a,...p.map(Math.abs)),0);
    if(!Number.isFinite(scale))throw new Error('section coordinates have unrepresentable extent');
    const tolerance=options.tolerance??64*Number.EPSILON*scale;
    const distances=local.map(p=>dot3(p,normal));
    if(distances.some(d=>!Number.isFinite(d)))throw new Error('section distances are not representable');
    const signs=distances.map(d=>Math.abs(d)<=tolerance?0:Math.sign(d));
    const nodes=new Map<string,SurfaceCurvePoint3>();
    const vertex=(i:number)=>{
      const id=key(plane.id,'vertex',surface.points[i].id);
      let node=nodes.get(id);
      if(!node){node=freeze({id,position:surface.points[i].position,vertices:[i,i,i] as const,weights:[1,0,0] as const});nodes.set(id,node);}
      return node;
    };
    const crossing=(i:number,j:number)=>{
      if(signs[i]===0)return vertex(i);if(signs[j]===0)return vertex(j);
      if(compare(surface.points[i].id,surface.points[j].id)>0)[i,j]=[j,i];
      const id=key(plane.id,'edge',surface.points[i].id,surface.points[j].id);
      let node=nodes.get(id);
      if(!node){
        // Opposite signs: scaled ratio avoids overflow of d0-d1.
        const a=Math.abs(distances[i]),b=Math.abs(distances[j]),m=Math.max(a,b),t=(a/m)/(a/m+b/m);
        node=freeze({id,position:lerp3(surface.points[i].position,surface.points[j].position,t),vertices:[i,j,j] as const,weights:[1-t,t,0] as const});nodes.set(id,node);
      }
      return node;
    };
    const pieces=new Map<string,{a:SurfaceCurvePoint3;b:SurfaceCurvePoint3;triangles:Set<number>;coplanar:number}>();
    const add=(a:SurfaceCurvePoint3,b:SurfaceCurvePoint3,triangle:number,coplanar=false)=>{
      if(a.id===b.id)return;
      if(compare(a.id,b.id)>0)[a,b]=[b,a];
      const id=key(a.id,b.id),entry=pieces.get(id)??{a,b,triangles:new Set<number>(),coplanar:0};
      entry.triangles.add(triangle);if(coplanar)entry.coplanar++;pieces.set(id,entry);
      if(pieces.size+segments.length>max)throw new Error(`section candidate capacity exceeded (${max}); use fewer planes or a larger explicit maxSegments`);
    };
    surface.triangles.forEach((triangle,index)=>{
      const v=triangle.vertices,s=v.map(i=>signs[i]);
      if(s.every(x=>x===0)){for(let j=0;j<3;j++)add(vertex(v[j]),vertex(v[(j+1)%3]),index,true);return;}
      if(s.every(x=>x>0)||s.every(x=>x<0))return;
      const hits=new Map<string,SurfaceCurvePoint3>();
      for(let j=0;j<3;j++) {
        const a=v[j],b=v[(j+1)%3];
        if(signs[a]===0){const p=vertex(a);hits.set(p.id,p);}
        if(signs[a]*signs[b]<0){const p=crossing(a,b);hits.set(p.id,p);}
      }
      const points=[...hits.values()];
      if(points.length===2)add(points[0],points[1],index);
    });
    for(const [id,piece] of [...pieces].sort((a,b)=>compare(a[0],b[0]))) {
      if(piece.coplanar>=2)continue;
      if(Math.hypot(...sub3(piece.a.position,piece.b.position))===0)continue;
      segments.push(freeze({id:key('section',plane.id,id),kind:'section' as const,a:piece.a,b:piece.b,triangles:[...piece.triangles].sort((a,b)=>a-b),attributes:{...structuredClone(plane.attributes),sectionPlane:plane.id}}));
    }
  }
  return Object.freeze({surface,segments:Object.freeze(segments)});
}
