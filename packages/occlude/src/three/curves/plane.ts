import type { Attributes3, Surface3 } from '../geometry/surface.js';
import { dot3, finite3, lerp3, sub3, unit3, type Vec3 } from '../math.js';
import { freezeCurves3, type SurfaceCurvePoint3, type SurfaceCurveSegment3 } from './surface.js';
export interface Plane3 { readonly id:string; readonly origin:Vec3; readonly normal:Vec3; readonly attributes?:Attributes3 }
const key=(...parts:(string|number)[])=>JSON.stringify(parts);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Shared source-supported triangle/plane intersection; only selected triangles
 * participate, so a hatch stripe never scans the whole scene. */
export function intersectPlane3(surface:Surface3,plane:Plane3,triangles:readonly number[],options:{tolerance?:number;maxSegments:number;kind:SurfaceCurveSegment3['kind']}):readonly SurfaceCurveSegment3[] {
  const segments:SurfaceCurveSegment3[]=[];
    finite3(plane.origin);finite3(plane.normal);const normal=unit3(plane.normal);
    const indices=new Set(triangles.flatMap(i=>[...surface.triangles[i].vertices]));
    const local=new Map([...indices].map(i=>[i,sub3(surface.points[i].position,plane.origin)]));
    const scale=[...local.values()].reduce((a,p)=>Math.max(a,...p.map(Math.abs)),0);
    if(!Number.isFinite(scale))throw new Error('section coordinates have unrepresentable extent');
    const tolerance=options.tolerance??64*Number.EPSILON*scale;
    const distances=new Map([...local].map(([i,p])=>[i,dot3(p,normal)]));
    if([...distances.values()].some(d=>!Number.isFinite(d)))throw new Error('section distances are not representable');
    const signs=new Map([...distances].map(([i,d])=>[i,Math.abs(d)<=tolerance?0:Math.sign(d)]));
    const nodes=new Map<string,SurfaceCurvePoint3>();
    const vertex=(i:number)=>{
      const id=key(plane.id,'vertex',surface.points[i].id);
      let node=nodes.get(id);
      if(!node){node=freezeCurves3({id,position:surface.points[i].position,vertices:[i,i,i] as const,weights:[1,0,0] as const});nodes.set(id,node);}
      return node;
    };
    const crossing=(i:number,j:number)=>{
      if((signs.get(i)!)===0)return vertex(i);if((signs.get(j)!)===0)return vertex(j);
      if(compare(surface.points[i].id,surface.points[j].id)>0)[i,j]=[j,i];
      const id=key(plane.id,'edge',surface.points[i].id,surface.points[j].id);
      let node=nodes.get(id);
      if(!node){
        // Opposite signs: scaled ratio avoids overflow of d0-d1.
        const a=Math.abs((distances.get(i)!)),b=Math.abs((distances.get(j)!)),m=Math.max(a,b),t=(a/m)/(a/m+b/m);
        node=freezeCurves3({id,position:lerp3(surface.points[i].position,surface.points[j].position,t),vertices:[i,j,j] as const,weights:[1-t,t,0] as const});nodes.set(id,node);
      }
      return node;
    };
    const pieces=new Map<string,{a:SurfaceCurvePoint3;b:SurfaceCurvePoint3;triangles:Set<number>;coplanar:number}>();
    const add=(a:SurfaceCurvePoint3,b:SurfaceCurvePoint3,triangle:number,coplanar=false)=>{
      if(a.id===b.id)return;
      if(compare(a.id,b.id)>0)[a,b]=[b,a];
      const id=key(a.id,b.id),entry=pieces.get(id)??{a,b,triangles:new Set<number>(),coplanar:0};
      entry.triangles.add(triangle);if(coplanar)entry.coplanar++;pieces.set(id,entry);
      if(pieces.size>options.maxSegments)throw new Error(`section candidate capacity exceeded (${options.maxSegments}); use fewer planes or a larger explicit maxSegments`);
    };
    triangles.forEach(index=>{
      const triangle=surface.triangles[index];
      const v=triangle.vertices,s=v.map(i=>(signs.get(i)!));
      if(s.every(x=>x===0)){for(let j=0;j<3;j++)add(vertex(v[j]),vertex(v[(j+1)%3]),index,true);return;}
      if(s.every(x=>x>0)||s.every(x=>x<0))return;
      const hits=new Map<string,SurfaceCurvePoint3>();
      for(let j=0;j<3;j++) {
        const a=v[j],b=v[(j+1)%3];
        if((signs.get(a)!)===0){const p=vertex(a);hits.set(p.id,p);}
        if((signs.get(a)!)*(signs.get(b)!)<0){const p=crossing(a,b);hits.set(p.id,p);}
      }
      const points=[...hits.values()];
      if(points.length===2)add(points[0],points[1],index);
    });
    // One frozen record for every piece of this plane: the same values, shared.
    const planeAttributes=freezeCurves3(structuredClone(plane.attributes??{}));
    for(const [id,piece] of [...pieces].sort((a,b)=>compare(a[0],b[0]))) {
      if(piece.coplanar>=2)continue;
      if(Math.hypot(...sub3(piece.a.position,piece.b.position))===0)continue;
      segments.push(freezeCurves3({id:key(options.kind,plane.id,id),kind:options.kind,a:piece.a,b:piece.b,triangles:[...piece.triangles].sort((a,b)=>a-b),attributes:planeAttributes}));
    }
  return Object.freeze(segments);
}
