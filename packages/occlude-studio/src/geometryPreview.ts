/** Demand-driven, worker-side previews. Nothing here runs during capture. */
import {
  Material,
  material,
  stationsMaterial,
  PointSelection,
  EdgeSelection,
  Faces,
  FaceSelection,
  getInspectionValue,
  getInspectionIndex,
  userUnitsToPaper,
  INSPECTION_LIMITS,
  type InspectionPayload,
  type Station,
  type Face,
  type ShapeValue,
  type Tree,
  type Edge,
  type Vertex,
} from 'occlude';
import { inspectionOwner } from '../../occlude/src/material.js';
import { inspectionPrimitives, type Frame } from '../../occlude/src/record.js';
import type { Prim } from '../../occlude/src/prims.js';
import type { TransformOp } from '../../occlude/src/state.js';

export type FieldBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};
export type PreviewOptions = {
  bounds?: FieldBounds;
  resolution?: number;
  sample?: boolean;
};
export type GraphPreview = {
  kind: 'graph';
  material: InspectionPayload;
  sourcePoints?: number[];
  sourceEdges?: number[];
  directions?: {
    x: number;
    y: number;
    tx: number;
    ty: number;
    nx: number;
    ny: number;
  }[];
  note: string;
};
export type NativePreview = {
  kind: 'native';
  contours: Prim[][];
  note: string;
};
export type FacesPreview = {
  kind: 'faces';
  faces: {
    index: number;
    area: number;
    perimeter: number;
    contours: [number, number][][];
    sourceEdges: number[];
  }[];
  note: string;
};
export type FieldPreview = {
  kind: 'field';
  vector: boolean;
  bounds: FieldBounds;
  resolution: number;
  values: Float64Array;
  u?: Float64Array;
  v?: Float64Array;
  min: number | null;
  max: number | null;
  invalid: number;
  errors: number;
  error?: string;
  elapsedMs: number;
};
export type GeometryPreview =
  GraphPreview | NativePreview | FacesPreview | FieldPreview;

export function defaultFieldBounds(frame: Frame): FieldBounds {
  const unit = Math.min(frame.inner.innerW, frame.inner.innerH) / 100;
  const w = frame.inner.innerW / unit,
    h = frame.inner.innerH / unit;
  return frame.origin === 'center'
    ? { xMin: -w / 2, xMax: w / 2, yMin: -h / 2, yMax: h / 2 }
    : { xMin: 0, xMax: w, yMin: 0, yMax: h };
}
export function validateFieldOptions(
  bounds: FieldBounds,
  resolution: number,
): void {
  if (![16, 32, 64, 128].includes(resolution))
    throw new Error('Choose a 16, 32, 64 or 128 cell grid');
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    !(bounds.xMin < bounds.xMax) ||
    !(bounds.yMin < bounds.yMax) ||
    !Number.isFinite(bounds.xMax - bounds.xMin) ||
    !Number.isFinite(bounds.yMax - bounds.yMin)
  )
    throw new Error('Field bounds must be finite, with min smaller than max');
}
export function sampleField(
  fn: (x: number, y: number) => unknown,
  vector: boolean,
  bounds: FieldBounds,
  resolution = 32,
): FieldPreview {
  validateFieldOptions(bounds, resolution);
  const start = performance.now(),
    values = new Float64Array(resolution * resolution).fill(NaN);
  const u = vector ? values.slice() : undefined,
    v = vector ? values.slice() : undefined;
  let min = Infinity,
    max = -Infinity,
    invalid = 0,
    errors = 0,
    error: string | undefined;
  for (let y = 0; y < resolution; y++)
    for (let x = 0; x < resolution; x++) {
      // Cell centres: hover reads exactly these samples, never calls the field.
      const px =
        bounds.xMin + ((x + 0.5) / resolution) * (bounds.xMax - bounds.xMin);
      const py =
        bounds.yMin + ((y + 0.5) / resolution) * (bounds.yMax - bounds.yMin);
      const i = y * resolution + x;
      try {
        const result = fn(px, py);
        const n =
          vector &&
          Array.isArray(result) &&
          result.length === 2 &&
          result.every((v) => typeof v === 'number' && Number.isFinite(v))
            ? Math.hypot(result[0], result[1])
            : !vector && typeof result === 'number'
              ? result
              : NaN;
        if (Number.isFinite(n)) {
          values[i] = n;
          min = Math.min(min, n);
          max = Math.max(max, n);
          if (vector) {
            u![i] = (result as number[])[0];
            v![i] = (result as number[])[1];
          }
        } else invalid++;
      } catch (e) {
        invalid++;
        errors++;
        error ??= (e instanceof Error ? e.message : String(e)).slice(0, 512);
      }
      if (performance.now() - start > 1500)
        throw new Error(
          'Field sampling exceeded 1.5 seconds; try a coarser grid or a cheaper field',
        );
    }
  return {
    kind: 'field',
    vector,
    bounds,
    resolution,
    values,
    u,
    v,
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
    invalid,
    errors,
    error,
    elapsedMs: performance.now() - start,
  };
}
function copyMaterial(name: string, m: Material): InspectionPayload {
  const arrays = [
    m.x,
    m.y,
    m.edgeList,
    ...Object.values(m.attrs),
    ...Object.values(m.edgeAttrs),
  ];
  if (arrays.reduce((n, a) => n + a.byteLength, 0) > 32 * 1024 * 1024)
    throw new Error('Preview exceeds the 32 MiB transport limit');
  return {
    name,
    n: m.n,
    x: m.x.slice(),
    y: m.y.slice(),
    edges: m.edgeList.slice(),
    attrs: Object.fromEntries(
      Object.entries(m.attrs).map(([k, v]) => [k, v.slice()]),
    ),
    edgeAttrs: Object.fromEntries(
      Object.entries(m.edgeAttrs).map(([k, v]) => [k, v.slice()]),
    ),
    iteration: m.iteration,
  };
}
export function geometryPreview(
  name: string,
  frame: Frame,
  options: PreviewOptions = {},
): GeometryPreview {
  const value = getInspectionValue(name),
    entry = getInspectionIndex().find((e) => e.name === name);
  if (!entry || value == null)
    throw new Error('Capture is no longer available');
  const toPaper = userUnitsToPaper(frame);
  if (entry.kind === 'scalar' || entry.kind === 'vector') {
    if (!options.sample)
      throw new Error('Choose Sample field to evaluate this function');
    return sampleField(
      value as (x: number, y: number) => unknown,
      entry.kind === 'vector',
      options.bounds ?? defaultFieldBounds(frame),
      options.resolution ?? 32,
    );
  }
  if (value instanceof Material)
    return {
      kind: 'graph',
      material: copyMaterial(name, value),
      note: 'Material coordinates, before enclosing drawing transforms.',
    };
  if (value instanceof PointSelection || value instanceof EdgeSelection) {
    return {
      kind: 'graph',
      material: copyMaterial(name, value.extract()),
      sourcePoints: [
        ...(value instanceof PointSelection
          ? value.indices
          : value.points.indices),
      ],
      sourceEdges: value instanceof EdgeSelection ? [...value.indices] : [],
      note: 'Selected subset. Source rows refer to this captured material state; extraction here is only a transport copy.',
    };
  }
  if (entry.kind === 'stations' || entry.kind === 'station') {
    const stations = (
      entry.kind === 'station' ? [value] : value
    ) as readonly Station[];
    const m = copyMaterial(name, stationsMaterial(stations));
    m.attrs = {};
    m.edgeAttrs = {};
    let transportBytes =
      m.x.byteLength +
      m.y.byteLength +
      m.edges.byteLength +
      stations.length * (5 * 8 + 6 * 8);
    for (const key of ['heading', 's', 'u', 'length', 'chain'] as const)
      m.attrs[`station.${key}`] = Float64Array.from(stations, (s) => s[key]);
    for (const [domain, read] of [
      ['point', (s: Station) => s.attrs],
      ['edge', (s: Station) => s.edgeAttrs],
    ] as const) {
      const keys = new Set(stations.flatMap((s) => Object.keys(read(s))));
      for (const key of keys) {
        transportBytes += stations.length * 8;
        if (transportBytes > 32 * 1024 * 1024)
          throw new Error('Preview exceeds the 32 MiB transport limit');
        m.attrs[`${domain}.${key}`] = Float64Array.from(
          stations,
          (s) => read(s)[key] ?? NaN,
        );
      }
    }
    const [ox, oy] = toPaper(0, 0);
    const directions = stations.map((s) => {
      const [x, y] = toPaper(s.x, s.y),
        [tx, ty] = toPaper(...s.tangent),
        [nx, ny] = toPaper(...s.normal);
      return { x, y, tx: tx - ox, ty: ty - oy, nx: nx - ox, ny: ny - oy };
    });
    return {
      kind: 'graph',
      material: m,
      directions,
      note: 'Orange = tangent; green = normal. Direction ticks show at most 2,000 stations; all rows remain available. Station, point and edge columns stay separate.',
    };
  }
  if (
    value instanceof Faces ||
    value instanceof FaceSelection ||
    entry.kind === 'face'
  ) {
    const faces =
      value instanceof Faces
        ? value.faces
        : value instanceof FaceSelection
          ? [...value]
          : [value as Face];
    let rows = 0;
    const output = faces.map((f) => {
      rows += f.contours.reduce((n, c) => n + c.pts.length, 0) + f.edges.length;
      if (rows > INSPECTION_LIMITS.previewRows)
        throw new Error('Face preview exceeds the row limit');
      return {
        index: f.index,
        area: f.area,
        perimeter: f.perimeter,
        contours: f.contours.map((c) => c.pts.map(([x, y]) => toPaper(x, y))),
        sourceEdges: [...f.edges.indices],
      };
    });
    return {
      kind: 'faces',
      faces: output,
      note: 'Each face retains its holes and source edge rows. Areas and perimeters are in material units.',
    };
  }
  if (entry.kind === 'vertex' || entry.kind === 'edge') {
    const owner = inspectionOwner(value);
    if (owner instanceof Material) {
      const index = (value as Vertex | Edge).index;
      const selected =
        entry.kind === 'vertex'
          ? new PointSelection(owner, [index])
          : new EdgeSelection(owner, [index]);
      return {
        kind: 'graph',
        material: copyMaterial(name, selected.extract()),
        sourcePoints: [
          ...(selected instanceof PointSelection
            ? selected.indices
            : selected.points.indices),
        ],
        sourceEdges: selected instanceof EdgeSelection ? [index] : [],
        note: 'Source view, including its original point and edge attributes. Row references belong to this captured state.',
      };
    }
  }
  if (
    entry.kind === 'vertex' ||
    entry.kind === 'edge' ||
    entry.kind === 'contour'
  ) {
    const v = value as Vertex,
      e = value as Edge,
      c = value as { pts: [number, number][]; closed: boolean };
    const m =
      entry.kind === 'vertex'
        ? material([[v.x, v.y]])
        : entry.kind === 'edge'
          ? material(
              [
                [e.a.x, e.a.y],
                [e.b.x, e.b.y],
              ],
              { edges: [[0, 1]] },
            )
          : material(c.pts, {
              edges: c.pts
                .map((_, i) => [i, (i + 1) % c.pts.length] as [number, number])
                .slice(
                  0,
                  c.closed ? c.pts.length : Math.max(0, c.pts.length - 1),
                ),
            });
    return {
      kind: 'graph',
      material: copyMaterial(name, m),
      sourcePoints:
        entry.kind === 'vertex'
          ? [v.index]
          : entry.kind === 'edge'
            ? [e.a.index, e.b.index]
            : undefined,
      sourceEdges: entry.kind === 'edge' ? [e.index] : undefined,
      note: 'Captured geometry view; row references belong to its source state.',
    };
  }
  const contours: Prim[][] = [];
  let rows = 0;
  const visit = (node: Tree, transforms: TransformOp[], depth: number) => {
    if (depth > 32)
      throw new Error('Drawing preview nesting exceeds 32 levels');
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, transforms, depth + 1);
      return;
    }
    if ('__occludeGroup' in node) {
      for (const child of node.children)
        visit(child, [...transforms, node.opts], depth + 1);
      return;
    }
    if ('__occludeClip' in node) {
      for (const child of node.children) visit(child, transforms, depth + 1);
      return;
    }
    if ('__occludeInvert' in node) {
      visit(
        (node as unknown as { shape: ShapeValue }).shape,
        transforms,
        depth + 1,
      );
      return;
    }
    const shape = node as ShapeValue;
    if (!shape.__occludeShape)
      throw new Error('This drawing value has no native geometry preview');
    const cost =
      shape.geom.kind === 'path'
        ? shape.geom.cmds.length
        : shape.geom.kind === 'points'
          ? shape.geom.pts.length
          : shape.geom.kind === 'ngon'
            ? shape.geom.sides
            : 4;
    rows += cost;
    if (rows > 20_000)
      throw new Error('Native preview exceeds 20,000 segments');
    const lowered = inspectionPrimitives(
      shape.geom,
      [...transforms, shape.opts],
      frame,
    );
    contours.push(...lowered);
  };
  visit(value as Tree, [], 0);
  return {
    kind: 'native',
    contours,
    note: 'Native arcs and cubic curves, with this value’s own transforms. Before fills, clipping, modifiers and any enclosing drawing transforms. Non-uniformly transformed arcs use the renderer’s cubic representation.',
  };
}
