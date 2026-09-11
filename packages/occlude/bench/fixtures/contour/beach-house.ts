// fork of contours-2-multicolor @ 99f6748
// fork of contours-2 @ da3b470
import {
  sketch,
  image,
  circle,
  polygon,
  fill,
  distanceTo,
  deform,
  group,
  label,
} from 'occlude';

export default sketch({ aspect: [1, 1], margin: 5 }, (t) => {
  const { bounds, noise, ui, isolines } = t;
  const b = bounds();

  const noiseScale = t.rnd(10, 30);
  const detailScale = noiseScale * t.rnd(0.01, 1);
  const bigNoise = t.rnd(0, 1);
  const smallNoise = 1.0 - bigNoise;

  const field = (x, y) =>
    noise(x / noiseScale, y / noiseScale) * bigNoise +
    noise(x / detailScale + 1012, y / detailScale + 1000) * smallNoise;

  const inside = distanceTo(t.material(t.rect(5, 5, 90, 90)));
  const envelope = (x,y) => t.ease.expoIn(Math.max(0, Math.min(1, inside(x,y) / 10)));
  const falloffField = (x,y) => envelope(x,y) * field(x,y);
  const minLine = t.rnd(-4.4, 0);
  const maxLine = t.rnd(0, 2.0);
  const minLevels = ui(7);
  const maxLevels = ui(30);
  const period = Math.round(t.rnd(minLevels, maxLevels));

  const levels = t.times(period, (i, k) => t.map(k, 0, 1, minLine, maxLine));
  const contours = isolines(falloffField, levels, { close: true, step: 0.5 });
  const center = circle(50, 50, 16, { opaque: true });
  const d = distanceTo(t.material(center));
  const repeat = contours.edges
    .groupBy((e) => e.attrs.level)
    .map((cs) =>
      deform(
        (x, y) =>
          warp(
            x,
            y,
            t.map(cs.key, minLine, maxLine, 0, 1) * ui(0.535, { label: 'Warp amount' }),
          ),
        polygon(cs, {
          fill: levels.indexOf(cs.key) % 2 === 0 ? fill('stipple') : fill('contour'),
        }),
      ),
    );


  const density = (x, y) => {
    const s = d(x, y);
    const s2 = s <= 0 ? 0 : Math.max(0, 1 - s / 20);
    return t.ease.expoIn(s2);
  };
  const dots = t
    .scatter(density, { spacing: 0.4 })
    .points.map((p) => circle(p.x, p.y, 0.1));

  const push1 = t.rnd(-54, 50);
  const push2 = t.rnd(325, 3709);

  const warp = (x: number, y: number, level: number): [number, number] => {
    const dx = x - b.cx;
    const dy = y - b.cy;
    const dist = Math.hypot(dx, dy) || 1e-9;
    const push = push1 * Math.exp(-dist / push2);
    return [(dx / dist) * push * level, (dy / dist) * push * level];
  };

  const imageSize = ui(27, { min: 5, max: 40 });
  const key = image('beach-house-key.jpg', {
    x: b.cx - imageSize / 2,
    y: b.cy - imageSize / 2,
    width: imageSize,
  });
  const keylum = (x, y) => key.lum(x, y, 0.2);
  const keyy = t
    .scatter(keylum, { spacing: 0.12 })
    .points.map((p) => circle(p.x, p.y, 0.1, { pen: 'copic-red' }));

  const labels = [
    label('Beach House', 0, b.h, 1.6, { pen: 'copic-red' }),
    label('27 Mar 2022', b.w, b.h, 1.6, { align: 'right', pen: 'copic-red' }),
  ];

  return [
    group({ pen: 'one4all' }, repeat, center, dots, keyy),
    labels,
  ];
});
