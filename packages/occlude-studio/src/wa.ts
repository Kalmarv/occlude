/**
 * Web Awesome, the pages' component kit: imported once per page that uses
 * it, only the components the studio needs, dressed by tokens.css. Icons
 * are inline SVG (no asset base path, nothing fetched at runtime).
 */
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@awesome.me/webawesome/dist/components/slider/slider.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';

document.documentElement.classList.add('wa-dark');

/** A confirm as a dialog: resolves true on the confirming button. */
export function confirmDialog(opts: { title: string; body: string | HTMLElement; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement('wa-dialog') as HTMLElement & { open: boolean };
    dlg.setAttribute('label', opts.title);
    dlg.setAttribute('light-dismiss', '');
    const body = typeof opts.body === 'string' ? Object.assign(document.createElement('p'), { textContent: opts.body }) : opts.body;
    body.classList.add('dialog-body');
    const cancel = document.createElement('wa-button');
    cancel.setAttribute('slot', 'footer');
    cancel.setAttribute('appearance', 'outlined');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('wa-button');
    ok.setAttribute('slot', 'footer');
    ok.setAttribute('variant', opts.danger ? 'danger' : 'brand');
    ok.textContent = opts.confirm ?? 'OK';
    let result = false;
    ok.addEventListener('click', () => { result = true; dlg.open = false; });
    cancel.addEventListener('click', () => { dlg.open = false; });
    dlg.addEventListener('wa-after-hide', () => { dlg.remove(); resolve(result); });
    dlg.append(body, cancel, ok);
    document.body.append(dlg);
    requestAnimationFrame(() => { dlg.open = true; });
  });
}

/** A prompt as a dialog: resolves the typed text, or null when dismissed. */
export function promptDialog(opts: { title: string; body?: string; label?: string; placeholder?: string; confirm?: string; danger?: boolean; validate?: (v: string) => string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('wa-dialog') as HTMLElement & { open: boolean };
    dlg.setAttribute('label', opts.title);
    const wrap = document.createElement('div');
    wrap.className = 'dialog-body';
    if (opts.body) wrap.append(Object.assign(document.createElement('p'), { textContent: opts.body }));
    const input = document.createElement('wa-input') as HTMLElement & { value: string; focus(): void };
    if (opts.label) input.setAttribute('label', opts.label);
    if (opts.placeholder) input.setAttribute('placeholder', opts.placeholder);
    input.setAttribute('autofocus', '');
    const err = document.createElement('div');
    err.className = 'dialog-error';
    wrap.append(input, err);
    const cancel = document.createElement('wa-button');
    cancel.setAttribute('slot', 'footer');
    cancel.setAttribute('appearance', 'outlined');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('wa-button');
    ok.setAttribute('slot', 'footer');
    ok.setAttribute('variant', opts.danger ? 'danger' : 'brand');
    ok.textContent = opts.confirm ?? 'OK';
    let result: string | null = null;
    const submit = (): void => {
      const v = input.value;
      const problem = opts.validate?.(v) ?? null;
      if (problem) { err.textContent = problem; return; }
      result = v;
      dlg.open = false;
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') submit(); });
    cancel.addEventListener('click', () => { dlg.open = false; });
    dlg.addEventListener('wa-after-hide', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('wa-after-show', () => input.focus());
    dlg.append(wrap, cancel, ok);
    document.body.append(dlg);
    requestAnimationFrame(() => { dlg.open = true; });
  });
}
