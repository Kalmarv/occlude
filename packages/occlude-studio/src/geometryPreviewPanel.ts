import type { InspectionEntry } from 'occlude';
import {
  defaultFieldBounds,
  type GeometryPreview,
  type FieldPreview,
  type PreviewOptions,
} from './geometryPreview.js';
import type { Frame } from '../../occlude/src/record.js';
import type { Prim } from '../../occlude/src/prims.js';

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
  private sampleTimer: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    this.host.className = 'geometry-preview-panel';
    this.host.append(this.controls, this.content);
    this.host.hidden = true;
  }
  clear(): void {
    clearTimeout(this.sampleTimer);
    this.data = null;
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
    this.content.textContent = `${entry.kind === 'vector' ? 'Vector magnitude heatmap with arrows' : 'Scalar heatmap'}. Cell-centre samples in sketch coordinates. The graph’s y axis increases upward. Resolution and bounds changes update the grid.`;
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
    note.textContent = data.note;
    this.content.append(note);
    if (data.kind === 'native') {
      this.rendered = data.renderedContours !== undefined;
      const mode = document.createElement('select');
      mode.setAttribute('aria-label', 'Geometry overlay');
      if (data.renderedContours !== undefined)
        mode.add(new Option('Rendered result · actual position', 'rendered'));
      mode.add(new Option('Captured outlines · before modifiers', 'captured'));
      mode.value = this.rendered ? 'rendered' : 'captured';
      mode.onchange = () => {
        this.rendered = mode.value === 'rendered';
        this.onChange();
      };
      this.content.append(mode);
      const attributes = document.createElement('div');
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Geometry attributes');
      data.items.forEach((item, i) =>
        select.add(
          new Option(
            `Occurrence ${item.occurrence} · ${item.kind} ${i + 1}`,
            String(i),
          ),
        ),
      );
      const details = document.createElement('div');
      const showAttributes = () => {
        details.replaceChildren();
        const item = data.items[Number(select.value)];
        if (!item) return;
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
      select.onchange = showAttributes;
      attributes.append(select, details);
      this.content.append(attributes);
      showAttributes();
      const prims = data.contours.flat(),
        counts = { line: 0, arc: 0, cubic: 0 };
      for (const p of prims) counts[p.t]++;
      this.content.append(
        `${counts.line} lines · ${counts.arc} arcs · ${counts.cubic} cubics. Control handles shown for up to 300 cubics.`,
      );
    }
    if (data.kind === 'faces') {
      const list = document.createElement('div');
      list.className = 'geometry-face-list';
      for (const f of data.faces.slice(0, 100)) {
        const row = document.createElement('p');
        row.textContent = `Face ${f.index}: area ${fmt(f.area)}, perimeter ${fmt(f.perimeter)}, ${Math.max(0, f.contours.length - 1)} holes · source edges ${f.sourceEdges.slice(0, 24).join(', ')}${f.sourceEdges.length > 24 ? ' …' : ''}`;
        list.append(row);
      }
      if (data.faces.length > 100)
        list.append(`Showing details for 100 of ${data.faces.length} faces.`);
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
    const grid = () => {
      ctx.fillStyle = '#20242a';
      ctx.fillRect(0, 0, 360, 330);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const value = data.values[y * n + x];
          ctx.fillStyle = Number.isFinite(value)
            ? fieldColor(value, data.min, data.max, data.vector)
            : (x + y) % 2
              ? '#666b74'
              : '#383d45';
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
      ctx.fillStyle = '#c9ced5';
      ctx.font = '11px monospace';
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
      ctx.strokeStyle = '#fff';
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
    caption.textContent = `${fmt(lo)} ${diverging ? '← 0 →' : '→'} ${fmt(hi)} · sampled min ${data.min === null ? 'none' : fmt(data.min)} / max ${data.max === null ? 'none' : fmt(data.max)}. ${data.invalid} unavailable (checkerboard), ${data.errors} errors. ${n} × ${n} cell centres; ${fmt(data.elapsedMs)} ms. Peaks between samples may be missed.${data.error ? ` First error: ${data.error}` : ''}`;
    if (data.min === null) {
      legend.hidden = true;
      caption.textContent = `No finite samples. ${data.invalid} unavailable (checkerboard), ${data.errors} errors.${data.error ? ` First error: ${data.error}` : ''}`;
    }
    this.content.append(canvas, output, legend, caption);
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
          [d.tx, d.ty, '#f1b478'],
          [d.nx, d.ny, '#8dd5a8'],
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
      ctx.strokeStyle = '#cfb2ff';
      ctx.beginPath();
      const contours = this.rendered
        ? (data.renderedContours ?? data.contours)
        : data.contours;
      for (const c of contours) for (const p of c) strokePrim(ctx, p);
      ctx.stroke();
      ctx.strokeStyle = '#c8b3e788';
      ctx.fillStyle = '#dfcdff';
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
    }
    if (data.kind === 'faces') {
      ctx.fillStyle = '#91d9a744';
      ctx.strokeStyle = '#91d9a7';
      for (const f of data.faces) {
        ctx.beginPath();
        for (const c of f.contours) {
          if (!c.length) continue;
          ctx.moveTo(...c[0]);
          for (const p of c.slice(1)) ctx.lineTo(...p);
          ctx.closePath();
        }
        ctx.fill('evenodd');
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
