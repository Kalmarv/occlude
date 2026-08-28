export type Point = [number, number];

export interface MotionLimits {
  /** Maximum requested path speed, mm/s. */
  maxVelocity: number;
  /** Cartesian acceleration limit, mm/s². */
  acceleration: number;
  /** GRBL-style geometric junction deviation, mm. */
  junctionDeviation: number;
  /** Klipper-style minimum fraction of each short move spent cruising. */
  minimumCruiseRatio: number;
  /** Speed at the beginning and end of the complete run, mm/s. */
  startVelocity: number;
  endVelocity: number;
}

export interface PlannedSegment {
  start: Point;
  end: Point;
  length: number;
  startVelocity: number;
  cruiseVelocity: number;
  endVelocity: number;
}

/**
 * Plan an exact polyline using GRBL/Marlin junction deviation and Klipper's
 * whole-run reverse/forward look-ahead. Speeds are kept squared while
 * planning so acceleration reachability is the exact v² = u² + 2as bound.
 */
export function planPolyline(points: Point[], limits: MotionLimits): PlannedSegment[] {
  const segments = points
    .slice(1)
    .map((end, i) => {
      const start = points[i];
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const length = Math.hypot(dx, dy);
      return length > 1e-9 ? { start, end, length, ux: dx / length, uy: dy / length } : null;
    })
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null);
  if (segments.length === 0) return [];

  const accel = Math.max(1e-6, limits.acceleration);
  const maxV2 = Math.max(0, limits.maxVelocity) ** 2;
  const junctionV2 = new Array<number>(segments.length + 1).fill(maxV2);
  junctionV2[0] = Math.min(maxV2, Math.max(0, limits.startVelocity) ** 2);
  junctionV2[segments.length] = Math.min(maxV2, Math.max(0, limits.endVelocity) ** 2);

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const next = segments[i];
    const dot = Math.max(-1, Math.min(1, prev.ux * next.ux + prev.uy * next.uy));
    if (dot > 1 - 1e-12) {
      junctionV2[i] = maxV2;
      continue;
    }
    if (dot < -1 + 1e-12 || limits.junctionDeviation <= 0) {
      junctionV2[i] = 0;
      continue;
    }
    // GRBL uses cos(pi-turnAngle) = -dot, then a half-angle identity.
    const sinHalf = Math.sqrt(Math.max(0, 0.5 * (1 + dot)));
    const jdV2 = (accel * limits.junctionDeviation * sinHalf) / Math.max(1e-12, 1 - sinHalf);
    // Klipper's short-segment guard: the virtual tangent circle may touch no
    // farther than halfway along either adjacent segment.
    const cosHalf = Math.sqrt(Math.max(0, 0.5 * (1 - dot)));
    const shortV2 = cosHalf > 1e-12
      ? 0.5 * accel * Math.min(prev.length, next.length) * (sinHalf / cosHalf)
      : maxV2;
    junctionV2[i] = Math.min(maxV2, jdV2, shortV2);
  }

  // Reverse pass: every junction must be able to decelerate to the next one.
  for (let i = segments.length - 1; i >= 0; i--) {
    junctionV2[i] = Math.min(junctionV2[i], junctionV2[i + 1] + 2 * accel * segments[i].length);
  }
  // Forward pass: every junction must be reachable from the previous one.
  for (let i = 0; i < segments.length; i++) {
    junctionV2[i + 1] = Math.min(junctionV2[i + 1], junctionV2[i] + 2 * accel * segments[i].length);
  }

  return segments.map((segment, i) => {
    const startV2 = junctionV2[i];
    const endV2 = junctionV2[i + 1];
    // Highest triangular/trapezoidal peak reachable from both ends.
    const reachablePeakV2 = (2 * accel * segment.length + startV2 + endV2) / 2;
    const cruiseRatio = Math.max(0, Math.min(0.99, limits.minimumCruiseRatio));
    const mcrPeakV2 = (startV2 + endV2) / 2 + accel * segment.length * (1 - cruiseRatio);
    const cruiseV2 = Math.max(startV2, endV2, Math.min(maxV2, reachablePeakV2, mcrPeakV2));
    return {
      start: segment.start,
      end: segment.end,
      length: segment.length,
      startVelocity: Math.sqrt(startV2),
      cruiseVelocity: Math.sqrt(cruiseV2),
      endVelocity: Math.sqrt(endV2),
    };
  });
}
