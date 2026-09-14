import type {Surface3,SurfaceCorner3} from './surface.js';
/** Corner indices are local to the triangle's polygon, independent of geometry
 * deformation or triangulation diagonals. */
export function triangleCorners3(surface:Surface3,triangle:number):readonly [number,number,number] {
  const t=surface.triangles[triangle];if(!t)throw new Error('invalid surface triangle');
  const face=surface.faces[t.face],indices=t.vertices.map(v=>face.vertices.indexOf(v));
  if(indices.some(i=>i<0))throw new Error('triangle vertices do not belong to its polygon');
  return Object.freeze(indices) as unknown as readonly [number,number,number];
}
export function faceCorners3(surface:Surface3,face:number):readonly SurfaceCorner3[] {
  const row=surface.faces[face];if(!row)throw new Error('invalid surface face');
  return row.corners??Object.freeze(row.vertices.map(v=>Object.freeze({id:JSON.stringify(['corner',row.id,surface.points[v].id]),attributes:Object.freeze({})})));
}
