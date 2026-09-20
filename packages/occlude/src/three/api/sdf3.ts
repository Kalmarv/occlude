import {finite3,type Vec3} from '../math.js';

/** A signed distance field in space: POSITIVE INSIDE, negative outside, the
 * same sign `distanceTo` and the 2D `sdf` algebra use (src/distance.ts). The
 * sign is why `union` is a maximum and not a minimum: the union is inside
 * wherever EITHER field is inside, and inside is the larger value. */
export type DistanceField3=(x:number,y:number,z:number)=>number;
/** `√(a²+b²)` and `√(a²+b²+c²)` spelled out — the 2D `sdf` does the same
 * (src/distance.ts `hyp`): V8's `Math.hypot` scales and compensates, at
 * ~2.5× the cost and a last-bit difference. Deliberate ink change 2026-09-20. */
const hyp2=(a:number,b:number):number=>Math.sqrt(a*a+b*b);
const hyp3=(a:number,b:number,c:number):number=>Math.sqrt(a*a+b*b+c*c);

/**
 * Solids as distance fields, and the algebra over them — the 2D `sdf` in
 * three dimensions. Pure: no seed and no paper, so it is a module import.
 * `isosurface(f, {bounds, resolution})` is how one becomes a mesh, and the
 * surface of a field is its zero level, so there is no `contour()` and no
 * `offset()`: a solid grown by a tenth is `(x, y, z) => f(x, y, z) + 0.1`,
 * written where it is needed.
 *
 * `sphere`, `box`, `capsule`, `torus` and `plane` are exact. `union` is exact
 * outside the solid and understates depth inside it, because the nearest
 * boundary may belong to the other field; `intersect` is the reverse, and
 * `subtract` is approximate near the cut. Take any of them at level zero and
 * the surface is exact. `blend` is exact wherever the joint is further than
 * its radius away, and rounds the joint within that distance.
 */

const asField=(f:DistanceField3,what:string):DistanceField3=>{
  if(typeof f!=='function')throw new Error(`sdf3.${what}: expected a distance field, a function of (x, y, z)`);
  return f;
};
const many=(fields:readonly DistanceField3[],what:string):DistanceField3[]=>fields.map(f=>asField(f,what));
/** Nowhere inside — the identity of a union, and an empty solid. */
const nowhere:DistanceField3=()=>-Infinity;
/** Everywhere inside — the identity of an intersection. */
const everywhere:DistanceField3=()=>Infinity;
const triple=(v:Vec3|number,what:string):Vec3=>{
  const out:Vec3=typeof v==='number'?[v,v,v]:v;
  if(!Array.isArray(out)||out.length!==3)throw new Error(`sdf3.${what}: expected a [x, y, z] triple`);
  finite3(out);
  return out;
};

/** A ball of radius `r` about `center`. Exact. */
const sphereField=(r:number,center:Vec3=[0,0,0]):DistanceField3=>{
  const [cx,cy,cz]=triple(center,'sphere');
  return (x,y,z)=>r-hyp3(x-cx,y-cy,z-cz);
};

/**
 * An axis-aligned box, `size` across (one number for a cube, or a triple),
 * CENTRED on `center`. Exact inside and out, including the rounded distance
 * past an edge or a corner.
 *
 * It is `box` and not `rect`, and it is centred always, for the reason the
 * 2D `sdf.box` is: a pure field cannot read the sketch's own rect mode, so
 * one name with two anchors would be a trap.
 */
const boxField=(size:Vec3|number,center:Vec3=[0,0,0]):DistanceField3=>{
  const [hx,hy,hz]=triple(size,'box').map(v=>Math.abs(v)/2);
  const [cx,cy,cz]=triple(center,'box');
  return (x,y,z)=>{
    const dx=Math.abs(x-cx)-hx,dy=Math.abs(y-cy)-hy,dz=Math.abs(z-cz)-hz;
    // Outside: the distance to the nearest face, edge or corner. Inside: the
    // nearest face, which is the largest (least negative) of the three.
    const outside=hyp3(Math.max(dx,0),Math.max(dy,0),Math.max(dz,0));
    return -(outside+Math.min(Math.max(dx,dy,dz),0));
  };
};

/**
 * A capsule: every point within `r` of the segment from `a` to `b`. Exact.
 *
 * `r` is required, and for the reason the 2D `sdf.segment` requires it: a
 * capsule of no radius is never positive, so its surface is empty and the
 * sketch draws nothing at all. A field is a solid, and a solid needs a width.
 */
const capsuleField=(a:Vec3,b:Vec3,r:number):DistanceField3=>{
  const [ax,ay,az]=triple(a,'capsule'),[bx,by,bz]=triple(b,'capsule');
  const dx=bx-ax,dy=by-ay,dz=bz-az,len2=dx*dx+dy*dy+dz*dz;
  return (x,y,z)=>{
    const t=len2>0?Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy+(z-az)*dz)/len2)):0;
    return r-hyp3(x-(ax+dx*t),y-(ay+dy*t),z-(az+dz*t));
  };
};

/** A ring of tube radius `minor` about a circle of radius `major`, centred at
 * the origin, standing on the Z axis like `torus()`. Exact. */
const torusField=(major:number,minor:number):DistanceField3=>
  (x,y,z)=>minor-hyp2(hyp2(x,y)-major,z);

/**
 * The half space on the far side of a plane: `normal` points OUT of the solid,
 * and `offset` is how far the plane sits along it from the origin. A normal
 * with no length names no plane, so that field is nowhere inside.
 */
const planeField=(normal:Vec3,offset=0):DistanceField3=>{
  const n=triple(normal,'plane'),length=Math.hypot(...n);
  if(!(length>0)||!Number.isFinite(length))return nowhere;
  const [nx,ny,nz]=[n[0]/length,n[1]/length,n[2]/length];
  return (x,y,z)=>offset-(x*nx+y*ny+z*nz);
};

/** Inside wherever any of them is inside. */
const unionField=(...fields:DistanceField3[]):DistanceField3=>{
  const fs=many(fields,'union');
  if(fs.length===0)return nowhere;
  if(fs.length===1)return fs[0];
  return (x,y,z)=>{let best=-Infinity;for(const f of fs)best=Math.max(best,f(x,y,z));return best;};
};

/** Inside only where all of them are inside. */
const intersectField=(...fields:DistanceField3[]):DistanceField3=>{
  const fs=many(fields,'intersect');
  if(fs.length===0)return everywhere;
  if(fs.length===1)return fs[0];
  return (x,y,z)=>{let best=Infinity;for(const f of fs)best=Math.min(best,f(x,y,z));return best;};
};

/** `a` with every later field cut out of it. */
const subtractField=(a:DistanceField3,...holes:DistanceField3[]):DistanceField3=>{
  const base=asField(a,'subtract');
  const fs=many(holes,'subtract');
  if(fs.length===0)return base;
  return (x,y,z)=>{let best=base(x,y,z);for(const f of fs)best=Math.min(best,-f(x,y,z));return best;};
};

/**
 * A union with a fillet of `radius` where the two meet. Away from the joint
 * it is exactly the union; within `radius` of it the seam becomes a quarter
 * round, so the blended solid is a little larger there — a fillet adds
 * material, and this one adds it only where it belongs. The form is the 2D
 * `sdf.blend`, which is dimension free.
 */
const blendField=(a:DistanceField3,b:DistanceField3,radius:number):DistanceField3=>{
  const fa=asField(a,'blend'),fb=asField(b,'blend'),k=Math.abs(radius);
  if(!(k>0)||!Number.isFinite(k))return unionField(fa,fb);
  return (x,y,z)=>{
    const u=fa(x,y,z),v=fb(x,y,z);
    // An empty field is -Infinity by design. Blending with one gives the
    // other, rather than NaN everywhere.
    if(!Number.isFinite(u)||!Number.isFinite(v))return Math.max(u,v);
    return Math.min(-k,Math.max(u,v))+hyp2(Math.max(k+u,0),Math.max(k+v,0));
  };
};

/** The same solid, moved by `v`. */
const translateField=(f:DistanceField3,v:Vec3):DistanceField3=>{
  const g=asField(f,'translate'),[dx,dy,dz]=triple(v,'translate');
  return (x,y,z)=>g(x-dx,y-dy,z-dz);
};

/**
 * The solid repeated forever on a lattice of `period` (one number for a cube
 * of space, or a triple). Space folds into one cell about the origin, so the
 * solid should sit inside its own cell; an axis whose period is not positive
 * does not repeat. The field stays a true distance only within a cell, which
 * is what a surface at level zero reads.
 */
const repeatField=(f:DistanceField3,period:Vec3|number):DistanceField3=>{
  const g=asField(f,'repeat'),p=triple(period,'repeat');
  const fold=(v:number,q:number)=>q>0?v-q*Math.round(v/q):v;
  return (x,y,z)=>g(fold(x,p[0]),fold(y,p[1]),fold(z,p[2]));
};

export const sdf3={
  sphere:sphereField,
  box:boxField,
  capsule:capsuleField,
  torus:torusField,
  plane:planeField,
  union:unionField,
  intersect:intersectField,
  subtract:subtractField,
  blend:blendField,
  translate:translateField,
  repeat:repeatField,
};
