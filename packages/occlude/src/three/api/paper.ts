import {material,type Material} from '../../material.js';
import {paperToUser} from '../../record.js';
import type {Execution} from '../../execution.js';
import {toCamera3,toPaper3,type CameraFrame3} from '../camera.js';
import {isLineArt3,type LineArtScene3} from '../scene.js';
import {isDrawing3,type Drawing3} from '../drawing.js';
import {viewFrame3} from '../resolve.js';
import type {Vec3} from '../math.js';
import {position3,type PointLike3} from './query.js';

/** What a view can be asked about: the drawing a sketch holds, or the captured
 * scene inside it. */
export type ViewSource3=Drawing3|LineArtScene3;
export type PaperPoints3=Iterable<PointLike3>|{readonly points:Iterable<PointLike3>};
const NOWHERE:readonly [number,number]=Object.freeze([Number.NaN,Number.NaN]);

function sceneOf(view:ViewSource3):LineArtScene3 {
  if(isDrawing3(view))return view.scene;
  if(isLineArt3(view))return view;
  throw new Error('toPaper requires the drawing a view returned, or its scene');
}
/** One world point in drawable units, or a pair of NaN when it has no place on
 * the paper: behind the eye there is nothing to draw and nothing to point at. */
function projected(frame:CameraFrame3,toUser:(x:number,y:number)=>[number,number],point:Vec3):readonly [number,number] {
  const camera=toCamera3(frame,point);
  if(!(-camera[2]>0))return NOWHERE;
  const paper=toPaper3(frame,camera);
  return Object.freeze(toUser(paper[0],paper[1]));
}
const single=(value:unknown):boolean=>Array.isArray(value)&&value.length===3&&value.every(n=>typeof n==='number')
  ||!!value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as {x:unknown}).x==='number'&&typeof (value as {z:unknown}).z==='number';
function list(value:PaperPoints3):readonly PointLike3[] {
  const source=value&&typeof value==='object'&&'points' in value?(value as {points:Iterable<PointLike3>}).points:value;
  if(!source||typeof (source as Iterable<PointLike3>)[Symbol.iterator]!=='function')throw new Error('toPaper takes one 3D point, or points: an array, a selection, or geometry that answers points');
  return [...source as Iterable<PointLike3>];
}
/** Where a view puts a world point on the paper.
 *
 * A point in, a drawable `[x, y]` pair out; points in, a material of those
 * pairs out, so a label or a leader line can be placed where the drawing
 * already put an object. The camera is the view's own, including a camera the
 * studio has committed, so the pair lands exactly where the view's lines do.
 * A point behind the eye has no place on the paper: the pair is NaN, and a
 * material skips it. */
export function bindToPaper3(exec:Execution) {
  function toPaper(view:ViewSource3,point:PointLike3):readonly [number,number];
  function toPaper(view:ViewSource3,points:PaperPoints3):Material;
  function toPaper(view:ViewSource3,input:PointLike3|PaperPoints3):readonly [number,number]|Material {
    const frame=viewFrame3(exec,sceneOf(view)),toUser=paperToUser(exec.frame);
    if(single(input))return projected(frame,toUser,position3(input as PointLike3));
    const points=list(input as PaperPoints3).map(p=>projected(frame,toUser,position3(p)));
    return material(points.filter(p=>p.every(Number.isFinite)) as unknown as readonly (readonly [number,number])[]);
  }
  return toPaper;
}
