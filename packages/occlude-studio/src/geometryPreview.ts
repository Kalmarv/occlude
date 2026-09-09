/** Demand-driven, worker-side previews. Nothing here runs during capture. */
import {
  Material,
  material,
  stationsMaterial,
  PointSelection,
  EdgeSelection,
  Faces,
  FaceSelection,
  type InspectionEntry,
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
  type Frame,
  type Prim,
  type TransformOp,
  getInspectionValues,
  getInspectionPlacements,
  inspectionOwner,
  inspectionPrimitives,
} from 'occlude';

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
  occurrence?: number;
};
export type GraphPreview = {
  kind: 'graph';
  material: InspectionPayload;
  /** The capture this one was taken from, when that material is captured too. */
  sourceCapture?: string;
  sourcePoints?: number[];
  sourceEdges?: number[];
  /** For stations: the source edge each point row sits on. */
  sourcePointEdges?: number[];
  occurrences?: number[];
  edgeOccurrences?: number[];
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
export type NativeItem = {
  contours: Prim[][];
  shapeIds: number[];
  renderedContours?: Prim[][];
  occurrence: number;
  kind: string;
  geometry: string;
  options: string;
};
export type NativePreview = {
  kind: 'native';
  contours: Prim[][];
  shapeIds: number[];
  renderedContours?: Prim[][];
  /** The visible ink was cut at the fragment limit; post-modifier is partial. */
  renderedTruncated?: boolean;
  items: NativeItem[];
  note: string;
};
export type FacesPreview = {
  kind: 'faces';
  sourceCapture?: string;
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
  /** Sampling stopped at the time limit; cells after it are unavailable. */
  truncated?: boolean;
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
/** A field is sampled on the render worker's thread; past this the grid
 * is returned as far as it got. */
export const SAMPLE_TIME_LIMIT_MS = 1500;

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
    truncated = false,
    error: string | undefined;
  sampling: for (let y = 0; y < resolution; y++)
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
      if (performance.now() - start > SAMPLE_TIME_LIMIT_MS) {
        truncated = true;
        invalid += resolution * resolution - i - 1;
        break sampling;
      }
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
    truncated,
  };
}
/** The capture holding exactly this object, if any: the same material a
 * selection, a face collection or a run of stations was taken from. */
function captureOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const entry of getInspectionIndex()) {
    try {
      if (getInspectionValues(entry.name).includes(value)) return entry.name;
    } catch {
      // a limited capture retained nothing
    }
  }
  return undefined;
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
  const values = getInspectionValues(name),
    entry = getInspectionIndex().find((e) => e.name === name);
  if (!entry || !values.length)
    throw new Error('Capture is no longer available');
  if (entry.kind === 'scalar' || entry.kind === 'vector') {
    const index = options.occurrence ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= values.length)
      throw new Error('Field occurrence is unavailable');
    return previewValue(name, frame, options, values[index], entry);
  }
  const previews: GeometryPreview[] = [];
  let bytes = 0,
    segments = 0;
  for (const value of values) {
    const p = previewValue(name, frame, options, value, entry);
    if (p.kind === 'graph')
      bytes +=
        [
          p.material.x,
          p.material.y,
          p.material.edges,
          ...Object.values(p.material.attrs),
          ...Object.values(p.material.edgeAttrs),
        ].reduce((n, a) => n + a.byteLength, 0) +
        (p.directions?.length ?? 0) * 48;
    if (p.kind === 'native') {
      const n = p.contours.reduce((n, c) => n + c.length, 0);
      segments += n;
      bytes +=
        n * 128 +
        p.items.reduce(
          (n, i) => n + 2 * (i.geometry.length + i.options.length),
          0,
        );
    }
    if (bytes > 32 * 1024 * 1024 || segments > 20000)
      throw new Error(
        'Combined preview exceeds its 32 MiB or 20,000 segment limit',
      );
    previews.push(p);
  }
  return combinePreviews(name, previews);
}

function previewValue(
  name: string,
  frame: Frame,
  options: PreviewOptions,
  value: unknown,
  entry: InspectionEntry,
): GeometryPreview {
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
      sourceCapture: captureOf(value.source),
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
      sourceCapture: captureOf(inspectionOwner(value)),
      sourcePointEdges: stations.map((s) => s.edge),
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
      sourceCapture: captureOf(value instanceof Faces ? value.source : value instanceof FaceSelection ? value.source.source : (inspectionOwner(value) as Faces | undefined)?.source),
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
        sourceCapture: captureOf(owner),
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
  const items: NativeItem[] = [];
  let shapeCursor: number | null = null;
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
    items.push({
      occurrence: 1,
      kind:
        shape.geom.kind === 'path' &&
        shape.geom.cmds.some((c) => c.op === 'close') &&
        shape.geom.cmds.every(
          (c) => c.op === 'move' || c.op === 'line' || c.op === 'close',
        )
          ? 'polygon'
          : shape.geom.kind,
      contours: lowered,
      shapeIds: shapeCursor === null ? [] : [shapeCursor++],
      geometry: JSON.stringify(shape.geom),
      options: JSON.stringify(
        {
          ...shape.opts,
          ...(transforms.length ? { enclosing: transforms } : {}),
        },
        (_key, value) => (typeof value === 'function' ? '[function]' : value),
      ),
    });
    contours.push(...lowered);
  };
  const placements = getInspectionPlacements(value);
  for (const placement of placements.length
    ? placements
    : [{ transforms: [] }]) {
    shapeCursor = 'start' in placement ? placement.start : null;
    visit(value as Tree, [...placement.transforms], 0);
  }
  return {
    kind: 'native',
    contours,
    items,
    shapeIds: [
      ...new Set(
        placements.flatMap((p) =>
          Array.from({ length: p.end - p.start }, (_, i) => p.start + i),
        ),
      ),
    ],
    note: placements.length
      ? 'Both views use the final drawing placement. Post-modifier shows visible ink, including clipping, fills and occlusion.'
      : 'Source geometry: this value was not placed in the returned drawing. No enclosing transforms can be inferred.',
  };
}

/** Combine loop occurrences without connecting unrelated graphs or flattening attribute domains. */
function combinePreviews(
  name: string,
  previews: GeometryPreview[],
): GeometryPreview {
  const first = previews[0];
  if (previews.length === 1) return first;
  if (previews.every((p): p is NativePreview => p.kind === 'native')) {
    const contours = previews.flatMap((p) => p.contours);
    if (contours.reduce((n, c) => n + c.length, 0) > 20000)
      throw new Error('Combined preview exceeds 20,000 segments');
    return {
      kind: 'native',
      contours,
      shapeIds: [...new Set(previews.flatMap((p) => p.shapeIds))],
      items: previews.flatMap((p, i) =>
        p.items.map((item) => ({ ...item, occurrence: i + 1 })),
      ),
      note: previews[0].note,
    };
  }
  if (previews.every((p): p is FacesPreview => p.kind === 'faces'))
    return {
      kind: 'faces',
      faces: previews.flatMap((p) => p.faces),
      sourceCapture: previews[0].sourceCapture,
      note: previews[0].note,
    };
  if (!previews.every((p): p is GraphPreview => p.kind === 'graph'))
    throw new Error('This capture contains incompatible geometry kinds');
  const n = previews.reduce((n, p) => n + p.material.n, 0),
    edgeCount = previews.reduce((n, p) => n + p.material.edges.length / 2, 0);
  const pointKeys = [
      ...new Set(previews.flatMap((p) => Object.keys(p.material.attrs))),
    ],
    edgeKeys = [
      ...new Set(previews.flatMap((p) => Object.keys(p.material.edgeAttrs))),
    ];
  if (
    8 * (n * (3 + pointKeys.length) + edgeCount * (3 + edgeKeys.length)) >
    32 * 1024 * 1024
  )
    throw new Error('Combined preview exceeds 32 MiB');
  const attrs = Object.fromEntries(
      pointKeys.map((k) => [k, new Float64Array(n).fill(NaN)]),
    ),
    edgeAttrs = Object.fromEntries(
      edgeKeys.map((k) => [k, new Float64Array(edgeCount).fill(NaN)]),
    );
  const x = new Float64Array(n),
    y = new Float64Array(n),
    edges = new Uint32Array(edgeCount * 2),
    occurrences: number[] = [],
    edgeOccurrences: number[] = [];
  const sourcePoints: number[] = [],
    sourceEdges: number[] = [],
    sourcePointEdges: number[] = [];
  let pointOffset = 0,
    edgeOffset = 0;
  previews.forEach((p, i) => {
    const m = p.material;
    x.set(m.x, pointOffset);
    y.set(m.y, pointOffset);
    for (let j = 0; j < m.edges.length; j++)
      edges[edgeOffset * 2 + j] = m.edges[j] + pointOffset;
    for (const [k, v] of Object.entries(m.attrs)) attrs[k].set(v, pointOffset);
    for (const [k, v] of Object.entries(m.edgeAttrs))
      edgeAttrs[k].set(v, edgeOffset);
    for (let j = 0; j < m.n; j++) {
      occurrences.push(i + 1);
      sourcePoints.push(p.sourcePoints?.[j] ?? j);
      sourcePointEdges.push(p.sourcePointEdges?.[j] ?? -1);
    }
    for (let j = 0; j < m.edges.length / 2; j++) {
      edgeOccurrences.push(i + 1);
      sourceEdges.push(p.sourceEdges?.[j] ?? j);
    }
    pointOffset += m.n;
    edgeOffset += m.edges.length / 2;
  });
  return {
    kind: 'graph',
    material: {
      name,
      n,
      x,
      y,
      edges,
      attrs,
      edgeAttrs,
      iteration: first.kind === 'graph' ? first.material.iteration : 0,
    },
    sourceCapture: previews[0].sourceCapture,
    sourcePoints,
    sourceEdges,
    sourcePointEdges: sourcePointEdges.some((e) => e >= 0) ? sourcePointEdges : undefined,
    occurrences,
    edgeOccurrences,
    directions: previews.flatMap((p) => p.directions ?? []),
    note: 'Every occurrence, kept as separate geometry. Source coordinates; later placements are not inferred.',
  };
}
