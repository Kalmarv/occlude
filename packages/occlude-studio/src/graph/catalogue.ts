/**
 * The built-in node catalogue: one entry per occlude word a graph may
 * use, generated from the public types.
 *
 *   pnpm --filter occlude-studio graph:catalogue
 *
 * Do not edit by hand. `tools/graph-catalogue.ts` reads the same program
 * the docs signatures read, and the reference pages decide where a word
 * belongs. A word whose types carry no socket is absent; the run lists
 * those words and the reason.
 */
import type { Catalogue } from './model.js';

export const CATALOGUE: Catalogue = {
  words: [
    {
      word: 'inch', module: 'occlude', receiver: null,
      import: 'inch', call: 'inch', returns: 'Number',
      page: '/docs/reference/sketch', group: 'Sketch',
      params: [
        { name: 'n', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'mm', module: 'occlude', receiver: null,
      import: 'mm', call: 'mm', returns: 'Number',
      page: '/docs/reference/sketch', group: 'Sketch',
      params: [
        { name: 'n', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ui', module: 'occlude', receiver: null,
      import: 'ui', call: 'ui', returns: 'Number',
      page: '/docs/reference/sketch', group: 'Sketch',
      params: [
        { name: 'value', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'min', takes: { socket: 'Number' }, optional: true },
          { name: 'max', takes: { socket: 'Number' }, optional: true },
          { name: 'step', takes: { socket: 'Number' }, optional: true },
          { name: 'label', control: 'text', optional: true },
          { name: 'method', control: 'menu', choices: ['akima', 'cubic', 'linear'], optional: true },
        ] },
      ],
    },
    {
      word: 'circle', module: 'occlude', receiver: null,
      import: 'circle', call: 'circle', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: false },
        { name: 'r', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'clip', module: 'occlude', receiver: null,
      import: 'clip', call: 'clip', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'region', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: false },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'dash', module: 'occlude', receiver: null,
      import: 'dash', call: 'dash', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'len', takes: { socket: 'Number' }, optional: false },
        { name: 'gap', takes: { socket: 'Number' }, optional: false },
        { name: 'offset', takes: { socket: 'Number' }, optional: true },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'decimate', module: 'occlude', receiver: null,
      import: 'decimate', call: 'decimate', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'p', takes: { socket: 'Field' }, optional: false },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'ellipse', module: 'occlude', receiver: null,
      import: 'ellipse', call: 'ellipse', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: false },
        { name: 'rx', takes: { socket: 'Number' }, optional: false },
        { name: 'ry', takes: { socket: 'Number' }, optional: false },
        { name: 'rotation', takes: { socket: 'Number' }, optional: true },
        { name: 'opts', optional: true, options: [
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'group', module: 'occlude', receiver: null,
      import: 'group', call: 'group', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'opts', optional: false, options: [
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
          { name: 'pen', control: 'text', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
        ] },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'label', module: 'occlude', receiver: null,
      import: 'label', call: 'label', returns: 'drawing',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'str', control: 'text', optional: false },
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: false },
        { name: 'h', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'unit', control: 'menu', choices: ['mm', 'user'], optional: true },
          { name: 'align', control: 'menu', choices: ['center', 'left', 'right'], optional: true },
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'labelWidth', module: 'occlude', receiver: null,
      import: 'labelWidth', call: 'labelWidth', returns: 'Number',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'str', control: 'text', optional: false },
        { name: 'h', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'line', module: 'occlude', receiver: null,
      import: 'line', call: 'line', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'x1', takes: { socket: 'Number' }, optional: false },
        { name: 'y1', takes: { socket: 'Number' }, optional: false },
        { name: 'x2', takes: { socket: 'Number' }, optional: false },
        { name: 'y2', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'mask', module: 'occlude', receiver: null,
      import: 'mask', call: 'mask', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'sv', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: false },
      ],
    },
    {
      word: 'modify', module: 'occlude', receiver: null,
      import: 'modify', call: 'modify', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'mods', control: 'text', raw: true, optional: false },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'ngon', module: 'occlude', receiver: null,
      import: 'ngon', call: 'ngon', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: false },
        { name: 'sides', takes: { socket: 'Number' }, optional: false },
        { name: 'r', takes: { socket: 'Number' }, optional: false },
        { name: 'rotation', takes: { socket: 'Number' }, optional: true },
        { name: 'opts', optional: true, options: [
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'polygon', module: 'occlude', receiver: null,
      import: 'polygon', call: 'polygon', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'contours', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'winding', control: 'menu', choices: ['nonzero', 'evenodd'], optional: true },
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'rect', module: 'occlude', receiver: null,
      import: 'rect', call: 'rect', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: false },
        { name: 'w', takes: { socket: 'Number' }, optional: false },
        { name: 'h', takes: { socket: 'Number' }, optional: false },
        { name: 'radius', takes: { socket: 'Number' }, optional: true },
        { name: 'opts', optional: true, options: [
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'roughen', module: 'occlude', receiver: null,
      import: 'roughen', call: 'roughen', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'amount', takes: { socket: 'Field' }, optional: false },
        { name: 'detail', takes: { socket: 'Number' }, optional: false },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'smooth', module: 'occlude', receiver: null,
      import: 'smooth', call: 'smooth', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'passes', takes: { socket: 'Number' }, optional: false },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'stroke', module: 'occlude', receiver: null,
      import: 'stroke', call: 'stroke', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'contour', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'strokes', module: 'occlude', receiver: null,
      import: 'strokes', call: 'strokes', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'source', takes: { socket: 'Geometry', kinds: ['shape', 'material'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'wobble', module: 'occlude', receiver: null,
      import: 'wobble', call: 'wobble', returns: 'shape',
      page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'amount', takes: { socket: 'Field' }, optional: false },
        { name: 'children', takes: { socket: 'Geometry', kinds: ['drawing'] }, optional: true },
      ],
    },
    {
      word: 'fill', module: 'occlude', receiver: null,
      import: 'fill', call: 'fill', returns: 'Fill',
      page: '/docs/reference/fills', group: 'Fills',
      params: [
        { name: 'name', control: 'text', optional: true },
        { name: 'params', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'distanceTo', module: 'occlude', receiver: null,
      import: 'distanceTo', call: 'distanceTo', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'boundary', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: false },
      ],
    },
    {
      word: 'sdf.blend', module: 'occlude', receiver: 'sdf',
      import: 'sdf', call: 'sdf.blend', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'a', takes: { socket: 'Field' }, optional: false },
        { name: 'b', takes: { socket: 'Field' }, optional: false },
        { name: 'radius', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'sdf.box', module: 'occlude', receiver: 'sdf',
      import: 'sdf', call: 'sdf.box', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'cx', takes: { socket: 'Number' }, optional: false },
        { name: 'cy', takes: { socket: 'Number' }, optional: false },
        { name: 'w', takes: { socket: 'Number' }, optional: false },
        { name: 'h', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'sdf.circle', module: 'occlude', receiver: 'sdf',
      import: 'sdf', call: 'sdf.circle', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'cx', takes: { socket: 'Number' }, optional: false },
        { name: 'cy', takes: { socket: 'Number' }, optional: false },
        { name: 'r', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'sdf.intersect', module: 'occlude', receiver: 'sdf',
      import: 'sdf', call: 'sdf.intersect', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'fields', takes: { socket: 'Field' }, optional: true },
      ],
    },
    {
      word: 'sdf.segment', module: 'occlude', receiver: 'sdf',
      import: 'sdf', call: 'sdf.segment', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'x0', takes: { socket: 'Number' }, optional: false },
        { name: 'y0', takes: { socket: 'Number' }, optional: false },
        { name: 'x1', takes: { socket: 'Number' }, optional: false },
        { name: 'y1', takes: { socket: 'Number' }, optional: false },
        { name: 'r', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'sdf.subtract', module: 'occlude', receiver: 'sdf',
      import: 'sdf', call: 'sdf.subtract', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'a', takes: { socket: 'Field' }, optional: false },
        { name: 'holes', takes: { socket: 'Field' }, optional: true },
      ],
    },
    {
      word: 'sdf.union', module: 'occlude', receiver: 'sdf',
      import: 'sdf', call: 'sdf.union', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'fields', takes: { socket: 'Field' }, optional: true },
      ],
    },
    {
      word: 't.isolines', module: 'occlude', receiver: 't',
      import: null, call: 't.isolines', returns: 'material',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'field', takes: { socket: 'Field' }, optional: false },
        { name: 'at', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'step', takes: { socket: 'Number' }, optional: true },
          { name: 'close', control: 'check', optional: true },
        ] },
      ],
    },
    {
      word: 't.ridges', module: 'occlude', receiver: 't',
      import: null, call: 't.ridges', returns: 'material',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'field', takes: { socket: 'Field' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'step', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 't.within', module: 'occlude', receiver: 't',
      import: null, call: 't.within', returns: 'faces',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'faces', takes: { socket: 'Geometry', kinds: ['faces', 'material', 'points'] }, optional: true },
        { name: 'area', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'faces', control: 'menu', choices: ['contained', 'centroid'], optional: true },
        ] },
      ],
    },
    {
      word: 't.noise', module: 'occlude', receiver: 't',
      import: null, call: 't.noise', returns: 'Number',
      page: '/docs/reference/random', group: 'Random',
      params: [
        { name: 'x', takes: { socket: 'Number' }, optional: true },
        { name: 'y', takes: { socket: 'Number' }, optional: true },
        { name: 'z', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 't.rnd', module: 'occlude', receiver: 't',
      import: null, call: 't.rnd', returns: 'Number',
      page: '/docs/reference/random', group: 'Random',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: true },
        { name: 'b', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 'add', module: 'occlude', receiver: null,
      import: 'add', call: 'add', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Vector' }, optional: false },
        { name: 'b', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'angleOf', module: 'occlude', receiver: null,
      import: 'angleOf', call: 'angleOf', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'cross', module: 'occlude', receiver: null,
      import: 'cross', call: 'cross', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Vector' }, optional: false },
        { name: 'b', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'distance', module: 'occlude', receiver: null,
      import: 'distance', call: 'distance', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Vector' }, optional: false },
        { name: 'b', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'dot', module: 'occlude', receiver: null,
      import: 'dot', call: 'dot', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Vector' }, optional: false },
        { name: 'b', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'ease.cubicIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.cubicIn', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'fromAngle', module: 'occlude', receiver: null,
      import: 'fromAngle', call: 'fromAngle', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'angle', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'length', module: 'occlude', receiver: null,
      import: 'length', call: 'length', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'limit', module: 'occlude', receiver: null,
      import: 'limit', call: 'limit', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Vector' }, optional: false },
        { name: 'max', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'map', module: 'occlude', receiver: null,
      import: 'map', call: 'map', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Number' }, optional: false },
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
        { name: 'c', takes: { socket: 'Number' }, optional: false },
        { name: 'd', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'mul', module: 'occlude', receiver: null,
      import: 'mul', call: 'mul', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Vector' }, optional: false },
        { name: 'k', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'norm', module: 'occlude', receiver: null,
      import: 'norm', call: 'norm', returns: 'Number',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Number' }, optional: false },
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'perp', module: 'occlude', receiver: null,
      import: 'perp', call: 'perp', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'sub', module: 'occlude', receiver: null,
      import: 'sub', call: 'sub', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Vector' }, optional: false },
        { name: 'b', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'sum', module: 'occlude', receiver: null,
      import: 'sum', call: 'sum', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'vs', takes: { socket: 'Vector' }, optional: true },
      ],
    },
    {
      word: 'unit', module: 'occlude', receiver: null,
      import: 'unit', call: 'unit', returns: 'Vector',
      page: '/docs/reference/math', group: 'Math',
      params: [
        { name: 'v', takes: { socket: 'Vector' }, optional: false },
      ],
    },
    {
      word: 'append', module: 'occlude', receiver: null,
      import: 'append', call: 'append', returns: 'material',
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'args', takes: { socket: 'Geometry', kinds: ['material'] }, optional: true },
      ],
    },
    {
      word: 'curve', module: 'occlude', receiver: null,
      import: 'curve', call: 'curve', returns: 'material',
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'pts', control: 'text', raw: true, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'closed', control: 'check', optional: true },
        ] },
      ],
    },
    {
      word: 'material', module: 'occlude', receiver: null,
      import: 'material', call: 'material', returns: 'material',
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'points', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
      ],
    },
    {
      word: 'Material.attribute', module: 'occlude', receiver: null,
      import: null, call: '{self}.attribute', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'name', control: 'text', optional: false },
        { name: 'value', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'transfer', control: 'menu', choices: ['interpolate', 'nearest'], optional: true },
        ] },
      ],
    },
    {
      word: 'Material.attributes', module: 'occlude', receiver: null,
      import: null, call: '{self}.attributes', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'values', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'Material.edgeAttribute', module: 'occlude', receiver: null,
      import: null, call: '{self}.edgeAttribute', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'name', control: 'text', optional: false },
        { name: 'value', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'transfer', control: 'menu', choices: ['copy', 'distribute'], optional: true },
        ] },
      ],
    },
    {
      word: 'Material.edgeAttributes', module: 'occlude', receiver: null,
      import: null, call: '{self}.edgeAttributes', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'values', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'Material.edges', module: 'occlude', receiver: null,
      import: null, call: '{self}.edges', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
      ],
    },
    {
      word: 'Material.n', module: 'occlude', receiver: null,
      import: null, call: '{self}.n', returns: 'Number',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
      ],
    },
    {
      word: 'Material.points', module: 'occlude', receiver: null,
      import: null, call: '{self}.points', returns: 'points',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
      ],
    },
    {
      word: 'Material.resample', module: 'occlude', receiver: null,
      import: null, call: '{self}.resample', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'opts', optional: false, options: [
          { name: 'spacing', takes: { socket: 'Number' }, optional: true },
          { name: 'count', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'Material.withEdges', module: 'occlude', receiver: null,
      import: null, call: '{self}.withEdges', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'pairs', control: 'text', raw: true, optional: false },
        { name: 'edgeAttributes', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 't.material', module: 'occlude', receiver: 't',
      import: null, call: 't.material', returns: 'material',
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'args', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: true },
      ],
    },
    {
      word: 't.sample', module: 'occlude', receiver: 't',
      import: null, call: 't.sample', returns: 'material',
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'shape', takes: { socket: 'Geometry', kinds: ['shape', 'curves'] }, optional: true },
        { name: 'options', optional: false, options: [
          { name: 'count', takes: { socket: 'Number' }, optional: true },
          { name: 'spacing', takes: { socket: 'Number' }, optional: true },
          { name: 'tolerance', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'snap', module: 'occlude', receiver: null,
      import: 'snap', call: 'snap', returns: 'material',
      page: '/docs/reference/points', group: 'Points',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'field', takes: { socket: 'Field' }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'radius', takes: { socket: 'Number' }, optional: false },
          { name: 'samples', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 't.quadtree', module: 'occlude', receiver: 't',
      import: null, call: 't.quadtree', returns: 'material',
      page: '/docs/reference/points', group: 'Points',
      params: [
        { name: 'points', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'capacity', takes: { socket: 'Number' }, optional: true },
          { name: 'depth', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 't.relax', module: 'occlude', receiver: 't',
      import: null, call: 't.relax', returns: 'material',
      page: '/docs/reference/points', group: 'Points',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'iterations', takes: { socket: 'Number' }, optional: true },
          { name: 'density', takes: { socket: 'Field' }, optional: true },
          { name: 'within', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: true },
          { name: 'resolution', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 't.scatter', module: 'occlude', receiver: 't',
      import: null, call: 't.scatter', returns: 'material',
      page: '/docs/reference/points', group: 'Points',
      params: [
        { name: 'field', takes: { socket: 'Field' }, optional: true },
        { name: 'opts', optional: false, options: [
          { name: 'spacing', takes: { socket: 'Number' }, optional: false },
          { name: 'within', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: true },
        ] },
      ],
    },
    {
      word: 't.settle', module: 'occlude', receiver: 't',
      import: null, call: 't.settle', returns: 'material',
      page: '/docs/reference/points', group: 'Points',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'density', takes: { socket: 'Field' }, optional: false },
          { name: 'spacing', takes: { socket: 'Number' }, optional: false },
          { name: 'iterations', takes: { socket: 'Number' }, optional: true },
          { name: 'within', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: true },
          { name: 'resolution', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 't.throw', module: 'occlude', receiver: 't',
      import: null, call: 't.throw', returns: 'material',
      page: '/docs/reference/points', group: 'Points',
      params: [
        { name: 'area', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: true },
        { name: 'opts', optional: false, options: [
          { name: 'count', takes: { socket: 'Number' }, optional: false },
          { name: 'attempts', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 't.voronoi', module: 'occlude', receiver: 't',
      import: null, call: 't.voronoi', returns: 'material',
      page: '/docs/reference/points', group: 'Points',
      params: [
        { name: 'sites', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'within', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: true },
        ] },
      ],
    },
    {
      word: 'connect.chain', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.chain', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'edgeAttributes', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'connect.nearest', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.nearest', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'count', takes: { socket: 'Number' }, optional: false },
        ] },
      ],
    },
    {
      word: 'connect.pairs', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.pairs', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'a', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'b', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'edgeAttributes', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'connect.ring', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.ring', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'edgeAttributes', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'connect.tour', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.tour', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'closed', control: 'check', optional: true },
          { name: 'candidates', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'connect.trails', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.trails', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
      ],
    },
    {
      word: 'connect.tree', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.tree', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
      ],
    },
    {
      word: 'connect.triangulate', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.triangulate', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'edgeAttributes', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'connect.unimpeded', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.unimpeded', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'room', takes: { socket: 'Field' }, optional: true },
        ] },
      ],
    },
    {
      word: 'PointSelection.complement', module: 'occlude', receiver: null,
      import: null, call: '{self}.complement', returns: 'points',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '/docs/reference/selections', group: 'Selections',
      params: [
      ],
    },
    {
      word: 'PointSelection.extract', module: 'occlude', receiver: null,
      import: null, call: '{self}.extract', returns: 'material',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '/docs/reference/selections', group: 'Selections',
      params: [
      ],
    },
    {
      word: 'PointSelection.inducedEdges', module: 'occlude', receiver: null,
      import: null, call: '{self}.inducedEdges', returns: 'material',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '/docs/reference/selections', group: 'Selections',
      params: [
      ],
    },
    {
      word: 'PointSelection.intersect', module: 'occlude', receiver: null,
      import: null, call: '{self}.intersect', returns: 'points',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '/docs/reference/selections', group: 'Selections',
      params: [
        { name: 'other', takes: { socket: 'Geometry', kinds: ['points'] }, optional: false },
      ],
    },
    {
      word: 'PointSelection.near', module: 'occlude', receiver: null,
      import: null, call: '{self}.near', returns: 'points',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '/docs/reference/selections', group: 'Selections',
      params: [
        { name: 'p', takes: { socket: 'Vector' }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'radius', takes: { socket: 'Number' }, optional: false },
        ] },
      ],
    },
    {
      word: 'PointSelection.subtract', module: 'occlude', receiver: null,
      import: null, call: '{self}.subtract', returns: 'points',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '/docs/reference/selections', group: 'Selections',
      params: [
        { name: 'other', takes: { socket: 'Geometry', kinds: ['points'] }, optional: false },
      ],
    },
    {
      word: 'PointSelection.union', module: 'occlude', receiver: null,
      import: null, call: '{self}.union', returns: 'points',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '/docs/reference/selections', group: 'Selections',
      params: [
        { name: 'other', takes: { socket: 'Geometry', kinds: ['points'] }, optional: false },
      ],
    },
    {
      word: 'Faces.boundaryEdges', module: 'occlude', receiver: null,
      import: null, call: '{self}.boundaryEdges', returns: 'material',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '/docs/reference/faces', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Faces.contours', module: 'occlude', receiver: null,
      import: null, call: '{self}.contours', returns: 'shape',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '/docs/reference/faces', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Faces.edges', module: 'occlude', receiver: null,
      import: null, call: '{self}.edges', returns: 'material',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '/docs/reference/faces', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Faces.points', module: 'occlude', receiver: null,
      import: null, call: '{self}.points', returns: 'points',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '/docs/reference/faces', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'FaceSelection.adjacent', module: 'occlude', receiver: null,
      import: null, call: '{self}.adjacent', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '/docs/reference/faces', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Material.faces', module: 'occlude', receiver: null,
      import: null, call: '{self}.faces', returns: 'faces',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/faces', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Material.planarize', module: 'occlude', receiver: null,
      import: null, call: '{self}.planarize', returns: 'material',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '/docs/reference/faces', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'envelope', module: 'occlude', receiver: null,
      import: 'envelope', call: 'envelope', returns: 'material',
      page: '/docs/reference/transforms', group: 'Transforms',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
      ],
    },
    {
      word: 'interlace', module: 'occlude', receiver: null,
      import: 'interlace', call: 'interlace', returns: 'material',
      page: '/docs/reference/transforms', group: 'Transforms',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'gap', takes: { socket: 'Number' }, optional: false },
        ] },
      ],
    },
    {
      word: 'oscillate', module: 'occlude', receiver: null,
      import: 'oscillate', call: 'oscillate', returns: 'material',
      page: '/docs/reference/transforms', group: 'Transforms',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'wavelength', takes: { socket: 'Field' }, optional: false },
          { name: 'amplitude', takes: { socket: 'Field' }, optional: false },
          { name: 'phase', takes: { socket: 'Number' }, optional: true },
          { name: 'steps', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'thicken', module: 'occlude', receiver: null,
      import: 'thicken', call: 'thicken', returns: 'material',
      page: '/docs/reference/transforms', group: 'Transforms',
      params: [
        { name: 'source', takes: { socket: 'Geometry', kinds: ['material', 'points'] }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'radius', takes: { socket: 'Number' }, optional: false },
          { name: 'tolerance', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'warp', module: 'occlude', receiver: null,
      import: 'warp', call: 'warp', returns: 'material',
      page: '/docs/reference/transforms', group: 'Transforms',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'opts', optional: false, options: [
          { name: 'from', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
          { name: 'to', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        ] },
      ],
    },
    {
      word: 'svg', module: 'occlude', receiver: null,
      import: 'svg', call: 'svg', returns: 'shape',
      page: '/docs/reference/images', group: 'Images',
      params: [
        { name: 'text', control: 'text', optional: false },
        { name: 'opts', optional: true, options: [
          { name: 'x', takes: { socket: 'Number' }, optional: true },
          { name: 'y', takes: { socket: 'Number' }, optional: true },
          { name: 'width', takes: { socket: 'Number' }, optional: true },
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
          { name: 'decimate', takes: { socket: 'Field' }, optional: true },
          { name: 'wobble', takes: { socket: 'Field' }, optional: true },
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'box', module: 'occlude/3d', receiver: null,
      import: 'box', call: 'box', returns: 'mesh',
      page: '/docs/reference/3d/primitives', group: 'Primitives',
      params: [
        { name: 'size', control: 'text', raw: true, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'cone', module: 'occlude/3d', receiver: null,
      import: 'cone', call: 'cone', returns: 'mesh',
      page: '/docs/reference/3d/primitives', group: 'Primitives',
      params: [
        { name: 'radius', takes: { socket: 'Number' }, optional: true },
        { name: 'height', takes: { socket: 'Number' }, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'segments', takes: { socket: 'Number' }, optional: true },
          { name: 'caps', control: 'check', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'cylinder', module: 'occlude/3d', receiver: null,
      import: 'cylinder', call: 'cylinder', returns: 'mesh',
      page: '/docs/reference/3d/primitives', group: 'Primitives',
      params: [
        { name: 'radius', takes: { socket: 'Number' }, optional: true },
        { name: 'height', takes: { socket: 'Number' }, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'segments', takes: { socket: 'Number' }, optional: true },
          { name: 'caps', control: 'check', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'plane', module: 'occlude/3d', receiver: null,
      import: 'plane', call: 'plane', returns: 'mesh',
      page: '/docs/reference/3d/primitives', group: 'Primitives',
      params: [
        { name: 'width', takes: { socket: 'Number' }, optional: true },
        { name: 'height', takes: { socket: 'Number' }, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'sphere', module: 'occlude/3d', receiver: null,
      import: 'sphere', call: 'sphere', returns: 'mesh',
      page: '/docs/reference/3d/primitives', group: 'Primitives',
      params: [
        { name: 'radius', takes: { socket: 'Number' }, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'segments', takes: { socket: 'Number' }, optional: true },
          { name: 'rings', takes: { socket: 'Number' }, optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'torus', module: 'occlude/3d', receiver: null,
      import: 'torus', call: 'torus', returns: 'mesh',
      page: '/docs/reference/3d/primitives', group: 'Primitives',
      params: [
        { name: 'radius', takes: { socket: 'Number' }, optional: true },
        { name: 'tubeRadius', takes: { socket: 'Number' }, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'segments', takes: { socket: 'Number' }, optional: true },
          { name: 'tubeSegments', takes: { socket: 'Number' }, optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'revolve', module: 'occlude/3d', receiver: null,
      import: 'revolve', call: 'revolve', returns: 'mesh',
      page: '/docs/reference/3d/curves', group: 'Curves and profiles',
      params: [
        { name: 'profile', control: 'text', raw: true, optional: false },
        { name: 'options', optional: true, options: [
          { name: 'segments', takes: { socket: 'Number' }, optional: true },
          { name: 'angle', takes: { socket: 'Number' }, optional: true },
          { name: 'caps', control: 'check', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'maxPoints', takes: { socket: 'Number' }, optional: true },
          { name: 'maxFaces', takes: { socket: 'Number' }, optional: true },
          { name: 'maxCapPoints', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'sweep', module: 'occlude/3d', receiver: null,
      import: 'sweep', call: 'sweep', returns: 'mesh',
      page: '/docs/reference/3d/curves', group: 'Curves and profiles',
      params: [
        { name: 'profile', control: 'text', raw: true, optional: false },
        { name: 'path', control: 'text', raw: true, optional: false },
        { name: 'options', optional: true, options: [
          { name: 'normal', takes: { socket: 'Vector' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
          { name: 'twist', takes: { socket: 'Number' }, optional: true },
          { name: 'caps', control: 'check', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'maxPoints', takes: { socket: 'Number' }, optional: true },
          { name: 'maxFaces', takes: { socket: 'Number' }, optional: true },
          { name: 'maxCapPoints', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'instanceOnFaces', module: 'occlude/3d', receiver: null,
      import: 'instanceOnFaces', call: 'instanceOnFaces', returns: 'mesh',
      page: '/docs/reference/3d/instances', group: 'Instances and sampling',
      params: [
        { name: 'prototype', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
        { name: 'faces', control: 'text', raw: true, optional: false },
        { name: 'options', optional: true, options: [
          { name: 'rotate', takes: { socket: 'Vector' }, optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'instanceOnPoints', module: 'occlude/3d', receiver: null,
      import: 'instanceOnPoints', call: 'instanceOnPoints', returns: 'mesh',
      page: '/docs/reference/3d/instances', group: 'Instances and sampling',
      params: [
        { name: 'prototype', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
        { name: 'input', control: 'text', raw: true, optional: false },
        { name: 'options', optional: true, options: [
          { name: 'rotate', takes: { socket: 'Vector' }, optional: true },
          { name: 'offset', takes: { socket: 'Vector' }, optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'orthographic', module: 'occlude/3d', receiver: null,
      import: 'orthographic', call: 'orthographic', returns: 'Camera',
      page: '/docs/reference/3d/view', group: 'View',
      params: [
        { name: 'options', optional: false, options: [
          { name: 'eye', takes: { socket: 'Vector' }, optional: false },
          { name: 'target', takes: { socket: 'Vector' }, optional: true },
          { name: 'up', takes: { socket: 'Vector' }, optional: true },
          { name: 'near', takes: { socket: 'Number' }, optional: true },
          { name: 'far', takes: { socket: 'Number' }, optional: true },
          { name: 'span', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'perspective', module: 'occlude/3d', receiver: null,
      import: 'perspective', call: 'perspective', returns: 'Camera',
      page: '/docs/reference/3d/view', group: 'View',
      params: [
        { name: 'options', optional: false, options: [
          { name: 'eye', takes: { socket: 'Vector' }, optional: false },
          { name: 'target', takes: { socket: 'Vector' }, optional: true },
          { name: 'up', takes: { socket: 'Vector' }, optional: true },
          { name: 'near', takes: { socket: 'Number' }, optional: true },
          { name: 'far', takes: { socket: 'Number' }, optional: true },
          { name: 'fovDegrees', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'view', module: 'occlude/3d', receiver: null,
      import: 'view', call: 'view', returns: 'drawing',
      page: '/docs/reference/3d/view', group: 'View',
      params: [
        { name: 'geometry', control: 'text', raw: true, optional: false },
        { name: 'options', optional: false, options: [
          { name: 'camera', takes: { socket: 'Camera' }, optional: false },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'intersections', module: 'occlude/3d', receiver: null,
      import: 'intersections', call: 'intersections', returns: 'curves',
      page: '/docs/reference/3d/surface', group: 'Surface curves',
      params: [
        { name: 'a', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: true },
        { name: 'b', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'maxPairs', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'mapSurface', module: 'occlude/3d', receiver: null,
      import: 'mapSurface', call: 'mapSurface', returns: 'curves',
      page: '/docs/reference/3d/surface', group: 'Surface curves',
      params: [
        { name: 'mesh', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
        { name: 'pattern', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'options', optional: true, options: [
          { name: 'uv', control: 'text', optional: true },
          { name: 'chartAttribute', control: 'text', optional: true },
          { name: 'chart', takes: { socket: 'Number' }, optional: true },
          { name: 'maxInputPoints', takes: { socket: 'Number' }, optional: true },
          { name: 'maxInputSegments', takes: { socket: 'Number' }, optional: true },
          { name: 'maxTriangles', takes: { socket: 'Number' }, optional: true },
          { name: 'maxCandidates', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'trace', module: 'occlude/3d', receiver: null,
      import: 'trace', call: 'trace', returns: 'curves',
      page: '/docs/reference/3d/surface', group: 'Surface curves',
      params: [
        { name: 'mesh', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
        { name: 'seeds', control: 'text', raw: true, optional: false },
        { name: 'direction', takes: { socket: 'Vector' }, optional: false },
        { name: 'options', optional: false, options: [
          { name: 'step', takes: { socket: 'Number' }, optional: false },
          { name: 'maxLength', takes: { socket: 'Number' }, optional: true },
          { name: 'maxSteps', takes: { socket: 'Number' }, optional: true },
          { name: 'creaseDegrees', takes: { socket: 'Number' }, optional: true },
          { name: 'uv', control: 'text', optional: true },
          { name: 'chartAttribute', control: 'text', optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'boundaryLoops', module: 'occlude', receiver: null,
      import: 'boundaryLoops', call: 'boundaryLoops', returns: 'shape',
      page: '', group: 'Other',
      params: [
        { name: 'input', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: false },
        { name: 'who', control: 'text', optional: false },
      ],
    },
    {
      word: 'box3', module: 'occlude', receiver: null,
      import: 'box3', call: 'box3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'size', takes: { socket: 'Vector' }, optional: true },
        { name: 'center', takes: { socket: 'Vector' }, optional: true },
      ],
    },
    {
      word: 'bridgeArg', module: 'occlude', receiver: null,
      import: 'bridgeArg', call: 'bridgeArg', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'bridge', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'bridgeGapFor', module: 'occlude', receiver: null,
      import: 'bridgeGapFor', call: 'bridgeGapFor', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'pen', control: 'text', raw: true, optional: false },
        { name: 'bridge', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'cloneSurface3', module: 'occlude', receiver: null,
      import: 'cloneSurface3', call: 'cloneSurface3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'surface', takes: { socket: 'Geometry', kinds: ['surface'] }, optional: false },
      ],
    },
    {
      word: 'curveMs', module: 'occlude', receiver: null,
      import: 'curveMs', call: 'curveMs', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'curve', control: 'text', raw: true, optional: false },
        { name: 'pulse', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'cylindricalUV', module: 'occlude/3d', receiver: null,
      import: 'cylindricalUV', call: 'cylindricalUV', returns: 'mesh',
      page: '', group: 'Other',
      params: [
        { name: 'mesh', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
        { name: 'settings', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'degrees', module: 'occlude', receiver: null,
      import: 'degrees', call: 'degrees', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'radians', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.backIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.backIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.backInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.backInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.backOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.backOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.bounceIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.bounceIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.bounceInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.bounceInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.bounceOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.bounceOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.circIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.circIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.circInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.circInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.circOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.circOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.cubicInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.cubicInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.cubicOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.cubicOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.elasticIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.elasticIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.elasticInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.elasticInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.elasticOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.elasticOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.expoIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.expoIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.expoInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.expoInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.expoOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.expoOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.linear', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.linear', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.powIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.powIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
        { name: 'p', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 'ease.powInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.powInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
        { name: 'p', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 'ease.powOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.powOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
        { name: 'p', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 'ease.quadIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quadIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quadInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quadInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quadOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quadOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quartIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quartIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quartInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quartInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quartOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quartOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quintIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quintIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quintInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quintInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.quintOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.quintOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.sinIn', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.sinIn', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.sinInOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.sinInOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.sinOut', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.sinOut', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.smooth', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.smooth', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'ease.smoother', module: 'occlude', receiver: 'ease',
      import: 'ease', call: 'ease.smoother', returns: 'Number',
      page: '', group: 'ease',
      params: [
        { name: 't', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'extrudeFaces3', module: 'occlude', receiver: null,
      import: 'extrudeFaces3', call: 'extrudeFaces3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'surface', takes: { socket: 'Geometry', kinds: ['surface'] }, optional: false },
        { name: 'selection', control: 'text', raw: true, optional: false },
        { name: 'distance', takes: { socket: 'Number' }, optional: false },
        { name: 'options', optional: false, options: [
          { name: 'operation', control: 'text', optional: false },
        ] },
      ],
    },
    {
      word: 'faces', module: 'occlude', receiver: null,
      import: 'faces', call: 'faces', returns: 'faces',
      page: '', group: 'Other',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
      ],
    },
    {
      word: 'Faces.adjacent', module: 'occlude', receiver: null,
      import: null, call: '{self}.adjacent', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Faces.at', module: 'occlude', receiver: null,
      import: null, call: '{self}.at', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'Faces',
      params: [
        { name: 'i', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'Faces.faces', module: 'occlude', receiver: null,
      import: null, call: '{self}.faces', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Faces.iteration', module: 'occlude', receiver: null,
      import: null, call: '{self}.iteration', returns: 'Number',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Faces.length', module: 'occlude', receiver: null,
      import: null, call: '{self}.length', returns: 'Number',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'Faces.source', module: 'occlude', receiver: null,
      import: null, call: '{self}.source', returns: 'material',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'Faces',
      params: [
      ],
    },
    {
      word: 'FaceSelection.at', module: 'occlude', receiver: null,
      import: null, call: '{self}.at', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
        { name: 'i', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'FaceSelection.boundaryEdges', module: 'occlude', receiver: null,
      import: null, call: '{self}.boundaryEdges', returns: 'material',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
      ],
    },
    {
      word: 'FaceSelection.contours', module: 'occlude', receiver: null,
      import: null, call: '{self}.contours', returns: 'shape',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
      ],
    },
    {
      word: 'FaceSelection.edges', module: 'occlude', receiver: null,
      import: null, call: '{self}.edges', returns: 'material',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
      ],
    },
    {
      word: 'FaceSelection.intersect', module: 'occlude', receiver: null,
      import: null, call: '{self}.intersect', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
        { name: 'other', takes: { socket: 'Geometry', kinds: ['faces'] }, optional: false },
      ],
    },
    {
      word: 'FaceSelection.iteration', module: 'occlude', receiver: null,
      import: null, call: '{self}.iteration', returns: 'Number',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
      ],
    },
    {
      word: 'FaceSelection.length', module: 'occlude', receiver: null,
      import: null, call: '{self}.length', returns: 'Number',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
      ],
    },
    {
      word: 'FaceSelection.points', module: 'occlude', receiver: null,
      import: null, call: '{self}.points', returns: 'points',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
      ],
    },
    {
      word: 'FaceSelection.source', module: 'occlude', receiver: null,
      import: null, call: '{self}.source', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
      ],
    },
    {
      word: 'FaceSelection.subtract', module: 'occlude', receiver: null,
      import: null, call: '{self}.subtract', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
        { name: 'other', takes: { socket: 'Geometry', kinds: ['faces'] }, optional: false },
      ],
    },
    {
      word: 'FaceSelection.union', module: 'occlude', receiver: null,
      import: null, call: '{self}.union', returns: 'faces',
      self: { param: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] } },
      page: '', group: 'FaceSelection',
      params: [
        { name: 'other', takes: { socket: 'Geometry', kinds: ['faces'] }, optional: false },
      ],
    },
    {
      word: 'falloff', module: 'occlude/3d', receiver: null,
      import: 'falloff', call: 'falloff', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'point', takes: { socket: 'Vector' }, optional: false },
        { name: 'options', optional: false, options: [
          { name: 'center', takes: { socket: 'Vector' }, optional: true },
          { name: 'radius', takes: { socket: 'Number' }, optional: false },
        ] },
      ],
    },
    {
      word: 'grid3', module: 'occlude', receiver: null,
      import: 'grid3', call: 'grid3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'columns', takes: { socket: 'Number' }, optional: false },
        { name: 'rows', takes: { socket: 'Number' }, optional: false },
        { name: 'size', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'h', module: 'occlude', receiver: null,
      import: 'h', call: 'h', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'n', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'invertRange', module: 'occlude', receiver: null,
      import: 'invertRange', call: 'invertRange', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'v', takes: { socket: 'Number' }, optional: false },
        { name: 'max', takes: { socket: 'Number' }, optional: false },
        { name: 'min', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 'laneThreshold', module: 'occlude/3d', receiver: null,
      import: 'laneThreshold', call: 'laneThreshold', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'lane', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'liftAt', module: 'occlude', receiver: null,
      import: 'liftAt', call: 'liftAt', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'map', control: 'text', raw: true, optional: false },
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'liftForTravel', module: 'occlude', receiver: null,
      import: 'liftForTravel', call: 'liftForTravel', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'map', control: 'text', raw: true, optional: false },
        { name: 'from', control: 'text', raw: true, optional: false },
        { name: 'to', control: 'text', raw: true, optional: false },
        { name: 'marginPulses', takes: { socket: 'Number' }, optional: false },
        { name: 'fullUpPulse', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'lineArt3', module: 'occlude', receiver: null,
      import: 'lineArt3', call: 'lineArt3', returns: 'drawing',
      page: '', group: 'Other',
      params: [
        { name: 'options', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'long', module: 'occlude', receiver: null,
      import: 'long', call: 'long', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'n', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'Material.cellOf', module: 'occlude', receiver: null,
      import: null, call: '{self}.cellOf', returns: 'faces',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '', group: 'Material',
      params: [
        { name: 'site', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'Material.edgeCount', module: 'occlude', receiver: null,
      import: null, call: '{self}.edgeCount', returns: 'Number',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '', group: 'Material',
      params: [
      ],
    },
    {
      word: 'Material.iteration', module: 'occlude', receiver: null,
      import: null, call: '{self}.iteration', returns: 'Number',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '', group: 'Material',
      params: [
      ],
    },
    {
      word: 'Material.maxDegree', module: 'occlude', receiver: null,
      import: null, call: '{self}.maxDegree', returns: 'Number',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '', group: 'Material',
      params: [
      ],
    },
    {
      word: 'Material.next', module: 'occlude', receiver: null,
      import: null, call: '{self}.next', returns: 'Number',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '', group: 'Material',
      params: [
        { name: 'v', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'Material.prev', module: 'occlude', receiver: null,
      import: null, call: '{self}.prev', returns: 'Number',
      self: { param: 'material', takes: { socket: 'Geometry', kinds: ['material'] } },
      page: '', group: 'Material',
      params: [
        { name: 'v', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.abs', module: 'occlude', receiver: null, template: 'Math.abs({a})',
      import: null, call: 'math.abs', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.add', module: 'occlude', receiver: null, template: '({a} + {b})',
      import: null, call: 'math.add', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.atan2', module: 'occlude', receiver: null, template: 'Math.atan2({y}, {x})',
      import: null, call: 'math.atan2', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'y', takes: { socket: 'Number' }, optional: false },
        { name: 'x', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.ceil', module: 'occlude', receiver: null, template: 'Math.ceil({a})',
      import: null, call: 'math.ceil', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.cos', module: 'occlude', receiver: null, template: 'Math.cos({a})',
      import: null, call: 'math.cos', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.divide', module: 'occlude', receiver: null, template: '({a} / {b})',
      import: null, call: 'math.divide', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.floor', module: 'occlude', receiver: null, template: 'Math.floor({a})',
      import: null, call: 'math.floor', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.hypot', module: 'occlude', receiver: null, template: 'Math.hypot({a}, {b})',
      import: null, call: 'math.hypot', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.log', module: 'occlude', receiver: null, template: 'Math.log({a})',
      import: null, call: 'math.log', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.max', module: 'occlude', receiver: null, template: 'Math.max({a}, {b})',
      import: null, call: 'math.max', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.min', module: 'occlude', receiver: null, template: 'Math.min({a}, {b})',
      import: null, call: 'math.min', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.multiply', module: 'occlude', receiver: null, template: '({a} * {b})',
      import: null, call: 'math.multiply', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.pi', module: 'occlude', receiver: null, value: true,
      import: null, call: 'Math.PI', returns: 'Number',
      page: '', group: 'Math',
      params: [
      ],
    },
    {
      word: 'math.power', module: 'occlude', receiver: null, template: '({a} ** {b})',
      import: null, call: 'math.power', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.remainder', module: 'occlude', receiver: null, template: '({a} % {b})',
      import: null, call: 'math.remainder', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.round', module: 'occlude', receiver: null, template: 'Math.round({a})',
      import: null, call: 'math.round', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.sign', module: 'occlude', receiver: null, template: 'Math.sign({a})',
      import: null, call: 'math.sign', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.sin', module: 'occlude', receiver: null, template: 'Math.sin({a})',
      import: null, call: 'math.sin', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.sqrt', module: 'occlude', receiver: null, template: 'Math.sqrt({a})',
      import: null, call: 'math.sqrt', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.subtract', module: 'occlude', receiver: null, template: '({a} - {b})',
      import: null, call: 'math.subtract', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'math.tan', module: 'occlude', receiver: null, template: 'Math.tan({a})',
      import: null, call: 'math.tan', returns: 'Number',
      page: '', group: 'Math',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'measureFaces3', module: 'occlude', receiver: null,
      import: 'measureFaces3', call: 'measureFaces3', returns: 'faces',
      page: '', group: 'Other',
      params: [
        { name: 'surface', takes: { socket: 'Geometry', kinds: ['surface'] }, optional: false },
      ],
    },
    {
      word: 'mesh', module: 'occlude/3d', receiver: null,
      import: 'mesh', call: 'mesh', returns: 'mesh',
      page: '', group: 'Other',
      params: [
        { name: 'positions', control: 'text', raw: true, optional: true },
        { name: 'faces', control: 'text', raw: true, optional: true },
        { name: 'options', optional: true, options: [
          { name: 'key', control: 'text', optional: true },
          { name: 'creaseAngle', takes: { socket: 'Number' }, optional: true },
          { name: 'stroke', control: 'text', optional: true },
          { name: 'fillPen', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 'planarize', module: 'occlude', receiver: null,
      import: 'planarize', call: 'planarize', returns: 'material',
      page: '', group: 'Other',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
      ],
    },
    {
      word: 'planarUV', module: 'occlude/3d', receiver: null,
      import: 'planarUV', call: 'planarUV', returns: 'mesh',
      page: '', group: 'Other',
      params: [
        { name: 'mesh', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
        { name: 'settings', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 'planDurationMs', module: 'occlude', receiver: null,
      import: 'planDurationMs', call: 'planDurationMs', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'planned', control: 'text', raw: true, optional: false },
        { name: 'accel', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'pointCloud3', module: 'occlude', receiver: null,
      import: 'pointCloud3', call: 'pointCloud3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'positions', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'PointSelection.length', module: 'occlude', receiver: null,
      import: null, call: '{self}.length', returns: 'Number',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '', group: 'PointSelection',
      params: [
      ],
    },
    {
      word: 'PointSelection.source', module: 'occlude', receiver: null,
      import: null, call: '{self}.source', returns: 'material',
      self: { param: 'points', takes: { socket: 'Geometry', kinds: ['points'] } },
      page: '', group: 'PointSelection',
      params: [
      ],
    },
    {
      word: 'primLength', module: 'occlude', receiver: null,
      import: 'primLength', call: 'primLength', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'p', control: 'text', raw: true, optional: false },
        { name: 'tol', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 'radians', module: 'occlude', receiver: null,
      import: 'radians', call: 'radians', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'degrees', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 's', module: 'occlude', receiver: null,
      import: 's', call: 's', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'n', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'settleAtLift', module: 'occlude', receiver: null,
      import: 'settleAtLift', call: 'settleAtLift', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'penDelay', takes: { socket: 'Number' }, optional: false },
        { name: 'pulse', takes: { socket: 'Number' }, optional: false },
        { name: 'm', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'snapshotSurface3', module: 'occlude', receiver: null,
      import: 'snapshotSurface3', call: 'snapshotSurface3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'surface', takes: { socket: 'Geometry', kinds: ['surface'] }, optional: false },
      ],
    },
    {
      word: 'stationsMaterial', module: 'occlude', receiver: null,
      import: 'stationsMaterial', call: 'stationsMaterial', returns: 'material',
      page: '', group: 'Other',
      params: [
        { name: 'stations', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'surface3', module: 'occlude', receiver: null,
      import: 'surface3', call: 'surface3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'positions', control: 'text', raw: true, optional: false },
        { name: 'polygons', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 't.cx', module: 'occlude', receiver: 't', value: true,
      import: null, call: 't.cx', returns: 'Number',
      page: '', group: 'Other',
      params: [
      ],
    },
    {
      word: 't.cy', module: 'occlude', receiver: 't', value: true,
      import: null, call: 't.cy', returns: 'Number',
      page: '', group: 'Other',
      params: [
      ],
    },
    {
      word: 't.height', module: 'occlude', receiver: 't', value: true,
      import: null, call: 't.height', returns: 'Number',
      page: '', group: 'Other',
      params: [
      ],
    },
    {
      word: 't.len', module: 'occlude', receiver: 't',
      import: null, call: 't.len', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'l', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 't.noisyLine', module: 'occlude', receiver: 't',
      import: null, call: 't.noisyLine', returns: 'shape',
      page: '', group: 'Other',
      params: [
        { name: 'x1', takes: { socket: 'Number' }, optional: false },
        { name: 'y1', takes: { socket: 'Number' }, optional: false },
        { name: 'x2', takes: { socket: 'Number' }, optional: false },
        { name: 'y2', takes: { socket: 'Number' }, optional: false },
        { name: 'o', control: 'text', raw: true, optional: true },
        { name: 'shapeOpts', control: 'text', raw: true, optional: true },
      ],
    },
    {
      word: 't.strokes3', module: 'occlude', receiver: 't',
      import: null, call: 't.strokes3', returns: 'shape',
      page: '', group: 'Other',
      params: [
        { name: 'runs', control: 'text', raw: true, optional: false },
        { name: 'options', optional: true, options: [
          { name: 'pass', control: 'text', optional: true },
        ] },
      ],
    },
    {
      word: 't.width', module: 'occlude', receiver: 't', value: true,
      import: null, call: 't.width', returns: 'Number',
      page: '', group: 'Other',
      params: [
      ],
    },
    {
      word: 'tourBudget', module: 'occlude', receiver: null,
      import: 'tourBudget', call: 'tourBudget', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'optimize', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 'transformSurface3', module: 'occlude', receiver: null,
      import: 'transformSurface3', call: 'transformSurface3', returns: 'surface',
      page: '', group: 'Other',
      params: [
        { name: 'surface', takes: { socket: 'Geometry', kinds: ['surface'] }, optional: false },
        { name: 'options', optional: false, options: [
          { name: 'translate', takes: { socket: 'Vector' }, optional: true },
          { name: 'rotate', takes: { socket: 'Vector' }, optional: true },
          { name: 'scale', takes: { socket: 'Vector' }, optional: true },
          { name: 'origin', takes: { socket: 'Vector' }, optional: true },
        ] },
      ],
    },
    {
      word: 'travelLiftPulse', module: 'occlude', receiver: null,
      import: 'travelLiftPulse', call: 'travelLiftPulse', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'm', control: 'text', raw: true, optional: false },
        { name: 'from', control: 'text', raw: true, optional: false },
        { name: 'to', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'voronoi', module: 'occlude', receiver: null,
      import: 'voronoi', call: 'voronoi', returns: 'material',
      page: '', group: 'Other',
      params: [
        { name: 'points', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
        { name: 'bounds', control: 'text', raw: true, optional: false },
      ],
    },
    {
      word: 'w', module: 'occlude', receiver: null,
      import: 'w', call: 'w', returns: 'Number',
      page: '', group: 'Other',
      params: [
        { name: 'n', takes: { socket: 'Number' }, optional: false },
      ],
    },
  ],
  importable: [
    { module: 'occlude', names: [
      { name: 'add', spec: 'add' }, { name: 'angleOf', spec: 'angleOf' }, { name: 'append', spec: 'append' }, { name: 'applyShader', spec: 'applyShader' },
      { name: 'assetTable', spec: 'assetTable' }, { name: 'banding', spec: 'banding' }, { name: 'bindToolkit', spec: 'bindToolkit' }, { name: 'boundaryLoops', spec: 'boundaryLoops' },
      { name: 'box3', spec: 'box3' }, { name: 'bridgeArg', spec: 'bridgeArg' }, { name: 'bridgeGapFor', spec: 'bridgeGapFor' }, { name: 'BUILTIN_FILL_NAMES', spec: 'BUILTIN_FILL_NAMES' },
      { name: 'canonicalJson', spec: 'canonicalJson' }, { name: 'cellCentre', spec: 'cellCentre' }, { name: 'chainsBounds', spec: 'chainsBounds' }, { name: 'checkDrawRequest', spec: 'checkDrawRequest' },
      { name: 'circle', spec: 'circle' }, { name: 'clip', spec: 'clip' }, { name: 'cloneSurface3', spec: 'cloneSurface3' }, { name: 'commitCamera3', spec: 'commitCamera3' },
      { name: 'compileSketch', spec: 'compileSketch' }, { name: 'compileSketchAsync', spec: 'compileSketchAsync' }, { name: 'components', spec: 'components' }, { name: 'connect', spec: 'connect' },
      { name: 'constructStrokes3', spec: 'constructStrokes3' }, { name: 'cross', spec: 'cross' }, { name: 'curl', spec: 'curl' }, { name: 'curve', spec: 'curve' },
      { name: 'curveMs', spec: 'curveMs' }, { name: 'customFill', spec: 'customFill' }, { name: 'dash', spec: 'dash' }, { name: 'decimate', spec: 'decimate' },
      { name: 'decodePlanBuffer', spec: 'decodePlanBuffer' }, { name: 'decodeRender', spec: 'decodeRender' }, { name: 'DEFAULT_INPUTS', spec: 'DEFAULT_INPUTS' }, { name: 'DEFAULT_PAPERS', spec: 'DEFAULT_PAPERS' },
      { name: 'DEFAULT_PENS', spec: 'DEFAULT_PENS' }, { name: 'deform', spec: 'deform' }, { name: 'degrees', spec: 'degrees' }, { name: 'distance', spec: 'distance' },
      { name: 'distanceTo', spec: 'distanceTo' }, { name: 'DOC_PAGES', spec: 'DOC_PAGES' }, { name: 'docsPaper', spec: 'docsPaper' }, { name: 'dot', spec: 'dot' },
      { name: 'DRAW_HOOK', spec: 'DRAW_HOOK' }, { name: 'drawFragments', spec: 'drawFragments' }, { name: 'drawing3', spec: 'drawing3' }, { name: 'ease', spec: 'ease' },
      { name: 'EdgeSelection', spec: 'EdgeSelection' }, { name: 'EdgeSelection3', spec: 'EdgeSelection3' }, { name: 'editEdges3', spec: 'editEdges3' }, { name: 'editPoints3', spec: 'editPoints3' },
      { name: 'ellipse', spec: 'ellipse' }, { name: 'encodePlanBuffer', spec: 'encodePlanBuffer' }, { name: 'encodeScene', spec: 'encodeScene' }, { name: 'encodeToolpath', spec: 'encodeToolpath' },
      { name: 'envelope', spec: 'envelope' }, { name: 'estimatePlanMs', spec: 'estimatePlanMs' }, { name: 'evalPrim', spec: 'evalPrim' }, { name: 'Execution', spec: 'Execution' },
      { name: 'exportCollisions', spec: 'exportCollisions' }, { name: 'exportGcode', spec: 'exportGcode' }, { name: 'exportPng', spec: 'exportPng' }, { name: 'exportSvg', spec: 'exportSvg' },
      { name: 'extent', spec: 'extent' }, { name: 'extrudeFaces3', spec: 'extrudeFaces3' }, { name: 'FaceMeasurements', spec: 'FaceMeasurements' }, { name: 'faces', spec: 'faces' },
      { name: 'Faces', spec: 'Faces' }, { name: 'FaceSelection', spec: 'FaceSelection' }, { name: 'FaceSelection3', spec: 'FaceSelection3' }, { name: 'FeatureKind3', spec: 'FeatureKind3' },
      { name: 'FeatureSelection3', spec: 'FeatureSelection3' }, { name: 'fill', spec: 'fill' }, { name: 'FILL_NAME_RE', spec: 'FILL_NAME_RE' }, { name: 'fillAsset', spec: 'fillAsset' },
      { name: 'fillTable', spec: 'fillTable' }, { name: 'fitDuration', spec: 'fitDuration' }, { name: 'force', spec: 'force' }, { name: 'formatSeed', spec: 'formatSeed' },
      { name: 'fromAngle', spec: 'fromAngle' }, { name: 'GpuSceneCompute3', spec: 'GpuSceneCompute3' }, { name: 'grad', spec: 'grad' }, { name: 'grid3', spec: 'grid3' },
      { name: 'group', spec: 'group' }, { name: 'h', spec: 'h' }, { name: 'hashPlan', spec: 'hashPlan' }, { name: 'hatch3', spec: 'hatch3' },
      { name: 'inch', spec: 'inch' }, { name: 'inheritEdge', spec: 'inheritEdge' }, { name: 'initOcclude', spec: 'initOcclude' }, { name: 'inspectHook', spec: 'inspectHook' },
      { name: 'interlace', spec: 'interlace' }, { name: 'invert', spec: 'invert' }, { name: 'invertRange', spec: 'invertRange' }, { name: 'isBuiltinFill', spec: 'isBuiltinFill' },
      { name: 'isLineArt3', spec: 'isLineArt3' }, { name: 'isSketch', spec: 'isSketch' }, { name: 'isSketchAsync', spec: 'isSketchAsync' }, { name: 'isStations', spec: 'isStations' },
      { name: 'label', spec: 'label' }, { name: 'labelWidth', spec: 'labelWidth' }, { name: 'Len', spec: 'Len' }, { name: 'length', spec: 'length' },
      { name: 'liftAt', spec: 'liftAt' }, { name: 'liftForTravel', spec: 'liftForTravel' }, { name: 'liftMapFromCounts', spec: 'liftMapFromCounts' }, { name: 'limit', spec: 'limit' },
      { name: 'line', spec: 'line' }, { name: 'lineArt3', spec: 'lineArt3' }, { name: 'liveExampleToJs', spec: 'liveExampleToJs' }, { name: 'loadFillModule', spec: 'loadFillModule' },
      { name: 'long', spec: 'long' }, { name: 'makePlan', spec: 'makePlan' }, { name: 'map', spec: 'map' }, { name: 'mask', spec: 'mask' },
      { name: 'material', spec: 'material' }, { name: 'Material', spec: 'Material' }, { name: 'meanBy', spec: 'meanBy' }, { name: 'measureFaces3', spec: 'measureFaces3' },
      { name: 'mm', spec: 'mm' }, { name: 'modify', spec: 'modify' }, { name: 'moduleName', spec: 'moduleName' }, { name: 'mul', spec: 'mul' },
      { name: 'neighbours', spec: 'neighbours' }, { name: 'ngon', spec: 'ngon' }, { name: 'norm', spec: 'norm' }, { name: 'numericLoops', spec: 'numericLoops' },
      { name: 'openPlan', spec: 'openPlan' }, { name: 'oscillate', spec: 'oscillate' }, { name: 'ownedBy', spec: 'ownedBy' }, { name: 'paper', spec: 'paper' },
      { name: 'paperModel', spec: 'paperModel' }, { name: 'PAPERS', spec: 'PAPERS' }, { name: 'paperSize', spec: 'paperSize' }, { name: 'parseCounts', spec: 'parseCounts' },
      { name: 'parseLiveMeta', spec: 'parseLiveMeta' }, { name: 'parseSeed', spec: 'parseSeed' }, { name: 'parseToolpath', spec: 'parseToolpath' }, { name: 'path', spec: 'path' },
      { name: 'PathValue', spec: 'PathValue' }, { name: 'pen', spec: 'pen' }, { name: 'penModel', spec: 'penModel' }, { name: 'pensToJson', spec: 'pensToJson' },
      { name: 'perp', spec: 'perp' }, { name: 'plan', spec: 'plan' }, { name: 'PLAN_SCHEMA', spec: 'PLAN_SCHEMA' }, { name: 'planarize', spec: 'planarize' },
      { name: 'planAsBuffers', spec: 'planAsBuffers' }, { name: 'planBuffer', spec: 'planBuffer' }, { name: 'planDurationMs', spec: 'planDurationMs' }, { name: 'planGcode', spec: 'planGcode' },
      { name: 'planPolyline', spec: 'planPolyline' }, { name: 'planSchedule', spec: 'planSchedule' }, { name: 'planSettings', spec: 'planSettings' }, { name: 'planSvg', spec: 'planSvg' },
      { name: 'planToolpath', spec: 'planToolpath' }, { name: 'planValue', spec: 'planValue' }, { name: 'pointCloud3', spec: 'pointCloud3' }, { name: 'PointSelection', spec: 'PointSelection' },
      { name: 'PointSelection3', spec: 'PointSelection3' }, { name: 'polygon', spec: 'polygon' }, { name: 'primLength', spec: 'primLength' }, { name: 'probeExpression', spec: 'probeExpression' },
      { name: 'profileToJson', spec: 'profileToJson' }, { name: 'query', spec: 'query' }, { name: 'radians', spec: 'radians' }, { name: 'range', spec: 'range' },
      { name: 'rect', spec: 'rect' }, { name: 'refineLiftMap', spec: 'refineLiftMap' }, { name: 'render', spec: 'render' }, { name: 'renderAsync', spec: 'renderAsync' },
      { name: 'renderEncoded', spec: 'renderEncoded' }, { name: 'resolveDraw', spec: 'resolveDraw' }, { name: 'resolveFill', spec: 'resolveFill' }, { name: 'rotate', spec: 'rotate' },
      { name: 'roughen', spec: 'roughen' }, { name: 'rulings', spec: 'rulings' }, { name: 's', spec: 's' }, { name: 'scale', spec: 'scale' },
      { name: 'scanAssetNames', spec: 'scanAssetNames' }, { name: 'scanFillNames', spec: 'scanFillNames' }, { name: 'scanUiControls', spec: 'scanUiControls' }, { name: 'schedulePlan', spec: 'schedulePlan' },
      { name: 'sdf', spec: 'sdf' }, { name: 'section3', spec: 'section3' }, { name: 'segmentRuns', spec: 'segmentRuns' }, { name: 'segmentsToBlocks', spec: 'segmentsToBlocks' },
      { name: 'selectAll', spec: 'selectAll' }, { name: 'selectChains', spec: 'selectChains' }, { name: 'selectedFlat', spec: 'selectedFlat' }, { name: 'selectProgress', spec: 'selectProgress' },
      { name: 'selectTime', spec: 'selectTime' }, { name: 'SETTLE_FLOOR_MS', spec: 'SETTLE_FLOOR_MS' }, { name: 'settleAtLift', spec: 'settleAtLift' }, { name: 'shader', spec: 'shader' },
      { name: 'shaper', spec: 'shaper' }, { name: 'siteId', spec: 'siteId' }, { name: 'sketch', spec: 'sketch' }, { name: 'sketchAsync', spec: 'sketchAsync' },
      { name: 'smooth', spec: 'smooth' }, { name: 'snap', spec: 'snap' }, { name: 'snapshotSurface3', spec: 'snapshotSurface3' }, { name: 'standaloneEstimate', spec: 'standaloneEstimate' },
      { name: 'stationsMaterial', spec: 'stationsMaterial' }, { name: 'stepsSurface3', spec: 'stepsSurface3' }, { name: 'stroke', spec: 'stroke' }, { name: 'strokes', spec: 'strokes' },
      { name: 'sub', spec: 'sub' }, { name: 'subPrim', spec: 'subPrim' }, { name: 'sum', spec: 'sum' }, { name: 'sumBy', spec: 'sumBy' },
      { name: 'sumForces', spec: 'sumForces' }, { name: 'surface3', spec: 'surface3' }, { name: 'svg', spec: 'svg' }, { name: 'synth', spec: 'synth' },
      { name: 'tagDraws', spec: 'tagDraws' }, { name: 'thicken', spec: 'thicken' }, { name: 'times', spec: 'times' }, { name: 'tourBudget', spec: 'tourBudget' },
      { name: 'tracePrim', spec: 'tracePrim' }, { name: 'transformSurface3', spec: 'transformSurface3' }, { name: 'translate', spec: 'translate' }, { name: 'travelLiftPulse', spec: 'travelLiftPulse' },
      { name: 'ui', spec: 'ui' }, { name: 'unit', spec: 'unit' }, { name: 'userModules', spec: 'userModules' }, { name: 'userUnitsToPaper', spec: 'userUnitsToPaper' },
      { name: 'vectorField', spec: 'vectorField' }, { name: 'voronoi', spec: 'voronoi' }, { name: 'w', spec: 'w' }, { name: 'warp', spec: 'warp' },
      { name: 'within', spec: 'within' }, { name: 'wobble', spec: 'wobble' },
    ] },
    { module: 'occlude/3d', names: [
      { name: 'across', spec: 'across' }, { name: 'alignAxis', spec: 'alignAxis' }, { name: 'AsyncQueryBatch', spec: 'AsyncQueryBatch' }, { name: 'axisAngle', spec: 'axisAngle' },
      { name: 'box', spec: 'box' }, { name: 'circle3', spec: 'circle as circle3' }, { name: 'Collection', spec: 'Collection' }, { name: 'cone', spec: 'cone' },
      { name: 'curvature', spec: 'curvature' }, { name: 'curve3', spec: 'curve as curve3' }, { name: 'CurveEdit', spec: 'CurveEdit' }, { name: 'CurveGeometry', spec: 'CurveGeometry' },
      { name: 'CurveSamples', spec: 'CurveSamples' }, { name: 'cylinder', spec: 'cylinder' }, { name: 'cylindricalUV', spec: 'cylindricalUV' }, { name: 'falloff', spec: 'falloff' },
      { name: 'force3', spec: 'force as force3' }, { name: 'gradient', spec: 'gradient' }, { name: 'grid', spec: 'grid' }, { name: 'instanceOnFaces', spec: 'instanceOnFaces' },
      { name: 'instanceOnPoints', spec: 'instanceOnPoints' }, { name: 'Instances', spec: 'Instances' }, { name: 'intersections', spec: 'intersections' }, { name: 'isolines', spec: 'isolines' },
      { name: 'laneThreshold', spec: 'laneThreshold' }, { name: 'light', spec: 'light' }, { name: 'mapSurface', spec: 'mapSurface' }, { name: 'mesh', spec: 'mesh' },
      { name: 'Mesh', spec: 'Mesh' }, { name: 'MeshCorners', spec: 'MeshCorners' }, { name: 'MeshEdges', spec: 'MeshEdges' }, { name: 'MeshEdit', spec: 'MeshEdit' },
      { name: 'MeshFaces', spec: 'MeshFaces' }, { name: 'MeshPoints', spec: 'MeshPoints' }, { name: 'orthographic', spec: 'orthographic' }, { name: 'perspective', spec: 'perspective' },
      { name: 'planarUV', spec: 'planarUV' }, { name: 'plane', spec: 'plane' }, { name: 'pointCloud', spec: 'pointCloud' }, { name: 'PointEdit', spec: 'PointEdit' },
      { name: 'PointGeometry', spec: 'PointGeometry' }, { name: 'polyline', spec: 'polyline' }, { name: 'PreparedQuery', spec: 'PreparedQuery' }, { name: 'ProjectedCurves', spec: 'ProjectedCurves' },
      { name: 'query3', spec: 'query as query3' }, { name: 'QueryBatch', spec: 'QueryBatch' }, { name: 'revolve', spec: 'revolve' }, { name: 'Rotation', spec: 'Rotation' },
      { name: 'sphere', spec: 'sphere' }, { name: 'style', spec: 'style' }, { name: 'SurfaceCurves', spec: 'SurfaceCurves' }, { name: 'SurfaceSamples', spec: 'SurfaceSamples' },
      { name: 'sweep', spec: 'sweep' }, { name: 'torus', spec: 'torus' }, { name: 'trace', spec: 'trace' }, { name: 'v3', spec: 'v3' },
      { name: 'view', spec: 'view' },
    ] },
  ],
  importableTypes: [
    { module: 'occlude', names: [
      'AssetPixels', 'AssetTable', 'AsyncSketchDef', 'Attributes3', 'Boundary', 'Bounds',
      'Camera3', 'CellGeometry', 'ChildInterval', 'ChildSpec', 'ClassifiedFeature3', 'ClassifiedScene3',
      'ClipValue', 'CompileConfig', 'Components', 'Contour', 'Corner', 'Crossing',
      'Curve', 'CustomFillFn', 'CustomPrimitive', 'DeformOptions3', 'DistanceField', 'DrawEntry',
      'DrawHook', 'DrawRequest', 'DrawSite', 'DrawTiming', 'Drawing3', 'DrawingPlan',
      'Edge', 'EdgeMeasure3', 'EdgeQuery', 'EdgeRef', 'EdgeTransfer', 'EncodedScene',
      'EstimateOpts', 'EventCandidate', 'ExecutionInputs', 'ExportOptions', 'Face', 'FaceMeasure',
      'Feature3', 'FieldAlign', 'FieldFn', 'FillAnchor', 'FillAssetDef', 'FillCtx',
      'FillRegion', 'FillSpec', 'FillTable', 'FirstHit', 'FitResult', 'FlatChain',
      'Fragment', 'GcodeJob', 'GroupOpts', 'GroupValue', 'Handle', 'HatchFamily3',
      'HatchSource3', 'ImageChannel', 'ImagePlacement', 'ImageSampler', 'InspectionEntry', 'InspectionPayload',
      'InterlaceOpts', 'InvertValue', 'IsoContour', 'IsoOpts', 'L', 'LabelOpts',
      'LiftMap', 'LiftModel', 'LineArtOptions3', 'LineArtScene3', 'LineSet3', 'LiveMeta',
      'MachineProfileTS', 'MeasureOpts', 'ModelingProgress3', 'ModelingStats3', 'ModifierValue', 'MotionBlock',
      'MotionLimits', 'NearestHit', 'NearestQuery3', 'NeighbourStats', 'Next', 'OscillateAmount',
      'OscillateOpts', 'Paper', 'PaperChoice', 'PaperDef', 'PaperFrame3', 'PaperSpec',
      'ParsedSeed', 'PenDef', 'PenTiming', 'PlanChain', 'PlanEstimate', 'PlanOptions',
      'PlanSchedule', 'PlanSelection', 'PlanSettings', 'PlanarEvent', 'PlanarizeOpts', 'PlannedSegment',
      'Point', 'PointEdit3', 'PointMeasure3', 'PointsLike', 'PolygonOpts', 'Prepared',
      'Prim', 'ProbeSummary', 'ProgressListener3', 'QuadtreeOpts', 'RandomStream', 'RawRender',
      'RayQuery3', 'Ref', 'RelaxOpts', 'RenderOptions', 'RenderResult', 'ReplaceOpts',
      'ResolvedDraw', 'RidgeContour', 'RidgeOpts', 'RulingOpts', 'ScatterOpts', 'SceneCompute3',
      'SectionPlane3', 'SegmentRun', 'SettleOpts', 'SettleParent', 'SettlePoint', 'ShaderValue',
      'ShapeOpts', 'ShapeValue', 'Shaper', 'ShaperOpts', 'ShaperPoint', 'Sites',
      'SketchConfig', 'SketchDef', 'SketchOptions', 'SnapField', 'SnapOpts', 'Snapshot',
      'Sources', 'SplitOpts', 'StageEvent3', 'StageListener3', 'Station', 'StepRule',
      'StepsOptions', 'StreamOpts', 'Stroke3', 'StrokeCtx', 'StrokeInk', 'StrokeProgram',
      'StrokeReference3', 'Surface3', 'SurfaceCorner3', 'SurfaceCurvePoint3', 'SurfaceCurveSegment3', 'SurfaceCurves3',
      'SurfaceHit3', 'SurfaceObject3', 'SurfaceQueryInput3', 'SurfaceQueryResult3', 'SynthBounds', 'SynthFn',
      'SynthOpts', 'SynthStats', 'ThickenOpts', 'ThrowOpts', 'TimeSelection', 'Toolkit',
      'TrailsOpts', 'Transfer', 'TransferPolicy', 'TransformOp', 'Tree', 'UiControl',
      'UiOpts', 'Vec', 'Vec3', 'VectorFieldFn', 'Vertex', 'VoronoiLinks',
      'WarpFn', 'WarpOpts', 'WasmModule', 'Winding', 'WireObject3', 'WithinFaces',
      'XY', 'YAxis',
    ] },
    { module: 'occlude/3d', names: [
      'AlignAxisOptions', 'AttributeFields', 'AttributeOptions', 'Axis3', 'CameraOptions', 'ChartFrame',
      'CornerRow', 'CurveOptions', 'CurveRule', 'CurveSample', 'CurveSampleRow', 'CurveSamplingOptions',
      'CurveSnapshot', 'CylindricalUVOptions', 'DirectionField', 'DirectionInput', 'EdgeAttributes', 'EdgeRow',
      'ExtrudeOffset', 'ExtrudeOptions', 'ExtrudeRegion', 'FaceRow', 'Field', 'Force',
      'GeometryOptions', 'GridOptions', 'HatchAttributes', 'HatchFamily', 'HatchInput', 'HatchOptions',
      'HatchStats', 'InstanceOnFacesOptions', 'InstanceOnPointsOptions', 'InstanceRow', 'InstanceTransform', 'InstanceTransformInput',
      'IntersectionAttributes', 'IntersectionInput', 'IntersectionOptions', 'IsolineAttributes', 'IsolineField', 'IsolineLevels',
      'IsolineOptions', 'MappedAttributes', 'MeshCornerRow', 'MeshEdgeRow', 'MeshFaceRow', 'MeshPointRow',
      'MeshRule', 'MeshSnapshot', 'NearestBatchOptions', 'NearestOptions', 'PlanarUVOptions', 'PointLike3',
      'PointRow', 'PointRule', 'PointSnapshot', 'PolylineOptions', 'Position3', 'ProjectedCurve',
      'ProjectedLines', 'ProjectedStrokeOptions', 'Quaternion3', 'QueryResult', 'QueryResults', 'RadialOptions',
      'RayBatchOptions', 'RayHit', 'RayOptions', 'RealizeOptions', 'RevolveOptions', 'RotationData',
      'RotationInput', 'SamplingGeneration', 'SegmentBatchOptions', 'SphereOptions', 'StepAttributes', 'StepsOptions',
      'Style3', 'Styleable', 'SubdivisionOptions', 'SurfaceCoordinateOptions', 'SurfaceCurveEdge', 'SurfaceCurveOptions',
      'SurfaceCurvePoint', 'SurfaceHit', 'SurfaceLocation', 'SurfaceMappingOptions', 'SurfaceMappingStats', 'SurfaceSample',
      'SurfaceSampleRow', 'SurfaceSamplingOptions', 'SurfaceScatterOptions', 'SurfaceUV', 'SweepOptions', 'ToneField',
      'ToneInput', 'TorusOptions', 'TraceAttributes', 'TraceOptions', 'TraceSeed', 'Vec3',
      'Vector3', 'ViewHatch', 'ViewOptions', 'ViewSection',
    ] },
  ],
};
