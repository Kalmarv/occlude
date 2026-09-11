import { sketch, circle, rect, mask, fill } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 42 }, () => {
  const opts = { stroke: false, fill: fill('contour'), fillPen: 'pigma-05-black' };
  return circle(50, 50, 4, opts);
});
