import { describe, expect, test } from 'vitest';

import { cellTestPulses, heatColour, liftCells, nudgeCell, RUNG, setCellThreshold } from './liftGrid.js';

const map = {
  cols: 3,
  rows: 2,
  bedW: 300,
  bedH: 200,
  margin: 8,
  thresholds: [15200, null, 13600, 14400, 15200, null],
  unresolvedAbove: 16000,
};

describe('lift grid model', () => {
  test('cells carry threshold, travel lift and heat', () => {
    const cells = liftCells(map, 800, 8600);
    expect(cells).toHaveLength(6);
    expect(cells[0]).toMatchObject({ r: 0, c: 0, threshold: 15200, value: 15200, travel: 14400 });
    expect(cells[1]).toMatchObject({ r: 0, c: 1, threshold: null, value: 16000, travel: 15200 });
    expect(cells[3]).toMatchObject({ r: 1, c: 0, threshold: 14400, travel: 13600 });
    // heat: the cell needing the most lift (lowest pulse) is 1, unresolved is 0
    expect(cells[2].heat).toBe(1);
    expect(cells[1].heat).toBe(0);
    expect(cells[0].heat).toBeCloseTo((16000 - 15200) / (16000 - 13600));
  });

  test('travel never asks for more lift than the mechanism has', () => {
    const cells = liftCells({ ...map, thresholds: [9000, 9000, 9000, 9000, 9000, 9000] }, 800, 8600);
    for (const c of cells) expect(c.travel).toBe(8600);
    expect(cellTestPulses(cells[0])).toEqual([8600, 9000]);
  });

  test('a flat map has no heat', () => {
    const cells = liftCells({ ...map, thresholds: [15200, 15200, 15200, 15200, 15200, 15200] }, 800, 8600);
    for (const c of cells) expect(c.heat).toBe(0);
  });

  test('edits are copies, checked, and rounded', () => {
    const next = setCellThreshold(map, 1, 2, 14400.4);
    expect(next.thresholds[5]).toBe(14400);
    expect(map.thresholds[5]).toBeNull();
    expect(setCellThreshold(map, 0, 0, null).thresholds[0]).toBeNull();
    expect(() => setCellThreshold(map, 2, 0, 1)).toThrow(/no cell 2,0/);
    expect(() => setCellThreshold(map, 0, 0, NaN)).toThrow(/must be a number/);
  });

  test('a nudge steps by pulses; unresolved starts from the ladder top', () => {
    expect(nudgeCell(map, 0, 0, -RUNG).thresholds[0]).toBe(14400);
    expect(nudgeCell(map, 0, 1, -RUNG).thresholds[1]).toBe(15200);
  });

  test('a cell check plots the travel lift and the threshold, most lift first', () => {
    const [a, b] = liftCells(map, 800, 8600);
    expect(cellTestPulses(a)).toEqual([14400, 15200]);
    expect(cellTestPulses(b)).toEqual([15200, 16000]);
    const tight = liftCells(map, 0, 8600)[0];
    expect(cellTestPulses(tight)).toEqual([15200]);
  });

  test('heat colours run cool to warm', () => {
    expect(heatColour(0)).toBe('hsl(205 55% 62%)');
    expect(heatColour(1)).toBe('hsl(20 55% 62%)');
    expect(heatColour(2)).toBe(heatColour(1));
  });
});
