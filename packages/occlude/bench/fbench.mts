// Planarization and face discovery: the two topology operations a sketch pays
// for when it asks a drawing for its regions. Seeds fixed; medians of 5.
import { performance } from 'node:perf_hooks';
import { material, append, connect } from '../src/index.js';

let s = 5;
const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647) * 100;
const med = (label: string, f: () => unknown, runs = 5) => {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); f(); ms.push(performance.now() - t0); }
  ms.sort((a, b) => a - b);
  console.log(label.padEnd(52), ms[ms.length >> 1].toFixed(0).padStart(6), 'ms', `  (${ms.map((v) => v.toFixed(0)).join(', ')})`);
};

let net = material([]);
for (let i = 0; i < 400; i++) net = append(net, material([[rnd(), rnd()], [rnd(), rnd()]], { edges: [[0, 1]] }));
med('planarize 400 chords', () => net.planarize(), 3);
const pn = net.planarize();
console.log(`  -> ${pn.n} vertices ${pn.edgeCount} edges`);
med(`faces of ${pn.edgeCount} planar edges`, () => pn.faces());
const fc = pn.faces();
console.log(`  -> ${fc.faces.length} faces`);
med('faces.select area>1 + boundaries', () => fc.select((f) => f.area > 1).boundaries());

// Demanding: planarization at the scale where the event bookkeeping, not the
// sweep, decides the cost — a million vertices out of three thousand chords.
// Its own generator, so the fixtures below keep the values they always had.
{
  let bs = 31;
  const brnd = () => ((bs = (bs * 48271) % 2147483647) / 2147483647) * 100;
  for (const [chords, runs] of [[1500, 3], [3000, 1]] as const) {
    const pts: [number, number][] = [];
    const eds: [number, number][] = [];
    for (let i = 0; i < chords; i++) { pts.push([brnd(), brnd()], [brnd(), brnd()]); eds.push([2 * i, 2 * i + 1]); }
    const big = material(pts, { edges: eds });
    let out: ReturnType<typeof big.planarize> | undefined;
    med(`planarize ${chords} chords${runs === 1 ? ' (single run)' : ''}`, () => { out = big.planarize(); }, runs);
    console.log(`  -> ${out!.n} vertices ${out!.edgeCount} edges`);
  }
}

const tri = connect.triangulate(Array.from({ length: 5000 }, () => [rnd(), rnd()] as [number, number]));
med(`faces of a ${tri.n}-point triangulation (${tri.edgeCount} edges)`, () => tri.faces());

// a lattice: every vertex has degree four and every face is a quad — the
// angular sort and the walk with none of the randomness
{
  const K = 90;
  const pts: [number, number][] = [];
  for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) pts.push([i, j]);
  const id = (i: number, j: number) => i * (K + 1) + j;
  const eds: [number, number][] = [];
  for (let i = 0; i <= K; i++) for (let j = 0; j < K; j++) { eds.push([id(i, j), id(i, j + 1)]); eds.push([id(j, i), id(j + 1, i)]); }
  const lat = material(pts, { edges: eds });
  med(`faces of a ${K}×${K} lattice (${lat.n} V, ${lat.edgeCount} E)`, () => lat.faces());
}

// many disjoint segments: the planarity check's position map at scale, with
// almost no box overlaps to judge
{
  const pts: [number, number][] = [];
  const eds: [number, number][] = [];
  for (let i = 0; i < 40000; i++) {
    const x = (i % 200) * 10 + (i % 7);
    const y = Math.floor(i / 200) * 10 + (i % 5);
    pts.push([x, y], [x + 1, y + 1]);
    eds.push([2 * i, 2 * i + 1]);
  }
  const wide = material(pts, { edges: eds });
  med(`faces of ${wide.n} disjoint-segment vertices`, () => wide.faces(), 3);
}
