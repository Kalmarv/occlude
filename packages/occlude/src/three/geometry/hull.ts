import {add3,cross3,dot3,mul3,sub3,type Vec3} from '../math.js';

/** Convex hull of a point set as outward-wound triangles, by quickhull: an
 * initial tetrahedron of extreme points, then each facet's farthest outside
 * point pushed onto the hull, its visible facets removed and the horizon
 * refanned. Points inside the hull are dropped, so the result names only the
 * indices it keeps.
 *
 * Internal: the one caller is the geodesic polyhedron, where the points lie on
 * a sphere and the hull is exactly the geodesic triangulation. Fewer than four
 * points, or a set with no volume, has no hull and returns nothing. */
export function convexHull3(points:readonly Vec3[]):readonly (readonly [number,number,number])[] {
  const n=points.length;
  if(n<4)return [];
  let scale=0;for(const p of points)for(const v of p){if(!Number.isFinite(v))return [];scale=Math.max(scale,Math.abs(v));}
  if(!(scale>0))return [];
  const eps=1e-12*scale,above=(f:Facet,i:number):number=>dot3(f.normal,points[i])-f.offset;
  interface Facet {a:number;b:number;c:number;normal:Vec3;offset:number;outside:number[];dead:boolean}
  // The widest pair among the axis extremes, then the point farthest off that
  // line, then the point farthest off that plane: a tetrahedron with volume.
  const extremes:number[]=[];
  for(let k=0;k<3;k++){let lo=0,hi=0;for(let i=1;i<n;i++){if(points[i][k]<points[lo][k])lo=i;if(points[i][k]>points[hi][k])hi=i;}extremes.push(lo,hi);}
  let a=0,b=0,widest=0;
  for(const i of extremes)for(const j of extremes){const d=dot3(sub3(points[i],points[j]),sub3(points[i],points[j]));if(d>widest){widest=d;a=i;b=j;}}
  if(!(widest>0))return [];
  let c=0,offLine=0;
  for(let i=0;i<n;i++){const d=Math.hypot(...cross3(sub3(points[i],points[a]),sub3(points[b],points[a])));if(d>offLine){offLine=d;c=i;}}
  if(!(offLine>eps))return [];
  const plane=cross3(sub3(points[b],points[a]),sub3(points[c],points[a]));
  let d=0,offPlane=0;
  for(let i=0;i<n;i++){const v=Math.abs(dot3(plane,sub3(points[i],points[a])));if(v>offPlane){offPlane=v;d=i;}}
  if(!(offPlane>eps))return [];

  const facets=new Set<Facet>(),edges=new Map<number,Facet>(),key=(i:number,j:number):number=>i*n+j;
  let degenerate=false;
  const make=(i:number,j:number,k:number):Facet=>{
    const raw=cross3(sub3(points[j],points[i]),sub3(points[k],points[i])),length=Math.hypot(...raw);
    if(!(length>0))degenerate=true;
    const normal=length>0?mul3(raw,1/length):raw;
    const facet:Facet={a:i,b:j,c:k,normal,offset:dot3(normal,points[i]),outside:[],dead:false};
    facets.add(facet);edges.set(key(i,j),facet);edges.set(key(j,k),facet);edges.set(key(k,i),facet);
    return facet;
  };
  const drop=(f:Facet):void=>{f.dead=true;facets.delete(f);edges.delete(key(f.a,f.b));edges.delete(key(f.b,f.c));edges.delete(key(f.c,f.a));};
  const assign=(candidates:readonly number[],targets:readonly Facet[]):void=>{
    for(const i of candidates){
      let chosen:Facet|null=null,best=eps;
      for(const f of targets){const distance=above(f,i);if(distance>best){best=distance;chosen=f;}}
      if(chosen)chosen.outside.push(i);
    }
  };
  const inside=mul3([a,b,c,d].reduce((sum,i)=>add3(sum,points[i]),[0,0,0] as Vec3),1/4);
  for(const [i,j,k] of [[a,b,c],[a,c,d],[a,d,b],[b,d,c]]){
    const raw=cross3(sub3(points[j],points[i]),sub3(points[k],points[i]));
    if(dot3(raw,sub3(inside,points[i]))>0)make(i,k,j);else make(i,j,k);
  }
  assign(Array.from({length:n},(_,i)=>i).filter(i=>i!==a&&i!==b&&i!==c&&i!==d),[...facets]);
  const pending:Facet[]=[...facets];
  while(pending.length){
    const seed=pending.pop()!;
    if(seed.dead||!seed.outside.length)continue;
    let far=seed.outside[0],distance=-Infinity;
    for(const i of seed.outside){const value=above(seed,i);if(value>distance){distance=value;far=i;}}
    // Everything this point can see comes off the hull; the ring of edges
    // between what it sees and what it does not is refanned onto it.
    const visible=new Set<Facet>([seed]),walk:Facet[]=[seed],horizon:(readonly [number,number])[]=[];
    while(walk.length){
      const g=walk.pop()!;
      for(const [i,j] of [[g.a,g.b],[g.b,g.c],[g.c,g.a]] as const){
        const neighbour=edges.get(key(j,i));
        if(!neighbour||visible.has(neighbour))continue;
        if(above(neighbour,far)>eps){visible.add(neighbour);walk.push(neighbour);}
        else horizon.push([i,j]);
      }
    }
    const orphans:number[]=[];
    for(const g of visible){for(const i of g.outside)if(i!==far)orphans.push(i);drop(g);}
    const created=horizon.map(([i,j])=>make(i,j,far));
    assign(orphans,created);
    pending.push(...created);
    if(degenerate)return [];
  }
  return Object.freeze([...facets].map(f=>Object.freeze([f.a,f.b,f.c]) as readonly [number,number,number]));
}
