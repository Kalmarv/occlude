import { describe, expect, test } from 'vitest';

import { DEFAULT_PROFILE, migrateEbb } from './store.js';

// Servo pulses: SC,4 is the pen-UP register (SP,1 target), SC,5 pen-DOWN.
// The fields were once named servoDown/servoUp while feeding SC,4/SC,5 —
// inverted — and the pairs shipped under that reading under-used the lift.
describe('migrateEbb', () => {
  const tuned = { ...DEFAULT_PROFILE.ebb, penUpPulse: 9000, penDownPulse: 17500 };

  test('legacy field names map to the register they drove', () => {
    const { penUpPulse: _u, penDownPulse: _d, ...rest } = DEFAULT_PROFILE.ebb;
    const out = migrateEbb({ ...rest, servoDown: 9000, servoUp: 17500 });
    expect(out.penUpPulse).toBe(9000); // servoDown fed SC,4 = pen up
    expect(out.penDownPulse).toBe(17500); // servoUp fed SC,5 = pen down
    expect('servoDown' in out).toBe(false);
    expect('servoUp' in out).toBe(false);
  });

  test.each([
    [10000, 14200],
    [10000, 16000],
    [7500, 14200],
    [7500, 16000],
  ])('the shipped default pair %i/%i bumps to the swept values', (up, down) => {
    const out = migrateEbb({ ...DEFAULT_PROFILE.ebb, servoDown: up, servoUp: down, penUpPulse: undefined, penDownPulse: undefined });
    expect(out.penUpPulse).toBe(DEFAULT_PROFILE.ebb.penUpPulse);
    expect(out.penDownPulse).toBe(DEFAULT_PROFILE.ebb.penDownPulse);
  });

  test('a hand-tuned pair is kept, even if one half matches an old default', () => {
    expect(migrateEbb(tuned)).toEqual(tuned);
    const halfOld = { ...tuned, penUpPulse: 10000 };
    expect(migrateEbb(halfOld)).toEqual(halfOld);
  });

  test('new names win over stale legacy fields left in the same blob', () => {
    const out = migrateEbb({ ...tuned, servoDown: 10000, servoUp: 14200 });
    expect(out.penUpPulse).toBe(9000);
    expect(out.penDownPulse).toBe(17500);
  });

  test('fields added after a profile was saved are filled from the default', () => {
    const out = migrateEbb({ stepsPerMm: 80 });
    expect(out.stepsPerMm).toBe(80);
    expect(out.quickHopMm).toBe(DEFAULT_PROFILE.ebb.quickHopMm);
    expect(out.penUpPulse).toBe(DEFAULT_PROFILE.ebb.penUpPulse);
  });
});
