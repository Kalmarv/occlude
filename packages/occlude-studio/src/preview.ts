/**
 * Paper preview: Canvas 2D, pan/zoom, real pen widths on a paper-coloured
 * sheet. Debug mode ghosts the full primitive table (what was hidden),
 * outlines occluder bounds, and marks fragment endpoints.
 */

import { drawFragments, evalPrim, tracePrim, type PenDef, type RenderResult } from 'occlude';

interface PlanChain {
  pen: number;
  dot: boolean;
  /** Flattened points, paper mm. */
  pts: Float64Array;
  /** Ink length, mm. */
  inkLen: number;
}

interface PlotSim {
  chains: PlanChain[];
  pens: PenDef[];
  /** Cumulative sim time (s) at the START of each chain (after its travel). */
  chainStart: number[];
  /** Duration (s) of each chain's drawing (incl. dot dwell). */
  chainDur: number[];
  totalSeconds: number;
  simTime: number;
  lastFrame: number;
  speed: number;
  /** Index of the first chain not yet fully committed to the offscreen. */
  committed: number;
  layer: OffscreenCanvas | HTMLCanvasElement;
  lctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  pxPerMm: number;
  raf: number;
  onProgress: (elapsed: number, total: number, pen: string) => void;
  onDone: () => void;
}

export class Preview {
  private ctx: CanvasRenderingContext2D;
  private result: RenderResult | null = null;
  /** Screen px per mm. */
  private scale = 3;
  private panX = 0;
  private panY = 0;
  private fitted = false;
  /** Debug layers: each pass answers a different question. */
  debug = { occluded: false, bridges: false, cuts: false };
  private sim: PlotSim | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.bindInput();
    const ro = new ResizeObserver(() => {
      this.resize();
      this.draw();
    });
    ro.observe(canvas);
    this.resize();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = this.canvas;
    this.canvas.width = Math.max(1, clientWidth * dpr);
    this.canvas.height = Math.max(1, clientHeight * dpr);
  }

  setResult(r: RenderResult): void {
    this.result = r;
    this.stopPlot();
    if (!this.fitted) this.fit();
    this.draw();
  }

  get plotting(): boolean {
    return this.sim !== null;
  }

  /**
   * Animate the plot: chains in real tour order, timed by pen feed and
   * travel feed (mm/min), scaled by `speed`.
   */
  /** Parse a [pen, dot, n, x0, y0, …] toolpath plan into chains. */
  private parsePlan(plan: Float64Array): PlanChain[] {
    const chains: PlanChain[] = [];
    for (let i = 0; i < plan.length; ) {
      const pen = plan[i++];
      const dot = plan[i++] === 1;
      const n = plan[i++];
      const pts = plan.subarray(i, i + n * 2);
      i += n * 2;
      let inkLen = 0;
      for (let k = 2; k < pts.length; k += 2) {
        inkLen += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
      }
      chains.push({ pen, dot, pts, inkLen });
    }
    return chains;
  }

  /** Live plot view: while the MACHINE plots, mirror its progress — every
   * chain ghosted in toolpath blue, the upcoming few as a fading gradient,
   * drawn chains in real ink. Driven by chain indices from the EBB driver
   * instead of a clock. */
  private live: {
    chains: PlanChain[];
    pens: PenDef[];
    committed: number;
    index: number;
    layer: HTMLCanvasElement;
    lctx: CanvasRenderingContext2D;
    ghost: HTMLCanvasElement;
    pxPerMm: number;
  } | null = null;

  startLive(plan: Float64Array, pens: PenDef[]): void {
    this.stopPlot();
    if (!this.result) return;
    const chains = this.parsePlan(plan);
    if (chains.length === 0) return;
    this.live = {
      chains, pens,
      committed: 0,
      index: 0,
      layer: document.createElement('canvas'),
      lctx: null as unknown as CanvasRenderingContext2D,
      ghost: document.createElement('canvas'),
      pxPerMm: 0,
    };
    this.rebuildLiveLayers(this.desiredPxPerMm());
    this.draw();
  }

  private liveRaf = 0;

  liveProgress(chain: number): void {
    const live = this.live;
    if (!live) return;
    live.index = Math.min(chain, live.chains.length - 1);
    // The active chain draws in full ink immediately — at chain granularity
    // the view leads the pen by less than one stroke.
    while (live.committed <= live.index) {
      this.drawLiveChain(live.lctx, live.chains[live.committed], live.pens);
      live.committed++;
    }
    // Repaint on the next animation frame, coalesced: this is called from
    // the serial pump's progress callback, and a synchronous full redraw
    // there starves the motion FIFO (the every-25-strokes stutter).
    if (this.liveRaf === 0) {
      this.liveRaf = requestAnimationFrame(() => {
        this.liveRaf = 0;
        this.draw();
      });
    }
  }

  endLive(): void {
    if (this.liveRaf !== 0) cancelAnimationFrame(this.liveRaf);
    this.liveRaf = 0;
    this.live = null;
    this.draw();
  }

  private drawLiveChain(
    ctx: CanvasRenderingContext2D,
    c: PlanChain,
    pens: PenDef[],
  ): void {
    const pen = pens[c.pen];
    ctx.strokeStyle = pen?.color ?? '#111';
    ctx.fillStyle = pen?.color ?? '#111';
    ctx.lineWidth = pen?.width ?? 0.3;
    if (c.dot) {
      ctx.beginPath();
      ctx.arc(c.pts[0], c.pts[1], (pen?.width ?? 0.3) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(c.pts[0], c.pts[1]);
    for (let k = 2; k < c.pts.length; k += 2) ctx.lineTo(c.pts[k], c.pts[k + 1]);
    ctx.stroke();
  }

  private rebuildLiveLayers(pxPerMm: number): void {
    const live = this.live;
    if (!live || !this.result) return;
    const { w, h } = this.result.paper;
    live.pxPerMm = pxPerMm;
    for (const cv of [live.layer, live.ghost]) {
      cv.width = Math.max(1, Math.ceil(w * pxPerMm));
      cv.height = Math.max(1, Math.ceil(h * pxPerMm));
    }
    const g = live.ghost.getContext('2d')!;
    g.scale(pxPerMm, pxPerMm);
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(91, 139, 217, 0.4)';
    g.fillStyle = 'rgba(91, 139, 217, 0.4)';
    g.lineWidth = 0.14;
    g.beginPath();
    for (const c of live.chains) {
      if (c.dot) {
        g.moveTo(c.pts[0] + 0.15, c.pts[1]);
        g.arc(c.pts[0], c.pts[1], 0.15, 0, Math.PI * 2);
        continue;
      }
      g.moveTo(c.pts[0], c.pts[1]);
      for (let k = 2; k < c.pts.length; k += 2) g.lineTo(c.pts[k], c.pts[k + 1]);
    }
    g.stroke();
    const l = live.layer.getContext('2d')!;
    l.scale(pxPerMm, pxPerMm);
    l.lineCap = 'round';
    l.lineJoin = 'round';
    live.lctx = l;
    for (let i = 0; i < live.committed; i++) {
      this.drawLiveChain(l, live.chains[i], live.pens);
    }
  }

  startPlot(
    plan: Float64Array,
    pens: PenDef[],
    travelFeed: number,
    speed: number,
    onProgress: (elapsed: number, total: number, pen: string) => void,
    onDone: () => void,
  ): void {
    if (this.live) return; // the machine owns the preview right now
    this.stopPlot();
    if (!this.result) return;
    const chains = this.parsePlan(plan);
    if (chains.length === 0) return;
    // Timing: travel to each chain start, then draw at the pen's feed.
    const chainStart: number[] = [];
    const chainDur: number[] = [];
    let t = 0;
    let px = 0;
    let py = 0;
    const travelPerSec = Math.max(1, travelFeed / 60);
    for (const c of chains) {
      const pdef = pens[c.pen];
      const feedPerSec = Math.max(1, (pdef?.feed ?? 3000) / 60);
      const dwell = ((pdef?.penDelay ?? 100) / 1000) * 2 + 0.15; // down+up+settle
      t += Math.hypot(c.pts[0] - px, c.pts[1] - py) / travelPerSec;
      chainStart.push(t);
      const dur = c.dot ? dwell : dwell + c.inkLen / feedPerSec;
      chainDur.push(dur);
      t += dur;
      px = c.pts[c.pts.length - 2];
      py = c.pts[c.pts.length - 1];
    }
    // Offscreen accumulation layer in paper space — resolution follows the
    // current zoom (see rebuildLayer) so committed ink stays crisp.
    this.sim = {
      chains, pens, chainStart, chainDur,
      totalSeconds: t,
      simTime: 0,
      lastFrame: performance.now(),
      speed,
      committed: 0,
      layer: document.createElement('canvas'),
      lctx: null as unknown as CanvasRenderingContext2D,
      pxPerMm: 0,
      raf: 0,
      onProgress, onDone,
    };
    this.rebuildLayer(this.desiredPxPerMm());
    this.tick();
  }

  /** Layer resolution the current zoom deserves: enough px/mm to match the
   * screen (dpr-aware), bounded by a total-pixel budget so an A3 sheet at
   * high zoom can't allocate a monster canvas. */
  private desiredPxPerMm(): number {
    const { w, h } = this.result!.paper;
    const dpr = window.devicePixelRatio || 1;
    const areaCap = Math.sqrt(16e6 / (w * h)); // ≤ ~16M px total
    return Math.max(2, Math.min(this.scale * dpr, 24, areaCap));
  }

  /** (Re)create the accumulation layer at `pxPerMm` and replay the chains
   * committed so far. Called once per plot start and again when the zoom
   * moves far enough that the old raster would show. */
  private rebuildLayer(pxPerMm: number): void {
    const sim = this.sim!;
    const { w, h } = this.result!.paper;
    const layer = document.createElement('canvas');
    layer.width = Math.max(1, Math.ceil(w * pxPerMm));
    layer.height = Math.max(1, Math.ceil(h * pxPerMm));
    const lctx = layer.getContext('2d')!;
    lctx.scale(pxPerMm, pxPerMm);
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';
    sim.layer = layer;
    sim.lctx = lctx;
    sim.pxPerMm = pxPerMm;
    for (let i = 0; i < sim.committed; i++) {
      this.drawChainInto(lctx, sim.chains[i], Infinity);
    }
  }

  setPlotSpeed(speed: number): void {
    if (this.sim) this.sim.speed = speed;
  }

  stopPlot(): void {
    if (this.sim) {
      cancelAnimationFrame(this.sim.raf);
      this.sim = null;
      this.draw();
    }
  }

  private drawChainInto(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    c: PlanChain,
    upToLen: number,
  ): { x: number; y: number } {
    const pen = this.sim!.pens[c.pen];
    ctx.strokeStyle = pen?.color ?? '#111';
    ctx.fillStyle = pen?.color ?? '#111';
    ctx.lineWidth = pen?.width ?? 0.3;
    if (c.dot) {
      ctx.beginPath();
      ctx.arc(c.pts[0], c.pts[1], (pen?.width ?? 0.3) / 2, 0, Math.PI * 2);
      ctx.fill();
      return { x: c.pts[0], y: c.pts[1] };
    }
    ctx.beginPath();
    ctx.moveTo(c.pts[0], c.pts[1]);
    let remaining = upToLen;
    let hx = c.pts[0];
    let hy = c.pts[1];
    for (let k = 2; k < c.pts.length; k += 2) {
      const dx = c.pts[k] - c.pts[k - 2];
      const dy = c.pts[k + 1] - c.pts[k - 1];
      const seg = Math.hypot(dx, dy);
      if (remaining >= seg) {
        ctx.lineTo(c.pts[k], c.pts[k + 1]);
        hx = c.pts[k];
        hy = c.pts[k + 1];
        remaining -= seg;
      } else {
        const f = seg > 0 ? remaining / seg : 0;
        hx = c.pts[k - 2] + dx * f;
        hy = c.pts[k - 1] + dy * f;
        ctx.lineTo(hx, hy);
        break;
      }
    }
    ctx.stroke();
    return { x: hx, y: hy };
  }

  private tick = (): void => {
    const sim = this.sim;
    if (!sim) return;
    const now = performance.now();
    sim.simTime += ((now - sim.lastFrame) / 1000) * sim.speed;
    sim.lastFrame = now;

    // Commit fully-elapsed chains to the offscreen layer.
    while (
      sim.committed < sim.chains.length &&
      sim.simTime >= sim.chainStart[sim.committed] + sim.chainDur[sim.committed]
    ) {
      this.drawChainInto(sim.lctx, sim.chains[sim.committed], Infinity);
      sim.committed++;
    }

    if (sim.committed >= sim.chains.length) {
      const total = sim.totalSeconds;
      sim.onProgress(total, total, '');
      sim.onDone();
      this.stopPlot(); // final draw() shows the exact vector render
      return;
    }
    this.draw();
    sim.raf = requestAnimationFrame(this.tick);
  };

  fit(): void {
    if (!this.result) return;
    const { w, h } = this.result.paper;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    this.scale = Math.min(cw / (w * 1.15), ch / (h * 1.15));
    this.panX = (cw - w * this.scale) / 2;
    this.panY = (ch - h * this.scale) / 2;
    this.fitted = true;
    this.draw();
  }

  private bindInput(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.classList.add('panning');
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.panX += e.clientX - lastX;
      this.panY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.draw();
    });
    this.canvas.addEventListener('pointerup', () => {
      dragging = false;
      this.canvas.classList.remove('panning');
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(80, Math.max(0.2, this.scale * factor));
        // Zoom around the cursor.
        this.panX = mx - ((mx - this.panX) / this.scale) * ns;
        this.panY = my - ((my - this.panY) / this.scale) * ns;
        this.scale = ns;
        this.draw();
      },
      { passive: false },
    );
  }

  draw(): void {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const r = this.result;
    if (!r) return;

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    // The sheet.
    const { w, h } = r.paper;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 18 / this.scale;
    ctx.shadowOffsetY = 6 / this.scale;
    ctx.fillStyle = '#f6f2ea';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    if (this.live) {
      const live = this.live;
      const want = this.desiredPxPerMm();
      if (want > live.pxPerMm * 1.4 || want < live.pxPerMm / 2) {
        this.rebuildLiveLayers(want);
      }
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      // Everything still to draw, ghosted in toolpath blue.
      ctx.drawImage(live.ghost as CanvasImageSource, 0, 0, w, h);
      // The next stretch of chains, fading with queue distance.
      const AHEAD = 40;
      ctx.lineCap = 'round';
      for (let k = live.committed; k < Math.min(live.chains.length, live.committed + AHEAD); k++) {
        const c = live.chains[k];
        const a = 0.55 * (1 - (k - live.committed) / AHEAD);
        ctx.strokeStyle = `rgba(91, 139, 217, ${a.toFixed(3)})`;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 0.3;
        if (c.dot) {
          ctx.beginPath();
          ctx.arc(c.pts[0], c.pts[1], 0.3, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(c.pts[0], c.pts[1]);
        for (let m = 2; m < c.pts.length; m += 2) ctx.lineTo(c.pts[m], c.pts[m + 1]);
        ctx.stroke();
      }
      // Ink so far.
      ctx.drawImage(live.layer as CanvasImageSource, 0, 0, w, h);
      // Pen head at the end of the active chain.
      const cur = live.chains[live.index];
      const hx = cur.pts[cur.pts.length - 2];
      const hy = cur.pts[cur.pts.length - 1];
      ctx.fillStyle = live.pens[cur.pen]?.color ?? '#111';
      ctx.strokeStyle = 'rgba(217, 161, 61, 0.95)';
      ctx.lineWidth = 0.35;
      ctx.beginPath();
      ctx.arc(hx, hy, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.restore();
      return;
    }

    if (this.sim) {
      const sim = this.sim;
      // Re-render the committed-ink layer when the zoom has moved far
      // enough that its raster would show (hysteresis avoids churn while
      // wheel-zooming; each rebuild replays only committed chains once).
      const want = this.desiredPxPerMm();
      if (want > sim.pxPerMm * 1.4 || want < sim.pxPerMm / 2) {
        this.rebuildLayer(want);
      }
      // Committed ink.
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sim.layer as CanvasImageSource, 0, 0, w, h);
      ctx.restore();
      // Current chain in progress + travel line + pen head.
      const i = sim.committed;
      const c = sim.chains[i];
      const pdef = sim.pens[c.pen];
      const into = sim.simTime - sim.chainStart[i];
      let head = { x: c.pts[0], y: c.pts[1] };
      if (into >= 0) {
        const feedPerSec = Math.max(1, (pdef?.feed ?? 3000) / 60);
        const drawn = Math.max(0, into - (((pdef?.penDelay ?? 100) / 1000) * 2 + 0.15) / 2) * feedPerSec;
        head = this.drawChainInto(ctx, c, c.dot ? Infinity : drawn);
      } else {
        // Travelling to this chain: show the pen-up move.
        const prev = i > 0 ? sim.chains[i - 1] : null;
        const sx = prev ? prev.pts[prev.pts.length - 2] : c.pts[0];
        const sy = prev ? prev.pts[prev.pts.length - 1] : c.pts[1];
        const tt = 1 + into / Math.max(1e-6, sim.chainStart[i] - (i > 0 ? sim.chainStart[i - 1] + sim.chainDur[i - 1] : 0));
        head = { x: sx + (c.pts[0] - sx) * tt, y: sy + (c.pts[1] - sy) * tt };
        ctx.save();
        ctx.strokeStyle = 'rgba(91, 139, 217, 0.7)';
        ctx.lineWidth = 0.15;
        ctx.setLineDash([1.2, 1.2]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(head.x, head.y);
        ctx.stroke();
        ctx.restore();
      }
      // Pen head.
      ctx.save();
      ctx.fillStyle = pdef?.color ?? '#111';
      ctx.strokeStyle = 'rgba(91, 139, 217, 0.9)';
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      sim.onProgress(Math.max(0, sim.simTime), sim.totalSeconds, pdef?.name ?? '');
      ctx.restore();
      return;
    }

    if (this.debug.occluded) {
      // Ghost everything recorded or generated, including what occlusion
      // removed. The engine's ghost geometry is post-modified (wobbles and
      // dashes exactly like the ink); the raw prim table is the fallback
      // for renders made before debug was toggled on.
      ctx.save();
      ctx.strokeStyle = 'rgba(91, 139, 217, 0.35)';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      for (const p of r.ghost ?? r.prims) tracePrim(ctx, p);
      ctx.stroke();
      ctx.restore();
    }

    drawFragments(ctx, r.frags, r.pens);

    if (this.debug.bridges) {
      // Bridge connectors: the pen-down joins the bridge opt inserted —
      // highlighted so the tolerance's visual cost is inspectable.
      ctx.save();
      ctx.strokeStyle = 'rgba(217, 82, 82, 0.95)';
      ctx.lineWidth = 0.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const f of r.frags) {
        if (f.bridge) tracePrim(ctx, f.geom);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (this.debug.cuts) {
      // Fragment endpoints — where occlusion (and dashing) cut the ink.
      // Marker size follows zoom so dash-heavy sketches stay readable.
      ctx.save();
      ctx.fillStyle = 'rgba(217, 161, 61, 0.9)';
      const rad = Math.min(0.35, 2.5 / this.scale);
      for (const f of r.frags) {
        if (f.dot) continue;
        for (const t of [0, 1]) {
          const [x, y] = evalPrim(f.geom, t);
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    if (this.debug.occluded || this.debug.bridges || this.debug.cuts) {
      // Drawable frame.
      ctx.save();
      ctx.strokeStyle = 'rgba(91, 139, 217, 0.6)';
      ctx.lineWidth = 0.15;
      ctx.setLineDash([1, 1]);
      ctx.strokeRect(
        r.frame.offsetX,
        r.frame.offsetY,
        r.frame.inner.innerW,
        r.frame.inner.innerH,
      );
      ctx.restore();
    }

    ctx.restore();
  }
}
