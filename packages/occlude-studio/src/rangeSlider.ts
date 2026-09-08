/**
 * A two-handle range over one axis: two overlapping native range inputs,
 * the track filled between the handles. `onInput` fires while dragging,
 * with from ≤ to always (a handle pushed past the other carries it along).
 */
export interface DualRange {
  root: HTMLDivElement;
  set(from: number, to: number): void;
  setMax(max: number): void;
  get(): [number, number];
}

export function dualRange(opts: { min: number; max: number; step: number; from: number; to: number; onInput: (from: number, to: number) => void }): DualRange {
  const root = document.createElement('div');
  root.className = 'dual-range';
  const fill = document.createElement('div');
  fill.className = 'dual-range-fill';
  const lo = document.createElement('input');
  const hi = document.createElement('input');
  for (const r of [lo, hi]) {
    r.type = 'range';
    r.min = String(opts.min);
    r.max = String(opts.max);
    r.step = String(opts.step);
  }
  lo.value = String(opts.from);
  hi.value = String(opts.to);
  lo.className = 'dual-range-lo';
  hi.className = 'dual-range-hi';
  root.append(fill, lo, hi);
  const paint = (): void => {
    const min = Number(lo.min);
    const max = Number(lo.max);
    const span = Math.max(1e-9, max - min);
    const a = ((Number(lo.value) - min) / span) * 100;
    const b = ((Number(hi.value) - min) / span) * 100;
    fill.style.left = `${a}%`;
    fill.style.width = `${Math.max(0, b - a)}%`;
  };
  lo.oninput = () => {
    if (Number(lo.value) > Number(hi.value)) hi.value = lo.value;
    paint();
    opts.onInput(Number(lo.value), Number(hi.value));
  };
  hi.oninput = () => {
    if (Number(hi.value) < Number(lo.value)) lo.value = hi.value;
    paint();
    opts.onInput(Number(lo.value), Number(hi.value));
  };
  paint();
  return {
    root,
    set(from, to) { lo.value = String(from); hi.value = String(to); paint(); },
    setMax(max) { lo.max = String(max); hi.max = String(max); paint(); },
    get: () => [Number(lo.value), Number(hi.value)],
  };
}
