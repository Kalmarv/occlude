import { sketch, circle, rect, mask, fill } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 42 }, () => {
  const opts = { stroke: false, fill: fill('contour'), fillPen: 'pigma-05-black' };
  return Array.from({ length: 100 }, (_, i) => circle(5 + (i % 10) * 10, 5 + Math.floor(i / 10) * 10, 3, opts));
});
