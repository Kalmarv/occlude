/** Editor-independent descriptions. These describe today's API, not runtime contents. */
export const GEOMETRY_TYPES = {
  material: { label: 'Material', icon: '◇', color: 'graph', description: 'Editable points and straight connections. Native curves are not stored here.', use: '`.points` · `.edges` · `.along()` · `.steps()`\n\nDraw connections with `strokes(value)`.' },
  shape: { label: 'Shape', icon: '∿', color: 'path', description: 'Declarative drawing geometry. Its exact segment types and resolved dimensions are not determined by this type.', use: 'Return it from the sketch, compose with `group`, or convert with `t.material(shape)` / `t.sample(shape, options)`.\n\nMaterial conversion approximates curved outlines as straight connections.' },
  path: { label: 'Path', icon: '∿', color: 'path', description: 'A drawable path built from path commands.', use: 'Continue with `.lineTo()` / `.bezierTo()`, draw it, or sample its outline with `t.sample(path, options)`.' },
  drawing: { label: 'Drawing', icon: '▧', color: 'path', description: 'Composed drawing content, with ordering, transforms or clipping.', use: 'Return it from a sketch or include it in a group. Drawing composition does not imply a single connected boundary.' },
  stations: { label: 'Stations', icon: '⋮', color: 'sample', description: 'Samples along graph chains, with position, tangent, normal and source-chain distance.', use: 'Use `.map()` to place marks at each station. `heading` is radians; drawing rotations use `degrees(heading)`.\n\nConverting with `stationsMaterial()` flattens attribute domains; it is not an ownership-preserving view.' },
  station: { label: 'Station', icon: '⊥', color: 'sample', description: 'A position and orientation along a graph chain.', use: '`x`, `y`, `tangent`, `normal`, `u` and `length` describe this sample. `length` is the source chain length.\n\nUse `degrees(heading)` for drawing rotation.' },
  points: { label: 'Points · selection', icon: '⋮', color: 'graph', description: 'A point collection belonging to one material state.', use: '`.filter()` keeps source ownership; `.map()` returns an array.\n\n`.extract()` copies points and attributes without edges. Use `.inducedEdges().extract()` to keep their existing connections.' },
  edges: { label: 'Edges · selection', icon: '⌁', color: 'graph', description: 'An edge collection belonging to one material state.', use: '`.filter()` · `.groupBy()` · `.points`\n\nDraw with `strokes(value)`. `.extract()` copies selected edges, endpoints and attributes into an independent material.' },
  faces: { label: 'Faces', icon: '▱', color: 'area', description: 'Bounded areas belonging to a planar material, retaining their source relationships.', use: '`.filter()` · `.measure(field)` · `.facesOf(edge)`\n\n`.edges` includes incident walls; `.boundaryEdges` outlines the selected union. `.boundaries()` returns union contours, including holes.' },
  face: { label: 'Face', icon: '▱', color: 'area', description: 'An area in a planar material, with holes and source-edge relationships.', use: '`area` · `bounds` · `contours` · `edges`\n\nDraw its area with `polygon(face.contours, options)`. It remains attached to its source face collection.' },
  contour: { label: 'Polyline', icon: '⌁', color: 'path', description: 'Straight-segment contour points with an explicit closure flag.', use: 'Draw with `stroke(value)` or `strokes(values)`. A contour record does not carry a material’s full attribute schema or ownership.' },
  vertex: { label: 'Point', icon: '·', color: 'graph', description: 'A point view belonging to a material state, with numeric attributes.', use: '`x` · `y` · `index` and declared attributes. Source indices are not persistent IDs across edits.' },
  edge: { label: 'Edge', icon: '⌁', color: 'graph', description: 'A straight connection belonging to a material state.', use: '`a` · `b` · `length` · `attrs`\n\nIts identity can be used in edits of the owning state.' },
  scalar: { label: 'Scalar sampler', icon: '≈', color: 'field', description: 'A spatial numeric function. This type alone does not specify its units, domain or whether it represents density or distance.', use: 'Call with `(x, y)`. Consumers decide how values and absence are interpreted.' },
  vector: { label: 'Vector sampler', icon: '↗', color: 'field', description: 'A spatial function returning a two-component vector. Static typing does not prove that it has field metadata.', use: 'Use `vectorField(fn)` for custom samplers whose arrows should rotate with field transforms. Bounds and marking are not inferred from the function type.' },
} as const;

export type GeometryKind = keyof typeof GEOMETRY_TYPES;
export interface GeometryAnnotation {
  sourceStart?: number;
  sourceEnd?: number;
  expressionStart?: number;
  expressionEnd?: number;
  role: 'declaration' | 'value' | 'call';
  start: number;
  end: number;
  kind: GeometryKind;
  array: boolean;
  arrayDepth?: number;
  optional: boolean;
}
export interface GeometryAnalysis {
  version: string;
  annotations: GeometryAnnotation[];
}

export interface GeometryInspectionRequest {
  document: string;
  revision: string;
  annotation: GeometryAnnotation;
  label: string;
}
