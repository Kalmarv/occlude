/**
 * The Results page: every saved result as a card — the frozen SVG, what
 * it is (sketch, seed, chains, ETA, build), and open / download / delete.
 * Opening loads the saved plan bytes into the studio frozen: the source is
 * never executed there.
 */

import './style.css';
import { deleteResult, listResults, resultSvgUrl, type SavedResult } from './resultsApi.js';
import { mountShell } from './shell.js';
mountShell('results');

const main = document.getElementById('results-list')!;

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const btn = (label: string, fn: () => void | Promise<void>, title?: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
  b.onclick = () => void Promise.resolve(fn()).catch((err) => alert(err instanceof Error ? err.message : String(err)));
  return b;
};
const fmtMin = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.ceil(ms / 1000)} s`);

function card(r: SavedResult): HTMLElement {
  const c = el('div', 'result-card');
  c.id = r.id;
  const img = document.createElement('img');
  img.className = 'result-svg';
  img.src = resultSvgUrl(r.id);
  img.alt = `saved result ${r.id}`;
  img.loading = 'lazy';
  const title = el('div', 'result-title', `${r.provenance?.sketch ?? 'untitled'} · ${r.selection.count} chains`);
  const req = r.request as { kind?: string; budgetMs?: number | null } | undefined;
  const meta = el('div', 'result-meta');
  meta.textContent = [
    `chains ${r.selection.from}–${r.selection.to} of the plan${req?.kind ? ` (${req.kind}${req.budgetMs ? `, budget ${fmtMin(req.budgetMs)}` : ''})` : ''}`,
    `ETA ${fmtMin(r.eta.standaloneMs)} of ${fmtMin(r.eta.fullMs)}`,
    `seed ${r.provenance?.seed ?? '—'}`,
    `${r.paper.w}×${r.paper.h} mm, ${r.pens.map((p) => p.name).join(', ')}`,
    r.profile ? `profile ${r.profile.name}` : 'no machine profile',
    `saved ${r.savedAt.slice(0, 16).replace('T', ' ')} · build ${r.build}`,
    `plan ${r.planHash.slice(0, 12)}… from ${r.sourcePlanHash.slice(0, 12)}…`,
  ].join(' · ');
  const actions = el('div', 'row');
  actions.append(
    btn('Open frozen in studio', () => { location.href = `/?result=${encodeURIComponent(r.id)}`; }, 'Show, export and plot this exact result — the source is not run'),
    btn('SVG', () => { const a = document.createElement('a'); a.href = resultSvgUrl(r.id); a.download = `occlude-${r.id}.svg`; a.click(); }),
    btn('Delete', async () => {
      if (!confirm(`Delete saved result ${r.id}? This is the only copy of its resolved ink.`)) return;
      await deleteResult(r.id);
      c.remove();
    }),
  );
  c.append(img, title, meta, actions);
  return c;
}

async function render(): Promise<void> {
  main.innerHTML = '';
  const results = await listResults();
  if (results.length === 0) {
    main.append(el('p', 'assets-hint', 'No saved results yet — choose a range in the studio\'s Drawing panel and press Save result.'));
    return;
  }
  for (const r of results) main.append(card(r));
  const want = location.hash.slice(1);
  if (want) document.getElementById(want)?.scrollIntoView();
}

void render().catch((err) => {
  main.textContent = err instanceof Error ? err.message : String(err);
});
