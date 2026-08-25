/**
 * Paper preview: Canvas 2D, pan/zoom, real pen widths on a paper-coloured
 * sheet. Debug mode ghosts the full primitive table (what was hidden),
 * outlines occluder bounds, and marks fragment endpoints.
 */

import { drawFragments, evalPrim, tracePrim, type RenderResult } from 'occlude';

export class Preview {
  private ctx: CanvasRenderingContext2D;
  private result: RenderResult | null = null;
  /** Screen px per mm. */
  private scale = 3;
  private panX = 0;
  private panY = 0;
  private fitted = false;
  debug = false;

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
    if (!this.fitted) this.fit();
    this.draw();
  }

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

    if (this.debug) {
      // Ghost the full primitive table — everything that was recorded or
      // generated, including what occlusion removed.
      ctx.save();
      ctx.strokeStyle = 'rgba(91, 139, 217, 0.35)';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      for (const p of r.prims) tracePrim(ctx, p);
      ctx.stroke();
      ctx.restore();
    }

    drawFragments(ctx, r.frags, r.pens);

    if (this.debug) {
      // Fragment endpoints.
      ctx.save();
      ctx.fillStyle = 'rgba(217, 161, 61, 0.9)';
      for (const f of r.frags) {
        if (f.dot) continue;
        for (const t of [0, 1]) {
          const [x, y] = evalPrim(f.geom, t);
          ctx.beginPath();
          ctx.arc(x, y, 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Drawable frame.
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
