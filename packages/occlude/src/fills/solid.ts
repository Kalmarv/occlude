// Built-in fill 'solid' — unbroken ink: shape-aligned rows at 0.9× the nib.
import { fillAsset, rulings } from '../fillModule.js';
import type { L } from '../units.js';

export default fillAsset({
  params: {
    /** Row direction; barely visible once solid, but sets plot direction. */
    angle: 0,
    /** Length; default 0.9× the nib so rows overlap into unbroken ink. */
    spacing: undefined as L | undefined,
  },
  generate(region, p, ctx) {
    const spacing =
      (p.spacing !== undefined ? ctx.len(p.spacing) : 0.9 * ctx.penWidth) * ctx.coarsen;
    // Shape-aligned: small shapes fill identically wherever they sit, and
    // the rows rotate with the motif's explicit transform.
    return rulings(region, {
      spacing, angle: p.angle + ctx.anchor.rotation, offset: 0, align: 'shape',
    });
  },
});
