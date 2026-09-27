import type {Mesh3} from './mesh3.js';
/** Corner indices are local to the triangle's polygon, independent of geometry
 * deformation or triangulation diagonals: positions round the face's loop,
 * read from the face's fixed triangles. Add `mesh.cornerStart[face]` for the
 * corner row. */
export function triangleCorners3(mesh:Mesh3,triangle:number):readonly [number,number,number] {
  if(!Number.isSafeInteger(triangle)||triangle<0||triangle>=mesh.triangleCount)throw new Error('invalid surface triangle');
  const face=mesh.triangleFace[triangle],local=mesh.localTriangles(face),k=3*(triangle-mesh.faceTriangleStart[face]);
  const indices=[local[k],local[k+1],local[k+2]];
  if(indices.some(i=>!(i>=0)))throw new Error('triangle vertices do not belong to its polygon');
  return Object.freeze(indices) as unknown as readonly [number,number,number];
}
