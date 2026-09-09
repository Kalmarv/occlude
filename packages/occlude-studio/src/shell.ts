/**
 * The page shell: a sidebar naming the studio's pages, the one that is
 * open lit, and a footer line. The studio itself (the editor and preview)
 * keeps its sparse top bar; every page-type screen mounts this.
 */
export type PageKey = 'studio' | 'sketches' | 'fills' | 'assets' | 'machine' | 'results' | 'docs' | 'evolve';

const ICONS: Record<PageKey, string> = {
  studio: '<path d="M4 5h16v14H4z"/><path d="M8 19v-4M16 19v-4"/>',
  sketches: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18"/>',
  fills: '<path d="M4 20l16-16M4 12l8 8M12 4l8 8"/>',
  assets: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 16l-5-5-8 8"/>',
  machine: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 18v2M17 18v2M12 6V3"/>',
  results: '<path d="M4 19V5M4 19h16"/><path d="M8 15l4-6 4 3 4-7"/>',
  docs: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 12h6M9 16h6"/>',
  evolve: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3"/>',
};

const PAGES: { key: PageKey; label: string; href: string }[] = [
  { key: 'studio', label: 'Studio', href: '/' },
  { key: 'sketches', label: 'Sketches', href: '/sketches.html' },
  { key: 'fills', label: 'Fills', href: '/fills.html' },
  { key: 'assets', label: 'Assets', href: '/assets.html' },
  { key: 'machine', label: 'Machine', href: '/machine.html' },
  { key: 'results', label: 'Results', href: '/results.html' },
  { key: 'docs', label: 'Docs', href: '/docs.html' },
];

export function icon(key: PageKey): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[key];
  return svg;
}

/** Mount the sidebar into `#side` (created if the page lacks it). */
export function mountShell(active: PageKey, footer?: string): void {
  let side = document.getElementById('side');
  if (!side) {
    side = document.createElement('aside');
    side.id = 'side';
    document.body.prepend(side);
  }
  side.className = 'side';
  side.replaceChildren();
  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = 'o';
  brand.append(mark, 'occlude');
  const nav = document.createElement('nav');
  nav.className = 'nav';
  for (const p of PAGES) {
    const a = document.createElement('a');
    a.href = p.href;
    a.className = p.key === active ? 'on' : '';
    a.append(icon(p.key), p.label);
    nav.append(a);
    if (p.key === 'assets') nav.append(Object.assign(document.createElement('div'), { className: 'sep' }));
  }
  side.append(brand, nav);
  if (footer) {
    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.textContent = footer;
    side.append(foot);
  }
}
