import {
  append,
  sketch,
  compileSketch,
  setPaperHint,
  type Material,
} from '../../src/index.js';
import {
  analyticalUnion,
  type Envelope,
} from './core/thicken-arrangement.js';
let source: Material | undefined;
const paper = Number(process.argv[2] ?? 100),
  depth = Number(process.argv[3] ?? 1),
  low = Number(process.argv[4] ?? 1),
  high = Number(process.argv[5] ?? 5);
setPaperHint(paper, paper);
compileSketch(
  sketch({ aspect: [1, 1], margin: 6, seed: 42 }, (t) => {
    const b = t.bounds();
    let width = 40,
      m = t.material(t.rect(b.cx - 20, b.cy - 20, 40, 40));
    for (let i = 0; i <= depth; i++) {
      const shapes = m
        .along()
        .map((p) =>
          t.rect(p.x - width / 4, p.y - width / 4, width / 2, width / 2),
        );
      m = shapes.reduce((m, s) => append(m, t.material(s)), m);
      width /= 2;
    }
    source = m;
    return [];
  }),
);
const src = source!,
  inputs: Envelope[] = [];
for (let i = 0; i < src.edgeCount; i++) {
  const a = src.edgeList[2 * i],
    b = src.edgeList[2 * i + 1],
    ax = src.x[a],
    ay = src.y[a],
    bx = src.x[b],
    by = src.y[b],
    ra = low + (ax / 100) * (high - low),
    rb = low + (bx / 100) * (high - low);
  inputs.push({
    ax,
    ay,
    bx,
    by,
    ra,
    rb,
    va: a,
    vb: b,
    edge: i,
    minX: Math.min(ax - ra, bx - rb),
    minY: Math.min(ay - ra, by - rb),
    maxX: Math.max(ax + ra, bx + rb),
    maxY: Math.max(ay + ra, by + rb),
  });
}
const start = performance.now();
console.log({ paper, depth, low, high, vertices: src.n, edges: src.edgeCount });
const loops = analyticalUnion(inputs, 0.01, false, (stage, counts) =>
  console.log(stage, performance.now() - start, counts),
);
console.log(
  'result',
  performance.now() - start,
  loops.length,
  loops.reduce((s, l) => s + l.length, 0),
);
for (const [i, l] of loops.entries()) {
  const distinct = l.filter((p, j) => {
    const q = l[(j + 1) % l.length];
    return p.x !== q.x || p.y !== q.y;
  });
  const origin = l[0],
    area =
      l.reduce((s, p, j) => {
        const q = l[(j + 1) % l.length];
        return (
          s +
          (p.x - origin.x) * (q.y - origin.y) -
          (q.x - origin.x) * (p.y - origin.y)
        );
      }, 0) / 2;
  if (distinct.length < 3 || area === 0)
    console.log(
      'collapsed',
      i,
      l.length,
      distinct.length,
      area,
      JSON.stringify(l),
    );
}
