import { sketch, paper, pen, mm, inch } from 'occlude';
import { plane, box, view, orthographic } from 'occlude/3d';

export default sketch({ ...({ seed: 42, paper: paper({ width: inch(8.5), height: inch(11), color: '#F5F0E6' }), pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#A84932' }),
} }), cameras3: {
    "@1": {"eye":[6.478014765201803,8.637353020269071,5.39834563766817],"target":[0,0,0],"kind":"perspective","near":0.9907279243665265,"far":100.89072792436653,"up":[0,0,1],"fovDegrees":45}
  } }, t => {
  console.info('mesh-model'); const terrain = plane(5, 5).subdivide(3)
    .attribute('mobility', p => Math.max(0, 1 - Math.hypot(p.x, p.y) / 3))
    .displace(p => [0, 0, t.noise(p.x * 0.7, p.y * 0.7) * 0.7])
    .steps(4, (current, next, k) => {
      next.move(current.points, p => [0, 0, Math.sin(p.x + k * 0.1) * p.mobility * 0.03]);
    });
  return view([terrain, box([0.9, 0.9, 1.8]).translate([0, 0, 1])], {
    camera: orthographic({ eye: [6, 8, 5], target: [0, 0, 0], span: 10 }),
    stroke: 'ink',
    hatch: { spacing: mm(2), angle: 35, stroke: 'shade' },
  });
});
