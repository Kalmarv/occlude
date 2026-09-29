/**
 * "Copy debug info": everything a remote look at a machine problem needs,
 * as one plain-text block to paste — the error, the build, the browser, the
 * USB device, the machine profile and the board's own settings, the plot's
 * progress, the sketch (name, seed, pen, source) and the tail of the serial
 * transcript. Read at the moment of the click from the session that plots,
 * so it holds that session's traffic.
 */

import type { Driver } from './machine.js';
import { download } from './store.js';
import { notify } from './wa.js';
import { button } from './widgets.js';
import type { MachineProfile } from './store.js';

/** How much of the serial transcript the block carries. */
export const DEBUG_LOG_LINES = 400;

export interface DebugInputs {
  error: string;
  build: string;
  driver: Driver;
  profile: MachineProfile;
  progress: string;
  /** The sketch on the page that plots; the Machine page has none. */
  sketch?: { name: string; seed: string | null; pen: string; source: string; execution: unknown };
}

const hex4 = (n: number | undefined): string => (n === undefined ? '?' : n.toString(16).padStart(4, '0'));

export function debugInfo(i: DebugInputs): string {
  const d = i.driver;
  const usb = d.usbInfo();
  const board = 'grblSettings' in d && d.grblSettings.size
    ? [...d.grblSettings].sort((a, b) => a[0] - b[0]).map(([k, v]) => `$${k}=${v}`).join(' ')
    : '(not read)';
  const lines = d.transcript().split('\n');
  const tail = lines.slice(-DEBUG_LOG_LINES);
  return [
    `occlude debug info — ${new Date().toISOString()}`,
    `error: ${i.error || '(none shown)'}`,
    `build: ${i.build}`,
    `browser: ${navigator.userAgent}`,
    `usb: ${usb ? `${hex4(usb.usbVendorId)}:${hex4(usb.usbProductId)}` : '(no port open)'}`,
    `driver: ${i.profile.driver ?? 'ebb'} · firmware ${d.version || '(unknown)'} · ${d.connected ? 'connected' : 'not connected'} · ${d.plotting ? 'plotting' : 'idle'}`,
    `board settings: ${board}`,
    `plot: ${i.progress || '(no plot this session)'}`,
    '',
    `## machine profile`,
    JSON.stringify(i.profile, null, 2),
    '',
    ...(i.sketch ? [
      `## sketch: ${i.sketch.name || '(unsaved)'} · seed ${i.sketch.seed ?? '(none)'} · pen ${i.sketch.pen || '(default)'}`,
      `execution: ${JSON.stringify(i.sketch.execution)}`,
      '```ts',
      i.sketch.source,
      '```',
    ] : ['## sketch: (the Machine page runs no sketch)']),
    '',
    `## serial log (last ${tail.length} of ${lines.length} lines)`,
    '```',
    ...tail,
    '```',
  ].join('\n');
}

/** The button: the block to the clipboard, or to a file where the browser
 * refuses the clipboard. `read` gathers the inputs at the click. */
export function copyDebugButton(read: () => DebugInputs): HTMLButtonElement {
  return button('Copy debug info', async () => {
    const text = debugInfo(read());
    try {
      await navigator.clipboard.writeText(text);
      notify('Debug info copied — paste it into the chat', 'success');
    } catch {
      download('occlude-debug.txt', text, 'text/plain');
      notify('The clipboard was refused — the debug info was downloaded instead', 'warning');
    }
  });
}

/** A machine error where the user is looking, with its debug info one
 * click away (a page may write the clipboard only from a click). */
export function showMachineError(status: HTMLElement, e: unknown, read: (error: string) => DebugInputs): void {
  const message = e instanceof Error ? e.message : String(e);
  status.replaceChildren(document.createTextNode(message + ' '), copyDebugButton(() => read(message)));
}
