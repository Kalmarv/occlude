/**
 * The single engine bugs of the friction audit (spec 65, audit N7): one
 * test per entry id, each the audit sketch's failing line made to pass.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { image } from '../src/imageAsset.js';
import { areaLoops } from '../src/boundary.js';
import { alignAxis, box, cone, instanceOnPoints, plane, pointCloud, sphere, type Mesh } from '../src/three/api/index.js';
import { add3, cross3, dot3, mul3, sub3, type Vec3 } from '../src/three/math.js';
import { captureHatch, hatchSurface, hatchTraceJob } from '../src/three/api/hatch.js';
import { runGeometryJob3 } from '../src/three/geometry/job.js';
import { surfaceBinding3 } from '../src/three/curves/network.js';
import { traceBoth3, traceEnvironment3 } from '../src/three/surface/trace.js';
import { surfaceLocation3 } from '../src/three/geometry/location.js';
import { add, append, assetTable, circle, curl, curve, dots, evalPrim, exportPng, exportSvg, fill, fromAngle, group, initOcclude, line, material, mm, mul, ngon, pen, polygon, query, rect, render, sketch, strokes } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

describe('G3-1 curve is open unless closed: true', () => {
  it('builds a chain by default and a ring on request', () => {
    const pts: [number, number][] = [[0, 0], [1 / 3, 0], [0.5, 0.25], [2 / 3, 0], [1, 0]];
    expect(curve(pts).edgeCount).toBe(4);
    expect(curve(pts).curves()[0].closed).toBe(false);
    expect(curve(pts, { closed: true }).edgeCount).toBe(5);
  });
  it('is a motif replace takes as written (reference-steps-3)', () => {
    const t = toolkit();
    const motif = curve([[0, 0], [1 / 3, 0], [0.5, 0.25], [2 / 3, 0], [1, 0]]);
    const seed = t.sample(circle(50, 50, 30), { count: 6 });
    const bent = seed.steps(3, (cur, next) => next.replace(cur.edges, motif));
    expect(bent.edgeCount).toBe(6 * 4 ** 3);
  });
});

describe('G4-2 withEdges replaces the edge list', () => {
  it('withEdges([]) leaves the samples as a loose cloud (examples-tangle-1)', () => {
    const t = toolkit();
    const ring = t.sample(circle([100, 50], 20), { count: 26 });
    expect(ring.edgeCount).toBe(26);
    const loose = ring.withEdges([]);
    expect(loose.edgeCount).toBe(0);
    expect(loose.n).toBe(26);
    expect(Array.from(loose.pointIds)).toEqual(Array.from(ring.pointIds));
  });
  it('keeps the id and columns of a pair it names again, and mints the rest', () => {
    const m = material([[0, 0], [10, 0], [20, 0]], { edges: [[0, 1], [1, 2]] }).edgeAttribute('w', (e) => e.index + 1);
    const out = m.withEdges([[2, 0], [1, 0]], { w: 9 });
    expect(out.edgeCount).toBe(2);
    expect(Array.from(out.edgeAttrs.w)).toEqual([9, 1]);
    expect(out.edgeIds[1]).toBe(m.edgeIds[0]);
    expect(m.edgeIds).not.toContain(out.edgeIds[0]);
  });
});

describe('G4-17 G7-8 planarize gives a crossing the first edge\'s columns', () => {
  it('planarizes a grown network with per-strand columns (examples-network-3)', () => {
    const t = toolkit({ seed: 7 });
    const rock = t.sample(circle(100, 46, 16), { count: 40 });
    const seeds = material(t.times(9, (i, u) => [14 + u * 172, 96]), { active: 1, heading: -Math.PI / 2 });
    const paths = append(rock, seeds, { fill: { active: 0, heading: 0 } }).steps(40, (current, next, k) => {
      const lines = query.edges(current);
      const tips = current.points.filter((p) => p.active === 1 && p.y > 4 && p.x > 3 && p.x < 197);
      next.extrude(tips, (p) => {
        const h = p.heading + t.noise(p.x / 10, p.y / 10, k) * 0.5;
        const hit = lines.firstHit(p, add(p, mul(fromAngle(h), 2.2)), { excludeIncident: p });
        if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h } }) };
        const headings = t.chance(0.08) ? [h - 0.6, h + 0.6] : [h];
        return headings.map((hh) => ({ position: add(p, mul(fromAngle(hh), 2.2)), attributes: { heading: hh } }));
      }, { inherit: true });
      next.set(tips, { active: 0 });
    });
    const regions = paths.planarize().faces();
    expect(regions.length).toBeGreaterThan(0);
  });
  it('takes the value along the lowest edge row, and point: overrides it', () => {
    const a = curve([[0, 0], [10, 10]], { heading: [0, 10] });
    const b = curve([[0, 10], [10, 0]], { heading: [100, 200] });
    const p = append(a, b).planarize();
    expect(p.attrs.heading[4]).toBe(5); // halfway along edge 0
    expect(append(b, a).planarize().attrs.heading[4]).toBe(150); // halfway along edge 0, which is b now
    expect(append(a, b).planarize({ point: () => ({ heading: -1 }) }).attrs.heading[4]).toBe(-1);
  });
});

describe('G7-3 strokes refuses a shape by name', () => {
  it('names the shape and the door, not a face collection (workshop-02-2)', () => {
    const box = rect(15, 25, 70, 50);
    expect(() => strokes(box as never)).toThrow(/strokes: a shape is not geometry yet — .*t\.material\(shape\)/);
  });
  it('still names one face as an area', () => {
    const t = toolkit();
    const face = t.material(rect(10, 10, 20, 20)).faces().faces[0];
    expect(() => strokes(face as never)).toThrow(/one face is an area/);
  });
});

describe('G7-4 a history entry is a material', () => {
  it('draws with strokes as it is, and says its iteration (workshop-04-1)', () => {
    const t = toolkit();
    const square = t.sample(rect(40, 40, 20, 20), { count: 40 });
    const grown = square.steps(12, (current, next) => next.move(current.points, [0.5, 0]), { every: 6 });
    expect(grown.history.map((h) => h.iteration)).toEqual([0, 6, 12]);
    for (const h of grown.history) expect(strokes(h)).toHaveLength(1);
    expect(grown.history[2].x[0]).toBe(grown.x[0]);
  });
});

describe('G5-11 replace welds a motif point onto a point already there', () => {
  it('hands back a material whose faces read without planarize (examples-flake-1)', () => {
    const t = toolkit({ margin: 6 } as never);
    const h = Math.sqrt(3) / 6;
    const motif = material([[0, 0], [1 / 3, 0], [0.5, h], [2 / 3, 0], [1, 0]], { edges: [[0, 1], [1, 2], [2, 3], [3, 4]] });
    const cells = t.hexes({ spacing: mm(45) });
    const grown = cells.steps(2, (cur, next) => next.replace(cur.edges, motif));
    expect(grown.faces().length).toBeGreaterThan(0);
    const at = new Set<string>();
    for (let i = 0; i < grown.n; i++) at.add(`${grown.x[i].toFixed(9)},${grown.y[i].toFixed(9)}`);
    expect(at.size).toBe(grown.n);
  });
  it('welds two tips that meet into one point', () => {
    // Two walls meeting at a right angle; each motif's tip lands on (5, 5).
    const walls = material([[0, 10], [0, 0], [10, 0]], { edges: [[0, 1], [1, 2]], age: [1, 2, 3] });
    const tent = curve([[0, 0], [0.5, 0.5], [1, 0]]);
    const out = walls.steps(1, (cur, next) => next.replace(cur.edges, tent));
    expect(out.n).toBe(4);
    expect([out.x[3], out.y[3]]).toEqual([5, 5]);
    // Both tents run from the corner to (5, 5): one wall, drawn once.
    expect(out.edgeCount).toBe(3);
  });
});

describe('G3-7 G6-29 a flat tiling reads its faces at every depth', () => {
  it('keeps one placement per cell, so faces read for {4,4}, {3,6} and {6,3} (reference-geometry-3, examples-fivefold-4)', () => {
    const t = toolkit();
    // Cells within `depth` steps of the first: centred hexagonal and
    // square numbers, and the triangles' own count.
    const cells: Record<string, number[]> = { '6,3': [1, 7, 19, 37], '4,4': [1, 5, 13, 25], '3,6': [1, 4, 10, 19] };
    for (const [symbol, counts] of Object.entries(cells)) {
      const [p, q] = symbol.split(',').map(Number);
      for (let depth = 0; depth <= 3; depth++) {
        const tiles = t.tiling(p, q, { depth, side: 6 });
        expect(tiles.placements).toHaveLength(counts[depth]);
        expect(tiles.faces().length).toBe(counts[depth]);
      }
    }
    const deep = t.tiling(6, 3, { depth: 6, side: 6 });
    expect(deep.faces().length).toBe(127);
    // One wall per shared edge: a patch of 19 hexagons has 72 walls.
    expect(t.tiling(6, 3, { depth: 2, side: 6 }).edgeCount).toBe(72);
  });
});

describe('G5-20 a shape refuses an option it does not take', () => {
  it('names the key instead of drawing as if it were not written (examples-spindle-3)', () => {
    expect(() => ngon(28, 28, 5, 18, { rotation: -90 } as never)).toThrow(/a shape has no option 'rotation' — it takes pen, .*rotate/);
    expect(() => circle(0, 0, 1, { colour: 'red' } as never)).toThrow(/no option 'colour'/);
    // The turn about its own centre is the positional argument.
    expect(ngon(28, 28, 5, 18, -90).geom).toMatchObject({ kind: 'ngon', rotation: -90 });
    expect(() => ngon(28, 28, 5, 18, -90, { rotate: 36, origin: 'center', pen: 'x' })).not.toThrow();
  });
});

describe('G2-11 a face\'s walls wind one stated way', () => {
  it('extracts each face so along normals point into it (reference-material-3)', () => {
    const t = toolkit({ seed: 1 });
    const parts = append(t.material(rect(20, 20, 30, 30)), t.material(rect(50, 20, 30, 30)), t.material(ngon(50, 60, 6, 22)));
    const cells = parts.merge().planarize().rotate(12, { origin: 'centroid' }).faces();
    expect(cells.length).toBeGreaterThan(2);
    for (const f of cells) {
      const stations = f.extract().along({ spacing: 5 });
      expect(stations.length).toBeGreaterThan(4);
      for (const s of stations) {
        const [nx, ny] = s.normal;
        expect(nx * (f.centroid[0] - s.x) + ny * (f.centroid[1] - s.y)).toBeGreaterThan(0);
      }
      // contours() already wound so: the outer boundary has positive area.
      const [outer] = f.contours();
      let a = 0;
      for (let i = 0; i < outer.pts.length; i++) {
        const [x0, y0] = outer.pts[i];
        const [x1, y1] = outer.pts[(i + 1) % outer.pts.length];
        a += x0 * y1 - x1 * y0;
      }
      expect(a).toBeGreaterThan(0);
    }
  });
});

describe('G2-21 m.transform takes a transform record with group\'s meaning', () => {
  it('lands every p6m copy where group(record, …) draws it (reference-transforms-2)', () => {
    const ends = (tree: () => unknown) => {
      const out = render(sketch({ aspect: [1, 1] }, tree as never), { paper: 'Square20' });
      return out.frags.map((f) => [evalPrim(f.geom, 0), evalPrim(f.geom, 1)].flat().map((v) => Math.round(v * 1e6) / 1e6)).sort().join(';');
    };
    const t = toolkit();
    const records = t.symmetry('p6m', { cell: 24 }).slice(0, 12);
    expect(records.some((r) => Array.isArray(r.scale))).toBe(true); // mirrors are in the set
    const motif = curve([[3, 1], [8, 2]]);
    for (const r of records) {
      const viaGroup = ends(() => group(r, line(3, 1, 8, 2)));
      const viaMaterial = ends(() => strokes(motif.transform(r)));
      expect(viaMaterial).toBe(viaGroup);
    }
  });
  it('builds a wallpaper as one material, keeps ids, and refuses a frame word by name', () => {
    const t = toolkit();
    const motif = curve([[0, 0], [8, 2], [6, 9]], { closed: true });
    const copies = t.symmetry('p6m', { cell: 24 }).map((p) => motif.transform(p));
    expect(append(...copies).merge().planarize().faces().length).toBeGreaterThan(0);
    expect(Array.from(copies[1].pointIds)).toEqual(Array.from(motif.pointIds));
    // 'center' is the one Origin of every pivot: the material's own middle.
    const mid: [number, number] = [(Math.min(...motif.x) + Math.max(...motif.x)) / 2, (Math.min(...motif.y) + Math.max(...motif.y)) / 2];
    const byWord = motif.transform({ rotate: 30, origin: 'center' });
    const byPoint = motif.transform({ rotate: 30, origin: mid });
    for (let i = 0; i < motif.n; i++) {
      expect(byWord.x[i]).toBeCloseTo(byPoint.x[i], 9);
      expect(byWord.y[i]).toBeCloseTo(byPoint.y[i], 9);
    }
    expect(() => motif.transform({ translate: [mm(3), 0] })).toThrow(/translate\[0\] is .* give a finite number/);
  });
});

describe('G3-14 a headless export of t.draw({ minutes }) takes the machine timing', () => {
  const def = sketch({ aspect: [1, 1], seed: 5 }, (t) => {
    t.draw({ minutes: [0, 3] });
    return [dots(t.scatter({ spacing: 3 }), { pen: 'stabilo-88-blue' }), strokes(t.sample(circle(50, 50, 30), { count: 80 }))];
  });
  it('exports with timing, and refuses without it naming the export option (reference-plotting-3)', () => {
    const timing = {
      penOf: () => ({ feed: 3000, penDelay: 150 }),
      opts: { travelFeed: 8000, acceleration: 800, travelAcceleration: 1500, junctionDeviation: 0.05, minimumCruiseRatio: 0.5 },
    };
    expect(exportPng(def, { paper: 'Square20', scale: 2, timing }).length).toBeGreaterThan(0);
    expect(() => exportPng(def, { paper: 'Square20', scale: 2 })).toThrow(/give the export \{ timing: \{ penOf, opts \} \}/);
  });
});

describe('G2-6 area is a measured size; a share is a fraction', () => {
  // Left half black, right half white, 16 × 16 pixels over 40 units.
  const img = () => {
    const w = 16, h = 16, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * w + x) * 4);
    return image(assetTable([['t.png', { pixels: { width: w, height: h, data } }]]), 't.png', { width: 40 });
  };
  it('names a region\'s fraction share, as a palette entry does (reference-images-1)', () => {
    const regions = img().regions({ count: 2 });
    expect(regions.map((r) => r.share)).toEqual([0.5, 0.5]);
    expect(regions.every((r) => !('area' in r))).toBe(true);
  });
  it('gives a palette entry\'s outline as contours(), so it is an area as it is', () => {
    const [dark] = img().palette(2).filter((e) => e.color === '#000000');
    expect(dark.contours().length).toBeGreaterThan(0);
    expect(areaLoops(dark, 'polygon').length).toBe(dark.contours().length);
  });
});

/** A tiny deterministic stream, so the 3D tests never read the sketch RNG. */
const stream = (seed = 1) => { let v = seed >>> 0 || 1; return () => { v ^= v << 13; v >>>= 0; v ^= v >>> 17; v ^= v << 5; v >>>= 0; return v / 4294967296; }; };

describe('G3-40 a location has uv where its face has a chart, as the fields page says', () => {
  it('reads uv and tangentU on a primitive, and neither on a boolean\'s result', () => {
    const at = (m: { surface: Parameters<typeof surfaceLocation3>[0] }) => surfaceLocation3(m.surface, 0, [1 / 3, 1 / 3, 1 / 3]);
    for (const primitive of [box(2), plane(2), sphere(1)]) {
      const s = at(primitive);
      expect(s.chartStatus).toBe('regular');
      expect(s.uv).toHaveLength(2);
      expect(s.tangentU).toHaveLength(3);
    }
    const cut = at(box(2).subtract(sphere(1.1, { segments: 24, rings: 12 }).translate([1, 1, 1])));
    expect(cut.chartStatus).toBe('missing');
    expect(cut.uv).toBeUndefined();
    expect(cut.tangentU).toBeUndefined();
  });
});

describe('G3-41 a lane that turns back on itself is a lane, not an assert', () => {
  it('hatches a displaced sheet along a curly field (reference-3d-fields-1)', () => {
    const t = toolkit({ seed: 42 });
    const sheet = plane(4, 4).subdivide(4).displace((p) => [0, 0, 0.3 * Math.sin(p.x * 1.2)]);
    const flow = curl((x, y) => t.noise(x * 3, y * 3));
    const options = { spacing: 0.08, tone: 1, direction: (s: { uv?: readonly [number, number] }) => { const [u, v] = s.uv ?? [0, 0]; const d = flow(u, v); return [d[0], d[1], 0] as [number, number, number]; } };
    const traced = runGeometryJob3(hatchTraceJob(captureHatch(sheet, options), stream(1))).value;
    for (const { trace } of traced.families[0].surfaces[0].traces) {
      for (let i = 1; i < trace.nodes.length; i++) expect(trace.nodes[i].distance).toBeGreaterThanOrEqual(trace.nodes[i - 1].distance);
    }
    expect(hatchSurface(sheet, options, stream(1)).stats.segments).toBeGreaterThan(1000);
  });
  it('returns a loop found walking backward as one closed lane, its distances running forward', () => {
    const sheet = plane(4, 4).subdivide(4);
    const env = traceEnvironment3(sheet.surface, surfaceBinding3(sheet.surface));
    // A seed about one unit from the middle, on a field that turns round it.
    const centre = (t: number) => { const [a, b, c] = sheet.surface.triangles[t].vertices.map((v) => sheet.surface.points[v].position); return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]; };
    const triangle = sheet.surface.triangles.map((_, i) => i).find((i) => Math.abs(Math.hypot(...centre(i)) - 1) < 0.15)!;
    const round = (s: { position: readonly number[] }) => [-s.position[1], s.position[0], 0] as [number, number, number];
    // The forward half is stopped at once; the backward half goes round.
    let calls = 0;
    // Straight steps round a circle spiral out a little: short ones keep
    // the return inside the seed's own triangle, where a loop closes.
    const opts = { step: 0.005, maxLength: 50, maxSteps: Infinity, creaseDegrees: 60, loopDistance: 0.05 };
    const lane = traceBoth3(env, { triangle, weights: [1 / 3, 1 / 3, 1 / 3] }, round as never, opts, { occupied: () => calls++ === 0 });
    expect(lane.closed).toBe(true);
    expect(lane.length).toBeGreaterThan(5);
    expect(lane.nodes[0].distance).toBe(0);
    for (let i = 1; i < lane.nodes.length; i++) expect(lane.nodes[i].distance).toBeGreaterThanOrEqual(lane.nodes[i - 1].distance);
    expect(lane.nodes[lane.nodes.length - 1].distance).toBe(lane.length);
    expect(lane.supports).toHaveLength(lane.nodes.length - 1);
  });
});

describe('G3-42 t.hatch reaches every face the direction crosses', () => {
  const solid = () => box(2).subtract(sphere(1.1, { segments: 24, rings: 12 }).translate([1, 1, 1]));
  it('hatches the scoop a boolean cut, whatever the random stream (reference-3d-fields-4)', () => {
    const m = solid();
    const s = m.surface;
    const onScoop = (tri: number) => {
      const c = s.triangles[tri].vertices.map((v) => s.points[v].position).reduce((a, p) => [a[0] + p[0] / 3, a[1] + p[1] / 3, a[2] + p[2] / 3], [0, 0, 0]);
      return Math.abs(Math.hypot(c[0] - 1, c[1] - 1, c[2] - 1) - 1.1) < 0.08;
    };
    for (const seed of [1, 2, 3, 4, 5]) {
      const { curves, stats } = hatchSurface(m, { direction: [0, 0, 1], spacing: 0.08, tone: 1 }, stream(seed));
      expect(curves.network.segments.filter((seg) => onScoop(seg.supports[0].triangle)).length).toBeGreaterThan(400);
      expect(stats.sweepSeeds).toBeGreaterThan(0);
    }
  });
  it('walks nothing on a face whose normal is the direction', () => {
    const top = plane(2, 2).subdivide(2);
    const { stats } = hatchSurface(top, { direction: [0, 0, 1], spacing: 0.1, tone: 1 }, stream(1));
    expect(stats.segments).toBe(0);
    expect(stats.accepted).toBe(0);
  });
});

describe('G3-35 a cone base that lies on a sphere facet and crosses its edges unites exactly',()=>{
 /** Closed, edge-manifold, consistently wound: every edge has two faces that walk it in opposite directions. */
 const manifold=(m:Mesh<any,any,any,any>,chi:number)=>{
  const s=m.surface;
  expect(s.edges.filter(e=>e.faces.length!==2)).toHaveLength(0);
  expect(s.points.length-s.edges.length+s.faces.length).toBe(chi);
  const walk=new Map<string,number>();
  for(const f of s.faces)for(let i=0;i<f.vertices.length;i++){const a=f.vertices[i],b=f.vertices[(i+1)%f.vertices.length],key=`${Math.min(a,b)}:${Math.max(a,b)}`;walk.set(key,(walk.get(key)??0)+(a<b?1:-1));}
  expect([...walk.values()].every(n=>n===0)).toBe(true);
 };
 const volume=(m:Mesh<any,any,any,any>)=>{let total=0;const s=m.surface;for(const t of s.triangles){const [a,b,c]=t.vertices.map(i=>s.points[i].position);total+=dot3(a,cross3(b,c))/6;}return total;};
 const spike=()=>cone(0.06,0.3,{segments:8}).translate([0,0,0.15]);

 it('unites a few cones stood on facets by the facet normal, near each facet edge in turn',()=>{
  const ball=sphere(1.2,{segments:32,rings:16}),s=ball.surface;
  // Three triangles well apart in the upper hemisphere; each cone sits 0.03
  // from a different edge of its triangle, so its 0.06 base crosses that edge.
  const upper=s.triangles.map((t,i)=>({i,c:t.vertices.map(v=>s.points[v].position)})).filter(({c})=>c.every(p=>p[2]>0.3&&p[2]<1.0));
  const picks=[upper[0],upper[Math.floor(upper.length/3)],upper[Math.floor(2*upper.length/3)]];
  const sites:Vec3[]=[],normals:Vec3[]=[];
  picks.forEach(({c},k)=>{
   const [a,b,d]=[c[k%3],c[(k+1)%3],c[(k+2)%3]],n=cross3(sub3(b,a),sub3(d,a)),unit=mul3(n,1/Math.hypot(...n));
   const middle=mul3(add3(a,b),0.5),inward=sub3(mul3(add3(add3(a,b),d),1/3),middle);
   sites.push(add3(middle,mul3(inward,0.03/Math.hypot(...inward))));normals.push(unit);
  });
  const cones=instanceOnPoints(spike(),pointCloud(sites).points,{rotate:p=>alignAxis('z',normals[p.index])}).realize();
  for(const [x,y] of [[ball,cones],[cones,ball]] as const){
   const united=x.unite(y);
   manifold(united,2);
   // Each cone stands on the ball and hides none of it: nothing is lost or doubled.
   expect(volume(united)).toBeCloseTo(volume(ball)+volume(cones),9);
  }
  expect(volume(ball.subtract(cones))).toBeCloseTo(volume(ball),9);
 });

 it('unites the instances page recipe: the realized scattered spikes and the ball, either way round',()=>{
  const out:{united?:Mesh<any,any,any,any>;reversed?:Mesh<any,any,any,any>;ball?:Mesh<any,any,any,any>;spikes?:Mesh<any,any,any,any>}={};
  render(sketch({aspect:[1,1],seed:7,pens:{ink:pen({width:mm(0.25),color:'#18202A'})}},(t)=>{
   const ball=sphere(1.2,{segments:32,rings:16});
   const pts=t.scatter(ball,{spacing:0.35,weight:(f)=>(f.normal[2]>0?1:0)});
   const spikes=instanceOnPoints(spike(),pts,{rotate:(p)=>alignAxis('z',p.sample.normal)}).realize();
   out.ball=ball;out.spikes=spikes;out.united=spikes.unite(ball);out.reversed=ball.unite(spikes);
   return [];
  }),{paper:'Square20'});
  for(const m of [out.united!,out.reversed!]){
   manifold(m,2);
   expect(volume(m)).toBeCloseTo(volume(out.ball!)+volume(out.spikes!),9);
  }
 },120000);
});

describe('G3-9 hatch of tiling faces under later hex strokes keeps its ink', () => {
  const BG = '#f6f2ea';
  const pens = {
    blue: pen({ width: mm(0.4), color: '#2244bb' }),
    green: pen({ width: mm(0.4), color: '#1d7a3c' }),
  };

  /** The audit sketch (working/audit/sketches/reference-geometry-4.ts), with
   * the hex strokes on top or left out. */
  const def = (hexes: boolean) => sketch({ aspect: [1, 1], seed: 7, pens }, (t) => {
    const h = fill('hatch', { angle: 60, spacing: mm(1) });
    const odd = t.tiling(4, 4, { depth: 6, side: 6 }).faces().filter((f) => (f.generation ?? 0) % 2 === 1);
    const left = odd.filter((f) => f.centroid[0] < 50);
    const right = odd.filter((f) => f.centroid[0] >= 50);
    return [
      polygon(left.contours(), { fill: h, fillPen: 'blue', stroke: false }),
      right.map((f) => polygon(f, { fill: h, fillPen: 'blue', stroke: false })),
      ...(hexes ? [strokes(t.hexes({ spacing: 7 }), { pen: 'green' })] : []),
    ];
  });

  /** Minimal 8-bit RGB PNG decoder (the rasteriser writes nothing else). */
  function decodeRgb(bytes: Uint8Array): { w: number; h: number; px: Uint8Array } {
    const b = Buffer.from(bytes);
    let o = 8, w = 0, h = 0;
    const idat: Buffer[] = [];
    while (o < b.length) {
      const len = b.readUInt32BE(o);
      const type = b.toString('ascii', o + 4, o + 8);
      const d = b.subarray(o + 8, o + 8 + len);
      if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); expect(d[9]).toBe(2); }
      if (type === 'IDAT') idat.push(d);
      o += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * 3;
    const px = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)];
      for (let i = 0; i < stride; i++) {
        const at = y * stride + i;
        const a = i >= 3 ? px[at - 3] : 0, up = y > 0 ? px[at - stride] : 0, c = i >= 3 && y > 0 ? px[at - stride - 3] : 0;
        let v = raw[y * (stride + 1) + 1 + i];
        if (f === 1) v += a;
        else if (f === 2) v += up;
        else if (f === 3) v += (a + up) >> 1;
        else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
        px[at] = v & 255;
      }
    }
    return { w, h, px };
  }

  const penGroup = (svg: string, name: string): string[] => {
    const g = svg.match(new RegExp(`data-pen="${name}">(.*?)</g>`, 's'));
    return g ? [...g[1].matchAll(/<(?:path|circle)[^>]*>/g)].map((m) => m[0]).sort() : [];
  };

  it('solves, plans and exports the same hatch with and without the hexes on top', () => {
    const [bare, over] = [render(def(false), { paper: 'Square20' }), render(def(true), { paper: 'Square20' })];
    const blue = (r: typeof bare) => r.frags.filter((f) => r.pens[f.pen].name === 'blue').length;
    expect(blue(over)).toBe(blue(bare));
    const [svgBare, svgOver] = [exportSvg(def(false), { paper: 'Square20', background: BG }), exportSvg(def(true), { paper: 'Square20', background: BG })];
    const hatch = penGroup(svgBare, 'blue');
    expect(hatch.length).toBeGreaterThan(400);
    expect(penGroup(svgOver, 'blue')).toEqual(hatch);
  });

  it('rasterises every hatch pixel: the hexes paint over it where they cross, never leave paper', () => {
    const scale = 4;
    const bare = decodeRgb(exportPng(def(false), { paper: 'Square20', scale, background: BG }));
    const over = decodeRgb(exportPng(def(true), { paper: 'Square20', scale, background: BG }));
    const isBg = (px: Uint8Array, i: number) => px[i] === 0xf6 && px[i + 1] === 0xf2 && px[i + 2] === 0xea;
    let ink = 0, lost = 0;
    for (let i = 0; i < bare.px.length; i += 3) {
      if (isBg(bare.px, i)) continue;
      ink++;
      if (isBg(over.px, i)) lost++;
    }
    expect(ink).toBeGreaterThan(40_000);
    expect(lost).toBe(0);
  });
});
