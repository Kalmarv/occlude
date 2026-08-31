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

/** One constant-acceleration motion block — the shape the EBB's LM command
 * executes natively. Consecutive blocks are velocity-continuous. */
export interface MotionBlock {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Cartesian entry/exit speeds, mm/s. */
  v0: number;
  v1: number;
  /** Index of the source PlannedSegment (pause/resume replans from here). */
  seg: number;
}

/** Exact duration of a planned profile, ms: per segment, the trapezoid
 * accel/cruise/decel times — not the "always at full feed" fiction. */
export function planDurationMs(planned: PlannedSegment[], accel: number): number {
  const a = Math.max(1e-6, accel);
  let seconds = 0;
  for (const s of planned) {
    const dAccel = Math.max(0, (s.cruiseVelocity ** 2 - s.startVelocity ** 2) / (2 * a));
    const dDecel = Math.max(0, (s.cruiseVelocity ** 2 - s.endVelocity ** 2) / (2 * a));
    seconds += (s.cruiseVelocity - s.startVelocity) / a;
    seconds += (s.cruiseVelocity - s.endVelocity) / a;
    if (s.cruiseVelocity > 1e-9) {
      seconds += Math.max(0, s.length - dAccel - dDecel) / s.cruiseVelocity;
    }
  }
  return seconds * 1000;
}

/**
 * Slice planned segments into accel/cruise/decel blocks, each capped at
 * `maxBlockS` seconds. The cap bounds pause latency (the FIFO holds at most
 * one queued block) and keeps progress reporting granular; a whole cruise
 * leg would otherwise be one multi-second command.
 */
export function segmentsToBlocks(
  planned: PlannedSegment[],
  accel: number,
  maxBlockS = 0.25,
): MotionBlock[] {
  const a = Math.max(1e-6, accel);
  const blocks: MotionBlock[] = [];
  planned.forEach((segment, seg) => {
    const { length } = segment;
    const vs = segment.startVelocity;
    const vc = segment.cruiseVelocity;
    const ve = segment.endVelocity;
    let dAccel = Math.max(0, (vc * vc - vs * vs) / (2 * a));
    let dDecel = Math.max(0, (vc * vc - ve * ve) / (2 * a));
    // The planner guarantees reachability; rescale only float overshoot.
    if (dAccel + dDecel > length) {
      const k = length / (dAccel + dDecel);
      dAccel *= k;
      dDecel *= k;
    }
    const at = (s: number): Point => [
      segment.start[0] + ((segment.end[0] - segment.start[0]) * s) / length,
      segment.start[1] + ((segment.end[1] - segment.start[1]) * s) / length,
    ];
    const phases: { s0: number; s1: number; v0: number; v1: number }[] = [
      { s0: 0, s1: dAccel, v0: vs, v1: vc },
      { s0: dAccel, s1: length - dDecel, v0: vc, v1: vc },
      { s0: length - dDecel, s1: length, v0: vc, v1: ve },
    ];
    for (const phase of phases) {
      if (phase.s1 - phase.s0 < 1e-9) continue;
      const phaseA = (phase.v1 ** 2 - phase.v0 ** 2) / (2 * (phase.s1 - phase.s0));
      let s = phase.s0;
      let v = phase.v0;
      while (s < phase.s1 - 1e-9) {
        // Remaining phase time; finish the phase in one block when it fits
        // the cap, otherwise advance by exactly the cap. (Accel/decel phases
        // last (Δv)/a — usually under the cap; splitting is for cruise.)
        const tEnd =
          phaseA !== 0 ? (phase.v1 - v) / phaseA : (phase.s1 - s) / Math.max(v, 1e-9);
        let s2: number;
        let v2: number;
        if (tEnd <= maxBlockS + 1e-9) {
          s2 = phase.s1;
          v2 = phase.v1;
        } else {
          v2 = v + phaseA * maxBlockS;
          s2 = s + ((v + v2) / 2) * maxBlockS;
        }
        const [x0, y0] = at(s);
        const [x1, y1] = at(s2);
        blocks.push({ x0, y0, x1, y1, v0: v, v1: v2, seg });
        s = s2;
        v = v2;
      }
    }
  });
  return blocks;
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


// ---- plot-time ground truth ------------------------------------------------

export interface PlanChainLike {
  pen: number;
  dot: boolean;
  pts: ArrayLike<number>;
}

export interface EstimateOpts {
  /** mm/min. */
  travelFeed: number;
  /** mm/s². */
  acceleration: number;
  travelAcceleration: number;
  junctionDeviation: number;
  minimumCruiseRatio: number;
  /** Quick-hop threshold, mm; 0 disables (full lifts everywhere). */
  quickHopMm: number;
}

export interface PenTiming {
  feed: number;
  penDelay: number;
}

export interface PlanEstimate {
  totalMs: number;
  /** Breakdown — the calibration features: wall ≈ Σ aᵢ·featureᵢ. */
  drawMs: number;
  travelMs: number;
  cycleMs: number;
  commands: number;
  chains: number;
  dots: number;
}

/** THE plot-time model — the same math the EBB driver's progress totals and
 * ETA use. plotstats and the export panel estimate through this too, so
 * every number the user sees shares one source of truth. Trapezoid-planned
 * per move (short dense segments never reach feed and are priced at their
 * planned speed), pen cycles follow the quick-hop rule exactly. */
export function estimatePlanMs(
  chains: readonly PlanChainLike[],
  penOf: (penIndex: number) => PenTiming | undefined,
  o: EstimateOpts,
): PlanEstimate {
  const drawAccel = Math.max(1, o.acceleration);
  const travelAccel = Math.max(1, o.travelAcceleration);
  const limits = (maxVelocity: number, acceleration: number) => ({
    maxVelocity: Math.max(1, maxVelocity),
    acceleration,
    junctionDeviation: Math.max(0, o.junctionDeviation),
    minimumCruiseRatio: o.minimumCruiseRatio,
    startVelocity: 0,
    endVelocity: 0,
  });
  const est: PlanEstimate = {
    totalMs: 0, drawMs: 0, travelMs: 0, cycleMs: 0,
    commands: 0, chains: chains.length, dots: 0,
  };
  let px = 0;
  let py = 0;
  chains.forEach((c, i) => {
    const pen = penOf(c.pen);
    const feed = pen?.feed ?? 3000;
    const travel: Point[] = [[px, py], [c.pts[0], c.pts[1]]];
    est.travelMs += planDurationMs(
      planPolyline(travel, limits(o.travelFeed / 60, travelAccel)),
      travelAccel,
    );
    est.commands += 3; // travel + pen down + pen up
    if (c.dot) {
      est.dots += 1;
    } else {
      const poly: Point[] = [];
      for (let k = 0; k < c.pts.length; k += 2) poly.push([c.pts[k], c.pts[k + 1]]);
      est.drawMs += planDurationMs(planPolyline(poly, limits(feed / 60, drawAccel)), drawAccel);
      est.commands += poly.length - 1;
    }
    // Pen-cycle cost mirrors the plot loop's quick-hop rule: down height set
    // by the travel INTO the chain, up height by the travel OUT of it.
    const settle = Math.max(pen?.penDelay ?? 300, 150);
    const gapIn = Math.hypot(c.pts[0] - px, c.pts[1] - py);
    const nxt = chains[i + 1];
    px = c.pts[c.pts.length - 2] as number;
    py = c.pts[c.pts.length - 1] as number;
    const gapOut = nxt ? Math.hypot((nxt.pts[0] as number) - px, (nxt.pts[1] as number) - py) : Infinity;
    const hop = (g: number): boolean => o.quickHopMm > 0 && g <= o.quickHopMm;
    const down = i > 0 && hop(gapIn) ? Math.max(200, Math.round(settle * 0.5)) : settle;
    const up = hop(gapOut) ? Math.max(150, Math.round(settle * 0.4)) : settle;
    est.cycleMs += down + up + 300;
  });
  est.totalMs = est.drawMs + est.travelMs + est.cycleMs;
  return est;
}
