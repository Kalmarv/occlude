import { sketchAsync, clip, rect, mask, label, paper, pen, mm } from 'occlude';
import { mesh, plane, query, view, orthographic } from 'occlude/3d';
import { grid3, FaceSelection3, extrudeFaces3 } from 'occlude/3d/advanced';

export default sketchAsync({ seed: 42, paper: paper({ width: mm(200), height: mm(200) }), margin: 5, pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
  fine: pen({ width: mm(0.18), color: '#56626A' }),
  accent: pen({ width: mm(0.25), color: '#A84932' }),
} }, async t => {
  // Independent-face extrusion remains an explicit advanced modeling operation.
  let surface = grid3(6, 6, [4, 4]);
  surface.faces.forEach(face => {
    face.attributes.height = t.rnd(0.6, 1.8);
    face.attributes.occupied = t.rnd() > 0.25;
    face.attributes.spacing = t.rnd(1.5, 2.5);
  });
  const selected = new FaceSelection3(surface).filter(f => f.index % 6 % 2 === 0 && Math.floor(f.index / 6) % 2 === 0 && f.attributes.occupied === true);
  surface = extrudeFaces3(surface, selected, f => Number(f.attributes.height), { operation: 'hatched-towers' });
  surface.points.forEach(p => { p.attributes.drift = p.position[2] > 0 ? t.rnd(0.002, 0.006) : 0; });
  // These displacement samples are captured once and reapplied eight times on the GPU.
  surface = await t.deform3(surface, { iterations: 8, relaxation: 0,
    displacements: surface.points.map(p => p.position[2] > 0 ? [Number(p.attributes.drift) * Math.sin(p.position[1]), Number(p.attributes.drift) * Math.cos(p.position[0]), 0] : [0, 0, 0]),
  });
  const input = mesh(surface);
  const hits = await query(plane(8).translate([0, 0, 1.1])).batch(t).nearest(input.points);
  const byId = new Map(hits.map(result => [result.source.id, result.hit]));
  surface.points.forEach(p => {
    const hit = byId.get(p.id);
    if (hit && p.position[2] > hit.position[2]) {
      p.attributes.beforeCeiling = p.position[2];
      p.attributes.ceilingAdjusted = true;
      p.position = hit.position;
    }
  });
  const relief = mesh(surface, { key: 'relief' })
    .faceAttribute('spacing', f => Number(f.attributes.spacing));
  return [
    clip(rect(4, 4, 92, 84), view(relief, {
      key: 'procedural-relief',
      camera: orthographic({ span: 5.5, eye: [5, 7, 6], target: [0, 0, 0.4], near: 0.1, far: 30 }),
      // Keep shallow creases in the deformed relief visible.
      creaseAngle: 0,
      stroke: 'outline',
      hatch: [
        { key: 'shade', spacing: f => mm(f.spacing), angle: f => f.normal[2] > 0.5 ? 35 : -35,
          stroke: 'fine', select: f => f.role === 'side' || f.role === 'cap' },
        { key: 'cross', spacing: f => mm(f.spacing * 2), angle: -35,
          stroke: 'fine', select: f => (f.role === 'side' || f.role === 'cap') && f.normal[2] > 0.5 },
      ],
      sections: [0.2, 0.4, 0.6, 0.8].map((height, i) => ({
        key: `level-${i}`, origin: [0, 0, height], normal: [0, 0, 1], stroke: 'accent',
      })),
    })),
    mask(rect(60, 75, 32, 13)),
    label('HATCH / SECTIONS', 61, 78, 2.5, { stroke: 'outline' }),
    label('PAPER SPACING', 61, 83, 2, { stroke: 'outline' }),
    label('SEEDED RELIEF', 8, 94, 4, { stroke: 'outline' }),
  ];
});
