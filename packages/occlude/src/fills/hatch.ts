// Built-in fill 'hatch' — parallel lines. An ordinary fill file with no
// privileges; shipped names are ink-immutable (an ink-affecting change needs
// a NEW name). Clone it from the studio's Fills panel to make it yours.
import { fillAsset, rulings } from '../fillModule.js';
import type { L } from '../units.js';

export default fillAsset({
  params: {
    angle: 0,
    /** Length; default 3× the fill pen's nib. */
    spacing: undefined as L | undefined,
    offset: 0,
    align: 'paper' as 'paper' | 'shape',
  },
  generate(region, p, ctx) {
    const spacing =
      (p.spacing !== undefined ? ctx.len(p.spacing) : 3 * ctx.penWidth) * ctx.coarsen;
    const angle = p.align === 'shape' ? p.angle + ctx.anchor.rotation : p.angle;
    return rulings(region, { spacing, angle, offset: p.offset, align: p.align });
  },
});
