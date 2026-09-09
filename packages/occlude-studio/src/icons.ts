/**
 * The studio's icon set: one stroke style, 24-unit grid, drawn in
 * currentColor. `icon()` makes the svg; `iconButton()` is an icon-only
 * control whose label lives in the tooltip and for assistive tech;
 * `withIcon()` puts an icon in front of a text button that keeps its word.
 */

const PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-6h4v6"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>',
  snapshot: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  fork: '<circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/><path d="M6 7.5v2a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-2"/><path d="M12 13.5v3"/>',
  evolve: '<path d="M12 3c3 4 3 8 0 12"/><path d="M12 3c-3 4-3 8 0 12"/><path d="M12 15v6"/><path d="M6 8c2 0 4 1 6 3M18 8c-2 0-4 1-6 3"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
  new: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/>',
  import: '<path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M4 17v3h16v-3"/>',
  download: '<path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M4 17v3h16v-3"/>',
  export: '<path d="M12 14V3"/><path d="M8 7l4-4 4 4"/><path d="M4 17v3h16v-3"/>',
  freeze: '<path d="M12 3v18M3 12h18"/><path d="M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  frame: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 9h16M8 5v14"/>',
  marks: '<circle cx="12" cy="12" r="5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 13v7H4V6h7"/>',
  gallery: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  rename: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  clone: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/><path d="M14 11v6M11 14h6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  back: '<path d="M11 5l-7 7 7 7"/><path d="M4 12h16"/>',
  keep: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  again: '<path d="M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3"/><path d="M6 21v-5h5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  penUp: '<path d="M12 20V9"/><path d="M8 13l4-4 4 4"/><path d="M5 4h14"/>',
  penDown: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 20h14"/>',
  release: '<path d="M8 4h8v7l-2 2H10l-2-2z"/><path d="M12 13v7"/><path d="M4 20h16"/>',
  brush: '<path d="M14 4l6 6-8 8H6v-6z"/><path d="M6 18l-2 2"/>',
  clear: '<path d="M4 7h16"/><path d="M7 7l1 13h8l1-13"/><path d="M10 4h4v3h-4z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  view: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  svg.innerHTML = PATHS[name];
  return svg;
}

/** An icon-only button: the label is the tooltip and the accessible name. */
export function iconButton(name: IconName, label: string, onclick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(name));
  b.onclick = () => void onclick();
  return b;
}

/** Puts an icon in front of a text button's word; the word stays. */
export function withIcon<T extends HTMLElement>(b: T, name: IconName): T {
  b.classList.add('has-icon');
  b.prepend(icon(name));
  return b;
}

/** Change a button's word without losing its icon. */
export function relabel(b: HTMLElement, text: string): void {
  for (const n of [...b.childNodes]) if (!(n instanceof SVGElement)) n.remove();
  b.append(text);
}

/** Swap an icon button's picture and label. */
export function setIcon(b: HTMLElement, name: IconName, label?: string): void {
  b.querySelector('svg.icon')?.replaceWith(icon(name));
  if (label !== undefined) {
    b.title = label;
    b.setAttribute('aria-label', label);
  }
}
