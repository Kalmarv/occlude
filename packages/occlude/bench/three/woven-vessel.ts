import { sketch, paper, pen, mm, strokes, dash, wobble, label } from 'occlude';
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
