/**
 * Evolve: choose among variations of one drawing. A three-by-three grid —
 * the current drawing in the middle, eight variations around it — where a
 * variation is the same source and seed with a few random draws answered
 * differently (the library's draw overrides, see draws.ts). Clicking a tile
 * makes it the middle and cools the grid; draws you keep choosing settle,
 * draws that keep changing stay lively. Nothing is written until Keep,
 * which makes one snapshot (source, seed, overrides, parent); Open in
 * studio keeps and then opens. The source is never edited.
 */
import './style.css';

import { formatSeed, liveExampleToJs, parseSeed, type PenDef, type RenderResult } from 'occlude';

import { Preview } from './preview.js';
import { RenderClient } from './workerClient.js';
import { loadPens, loadSettings } from './store.js';
import {
  createSnapshot, forkSketch, forkSnapshot, loadSketchByName, loadSketchJs, loadSnapshot, openInStudio, putThumb, saveSketchByName, takeLive, thumbFromCanvas, transpileSource,
  type SourceRef,
} from './sketchApi.js';
import { button, el, hint } from './widgets.js';
import { cool, mulberry32, mutate, reheat, type Candidate, type Draws } from './evolve.js';

const main = document.getElementById('evolve-main')!;
const title = document.getElementById('evolve-title')!;

async function boot(): Promise<void> {
  const params = new URL(location.href).searchParams;
  // Live: the studio's unsaved buffer, handed over without a save. Keep
  // saves it first (under a name it asks for if the sketch has none).
  const live = params.get('live') ? takeLive() : null;
  const name = params.get('sketch') ?? live?.name ?? '';
  if (!name && !live) {
    main.append(hint('Open Evolve from the Sketches page, or from the studio’s Evolve button.'));
    return;
  }
  const ref: SourceRef = { name, snap: params.get('snap') ?? undefined, sha: params.get('at') ?? undefined };
  const pens: PenDef[] = await loadPens();
  const settings = loadSettings();
  // The server strips types; the worker evaluates CommonJS — the same
  // ESM→CJS rewrite the docs examples and the snapshot gallery use.
  const js = liveExampleToJs(live ? await transpileSource(live.source) : await loadSketchJs(ref));
  const startMeta = ref.snap ? (await loadSnapshot(name, ref.snap)).meta : null;
  const seedParam = params.get('seed');
  const parsed = parseSeed(seedParam ?? (startMeta?.seed != null ? formatSeed(String(startMeta.seed), startMeta.overrides ?? {}) : String(Math.floor(Math.random() * 2 ** 31))));
  title.textContent = live ? `${name || 'untitled'} · unsaved` : `${name}${ref.snap ? ` · snapshot ${ref.snap}` : ref.sha ? ` @ ${ref.sha}` : ''}`;

  // ---- state
  let centre: Candidate = { seed: parsed.seed, overrides: parsed.overrides };
  let centreDraws: Draws = { addrs: [], f: new Float64Array(0) };
  const heat = new Map<string, number>();
  let T = 0.8;
  const processSeed = Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(processSeed);
  const lineage: { cand: Candidate; thumb: string }[] = [];
  let generation = 0;

  // ---- render pool: three workers, tiles round-robin, results as they land
  const pool = [new RenderClient(), new RenderClient(), new RenderClient()];
  const busy: Promise<void>[] = pool.map(() => Promise.resolve());
  const renderOn = (k: number, cand: Candidate, wantDraws: boolean) => {
    const client = pool[k % pool.length];
    const p = busy[k % pool.length].then(() => client.render({
      js,
      cfg: {
        pens,
        paper: settings.paper === 'Custom' ? settings.customPaper : settings.paper,
        landscape: settings.landscape,
        defaultMarginPct: settings.defaultMarginPct,
        coarsen: 1,
        seed: formatSeed(cand.seed, cand.overrides),
        draws: wantDraws,
      },
    }));
    busy[k % pool.length] = p.then(() => undefined, () => undefined);
    return p;
  };

  const sizeCanvas = (canvas: HTMLCanvasElement): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
  };

  // ---- grid
  const grid = el('div', 'evolve-grid');
  const tiles: { root: HTMLDivElement; canvas: HTMLCanvasElement; note: HTMLDivElement; preview: Preview; cand: Candidate | null; result: RenderResult | null }[] = [];
  // Hover: the tile large, in a panel over the grid, after a short rest so
  // sweeping the mouse across doesn't flicker. Pointer-transparent: the
  // click beneath still picks.
  const zoomCanvas = document.createElement('canvas');
  const zoom = el('div', 'evolve-zoom', zoomCanvas);
  zoom.hidden = true;
  const zoomPreview = new Preview(zoomCanvas);
  zoomPreview.setPaperColor(settings.paperColor);
  let zoomTimer = 0;
  const showZoom = (i: number): void => {
    const t = tiles[i];
    if (!t.result) return;
    zoom.hidden = false;
    sizeCanvas(zoomCanvas);
    zoomPreview.setResult(t.result);
    zoomPreview.fit();
  };
  const hideZoom = (): void => { clearTimeout(zoomTimer); zoom.hidden = true; };
  for (let i = 0; i < 9; i++) {
    const canvas = document.createElement('canvas');
    const note = el('div', 'evolve-note');
    const root = el('div', 'evolve-tile', canvas, note);
    const preview = new Preview(canvas);
    preview.setPaperColor(settings.paperColor);
    tiles.push({ root, canvas, note, preview, cand: null, result: null });
    grid.append(root);
    root.onclick = () => { hideZoom(); const t = tiles[i]; if (t.cand) void choose(i); };
    // Only the sheet itself arms the zoom, not the dark margin around it.
    let overPaper = false;
    root.onmousemove = (e) => {
      const t = tiles[i];
      if (!t.result) return;
      const [x, y] = t.preview.toPaper(e.clientX, e.clientY);
      const inside = x >= 0 && y >= 0 && x <= t.result.paper.w && y <= t.result.paper.h;
      if (inside === overPaper) return;
      overPaper = inside;
      clearTimeout(zoomTimer);
      if (inside) zoomTimer = window.setTimeout(() => showZoom(i), 600);
      else zoom.hidden = true;
    };
    root.onmouseleave = () => { overPaper = false; hideZoom(); };
  }
  tiles[4].root.classList.add('centre');

  // ---- controls
  const tempIn = document.createElement('input');
  tempIn.type = 'range';
  tempIn.min = '0';
  tempIn.max = '1';
  tempIn.step = '0.01';
  tempIn.value = String(T);
  tempIn.title = 'How far the variations stray: 1 is nearly a new seed, 0 is the same drawing';
  tempIn.oninput = () => { T = Number(tempIn.value); tempText(); };
  const tempLabel = el('span', 'evolve-temp');
  const tempText = (): void => { tempLabel.textContent = `${Math.round(T * 100)}%`; };
  tempText();
  const seedText = el('span', 'evolve-seed');
  const status = el('span', 'evolve-status');
  // Again warms: the draws and the variation both step back up by one pick's
  // worth, so pressing it because nothing appealed widens the next grid.
  const againBtn = button('Again', () => {
    reheat(heat);
    T = Math.min(1, T / 0.85);
    tempIn.value = String(T);
    tempText();
    void regenerate();
  });
  againBtn.title = 'Eight new variations of the middle, a step wider than the last: draws that had settled warm up again';
  const keepBtn = button('Keep', () => void keep(false));
  keepBtn.className = 'primary';
  keepBtn.title = 'Snapshot the middle drawing: source, seed and the overridden draws';
  const openBtn = button('Open in studio', () => void keep(true));
  openBtn.title = 'Keep, then open the drawing in the studio';
  const backBtn = button('Back', () => void back());
  backBtn.title = 'Return to the previous pick';
  const strip = el('div', 'evolve-lineage');
  const bar = el('div', 'evolve-bar',
    el('div', 'evolve-group', backBtn, againBtn),
    el('label', 'evolve-variation', el('span', 'evolve-caption', 'variation'), tempIn, tempLabel),
    el('div', 'evolve-readout', seedText, status),
    el('div', 'evolve-group', keepBtn, openBtn),
  );
  main.append(grid, bar, strip, zoom);

  const showSeed = (): void => {
    const n = Object.keys(centre.overrides).length;
    seedText.textContent = n ? `seed ${centre.seed} +${n}` : `seed ${centre.seed}`;
    seedText.title = formatSeed(centre.seed, centre.overrides);
  };

  const renderTile = async (i: number, cand: Candidate, wantDraws: boolean, gen: number): Promise<Draws | null> => {
    const t = tiles[i];
    t.cand = cand;
    t.root.classList.add('pending');
    t.note.textContent = '';
    try {
      const reply = await renderOn(i, cand, wantDraws);
      if (gen !== generation || !reply) return null;
      sizeCanvas(t.canvas);
      t.result = reply.result;
      t.preview.setResult(reply.result);
      t.preview.fit();
      const n = Object.keys(cand.overrides).length;
      t.note.textContent = i === 4 ? 'current' : i === 8 && n === 0 && cand.seed !== centre.seed ? 'new seed' : n ? `+${n}` : '';
      t.root.classList.remove('pending');
      return reply.draws ?? null;
    } catch (e) {
      if (gen !== generation) return null;
      t.root.classList.remove('pending');
      t.note.textContent = e instanceof Error ? e.message : String(e);
      return null;
    }
  };

  /** The middle first (its draws are the material), then the eight. */
  const regenerate = async (): Promise<void> => {
    generation += 1;
    const gen = generation;
    showSeed();
    status.textContent = 'rendering…';
    const draws = await renderTile(4, centre, true, gen);
    if (gen !== generation) return;
    if (draws) centreDraws = draws;
    for (const addr of centreDraws.addrs) if (!heat.has(addr)) heat.set(addr, 1);
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 9; i++) {
      if (i === 4) continue;
      const cand: Candidate = i === 8
        ? { seed: String(Math.floor(rng() * 2 ** 31)), overrides: {} }
        : mutate(centre, centreDraws, heat, T, rng);
      jobs.push(renderTile(i, cand, false, gen));
    }
    await Promise.all(jobs);
    if (gen !== generation) return;
    status.textContent = centreDraws.addrs.length
      ? `${centreDraws.addrs.length} draws in play · click a variation to make it the middle; click the middle to cool`
      : 'this sketch makes no random draws of its own — only the new-seed tile varies';
  };

  const pushLineage = (): void => {
    const thumb = tiles[4].canvas.toDataURL('image/png');
    lineage.push({ cand: { seed: centre.seed, overrides: { ...centre.overrides } }, thumb });
    const img = document.createElement('img');
    img.src = thumb;
    img.className = 'evolve-crumb';
    img.title = formatSeed(centre.seed, centre.overrides);
    const at = lineage.length - 1;
    img.onclick = () => void jumpTo(at);
    strip.append(img);
    strip.scrollLeft = strip.scrollWidth;
    for (const c of strip.children) c.classList.remove('current');
    img.classList.add('current');
    syncButtons();
  };

  const choose = async (i: number): Promise<void> => {
    const t = tiles[i];
    if (!t.cand) return;
    if (i === 4) {
      T = Math.max(0.2, T * 0.85); // cool gently, never all the way: the grid keeps some variety
      tempIn.value = String(T);
      tempText();
      await regenerate();
      return;
    }
    const from = centre;
    centre = { seed: t.cand.seed, overrides: { ...t.cand.overrides } };
    if (centre.seed === from.seed) cool(heat, centreDraws, from, centre);
    else heat.clear();
    T = Math.max(0.2, T * 0.85); // cool gently, never all the way: the grid keeps some variety
    tempIn.value = String(T);
    tempText();
    pushLineage();
    await regenerate();
  };

  const jumpTo = async (at: number): Promise<void> => {
    const entry = lineage[at];
    if (!entry) return;
    centre = { seed: entry.cand.seed, overrides: { ...entry.cand.overrides } };
    lineage.length = at + 1;
    for (const img of [...strip.children].slice(at + 1)) img.remove();
    for (const c of strip.children) c.classList.remove('current');
    strip.children[at]?.classList.add('current');
    syncButtons();
    await regenerate();
  };

  const back = async (): Promise<void> => {
    if (lineage.length < 2) return;
    await jumpTo(lineage.length - 2);
  };
  const syncButtons = (): void => { backBtn.disabled = lineage.length < 2; };

  /** Keep: one snapshot of the middle. A head start keeps on the sketch;
   * a snapshot or version start keeps on a fork from there, so the tag
   * always sits on the source that was rendered. */
  const keep = async (thenOpen: boolean): Promise<void> => {
    keepBtn.disabled = openBtn.disabled = true;
    try {
      let target = name;
      if (live) {
        // The buffer is saved now, once, so the tag has a source to sit on.
        if (!target) {
          const asked = prompt('Name the sketch to keep this drawing:')?.trim() ?? '';
          if (!asked) return;
          if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(asked)) throw new Error('names are letters, digits, spaces, _ and -');
          target = asked;
        }
        await saveSketchByName(target, live.source);
      } else if (ref.snap) target = await forkSnapshot(name, ref.snap);
      else if (ref.sha) target = await forkSketch(name, undefined, ref.sha);
      const id = await createSnapshot(target, {
        seed: centre.seed,
        overrides: centre.overrides,
        parent: ref.snap ?? null,
        label: 'evolved',
      });
      const png = await thumbFromCanvas(tiles[4].canvas);
      if (png) await putThumb(target, png, id);
      status.textContent = `kept as snapshot ${id} of ${target}`;
      if (thenOpen) openInStudio(target, live ? live.source : await loadSketchByName(target), formatSeed(centre.seed, centre.overrides));
    } catch (e) {
      status.textContent = `keep failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      keepBtn.disabled = openBtn.disabled = false;
    }
  };

  window.addEventListener('resize', () => {
    for (const t of tiles) { if (t.cand) { sizeCanvas(t.canvas); t.preview.fit(); } }
  });

  await regenerate();
  pushLineage(); // the start, once its tile has rendered
}

void boot();
