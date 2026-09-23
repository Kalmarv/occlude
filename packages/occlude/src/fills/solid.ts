// Built-in fill 'solid' — unbroken ink: shape-aligned rows at 0.9× the nib.
import { fillAsset, rulings } from '../fillModule.js';
import type { L } from '../units.js';
import type { LengthField } from '../streamlines.js';

export default fillAsset({
  params: {
    /** Row direction; barely visible once solid, but sets plot direction. */
    angle: 0,
    /** Length, or a field of lengths read along each row; default 0.9× the
     * nib so rows overlap into unbroken ink. */
    spacing: undefined as L | LengthField | undefined,
    /** Length between the reads of a spacing field along a row; default 1 mm. */
    step: undefined as L | undefined,
  },
  generate(region, p, ctx) {
    const sp = p.spacing;
    const spacing = typeof sp === 'function'
      ? (x: number, y: number) => ctx.len(sp(x, y)) * ctx.coarsen
      : (sp !== undefined ? ctx.len(sp) : 0.9 * ctx.penWidth) * ctx.coarsen;
    // Shape-aligned: small shapes fill identically wherever they sit, and
    // the rows rotate with the motif's explicit transform.
    return rulings(region, {
      spacing, angle: p.angle, offset: 0, align: 'shape', anchor: ctx.anchor,
      step: p.step !== undefined ? ctx.len(p.step) : undefined,
    });
  },
});
