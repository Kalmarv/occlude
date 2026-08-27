#!/usr/bin/env tsx
/**
 * Pen calibration sheet generator: one physical pen, one printable page
 * that measures everything occlude needs to know about it.
 *
 *   pnpm --filter occlude calibrate [--name rotring-04] [--width 0.4]
 *        [--paper A4] [--feeds 1000,2000,...] [--pen-down 0] [--pen-up 5]
 *        [--z-offsets -1,-0.5,...] [--delays 40,80,120,200] [--servo]
 *        [--out dir]
 *
 * Sections (top to bottom):
 *   rulers + 60mm square with diagonals   → steps/mm, squareness
 *   corner + centre crosshairs            → flatness/sag measurement targets
 *   F rows: same stroke at each feed      → fastest clean speed → pen.feed
 *   Z rows: pen-down offsets around base  → contact height → pen.penDown
 *   P rows: dot grids at each delay (ms)  → dot quality → pen.penDelay
 *   H swatches: hatch at tighter spacings → where texture closes up
 *   concentric circles + crossing line    → arc quality at speed
 *
 * Each row is a pen VARIANT (same physical pen, one parameter changed), so
 * the exporter emits one G-code job per row; they are concatenated into a
 * single file — no pen swaps, rows run in order.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  circle, exportGcode, exportPng, exportSvg, initOcclude, label, line, mm, path,
  paperSize, rect, render, setPaperHint, setPenLibrary, sketch, stipple,
  type PenDef, type Tree,
} from '../src/index.js';

// ---- args ----

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const csv = (s: string): number[] => s.split(',').map(Number).filter(Number.isFinite);

const name = opt('name', 'cal-pen');
const width = parseFloat(opt('width', '0.3'));
const paper = opt('paper', 'A4');
const feeds = csv(opt('feeds', '1000,2000,3000,4500,6000,9000,12000'));
const penDown = parseFloat(opt('pen-down', '0'));
const penUp = parseFloat(opt('pen-up', '5'));
const zOffsets = csv(opt('z-offsets', '-1,-0.5,-0.25,0.25,0.5,1'));
const delays = csv(opt('delays', '40,80,120,200'));
const servo = args.includes('--servo');
const outDir = opt('out', `cal-${name}`);

// ---- pen variants: one per test row ----

const base: PenDef = {
  name, width, color: '#111111', feed: 3000, penDown, penUp, penDelay: 100,
};
const fPen = (f: number): string => `${name}-F${f}`;
const zPen = (o: number): string => `${name}-Z${o}`;
const pPen = (d: number): string => `${name}-P${d}`;
const pens: PenDef[] = [
  base,
  ...feeds.map((f) => ({ ...base, name: fPen(f), feed: f })),
  ...zOffsets.map((o) => ({ ...base, name: zPen(o), penDown: penDown + o })),
  ...delays.map((d) => ({ ...base, name: pPen(d), penDelay: d })),
];
setPenLibrary(pens);

// ---- the sheet ----

const { w: PW, h: PH } = paperSize({ paper: paper as never });
setPaperHint(PW, PH);

const def = sketch({ aspect: 'paper', margin: 0, seed: 1, pen: name }, () => {
  const out: Tree[] = [];
  const L = mm;

  // Crosshairs: corners + centre (flatness / sag measurement targets).
  const cross = (x: number, y: number): Tree => [
    line(L(x - 4), L(y), L(x + 4), L(y)),
    line(L(x), L(y - 4), L(x), L(y + 4)),
  ];
  // Centre target sits just above the speed ladder — near enough centre
  // for flatness measurement, clear of every test row.
  out.push(
    cross(10, 10), cross(PW - 10, 10), cross(10, PH - 10),
    cross(PW - 10, PH - 10), cross(PW / 2, 92),
  );

  // Arc quality: concentric circles + a crossing line, in the open area
  // under the rulers.
  out.push(
    circle(L(68), L(62), L(24)),
    circle(L(68), L(62), L(12)),
    circle(L(68), L(62), L(5)),
    line(L(30), L(82), L(112), L(40)),
  );

  // Rulers: 100mm with 10mm ticks — measure with a real ruler → steps/mm.
  out.push(line(L(15), L(16), L(115), L(16)));
  for (let k = 0; k <= 10; k++) {
    out.push(line(L(15 + k * 10), L(16), L(15 + k * 10), L(16 + (k % 5 === 0 ? 4 : 2))));
  }
  out.push(label('0', 13, 22, 3, { pen: name, unit: 'mm' }), label('100', 111, 22, 3, { pen: name, unit: 'mm' }));
  out.push(line(L(15), L(20), L(15), L(120)));
  for (let k = 1; k <= 10; k++) {
    out.push(line(L(15), L(20 + k * 10), L(15 + (k % 5 === 0 ? 4 : 2)), L(20 + k * 10)));
  }

  // 60mm square with both diagonals: squareness (diagonals must measure equal).
  out.push(
    rect(L(135), L(20), L(60), L(60)),
    line(L(135), L(20), L(195), L(80)),
    line(L(195), L(20), L(135), L(80)),
    label('X60', 158, 84, 3, { pen: name, unit: 'mm' }),
  );

  // Speed ladder.
  const stroke = (y: number, pen: string): Tree[] => {
    const zig = path();
    zig.moveTo(L(78), L(y));
    for (let k = 1; k <= 10; k++) zig.lineTo(L(78 + k * 3.6), L(y + (k % 2 ? -3 : 3)));
    const s = path();
    s.moveTo(L(150), L(y + 3)).bezierTo(L(162), L(y + 3), L(162), L(y - 3), L(174, ), L(y - 3))
      .bezierTo(L(186), L(y - 3), L(186), L(y + 3), L(196), L(y + 3));
    return [
      line(L(42), L(y), L(75), L(y), { pen }),
      zig.build({ pen }),
      circle(L(122), L(y), L(3.4), { pen }),
      circle(L(132), L(y), L(1.6), { pen }),
      circle(L(140), L(y), L(0.8), { pen }),
      s.build({ pen }),
    ];
  };
  let y = 100;
  for (const f of feeds) {
    out.push(label(`F${f}`, 12, y - 2, 3.6, { pen: name, unit: 'mm' }), ...stroke(y, fPen(f)));
    y += 9;
  }

  // Z / pressure ladder.
  y += 4;
  for (const o of zOffsets) {
    out.push(label(`Z${o >= 0 ? '' : '-'}${Math.abs(o)}`, 12, y - 2, 3.6, { pen: name, unit: 'mm' }));
    out.push(
      line(L(42), L(y), L(110), L(y), { pen: zPen(o) }),
      circle(L(120), L(y), L(2.2), { pen: zPen(o) }),
      line(L(128), L(y), L(196), L(y), { pen: zPen(o) }),
    );
    y += 8;
  }

  // Dot dwell rows: stipple grids (dots = pen taps at this delay).
  y += 4;
  for (const d of delays) {
    out.push(label(`P${d}`, 12, y - 2, 3.6, { pen: name, unit: 'mm' }));
    out.push(rect(L(42), L(y - 2.2), L(154), L(4.4), {
      stroke: false, fill: stipple(1, mm(3.5)), fillPen: pPen(d),
    }));
    y += 8;
  }

  // Hatch spacing swatches: where does texture become solid?
  y += 5;
  const spacings = [2, 1.5, 1.2, 1, 0.8, 0.6];
  spacings.forEach((sp, k) => {
    const x = 12 + k * 33;
    out.push(rect(L(x), L(y), L(24), L(24), {
      fill: { type: 'hatch', passes: [{ angle: 45, spacing: mm(sp), offset: 0 }] } as never,
    }));
    out.push(label(`H${sp}`, x + 4, y + 27, 3, { pen: name, unit: 'mm' }));
  });

  return out;
});

// ---- render + export ----

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));

mkdirSync(outDir, { recursive: true });
const paperOpt = { paper: paper as never };
const out = render(def, paperOpt);
console.log(`${out.frags.length} strokes across ${pens.length} pen variants`);

const jobs = exportGcode(def, { ...paperOpt, profile: { zMode: !servo } });
const combined = [
  `; occlude calibration sheet — ${name} (${width}mm) on ${paper}`,
  `; ${jobs.length} rows, one physical pen; rows run in order, no swaps`,
  '',
  ...jobs.map((j) => j.gcode),
].join('\n');
writeFileSync(join(outDir, 'cal.gcode'), combined);
writeFileSync(join(outDir, 'cal.png'), exportPng(def, { ...paperOpt, scale: 8, background: '#f6f2ea' }));
writeFileSync(join(outDir, 'cal.svg'), exportSvg(def, { ...paperOpt, background: '#f6f2ea' }));

const secs = jobs.reduce((a, j) => a + j.estSeconds, 0);
console.log(`wrote ${outDir}/cal.gcode (${jobs.length} jobs, ~${(secs / 60).toFixed(1)} min), cal.png, cal.svg`);
console.log('read the sheet: fastest clean F row → pen.feed; best Z row → pen.penDown;');
console.log('cleanest P row → pen.penDelay; measure the 100mm rulers and the X60 diagonals.');
