/** Local persistence: sketch source, pen library, paper & machine settings. */

import { DEFAULT_PENS, type PenDef } from 'occlude';

const KEYS = {
  sketch: 'occlude.sketch',
  sketchName: 'occlude.sketchName',
  pens: 'occlude.pens',
  settings: 'occlude.settings',
  ui: 'occlude.ui',
};

export interface UiPrefs {
  /** Editor pane width, CSS px; null = default (34%). */
  editorW: number | null;
  railOpen: boolean;
}

export function loadUi(): UiPrefs {
  try {
    const raw = localStorage.getItem(KEYS.ui);
    if (raw) return { editorW: null, railOpen: true, ...(JSON.parse(raw) as Partial<UiPrefs>) };
  } catch {
    // fall through
  }
  return { editorW: null, railOpen: true };
}

export function saveUi(ui: UiPrefs): void {
  localStorage.setItem(KEYS.ui, JSON.stringify(ui));
}

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

export const DEFAULT_SKETCH = `import { sketch, mm } from 'occlude';

// A sketch is a pure function: toolkit in, tree of shapes out.
// Tree order is draw order — filled shapes hide what's beneath them.
export default sketch({ aspect: [3, 2], margin: 6 }, (t) => {
  const { circle, rect, line, hatch, stipple, grid, rnd, chance, bounds } = t;
  const b = bounds();

  return [
    // A horizon line, drawn first so everything above occludes it.
    line(0, b.cy, b.w, b.cy),

    grid({ cols: 6, rows: 4, gap: 2 }).map((cell) => {
      const cx = cell.x + cell.w / 2;
      const cy = cell.y + cell.h / 2;
      return chance(0.7)
        ? circle(cx, cy, cell.w * rnd(0.28, 0.5), {
            fill: hatch(rnd(180), mm(rnd(0.8, 2))),
          })
        : rect(cell.x + 2, cell.y + 2, cell.w - 4, cell.h - 4, 2, {
            fill: stipple(0.6),
            fillPen: 'stabilo-88-red',
          });
    }),
  ];
});
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

export function download(
  filename: string,
  content: string | Uint8Array,
  type = 'text/plain',
): void {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
