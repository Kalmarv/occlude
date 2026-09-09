/**
 * The Sketches page: the library as lineages. A family is a root sketch
 * and every fork descended from it, drawn as one upward graph — the root
 * chain starts at the bottom, time climbs, a fork splits off the save it
 * was taken from into its own chain, snapshots fan off the save they
 * froze as pictures to the right, and the current render tops each
 * chain. Only saves with a picture are dots; the plain saves between
 * them fold into a hairline with a count that opens on click. Clicking
 * a dot or a picture opens a popover
 * beside it — a larger preview, the details, and open/fork/delete. The
 * server keeps the truth in git; this page only reads it.
 */

import './style.css';
import './wa.js';
import { confirmDialog, notify, promptDialog } from './wa.js';
import { mountShell } from './shell.js';
import { NEW_SKETCH } from './store.js';
import {
  deleteSketchByName, deleteSnapshot, forkSketch, forkSnapshot, listSketchInfo,
  evolveUrl, loadSketchAt, loadSketchByName, loadSnapshot, openInStudio, sketchHistory, snapshotSeed, thumbUrl,
  type Commit, type SketchInfo, type Snapshot,
} from './sketchApi.js';
import { openGallery } from './snapshotGallery.js';
import { mendThumbs, type ThumbTarget } from './thumbMender.js';

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
    void Promise.resolve(fn()).catch((err) => notify(err instanceof Error ? err.message : String(err), 'danger'));
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
const GAP = 8;         // between pictures in a fan
const RUN_H = 30;      // a folded run of plain saves
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

/** Runs of plain saves the user has opened up into dots, keyed by
 * `name:firstSha`. Page state; a refresh keeps it. */
const expandedRuns = new Set<string>();

type Item =
  | { kind: 'commit'; row: Row; c: Commit; time: number; plain: boolean; run?: string }
  | { kind: 'run'; row: Row; key: string; commits: Commit[]; time: number };

function lineage(rows: Row[], pick: (s: Selection, anchor: Element) => void, rerender: () => void): HTMLElement {
  // Only pictures are nodes: a save with a snapshot hanging off it, the
  // head under its current render, the save a fork left from, and the
  // fork's own first save. The plain saves between them fold into a
  // hairline with a count, which opens into dots on demand.
  const anchored = new Map<Row, Map<string, Snapshot[]>>();
  for (const row of rows) {
    const bySha = new Map<string, Snapshot[]>();
    for (const s of row.snapshots) {
      const a = snapshotAnchor(row, s);
      if (a) bySha.set(a.sha, [...(bySha.get(a.sha) ?? []), s]);
    }
    anchored.set(row, bySha);
  }
  const forkOrigins = new Set<string>();
  for (const row of rows) {
    const parent = rows.find((r) => r.info.name === row.info.parent);
    if (!parent || row.commits.length === 0) continue;
    const from = forkPoint(row, parent);
    if (from) forkOrigins.add(from.sha);
  }
  const kept = (row: Row, c: Commit): boolean =>
    c === row.commits[0] || c === row.commits[row.commits.length - 1] ||
    (anchored.get(row)?.get(c.sha)?.length ?? 0) > 0 || forkOrigins.has(c.sha) || /^fork /.test(c.subject);

  // Each chain as a sequence of items, oldest first.
  const items: Item[] = [];
  for (const row of rows) {
    let run: Commit[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const key = `${row.info.name}:${run[0].sha}`;
      if (expandedRuns.has(key)) {
        for (const c of run) items.push({ kind: 'commit', row, c, time: c.time, plain: true, run: key });
      } else {
        items.push({ kind: 'run', row, key, commits: run, time: run[0].time });
      }
      run = [];
    };
    for (const c of row.commits) {
      if (kept(row, c)) { flush(); items.push({ kind: 'commit', row, c, time: c.time, plain: false }); }
      else run.push(c);
    }
    flush();
  }
  // One time axis for the family, y-up, flipped at the end.
  items.sort((a, b) => a.time - b.time || (a.kind === 'commit' ? a.c.sha : a.key).localeCompare(b.kind === 'commit' ? b.c.sha : b.key));
  const yUpOf = new Map<string, number>();
  let cursor = PAD_B;
  for (const it of items) {
    if (it.kind === 'run') { yUpOf.set(it.key, cursor + RUN_H / 2); cursor += RUN_H; continue; }
    const n = anchored.get(it.row)?.get(it.c.sha)?.length ?? 0;
    const isHead = it.row.commits[it.row.commits.length - 1] === it.c;
    // A fanned save sits in the middle of its pictures' height, so the
    // fan never reaches into the neighbours' rows.
    const band = n > 0 ? PIC_H + GAP : ROW;
    yUpOf.set(it.c.sha, cursor + (n > 0 ? band / 2 : 0));
    cursor += band + (isHead ? CUR_H + GAP + LABEL_H : 0);
  }
  const H = cursor + PAD_T;
  const Y = (yUp: number): number => H - yUp;
  // Lanes: each chain is as wide as its widest fan of pictures.
  const laneXs: number[] = [];
  let x = X0;
  for (const row of rows) {
    laneXs.push(x);
    const fan = Math.max(0, ...[...(anchored.get(row)?.values() ?? [])].map((v) => v.length));
    x += Math.max(LANE, STUB + 10 + fan * (PIC_W + GAP) + 40);
  }
  const laneX = (row: Row): number => laneXs[rows.indexOf(row)];
  const W = x + PAD_R;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H }, 'lineage') as SVGSVGElement;

  // Rails: solid between nodes, a hairline through a folded run.
  for (const row of rows) {
    const mine = items.filter((it) => it.row === row);
    const yOf = (it: Item): number => Y(yUpOf.get(it.kind === 'run' ? it.key : it.c.sha)!);
    for (let i = 1; i < mine.length; i++) {
      const a = mine[i - 1], b = mine[i];
      const thin = a.kind === 'run' || b.kind === 'run';
      svg.append(svgEl('line', { x1: laneX(row), x2: laneX(row), y1: yOf(a), y2: yOf(b) }, thin ? 'lineage-rail thin' : 'lineage-rail'));
    }
  }
  // Fork connectors: from the parent's save up and over to the fork's first save.
  for (const row of rows) {
    const parent = rows.find((r) => r.info.name === row.info.parent);
    if (!parent || row.commits.length === 0) continue;
    const from = forkPoint(row, parent);
    if (!from || !yUpOf.has(from.sha)) continue;
    const x1 = laneX(parent), y1 = Y(yUpOf.get(from.sha)!);
    const x2 = laneX(row), y2 = Y(yUpOf.get(row.commits[0].sha)!);
    const my = (y1 + y2) / 2;
    svg.append(svgEl('path', { d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}` }, 'lineage-fork'));
  }
  // Pictures: a fan of snapshots level with their save, and the current
  // render capping each chain above its head.
  const picture = (row: Row, px: number, py: number, w: number, h: number, snap?: Snapshot): void => {
    const g = svgEl('g', {}, 'lineage-pic' + (snap ? '' : ' current'));
    const sel: Selection = snap ? { kind: 'snapshot', row, snapshot: snap } : { kind: 'current', row };
    g.append(svgEl('rect', { x: px, y: py, width: w, height: h, rx: 4 }, 'lineage-paper'));
    g.append(svgEl('image', {
      x: px + 2, y: py + 2, width: w - 4, height: h - 4,
      href: `${thumbUrl(row.info.name, snap?.id)}?t=${Date.now()}`, preserveAspectRatio: 'xMidYMid meet',
    }));
    g.append(svgEl('rect', { x: px, y: py, width: w, height: h, rx: 4 }, 'lineage-frame'));
    const title = svgEl('title', {});
    if (snap) {
      title.textContent = `snapshot · ${snap.meta.label || 'seed ' + (snap.meta.seed ?? '—')} · ${snap.meta.at ? when(Date.parse(snap.meta.at)) : snap.id}`;
      if (snap.meta.label) {
        const cap = svgEl('text', { x: px + 5, y: py + h - 5 }, 'lineage-cap');
        cap.textContent = snap.meta.label;
        g.append(cap);
      }
    } else {
      title.textContent = `${row.info.name} · current`;
    }
    g.addEventListener('click', (e) => { e.stopPropagation(); pick(sel, g); });
    g.append(title);
    svg.append(g);
  };
  const curTop = new Map<Row, { x: number; y: number }>();
  for (const it of items) {
    if (it.kind !== 'commit') continue;
    const nx = laneX(it.row), ny = Y(yUpOf.get(it.c.sha)!);
    const snaps = (anchored.get(it.row)?.get(it.c.sha) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    if (snaps.length) {
      const x0 = nx + STUB + 10;
      const xEnd = x0 + (snaps.length - 1) * (PIC_W + GAP);
      svg.append(svgEl('path', { d: `M ${nx} ${ny} H ${xEnd}` }, 'lineage-stub'));
      snaps.forEach((snap, i) => picture(it.row, x0 + i * (PIC_W + GAP), ny - PIC_H / 2, PIC_W, PIC_H, snap));
    }
    const isHead = it.row.commits[it.row.commits.length - 1] === it.c;
    if (isHead) {
      const lift = snaps.length ? PIC_H / 2 + GAP : 14;
      const bottom = yUpOf.get(it.c.sha)! + lift;
      svg.append(svgEl('path', { d: `M ${nx} ${ny} V ${Y(bottom)}` }, 'lineage-stub current'));
      picture(it.row, nx - CUR_W / 2, Y(bottom + CUR_H), CUR_W, CUR_H);
      curTop.set(it.row, { x: nx - CUR_W / 2, y: Y(bottom + CUR_H + LABEL_H) });
    }
  }
  // Dots on the nodes, and the folded runs' counts.
  for (const it of items) {
    const x = laneX(it.row);
    if (it.kind === 'run') {
      const y = Y(yUpOf.get(it.key)!);
      const g = svgEl('g', {}, 'lineage-run');
      const n = it.commits.length;
      const t = svgEl('text', { x: x + 12, y: y + 4 }, 'lineage-run-label');
      t.textContent = `${n} save${n === 1 ? '' : 's'}`;
      const title = svgEl('title', {});
      title.textContent = `${when(it.commits[0].time)} – ${when(it.commits[n - 1].time)} · click to show each save`;
      g.append(svgEl('rect', { x: x - 10, y: y - RUN_H / 2, width: 90, height: RUN_H }, 'lineage-hit'), t, title);
      g.addEventListener('click', (e) => { e.stopPropagation(); expandedRuns.add(it.key); rerender(); });
      svg.append(g);
      continue;
    }
    const c = it.c, row = it.row;
    const y = Y(yUpOf.get(c.sha)!);
    const head = row.commits[row.commits.length - 1];
    const isFork = /^fork /.test(c.subject);
    const sel: Selection = { kind: 'commit', row, commit: c };
    const g = svgEl('g', {}, 'lineage-commit');
    const title = svgEl('title', {});
    title.textContent = `${c.sha} · ${when(c.time)} · ${c.subject}`;
    g.append(title, svgEl('circle', { cx: x, cy: y, r: 10 }, 'lineage-hit'));
    g.append(svgEl('circle', { cx: x, cy: y, r: c === head ? 5.5 : it.plain ? 2.5 : 4 },
      `lineage-dot${isFork ? ' fork' : ''}${c === head ? ' head' : ''}${it.plain ? ' plain' : ''}`));
    g.addEventListener('click', (e) => { e.stopPropagation(); pick(sel, g); });
    svg.append(g);
    // The first dot of an opened run carries the fold.
    if (it.run && items.find((o) => o.kind === 'commit' && o.run === it.run) === it) {
      const f = svgEl('text', { x: x + 12, y: y + 4 }, 'lineage-run-label');
      f.textContent = 'fold';
      f.addEventListener('click', (e) => { e.stopPropagation(); expandedRuns.delete(it.run!); rerender(); });
      svg.append(f);
    }
  }
  // Labels: name and counts above each chain's current render.
  for (const row of rows) {
    const at = curTop.get(row);
    if (!at) continue;
    const fo = svgEl('foreignObject', { x: at.x, y: at.y, width: LANE - 20, height: LABEL_H });
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
  // Deleting a sketch is the one destructive action here (saves cannot be
  // deleted: git is the history), so it asks for the name to be typed.
  const deleteSketch = btn('delete sketch', async () => {
    closePopover();
    const typed = await promptDialog({
      title: `Delete '${name}'?`,
      body: 'Its saves and snapshots stay in git and can be restored. Type the name to confirm.',
      placeholder: name,
      confirm: 'Delete',
      danger: true,
      validate: (v) => (v.trim() === name ? null : 'The name does not match.'),
    });
    if (typed === null) return;
    await deleteSketchByName(name);
    await refresh();
  });
  deleteSketch.className += ' danger-quiet';
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
        openInStudio(name, source, snapshotSeed(m));
      }, 'Open this frozen source with its seed (saving writes the sketch head)'),
      btn('evolve', () => { location.href = evolveUrl({ name, snap: s.id }, snapshotSeed(s.meta)); },
        'Choose among variations of this drawing: a grid of seeds and draw overrides, kept as snapshots'),
      btn('fork', async () => {
        const made = await forkSnapshot(name, s.id);
        openInStudio(made, await loadSketchByName(made), snapshotSeed(s.meta));
      }, 'A new sketch from this frozen source'),
      btn('delete', async () => {
        closePopover();
        if (!(await confirmDialog({ title: 'Delete this snapshot?', body: `The snapshot of '${name}' and its thumbnail are removed; the save it froze stays.`, confirm: 'Delete', danger: true }))) return;
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
      btn('evolve', () => { location.href = evolveUrl({ name }, null); },
        'Choose among variations of this sketch: a grid of seeds and draw overrides, kept as snapshots'),
      btn('fork', () => forkNow(name), 'A new sketch from the current source'),
    );
    // Only the sketch's own row offers deletion — never a row in its history,
    // where 'delete' reads as 'delete this save' and it is not.
    if (sel.kind === 'current') actions.append(deleteSketch);
    else meta.append(el('div', 'lineage-sub', 'A save cannot be deleted: git keeps every one. Delete the sketch from its own row.'));
  } else {
    const c = sel.commit;
    meta.append(el('div', 'lineage-name', c.subject));
    meta.append(el('div', 'lineage-sub', `${name} @ ${c.sha} · ${when(c.time)}`));
    actions.append(
      btn('open', async () => openInStudio(name, await loadSketchAt(name, c.sha)),
        'Open the source as it was at this save (saving writes the sketch head)'),
      btn('evolve', () => { location.href = evolveUrl({ name, sha: c.sha }, null); },
        'Choose among variations of this version (kept as snapshots of a fork from here)'),
      btn('fork from here', () => forkNow(name, c.sha), 'A new sketch branching from this save'),
    );
  }
  pop.append(meta, actions);
  document.body.append(pop);
  placePopover();
}

const openFamilies = new Set<string>();

const CALIBRATION = /^(settle|cal|lift|down|traverse|pen-width|clearance)/;

interface FamilyFacts {
  evolved: boolean;
  forks: number;
  snaps: number;
  calibration: boolean;
}

function family(root: SketchInfo, all: SketchInfo[], rows: Row[], refresh: () => Promise<void>): HTMLElement {
  const sec = el('article', 'card');
  const ordered = orderRows(root, all, new Map(rows.map((r) => [r.info.name, r])));
  const forks = ordered.length - 1;
  const snaps = ordered.reduce((n, r) => n + r.snapshots.length, 0);
  const saves = ordered.reduce((n, r) => n + r.commits.length, 0);
  const evolved = ordered.some((r) => r.snapshots.some((sn) => sn.meta.overrides && Object.keys(sn.meta.overrides).length > 0));
  const facts: FamilyFacts = { evolved, forks, snaps, calibration: CALIBRATION.test(root.name) };
  (sec as HTMLElement & { facts?: FamilyFacts }).facts = facts;
  sec.dataset.name = ordered.map((r) => r.info.name).join(' ');
  // The entry is the family's most recent render: whichever sketch in it
  // was saved last.
  const latest = ordered.reduce((a, b) => (b.info.mtime > a.info.mtime ? b : a), ordered[0]);
  const thumb = el('div', 'thumb');
  const img = document.createElement('img');
  img.src = `${thumbUrl(latest.info.name)}?t=${Date.now()}`;
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => { img.remove(); thumb.textContent = 'no render yet'; };
  thumb.append(img);
  const body = el('div', 'card-body');
  const head = el('div', 'card-head');
  head.append(el('h3', undefined, root.name));
  const meta = el('div', 'meta');
  meta.append(el('span', undefined, `${saves} save${saves === 1 ? '' : 's'}`));
  if (latest.info.name !== root.name) meta.append(el('span', 'dot', '·'), el('span', undefined, `latest ${latest.info.name}`));
  meta.append(el('span', 'dot', '·'), el('span', undefined, ago(latest.info.mtime)));
  const chips = el('div', 'chips');
  if (evolved) chips.append(el('span', 'chip chip-accent', 'evolved'));
  if (snaps) chips.append(el('span', 'chip', `${snaps} snapshot${snaps === 1 ? '' : 's'}`));
  if (forks) chips.append(el('span', 'chip', `${forks} fork${forks === 1 ? '' : 's'}`));
  if (facts.calibration) chips.append(el('span', 'chip', 'calibration'));
  body.append(head, meta, chips);
  const face = el('div', 'card-face');
  face.append(thumb, body);
  sec.append(face);

  let graph: HTMLElement | null = null;
  const setOpen = (open: boolean): void => {
    if (open) openFamilies.add(root.name); else openFamilies.delete(root.name);
    sec.classList.toggle('open', open);
    closePopover();
    graph?.remove();
    graph = null;
    if (open) {
      graph = el('div', 'card-graph');
      if (snaps > 0) {
        const allSnaps = ordered.flatMap((r) => r.snapshots);
        const gal = document.createElement('wa-button');
        gal.className = 'card-gallery';
        gal.setAttribute('size', 'small');
        gal.setAttribute('appearance', 'outlined');
        gal.textContent = `Gallery · ${snaps}`;
        gal.title = `Flip through this family’s ${snaps} snapshot${snaps === 1 ? '' : 's'}`;
        gal.addEventListener('click', (e) => { e.stopPropagation(); openGallery({ shots: allSnaps, scope: root.name }); });
        graph.append(gal);
      }
      graph.append(lineage(ordered, (sel, anchor) => openPopover(sel, anchor, refresh), () => setOpen(true)));
      sec.append(graph);
    }
  };
  face.onclick = () => setOpen(!openFamilies.has(root.name));
  face.title = 'Show the family’s saves, forks, and snapshots';
  setOpen(openFamilies.has(root.name));
  return sec;
}

// ---- filters and search over the cards ----
let filter = 'all';
let query = '';
function applyFilters(): void {
  let shown = 0;
  for (const card of main.querySelectorAll<HTMLElement & { facts?: FamilyFacts }>('.card')) {
    const f = card.facts ?? { evolved: false, forks: 0, snaps: 0, calibration: false };
    const byFilter = filter === 'all' || (filter === 'evolved' && f.evolved) || (filter === 'forks' && f.forks > 0)
      || (filter === 'snapshots' && f.snaps > 0) || (filter === 'calibration' && f.calibration);
    const byQuery = !query || (card.dataset.name ?? '').toLowerCase().includes(query);
    card.hidden = !(byFilter && byQuery);
    if (!card.hidden) shown += 1;
  }
  const count = document.getElementById('sketches-count');
  const total = main.querySelectorAll('.card').length;
  if (count) count.textContent = shown === total ? `${total} famil${total === 1 ? 'y' : 'ies'}` : `${shown} of ${total} families`;
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
  main.className = 'cards';
  main.replaceChildren(...roots.map((r) => family(r, all, rows, refresh)));
  const sub = document.getElementById('sketches-sub');
  if (sub) sub.textContent = `${all.length} sketch${all.length === 1 ? '' : 'es'} · ${hist.reduce((n, h) => n + h.snapshots.length, 0)} snapshots`;
  applyFilters();
  // Missing thumbnails are regenerated in the background and painted in as
  // they land — snapshots first, newest first, then the sketches' own.
  const targets: ThumbTarget[] = [];
  for (const r of rows) for (const sn of r.snapshots) targets.push({ name: r.info.name, snap: sn.id, meta: sn.meta });
  for (const r of rows) if (!r.info.thumb) targets.push({ name: r.info.name });
  // A card's picture is an <img> that removed itself on 404, so a mended
  // sketch thumbnail needs the page redrawn once the pass is over.
  let cardMended = false;
  void mendThumbs(targets, (t) => { if (!t.snap) cardMended = true; }).then(() => { if (cardMended) void refresh(); });
}

(window as unknown as Record<string, unknown>).__sketches = { refresh };
mountShell('sketches');
document.getElementById('sketches-filter')?.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-filter]') as HTMLButtonElement | null;
  if (!b) return;
  filter = b.dataset.filter ?? 'all';
  for (const o of b.parentElement!.querySelectorAll('button')) o.classList.toggle('on', o === b);
  applyFilters();
});
document.getElementById('sketches-search')?.addEventListener('input', (e) => {
  query = ((e.target as HTMLInputElement).value ?? '').trim().toLowerCase();
  applyFilters();
});
document.getElementById('sketches-new')?.addEventListener('click', () => openInStudio('', NEW_SKETCH));
void refresh();
