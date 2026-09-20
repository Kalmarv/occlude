/**
 * Wavefront OBJ as a mesh source: `obj(text, opts)` turns a model exported
 * by Blender or any other modeller into an ordinary `Mesh` — viewed,
 * occluded, hatched, subdivided, styled and plotted like a box.
 *
 * Deliberately not a general OBJ engine: `v` and `f` are read, `o` and `g`
 * become face attributes, and everything else (normals, texture
 * coordinates, materials, smoothing groups, `l` polylines, free-form
 * curves) is read past. Polygons keep their vertex count; the surface's own
 * ear clipping triangulates them for drawing. Negative (relative) indices
 * are honoured. The file's coordinates enter as they are — no unit, no
 * scale — except for the up axis: OBJ is Y-up by convention and occlude is
 * Z-up, so a file is stood upright unless `up: 'z'` says it already is.
 *
 * A mistake in the file refuses by line: an index past the last vertex, a
 * face that visits a vertex twice, two faces that wind the same way along a
 * shared edge, three faces on one edge. A face with fewer than three
 * distinct corners is nothing to draw, and is dropped.
 */

import type {Vec3} from '../math.js';
import {surface3} from '../geometry/surface.js';
import {ownSurface3} from '../geometry/model.js';
import {Mesh,emptyMesh,type GeometryOptions} from './mesh.js';

export interface ObjOptions extends GeometryOptions {
  /** The axis the file treats as up. OBJ files are Y-up by convention
   * (Blender's export default); `'z'` reads the coordinates unchanged.
   * Default `'y'`. */
  readonly up?:'y'|'z';
  /** Only these `o` objects, by name; default all. */
  readonly objects?:readonly string[];
}

interface ObjFace {readonly line:number;readonly vertices:readonly number[];readonly object?:string;readonly group?:string}

/** `text` parsed into positions in occlude's frame and faces by original
 * vertex index; the caller compacts the vertices the faces use. */
function parseObj(text:string,up:'y'|'z'):{positions:Vec3[];faces:ObjFace[]} {
  const positions:Vec3[]=[],faces:ObjFace[]=[];
  let object:string|undefined,group:string|undefined;
  const lines=text.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=i+1,raw=lines[i];
    const hash=raw.indexOf('#');
    const fields=(hash<0?raw:raw.slice(0,hash)).trim().split(/\s+/);
    const kind=fields[0];
    if(!kind)continue;
    if(kind==='v'){
      const [x,y,z]=fields.slice(1,4).map(Number);
      if(fields.length<4||![x,y,z].every(Number.isFinite))throw new Error(`obj line ${line}: vertex needs three finite coordinates`);
      positions.push(up==='y'?[x,-z,y]:[x,y,z]);
    }else if(kind==='f'){
      const indices=fields.slice(1).map(field=>{
        const index=Number(field.split('/')[0]);
        if(!Number.isInteger(index)||index===0)throw new Error(`obj line ${line}: face index '${field}' is not a vertex number`);
        const absolute=index<0?positions.length+index:index-1;
        if(absolute<0||absolute>=positions.length)throw new Error(`obj line ${line}: face refers to vertex ${index} and the file has ${positions.length} vertices so far`);
        return absolute;
      });
      // A corner repeated in place (a collapsed edge) is dropped; a corner
      // revisited later is a pinched polygon, which is a mistake to name.
      const vertices=indices.filter((v,k)=>v!==indices[(k+indices.length-1)%indices.length]);
      if(new Set(vertices).size!==vertices.length)throw new Error(`obj line ${line}: face visits a vertex twice`);
      if(vertices.length<3)continue;
      faces.push({line,vertices,...(object!==undefined?{object}:{}),...(group!==undefined?{group}:{})});
    }else if(kind==='o')object=fields.slice(1).join(' ');
    else if(kind==='g')group=fields.slice(1).join(' ');
  }
  return {positions,faces};
}

/** The manifold rules the surface enforces, checked here first so the
 * refusal can name the lines of the file that break them. */
function checkEdges(faces:readonly ObjFace[]):void {
  const edges=new Map<string,{line:number;forward:number;count:number}>();
  for(const face of faces)for(let i=0;i<face.vertices.length;i++){
    const a=face.vertices[i],b=face.vertices[(i+1)%face.vertices.length],key=a<b?`${a}:${b}`:`${b}:${a}`;
    const seen=edges.get(key);
    if(!seen){edges.set(key,{line:face.line,forward:a,count:1});continue;}
    if(seen.count===2)throw new Error(`obj line ${face.line}: a third face on the edge between vertices ${a+1} and ${b+1} (lines ${seen.line} and ${face.line} already share it); the surface must be manifold`);
    if(seen.forward===a)throw new Error(`obj lines ${seen.line} and ${face.line}: both faces wind the same way along the edge between vertices ${a+1} and ${b+1}; flip one`);
    seen.count=2;
  }
}

function optionsObject(options:unknown):asserts options is ObjOptions {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('obj options must be an object');
  const {up,objects}=options as ObjOptions;
  if(up!==undefined&&up!=='y'&&up!=='z')throw new Error(`obj up must be 'y' or 'z'`);
  if(objects!==undefined&&(!Array.isArray(objects)||!objects.every(name=>typeof name==='string')))throw new Error('obj objects must be a list of object names');
}

/** A mesh from the text of an OBJ file. See the module note for what is
 * read and what refuses. */
export function obj(text:string,options:ObjOptions={}):Mesh<{},{},{object?:string;group?:string},{}> {
  if(typeof text!=='string')throw new Error('obj needs the text of an OBJ file; in a sketch, t.asset(\'name.obj\')');
  optionsObject(options);
  const {up='y',objects,...geometry}=options;
  const parsed=parseObj(text,up);
  const wanted=objects?new Set(objects):undefined;
  const faces=wanted?parsed.faces.filter(f=>f.object!==undefined&&wanted.has(f.object)):parsed.faces;
  if(parsed.positions.length===0)return emptyMesh(geometry);
  checkEdges(faces);
  // Only the vertices the kept faces use, in first-use order, so a stray
  // vertex or a filtered-out object leaves nothing behind. A file with
  // vertices and no faces keeps every vertex: it is a point cloud.
  const remap=new Map<number,number>();
  const positions:Vec3[]=[];
  const use=(v:number):number=>{let i=remap.get(v);if(i===undefined){i=positions.length;remap.set(v,i);positions.push(parsed.positions[v]);}return i;};
  const polygons=faces.map(f=>f.vertices.map(use));
  if(faces.length===0&&!wanted)parsed.positions.forEach((_,v)=>use(v));
  const mesh=new Mesh(ownSurface3(surface3(positions,polygons)),geometry);
  const named=faces.some(f=>f.object!==undefined),grouped=faces.some(f=>f.group!==undefined);
  if(!named&&!grouped)return mesh as Mesh<{},{},{object?:string;group?:string},{}>;
  return mesh.faceAttributes(row=>{
    const f=faces[row.index];
    return {...(named?{object:f.object??''}:{}),...(grouped?{group:f.group??''}:{})};
  }) as unknown as Mesh<{},{},{object?:string;group?:string},{}>;
}
