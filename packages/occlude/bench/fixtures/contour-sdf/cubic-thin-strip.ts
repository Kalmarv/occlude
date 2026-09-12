// Actual 100 × 0.005 mm cubic ribbon: normalizing at nib-scale tolerance
// can put a cleanup chord outside the source. One input-grid step thick;
// the smaller native fixture exercises post-snap geometry.
import { sketch, path, fill, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 0, seed: 42 }, () =>
  path()
    .moveTo(mm(10), mm(40))
    .bezierTo(mm(40), mm(44), mm(80), mm(44), mm(110), mm(40))
    .lineTo(mm(110), mm(39.995))
    .bezierTo(mm(80), mm(43.995), mm(40), mm(43.995), mm(10), mm(39.995))
    .close()
    .build({ stroke: false, fill: fill('contour'), pen: 'micron-01' }),
);
