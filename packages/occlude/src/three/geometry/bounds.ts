import type {Vec3} from '../math.js';
export type WorldBounds3=readonly [number,number,number,number,number,number];
interface Node {readonly bounds:WorldBounds3;readonly left?:Node;readonly right?:Node;readonly indices?:readonly number[]}
export function worldBounds3(points:readonly Vec3[]):WorldBounds3 {
 // Empty geometry has empty bounds: a box that contains and overlaps nothing.
 // Reachable since a degenerate construction returns an empty surface.
 if(!points.length)return Object.freeze([Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]) as unknown as WorldBounds3;
 const b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
 for(const p of points)for(let k=0;k<3;k++){if(!Number.isFinite(p[k]))throw new Error('world bounds require finite coordinates');b[k]=Math.min(b[k],p[k]);b[k+3]=Math.max(b[k+3],p[k]);}
 return Object.freeze(b) as unknown as WorldBounds3;
}
export const overlaps3=(a:WorldBounds3,b:WorldBounds3)=>a[0]<=b[3]&&a[3]>=b[0]&&a[1]<=b[4]&&a[4]>=b[1]&&a[2]<=b[5]&&a[5]>=b[2];
/** Closed bounds over represented vertices need no coordinate expansion.
 * A rational point inside such bounds also rounds inside their representable
 * endpoints; consumers requiring arithmetic envelopes must supply those bounds. */
export class WorldIndex3 {
 private constructor(private readonly bounds:readonly WorldBounds3[],private readonly root?:Node){Object.freeze(this);}
 static *build(bounds:readonly WorldBounds3[]):Generator<void,WorldIndex3> {
  const owned:WorldBounds3[]=[];
  for(let i=0;i<bounds.length;i++){
   const b=bounds[i];if(b.length!==6||!b.every(Number.isFinite)||[0,1,2].some(k=>b[k]>b[k+3]))throw new Error('invalid world bounds');
   owned.push(Object.freeze([...b]) as unknown as WorldBounds3);if((i&1023)===1023)yield;
  }
  function* build(indices:number[]):Generator<void,Node>{
   const b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
   for(let j=0;j<indices.length;j++){const box=owned[indices[j]];for(let k=0;k<3;k++){b[k]=Math.min(b[k],box[k]);b[k+3]=Math.max(b[k+3],box[k+3]);}if((j&1023)===1023)yield;}
   const box=Object.freeze(b) as unknown as WorldBounds3;
   if(indices.length<=8)return Object.freeze({bounds:box,indices:Object.freeze(indices)});
   let axis=0;for(let k=1;k<3;k++)if(b[k+3]-b[k]>b[axis+3]-b[axis])axis=k;
   indices.sort((a,c)=>(owned[a][axis]/2+owned[a][axis+3]/2)-(owned[c][axis]/2+owned[c][axis+3]/2)||a-c);
   yield;
   const middle=Math.floor(indices.length/2),left=yield*build(indices.slice(0,middle)),right=yield*build(indices.slice(middle));
   return Object.freeze({bounds:box,left,right});
  }
  const root=bounds.length?yield*build(bounds.map((_,i)=>i)):undefined;
  return new WorldIndex3(Object.freeze(owned),root);
 }
 *query(bounds:WorldBounds3):Generator<number>{
  const stack=this.root?[this.root]:[];
  while(stack.length){const node=stack.pop()!;if(!overlaps3(bounds,node.bounds))continue;
   if(node.indices){for(const i of node.indices)if(overlaps3(bounds,this.bounds[i]))yield i;}
   else stack.push(node.right!,node.left!);
  }
 }
}
