import { sketch, circle, rect, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 42 }, () => {
  const opts = { stroke: false, fill: fill('contour'), fillPen: 'pigma-05-black' };
  return rect(8, 12, 84, 76, 10, opts);
});
