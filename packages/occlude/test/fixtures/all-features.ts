/**
 * The kitchen-sink sketch: as much of the public surface as one runnable
 * drawing can hold, with its ink pinned by `test/all-features.test.ts`.
 *
 * Two jobs:
 *
 *   1. **An executable inventory.** A public name that is removed or
 *      renamed stops this compiling, or throws when it runs — in
 *      `pnpm test`, loudly. The docs oracle covers the same surface by
 *      example, but it says nothing until someone edits a fence.
 *   2. **An ink oracle for the whole surface.** The pinned fragment count,
 *      plan hash, SVG hash and time estimate move only when someone means
 *      them to, so an engine change that quietly alters ink anywhere shows
 *      up here.
 *
 * Deterministic (one seed, no wall clock) and bounded. It sets a draw
 * range on purpose: the pinned export is a *prefix* of the plan, which
 * exercises `t.draw`.
 *
 * Deliberately NOT here, with the reason:
 *   - `svg('church.svg')` — a 2.5 MB import; docs/images.md covers imports
 *     live, and a fixture should not carry that cost.
 *   - `synth` / `probeExpression` — an exploration tool that *writes*
 *     sketches; docs/getting-started.md exercises it.
 *   - `exportGcode` / `planGcode` / `exportPng` — encoders that need a
 *     machine profile; the test pins the plan bytes and the SVG, which is
 *     what those encoders slice.
 *   - `shaper`, `liveExampleToJs`, `scanUiControls`: authoring/host tools,
 *     not drawing surface.
 */

import {
  sketch, mm, w, h, s, long, degrees, radians,
  circle, ellipse, rect, line, polygon, ngon, path, stroke, strokes, label, labelWidth,
  group, clip, invert, mask, modify, dash, smooth, roughen, deform, decimate, wobble, noiseField,
  fill, customFill, rulings, isBuiltinFill, resolveFill,
  rotate, translate, scale, within, vectorField, grad, curl, distanceTo,
  map, norm, invertRange, ease,
  material, curve, append, connect, planarize,
  segmentRuns, neighbours, extent, banding,
  add, sub, mul, length, distance, unit, limit, perp, dot, cross, fromAngle, angleOf, sum, sumBy,
  force, sumForces, meanBy, components, query,
  boundaryLoops, numericLoops, image, ui,
  type Station, type Tree,
} from 'occlude';

export default sketch({ aspect: [2, 1], margin: 4, seed: 7 }, (t) => {
  // ---- randomness, through the toolkit -----------------------------------
  const r01 = t.rnd(); // 0…1
  const r1 = t.rnd(6); // 0…6
  const r2 = t.rnd(2, 6); // 2…6
  const picked = t.pick([3, 5, 8]);
  const coin = t.chance(0.5) ? 1 : 0;
  const maybe = t.prob(0.4, () => 1, () => 0) ?? 0;
  const n0 = t.noise(12.5, 7.5, 0.25); // -1…1
  const rExtra = t.stream('extras').rnd(1, 9); // an independent stream

  // ---- units and the drawable --------------------------------------------
  const b = t.bounds();
  const uLen = t.len(mm(3)); // a tagged length as drawable units
  const uBare = t.len(2); // a bare number is already drawable units
  const uMm = t.len(t.mm(4));
  const uW = t.len(w(10));
  const uH = t.len(h(10));
  const uWTk = t.len(t.w(5));
  const uHTk = t.len(t.h(5));
  const uS = t.len(s(10));
  const uSTk = t.len(t.s(5));
  const uLong = t.len(long(10));
  const cx = t.cx;
  const cy = t.cy;
  const deg = degrees(Math.PI / 3);
  const rad = radians(60);

  // ---- fields: plain callables, transformed, bounded, marked vector ------
  const land = (x: number, y: number) => t.noise(x / 22, y / 22) * 0.5 + 0.5;
  const ramp = (x: number, y: number) => map(x, 0, b.w, 0, 1);
  const turned = rotate(land, 30);
  const movedField = translate(ramp, mm(2), 0);
  const zoomed = scale(land, 1.3);
  const bounded = within(land, ellipse(40, 30, 28, 20));
  const flow = vectorField((x, y): [number, number] => [Math.cos(y / 14), Math.sin(x / 14)]);
  const slope = grad(land, 0.5);
  const swirl = curl(land, 0.5);
  const blended = (x: number, y: number) => norm(land(x, y) + turned(x, y) * 0.5, 0, 1.5);
  const eased = (x: number, y: number) => ease.sinOut(invertRange(ramp(x, y), 1, 0));
  const movedRead = movedField(20, 20);
  const zoomedRead = zoomed(20, 20);

  // ---- generators: grid, times, scatter, relax, settle, voronoi ----------
  const gridCells = t.grid({ cols: 4, rows: 2, gap: 1 });
  const region = rect(102, 72, 46, 24);
  const seeds = t.scatter(() => 1, { spacing: 9, within: region });
  const rangeRead = t.range(8);
  const insideSeeds = t.within(seeds.points, region);
  const relaxed = t.relax(seeds, { iterations: 2, density: land });
  const settled = t.settle(seeds, { density: land, spacing: 6, iterations: 3 });
  const cells = t.voronoi(seeds, { bounds: { x: 102, y: 72, w: 46, h: 24 } });
  const isolinesMat = t.isolines(bounded, 0.5, { step: 6, close: true });
  const streams = t.streamlines(within(swirl, rect(100, 6, 38, 20)), { spacing: 10, minSpacing: 1, step: 4 });
  const dfield = distanceTo([[[150, 8], [192, 8], [192, 30], [150, 30]]]);
  const boxMat = t.material(rect(102, 44, 42, 20));
  const dbox = t.distanceTo(boxMat);
  const img = image('test-gradient.png', { x: 146, y: 4, width: 48 });
  const imgTone = img.field('lum', { area: 1.2 });

  // ---- shapes: repetition, lines, text, fills, masking -------------------
  const scene: Tree[] = [
    t.times(4, (k, u) => line(6, 8 + u * 8, 194, 8 + u * 8, { decimate: 0.1 })),
    t.noisyLine(6, 20, 194, 20, { amplitude: 1.1, points: 20, offset: 2 }),
    label('KITCHEN SINK', 4, 2, 4),
  ];

  const fills = [
    fill('hatch', { angle: 30, spacing: mm(4) }),
    fill('crosshatch', { angles: [0, 90], spacing: mm(4) }),
    fill('stipple', { density: 0.12, minDist: mm(2.5) }),
    fill('solid', { angle: 45 }),
    customFill((r, ctx) =>
      rulings(r, { spacing: ctx.penWidth * 3, angle: 15, align: 'shape', anchor: ctx.anchor }),
    ),
  ];
  const hatchName = isBuiltinFill('hatch') ? 'hatch' : resolveFill('hatch') ? 'hatch' : 'solid';
  scene.push(t.times(5, (k) => circle(24 + k * 16, 36, k === 3 ? 3.5 : 5, { fill: fills[k] })));
  scene.push(circle(122, 36, 6.5, { fill: (r, ctx) => rulings(r, { spacing: ctx.penWidth * 2.5, angle: 75 }) }));
  scene.push(circle(138, 36, 6.5, { opaque: true }));
  scene.push(mask(circle(154, 36, 6.5)));
  scene.push(group({ translate: [172, 20], rotate: 12, scale: 0.85, origin: 'center' }, rect(-14, -7, 28, 14, { rotate: 20 })));

  // ---- clip, invert, modifiers ------------------------------------------
  scene.push(clip(invert(ellipse(40, 58, 24, 11)), t.times(7, (k, u) => line(16, 48 + u * 20, 64, 48 + u * 20))));
  scene.push(clip(polygon([[40, 48], [64, 58], [40, 68]]), t.times(5, (k, u) => line(20, 50 + u * 16, 60, 50 + u * 16))));

  scene.push(modify([smooth(2), wobble(mm(0.5))], rect(72, 50, 24, 8)));
  scene.push(rect(72, 62, 24, 8, { modifiers: [dash(mm(2.5), mm(1.5)), roughen(mm(0.4), mm(4))] }));
  scene.push(line(72, 74, 78, 74, { modifiers: [deform({ field: flow, detail: mm(3) })] }));
  scene.push(line(72, 84, 78, 84, { modifiers: [deform({ field: noiseField(3, 30), detail: mm(3) })] }));
  scene.push(modify([decimate(0.2)], rect(4, 62, 20, 8)));
  scene.push(ngon(40, 86, 5, 7, 15, { decimate: { stroke: 0.2 } }));
  scene.push(
    path({ winding: 'evenodd' })
      .moveTo(4, 74).lineTo(16, 74).lineTo(16, 84).close()
      .build({ fill: fill('hatch', { angle: 0, spacing: mm(1.2) }) }),
  );
  scene.push(ellipse(28, 92, 11, 5, 30, { opaque: true, origin: [28, 92], rotate: 40 }));
  scene.push(polygon([[4, 46], [14, 46], [9, 54]], { opaque: true }));

  // ---- a material grown from a ring: steps, columns, forces, runs --------
  const ringPts = t.times(12, (k, u): [number, number] => {
    const d = mul(fromAngle(u * Math.PI * 2), 9);
    return [116 + d[0], 36 + d[1]];
  });
  const ring = curve(ringPts)
    .attribute('age', 0)
    .attribute('tag', (p) => p.index % 2, { transfer: 'nearest' })
    .edgeAttribute('tick', (e) => e.length)
    .edgeAttributes({ span: (e) => e.length * 2 });
  const grown = ring.steps(2, (cur, next, k) => {
    // Forces are prepared against the state they act on, once per step.
    const pull = sumForces(
      force.tension(cur, { rest: 2.6 }),
      force.separation(cur, { radius: 4.5, excludeConnected: true }),
    );
    next.move(cur.points, (p) => mul(pull(p, k), 0.4));
    next.set(cur.points.filter((p) => p.index % 3 === 0), () => ({ age: k }));
  }, (cur, next, k) => {
    next.splitEdges(cur.edges.filter((e) => e.length > 4.6), { at: 0.5 });
  });

  const runs = segmentRuns(grown, (a, b) => Math.round((a.age + b.age) / 2));
  const band = banding.over(grown.attrs.age, { count: 2 });
  const ageExtent = extent(grown.attrs.age);
  const parts = components(grown);
  const tagged = grown.attribute('piece', (p) => parts.label(p), { transfer: 'nearest' });
  const meanAge = meanBy(grown.points, (p) => p.age);
  const sumX = sumBy(grown.points, (p) => [p.x, 0])[0];
  const firstPt = grown.points.length > 0 ? grown.points.at(0) : undefined;
  const nearby = firstPt ? neighbours(grown, { radius: 6 })(firstPt).length : 0;
  const edgeQ = query.edges(grown);
  const near = edgeQ.nearest([116, 36], { within: 10 });
  const hit = edgeQ.firstHit([104, 36], [128, 36]);
  const deg0 = grown.degree(0);
  const conn0 = grown.connected(0).length;
  const cp0 = grown.connectedPoints(0).length;

  const selA = grown.points.filter((p) => p.age <= 0);
  const selUnion = selA.union(grown.points.filter((p) => p.index < 6));
  const selInter = selA.intersect(grown.points.filter((p) => p.index < 8));
  const selSub = selA.subtract(grown.points.filter((p) => p.index % 2 === 0));
  const selComp = selA.complement();
  const selHas = firstPt ? selA.has(firstPt) : false;
  const selExtract = selA.extract();
  const keyCount = grown.points.groupBy((p) => Math.round(p.age)).length;

  scene.push(strokes(grown));
  scene.push(runs.map((r) => stroke(r)));
  scene.push(grown.points.filter((p) => grown.degree(p) === 1).map((p) => circle(p.x, p.y, 1)));
  scene.push(selExtract.points.map((p) => circle(p.x, p.y, 0.6)));

  // ---- planar faces, measured, drawn as boundaries -----------------------
  // 9 samples around the circle keeps its vertices off the two chords, so
  // every contact is a clean crossing rather than a tangency.
  const net = append(
    t.sample(circle(122, 62, 16), { count: 9 }),
    append(
      t.sample(line(104, 62, 140, 62), { count: 2 }),
      t.sample(line(122, 52, 122, 72), { count: 2 }),
    ),
  );
  const planar = planarize(net);
  const faceSet = planar.faces();
  const chosen = faceSet.filter((f) => f.area > 80);
  const measured = faceSet.measure(land, { resolution: 40 });
  const faceOne = chosen.length > 0 ? measured.forFace(chosen.at(0)) : null;
  const facePerim = chosen.length > 0 ? chosen.at(0).perimeter : 0;
  const faceEdges = chosen.edges.length;
  scene.push(strokes(planar));
  scene.push(strokes(chosen.boundaryEdges));
  scene.push(strokes(chosen.boundaries()));
  scene.push(chosen.map((f) => (f.contours[0] ? stroke(f.contours[0]) : null)));

  // ---- stations along a spine, and resampling ----------------------------
  const spine = t.material(ellipse(40, 20, 30, 9));
  const evenSpine = spine.resample({ spacing: 6 });
  const stations: Station[] = spine.along({ spacing: 9 });
  const st0 = stations.length > 0 ? stations[0] : null;
  const stHead = st0 ? st0.heading : 0;
  const stTangent = st0 ? angleOf(st0.tangent) : 0;
  const stAttr = st0 ? Object.keys(st0.attrs).length : 0;
  scene.push(stations.map((st) => st.place(circle(0, 0, 0.9), { offset: [0, 1.5] })));
  scene.push(strokes(evenSpine));

  // ---- generators drawn: grid, scatter, relax, settle, voronoi -----------
  const cellFaces = cells.faces();
  const cellOne = cellFaces.length > 0 ? cellFaces.at(0) : null;
  const siteOfFirst = cellOne ? cells.siteOf(cellOne) : null;
  const cellOfSite = seeds.points.length > 0 ? cells.cellOf(seeds.points.at(0)) : null;
  scene.push(gridCells.map((c) => rect(c.x, c.y, c.w, c.h)));
  scene.push(seeds.points.map((p) => circle(p.x, p.y, 0.5)));
  scene.push(relaxed.points.filter((p, i) => i % 3 === 0).map((p) => circle(p.x, p.y, 0.9)));
  scene.push(settled.points.filter((p, i) => i % 3 === 0).map((p) => circle(p.x, p.y, 0.4 + p.demand * 0.8)));
  scene.push(strokes(cells));

  // ---- contours, streamlines, distance fields, an image ------------------
  scene.push(strokes(isolinesMat));
  scene.push(strokes(streams));
  scene.push(strokes(t.isolines(dbox, -4, { step: 4 })));
  scene.push(strokes(t.isolines(within(imgTone, rect(146, 4, 48, 30)), 0.5, { step: 6 })));
  scene.push(
    t.times(4, (k, u) =>
      t.times(4, (j, v) => circle(150 + u * 40, 8 + v * 22, 0.3 + img.lum(150 + u * 40, 8 + v * 22, 3) * 1.6)),
    ),
  );

  // ---- vector vocabulary (results feed the report) -----------------------
  const vAdd = add([1, 2], [3, 4]);
  const vSub = sub([4, 4], [1, 1]);
  const vMul = mul([2, 3], 2);
  const vLen = length([3, 4]);
  const vDist = distance([0, 0], [3, 4]);
  const vUnit = unit([3, 4]);
  const vLimit = limit([9, 9], 3);
  const vPerp = perp([1, 0]);
  const vDot = dot([1, 2], [3, 4]);
  const vCross = cross([1, 0], [0, 1]);
  const vSum = sum([1, 1], [2, 2], [3, 3]);
  const vSumBy = sumBy([[1, 1], [2, 2]], (q) => q as [number, number]);
  const vAngle = angleOf([0, 1]);
  const vFrom = fromAngle(Math.PI / 2);

  // ---- helpers that are easy to forget -----------------------------------
  const loops = boundaryLoops([[[0, 0], [4, 0], [4, 4]]], 'all-features');
  const numLoops = numericLoops([[[0, 0], [4, 0], [4, 4]]], 'all-features');
  const connectRing = connect.ring(material([[0, 0], [4, 0], [2, 4]])).edges.length;
  const connectChain = connect.chain(material([[0, 0], [4, 0], [2, 4]])).edges.length;
  const connectNear = connect.nearest(seeds, { count: 2 }).edges.length;
  const connectPairs = connect.pairs(
    material([[0, 0], [4, 0]]),
    material([[2, 2], [6, 2]]),
  ).edges.length;
  const connectTri = connect.triangulate(material([[0, 0], [4, 0], [2, 4], [6, 3]])).edges.length;

  // ---- declarative extras: sliders, probes, the plan itself --------------
  const weight = ui(0.6, { min: 0, max: 1, step: 0.05 });
  t.probe('all-features', [r01, r1, r2, n0, uLen, deg, rad, weight]);
  t.inspect('grown', grown);
  t.plan({ optimize: 200, bridge: 0.4 });
  t.draw({ progress: [0, 0.55] });

  // ---- the report: readings drawn as text, the rest in one digest -------
  // `report` is two call sites of one line format; the numbers are all
  // one-decimal so a change moves exactly one token in one label.
  const report = (parts: (number | string)[]) =>
    parts.map((v) => (typeof v === 'number' ? v.toFixed(1) : v)).join(' ');
  // The digest consumes every reading the two lines do not print, so the
  // whole inventory is evaluated (and visible) whatever the drawing shows.
  const digest = [
    uLen, uBare, uH, uWTk, uHTk, uS, uSTk, uLong, b.h, cx, cy, rangeRead.length, insideSeeds.length,
    movedRead, zoomedRead, blended(20, 20), eased(20, 20), slope(20, 20)[0], dfield(170, 20),
    ageExtent[0], ageExtent[1], meanAge, sumX, keyCount, vCross, vAngle, vAdd[0], vSub[0], vMul[1], vUnit[1], vPerp[1],
    selA.indices.length, selUnion.length, selInter.length, selSub.length, selComp.length,
    selHas ? 1 : 0, stHead, stTangent, stAttr, st0 ? st0.x : 0, st0 ? st0.y : 0, st0 ? st0.s : 0,
    facePerim, faceEdges, faceOne ? faceOne.mean : 0, faceOne ? faceOne.integral : 0,
    faceOne ? faceOne.centroid[0] : 0, faceOne ? faceOne.samples : 0,
    loops.length, numLoops.length, siteOfFirst ? 1 : 0, cellOfSite ? 1 : 0, cellOne ? cellOne.area : 0,
    band(0.5), tagged.n, hatchName.length, vLimit[0], vSum[0], vSumBy[1], vFrom[1],
    near ? near.distance : 0, hit ? hit.along : 0, connectChain, connectPairs, connectTri,
  ].reduce((a, v) => a + v, 0);
  scene.push(label(
    report(['r', r01, r1, r2, picked, coin, maybe, n0, rExtra, 'u', uMm, uW, deg, rad, 'sum', digest]),
    4, 22, 2,
  ));
  scene.push(label(
    report(['m', meanAge, sumX, parts.count, nearby, deg0, conn0, cp0, 'v', vLen, vDist, vDot, 'c', connectRing, connectNear, 'n', isolinesMat.edges.length, streams.edges.length]),
    4, 25, 2,
  ));

  return scene;
});
