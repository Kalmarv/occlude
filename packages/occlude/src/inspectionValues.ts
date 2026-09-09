/** Runtime classification for the inspector. No sampling or derived topology. */
import {
  Material,
  isStations,
  viewKind,
  inspectionOwner,
  type Station,
} from './material.js';
import { PointSelection, EdgeSelection } from './relation.js';
import { Faces, FaceSelection, type Face } from './faces.js';
import type { ShapeValue, GroupValue, ClipValue, InvertValue } from './api.js';

export type InspectionKind =
  | 'material'
  | 'stations'
  | 'station'
  | 'points'
  | 'edges'
  | 'faces'
  | 'face'
  | 'shape'
  | 'path'
  | 'drawing'
  | 'scalar'
  | 'vector'
  | 'contour'
  | 'vertex'
  | 'edge';
export interface ValueDescription {
  kind: InspectionKind;
  points: number;
  edges?: number;
  rows: number;
  summary: string;
}
export function describeInspectionValue(
  value: unknown,
  hint?: string,
): ValueDescription | null {
  if (value instanceof Material)
    return {
      kind: 'material',
      points: value.n,
      edges: value.edgeCount,
      rows: value.n + value.edgeCount,
      summary: `${value.n} points · ${value.edgeCount} edges`,
    };
  if (value instanceof PointSelection || value instanceof EdgeSelection) {
    const point = value instanceof PointSelection;
    return {
      kind: point ? 'points' : 'edges',
      points: point ? value.length : 0,
      edges: point ? 0 : value.length,
      rows: value.source.n + value.source.edgeCount,
      summary: `${value.length} selected ${point ? 'points' : 'edges'} · source ${value.source.n} points / ${value.source.edgeCount} edges`,
    };
  }
  if (value instanceof Faces || value instanceof FaceSelection)
    return {
      kind: 'faces',
      points: 0,
      rows:
        value instanceof Faces
          ? value.source.n + value.source.edgeCount
          : value.source.source.n + value.source.source.edgeCount,
      summary: `${value.length} faces`,
    };
  const owner = inspectionOwner(value);
  const backing =
    owner instanceof Material
      ? owner
      : owner instanceof Faces
        ? owner.source
        : null;
  const backingRows = backing ? backing.n + backing.edgeCount : 0;
  if (viewKind(value) === 'face') {
    const f = value as Face;
    return {
      kind: 'face',
      points: 0,
      rows: backingRows || f.contours.reduce((n, c) => n + c.pts.length, 0),
      summary: `Face ${f.index} · area ${f.area} · ${f.contours.length} contours`,
    };
  }
  if (viewKind(value) === 'vertex')
    return {
      kind: 'vertex',
      points: 1,
      rows: backingRows || 1,
      summary: 'Source point view',
    };
  if (viewKind(value) === 'edge')
    return {
      kind: 'edge',
      points: 2,
      edges: 1,
      rows: backingRows || 3,
      summary: 'Source edge view',
    };
  if (
    isStations(value) ||
    (hint === 'stations' && Array.isArray(value) && value.length === 0)
  )
    return {
      kind: 'stations',
      points: (value as Station[]).length,
      rows: (value as Station[]).length * 2,
      summary: `${(value as Station[]).length} oriented stations`,
    };
  if (hint === 'station' && isStations([value]))
    return {
      kind: 'station',
      points: 1,
      rows: 2,
      summary: 'One oriented station',
    };
  if (typeof value === 'function' && (hint === 'scalar' || hint === 'vector'))
    return {
      kind: hint,
      points: 0,
      rows: 1,
      summary: `${hint === 'scalar' ? 'Scalar' : 'Vector'} field`,
    };
  if (value && typeof value === 'object' && '__occludeShape' in value) {
    const s = value as ShapeValue;
    const rows =
      s.geom.kind === 'path'
        ? s.geom.cmds.length
        : s.geom.kind === 'points'
          ? s.geom.pts.length
          : 1;
    return {
      kind: s.geom.kind === 'path' ? 'path' : 'shape',
      points: 0,
      rows,
      summary: `Native ${s.geom.kind} geometry`,
    };
  }
  if (value && typeof value === 'object' && '__occludeInvert' in value)
    return describeInspectionValue((value as InvertValue).shape, 'shape');
  if (
    value &&
    typeof value === 'object' &&
    ('__occludeGroup' in value || '__occludeClip' in value)
  )
    return {
      kind: 'drawing',
      points: 0,
      rows: (value as GroupValue | ClipValue).children.length,
      summary:
        'Composed geometry · preview before clipping, fills and modifiers',
    };
  if (
    (hint === 'drawing' && Array.isArray(value)) ||
    (hint === 'shape' && Array.isArray(value))
  )
    return {
      kind: 'drawing',
      points: 0,
      rows: (value as unknown[]).length,
      summary: `${(value as unknown[]).length} drawing values`,
    };
  if (
    hint === 'contour' &&
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { pts?: unknown }).pts)
  )
    return {
      kind: 'contour',
      points: (value as { pts: unknown[] }).pts.length,
      rows: (value as { pts: unknown[] }).pts.length,
      summary: 'Polyline contour',
    };
  return null;
}
