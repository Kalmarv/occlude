import {abs,canonicalPoint,cross,difference,dot,orientPoint,plane,sign,subtract,times,reduce,type H,type V} from '../geometry/exact.js';
export type ExactTriangle3=readonly [H,H,H];
export type TriangleContact3=
 |{readonly kind:'point';readonly points:readonly [H];readonly coplanar:boolean}
 |{readonly kind:'segment';readonly points:readonly [H,H];readonly coplanar:boolean}
 |{readonly kind:'area';readonly points:readonly H[];readonly coplanar:true;readonly plane:H};
/** Lexicographic represented-coordinate order, independent of homogeneous scale. */
export function compareExactPoints3(a:H,b:H):number {
 for(let k=0;k<3;k++){const d=a[k]*b[3]-b[k]*a[3];if(d)return d<0n?-1:1;}return 0;
}
export function exactPointKey3(p:H):string{return canonicalPoint(p).join(',');}
export function canonicalPlane3(value:H):H {
 const k=value.findIndex(v=>v!==0n);if(k<0||k===3)throw new Error('intersection triangle is degenerate');
 return Object.freeze(reduce(value[k]<0n?times(value,-1n):value));
}
function trianglePlane(triangle:ExactTriangle3):H {
 if(triangle.some(p=>p[3]<=0n))throw new Error('intersection triangles require finite positive homogeneous coordinates');
 const p=plane(...triangle);if(p.slice(0,3).every(n=>n===0n))throw new Error('intersection triangle is degenerate');return p;
}
const dropAxis=(normal:readonly bigint[])=>{let axis=0;for(let k=1;k<3;k++)if(abs(normal[k])>abs(normal[axis]))axis=k;return axis;};
/** A projective line/plane crossing; no division to floating coordinates. */
export function exactCrossing3(a:H,b:H,da:bigint,db:bigint):H {
 return canonicalPoint(subtract(times(a,db),times(b,da)));
}
function unique(points:readonly H[]):H[]{
 const values=new Map<string,H>();for(const p of points){const q=canonicalPoint(p);values.set(q.join(','),q);}return [...values.values()];
}
function cut(triangle:ExactTriangle3,distances:readonly bigint[]):H[]{
 const points:H[]=[];
 for(let i=0;i<3;i++){
  const j=(i+1)%3,a=distances[i],b=distances[j];
  if(a===0n)points.push(triangle[i]);
  if(sign(a)*sign(b)<0n)points.push(exactCrossing3(triangle[i],triangle[j],a,b));
 }
 return unique(points).sort(compareExactPoints3);
}
function contact(points:readonly H[],coplanar:boolean):TriangleContact3|null {
 const distinct=unique(points).sort(compareExactPoints3);
 if(!distinct.length)return null;
 if(distinct.length===1)return Object.freeze({kind:'point',points:Object.freeze(distinct) as readonly [H],coplanar});
 return Object.freeze({kind:'segment',points:Object.freeze([distinct[0],distinct.at(-1)!]) as readonly [H,H],coplanar});
}
function coplanar(a:ExactTriangle3,b:ExactTriangle3,normal:H):TriangleContact3|null {
 const drop=dropAxis(normal),orientation=sign(orientPoint(...b,drop));
 let polygon:H[]=[...a];
 for(let i=0;i<3&&polygon.length;i++){
  const edge=[b[i],b[(i+1)%3]] as const,next:H[]=[];
  for(let j=0;j<polygon.length;j++){
   const p=polygon[j],q=polygon[(j+1)%polygon.length],dp=orientPoint(...edge,p,drop)*orientation,dq=orientPoint(...edge,q,drop)*orientation;
   if(dp>=0n)next.push(p);
   if(sign(dp)*sign(dq)<0n)next.push(exactCrossing3(p,q,dp,dq));
  }
  polygon=unique(next);
 }
 if(polygon.length<3||polygon.every(p=>orientPoint(polygon[0],polygon[1],p,drop)===0n))return contact(polygon,true);
 // Remove redundant collinear points without ever merging positive separation.
 let changed=true;
 while(changed&&polygon.length>=3){
  changed=false;
  for(let i=0;i<polygon.length;i++)if(orientPoint(polygon[(i+polygon.length-1)%polygon.length],polygon[i],polygon[(i+1)%polygon.length],drop)===0n){polygon.splice(i,1);changed=true;break;}
 }
 if(polygon.length<3)return contact(polygon,true);
 if(orientPoint(polygon[0],polygon[1],polygon[2],drop)<0n)polygon.reverse();
 let first=0;for(let i=1;i<polygon.length;i++)if(compareExactPoints3(polygon[i],polygon[first])<0)first=i;
 polygon=[...polygon.slice(first),...polygon.slice(0,first)].map(canonicalPoint);
 return Object.freeze({kind:'area',points:Object.freeze(polygon),coplanar:true,plane:canonicalPlane3(normal)});
}
/** Exact contact of represented triangles. Area contact is an overlap polygon,
 * not arbitrary ink along either input's triangulation. The mesh assembler
 * subsequently takes the union boundary and retains both-source support. */
export function triangleContact3(a:ExactTriangle3,b:ExactTriangle3):TriangleContact3|null {
 const pa=trianglePlane(a),pb=trianglePlane(b),da=a.map(p=>dot(pb,p)),db=b.map(p=>dot(pa,p));
 const separated=(ds:readonly bigint[])=>ds.every(n=>n>0n)||ds.every(n=>n<0n);
 if(separated(da)||separated(db))return null;
 const parallel=cross(pa.slice(0,3) as unknown as V,pb.slice(0,3) as unknown as V).every(n=>n===0n);
 if(parallel)return da.every(n=>n===0n)?coplanar(a,b,pa):null;
 const ca=cut(a,da),cb=cut(b,db);if(!ca.length||!cb.length)return null;
 const low=compareExactPoints3(ca[0],cb[0])>=0?ca[0]:cb[0],high=compareExactPoints3(ca.at(-1)!,cb.at(-1)!)<=0?ca.at(-1)!:cb.at(-1)!;
 return compareExactPoints3(low,high)>0?null:contact([low,high],false);
}
/** Exact collinearity, useful when support splits subdivide a source line. */
export function collinearExact3(a:H,b:H,c:H):boolean{return cross(difference(b,a),difference(c,a)).every(n=>n===0n);}
