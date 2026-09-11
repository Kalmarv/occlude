import { sketch, circle, rect, mask, fill } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 42 }, () => {
  const opts = { stroke: false, fill: fill('contour'), fillPen: 'pigma-05-black' };
  return [rect(8, 8, 84, 84, 8, opts), ...Array.from({ length: 16 }, (_, i) => mask(circle(20 + (i % 4) * 20, 20 + Math.floor(i / 4) * 20, 5)))];
});
