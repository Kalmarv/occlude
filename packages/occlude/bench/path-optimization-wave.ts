import { sketch, stroke } from '../src/index.js';
/** Dense connected segments: fitting should reduce primitives; compare actual ETA. */
export default sketch({ aspect: 'square', margin: 8, seed: 42 }, (t) =>
  t.times(12, (k) => stroke(t.times(300, (_, u) => [12 + 76*u, 10 + 7*k + 2*Math.sin(18*u)]))),
);
