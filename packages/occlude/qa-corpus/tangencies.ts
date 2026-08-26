import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 'url' }, ({ circle, rect, line, hatch, rnd, times }) => {
  const r = 12, cx = 40 + Math.round(rnd(20)), cy = 50;
  return [
    circle(cx, cy, r, { fill: hatch(45, mm(1)) }),
    circle(cx + 2 * r, cy, r, { fill: hatch(135, mm(1)) }),   // externally tangent at one point
    circle(cx, cy, r / 2, { opaque: true }),                   // concentric, exactly half
    line(cx - 30, cy - r, cx + 60, cy - r),                    // tangent to both circles
    line(cx - 30, cy, cx + 60, cy),                            // through both centres
    line(cx, 0, cx, 100),                                      // through tangent point of inner circle
    rect(10, 70, 30, 20, { fill: hatch(0, mm(1)) }),
    rect(40, 70, 30, 20, { fill: hatch(0, mm(1)) }),           // shared vertical edge
    line(10, 70, 70, 70),                                      // collinear with both top edges
    line(40, 60, 40, 100),                                     // along the shared edge
    times(5, (k) => rect(10 + k * 0.005, 20, 8, 8, { opaque: true })), // sub-grid offsets: snap-collapsed?
  ];
});
