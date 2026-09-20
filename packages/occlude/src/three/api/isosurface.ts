/**
 * Marching cubes: the surface of a distance field, as a mesh.
 *
 * The cube's 256 cases are GENERATED here at load, from the cube's own
 * geometry, following the public description of Lorensen & Cline's marching
 * cubes (SIGGRAPH 1987) and Paul Bourke's public-domain notes for the corner
 * and edge numbering every such table uses. No table is copied from another
 * implementation.
 *
 * The generator also settles the ambiguous faces, which a copied table leaves
 * open: on each face of a cube, the crossings are paired by walking the face
 * anticlockwise SEEN FROM OUTSIDE and joining every crossing where the walk
 * enters the solid to the next crossing where it leaves. The pairing reads
 * only the four signs of that face, so the two cubes that share a face always
 * pair it the same way and traverse it in opposite directions. That is what
 * makes the output closed: every edge carries exactly two triangles, every
 * vertex one ring, and the winding is outward everywhere without a normal
 * test. A field is POSITIVE INSIDE (see `sdf3`), so the walk is what fixes
 * the sign, not the gradient.
 */
import {surface3} from '../geometry/surface.js';
import {ownSurface3} from '../geometry/model.js';
import {Mesh,emptyMesh,type GeometryOptions} from './mesh.js';
import {clampSetting,emptyCount,emptySize} from '../degenerate.js';
import {finite3,type Vec3} from '../math.js';
import type {DistanceField3} from './sdf3.js';

/** The cube's corners, in the order the case bits read them. */
const CORNERS:readonly Vec3[]=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
/** The cube's twelve edges, in the standard numbering. */
const EDGES:readonly (readonly [number,number])[]=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
/** The six faces, each anticlockwise seen from OUTSIDE the cube. */
const FACES:readonly (readonly number[])[]=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]];
/** The axis each edge runs along, and the corner it runs from. */
const EDGE_AXIS=EDGES.map(([a,b])=>[0,1,2].findIndex(k=>CORNERS[a][k]!==CORNERS[b][k]));
const EDGE_LOW=EDGES.map(([a,b],e)=>CORNERS[a][EDGE_AXIS[e]]<CORNERS[b][EDGE_AXIS[e]]?CORNERS[a]:CORNERS[b]);

/** One loop of edge crossings per connected piece of the surface in the cube,
 * in winding order, for each of the 256 sign patterns. */
function cubeCases():readonly (readonly (readonly number[])[])[] {
  const edgeOf=new Int8Array(64).fill(-1);
  EDGES.forEach(([a,b],e)=>{edgeOf[a*8+b]=e;edgeOf[b*8+a]=e;});
  const cases:(readonly number[])[][]=[];
  for(let code=0;code<256;code++){
    const inside=(c:number)=>(code>>c&1)===1;
    // `after[edge]` is the crossing the surface runs to next.
    const after=new Int8Array(12).fill(-1);
    for(const face of FACES){
      const crossings:{edge:number;enter:boolean}[]=[];
      for(let i=0;i<4;i++){
        const u=face[i],v=face[(i+1)%4];
        if(inside(u)===inside(v))continue;
        crossings.push({edge:edgeOf[u*8+v],enter:inside(v)});
      }
      for(let i=0;i<crossings.length;i++){
        if(!crossings[i].enter)continue;
        for(let k=1;k<=crossings.length;k++){
          const leaving=crossings[(i+k)%crossings.length];
          if(!leaving.enter){after[crossings[i].edge]=leaving.edge;break;}
        }
      }
    }
    const loops:number[][]=[],walked=new Uint8Array(12);
    for(let e=0;e<12;e++){
      if(after[e]<0||walked[e])continue;
      const loop:number[]=[];
      for(let cur=e;cur>=0&&!walked[cur];cur=after[cur]){walked[cur]=1;loop.push(cur);}
      if(loop.length>=3)loops.push(loop);
    }
    cases.push(loops);
  }
  return cases;
}
const CASES=cubeCases();

export interface IsosurfaceOptions extends GeometryOptions {
  /** The corner-to-corner box the field is read in: `[[minX, minY, minZ], [maxX, maxY, maxZ]]`. */
  readonly bounds:readonly [Vec3,Vec3];
  /** The level the surface is taken at; 0 (the boundary of the solid) by default. */
  readonly level?:number;
  /** Cells along the LONGEST side of the box, the others divided to match so
   * the cells stay cubes; a triple sets the three counts itself. */
  readonly resolution:number|readonly [number,number,number];
  /** Laplacian passes over the result: each one moves every point halfway to
   * the mean of its neighbours. Rounds the staircase of a coarse grid, and
   * shrinks the solid a little. None by default. */
  readonly smooth?:number;
}

/** The output limit, spelled as the primitives spell it. */
function budget(points:number,faces:number):void{if(points>500000||faces>250000)throw new Error('isosurface exceeds budget (500000 points / 250000 faces)');}
const cellCounts=(resolution:IsosurfaceOptions['resolution'],size:Vec3):[number,number,number]|undefined=>{
  if(Array.isArray(resolution)){
    const given=resolution as readonly number[];
    if(given.length!==3)throw new Error('isosurface resolution must be a count or a triple of counts');
    return given.some(n=>emptyCount(n,1,'isosurface resolution'))?undefined:[given[0],given[1],given[2]];
  }
  if(typeof resolution!=='number')throw new Error('isosurface resolution must be a count or a triple of counts');
  if(emptyCount(resolution,1,'isosurface resolution'))return undefined;
  const longest=Math.max(...size);
  return size.map(s=>Math.max(1,Math.round(resolution*s/longest))) as unknown as [number,number,number];
};

/**
 * The surface of a distance field, as a mesh: marching cubes over `bounds` at
 * `resolution`, with the vertices placed along the cell edges by linear
 * interpolation and shared between the cells that meet there, so the result
 * is closed wherever the solid is closed inside the box. `sdf3` builds the
 * field; anything else that answers `(x, y, z)` with a number, positive
 * inside, works the same.
 *
 * A solid that leaves the box is cut off there and comes back open along the
 * wall — give the box room if you want a closed surface. A box with no
 * extent, a resolution below one cell, and a field that is nowhere inside
 * each draw nothing: the result is an empty mesh.
 */
export function isosurface(field:DistanceField3,options:IsosurfaceOptions):Mesh {
  if(typeof field!=='function')throw new Error('isosurface: expected a distance field, a function of (x, y, z)');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('isosurface options must be an object');
  const box=options.bounds;
  if(!Array.isArray(box)||box.length!==2)throw new Error('isosurface bounds must be a [min, max] pair of triples');
  const [min,max]=box as readonly [Vec3,Vec3];
  finite3(min);finite3(max);
  const size:Vec3=[max[0]-min[0],max[1]-min[1],max[2]-min[2]];
  const level=clampSetting(options.level,-Number.MAX_VALUE,Number.MAX_VALUE,0,'isosurface level');
  const counts=emptySize(...size)?undefined:cellCounts(options.resolution,size);
  const passes=options.smooth===undefined||emptyCount(options.smooth,1,'isosurface smooth')?0:options.smooth;
  if(!counts)return emptyMesh(options);
  const [nx,ny,nz]=counts;
  // The sampling limit: a real ceiling on the work, not a nudge.
  if(nx*ny*nz>2_000_000)throw new Error('isosurface exceeds budget (2000000 cells)');
  const step:Vec3=[size[0]/nx,size[1]/ny,size[2]/nz];
  const cols=nx+1,rows=ny+1;
  const at=(i:number,j:number,k:number)=>(k*rows+j)*cols+i;
  const values=new Float64Array(cols*rows*(nz+1));
  for(let k=0;k<=nz;k++)for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){
    const answer=field(min[0]+i*step[0],min[1]+j*step[1],min[2]+k*step[2]);
    // A sample the field could not give is not inside: it draws nothing here
    // rather than failing the whole surface.
    values[at(i,j,k)]=typeof answer==='number'?answer:Number.NaN;
  }
  const points:Vec3[]=[],triangles:number[][]=[],known=new Map<number,number>();
  /** The crossing on one grid edge, made once and shared by every cell on it. */
  const crossing=(i:number,j:number,k:number,edge:number):number=>{
    const low=EDGE_LOW[edge],axis=EDGE_AXIS[edge];
    const gi=i+low[0],gj=j+low[1],gk=k+low[2],cell=at(gi,gj,gk),key=cell*3+axis;
    const held=known.get(key);
    if(held!==undefined)return held;
    const a=values[cell],b=values[at(gi+(axis===0?1:0),gj+(axis===1?1:0),gk+(axis===2?1:0))];
    // A crossing exactly on a grid point would put two vertices in one place,
    // so it is held just off the corner; an unusable pair splits the edge.
    const raw=Number.isFinite(a)&&Number.isFinite(b)&&a!==b?(level-a)/(b-a):0.5;
    const t=Math.min(1-1e-6,Math.max(1e-6,raw));
    const position=[min[0]+gi*step[0],min[1]+gj*step[1],min[2]+gk*step[2]];
    position[axis]+=t*step[axis];
    points.push(position as unknown as Vec3);known.set(key,points.length-1);
    return points.length-1;
  };
  const vertices=new Int32Array(12);
  for(let k=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    let code=0;
    for(let c=0;c<8;c++){const p=CORNERS[c];if(values[at(i+p[0],j+p[1],k+p[2])]>level)code|=1<<c;}
    const loops=CASES[code];
    if(loops.length===0)continue;
    for(const loop of loops){
      for(const edge of loop)vertices[edge]=crossing(i,j,k,edge);
      // A fan: the loop's own edges carry one triangle each and the diagonals
      // two, so the cell stays as closed as the loop is.
      for(let n=1;n+1<loop.length;n++)triangles.push([vertices[loop[0]],vertices[loop[n]],vertices[loop[n+1]]]);
    }
  }
  budget(points.length,triangles.length);
  if(triangles.length===0)return emptyMesh(options);
  return new Mesh(ownSurface3(surface3(relax(points,triangles,passes),triangles)),options);
}

/** Laplacian passes: every point moves halfway to the mean of the points it
 * shares a triangle edge with. Topology does not change. */
function relax(points:readonly Vec3[],triangles:readonly number[][],passes:number):Vec3[] {
  let current=points.map(p=>[p[0],p[1],p[2]] as Vec3);
  if(passes<1)return current;
  const neighbours=points.map(()=>new Set<number>());
  for(const t of triangles)for(let i=0;i<3;i++){neighbours[t[i]].add(t[(i+1)%3]);neighbours[t[(i+1)%3]].add(t[i]);}
  for(let pass=0;pass<passes;pass++){
    current=current.map((p,i)=>{
      const ring=neighbours[i];
      if(ring.size===0)return p;
      let x=0,y=0,z=0;
      for(const n of ring){x+=current[n][0];y+=current[n][1];z+=current[n][2];}
      const k=ring.size;
      return [(p[0]+x/k)/2,(p[1]+y/k)/2,(p[2]+z/k)/2] as Vec3;
    });
  }
  return current;
}
