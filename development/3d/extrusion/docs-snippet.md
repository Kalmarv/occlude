### Connected-region extrusion

`mesh.extrude(faces, offset, { key })` raises a connected selection as one
region: each connected component of the selection becomes a translated cap
with its original face and corner IDs, attributes and UVs, and every region
boundary edge (including open sheet edges and hole loops) grows one wall.
`offset` is a model vector, a callback over the frozen region (`index`,
`faces`, `normal`, `center`, `area`), or `{ distance }` along the region's
area-weighted mean normal, which is refused when the region's faces cancel.
Zero vectors and boundary-free closed shells are errors, not silent geometry.
Independent per-face extrusion remains the advanced `extrudeFaces3`.

```ts live
import { sketch, label, pen, mm } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () => {
  const sheet = plane(4, 4).subdivide(3);
  const raised = sheet.faces().filter(f => Math.hypot(f.center[0], f.center[1]) < 1.2);
  const model = sheet.extrude(raised, { distance: 0.6 }, { key: 'plateau' });
  const rim = model.faces().filter(f => f.center[2] === 0.6 && f.normal[2] > 0.9);
  const stepped = model.extrude(rim.filter(f => f.center[0] > 0), [0, 0, 0.35], { key: 'step' });
  return [
    view(stepped, { camera: orthographic({ eye: [5, 7, 6], span: 5.5 }), stroke: 'ink' }),
    label('CONNECTED EXTRUSION', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

Walls carry a side chart `key:side:<component>` with `uv = [loop fraction, 0|1]`,
so surface patterns generated on the result can address caps and walls
separately through `chart`.
