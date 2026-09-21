import {orient3d} from 'robust-predicates';
/** A certified rejection stage in front of the exact contact routine.
 *
 * Every world vertex reaching this file is the exact image of a binary64
 * coordinate — `bindingTriangle3` builds each one with `point(...)` from a
 * stored or transformed position, and `pointNumber` reads that same double
 * back — so `orient3d` from robust-predicates is not a filter here but a
 * complete predicate: Shewchuk's adaptive scheme returns the sign of the exact
 * determinant of double inputs, with no unknown outcome. Triangles arrive as
 * nine doubles at an offset, the order `intersectionContacts.ts` stores them.
 *
 * Two sound stages, both from working/globe-followup-report.md §4:
 *
 *  1. The six plane-side signs. If one triangle's three corners are strictly
 *     on one side of the other's plane, the triangles are disjoint: a triangle
 *     is convex, so it lies in that one open half-space.
 *  2. Both triples can straddle for disjoint triangles (§4.1's counterexample),
 *     so when neither triple settles it and no sign is zero, test the at most
 *     four candidate crossing edges. A segment that strictly straddles a
 *     triangle's plane meets the closed triangle exactly when the three
 *     orientations of the segment against the triangle's edges share one weak
 *     sign; mixed strict signs put the crossing outside. If the two triangles
 *     did meet, their intersection is a segment of the planes' common line
 *     whose endpoints lie on triangle edges, so some candidate edge would hit.
 *
 * A zero anywhere in the six signs — coplanar, touching, a shared vertex —
 * declines the certificate and keeps today's exact path unchanged. Nothing
 * here constructs a coordinate; it only says which pairs cannot meet. */
const side=(t:Float64Array,o:number,p:Float64Array,q:number)=>
 Math.sign(orient3d(t[o],t[o+1],t[o+2],t[o+3],t[o+4],t[o+5],t[o+6],t[o+7],t[o+8],p[q],p[q+1],p[q+2]));
/** Does the crossing of segment (p,q) with the plane of triangle `t` lie in
 * the closed triangle? Three orientations of one weak sign say yes; a strictly
 * positive and a strictly negative one together say no. */
function edgeHits(s:Float64Array,p:number,q:number,t:Float64Array,o:number):boolean {
 let positive=false,negative=false;
 for(let k=0;k<3;k++){
  const u=o+3*k,v=o+3*((k+1)%3);
  const d=orient3d(s[p],s[p+1],s[p+2],s[q],s[q+1],s[q+2],t[u],t[u+1],t[u+2],t[v],t[v+1],t[v+2]);
  if(d>0)positive=true;else if(d<0)negative=true;
  if(positive&&negative)return false;
 }
 return true;
}
/** True when the two triangles are proven disjoint and the exact routine would
 * report no contact. False keeps the pair, including every zero sign. */
export function separatedTriangles3(a:Float64Array,ia:number,b:Float64Array,ib:number):boolean {
 const a0=side(b,ib,a,ia),a1=side(b,ib,a,ia+3),a2=side(b,ib,a,ia+6);
 if((a0>0&&a1>0&&a2>0)||(a0<0&&a1<0&&a2<0))return true;
 const b0=side(a,ia,b,ib),b1=side(a,ia,b,ib+3),b2=side(a,ia,b,ib+6);
 if((b0>0&&b1>0&&b2>0)||(b0<0&&b1<0&&b2<0))return true;
 if(a0===0||a1===0||a2===0||b0===0||b1===0||b2===0)return false;
 const da=[a0,a1,a2],db=[b0,b1,b2];
 for(let k=0;k<3;k++)if(da[k]*da[(k+1)%3]<0&&edgeHits(a,ia+3*k,ia+3*((k+1)%3),b,ib))return false;
 for(let k=0;k<3;k++)if(db[k]*db[(k+1)%3]<0&&edgeHits(b,ib+3*k,ib+3*((k+1)%3),a,ia))return false;
 return true;
}
