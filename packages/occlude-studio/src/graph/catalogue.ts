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
        { name: 'offset', takes: { socket: 'Number' }, optional: false },
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
          { name: 'unit', control: 'menu', choices: ['user', 'mm'], optional: true },
          { name: 'align', control: 'menu', choices: ['center', 'left', 'right'], optional: true },
          { name: 'pen', control: 'text', optional: true },
          { name: 'fill', takes: { socket: 'Fill' }, optional: true },
          { name: 'fillPen', control: 'text', optional: true },
          { name: 'opaque', control: 'check', optional: true },
          { name: 'z', takes: { socket: 'Number' }, optional: true },
          { name: 'mode', control: 'menu', choices: ['corner', 'center'], optional: true },
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
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
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
          { name: 'bridge', takes: { socket: 'Number' }, optional: true },
          { name: 'preserveStroke', control: 'check', optional: true },
          { name: 'strokeSeed', takes: { socket: 'Number' }, optional: true },
          { name: 'rotate', takes: { socket: 'Number' }, optional: true },
          { name: 'scale', takes: { socket: 'Number' }, optional: true },
        ] },
      ],
    },
    {
      word: 'fill', module: 'occlude', receiver: null,
      import: 'fill', call: 'fill', returns: 'Fill',
      page: '/docs/reference/fills', group: 'Fills',
      params: [
        { name: 'name', control: 'text', optional: false },
      ],
    },
    {
      word: 'distanceTo', module: 'occlude', receiver: null,
      import: 'distanceTo', call: 'distanceTo', returns: 'Field',
      page: '/docs/reference/fields', group: 'Fields',
      params: [
        { name: 'boundary', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: false },
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
        { name: 'faces', takes: { socket: 'Geometry', kinds: ['faces'] }, optional: false },
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
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: true },
        { name: 'z', takes: { socket: 'Number' }, optional: true },
      ],
    },
    {
      word: 't.rnd', module: 'occlude', receiver: 't',
      import: null, call: 't.rnd', returns: 'Number',
      page: '/docs/reference/random', group: 'Random',
      params: [
        { name: 'a', takes: { socket: 'Number' }, optional: false },
        { name: 'b', takes: { socket: 'Number' }, optional: false },
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
      word: 'material', module: 'occlude', receiver: null,
      import: 'material', call: 'material', returns: 'material',
      page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'points', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
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
        { name: 'shape', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: false },
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
        { name: 'field', takes: { socket: 'Field' }, optional: false },
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
        { name: 'area', takes: { socket: 'Geometry', kinds: ['shape', 'faces', 'material', 'points'] }, optional: false },
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
      ],
    },
    {
      word: 'connect.ring', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.ring', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
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
      ],
    },
    {
      word: 'connect.unimpeded', module: 'occlude', receiver: 'connect',
      import: 'connect', call: 'connect.unimpeded', returns: 'material',
      page: '/docs/reference/connect', group: 'Connect',
      params: [
        { name: 'm', takes: { socket: 'Geometry', kinds: ['material'] }, optional: false },
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
      word: 'view', module: 'occlude/3d', receiver: null,
      import: 'view', call: 'view', returns: 'drawing',
      page: '/docs/reference/3d/view', group: 'View',
      params: [
        { name: 'geometry', takes: { socket: 'Geometry', kinds: ['curves'] }, optional: false },
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
        { name: 'a', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
        { name: 'b', takes: { socket: 'Geometry', kinds: ['mesh'] }, optional: false },
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
  ],
  importable: [
    { module: 'occlude', names: [
      'add', 'angleOf', 'append', 'applyShader', 'assetTable', 'banding', 'bindToolkit', 'boundaryLoops',
      'box3', 'bridgeArg', 'bridgeGapFor', 'canonicalJson', 'cellCentre', 'chainsBounds', 'checkDrawRequest', 'circle',
      'clip', 'cloneSurface3', 'commitCamera3', 'compileSketch', 'compileSketchAsync', 'components', 'connect', 'constructStrokes3',
      'cross', 'curl', 'curve', 'curveMs', 'customFill', 'dash', 'decimate', 'decodePlanBuffer',
      'decodeRender', 'deform', 'degrees', 'distance', 'distanceTo', 'docsPaper', 'dot', 'drawFragments',
      'drawing3', 'ease', 'editEdges3', 'editPoints3', 'ellipse', 'encodePlanBuffer', 'encodeScene', 'encodeToolpath',
      'envelope', 'estimatePlanMs', 'evalPrim', 'exportCollisions', 'exportGcode', 'exportPng', 'exportSvg', 'extent',
      'extrudeFaces3', 'faces', 'fill', 'fillAsset', 'fillTable', 'fitDuration', 'force', 'formatSeed',
      'fromAngle', 'grad', 'grid3', 'group', 'h', 'hashPlan', 'hatch3', 'inch',
      'inheritEdge', 'initOcclude', 'inspectHook', 'interlace', 'invert', 'invertRange', 'isBuiltinFill', 'isLineArt3',
      'isSketch', 'isSketchAsync', 'isStations', 'label', 'labelWidth', 'length', 'liftAt', 'liftForTravel',
      'liftMapFromCounts', 'limit', 'line', 'lineArt3', 'liveExampleToJs', 'loadFillModule', 'long', 'makePlan',
      'map', 'mask', 'material', 'meanBy', 'measureFaces3', 'mm', 'modify', 'moduleName',
      'mul', 'neighbours', 'ngon', 'norm', 'numericLoops', 'openPlan', 'oscillate', 'ownedBy',
      'paper', 'paperModel', 'paperSize', 'parseCounts', 'parseLiveMeta', 'parseSeed', 'parseToolpath', 'path',
      'pen', 'penModel', 'pensToJson', 'perp', 'plan', 'planAsBuffers', 'planBuffer', 'planDurationMs',
      'planGcode', 'planPolyline', 'planSchedule', 'planSettings', 'planSvg', 'planToolpath', 'planValue', 'planarize',
      'pointCloud3', 'polygon', 'primLength', 'probeExpression', 'profileToJson', 'query', 'radians', 'range',
      'rect', 'refineLiftMap', 'render', 'renderAsync', 'renderEncoded', 'resolveDraw', 'resolveFill', 'rotate',
      'roughen', 'rulings', 's', 'scale', 'scanAssetNames', 'scanFillNames', 'scanUiControls', 'schedulePlan',
      'sdf', 'section3', 'segmentRuns', 'segmentsToBlocks', 'selectAll', 'selectChains', 'selectProgress', 'selectTime',
      'selectedFlat', 'settleAtLift', 'shader', 'shaper', 'siteId', 'sketch', 'sketchAsync', 'smooth',
      'snap', 'snapshotSurface3', 'standaloneEstimate', 'stationsMaterial', 'stepsSurface3', 'stroke', 'strokes', 'sub',
      'subPrim', 'sum', 'sumBy', 'sumForces', 'surface3', 'svg', 'synth', 'tagDraws',
      'thicken', 'times', 'tourBudget', 'tracePrim', 'transformSurface3', 'translate', 'travelLiftPulse', 'ui',
      'unit', 'userModules', 'userUnitsToPaper', 'vectorField', 'voronoi', 'w', 'warp', 'within',
      'wobble',
    ] },
    { module: 'occlude/3d', names: [
      'across', 'alignAxis', 'axisAngle', 'box', 'circle3', 'cone', 'curvature', 'curve3',
      'cylinder', 'cylindricalUV', 'falloff', 'gradient', 'grid', 'instanceOnFaces', 'instanceOnPoints', 'intersections',
      'isolines', 'laneThreshold', 'light', 'mapSurface', 'mesh', 'orthographic', 'perspective', 'planarUV',
      'plane', 'pointCloud', 'polyline', 'query3', 'revolve', 'sphere', 'style', 'sweep',
      'torus', 'trace', 'view',
    ] },
  ],
};
