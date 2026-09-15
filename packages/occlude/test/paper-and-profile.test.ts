import { describe, expect, it } from 'vitest';
import { PAPERS, paperSize, DEFAULT_PAPERS } from '../src/index.js';
import { profileToJson } from '../src/render.js';

describe('paper presets', () => {
  it('include the large ISO sheets the A1 plotter needs, portrait, with landscape swapping', () => {
    expect(PAPERS.A0).toEqual({ name: 'A0', w: 841, h: 1189 });
    expect(PAPERS.A1).toEqual({ name: 'A1', w: 594, h: 841 });
    expect(PAPERS.A2).toEqual({ name: 'A2', w: 420, h: 594 });
    expect(paperSize({ paper: 'A1', landscape: true })).toEqual({ w: 841, h: 594 });
    expect(DEFAULT_PAPERS.map((p) => p.name)).toContain('A1');
  });
});

describe('machine profile JSON', () => {
  it('carries flipY, defaulting off, so the core mirrors only when asked', () => {
    expect(JSON.parse(profileToJson({}, { w: 100, h: 200 }))).toMatchObject({ bed: [100, 200], flipY: false, zMode: true, arcSupport: false });
    expect(JSON.parse(profileToJson({ flipY: true, resolution: 0.2, travelFeed: 10000 }, { w: 594, h: 841 }))).toMatchObject({ flipY: true, resolution: 0.2, travelFeed: 10000 });
  });
});
