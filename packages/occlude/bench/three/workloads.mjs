/** Six final surface-drawing workloads, shared by the headless CPU runner and the served GPU runner. */
export const workloads=[
{name:'mapped-plane',src:`import { sketchAsync, curve, pen, mm } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';
export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2) }) } }, async t => {
  const sheet = plane(4).subdivide(5).displace(p => [0, 0, 0.3 * Math.sin(p.x * 2) * Math.cos(p.y * 2)]);
  const marks = await t.mapSurface(sheet, t.times(96, (_, u) => curve([[0, u], [1, u]], { closed: false })));
  return view([sheet, marks], { camera: orthographic({ eye: [5, 7, 5], span: 6 }), pen: 'ink' });
});`},
{name:'primitive-crosshatch',src:`import { sketchAsync, pen, mm } from 'occlude';
import { torus, light, across, view, orthographic } from 'occlude/3d';
export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2) }) } }, async t => {
  const model = torus(1.4, 0.5, { segments: 48, tubeSegments: 20 }), sun = light({ direction: [-1, -2, 3], ambient: 0.1 });
  const along = await t.hatch(model, { spacing: 0.06, direction: s => s.tangentU, tone: s => 0.3 + 0.7 * sun(s) });
  const crossing = await t.hatch(model, { spacing: 0.06, direction: across(s => s.tangentU), tone: s => Math.max(0, 2 * sun(s) - 1) });
  return view([model, along, crossing], { camera: orthographic({ eye: [5, 7, 5], span: 5 }), pen: 'ink' });
});`},
{name:'custom-curvature',src:`import { sketchAsync, pen, mm } from 'occlude';
import { plane, curvature, light, view, perspective } from 'occlude/3d';
export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2) }) } }, async t => {
  const relief = plane(5, 4).subdivide(5).displace(p => [0, 0, 0.6 * Math.sin(p.x * 1.4) * Math.cos(p.y * 1.1) + 0.15 * t.noise(p.x, p.y)]);
  const marks = await t.hatch(relief, { spacing: 0.06, direction: curvature('max'), fallback: s => s.tangentU, tone: light({ direction: [-2, 1, 3], ambient: 0.05 }) });
  return view([relief, marks], { camera: perspective({ eye: [6, -8, 6], target: [0, 0, 0], fovDegrees: 38 }), pen: 'ink' });
});`},
{name:'intersection-assembly',src:`import { sketchAsync, pen, mm } from 'occlude';
import { box, cylinder, sphere, light, view, perspective } from 'occlude/3d';
export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2) }) } }, async t => {
  const block = box([2.5, 1.5, 1.5]), tube = cylinder(0.65, 2.8, { segments: 32 }).rotate([0, 35, 0]), ball = sphere(0.9, { segments: 32, rings: 16 }).translate([0.8, 0.3, 0.6]);
  const seams = [await t.intersections(block, tube), await t.intersections(block, ball), await t.intersections(tube, ball)];
  const marks = await t.hatch(tube, { direction: s => s.tangentV, spacing: 0.08, tone: light({ direction: [-1, -1, 2] }) });
  return view([block, tube, ball, ...seams, marks], { camera: perspective({ eye: [5, 7, 5], target: [0, 0, 0], fovDegrees: 40 }), pen: 'ink' });
});`},
{name:'repeated-prototypes',src:`import { sketchAsync, curve, pen, mm } from 'occlude';
import { box, grid, instanceOnPoints, view, perspective } from 'occlude/3d';
export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2) }) } }, async t => {
  const tile = box([0.6, 0.6, 0.25]);
  const pattern = await t.mapSurface(tile, t.times(12, (_, u) => curve([[0.1 + 0.8 * u, 0.1], [0.1 + 0.8 * u, 0.9]], { closed: false })), { chart: 'f1' });
  const tiles = instanceOnPoints(tile, grid({ cols: 8, rows: 8, spacing: 0.8 }).points, { rotate: p => [0, 0, (p.i + p.j) * 11] });
  return view([tiles, pattern.place(tiles)], { camera: perspective({ eye: [6, -8, 7], target: [0, 0, 0], fovDegrees: 40 }), pen: 'ink' });
});`},
{name:'hatch-density',src:`import { sketchAsync, pen, mm } from 'occlude';
import { sphere, light, view, orthographic } from 'occlude/3d';
export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2) }) } }, async t => {
  const ball = sphere(1.6, { segments: 48, rings: 32 }), sun = light({ direction: [-1, -2, 2], ambient: 0.1 });
  const marks = await t.hatch(ball, { direction: s => s.tangentU, spacing: 0.035, tone: s => 0.2 + 0.8 * sun(s) });
  return view([ball, marks], { camera: orthographic({ eye: [4, -6, 3], span: 4 }), pen: 'ink' });
});`},
{name:'woven-vessel',src:String.raw`import { sketch, paper, pen, mm, strokes, dash, wobble, label } from 'occlude';
import { cylinder, torus, sphere, curve, parametricCurve, revolve, circle, sweep, view, orthographic } from 'occlude/3d';

export default sketch(
  {
    seed: 11,
    paper: paper({ width: mm(200), height: mm(200), color: '#F4EFE4' }),
    margin: 12,
    pens: {
      ink: pen({ width: mm(0.3), color: '#1B2430' }),
      hidden: pen({ width: mm(0.14), color: '#B2705C' }),
      shade: pen({ width: mm(0.13), color: '#8B8B77' }),
      measure: pen({ width: mm(0.17), color: '#3F6E72' }),
    },
  },
  (t) => {
    const R = 1.55, H = 2.6, ROD = 0.185, TURNS = 3, SEG = 140;
    const rod = circle(ROD, { segments: 16 });
    const weave = [];
    for (const dir of [1, -1]) for (let k = 0; k < 3; k++) {
      const phase = (k * 2 * Math.PI) / 3 + (dir > 0 ? -0.5 : 0.5);
      weave.push(sweep(rod, parametricCurve((u) => {
        const a = phase + dir * u * TURNS * 2 * Math.PI;
        const r = R + 0.035 * t.noise(dir * 3 + k, u * 3.2);
        return [r * Math.cos(a), r * Math.sin(a), -0.18 + (H + 0.18) * u];
      }, { segments: SEG }), { caps: true }));
    }
    const plinth = cylinder(2.4, 0.12, { segments: 56 }).faceAttribute('ground', (f) => f.normal[2] > 0.9).translate([0, 0, -0.31]);
    const foot = cylinder(R + 0.3, 0.36, { segments: 48 }).faceAttribute('ground', (f) => f.normal[2] > 0.9).translate([0, 0, -0.06]);
    const band = torus(R, 0.17, { segments: 40, tubeSegments: 14 }).translate([0, 0, 0.52]);
    const rim = torus(R, 0.2, { segments: 48, tubeSegments: 14 }).translate([0, 0, H]);
    const handle = sweep(rod, parametricCurve((u) => { const a = Math.PI * u; return [-(R + 0.02) * Math.cos(a), 0, H + 1.1 * Math.sin(a)]; }, { segments: 72 }), { caps: true });
    const pear = revolve(curve([[0, 0, -0.5], [0.34, 0, -0.46], [0.4, 0, -0.08], [0.3, 0, 0.28], [0.2, 0, 0.52], [0.18, 0, 0.62], [0.1, 0, 0.68], [0, 0, 0.72]]), { segments: 28 }).translate([0.7, -0.5, 2.5]);
    const pip = sphere(0.45, { segments: 16, rings: 8 }).translate([-0.62, 0.55, 2.62]);
    return view([plinth, foot, ...weave, band, rim, handle, pear, pip], {
      key: 'woven-vessel',
      camera: orthographic({ eye: [4.6, 5.8, 5.2], target: [0, 0, 1.0], span: 6.6 }),
      hatch: { spacing: mm(1.8), angle: 35, pen: 'shade', select: (f) => f.ground === true },
      sections: [{ origin: [0, 0, 1.6], normal: [0, 0, 1], pen: 'measure', key: 'waist' }],
    }, (lines) => {
      const tremor = wobble({ amount: mm(0.09), wavelength: mm(9) });
      const edge = (c) => !c.kinds.has('hatch') && !c.kinds.has('section');
      return [
        strokes(lines.visible.filter((c) => c.kinds.has('hatch')), { stroke: 'shade' }),
        strokes(lines.hidden.filter(edge), { stroke: 'hidden', modifiers: [dash(mm(2.4), mm(1.6))] }),
        strokes(lines.visible.filter(edge), { stroke: 'ink', modifiers: [tremor] }),
        strokes(lines.visible.filter((c) => c.kinds.has('section')), { stroke: 'measure' }),
        label('WOVEN VESSEL', 14, 14, 4.2, { stroke: 'ink' }),
      ];
    });
  },
);
`},
];
