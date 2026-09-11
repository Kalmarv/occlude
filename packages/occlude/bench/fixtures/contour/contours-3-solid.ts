// fork of contours @ e622931
import { sketch, image } from 'occlude';

export default sketch({ aspect: [1, 3], margin: 5, seed: 42 }, (t) => {
  const { circle, bounds, noise, ui, polygon, isolines, distanceTo, deform } = t;
  const b = bounds();

  const noiseScale = ui(29, { min: 1, max: 30 });

  const isoField = (x, y) => noise(x / noiseScale, y / noiseScale);
  const isoOpts = { close: true, step: 0.2 };

  const minLine = ui(-1, { min: -2, max: 0, step: 0.01 });
  const maxLine = ui(1, { min: 0, max: 2, step: 0.01 });

  // One field sampling for ALL levels: isolines() samples once and marches
  // each cutoff. Calling it per level re-sampled the same field every time.
  const levels = t.times(9, (i, k) => t.map(k, 0, 1, minLine, maxLine));
  const __iso = isolines(isoField, levels, isoOpts);
  const repeat = levels.map((cs, i) => polygon(__iso.edges.filter((e) => e.attrs.level === cs), {
        fill: i % 2 === 0 ? t.fill('stipple') : t.fill('solid'),
      }));

  const center = circle(50, 50, 27, { opaque: true });
  const d = distanceTo(t.material(center).curves().map((c) => c.pts));

  const density = (x, y) => {
    const s = d(x, y);
    const s2 = s <= 0 ? 0 : Math.max(0, 1 - s / 20);
    return t.ease.expoIn(s2);
  };
  const dots = t.scatter(density, { spacing: 0.4 }).points.map((p) => circle(p.x, p.y, 0.1));

  const warp = (x: number, y: number): [number, number] => {
    const dx = x - b.cx;
    const dy = y - b.cy;
    const d = Math.hypot(dx, dy) || 1e-9;
    const push =
      ui(-40, { min: -50, max: 50 }) * Math.exp(-d / ui(24, { min: -50, max: 50 }));
    return [(dx / d) * push, (dy / d) * push];
  };

  return [t.group({ pen: 'sakura-jelly' }, deform(warp, repeat))];
});

// 1627492744
// 73386405
