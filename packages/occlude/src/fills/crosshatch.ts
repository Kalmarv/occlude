// Built-in fill 'crosshatch' — stacked hatch passes (default 0° + 90°).
import { fillAsset, rulings } from '../fillModule.js';
import type { L } from '../units.js';

export default fillAsset({
  params: {
    angles: [0, 90] as number[],
    spacing: undefined as L | undefined,
    offset: 0,
    align: 'paper' as 'paper' | 'shape',
  },
  generate(region, p, ctx) {
    const spacing =
      (p.spacing !== undefined ? ctx.len(p.spacing) : 3 * ctx.penWidth) * ctx.coarsen;
    const turn = p.align === 'shape' ? ctx.anchor.rotation : 0;
    return p.angles.flatMap((angle) =>
      rulings(region, { spacing, angle: angle + turn, offset: p.offset, align: p.align }),
    );
  },
});
