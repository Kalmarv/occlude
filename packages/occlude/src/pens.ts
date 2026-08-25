/**
 * Pens. A pen is a label on every fragment — occlusion ignores it, export
 * groups by it. The studio persists the library; sketches refer to pens by
 * name and fail loudly on unknown names so shared sketches break visibly.
 */

export interface PenDef {
  name: string;
  /** Nib width in mm — the system's one tolerance. */
  width: number;
  color: string;
  /** Draw feed, mm/min. */
  feed: number;
  /** Z height (z-mode) or spindle S value (M3 mode) for pen down. */
  penDown: number;
  penUp: number;
  /** Settle delay after pen down/up, ms. */
  penDelay: number;
}

export const DEFAULT_PENS: PenDef[] = [
  {
    name: 'pigma-005-black',
    width: 0.2,
    color: '#111111',
    feed: 3000,
    penDown: 0,
    penUp: 5,
    penDelay: 100,
  },
  {
    name: 'pigma-01-black',
    width: 0.25,
    color: '#111111',
    feed: 3000,
    penDown: 0,
    penUp: 5,
    penDelay: 100,
  },
  {
    name: 'stabilo-88-red',
    width: 0.4,
    color: '#cc2222',
    feed: 2500,
    penDown: 0,
    penUp: 5,
    penDelay: 120,
  },
  {
    name: 'stabilo-88-green',
    width: 0.4,
    color: '#1d7a3c',
    feed: 2500,
    penDown: 0,
    penUp: 5,
    penDelay: 120,
  },
  {
    name: 'stabilo-88-blue',
    width: 0.4,
    color: '#2244bb',
    feed: 2500,
    penDown: 0,
    penUp: 5,
    penDelay: 120,
  },
];
