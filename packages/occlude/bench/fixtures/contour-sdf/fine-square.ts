// A 21.9456 mm square on the pinned 12-inch paper. Fine-width scaling probe.
import { sketch, polygon, fill } from 'occlude';
export default sketch({ aspect: [1, 1], margin: 5, seed: 42 }, t => {
  const thick = t.material(t.rect(46, 46, 8, 8));
  return [t.group({ pen: 'micron-01' }, polygon(thick, { stroke: false, fill: fill('contour') }))];
});
