/**
 * The Sketches page: the library as cards — root sketches on top, and a
 * card opens into its forks (a tree, since forks can fork), its snapshots
 * (frozen source + seed), and its git history drawn as a rail. The
 * server keeps the truth in git; this page only reads it and hands
 * sources to the studio.
 */

import './style.css';
import {
  deleteSketchByName, deleteSnapshot, forkSketch, forkSnapshot, listSketchInfo, listSnapshots,
  loadSketchByName, loadSnapshot, openInStudio, sketchHistory, thumbUrl,
  type Commit, type SketchInfo, type Snapshot,
} from './sketchApi.js';

const grid = document.getElementById('sketches-grid')!;
const openCards = new Set<string>();

function ago(mtime: number): string {
  const s = (Date.now() - mtime) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

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

function thumb(url: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'asset-thumb sketch-thumb';
  const img = document.createElement('img');
  img.src = `${url}?t=${Date.now()}`;
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => {
    img.remove();
    el.textContent = 'no thumbnail yet — save in the studio';
  };
  el.append(img);
  return el;
}

async function fork(name: string): Promise<void> {
  const to = prompt(`Fork '${name}' as:`, `${name}-2`)?.trim();
  if (!to) return;
  const made = await forkSketch(name, to);
  openInStudio(made, await loadSketchByName(made));
}

function snapshotCard(s: Snapshot, refresh: () => Promise<void>): HTMLElement {
  const card = document.createElement('div');
  card.className = 'asset-card snap-card';
  const snapThumb = thumb(thumbUrl(s.name, s.id));
  snapThumb.title = 'Open this snapshot in the studio';
  snapThumb.onclick = async (e) => {
    e.stopPropagation();
    const { source, meta: m } = await loadSnapshot(s.name, s.id);
    openInStudio(s.name, source, m.seed);
  };
  card.append(snapThumb);
  const meta = document.createElement('div');
  meta.className = 'asset-meta';
  const nm = document.createElement('div');
  nm.className = 'asset-name';
  nm.textContent = s.meta.label || `seed ${s.meta.seed ?? '—'}`;
  const sub = document.createElement('div');
  sub.className = 'asset-size';
  const when = s.meta.at ? ago(Date.parse(s.meta.at)) : s.id;
  sub.textContent = `${when} · ${s.sha}`;
  meta.append(nm, sub);
  const actions = document.createElement('div');
  actions.className = 'asset-actions';
  actions.append(
    btn('open', async () => {
      const { source, meta: m } = await loadSnapshot(s.name, s.id);
      openInStudio(s.name, source, m.seed);
    }, 'Open this source with its seed (saving writes the sketch head)'),
    btn('fork', async () => {
      const to = prompt(`Fork snapshot of '${s.name}' as:`, `${s.name}-${(s.meta.label || s.id).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 20)}`)?.trim();
      if (!to) return;
      const made = await forkSnapshot(s.name, s.id, to);
      openInStudio(made, await loadSketchByName(made), s.meta.seed);
    }, 'A new sketch from this frozen source'),
    btn('delete', async () => {
      if (!confirm(`Delete this snapshot of '${s.name}'?`)) return;
      await deleteSnapshot(s.name, s.id);
      await refresh();
    }),
  );
  card.append(meta, actions);
  return card;
}

/** The git rail: commits as a vertical line of dots, newest on top, with
 * snapshot markers and fork-off points labelled beside them. */
function historyRail(commits: Commit[], snaps: Snapshot[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const rowH = 22;
  const svg = document.createElementNS(ns, 'svg');
  const h = Math.max(1, commits.length) * rowH + 10;
  svg.setAttribute('viewBox', `0 0 420 ${h}`);
  svg.setAttribute('class', 'git-rail');
  svg.style.height = `${h}px`;
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', '14'); line.setAttribute('x2', '14');
  line.setAttribute('y1', '10'); line.setAttribute('y2', String(h - 10));
  line.setAttribute('class', 'git-line');
  svg.append(line);
  const bySha = new Map<string, Snapshot[]>();
  for (const s of snaps) bySha.set(s.sha, [...(bySha.get(s.sha) ?? []), s]);
  commits.forEach((c, i) => {
    const y = 10 + i * rowH;
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', '14'); dot.setAttribute('cy', String(y)); dot.setAttribute('r', '4');
    const isFork = /^fork /.test(c.subject);
    dot.setAttribute('class', isFork ? 'git-dot fork' : 'git-dot');
    svg.append(dot);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '28'); label.setAttribute('y', String(y + 4));
    label.setAttribute('class', 'git-text');
    const d = new Date(c.time);
    label.textContent = `${c.sha}  ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ${c.subject}`;
    svg.append(label);
    const tagged = bySha.get(c.sha) ?? [];
    tagged.forEach((s, k) => {
      const tx = 300 + k * 8;
      const mark = document.createElementNS(ns, 'path');
      mark.setAttribute('d', `M ${tx} ${y - 5} l 6 5 l -6 5 z`);
      mark.setAttribute('class', 'git-snap');
      const t = document.createElementNS(ns, 'title');
      t.textContent = `snapshot ${s.meta.label || s.id} · seed ${s.meta.seed ?? '—'}`;
      mark.append(t);
      svg.append(mark);
    });
  });
  return svg;
}

function sketchCard(info: SketchInfo, all: SketchInfo[], refresh: () => Promise<void>): HTMLElement {
  const card = document.createElement('div');
  card.className = 'asset-card sketch-card';
  card.dataset.name = info.name;
  card.append(thumb(thumbUrl(info.name)));
  const meta = document.createElement('div');
  meta.className = 'asset-meta';
  const nm = document.createElement('div');
  nm.className = 'asset-name';
  nm.textContent = info.name;
  const forks = all.filter((s) => s.parent === info.name);
  const sub = document.createElement('div');
  sub.className = 'asset-size';
  sub.textContent =
    `${ago(info.mtime)}` +
    (forks.length ? ` · ${forks.length} fork${forks.length === 1 ? '' : 's'}` : '') +
    (info.snapshots ? ` · ${info.snapshots} snapshot${info.snapshots === 1 ? '' : 's'}` : '') +
    (info.parent ? ` · fork of ${info.parent}` : '');
  meta.append(nm, sub);
  const actions = document.createElement('div');
  actions.className = 'asset-actions';
  actions.append(
    btn('open', async () => openInStudio(info.name, await loadSketchByName(info.name))),
    btn('fork', () => fork(info.name)),
    btn('delete', async () => {
      if (!confirm(`Delete sketch '${info.name}' from the library? (git keeps its history)`)) return;
      await deleteSketchByName(info.name);
      await refresh();
    }),
  );
  card.append(meta, actions);

  // Expand: forks (as cards, recursively), snapshots, history.
  const detail = document.createElement('div');
  detail.className = 'sketch-detail';
  detail.hidden = !openCards.has(info.name);
  card.append(detail);
  const fill = async (): Promise<void> => {
    detail.replaceChildren();
    if (forks.length) {
      const h = document.createElement('h4');
      h.textContent = 'forks';
      const g = document.createElement('div');
      g.className = 'assets-grid sketch-children';
      for (const f of forks) g.append(sketchCard(f, all, refresh));
      detail.append(h, g);
    }
    const [snaps, hist] = await Promise.all([listSnapshots(info.name), sketchHistory(info.name)]);
    if (snaps.length) {
      const h = document.createElement('h4');
      h.textContent = 'snapshots';
      const g = document.createElement('div');
      g.className = 'assets-grid sketch-children';
      for (const s of snaps) g.append(snapshotCard(s, refresh));
      detail.append(h, g);
    }
    if (hist.commits.length) {
      const h = document.createElement('h4');
      h.textContent = 'history';
      const wrap = document.createElement('div');
      wrap.className = 'git-rail-wrap';
      wrap.append(historyRail(hist.commits, hist.snapshots));
      detail.append(h, wrap);
    }
  };
  if (!detail.hidden) void fill();
  // The thumbnail is the sketch: click it to open in the studio. The strip
  // below (name, meta, actions) toggles the forks/snapshots/history.
  const thumbEl = card.querySelector('.sketch-thumb') as HTMLElement;
  thumbEl.title = `Open '${info.name}' in the studio`;
  thumbEl.onclick = async (e) => {
    e.stopPropagation();
    openInStudio(info.name, await loadSketchByName(info.name));
  };
  card.onclick = (e) => {
    if ((e.target as HTMLElement).closest('.sketch-detail, button')) return;
    detail.hidden = !detail.hidden;
    if (detail.hidden) openCards.delete(info.name);
    else {
      openCards.add(info.name);
      void fill();
    }
    card.classList.toggle('expanded', !detail.hidden);
  };
  card.classList.toggle('expanded', !detail.hidden);
  return card;
}

async function refresh(): Promise<void> {
  let all: SketchInfo[];
  try {
    all = await listSketchInfo();
  } catch {
    grid.textContent = 'sketch library unavailable';
    return;
  }
  grid.replaceChildren();
  const roots = all.filter((s) => s.parent === null || !all.some((p) => p.name === s.parent));
  if (roots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'assets-hint';
    empty.textContent = 'No saved sketches yet — name one in the studio and press Save.';
    grid.append(empty);
    return;
  }
  for (const s of roots) grid.append(sketchCard(s, all, refresh));
}

(window as unknown as Record<string, unknown>).__sketches = { refresh };
void refresh();
