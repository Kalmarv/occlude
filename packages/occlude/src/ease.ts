/**
 * Easing functions: reshape a normalised t (0…1) before mapping it onto a
 * range — `map(ease.cubicIn(t), 0, 1, a, b)`. All curves pass through
 * (0, 0) and (1, 1), so mapped endpoints are always hit exactly; `back`
 * and `elastic` overshoot in between by design.
 *
 * Intuition for sequences: when t drives spacing (ring radii, row
 * positions), the LOCAL DENSITY is the curve's slope — `cubicIn` starts
 * flat, so elements crowd the start and fan out toward the end.
 */

const PI = Math.PI;
const c1 = 1.70158;
const c2 = c1 * 1.525;

function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) {
    const u = t - 1.5 / d;
    return n * u * u + 0.75;
  }
  if (t < 2.5 / d) {
    const u = t - 2.25 / d;
    return n * u * u + 0.9375;
  }
  const u = t - 2.625 / d;
  return n * u * u + 0.984375;
}

export const ease = {
  linear: (t: number): number => t,

  quadIn: (t: number): number => t * t,
  quadOut: (t: number): number => 1 - (1 - t) ** 2,
  quadInOut: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2),

  cubicIn: (t: number): number => t ** 3,
  cubicOut: (t: number): number => 1 - (1 - t) ** 3,
  cubicInOut: (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2),

  quartIn: (t: number): number => t ** 4,
  quartOut: (t: number): number => 1 - (1 - t) ** 4,
  quartInOut: (t: number): number => (t < 0.5 ? 8 * t ** 4 : 1 - (2 - 2 * t) ** 4 / 2),

  quintIn: (t: number): number => t ** 5,
  quintOut: (t: number): number => 1 - (1 - t) ** 5,
  quintInOut: (t: number): number => (t < 0.5 ? 16 * t ** 5 : 1 - (2 - 2 * t) ** 5 / 2),

  sinIn: (t: number): number => 1 - Math.cos((t * PI) / 2),
  sinOut: (t: number): number => Math.sin((t * PI) / 2),
  sinInOut: (t: number): number => -(Math.cos(PI * t) - 1) / 2,

  expoIn: (t: number): number => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  expoOut: (t: number): number => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  expoInOut: (t: number): number =>
    t <= 0 ? 0
    : t >= 1 ? 1
    : t < 0.5 ? 2 ** (20 * t - 10) / 2
    : (2 - 2 ** (-20 * t + 10)) / 2,

  circIn: (t: number): number => 1 - Math.sqrt(1 - t * t),
  circOut: (t: number): number => Math.sqrt(1 - (t - 1) ** 2),
  circInOut: (t: number): number =>
    t < 0.5
      ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
      : (Math.sqrt(1 - (2 - 2 * t) ** 2) + 1) / 2,

  /** Overshoots below 0 near the start. */
  backIn: (t: number): number => (c1 + 1) * t ** 3 - c1 * t * t,
  /** Overshoots above 1 near the end. */
  backOut: (t: number): number => 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  backInOut: (t: number): number =>
    t < 0.5
      ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2
      : ((2 * t - 2) ** 2 * ((c2 + 1) * (2 * t - 2) + c2) + 2) / 2,

  /** Springy wind-up below 0; decorative, not monotone. */
  elasticIn: (t: number): number =>
    t <= 0 ? 0 : t >= 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ((2 * PI) / 3)),
  /** Springy settle past 1; decorative, not monotone. */
  elasticOut: (t: number): number =>
    t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * PI) / 3)) + 1,
  elasticInOut: (t: number): number =>
    t <= 0 ? 0
    : t >= 1 ? 1
    : t < 0.5
      ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * ((2 * PI) / 4.5))) / 2
      : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * ((2 * PI) / 4.5))) / 2 + 1,

  bounceIn: (t: number): number => 1 - bounceOut(1 - t),
  /** Bouncing-ball settle; not monotone. */
  bounceOut,

  bounceInOut: (t: number): number =>
    t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2,

  /** Smoothstep: dense at both ends, sparse in the middle. */
  smooth: (t: number): number => t * t * (3 - 2 * t),
  /** Smootherstep: like smooth with flatter (C2) ends. */
  smoother: (t: number): number => t * t * t * (t * (t * 6 - 15) + 10),

  /** Polynomial of arbitrary power — powIn(t, 3) === cubicIn(t). */
  powIn: (t: number, p = 2): number => t ** p,
  powOut: (t: number, p = 2): number => 1 - (1 - t) ** p,
  powInOut: (t: number, p = 2): number =>
    t < 0.5 ? (2 * t) ** p / 2 : 1 - (2 - 2 * t) ** p / 2,
} as const;
