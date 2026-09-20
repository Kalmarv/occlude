/**
 * Seeded randomness and noise. One stream per sketch: `sketch({ seed })`
 * initialises it, and stipple placement in the core shares the same seed so
 * a sketch is fully reproducible from its URL.
 */

/** cyrb128 string hash → four 32-bit seeds. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** sfc32 PRNG. State in a typed array rather than four captured `let`s:
 * the same integer arithmetic, the same sequence, cheaper per draw (a
 * stipple asks millions of times). */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  const s = new Uint32Array([a >>> 0, b >>> 0, c >>> 0, d >>> 0]);
  return () => {
    const a = s[0];
    const b = s[1];
    const c = s[2];
    let t = (a + b) | 0;
    s[0] = b ^ (b >>> 9);
    s[1] = (c + (c << 3)) | 0;
    const c2 = (c << 21) | (c >>> 11);
    const d = (s[3] + 1) | 0;
    s[3] = d;
    t = (t + d) | 0;
    s[2] = (c2 + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Stable stream key without constructing or consuming a random stream. */
export const hashSeed = (key: string): number => cyrb128(key)[0];

export class Rng {
  private next: () => number;
  /** 32-bit seed handed to the core for stipple determinism. */
  readonly seed32: number;

  constructor(seed: number | string) {
    const [a, b, c, d] = typeof seed === 'number' ? cyrb128(String(seed)) : cyrb128(seed);
    this.seed32 = a;
    this.next = sfc32(a, b, c, d);
    for (let i = 0; i < 12; i++) this.next();
    // One seeded permutation feeds both noise fields, drawn here so the
    // stream position after construction is what it always was.
    const perm = seededPermutation(this);
    this.noise2 = makeSimplex2(perm);
    this.noise3 = makeSimplex3(perm);
  }

  float(): number {
    return this.next();
  }

  /** The raw draw function itself, for hot loops that call millions of
   * times: the same stream, one call instead of two. */
  floatFn(): () => number {
    return this.next;
  }

  private noise2: (x: number, y: number) => number;
  private noise3: (x: number, y: number, z: number) => number;

  /** Seeded simplex noise in about [-1, 1]. Two coordinates read a plane;
   * three read a solid, and the solid changes at the same rate along every
   * axis — no slice, no favoured direction — so it wraps a sphere with no
   * seam. `z` given as 0 is a point in the solid, not the plane, so a walk
   * through z is continuous. */
  noise(x: number, y = 0, z?: number): number {
    if (z === undefined) return this.noise2(x, y);
    return this.noise3(x, y, z);
  }
}

/** The 256-entry permutation the simplex corners hash through, shuffled
 * from the seeded stream, doubled so a corner index never wraps. */
function seededPermutation(rng: Rng): Uint8Array {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.float() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

/** Seeded 2D simplex noise (Gustavson's reference gradients). */
function makeSimplex2(perm: Uint8Array): (x: number, y: number) => number {
  // Gradients as two flat arrays; the corner kernel is a plain function.
  // No per-sample allocation (the old closure, tuple, and gradient pair
  // were three), identical arithmetic in identical order.
  const GX = new Float64Array([1, -1, 1, -1, 1, -1, 0, 0]);
  const GY = new Float64Array([1, 1, -1, -1, 0, 0, 1, -1]);
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const corner = (x: number, y: number, gi: number): number => {
    let t0 = 0.5 - x * x - y * y;
    if (t0 < 0) return 0;
    t0 *= t0;
    const g = gi % 8;
    return t0 * t0 * (GX[g] * x + GY[g] * y);
  };

  return (xin: number, yin: number): number => {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    n += corner(x0, y0, perm[ii + perm[jj]]);
    n += corner(x1, y1, perm[ii + i1 + perm[jj + j1]]);
    n += corner(x2, y2, perm[ii + 1 + perm[jj + 1]]);
    // Scale to roughly [-1, 1].
    return 70 * n;
  };
}

/**
 * Seeded 3D simplex noise (Gustavson's reference: twelve edge gradients of
 * a cube, skew 1/3, unskew 1/6, kernel radius² 0.6, scale 32). The solid
 * field the toolkit's three-argument `noise` reads. Isotropic: nothing
 * here treats one axis differently from another.
 */
function makeSimplex3(perm: Uint8Array): (x: number, y: number, z: number) => number {
  const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
  const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
  const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);
  const F3 = 1 / 3;
  const G3 = 1 / 6;
  const corner = (x: number, y: number, z: number, gi: number): number => {
    let t0 = 0.6 - x * x - y * y - z * z;
    if (t0 < 0) return 0;
    t0 *= t0;
    const g = gi % 12;
    return t0 * t0 * (GX[g] * x + GY[g] * y + GZ[g] * z);
  };

  return (xin: number, yin: number, zin: number): number => {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    // Which of the six tetrahedra of the skewed cube holds the point: the
    // order of the three coordinates, read as two corner offsets.
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    n += corner(x0, y0, z0, perm[ii + perm[jj + perm[kk]]]);
    n += corner(x1, y1, z1, perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]]);
    n += corner(x2, y2, z2, perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]]);
    n += corner(x3, y3, z3, perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]]);
    // Scale to roughly [-1, 1].
    return 32 * n;
  };
}

export function mapRange(v: number, a: number, b: number, c: number, d: number): number {
  return c + ((v - a) / (b - a)) * (d - c);
}

export function normRange(v: number, a: number, b: number): number {
  return (v - a) / (b - a);
}

export function invertRange(v: number, max: number, min = 0): number {
  return max - (v - min);
}
