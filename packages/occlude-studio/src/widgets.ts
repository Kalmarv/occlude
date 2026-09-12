/** Small DOM builders shared by the rail and the Machine page. */

export function button(label: string, onclick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => void onclick();
  return b;
}

export function row(label: string, control: HTMLElement, title?: string): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'row';
  if (title) r.title = title;
  const l = document.createElement('label');
  l.textContent = label;
  r.append(l, control);
  return r;
}

export function checkbox(label: string, value: boolean, onchange: (v: boolean) => void): HTMLLabelElement {
  const l = document.createElement('label');
  l.className = 'row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.style.flex = 'none';
  input.onchange = () => onchange(input.checked);
  l.append(input, document.createTextNode(` ${label}`));
  return l;
}

export function numberInput(value: number, step: number, onchange: (v: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(value);
  input.onchange = () => {
    const next = parseFloat(input.value);
    if (Number.isFinite(next)) onchange(next);
    else input.value = String(value);
  };
  return input;
}

export function pairInput(
  a: number,
  b: number,
  onchange: (a: number, b: number) => void,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const ia = numberInput(a, 1, (v) => onchange(v, parseFloat(ib.value)));
  const ib = numberInput(b, 1, (v) => onchange(parseFloat(ia.value), v));
  wrap.append(ia, ib);
  return wrap;
}

export function hint(text: string, title?: string): HTMLDivElement {
  const h = document.createElement('div');
  h.className = 'panel-hint';
  h.textContent = text;
  if (title) h.title = title;
  return h;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

/** A segmented switch: one of `options` is active; `onchange` fires with its key. */
export function segmented<K extends string>(
  options: { key: K; label: string; title?: string }[],
  active: K,
  onchange: (key: K) => void,
): { root: HTMLDivElement; set(key: K): void } {
  const root = document.createElement('div');
  root.className = 'segmented';
  root.setAttribute('role', 'tablist');
  const buttons = new Map<K, HTMLButtonElement>();
  const set = (key: K): void => {
    for (const [k, b] of buttons) {
      b.classList.toggle('active', k === key);
      b.setAttribute('aria-selected', String(k === key));
    }
    root.dataset.active = key;
  };
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.textContent = o.label;
    if (o.title) b.title = o.title;
    b.onclick = () => {
      set(o.key);
      onchange(o.key);
    };
    buttons.set(o.key, b);
    root.append(b);
  }
  set(active);
  return { root, set };
}

export function panel(title: string, open: boolean): { root: HTMLDetailsElement; body: HTMLDivElement } {
  const root = document.createElement('details');
  root.className = 'panel';
  root.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  const body = document.createElement('div');
  body.className = 'panel-body';
  root.append(summary, body);
  return { root, body };
}

/** Collapsed sub-section inside a panel — the home of set-once controls. */
export function subpanel(title: string): { root: HTMLDetailsElement; body: HTMLDivElement } {
  const root = document.createElement('details');
  root.className = 'subpanel';
  const summary = document.createElement('summary');
  summary.textContent = title;
  const body = document.createElement('div');
  body.className = 'subpanel-body';
  root.append(summary, body);
  return { root, body };
}
