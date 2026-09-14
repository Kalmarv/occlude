import { identity } from './identity.js';
import { orient2d, orient3d } from 'robust-predicates';
import { assembleSurface3, type Attributes3, type Surface3, type SurfacePoint3, type SurfaceFace3, type SurfaceTriangle3 } from '../geometry/surface.js';
import { cross3, sub3, type Vec3 } from '../math.js';

export interface SubdivisionOptions {
  readonly maxFaces?: number;
  readonly maxPoints?: number;
}
export type PointTransfers = Readonly<Record<string, 'interpolate' | 'nearest'>>;
const pair = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

/** Continuous numeric columns interpolate; categorical columns use the first
 * source in canonical point-ID order. Explicit nearest also protects numeric
 * labels. Missing columns remain missing rather than acquiring fake zeros. */
function interpolate(rows: readonly SurfacePoint3[], transfers: PointTransfers): Attributes3 {
  const ordered = [...rows].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0), out: Attributes3 = {};
  for (const name of Object.keys(ordered[0].attributes)) {
    if (!ordered.every(p=>Object.hasOwn(p.attributes,name))) continue;
    const values = ordered.map(p=>p.attributes[name]);
    if (transfers[name] !== 'nearest' && values.every(v=>typeof v==='number')) {
      out[name] = (values as number[]).reduce((sum,v)=>sum+v/values.length,0);
    } else if (transfers[name] !== 'nearest' && values.every(v=>Array.isArray(v)&&v.length===(values[0] as number[]).length)) {
      out[name] = (values[0] as number[]).map((_,i)=>values.reduce<number>((sum,v)=>sum+(v as number[])[i]/values.length,0));
    } else out[name] = structuredClone(values[0]);
  }
  return out;
}

/** Only convex, exactly planar quads have a center split. Other polygons use
 * their existing validated triangulation, preserving even folded faces. */
function isQuad(surface: Surface3, face: SurfaceFace3): boolean {
  if (face.vertices.length !== 4) return false;
  const p=face.vertices.map(v=>surface.points[v].position);
  if (orient3d(...p[0],...p[1],...p[2],...p[3]) !== 0) return false;
  const n=cross3(sub3(p[1],p[0]),sub3(p[2],p[0]));
  const axis=n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
  const xy=p.map(v=>v.filter((_,i)=>i!==axis) as [number,number]);
  const turns=xy.map((_,i)=>Math.sign(orient2d(...xy[i],...xy[(i+1)%4],...xy[(i+2)%4])));
  return turns[0]!==0 && turns.every(v=>v===turns[0]);
}

export function subdivideSurface(surface: Surface3, levels=1, options: SubdivisionOptions={}, transfers: PointTransfers={}): Surface3 {
  const maxFaces=options.maxFaces??250_000, maxPoints=options.maxPoints??500_000;
  if (!Number.isSafeInteger(levels)||levels<0) throw new Error('subdivide levels must be a nonnegative integer');
  if (![maxFaces,maxPoints].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('subdivide budgets must be positive integers');
  if (!levels || !surface.faces.length) return surface;
  const quads=surface.faces.map(f=>isQuad(surface,f));
  const triangleCounts=surface.faces.map(()=>0);
  surface.triangles.forEach(t=>triangleCounts[t.face]++);
  // Preflight every requested level before allocating the first output. The
  // point bound includes every polygon/triangulation edge and quad center.
  let faces=surface.faces.reduce((sum,_,i)=>sum+(quads[i]?4:4*triangleCounts[i]),0);
  let points=surface.points.length+surface.edges.length+surface.faces.reduce((sum,f,i)=>sum+(quads[i]?1:Math.max(0,f.vertices.length-3)),0);
  for(let level=0;level<levels;level++) {
    if (faces>maxFaces||points>maxPoints) throw new Error(`subdivide exceeds budget (${maxFaces} faces, ${maxPoints} points); reduce levels or raise explicit limits`);
    // Each next face has at most four sides; edges <= 4F, centers <= F.
    points += 5*faces; faces *= 4;
  }
  let current=surface;
  for(let level=0;level<levels;level++) current=refine(current,transfers);
  return current;
}

function refine(surface: Surface3, transfers: PointTransfers): Surface3 {
  const points: SurfacePoint3[]=surface.points.map(p=>({...p}));
  const faces: SurfaceFace3[]=[], triangles: SurfaceTriangle3[]=[];
  const midpoints=new Map<string,number>(), children=new Map<string,Surface3['edges'][number]>();
  const originals=new Map(surface.edges.map(e=>[pair(...e.vertices),e]));
  const center=(vertices:readonly number[], id:string):number=>{
    const rows=vertices.map(v=>surface.points[v]);
    const position=[0,1,2].map(k=>rows.reduce((sum,p)=>sum+p.position[k]/rows.length,0)) as unknown as Vec3;
    const index=points.length; points.push({id,position,provenance:{operation:'subdivide',parents:rows.map(p=>p.id)},attributes:interpolate(rows,transfers)});return index;
  };
  const midpoint=(a:number,b:number):number=>{
    const key=pair(a,b),found=midpoints.get(key);if(found!==undefined)return found;
    const original=originals.get(key);
    const index=center([a,b],identity('edge',...[surface.points[a].id,surface.points[b].id].sort()));midpoints.set(key,index);
    if(original){children.set(pair(a,index),original);children.set(pair(index,b),original);}
    return index;
  };
  const add=(parent:SurfaceFace3,vertices:number[],part:number)=>{
    const face=faces.length;faces.push({id:identity('face',parent.id,part),vertices,provenance:{operation:'subdivide',parents:[parent.id]},attributes:structuredClone(parent.attributes)});
    triangles.push({face,vertices:[vertices[0],vertices[1],vertices[2]]});
    if(vertices.length===4)triangles.push({face,vertices:[vertices[0],vertices[2],vertices[3]]});
  };
  const byFace=surface.faces.map(()=>[] as SurfaceTriangle3[]);surface.triangles.forEach(t=>byFace[t.face].push(t));
  surface.faces.forEach((f,i)=>{
    if(isQuad(surface,f)){
      const c=center(f.vertices,identity('center',f.id));
      f.vertices.forEach((v,j)=>add(f,[v,midpoint(v,f.vertices[(j+1)%4]),c,midpoint(f.vertices[(j+3)%4],v)],j));
    }else{
      let part=0;
      for(const {vertices:[a,b,c]} of byFace[i]){
        const ab=midpoint(a,b),bc=midpoint(b,c),ca=midpoint(c,a);
        for(const vertices of [[a,ab,ca],[ab,b,bc],[ca,bc,c],[ab,bc,ca]])add(f,vertices,part++);
      }
    }
  });
  const out=assembleSurface3(points,faces,triangles);
  return {...out,edges:Object.freeze(out.edges.map(e=>{
    const parent=children.get(pair(...e.vertices));
    return parent?{...e,id:identity('child-edge',parent.id,...e.vertices.map(v=>points[v].id).sort()),provenance:{operation:'subdivide',parents:[parent.id]},attributes:structuredClone(parent.attributes)}:e;
  }))};
}
