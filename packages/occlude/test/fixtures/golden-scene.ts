import { sketch, circle, line, path, fill, mm } from 'occlude';

// The Rust golden scene, as a sketch: a horizontal line under everything,
// an S-curve over it, and three filled circles — two hatch passes and one
// stipple — on A6 with no margin, so coordinates are paper millimetres.
// Rendered by the PRODUCT fills; the sentinel test keeps the committed
// fixture (crates/occlude-core/tests/fixtures/golden) equal to what these
// fills produce today.
export default sketch({ aspect: 'paper', margin: 0, seed: 1234 }, () => [
  line(mm(0), mm(74), mm(105), mm(74), { z: -1 }),
  path().moveTo(mm(10), mm(120)).bezierTo(mm(35), mm(60), mm(70), mm(130), mm(95), mm(50)).build(),
  circle(mm(40), mm(74), mm(22), { fill: fill('hatch', { angle: 45, spacing: mm(2) }) }),
  circle(mm(62), mm(74), mm(18), { fill: fill('hatch', { angle: -30, spacing: mm(2) }) }),
  circle(mm(52), mm(40), mm(12), { fill: fill('stipple', { density: 0.6, minDist: mm(1.2) }) }),
]);
