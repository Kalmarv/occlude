// Built-in fill 'hatch' — parallel lines. An ordinary fill file with no
// privileges; shipped names are ink-immutable (an ink-affecting change needs
// a NEW name). Clone it from the studio's Fills page to make it yours.
import { fillAsset, rulings } from '../fillModule.js';
import type { L } from '../units.js';
import type { LengthField } from '../streamlines.js';

export default fillAsset({
  params: {
    angle: 0,
    /** Length, or a field of lengths read along each line; default 3× the
     * fill pen's nib. */
    spacing: undefined as L | LengthField | undefined,
    offset: 0,
    align: 'paper' as 'paper' | 'shape',
    /** Length between the reads of a spacing field along a line; default 1 mm. */
    step: undefined as L | undefined,
  },
  generate(region, p, ctx) {
    const sp = p.spacing;
    const spacing = typeof sp === 'function'
      ? (x: number, y: number) => ctx.len(sp(x, y)) * ctx.coarsen
      : (sp !== undefined ? ctx.len(sp) : 3 * ctx.penWidth) * ctx.coarsen;
    return rulings(region, {
      spacing, angle: p.angle, offset: p.offset, align: p.align, anchor: ctx.anchor,
      step: p.step !== undefined ? ctx.len(p.step) : undefined,
    });
  },
});
