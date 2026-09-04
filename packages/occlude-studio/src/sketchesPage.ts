/**
 * The Sketches page: the library as lineages. A family is a root sketch
 * and every fork descended from it, drawn as one upward graph — the root
 * chain starts at the bottom, every save is a dot, time climbs, a fork
 * splits off the save it was taken from into its own chain, a snapshot
 * hangs off the save it froze as a picture to the right, and the current
 * render tops each chain. Clicking a dot or a picture opens a popover
 * beside it — a larger preview, the details, and open/fork/delete. The
 * server keeps the truth in git; this page only reads it.
 */

import './style.css';
import {
  deleteSketchByName, deleteSnapshot, forkSketch, forkSnapshot, listSketchInfo,
  loadSketchAt, loadSketchByName, loadSnapshot, openInStudio, sketchHistory, thumbUrl,
  type Commit, type SketchInfo, type Snapshot,
} from './sketchApi.js';
import { openGallery } from './snapshotGallery.js';

const main = document.getElementById('sketches-families')!;
const NS = 'http://www.w3.org/2000/svg';

function ago(mtime: number): string {
  const s = (Date.now() - mtime) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const when = (t: number): string => {
  const d = new Date(t);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

const btn = (label: string, fn: () => void | Promise<void>, title?: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    void Promise.resolve(fn()).catch((err) => alert(err instanceof Error ? err.message : String(err)));
  };
  return b;
};

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const svgEl = (tag: string, attrs: Record<string, string | number>, cls?: string): SVGElement => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  return e;
};

async function forkNow(name: string, ref?: string): Promise<void> {
  const made = await forkSketch(name, undefined, ref);
  openInStudio(made, await loadSketchByName(made));
}

// ---- the lineage graph ----

interface Row {
  info: SketchInfo;
  depth: number;
  commits: Commit[];     // oldest first
  snapshots: Snapshot[];
}

type Selection =
  | { kind: 'commit'; row: Row; commit: Commit }
  | { kind: 'snapshot'; row: Row; snapshot: Snapshot }
  | { kind: 'current'; row: Row };

const ROW = 26;        // one save
const LANE = 210;      // chain pitch: the chain plus the gutter its pictures hang in
const X0 = 80;         // first chain's x (room for its current render to its left)
const STUB = 16;       // node → picture elbow
const PIC_W = 110, PIC_H = 76;      // snapshot picture
const CUR_W = 130, CUR_H = 90;      // current render, centred above the chain
const LABEL_H = 54;
const GAP = 8;         // between stacked pictures
const PAD_T = 12, PAD_B = 18, PAD_R = 24;

/** Root first, then each fork under its parent (oldest fork first). */
function orderRows(root: SketchInfo, all: SketchInfo[], byName: Map<string, Row>): Row[] {
  const out: Row[] = [];
  const walk = (info: SketchInfo, depth: number): void => {
    const row = byName.get(info.name);
    if (!row) return;
    row.depth = depth;
    out.push(row);
    const kids = all
      .filter((s) => s.parent === info.name)
      .sort((a, b) => (byName.get(a.name)?.commits[0]?.time ?? 0) - (byName.get(b.name)?.commits[0]?.time ?? 0));
    for (const k of kids) walk(k, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Where a fork's chain leaves its parent: the parent's save named by the
 * fork header, else the parent's last save before the fork. */
function forkPoint(row: Row, parent: Row): Commit | undefined {
  const ref = row.info.forkRef ?? '';
  const snapId = ref.match(/^snapshot (\S+)$/)?.[1];
  const sha = snapId
    ? parent.snapshots.find((s) => s.id === snapId)?.sha
    : parent.commits.find((c) => ref.startsWith(c.sha) || c.sha.startsWith(ref))?.sha;
  const hit = sha && parent.commits.find((c) => c.sha === sha);
  if (hit) return hit;
  const t0 = row.commits[0]?.time ?? Infinity;
  return [...parent.commits].reverse().find((c) => c.time <= t0) ?? parent.commits[0];
}

/** The save a snapshot hangs off: the tagged commit when it is on this
 * chain, else the last save at or before the snapshot's time (an
 * untouched sketch snapshotted for its seed tags another file's commit). */
function snapshotAnchor(row: Row, s: Snapshot): Commit | undefined {
  const own = row.commits.find((c) => c.sha === s.sha);
  if (own) return own;
  const at = s.meta.at ? Date.parse(s.meta.at) : Infinity;
  return [...row.commits].reverse().find((c) => c.time <= at) ?? row.commits[row.commits.length - 1];
}

function lineage(rows: Row[], pick: (s: Selection, anchor: Element) => void): HTMLElement {
  // One time axis for the family: every save of every member, oldest at
  // the bottom. Coordinates are computed y-up and flipped at the end.
  const all = rows.flatMap((r) => r.commits.map((c) => ({ row: r, c })));
  all.sort((a, b) => a.c.time - b.c.time || a.c.sha.localeCompare(b.c.sha));
  const laneX = (row: Row): number => X0 + rows.indexOf(row) * LANE;
  // Which save each snapshot hangs off, per chain.
  const anchored = new Map<Row, Map<string, Snapshot[]>>();
  for (const row of rows) {
    const bySha = new Map<string, Snapshot[]>();
    for (const s of row.snapshots) {
      const a = snapshotAnchor(row, s);
      if (a) bySha.set(a.sha, [...(bySha.get(a.sha) ?? []), s]);
    }
    anchored.set(row, bySha);
  }
  // A save's row is as tall as the pictures hanging off it, so pictures
  // sit level with their save instead of piling up the gutter.
  const yUpOf = new Map<string, number>();
  let cursor = PAD_B;
  for (const e of all) {
    yUpOf.set(e.c.sha, cursor);
    const n = anchored.get(e.row)?.get(e.c.sha)?.length ?? 0;
    const isHead = e.row.commits[e.row.commits.length - 1] === e.c;
    cursor += Math.max(ROW, n * (PIC_H + GAP) + (isHead ? CUR_H + GAP + LABEL_H : 0));
  }

  interface Pic { row: Row; x: number; bottom: number; w: number; h: number; node: Commit; snap?: Snapshot }
  const pics: Pic[] = [];
  let top = 0;
  for (const row of rows) {
    if (row.commits.length === 0) continue;
    // Pictures stack up the lane's gutter: each sits level with its save
    // unless the one below is in the way, then it rides above it.
    let ceiling = -Infinity;
    const place = (node: Commit, w: number, h: number, snap?: Snapshot): void => {
      // Snapshots hang level with their save in the gutter; the current
      // render caps the chain, centred above the last save and clear of
      // any fork curving off it.
      const bottom = snap
        ? Math.max(yUpOf.get(node.sha)! - h / 2, ceiling + GAP)
        : Math.max(yUpOf.get(node.sha)! + 14, ceiling + GAP);
      ceiling = bottom + h;
      pics.push({ row, x: snap ? laneX(row) + STUB + 10 : laneX(row) - w / 2, bottom, w, h, node, snap });
    };
    const bySha = anchored.get(row)!;
    for (const c of row.commits) {
      const snaps = (bySha.get(c.sha) ?? []).sort((a, b) => a.id.localeCompare(b.id));
      for (const s of snaps) place(c, PIC_W, PIC_H, s);
    }
    const head = row.commits[row.commits.length - 1];
    place(head, CUR_W, CUR_H);
    top = Math.max(top, ceiling + LABEL_H);
  }
  const H = top + PAD_T;
  const W = X0 + rows.length * LANE + PAD_R;
  const Y = (yUp: number): number => H - yUp;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H }, 'lineage') as SVGSVGElement;

  // Chains.
  for (const row of rows) {
    if (row.commits.length === 0) continue;
    const x = laneX(row);
    const y1 = Y(yUpOf.get(row.commits[0].sha)!), y2 = Y(yUpOf.get(row.commits[row.commits.length - 1].sha)!);
    svg.append(svgEl('line', { x1: x, x2: x, y1, y2 }, 'lineage-rail'));
  }
  // Fork connectors: from the parent's save up and over to the fork's first save.
  for (const row of rows) {
    const parent = rows.find((r) => r.info.name === row.info.parent);
    if (!parent || row.commits.length === 0) continue;
    const from = forkPoint(row, parent);
    if (!from) continue;
    const x1 = laneX(parent), y1 = Y(yUpOf.get(from.sha)!);
    const x2 = laneX(row), y2 = Y(yUpOf.get(row.commits[0].sha)!);
    const my = (y1 + y2) / 2;
    svg.append(svgEl('path', { d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}` }, 'lineage-fork'));
  }
  // Pictures with their elbows.
  for (const p of pics) {
    const nx = laneX(p.row), ny = Y(yUpOf.get(p.node.sha)!);
    const py = Y(p.bottom + p.h / 2);
    svg.append(p.snap
      ? svgEl('path', { d: `M ${nx} ${ny} H ${nx + STUB / 2} V ${py} H ${p.x}` }, 'lineage-stub')
      : svgEl('path', { d: `M ${nx} ${ny} V ${Y(p.bottom)}` }, 'lineage-stub current'));
    const g = svgEl('g', {}, 'lineage-pic' + (p.snap ? '' : ' current'));
    const sel: Selection = p.snap ? { kind: 'snapshot', row: p.row, snapshot: p.snap } : { kind: 'current', row: p.row };
    g.append(svgEl('rect', { x: p.x, y: Y(p.bottom + p.h), width: p.w, height: p.h, rx: 3 }, 'lineage-paper'));
    const img = svgEl('image', {
      x: p.x + 2, y: Y(p.bottom + p.h) + 2, width: p.w - 4, height: p.h - 4,
      href: `${thumbUrl(p.row.info.name, p.snap?.id)}?t=${Date.now()}`, preserveAspectRatio: 'xMidYMid meet',
    });
    g.append(img);
    g.append(svgEl('rect', { x: p.x, y: Y(p.bottom + p.h), width: p.w, height: p.h, rx: 3 }, 'lineage-frame'));
    const title = svgEl('title', {});
    if (p.snap) {
      const s = p.snap;
      title.textContent = `snapshot · ${s.meta.label || 'seed ' + (s.meta.seed ?? '—')} · ${s.meta.at ? when(Date.parse(s.meta.at)) : s.id}`;
      if (s.meta.label) {
        const cap = svgEl('text', { x: p.x + 5, y: Y(p.bottom) - 5 }, 'lineage-cap');
        cap.textContent = s.meta.label;
        g.append(cap);
      }
    } else {
      title.textContent = `${p.row.info.name} · current`;
    }
    g.addEventListener('click', (e) => { e.stopPropagation(); pick(sel, g); });
    g.append(title);
    svg.append(g);
  }
  // Dots on top of everything.
  for (const row of rows) {
    const x = laneX(row);
    const head = row.commits[row.commits.length - 1];
    for (const c of row.commits) {
      const y = Y(yUpOf.get(c.sha)!);
      const isFork = /^fork /.test(c.subject);
      const sel: Selection = { kind: 'commit', row, commit: c };
      const g = svgEl('g', {}, 'lineage-commit');
      const title = svgEl('title', {});
      title.textContent = `${c.sha} · ${when(c.time)} · ${c.subject}`;
      g.append(title, svgEl('circle', { cx: x, cy: y, r: 10 }, 'lineage-hit'));
      g.append(svgEl('circle', { cx: x, cy: y, r: c === head ? 5.5 : 3.5 },
        `lineage-dot${isFork ? ' fork' : ''}${c === head ? ' head' : ''}`));
      g.addEventListener('click', (e) => { e.stopPropagation(); pick(sel, g); });
      svg.append(g);
    }
  }
  // Labels: name, counts, and actions above each chain's current render.
  for (const row of rows) {
    const cur = pics.find((p) => p.row === row && !p.snap);
    if (!cur) continue;
    const fo = svgEl('foreignObject', { x: cur.x, y: Y(cur.bottom + cur.h + LABEL_H), width: LANE - 20, height: LABEL_H });
    const box = el('div', 'lineage-label');
    box.append(el('div', 'lineage-name', row.info.name));
    const n = row.commits.length, k = row.snapshots.length;
    box.append(el('div', 'lineage-sub', `${ago(row.info.mtime)} · ${n} save${n === 1 ? '' : 's'}` +
      (k ? ` · ${k} snapshot${k === 1 ? '' : 's'}` : '')));
    fo.append(box);
    svg.append(fo);
  }
  const wrap = el('div', 'lineage-scroll');
  wrap.append(svg);
  return wrap;
}

// ---- the popover: preview, details, and actions beside what was clicked ----

const POP_W = 360;
let pop: HTMLElement | null = null;
let popAnchor: Element | null = null;

function closePopover(): void {
  pop?.remove();
  pop = null;
  popAnchor?.classList.remove('selected');
  popAnchor = null;
}

function placePopover(): void {
  if (!pop || !popAnchor) return;
  const r = popAnchor.getBoundingClientRect();
  const h = pop.offsetHeight;
  let left = r.right + 12;
  if (left + POP_W > window.innerWidth - 8) left = Math.max(8, r.left - 12 - POP_W);
  const top = Math.min(Math.max(8, r.top - 8), Math.max(8, window.innerHeight - h - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

document.addEventListener('click', (e) => {
  if (pop && !pop.contains(e.target as Node)) closePopover();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
window.addEventListener('resize', placePopover);
window.addEventListener('scroll', placePopover, true);

function openPopover(sel: Selection, anchor: Element, refresh: () => Promise<void>): void {
  const same = popAnchor === anchor;
  closePopover();
  if (same) return;
  popAnchor = anchor;
  anchor.classList.add('selected');
  pop = el('div', 'lineage-pop');
  pop.addEventListener('click', (e) => e.stopPropagation());
  const name = sel.row.info.name;
  const head = sel.row.commits[sel.row.commits.length - 1];
  const preview = (url: string): void => {
    const box = el('div', 'lineage-pop-pic');
    const img = document.createElement('img');
    img.src = `${url}?t=${Date.now()}`;
    img.alt = '';
    img.onerror = () => { img.remove(); box.textContent = 'no render yet'; };
    box.append(img);
    pop!.append(box);
  };
  const meta = el('div', 'lineage-row-meta');
  const actions = el('div', 'lineage-actions');
  const deleteSketch = btn('delete sketch', async () => {
    if (!confirm(`Delete sketch '${name}' from the library? (git keeps its saves)`)) return;
    closePopover();
    await deleteSketchByName(name);
    await refresh();
  });
  if (sel.kind === 'snapshot') {
    const s = sel.snapshot;
    preview(thumbUrl(name, s.id));
    meta.append(el('div', 'lineage-name', `snapshot · ${s.meta.label || `seed ${s.meta.seed ?? '—'}`}`));
    meta.append(el('div', 'lineage-sub', `on ${name} @ ${s.sha}` +
      (s.meta.label && s.meta.seed != null ? ` · seed ${s.meta.seed}` : '') +
      (s.meta.at ? ` · ${when(Date.parse(s.meta.at))}` : '')));
    actions.append(
      btn('gallery', () => {
        closePopover();
        openGallery({ shots: sel.row.snapshots, index: sel.row.snapshots.indexOf(s), scope: name });
      }, 'Flip through this sketch’s snapshots, starting here'),
      btn('open', async () => {
        const { source, meta: m } = await loadSnapshot(name, s.id);
        openInStudio(name, source, m.seed);
      }, 'Open this frozen source with its seed (saving writes the sketch head)'),
      btn('fork', async () => {
        const made = await forkSnapshot(name, s.id);
        openInStudio(made, await loadSketchByName(made), s.meta.seed);
      }, 'A new sketch from this frozen source'),
      btn('delete', async () => {
        if (!confirm(`Delete this snapshot of '${name}'?`)) return;
        closePopover();
        await deleteSnapshot(name, s.id);
        await refresh();
      }),
    );
  } else if (sel.kind === 'current' || (sel.kind === 'commit' && sel.commit === head)) {
    preview(thumbUrl(name));
    meta.append(el('div', 'lineage-name', `${name} · current`));
    meta.append(el('div', 'lineage-sub', `${head ? `@ ${head.sha} · ${when(head.time)}` : ''}`));
    actions.append(
      btn('open', async () => openInStudio(name, await loadSketchByName(name)), 'Open the sketch in the studio'),
      btn('fork', () => forkNow(name), 'A new sketch from the current source'),
      deleteSketch,
    );
  } else {
    const c = sel.commit;
    meta.append(el('div', 'lineage-name', c.subject));
    meta.append(el('div', 'lineage-sub', `${name} @ ${c.sha} · ${when(c.time)}`));
    actions.append(
      btn('open', async () => openInStudio(name, await loadSketchAt(name, c.sha)),
        'Open the source as it was at this save (saving writes the sketch head)'),
      btn('fork from here', () => forkNow(name, c.sha), 'A new sketch branching from this save'),
    );
  }
  pop.append(meta, actions);
  document.body.append(pop);
  placePopover();
}

const openFamilies = new Set<string>();

function family(root: SketchInfo, all: SketchInfo[], rows: Row[], refresh: () => Promise<void>): HTMLElement {
  const sec = el('section', 'lineage-family');
  const ordered = orderRows(root, all, new Map(rows.map((r) => [r.info.name, r])));
  const forks = ordered.length - 1;
  const snaps = ordered.reduce((n, r) => n + r.snapshots.length, 0);
  const saves = ordered.reduce((n, r) => n + r.commits.length, 0);
  const counts =
    `${saves} save${saves === 1 ? '' : 's'}` +
    (forks ? ` · ${forks} fork${forks === 1 ? '' : 's'}` : '') +
    (snaps ? ` · ${snaps} snapshot${snaps === 1 ? '' : 's'}` : '');
  // The entry is the family's most recent render: whichever sketch in it
  // was saved last.
  const latest = ordered.reduce((a, b) => (b.info.mtime > a.info.mtime ? b : a), ordered[0]);
  const pic = el('div', 'lineage-entry');
  const img = document.createElement('img');
  img.src = `${thumbUrl(latest.info.name)}?t=${Date.now()}`;
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => { img.remove(); pic.classList.add('empty'); pic.textContent = 'no render yet'; };
  pic.append(img);
  const head = el('div', 'lineage-head');
  const text = el('div', 'lineage-row-meta');
  text.append(el('h3', undefined, root.name), el('span', 'lineage-sub',
    counts + (latest.info.name !== root.name ? ` · latest: ${latest.info.name}` : '') + ` · ${ago(latest.info.mtime)}`));
  head.append(pic, text);
  if (snaps > 0) {
    // Flipping through the family's frozen renders, largest the window
    // allows — the lineage graph shows where they came from, not which one
    // to print.
    const all = ordered.flatMap((r) => r.snapshots);
    head.append(btn('gallery', () => openGallery({ shots: all, scope: root.name }),
      `Flip through this family’s ${snaps} snapshot${snaps === 1 ? '' : 's'}`));
  }
  sec.append(head);

  let graph: HTMLElement | null = null;
  const setOpen = (open: boolean): void => {
    if (open) openFamilies.add(root.name); else openFamilies.delete(root.name);
    sec.classList.toggle('open', open);
    closePopover();
    graph?.remove();
    graph = open ? lineage(ordered, (sel, anchor) => openPopover(sel, anchor, refresh)) : null;
    if (graph) sec.append(graph);
  };
  head.onclick = () => setOpen(!openFamilies.has(root.name));
  head.title = 'Show the family’s saves, forks, and snapshots';
  setOpen(openFamilies.has(root.name));
  return sec;
}

async function refresh(): Promise<void> {
  closePopover();
  let all: SketchInfo[];
  try {
    all = await listSketchInfo();
  } catch {
    main.textContent = 'sketch library unavailable';
    return;
  }
  if (all.length === 0) {
    main.replaceChildren(el('p', 'assets-hint', 'No saved sketches yet — name one in the studio and press Save.'));
    return;
  }
  const hist = await Promise.all(all.map((info) => sketchHistory(info.name).catch(() => ({ commits: [], snapshots: [] }))));
  const rows: Row[] = all.map((info, i) => ({
    info, depth: 0,
    commits: [...hist[i].commits].reverse(),
    snapshots: hist[i].snapshots,
  }));
  const roots = all.filter((s) => s.parent === null || !all.some((p) => p.name === s.parent));
  roots.sort((a, b) => b.mtime - a.mtime);
  main.className = 'lineage-grid';
  main.replaceChildren(...roots.map((r) => family(r, all, rows, refresh)));
}

(window as unknown as Record<string, unknown>).__sketches = { refresh };
void refresh();
