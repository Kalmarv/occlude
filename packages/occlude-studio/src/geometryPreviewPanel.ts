import type { InspectionEntry } from 'occlude';
import {
  defaultFieldBounds,
  type GeometryPreview,
  type FieldPreview,
  type NativeItem,
  type PreviewOptions,
} from './geometryPreview.js';
import { evalPrim, type Frame, type Prim } from 'occlude';
import { ramp } from './inspectorModel.js';

/** Distance from a point to a primitive, in the primitive's units: exact
 * for a line, sampled along arcs and cubics. */
function distToPrim(p: Prim, x: number, y: number): number {
  if (p.t === 'line') {
    const dx = p.x1 - p.x0, dy = p.y1 - p.y0;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - p.x0) * dx + (y - p.y0) * dy) / l2));
    return Math.hypot(x - (p.x0 + dx * t), y - (p.y0 + dy * t));
  }
  let best = Infinity;
  for (let i = 0; i <= 12; i++) {
    const [px, py] = evalPrim(p, i / 12);
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}

/** Even-odd containment across a face's contours (holes included). */
function insideContours(contours: [number, number][][], x: number, y: number): boolean {
  let inside = false;
  for (const c of contours) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const [xi, yi] = c[i], [xj, yj] = c[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The point a vertex row of a `points` geometry lands on, in paper mm:
 * contour i's primitive i starts there. */
function vertexOf(item: NativeItem, i: number): [number, number] | null {
  const prim = item.contours[0]?.[i];
  if (!prim) return null;
  return prim.t === 'arc' ? [prim.cx + prim.r * Math.cos(prim.start), prim.cy + prim.r * Math.sin(prim.start)] : [prim.x0, prim.y0];
}

/** A design token's current value, for canvas painting. */
export const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

const readable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(6)) : v,
  );
const fmt = (v: number) =>
  Number.isFinite(v) ? Number(v.toPrecision(5)).toString() : 'unavailable';
/** Pure colour mapping, shared by grid and legend. Missing is not zero. */
export function fieldColor(
  value: number,
  min: number | null,
  max: number | null,
  vector = false,
): string {
  if (!Number.isFinite(value) || min === null || max === null) return '#737780';
  const mix = (a: number[], b: number[], t: number) =>
    `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
  if (!vector && min < 0) {
    const extent = Math.max(Math.abs(min), Math.abs(max)),
      t = extent ? Math.max(-1, Math.min(1, value / extent)) : 0;
    return t < 0
      ? mix([241, 238, 226], [55, 109, 196], -t)
      : mix([241, 238, 226], [212, 76, 61], t);
  }
  const t =
    min === max ? 0.5 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  return t < 0.5
    ? mix([57, 35, 102], [40, 157, 157], t * 2)
    : mix([40, 157, 157], [245, 220, 80], t * 2 - 1);
}
function strokePrim(ctx: CanvasRenderingContext2D, p: Prim): void {
  if (p.t === 'arc') {
    ctx.moveTo(p.cx + p.r * Math.cos(p.start), p.cy + p.r * Math.sin(p.start));
    ctx.arc(p.cx, p.cy, p.r, p.start, p.start + p.sweep, p.sweep < 0);
  } else {
    ctx.moveTo(p.x0, p.y0);
    if (p.t === 'line') ctx.lineTo(p.x1, p.y1);
    else ctx.bezierCurveTo(p.c0x, p.c0y, p.c1x, p.c1y, p.x1, p.y1);
  }
}
export class GeometryPreviewPanel {
  readonly host = document.createElement('div');
  private controls = document.createElement('div');
  private content = document.createElement('div');
  private data: GeometryPreview | null = null;
  onChange: () => void = () => {};
  private rendered = true;
  private nativeSelected: number | null = null;
  /** A native item or face under the pointer in the table, lit in the preview. */
  private hoverIndex: number | null = null;
  /** A vertex row of the selected item under the pointer. */
  private vertexMark: [number, number] | null = null;
  private faceSelected: number | null = null;
  private selectNative: ((index: number | null) => void) | null = null;
  /** Follow a connection into another capture's rows. */
  onDrill: (capture: string, sel: { kind: 'point' | 'edge'; index: number }) => void = () => {};
  private selectFace: ((index: number | null) => void) | null = null;
  private sampleTimer: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    this.host.className = 'geometry-preview-panel';
    this.host.append(this.controls, this.content);
    this.host.hidden = true;
  }
  clear(): void {
    clearTimeout(this.sampleTimer);
    this.data = null;
    this.nativeSelected = this.hoverIndex = this.faceSelected = null;
    this.vertexMark = null;
    this.selectNative = this.selectFace = null;
    this.controls.replaceChildren();
    this.content.replaceChildren();
    this.host.hidden = true;
  }
  fieldControls(
    entry: InspectionEntry,
    frame: Frame,
    onSample: (options: PreviewOptions) => void,
  ): void {
    this.clear();
    this.host.hidden = false;
    const bounds = defaultFieldBounds(frame);
    const inputs = Object.entries(bounds).map(([key, value]) => {
      const label = document.createElement('label');
      label.textContent = key.replace('Min', ' min').replace('Max', ' max');
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = String(value);
      input.setAttribute('aria-label', `Field ${label.textContent}`);
      label.append(input);
      return { key, input, label };
    });
    const resolution = document.createElement('select');
    resolution.setAttribute('aria-label', 'Field resolution');
    for (const n of [16, 32, 64, 128])
      resolution.add(new Option(`${n} × ${n}`, String(n)));
    resolution.value = '32';
    const occurrence = document.createElement('select');
    occurrence.setAttribute('aria-label', 'Field occurrence');
    const count = entry.retainedOccurrences ?? 1;
    for (let i = 0; i < count; i++)
      occurrence.add(new Option(`Occurrence ${i + 1} of ${count}`, String(i)));
    occurrence.hidden = count <= 1;
    const button = document.createElement('button');
    button.textContent = 'Sample field';
    const error = document.createElement('output');
    error.className = 'field-error';
    error.setAttribute('role', 'status');
    button.onclick = () => {
      const chosen = Object.fromEntries(
        inputs.map(({ key, input }) => [
          key,
          input.value.trim() === '' ? NaN : Number(input.value),
        ]),
      ) as typeof bounds;
      if (
        !Object.values(chosen).every(Number.isFinite) ||
        chosen.xMin >= chosen.xMax ||
        chosen.yMin >= chosen.yMax
      ) {
        error.textContent = 'Enter finite bounds with min smaller than max.';
        return;
      }
      error.textContent = '';
      onSample({
        sample: true,
        bounds: chosen,
        resolution: Number(resolution.value),
        occurrence: Number(occurrence.value),
      });
    };
    for (const { input } of inputs)
      input.oninput = () => {
        clearTimeout(this.sampleTimer);
        this.sampleTimer = setTimeout(() => button.click(), 300);
      };
    resolution.onchange = occurrence.onchange = () => {
      clearTimeout(this.sampleTimer);
      button.click();
    };
    this.controls.append(
      ...inputs.map((i) => i.label),
      resolution,
      occurrence,
      button,
      error,
    );
    this.content.textContent = `${entry.kind === 'vector' ? 'Vector magnitude with direction arrows' : 'Scalar values'}, sampled at cell centres in sketch coordinates, y up. Edit the bounds or resolution to re-sample.`;
  }
  show(data: GeometryPreview): void {
    this.data = data;
    this.host.hidden = false;
    this.content.replaceChildren();
    if (data.kind === 'field') {
      this.renderField(data);
      return;
    }
    const note = document.createElement('p');
    note.className = 'inspect-hint';
    note.textContent = data.kind === 'native' && data.renderedTruncated ? `${data.note} Post-modifier ink was cut at the fragment limit.` : data.note;
    this.content.append(note);
    if (data.kind === 'native') {
      this.nativeSelected = null;
      this.rendered = data.renderedContours !== undefined;
      const modes = document.createElement('div');
      modes.className = 'segmented';
      const pre = document.createElement('button'),
        post = document.createElement('button');
      pre.textContent = 'Pre-modifier';
      pre.title = 'The native geometry with its enclosing placement, before modifiers';
      post.textContent = 'Post-modifier';
      post.disabled = data.renderedContours === undefined;
      post.title = data.renderedTruncated
        ? 'Visible ink, cut at the fragment limit — the overlay is partial'
        : 'The actual visible ink, including clipping, fills and occlusion';
      const setMode = (rendered: boolean) => {
        this.rendered = rendered;
        pre.classList.toggle('active', !rendered);
        post.classList.toggle('active', rendered);
        this.onChange();
      };
      pre.onclick = () => setMode(false);
      post.onclick = () => setMode(true);
      modes.append(pre, post);
      this.content.append(modes);
      setMode(this.rendered);
      const view = document.createElement('div');
      this.content.append(view);
      let page = 0;
      const pageSize = 50;
      const polygons = data.items.every((item) => item.kind === 'polygon');
      const listLabel = polygons ? 'polygons' : 'geometry';
      const selectItem = (index: number | null) => {
        this.nativeSelected = index;
        this.hoverIndex = null;
        this.vertexMark = null;
        showView();
        this.onChange();
      };
      this.selectNative = selectItem;
      const visibleOf = (item: NativeItem): number => item.renderedContours?.reduce((n, c) => n + c.length, 0) ?? 0;
      const maxVisible = Math.max(1, ...data.items.map(visibleOf));
      const hover = (index: number | null) => { this.hoverIndex = index; this.onChange(); };
      const showView = () => {
        view.replaceChildren();
        if (this.nativeSelected === null) {
          const title = document.createElement('p');
          title.textContent = `${data.items.length} ${listLabel} · click a row to inspect and isolate it`;
          view.append(title);
          const wrap = document.createElement('div');
          wrap.className = 'geometry-command-table geometry-object-table';
          const table = document.createElement('table'),
            header = document.createElement('tr');
          for (const text of [
            '#',
            'Type',
            'Vertices',
            'Visible',
            'Opaque',
          ]) {
            const th = document.createElement('th');
            th.textContent = text;
            header.append(th);
          }
          table.append(header);
          data.items
            .slice(page * pageSize, (page + 1) * pageSize)
            .forEach((item, offset) => {
              const index = page * pageSize + offset,
                geom = JSON.parse(item.geometry),
                opts = JSON.parse(item.options),
                tr = document.createElement('tr');
              tr.tabIndex = 0;
              tr.setAttribute('role', 'button');
              tr.setAttribute(
                'aria-label',
                `Inspect ${item.kind} ${index + 1}`,
              );
              const count =
                geom.pts?.length ??
                geom.cmds?.filter((c: { op: string }) => c.op !== 'close')
                  .length ??
                '—';
              const visible = item.renderedContours ? visibleOf(item) : null;
              for (const value of [
                index + 1,
                item.kind,
                count,
                visible ?? '—',
                opts.opaque || opts.fill ? 'yes' : 'no',
              ]) {
                const td = document.createElement('td');
                td.textContent = String(value);
                tr.append(td);
              }
              if (visible !== null) {
                const sw = document.createElement('span');
                sw.className = 'swatch';
                sw.style.background = ramp(visible / maxVisible);
                tr.cells[0].prepend(sw);
              }
              tr.onclick = () => selectItem(index);
              tr.onmouseenter = () => hover(index);
              tr.onmouseleave = () => hover(null);
              tr.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectItem(index);
                }
              };
              table.append(tr);
            });
          wrap.append(table);
          view.append(wrap);
          if (data.items.length > pageSize) {
            const pager = document.createElement('div');
            pager.className = 'geometry-object-pager';
            const prev = document.createElement('button'),
              next = document.createElement('button'),
              range = document.createElement('span');
            prev.textContent = 'Previous';
            next.textContent = 'Next';
            prev.setAttribute('aria-label', 'Previous geometries');
            next.setAttribute('aria-label', 'Next geometries');
            prev.disabled = page === 0;
            next.disabled = (page + 1) * pageSize >= data.items.length;
            prev.onclick = () => {
              page--;
              showView();
            };
            next.onclick = () => {
              page++;
              showView();
            };
            range.textContent = `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, data.items.length)} of ${data.items.length}`;
            pager.append(prev, range, next);
            view.append(pager);
          }
          return;
        }
        const item = data.items[this.nativeSelected];
        const back = document.createElement('button');
        back.textContent = `← All ${listLabel} (${data.items.length})`;
        back.onclick = () => selectItem(null);
        view.append(back);
        const title = document.createElement('h4');
        title.textContent = `${item.kind} ${this.nativeSelected + 1} · occurrence ${item.occurrence}`;
        view.append(title);
        const counts=document.createElement('p');
        counts.textContent=`Pre-modifier: ${item.contours.reduce((n,c)=>n+c.length,0)} segments · Post-modifier: ${item.renderedContours?.reduce((n,c)=>n+c.length,0) ?? 'unavailable'} visible fragments`;
        view.append(counts);
        const details = document.createElement('div');
        view.append(details);
        const opts = JSON.parse(item.options),
          geom = JSON.parse(item.geometry);
        const table = document.createElement('table');
        table.className = 'geometry-attributes';
        const row = (key: string, value: unknown) => {
          const tr = document.createElement('tr'),
            th = document.createElement('th'),
            td = document.createElement('td');
          th.textContent = key;
          td.textContent = typeof value === 'string' ? value : readable(value);
          tr.append(th, td);
          table.append(tr);
        };
        row('Geometry', item.kind);
        for (const [key, value] of Object.entries(opts)) row(key, value);
        if (!Object.keys(opts).length) row('Options', 'Defaults');
        for (const [key, value] of Object.entries(geom))
          if (key !== 'kind' && key !== 'cmds' && key !== 'pts')
            row(key, value);
        details.append(table);
        const commands = geom.cmds ?? geom.pts;
        if (commands) {
          const title = document.createElement('strong');
          title.textContent = `${commands.length} ${geom.cmds ? 'path commands' : 'vertices'} · source coordinates`;
          details.append(title);
          const wrap = document.createElement('div');
          wrap.className = 'geometry-command-table';
          const rows = document.createElement('table');
          const keys = [
            ...new Set<string>(commands.flatMap((v: object) => Object.keys(v))),
          ];
          const header = document.createElement('tr');
          for (const key of ['#', ...keys]) {
            const th = document.createElement('th');
            th.textContent = key;
            header.append(th);
          }
          rows.append(header);
          commands
            .slice(0, 200)
            .forEach((value: Record<string, unknown>, i: number) => {
              const tr = document.createElement('tr');
              if (geom.pts) {
                tr.onmouseenter = () => { this.vertexMark = vertexOf(item, i); this.onChange(); };
                tr.onmouseleave = () => { this.vertexMark = null; this.onChange(); };
              }
              for (const v of [i, ...keys.map((k) => value[k])]) {
                const td = document.createElement('td');
                td.textContent =
                  v === undefined
                    ? ''
                    : typeof v === 'string'
                      ? v
                      : readable(v);
                tr.append(td);
              }
              rows.append(tr);
            });
          wrap.append(rows);
          details.append(wrap);
          if (commands.length > 200)
            details.append('Showing the first 200 rows.');
        }
      };
      showView();
    }
    if (data.kind === 'faces') {
      const list = document.createElement('div');
      list.className = 'geometry-face-list';
      const rows: HTMLElement[] = [];
      const maxArea = Math.max(1e-9, ...data.faces.map((f) => Math.abs(f.area)));
      const select = (index: number | null) => {
        this.faceSelected = index;
        rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === index)));
        rows[index ?? -1]?.scrollIntoView({ block: 'nearest' });
        this.onChange();
      };
      this.selectFace = select;
      data.faces.forEach((f, i) => {
        const row = document.createElement('button');
        row.className = 'geometry-face-row';
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = ramp(Math.abs(f.area) / maxArea);
        row.append(sw, `face ${f.index} · area ${fmt(f.area)} · perimeter ${fmt(f.perimeter)}${f.contours.length > 1 ? ` · ${f.contours.length - 1} holes` : ''} · walls `);
        f.sourceEdges.slice(0, 12).forEach((e, k) => {
          if (k) row.append(', ');
          if (data.sourceCapture) {
            const a = document.createElement('a');
            a.textContent = String(e);
            a.title = 'This wall in the source material';
            a.onclick = (ev) => { ev.stopPropagation(); this.onDrill(data.sourceCapture!, { kind: 'edge', index: e }); };
            row.append(a);
          } else row.append(String(e));
        });
        if (f.sourceEdges.length > 12) row.append(' …');
        row.onclick = () => select(this.faceSelected === i ? null : i);
        row.onmouseenter = () => { this.hoverIndex = i; this.onChange(); };
        row.onmouseleave = () => { this.hoverIndex = null; this.onChange(); };
        rows.push(row);
        list.append(row);
      });
      this.content.append(list);
    }
  }
  private renderField(data: FieldPreview): void {
    const { resolution: n, bounds: b } = data,
      canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 330;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      'aria-label',
      'Sampled field heatmap. Arrow keys inspect cells.',
    );
    const ctx = canvas.getContext('2d')!,
      left = 43,
      top = 12,
      size = 280,
      cell = size / n;
    const ground = cssVar('--control'), check1 = cssVar('--edge-strong'), check2 = cssVar('--raised'), text = cssVar('--muted');
    const grid = () => {
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, 360, 330);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const value = data.values[y * n + x];
          ctx.fillStyle = Number.isFinite(value)
            ? fieldColor(value, data.min, data.max, data.vector)
            : (x + y) % 2
              ? check1
              : check2;
          ctx.fillRect(
            left + x * cell,
            top + (n - y - 1) * cell,
            cell + 0.25,
            cell + 0.25,
          );
        }
      if (data.vector) {
        const stride = Math.max(1, Math.ceil(n / 16));
        ctx.strokeStyle = '#ffffffcf';
        ctx.lineWidth = 1;
        for (let y = 0; y < n; y += stride)
          for (let x = 0; x < n; x += stride) {
            const i = y * n + x,
              u = data.u![i],
              v = data.v![i],
              len = Math.hypot(u, v);
            if (!Number.isFinite(len) || len === 0) continue;
            const sx = u / (b.xMax - b.xMin),
              sy = -v / (b.yMax - b.yMin),
              screenLength = Math.hypot(sx, sy);
            if (!Number.isFinite(screenLength) || screenLength === 0) continue;
            const px = left + (x + 0.5) * cell,
              py = top + (n - y - 0.5) * cell,
              dx = (sx / screenLength) * cell * stride * 0.38,
              dy = (sy / screenLength) * cell * stride * 0.38;
            ctx.beginPath();
            ctx.moveTo(px - dx, py - dy);
            ctx.lineTo(px + dx, py + dy);
            ctx.moveTo(px + dx * 0.45 - dy * 0.35, py + dy * 0.45 + dx * 0.35);
            ctx.lineTo(px + dx, py + dy);
            ctx.lineTo(px + dx * 0.45 + dy * 0.35, py + dy * 0.45 - dx * 0.35);
            ctx.stroke();
          }
      }
      ctx.fillStyle = text;
      ctx.font = `11px ${cssVar('--mono')}`;
      ctx.textAlign = 'left';
      ctx.fillText(fmt(b.xMin), left, top + size + 17);
      ctx.textAlign = 'right';
      ctx.fillText(fmt(b.xMax), left + size, top + size + 17);
      ctx.textAlign = 'center';
      ctx.fillText('x', left + size / 2, top + size + 17);
      ctx.textAlign = 'right';
      ctx.fillText(fmt(b.yMax), left - 5, top + 9);
      ctx.fillText(fmt(b.yMin), left - 5, top + size);
      ctx.fillText('y', left - 8, top + size / 2);
    };
    grid();
    const output = document.createElement('output');
    output.className = 'field-cell';
    output.setAttribute('aria-live', 'polite');
    output.textContent = 'Hover a cell, or focus the graph and use arrow keys.';
    let selectedX = 0,
      selectedY = 0;
    const read = (x: number, y: number) => {
      selectedX = x;
      selectedY = y;
      const i = y * n + x,
        px = b.xMin + ((x + 0.5) / n) * (b.xMax - b.xMin),
        py = b.yMin + ((y + 0.5) / n) * (b.yMax - b.yMin);
      output.textContent = `x ${fmt(px)} · y ${fmt(py)} · ${data.vector ? `vector (${fmt(data.u![i])}, ${fmt(data.v![i])}) · magnitude ` : 'value '}${fmt(data.values[i])}`;
      grid();
      ctx.strokeStyle = cssVar('--ink');
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left + x * cell, top + (n - y - 1) * cell, cell, cell);
    };
    canvas.onpointermove = (e) => {
      const r = canvas.getBoundingClientRect(),
        x = Math.floor(
          (((e.clientX - r.left) * canvas.width) / r.width - left) / cell,
        ),
        y =
          n -
          1 -
          Math.floor(
            (((e.clientY - r.top) * canvas.height) / r.height - top) / cell,
          );
      if (x >= 0 && x < n && y >= 0 && y < n) read(x, y);
    };
    canvas.onkeydown = (e) => {
      const steps: { [key: string]: [number, number] } = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
      };
      const d = steps[e.key];
      if (d) {
        e.preventDefault();
        read(
          Math.max(0, Math.min(n - 1, selectedX + d[0])),
          Math.max(0, Math.min(n - 1, selectedY + d[1])),
        );
      }
    };
    const legend = document.createElement('canvas');
    legend.width = 280;
    legend.height = 12;
    legend.className = 'field-legend';
    const lg = legend.getContext('2d')!;
    const diverging = !data.vector && data.min !== null && data.min < 0,
      extent = Math.max(Math.abs(data.min ?? 0), Math.abs(data.max ?? 0));
    const lo = diverging ? -extent : (data.min ?? 0),
      hi = diverging ? extent : (data.max ?? 0);
    for (let i = 0; i < 280; i++) {
      lg.fillStyle = fieldColor(
        lo + ((hi - lo) * i) / 279,
        data.min,
        data.max,
        data.vector,
      );
      lg.fillRect(i, 0, 1, 12);
    }
    const caption = document.createElement('p');
    caption.className = 'inspect-hint';
    caption.textContent = `${fmt(lo)} ${diverging ? '← 0 →' : '→'} ${fmt(hi)} · min ${data.min === null ? 'none' : fmt(data.min)} · max ${data.max === null ? 'none' : fmt(data.max)} · ${n} × ${n} in ${fmt(data.elapsedMs)} ms`
      + (data.invalid ? ` · ${data.invalid} unavailable (checkerboard)` : '') + (data.errors ? ` · ${data.errors} errors` : '')
      + (data.truncated ? ' · stopped at the time limit' : '') + (data.error ? ` · first error: ${data.error}` : '');
    if (data.min === null) {
      legend.hidden = true;
      caption.textContent = `No finite samples. ${data.invalid} unavailable (checkerboard), ${data.errors} errors.${data.error ? ` First error: ${data.error}` : ''}`;
    }
    this.content.append(canvas, output, legend, caption);
  }
  /** A click on the preview, in paper mm with a tolerance: the nearest
   * native item's outline, or the face under the point. True when it chose. */
  pick(x: number, y: number, tol: number): boolean {
    const data = this.data;
    if (!data) return false;
    if (data.kind === 'native') {
      let best = tol, hit: number | null = null;
      data.items.forEach((item, i) => {
        const contours = this.rendered ? (item.renderedContours ?? item.contours) : item.contours;
        for (const c of contours) for (const p of c) {
          const d = distToPrim(p, x, y);
          if (d < best) { best = d; hit = i; }
        }
      });
      if (hit === null && this.nativeSelected === null) return false;
      this.selectNative?.(hit);
      return true;
    }
    if (data.kind === 'faces') {
      const hit = data.faces.findIndex((f) => insideContours(f.contours, x, y));
      if (hit < 0 && this.faceSelected === null) return false;
      this.selectFace?.(hit < 0 ? null : hit);
      return true;
    }
    return false;
  }

  paint(ctx: CanvasRenderingContext2D, pxPerMm: number): void {
    const data = this.data;
    if (!data || data.kind === 'field') return;
    ctx.save();
    ctx.lineWidth = 1.8 / pxPerMm;
    if (data.kind === 'graph' && data.directions) {
      const stride = Math.max(1, Math.ceil(data.directions.length / 2000));
      for (let i = 0; i < data.directions.length; i += stride) {
        const d = data.directions[i];
        for (const [dx, dy, color] of [
          [d.tx, d.ty, cssVar('--kind-sample')],
          [d.nx, d.ny, cssVar('--kind-area')],
        ] as const) {
          const len = Math.hypot(dx, dy);
          if (!len) continue;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(
            d.x + ((dx / len) * 12) / pxPerMm,
            d.y + ((dy / len) * 12) / pxPerMm,
          );
          ctx.stroke();
        }
      }
    }
    if (data.kind === 'native') {
      // Every item in its colour (visible ink, when rendered), the selected
      // one on top in the accent, a hovered one lit; the rest step back
      // while something is selected.
      const kindColour = cssVar('--kind-path');
      const visibleOf = (item: NativeItem): number => item.renderedContours?.reduce((n, c) => n + c.length, 0) ?? 0;
      const maxVisible = Math.max(1, ...data.items.map(visibleOf));
      const contoursOf = (item: NativeItem): Prim[][] => (this.rendered ? (item.renderedContours ?? item.contours) : item.contours);
      const drawItem = (item: NativeItem, colour: string, width: number, alpha: number) => {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width / pxPerMm;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (const c of contoursOf(item)) for (const p of c) strokePrim(ctx, p);
        ctx.stroke();
      };
      const sel = this.nativeSelected;
      data.items.forEach((item, i) => {
        if (i === sel || i === this.hoverIndex) return;
        const colour = this.rendered && item.renderedContours ? ramp(visibleOf(item) / maxVisible) : kindColour;
        drawItem(item, colour, 1.6, sel === null ? 0.9 : 0.35);
      });
      if (this.hoverIndex !== null && this.hoverIndex !== sel && data.items[this.hoverIndex]) drawItem(data.items[this.hoverIndex], cssVar('--ink'), 2.2, 1);
      if (sel !== null && data.items[sel]) {
        drawItem(data.items[sel], cssVar('--bg'), 4.5, 0.9);
        drawItem(data.items[sel], cssVar('--accent'), 2.4, 1);
      }
      if (this.vertexMark) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = cssVar('--accent');
        ctx.beginPath();
        ctx.arc(this.vertexMark[0], this.vertexMark[1], 4 / pxPerMm, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = cssVar('--bg');
        ctx.lineWidth = 1.2 / pxPerMm;
        ctx.stroke();
      }
      const selected = sel === null ? data : data.items[sel];
      const contours = this.rendered ? (selected.renderedContours ?? selected.contours) : selected.contours;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = cssVar('--kind-path');
      ctx.lineWidth = 1 / pxPerMm;
      let handles = 0;
      for (const c of contours)
        for (const p of c)
          if (p.t === 'cubic' && handles++ < 300) {
            ctx.beginPath();
            ctx.moveTo(p.x0, p.y0);
            ctx.lineTo(p.c0x, p.c0y);
            ctx.moveTo(p.x1, p.y1);
            ctx.lineTo(p.c1x, p.c1y);
            ctx.stroke();
            for (const [x, y] of [
              [p.c0x, p.c0y],
              [p.c1x, p.c1y],
            ])
              ctx.fillRect(
                x - 2 / pxPerMm,
                y - 2 / pxPerMm,
                4 / pxPerMm,
                4 / pxPerMm,
              );
          }
      ctx.globalAlpha = 1;
    }
    if (data.kind === 'faces') {
      const area = cssVar('--kind-area'), accent = cssVar('--accent'), ink = cssVar('--ink');
      const maxArea = Math.max(1e-9, ...data.faces.map((f) => Math.abs(f.area)));
      data.faces.forEach((f, i) => {
        const chosen = i === this.faceSelected, lit = i === this.hoverIndex;
        ctx.beginPath();
        for (const c of f.contours) {
          if (!c.length) continue;
          ctx.moveTo(...c[0]);
          for (const p of c.slice(1)) ctx.lineTo(...p);
          ctx.closePath();
        }
        ctx.fillStyle = chosen ? accent : ramp(Math.abs(f.area) / maxArea);
        ctx.globalAlpha = chosen ? 0.45 : lit ? 0.4 : this.faceSelected === null ? 0.25 : 0.12;
        ctx.fill('evenodd');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = chosen ? accent : lit ? ink : area;
        ctx.lineWidth = (chosen || lit ? 2.2 : 1.4) / pxPerMm;
        ctx.stroke();
      });
    }
    ctx.restore();
  }
}
