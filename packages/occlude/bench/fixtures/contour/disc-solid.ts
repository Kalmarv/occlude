import { sketch, circle, rect, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 42 }, () => {
  const opts = { stroke: false, fill: fill('solid'), fillPen: 'pigma-05-black' };
  return circle(50, 50, 40, opts);
});
