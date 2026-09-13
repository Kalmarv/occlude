/**
 * One execution of a sketch: everything a run owns, held by ONE object the
 * host creates, compiles a sketch into, encodes, renders, plans and exports
 * from — and then drops. There is no module-level sketch state anywhere in
 * the package: no current sketch, no paper hint, no pen library, no seed
 * hint, no registries. Two executions never share a byte, so interleaving
 * them, or abandoning one, cannot change what the other produces.
 *
 * The inputs are explicit and captured: the paper (the sketch's own `paper`
 * declaration wins over the host's), the pen library the sketch may name
 * pens from (`stroke: 'micron-03'` resolves through the run's own table —
 * the sketch's declared `pens`, then the captured library), the seed the
 * host resolved for a sketch that does not fix its own, the assets and
 * custom fills the source references, and whether inspection is on. The
 * toolkit a sketch receives is bound to its execution (`api.ts`
 * `bindToolkit`); the pure module factories (`circle`, `fill`, `mm` …)
 * return values and never touch a run.
 */

import { DEFAULT_PENS, type PenDef } from './pens.js';
import type { PaperDef } from './paper.js';
import { Rng } from './random.js';
import { parseSeed } from './draws.js';
import type { Material } from './material.js';
import { Len, resolveLen, type L } from './units.js';
import type { Shape } from './shapes.js';
import type { DrawRequest, PlanOptions } from './plan.js';
import { makeFrame, type Frame } from './record.js';
import type { AssetTable } from './imageAsset.js';
import type { FillTable } from './fills.js';

export type Winding = 'nonzero' | 'evenodd';

export interface TransformOp {
  translate?: [L, L];
  /** Degrees. */
  rotate?: number;
  scale?: number | [number, number];
  /** Pivot for `rotate` and `scale`, in user coordinates: `[x, y]`, or
   * `'center'` for the centre of the drawable. Its own translate is a plain
   * move. Without it, rotation and scale pivot on the user origin. */
  origin?: [L, L] | 'center';
}

export interface SketchOptions {
  aspect?: [number, number] | 'square' | 'paper';
  seed?: 'url' | number | string;
  origin?: 'topLeft' | 'center';
  yUp?: boolean;
  /** Default rect anchoring: 'corner' (default) or 'center' (p5 rectMode). */
  rectMode?: 'corner' | 'center';
}

export interface ClipRecord {
  /** The shape whose region clips; removed from the drawable list. */
  shape: Shape;
  /** Complement: children keep the OUTSIDE of the region. */
  invert: boolean;
}

/** One addressed draw: its address, the unit float it returned, and what
 * the call made of it — a number from `rnd`, an index from `pick`, a
 * boolean from `chance`/`prob` — so a frozen sketch can write it back. */
export interface DrawEntry {
  addr: string;
  f: number;
  value?: number | boolean;
}

/** Running stats for one probe label plus a deterministic thinned sample
 * (every stride-th value; the stride doubles when the reservoir fills) —
 * enough for a histogram without storing every value. */
export interface ProbeAccumulator {
  count: number;
  nonFinite: number;
  min: number;
  max: number;
  sum: number;
  stride: number;
  samples: number[];
}

const PROBE_RESERVOIR = 2048;

/** One probe's summary as posted to the studio. */
export interface ProbeSummary {
  count: number;
  nonFinite: number;
  min: number;
  max: number;
  mean: number;
  /** Deterministically thinned values, for a histogram. */
  samples: number[];
}

/** What the current run registered: names and sizes, in registration order. */
export interface InspectionEntry {
  name: string;
  points: number;
  edges: number;
}

/** One registered material as plain transport: copies of its positions,
 * edge list and declared columns, nothing branded, nothing shared with the
 * material (so a transfer cannot detach what the sketch still holds). */
export interface InspectionPayload {
  name: string;
  n: number;
  x: Float64Array;
  y: Float64Array;
  /** `[a0, b0, a1, b1, …]`, stored order. */
  edges: Uint32Array;
  attrs: Record<string, Float64Array>;
  edgeAttrs: Record<string, Float64Array>;
  iteration: number;
}

export interface RandomStream {
  rnd(): number;
  rnd(n: number): number;
  rnd(a: number, b: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
  prob<T>(p: number, fn: () => T, elseFn?: () => T): T | undefined;
  noise(x: number, y?: number, z?: number): number;
}

/** A sheet: size in mm and the colour it is drawn on (presentation only —
 * the SVG background; never geometry). */
export interface PaperSpec {
  w: number;
  h: number;
  color?: string;
}

/**
 * What a run is given. Every field is a value the host resolved: nothing
 * here is read from a URL, a session or a library at run time.
 */
export interface ExecutionInputs {
  /** The sheet the host will render on. A sketch that declares its own
   * `paper` overrides it. */
  paper: PaperSpec;
  /** The captured pen library: models a sketch may instantiate through
   * `@user/pens`, and the pool undeclared pen names resolve from. Default:
   * the package's `DEFAULT_PENS`. */
  library?: readonly PenDef[];
  /** The seed for a sketch whose config leaves it open (`'url'` or
   * unset). The host owns URL and session seeds. Default 0. */
  seed?: number | string;
  /** Margin (percent of the short paper side) for a sketch that sets none. */
  marginPct?: number;
  /** Captured text and image assets the source references, by name. */
  assets?: AssetTable;
  /** Captured custom fill modules the source references, by name. */
  fills?: FillTable;
  /** Register `t.inspect` materials (the studio's inspector). Default off:
   * a sketch that inspects then costs the same as one that does not. */
  inspect?: boolean;
}

/** A sketch's declared configuration as `compile` reads it (the public
 * `SketchConfig` in api.ts adds the tree function). */
export interface CompileConfig extends SketchOptions {
  /** Percent inset from the paper edge. */
  margin?: L;
  /** Default pen for shapes that do not set one. */
  pen?: string;
  /** The sheet, declared by the sketch (wins over the host's). */
  paper?: PaperSpec;
  /** Sketch-local pens by name: `{ blue: fineliner({ color }) }`. */
  pens?: Readonly<Record<string, PenDef | Omit<PenDef, 'name'>>>;
}

/** The addressed-draw hook the host's tagged code calls: run `fn` with
 * `site` on the draw stack. Bound to one execution. */
export type DrawHook = <T>(site: string, fn: () => T) => T;

export class Execution {
  readonly inputs: Readonly<Required<Pick<ExecutionInputs, 'paper' | 'library' | 'seed' | 'marginPct' | 'inspect'>> & Pick<ExecutionInputs, 'assets' | 'fills'>>;

  // ---- fixed at compile ----
  /** The sheet this run resolves against (the sketch's own, or the host's). */
  paper: PaperSpec;
  aspect: [number, number] | 'square' | 'paper' = 'paper';
  origin: 'topLeft' | 'center' = 'topLeft';
  yUp = false;
  rectMode: 'corner' | 'center' = 'corner';
  marginPct = 0;
  /** Every pen a name in this run may resolve to: the captured library
   * under the sketch's declared pens (a declared name shadows). */
  pens: Map<string, PenDef> = new Map();
  currentPen = 'default';
  /** The seed the streams were built from, base only (the tail is `overrides`). */
  seedUsed: number | string = 0;
  rng: Rng = new Rng(0);
  overrides: Record<string, number> = {};
  /** The frame the run lowers against, resolved once at compile. */
  frame: Frame;

  // ---- the recording ----
  shapes: Shape[] = [];
  clips: ClipRecord[] = [];
  /** Active clip ids for shapes recorded now. */
  clipStack: number[] = [];
  /** Active transform chain (outermost first). */
  tfChain: TransformOp[] = [];
  drawIndex = 0;
  planOptions: PlanOptions | null = null;
  drawRequest: DrawRequest | null = null;

  // ---- what the run reports ----
  probes: Map<string, ProbeAccumulator> = new Map();
  inspections: Map<string, Material> = new Map();
  siteStack: string[] = [];
  siteCounts: Map<string, number> = new Map();
  overrideHits: Set<string> = new Set();
  drawLog: DrawEntry[] = [];
  private lastDraw: DrawEntry | null = null;
  /** Sketch-time `within` bounds lowered once per shape for THIS frame. */
  readonly boundCache: WeakMap<object, unknown> = new WeakMap();

  constructor(inputs: ExecutionInputs) {
    if (!inputs || typeof inputs !== 'object' || !inputs.paper) throw new Error('Execution: inputs.paper is required ({ w, h } in mm)');
    if (!(inputs.paper.w > 0) || !(inputs.paper.h > 0)) throw new Error(`Execution: paper must be positive, got ${inputs.paper.w}×${inputs.paper.h}`);
    this.inputs = Object.freeze({
      paper: { ...inputs.paper },
      library: inputs.library && inputs.library.length > 0 ? inputs.library.map((p) => ({ ...p })) : DEFAULT_PENS.map((p) => ({ ...p })),
      seed: inputs.seed ?? 0,
      marginPct: inputs.marginPct ?? 0,
      inspect: inputs.inspect === true,
      assets: inputs.assets,
      fills: inputs.fills,
    });
    this.paper = this.inputs.paper;
    this.frame = makeFrame(this, this.paper.w, this.paper.h, false);
    this.compiled = false;
  }

  private compiled: boolean;

  /**
   * Fix the run's configuration from the sketch's: aspect and frame
   * conventions, the paper (the sketch's own wins), the margin, the pen
   * table and the seeded streams. Once, before the tree is recorded.
   */
  begin(cfg: CompileConfig): void {
    if (this.compiled) throw new Error('Execution: already compiled — one execution runs one sketch once');
    this.compiled = true;
    this.aspect = cfg.aspect ?? 'paper';
    this.origin = cfg.origin ?? 'topLeft';
    this.yUp = cfg.yUp ?? false;
    this.rectMode = cfg.rectMode ?? 'corner';
    if (cfg.paper) {
      if (!(cfg.paper.w > 0) || !(cfg.paper.h > 0)) throw new Error(`paper: dimensions must be positive, got ${cfg.paper.w}×${cfg.paper.h}`);
      this.paper = { ...cfg.paper };
    }
    // The margin is a sketch-level composition setting: a percent of the
    // short paper side, or a physical length resolved against the paper.
    const m = cfg.margin ?? this.inputs.marginPct;
    this.marginPct = typeof m === 'number' ? m : marginPercent(m, this.paper);
    // Pens: the captured library under the sketch's declared pens.
    for (const p of this.inputs.library) this.pens.set(p.name, { ...p });
    const declared = cfg.pens ?? {};
    for (const [name, def] of Object.entries(declared)) {
      checkPen(name, def);
      this.pens.set(name, { ...def, name });
    }
    const first = Object.keys(declared)[0] ?? this.inputs.library[0]?.name ?? 'default';
    this.currentPen = cfg.pen ?? first;
    if (!this.pens.has(this.currentPen)) throw new Error(`unknown pen '${this.currentPen}' — available: ${[...this.pens.keys()].join(', ')}`);
    // Seed: the sketch's own when it fixes one, else the host's. A seed may
    // carry draw overrides as a tail (see draws.ts).
    const raw = cfg.seed === 'url' || cfg.seed === undefined ? this.inputs.seed : cfg.seed;
    const parsed = parseSeed(raw);
    this.seedUsed = typeof raw === 'number' ? raw : parsed.seed;
    this.overrides = parsed.overrides;
    this.rng = new Rng(this.seedUsed);
    this.frame = makeFrame(this, this.paper.w, this.paper.h, false);
  }

  // ---- geometry of the drawable ----

  /**
   * The drawable extent in bare units (percent of the short side): the safe
   * full-bleed rect is `rect(0, 0, b.w, b.h)`. The short side is always 100;
   * the long side is 100 × aspect ratio. For aspect 'paper' this uses the
   * run's paper.
   */
  bounds(): { w: number; h: number; cx: number; cy: number } {
    let aw: number;
    let ah: number;
    if (this.aspect === 'square') {
      aw = 1;
      ah = 1;
    } else if (this.aspect === 'paper') {
      const m = (this.marginPct / 100) * Math.min(this.paper.w, this.paper.h);
      aw = this.paper.w - 2 * m;
      ah = this.paper.h - 2 * m;
    } else {
      [aw, ah] = this.aspect;
    }
    const short = Math.min(aw, ah);
    const w = (100 * aw) / short;
    const h = (100 * ah) / short;
    return { w, h, cx: w / 2, cy: h / 2 };
  }

  /** mm per user unit for the run's aspect and paper — lets sketch-time
   * helpers (scatter spacing) resolve mm() before render. */
  unitScaleMm(): number {
    const m = (this.marginPct / 100) * Math.min(this.paper.w, this.paper.h);
    const innerW = this.paper.w - 2 * m;
    const innerH = this.paper.h - 2 * m;
    let aw: number;
    let ah: number;
    if (this.aspect === 'square') {
      aw = 1;
      ah = 1;
    } else if (this.aspect === 'paper') {
      aw = innerW;
      ah = innerH;
    } else {
      [aw, ah] = this.aspect;
    }
    const scale = Math.min(innerW / aw, innerH / ah);
    return (Math.min(aw, ah) * scale) / 100;
  }

  /** Sketch-time length resolution against the drawable (mm via the paper). */
  len(l: L): number {
    if (l instanceof Len && l.kind === 'mm') return l.value / this.unitScaleMm();
    const b = this.bounds();
    return resolveLen(l, { innerW: b.w, innerH: b.h });
  }

  // ---- the recording ----

  /** Scope a transform to the callback. Nesting composes; no unbalanced pops. */
  push(t: TransformOp, fn: () => void): void {
    this.tfChain.push(t);
    try {
      fn();
    } finally {
      this.tfChain.pop();
    }
  }

  /**
   * Restrict everything created inside `fn` to the region of `shape`. The
   * clip shape itself is not drawn and does not occlude.
   */
  clip(shape: Shape, fn: () => void, invert = false): void {
    // The shape was recorded on construction; a clip region is not a drawable.
    const idx = this.shapes.indexOf(shape);
    if (idx >= 0) this.shapes.splice(idx, 1);
    const clipId = this.clips.length;
    this.clips.push({ shape, invert });
    this.clipStack.push(clipId);
    try {
      fn();
    } finally {
      this.clipStack.pop();
    }
  }

  /** A pen name of this run, or a loud error naming what is available. */
  penOrThrow(name: string): string {
    if (!this.pens.has(name)) {
      throw new Error(`unknown pen '${name}' — available: ${[...this.pens.keys()].join(', ')}`);
    }
    return name;
  }

  // ---- randomness (one stream per sketch) ----

  /**
   * One unit float from `rng`, addressed when a tagged call site is on the
   * stack: `site:k` for the k-th draw that site made this run. An override at
   * that address is returned instead, and the stream has still advanced, so
   * every later draw is what the seed alone would have given.
   */
  private unitDraw(rng: Rng): number {
    const f = rng.float();
    const site = this.siteStack[this.siteStack.length - 1];
    this.lastDraw = null;
    if (site === undefined) return f;
    const k = this.siteCounts.get(site) ?? 0;
    this.siteCounts.set(site, k + 1);
    const addr = `${site}:${k}`;
    const o = this.overrides[addr];
    if (o !== undefined) this.overrideHits.add(addr);
    const v = o ?? f;
    const entry: DrawEntry = { addr, f: v };
    this.drawLog.push(entry);
    this.lastDraw = entry;
    return v;
  }

  /** Record what a draw's caller made of the unit float. */
  private madeOf(value: number | boolean): void {
    if (this.lastDraw) this.lastDraw.value = value;
  }

  /** The tagged code's hook: run `fn` with `site` on the draw stack. */
  readonly drawAt: DrawHook = <T,>(site: string, fn: () => T): T => {
    this.siteStack.push(site);
    try {
      return fn();
    } finally {
      this.siteStack.pop();
    }
  };

  rnd(): number;
  rnd(n: number): number;
  rnd(a: number, b: number): number;
  rnd(a?: number, b?: number): number {
    const f = this.unitDraw(this.rng);
    const v = a === undefined ? f : b === undefined ? f * a : a + f * (b - a);
    this.madeOf(v);
    return v;
  }

  pick<T>(arr: readonly T[]): T {
    const i = Math.floor(this.unitDraw(this.rng) * arr.length);
    this.madeOf(i);
    return arr[i];
  }

  chance(p: number): boolean {
    const v = this.unitDraw(this.rng) < p;
    this.madeOf(v);
    return v;
  }

  prob<T>(p: number, fn: () => T, elseFn?: () => T): T | undefined {
    if (this.chance(p)) return fn();
    return elseFn?.();
  }

  noise(x: number, y = 0, z = 0): number {
    return this.rng.noise(x, y, z);
  }

  /**
   * An independent random stream keyed off the master seed. Inserting shapes
   * that draw from one stream never shifts the values of another, so parts of
   * a composition can be iterated on in isolation.
   */
  stream(name: string): RandomStream {
    const rng = new Rng(`${this.seedUsed}:stream:${name}`);
    const rnd = (a?: number, b?: number): number => {
      const f = this.unitDraw(rng);
      const v = a === undefined ? f : b === undefined ? f * a : a + f * (b - a);
      this.madeOf(v);
      return v;
    };
    const chanceOf = (p: number): boolean => {
      const v = this.unitDraw(rng) < p;
      this.madeOf(v);
      return v;
    };
    return {
      rnd: rnd as RandomStream['rnd'],
      pick: <T>(arr: readonly T[]): T => { const i = Math.floor(this.unitDraw(rng) * arr.length); this.madeOf(i); return arr[i]; },
      chance: chanceOf,
      prob: (p, fn, elseFn) => (chanceOf(p) ? fn() : elseFn?.()),
      noise: (x, y = 0, z = 0) => rng.noise(x, y, z),
    };
  }

  /** Every addressed draw of this run, in order: the material an
   * evolution grid mutates. */
  getDrawLog(): DrawEntry[] {
    return this.drawLog.map((d) => ({ ...d }));
  }

  /** The seed's overrides and which of them a draw actually used; the rest
   * name addresses this source no longer has. */
  getOverrideReport(): { overrides: Record<string, number>; hit: string[]; dropped: string[] } {
    const keys = Object.keys(this.overrides);
    return {
      overrides: { ...this.overrides },
      hit: keys.filter((k) => this.overrideHits.has(k)),
      dropped: keys.filter((k) => !this.overrideHits.has(k)),
    };
  }

  // ---- probes and inspection ----

  /** Record one value under `label`. Identity on the value; numbers only
   * count toward the stats (anything else is a "non-finite" tick). */
  recordProbe(label: string, value: unknown): void {
    let p = this.probes.get(label);
    if (!p) {
      p = { count: 0, nonFinite: 0, min: Infinity, max: -Infinity, sum: 0, stride: 1, samples: [] };
      this.probes.set(label, p);
    }
    p.count++;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      p.nonFinite++;
      return;
    }
    if (value < p.min) p.min = value;
    if (value > p.max) p.max = value;
    p.sum += value;
    if (p.count % p.stride === 0) {
      if (p.samples.length >= PROBE_RESERVOIR) {
        p.samples = p.samples.filter((_, i) => i % 2 === 0);
        p.stride *= 2;
        if (p.count % p.stride !== 0) return;
      }
      p.samples.push(value);
    }
  }

  /** Every probe of this run, in first-seen order. */
  getProbeStats(): Record<string, ProbeSummary> {
    const out: Record<string, ProbeSummary> = {};
    for (const [label, p] of this.probes) {
      const finite = p.count - p.nonFinite;
      out[label] = {
        count: p.count,
        nonFinite: p.nonFinite,
        min: finite > 0 ? p.min : NaN,
        max: finite > 0 ? p.max : NaN,
        mean: finite > 0 ? p.sum / finite : NaN,
        samples: p.samples.slice(),
      };
    }
    return out;
  }

  /** Register `value` under `label` for the debug inspector. Not history:
   * the last registration under a label is the one kept. */
  recordInspection(label: string, value: Material): void {
    if (!this.inputs.inspect) return;
    this.inspections.set(label, value);
  }

  getInspectionIndex(): InspectionEntry[] {
    const out: InspectionEntry[] = [];
    for (const [name, m] of this.inspections) out.push({ name, points: m.n, edges: m.edgeCount });
    return out;
  }

  inspectionPayload(name: string): InspectionPayload | null {
    const m = this.inspections.get(name);
    if (!m) return null;
    const attrs: Record<string, Float64Array> = {};
    for (const k of Object.keys(m.attrs)) attrs[k] = m.attrs[k].slice();
    const edgeAttrs: Record<string, Float64Array> = {};
    for (const k of Object.keys(m.edgeAttrs)) edgeAttrs[k] = m.edgeAttrs[k].slice();
    return { name, n: m.n, x: m.x.slice(), y: m.y.slice(), edges: m.edgeList.slice(), attrs, edgeAttrs, iteration: m.iteration };
  }
}

/** A margin given as a physical length, as a percent of the short side. */
function marginPercent(m: L, paper: PaperSpec): number {
  const short = Math.min(paper.w, paper.h);
  const mmValue = m instanceof Len && m.kind === 'mm' ? m.value : resolveLen(m, { innerW: paper.w, innerH: paper.h });
  return (mmValue / short) * 100;
}

function checkPen(name: string, def: Omit<PenDef, 'name'>): void {
  if (typeof name !== 'string' || name.length === 0) throw new Error('pens: a pen needs a name');
  if (!def || typeof def !== 'object') throw new Error(`pens: '${name}' is not a pen — use pen({ width, … }) or a library model`);
  if (!(def.width > 0)) throw new Error(`pens: '${name}' needs a positive width (mm)`);
  if (typeof def.color !== 'string') throw new Error(`pens: '${name}' needs a color`);
}

// ---- the explicit pen and paper vocabulary ----

/** A pen from its physical facts: width and colour, with the machine
 * settings defaulted like the package's own pens. Pure — a value a sketch
 * declares under a name in `pens`, or a fill or stroke names. */
export function pen(spec: Omit<Partial<PenDef>, 'width'> & { width: L }): Omit<PenDef, 'name'> & { name?: string } {
  const width = typeof spec.width === 'number' ? spec.width : spec.width instanceof Len && spec.width.kind === 'mm' ? spec.width.value : NaN;
  if (!(width > 0)) throw new Error('pen: width must be a positive length in mm (a number, or mm(…)/inch(…))');
  const { name, ...rest } = spec;
  const out: Omit<PenDef, 'name'> & { name?: string } = {
    color: '#111111',
    feed: 3000,
    penDown: 0,
    penUp: 5,
    penDelay: 100,
    ...rest,
    width,
  };
  if (name !== undefined) out.name = name;
  return out;
}

/** A library pen as a model: `const fineliner = penModel(def)` gives a
 * factory whose every call is a fresh instance — the model's settings
 * under the caller's overrides (a colour, most often), never the model
 * mutated. Instances are distinct values: twenty colours of one pen are
 * twenty pens for grouping, changes and export. */
export function penModel(def: PenDef): (overrides?: Partial<Omit<PenDef, 'name'>>) => Omit<PenDef, 'name'> {
  const base = Object.freeze({ ...def });
  return (overrides = {}) => {
    const { name: _dropped, ...model } = base;
    void _dropped;
    return { ...model, ...overrides };
  };
}

/** A sheet from its dimensions (any length unit — `inch(8.5)`, `mm(210)`,
 * or a number of mm) and an optional colour. Pure. */
export function paper(spec: { width: L; height: L; color?: string }): PaperSpec {
  const toMm = (v: L, what: string): number => {
    const n = typeof v === 'number' ? v : v instanceof Len && v.kind === 'mm' ? v.value : NaN;
    if (!(n > 0)) throw new Error(`paper: ${what} must be a positive physical length (mm or inch)`);
    return n;
  };
  const out: PaperSpec = { w: toMm(spec.width, 'width'), h: toMm(spec.height, 'height') };
  if (spec.color !== undefined) out.color = spec.color;
  return out;
}

/** A library paper as a model: a factory of fresh sheets with overrides. */
export function paperModel(def: PaperSpec): (overrides?: Partial<PaperSpec>) => PaperSpec {
  const base = Object.freeze({ ...def });
  return (overrides = {}) => ({ ...base, ...overrides });
}

/** A library entry's export name in `@user/pens` / `@user/papers`:
 * `micron-03` → `micron_03` (a valid identifier; the original name still
 * works as a pen name). */
export function moduleName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
}

/** The library modules a sketch may import, built from captured
 * libraries: every entry a factory of fresh instances over the definition
 * (`penModel`, `paperModel`). Hosts hand these to their `require` shim —
 * the studio runner and the node tools alike — so a sketch resolves
 * `import { fineliner } from '@user/pens'` from the same values a run was
 * given. */
export function userModules(pens: readonly PenDef[], papers: readonly PaperDef[]): Record<'@user/pens' | '@user/papers', Record<string, unknown>> {
  const penMods: Record<string, unknown> = {};
  for (const p of pens) penMods[moduleName(p.name)] = penModel(p);
  const paperMods: Record<string, unknown> = {};
  for (const p of papers) paperMods[moduleName(p.name)] = paperModel(p.color === undefined ? { w: p.w, h: p.h } : { w: p.w, h: p.h, color: p.color });
  return { '@user/pens': penMods, '@user/papers': paperMods };
}
