/** Local persistence: sketch source, pen library, paper & machine settings. */

import { DEFAULT_PENS, type PenDef } from 'occlude';

const KEYS = {
  sketch: 'occlude.sketch',
  sketchName: 'occlude.sketchName',
  pens: 'occlude.pens',
  settings: 'occlude.settings',
};

export interface Settings {
  paper: string;
  landscape: boolean;
  defaultMarginPct: number;
  machine: {
    bedW: number;
    bedH: number;
    travelFeed: number;
    zMode: boolean;
    arcSupport: boolean;
    resolution: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  paper: 'A4',
  landscape: false,
  defaultMarginPct: 5,
  machine: {
    bedW: 300,
    bedH: 218,
    travelFeed: 6000,
    zMode: true,
    arcSupport: false,
    resolution: 0.025,
  },
};

export const DEFAULT_SKETCH = `import {
  sketch, margin, pen, circle, rect, line, path,
  hatch, crosshatch, stipple, mm, w, h,
  rnd, pick, chance, noise, push, clip, grid,
} from 'occlude';

sketch({ aspect: [3, 2], seed: 'url' });
margin(6);
pen('pigma-005-black');

// Filled shapes hide what's beneath them — later wins.
for (const cell of grid({ cols: 6, rows: 4, gap: 2 })) {
  const cx = cell.x + cell.w / 2;
  const cy = cell.y + cell.h / 2;
  const r = cell.w * rnd(0.28, 0.5);
  if (chance(0.7)) {
    circle(cx, cy, r).fill(hatch(rnd(0, 180), mm(rnd(0.8, 2))));
  } else {
    rect(cell.x + 2, cell.y + 2, cell.w - 4, cell.h - 4, 2)
      .fill(stipple(0.6), 'stabilo-88-red');
  }
}

// A horizon line, occluded by everything above it.
line(0, 50, 100, 50).z(-1);
`;

export function loadSketch(): string {
  return localStorage.getItem(KEYS.sketch) ?? DEFAULT_SKETCH;
}

export function saveSketch(src: string): void {
  localStorage.setItem(KEYS.sketch, src);
}

export function loadSketchName(): string {
  return localStorage.getItem(KEYS.sketchName) ?? '';
}

export function saveSketchName(name: string): void {
  localStorage.setItem(KEYS.sketchName, name);
}

/**
 * Pens live on the studio server (shared across devices); localStorage is
 * only the offline fallback.
 */
export async function loadPens(): Promise<PenDef[]> {
  try {
    const res = await fetch('/api/pens');
    if (res.ok) {
      const pens = (await res.json()) as PenDef[];
      if (Array.isArray(pens) && pens.length > 0) {
        localStorage.setItem(KEYS.pens, JSON.stringify(pens));
        return pens;
      }
    }
  } catch {
    // server unreachable — fall through to the local cache
  }
  try {
    const raw = localStorage.getItem(KEYS.pens);
    if (raw) {
      const pens = JSON.parse(raw) as PenDef[];
      if (Array.isArray(pens) && pens.length > 0) return pens;
    }
  } catch {
    // fall through to defaults
  }
  return structuredClone(DEFAULT_PENS);
}

export function savePens(pens: PenDef[]): void {
  localStorage.setItem(KEYS.pens, JSON.stringify(pens));
  void fetch('/api/pens', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pens),
  }).catch(() => {
    // offline: the local cache above still has it
  });
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEYS.settings);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // fall through
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEYS.settings, JSON.stringify(s));
}

export function download(filename: string, content: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
