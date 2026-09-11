/** Independent rational membership reference. This deliberately shares no
 * arithmetic, supports, roots, or crossing tables with the production core.
 * All values are lifted to a common integer scale before any subtraction. */
export type DiscEnvelope = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];
const view = new DataView(new ArrayBuffer(8));
function decode(value: number): [bigint, number] {
  if (!Number.isFinite(value)) throw new Error('oracle requires finite inputs');
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0),
    exp = Number((bits >> 52n) & 2047n);
  let significand = (bits & ((1n << 52n) - 1n)) + (exp ? 1n << 52n : 0n);
  if (bits >> 63n) significand = -significand;
  return [significand, exp ? exp - 1075 : -1074];
}
export function exactEnvelopeOracle(input: readonly DiscEnvelope[]) {
  const decoded = input.map((e) => e.map(decode));
  const exponent = Math.min(
    ...decoded.flatMap((e) => e.filter(([n]) => n !== 0n).map(([, e]) => e)),
    0,
  );
  const cache = new Map<number, bigint[][]>();
  return (x: number, y: number): -1 | 0 | 1 => {
    const xd = decode(x),
      yd = decode(y),
      scale = Math.min(exponent, xd[0] ? xd[1] : 0, yd[0] ? yd[1] : 0);
    let rows = cache.get(scale);
    if (!rows) {
      rows = decoded.map((row) =>
        row.map(([n, e]) => (n === 0n ? 0n : n << BigInt(e - scale))),
      );
      cache.set(scale, rows);
    }
    const xx = xd[0] === 0n ? 0n : xd[0] << BigInt(xd[1] - scale),
      yy = yd[0] === 0n ? 0n : yd[0] << BigInt(yd[1] - scale);
    let boundary = false;
    for (const [ax, ay, bx, by, ra, rb] of rows) {
      const qx = xx - ax,
        qy = yy - ay,
        dx = bx - ax,
        dy = by - ay,
        dr = rb - ra;
      const A = dx * dx + dy * dy - dr * dr,
        D = qx * dx + qy * dy + ra * dr,
        C = qx * qx + qy * qy - ra * ra;
      const end = (xx - bx) * (xx - bx) + (yy - by) * (yy - by) - rb * rb;
      if (C < 0n || end < 0n) return -1;
      const value =
        A > 0n && D > 0n && D < A ? A * C - D * D : C < end ? C : end;
      if (value < 0n) return -1;
      if (value === 0n) boundary = true;
    }
    return boundary ? 0 : 1;
  };
}
