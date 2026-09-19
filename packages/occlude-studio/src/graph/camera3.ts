/**
 * A viewer node showing the model instead of the drawing.
 *
 * The worker already draws the construction — the studio's panel asks it for
 * a bitmap and paints it over the sheet. A viewer node wants the same picture
 * in a smaller box and with no sheet behind it, so this holds one camera, the
 * gestures that move it, and the one-in-flight rule the panel follows:
 * a drag burst must not build a queue.
 *
 * The execution the picture comes from belongs to the worker, and the next
 * render of any other viewer replaces it. So a stale request is not an error
 * to show: it is a request to render this viewer again and ask once more.
 */
import type { Camera3 } from 'occlude/src/three/camera.js';
import type { ConstructionInfo3 } from '../three/construction.js';
import { fitCamera3, orbitCamera3, panCamera3, presetCamera3, zoomCamera3, type ViewPreset3 } from '../three/orbit.js';
import type { RenderClient } from '../workerClient.js';

/** What a fresh render of this viewer's own sketch gives back. */
export type Again = () => Promise<{ executionId: number; construction: ConstructionInfo3[] } | null>;

export class NodeCamera3 {
  private camera?: Camera3;
  private info?: ConstructionInfo3;
  private executionId = -1;
  private revision = 0;
  private busy = false;
  private dirty = false;
  private bitmap?: ImageBitmap;
  /** Why there is no picture. A blank box says nothing; this says it in the
   * box, where the artist is looking. */
  private trouble?: string;
  /** A render this camera asked for itself. The scene it brings back must not
   * schedule another draw: the draw that asked for it is still running, and
   * two of them chasing each other is a render loop. */
  private recovering = false;
  private off: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly client: RenderClient,
    private readonly again: Again,
    private readonly say: (message: string) => void,
  ) {
    this.bind();
  }

  /** A render arrived: this is the model it built, and the execution that
   * holds it. The artist's own camera is kept — a re-render on every edit
   * must not throw away the view they orbited to. */
  offer(executionId: number, info: ConstructionInfo3 | undefined): void {
    this.executionId = executionId;
    this.info = info;
    if (!info) return;
    if (!this.camera) this.camera = info.camera;
    if (!this.recovering) this.schedule();
  }

  has(): boolean {
    return this.info !== undefined;
  }

  /** Frame the model, the way `Home` does everywhere else. */
  fit(): void {
    if (!this.camera || !this.info?.bounds) return;
    const box = this.canvas.getBoundingClientRect();
    const aspect = box.height > 0 ? box.width / box.height : 1;
    this.camera = fitCamera3(this.camera, this.info.bounds, aspect);
    this.schedule();
  }

  /** Back to the camera the sketch itself asked for. */
  reset(): void {
    if (!this.info) return;
    this.camera = this.info.camera;
    this.schedule();
  }

  dispose(): void {
    for (const off of this.off) off();
    this.off = [];
    this.bitmap?.close();
    this.bitmap = undefined;
  }

  /** Paint what was last drawn, without asking for a new picture: the node
   * was repainted, or the canvas resized. */
  repaint(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
    }
    const ink = this.canvas.getContext('2d');
    if (!ink) return;
    ink.setTransform(dpr, 0, 0, dpr, 0, 0);
    ink.clearRect(0, 0, w, h);
    if (this.bitmap) {
      ink.drawImage(this.bitmap, 0, 0, w, h);
      return;
    }
    if (!this.trouble) return;
    const style = getComputedStyle(this.canvas);
    ink.fillStyle = style.getPropertyValue('--faint') || '#8a8f98';
    ink.font = `11px ${style.getPropertyValue('--sans') || 'sans-serif'}`;
    ink.textAlign = 'center';
    ink.textBaseline = 'middle';
    // One line per word run that fits: a node is narrow, and a clipped
    // message is no message.
    const words = this.trouble.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ink.measureText(next).width > w - 16 && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    const top = h / 2 - ((lines.length - 1) * 14) / 2;
    lines.forEach((text, i) => ink.fillText(text, w / 2, top + i * 14));
  }

  private schedule(): void {
    this.revision++;
    this.dirty = true;
    void this.draw();
  }

  private async draw(): Promise<void> {
    if (this.busy || !this.dirty || !this.camera) return;
    const box = this.canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    this.busy = true;
    this.dirty = false;
    const mine = this.revision;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const ask = async (): Promise<ImageBitmap | undefined> => {
      const reply = await this.client.construction({
        executionId: this.executionId,
        scene: 0,
        camera: this.camera!,
        width: Math.max(1, Math.min(4096, Math.round(box.width * ratio))),
        height: Math.max(1, Math.min(4096, Math.round(box.height * ratio))),
        revision: mine,
      });
      return reply.bitmap;
    };
    try {
      let bitmap: ImageBitmap | undefined;
      try {
        bitmap = await ask();
      } catch (error) {
        // The worker moved on to another viewer's execution. Build this one
        // again and ask once more; only then is it worth saying.
        this.recovering = true;
        let fresh: Awaited<ReturnType<Again>>;
        try {
          fresh = await this.again();
        } finally {
          this.recovering = false;
        }
        if (!fresh) throw error;
        this.executionId = fresh.executionId;
        this.info = fresh.construction[0] ?? this.info;
        bitmap = await ask();
      }
      if (!bitmap) return;
      if (mine !== this.revision) {
        bitmap.close();
        return;
      }
      this.bitmap?.close();
      this.bitmap = bitmap;
      this.trouble = undefined;
      this.repaint();
    } catch (error) {
      if (mine === this.revision) {
        const message = error instanceof Error ? error.message : String(error);
        this.trouble = message;
        this.repaint();
        this.say(message);
      }
    } finally {
      this.busy = false;
      if (this.dirty) void this.draw();
    }
  }

  /** Blender's gestures, the same ones the studio's panel takes: drag orbits,
   * shift pans, ctrl zooms, the wheel zooms, 1/3/7 are front/right/top. */
  private bind(): void {
    const canvas = this.canvas;
    let drag: { x: number; y: number; kind: 'orbit' | 'pan' | 'zoom' } | null = null;

    const down = (event: PointerEvent): void => {
      if (!this.camera) return;
      event.preventDefault();
      event.stopPropagation();
      canvas.setPointerCapture(event.pointerId);
      canvas.focus();
      drag = {
        x: event.clientX,
        y: event.clientY,
        kind: event.ctrlKey || event.metaKey ? 'zoom' : event.shiftKey || event.button === 1 ? 'pan' : 'orbit',
      };
    };
    const move = (event: PointerEvent): void => {
      if (!drag || !this.camera) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (dx === 0 && dy === 0) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const box = canvas.getBoundingClientRect();
      if (drag.kind === 'orbit') this.camera = orbitCamera3(this.camera, -dx * 0.01, -dy * 0.01);
      else if (drag.kind === 'pan') this.camera = panCamera3(this.camera, -dx / Math.max(1, box.width), dy / Math.max(1, box.height));
      else this.camera = zoomCamera3(this.camera, Math.exp(dy * 0.006));
      this.schedule();
    };
    const up = (event: PointerEvent): void => {
      drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const wheel = (event: WheelEvent): void => {
      if (!this.camera) return;
      event.preventDefault();
      event.stopPropagation();
      this.camera = zoomCamera3(this.camera, Math.exp(event.deltaY * 0.0015));
      this.schedule();
    };
    const key = (event: KeyboardEvent): void => {
      if (!this.camera) return;
      // 1/3/7 are front/right/top, and with ctrl the opposite side, as
      // Blender's numpad reads.
      const sides: Record<string, [ViewPreset3, ViewPreset3]> = {
        '1': ['front', 'back'],
        '3': ['right', 'left'],
        '7': ['top', 'bottom'],
      };
      const side = sides[event.key];
      if (side) {
        event.preventDefault();
        event.stopPropagation();
        this.camera = presetCamera3(this.camera, side[event.ctrlKey || event.metaKey ? 1 : 0]);
        this.schedule();
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        event.stopPropagation();
        this.fit();
      }
    };

    // The canvas is painted into the node before the node is in the page, so
    // the first draw would find a box of nothing and stop. The observer is
    // both the retry and the answer to a node the artist resizes: one draw is
    // ever in flight, so a drag cannot build a queue.
    const sizes = new ResizeObserver(() => {
      if (this.canvas.clientWidth <= 0 || this.canvas.clientHeight <= 0) return;
      this.repaint();
      this.schedule();
    });
    sizes.observe(canvas);
    this.off.push(() => sizes.disconnect());

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('keydown', key);
    this.off.push(
      () => canvas.removeEventListener('pointerdown', down),
      () => canvas.removeEventListener('pointermove', move),
      () => canvas.removeEventListener('pointerup', up),
      () => canvas.removeEventListener('pointercancel', up),
      () => canvas.removeEventListener('wheel', wheel),
      () => canvas.removeEventListener('keydown', key),
    );
  }
}
