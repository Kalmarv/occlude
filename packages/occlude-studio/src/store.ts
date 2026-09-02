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
  /** Rail width, CSS px; null = default (280px). */
  railW: number | null;
}

export function loadUi(): UiPrefs {
  const defaults: UiPrefs = { editorW: null, railOpen: true, railW: null };
  try {
    const raw = localStorage.getItem(KEYS.ui);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<UiPrefs>) };
  } catch {
    // fall through
  }
  return defaults;
}

export function saveUi(ui: UiPrefs): void {
  localStorage.setItem(KEYS.ui, JSON.stringify(ui));
}

export interface MachineSettings {
  bedW: number;
  bedH: number;
  travelFeed: number;
  zMode: boolean;
  arcSupport: boolean;
  resolution: number;
}

export interface EbbSettings {
  stepsPerMm: number;
  swapXY: boolean;
  invertX: boolean;
  invertY: boolean;
  servoDown: number;
  servoUp: number;
  acceleration: number;
  travelAcceleration: number;
  junctionDeviation: number;
  minimumCruiseRatio: number;
  lmMotion: boolean;
  quickHopMm: number;
  /** Chains between mid-plot QS drift checks (each one drains the FIFO —
   * a deliberate ~0.5s pause). 0 = check only at plot end. */
  driftCheckEvery: number;
}

/** A machine profile: everything physical about one machine (or one REGIME
 * of a machine — 'iDraw A3 (large)' with quick-hop off is a profile of the
 * same hardware). Profiles live on the studio server, shared across
 * devices; the ACTIVE choice is per-browser (Settings.activeProfile). */
export interface MachineProfile {
  name: string;
  driver: 'ebb' | 'gcode';
  machine: MachineSettings;
  ebb: EbbSettings;
}

export interface Settings {
  /** Name of the active machine profile. */
  activeProfile: string;
  paper: string;
  /** Used when paper === 'Custom' — always stored in mm. */
  customPaper: { w: number; h: number };
  /** Display unit for the custom size inputs. */
  paperUnit: 'mm' | 'in';
  landscape: boolean;
  defaultMarginPct: number;
}

export const DEFAULT_SETTINGS: Settings = {
  activeProfile: 'iDraw',
  paper: 'A4',
  customPaper: { w: 200, h: 200 },
  paperUnit: 'mm',
  landscape: false,
  defaultMarginPct: 5,
};

/** The measured iDraw (EBB 2.8.1, 2026-08-26): 100 steps/mm at 1/16
 * microstep; axes rotated 90° vs the page (swap + invert X); servo SC
 * positions verified on hardware — 10000 IS fully down (the arm clears
 * the pen, which rests under its own weight; contact is mechanical). */
export const DEFAULT_PROFILE: MachineProfile = {
  name: 'iDraw',
  driver: 'ebb',
  machine: {
    bedW: 300,
    bedH: 218,
    travelFeed: 6000,
    zMode: true,
    arcSupport: false,
    resolution: 0.025,
  },
  ebb: {
    stepsPerMm: 100,
    swapXY: true,
    invertX: true,
    invertY: false,
    servoDown: 10000,
    servoUp: 14200,
    acceleration: 1000,
    travelAcceleration: 2000,
    junctionDeviation: 0.02,
    minimumCruiseRatio: 0.5,
    lmMotion: true,
    quickHopMm: 15,
    driftCheckEvery: 1000,
  },
};

export const DEFAULT_SKETCH = `import { sketch, mm } from 'occlude';

// A sketch is a pure function: toolkit in, tree of shapes out.
// Tree order is draw order — filled shapes hide what's beneath them.
export default sketch({ aspect: [3, 2], margin: 6 }, (t) => {
  const { circle, rect, line, fill, grid, rnd, chance, bounds } = t;
  const b = bounds();

  return [
    // A horizon line, drawn first so everything above occludes it.
    line(0, b.cy, b.w, b.cy),

    grid({ cols: 6, rows: 4, gap: 2 }).map((cell) => {
      const cx = cell.x + cell.w / 2;
      const cy = cell.y + cell.h / 2;
      return chance(0.7)
        ? circle(cx, cy, cell.w * rnd(0.28, 0.5), {
            fill: fill('hatch', { angle: rnd(180), spacing: mm(rnd(0.8, 2)) }),
          })
        : rect(cell.x + 2, cell.y + 2, cell.w - 4, cell.h - 4, 2, {
            fill: fill('stipple', { density: 0.6 }),
            fillPen: 'stabilo-88-red',
          });
    }),
  ];
});
`;

/** Blank-slate starter for the New button: one visible mark, no tutorial. */
export const NEW_SKETCH = `import { sketch } from 'occlude';

export default sketch({ aspect: [3, 2], margin: 6 }, (t) => {
  const { circle, bounds } = t;
  const b = bounds();

  return [circle(b.cx, b.cy, b.h / 4)];
});
`;

/** Starter for a new fill file: declared params, a pure generator, no
 * imports beyond occlude, no captures — the storable shape. */
export const NEW_FILL = `import { fillAsset, rulings, mm } from 'occlude';

// A fill file: declared params + a pure generator of marks in paper mm.
// It imports nothing but occlude and captures nothing — that is what makes
// it storable, shareable, and embeddable in exports. Use it from a sketch
// as fill('<name>', { spacing: mm(1), angle: 60 }).
export default fillAsset({
  params: { spacing: mm(1.5), angle: 45 },
  generate(region, p, ctx) {
    return rulings(region, { spacing: ctx.len(p.spacing) * ctx.coarsen, angle: p.angle });
  },
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
export async function loadProfiles(): Promise<MachineProfile[]> {
  try {
    const res = await fetch('/api/profiles');
    if (res.ok) {
      const profiles = (await res.json()) as MachineProfile[];
      if (Array.isArray(profiles) && profiles.length > 0) {
        // Forward-compat: fill fields added after a profile was saved.
        for (const pp of profiles) {
          pp.machine = { ...DEFAULT_PROFILE.machine, ...pp.machine };
          pp.ebb = { ...DEFAULT_PROFILE.ebb, ...pp.ebb };
        }
        localStorage.setItem('occlude.profiles', JSON.stringify(profiles));
        return profiles;
      }
    }
  } catch {
    // server unreachable — fall through
  }
  try {
    const raw = localStorage.getItem('occlude.profiles');
    if (raw) {
      const profiles = JSON.parse(raw) as MachineProfile[];
      if (Array.isArray(profiles) && profiles.length > 0) return profiles;
    }
  } catch {
    // corrupt cache
  }
  // Migration: the pre-profile settings blob carried one implicit machine.
  const migrated: MachineProfile = structuredClone(DEFAULT_PROFILE);
  try {
    const raw = localStorage.getItem(KEYS.settings);
    if (raw) {
      const old = JSON.parse(raw) as { machine?: MachineSettings; ebb?: EbbSettings };
      if (old.machine) migrated.machine = { ...migrated.machine, ...old.machine };
      if (old.ebb) migrated.ebb = { ...migrated.ebb, ...migrateEbb(old.ebb) };
    }
  } catch {
    // defaults stand
  }
  saveProfiles([migrated]);
  return [migrated];
}

export function saveProfiles(profiles: MachineProfile[]): void {
  localStorage.setItem('occlude.profiles', JSON.stringify(profiles));
  void fetch('/api/profiles', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profiles),
  }).catch(() => {
    // server unreachable — local cache still holds it
  });
}

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

/** Stored values beat defaults, so default changes need explicit
 * migrations: 7500 was a briefly-deployed mistake (the extension's range
 * floor) — the hardware-verified fully-down value is 10000. */
function migrateEbb(ebb: EbbSettings): EbbSettings {
  return ebb.servoDown === 7500 ? { ...ebb, servoDown: 10000 } : ebb;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEYS.settings);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings> & {
        machine?: unknown; ebb?: unknown; // pre-profile blobs carry these
      };
      const { machine: _m, ebb: _e, ...rest } = parsed;
      return { ...DEFAULT_SETTINGS, ...rest };
    }
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
