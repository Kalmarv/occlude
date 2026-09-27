import type {Surface3} from './surface.js';
/** Corner indices are local to the triangle's polygon, independent of geometry
 * deformation or triangulation diagonals. */
export function triangleCorners3(surface:Surface3,triangle:number):readonly [number,number,number] {
  const t=surface.triangles[triangle];if(!t)throw new Error('invalid surface triangle');
  const face=surface.faces[t.face],indices=t.vertices.map(v=>face.vertices.indexOf(v));
  if(indices.some(i=>i<0))throw new Error('triangle vertices do not belong to its polygon');
  return Object.freeze(indices) as unknown as readonly [number,number,number];
}
