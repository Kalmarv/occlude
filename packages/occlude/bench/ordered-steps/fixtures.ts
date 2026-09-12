import {
  append,
  curve,
  material,
  force,
  type Material,
} from "../../src/material.js";
import { edges as edgeQuery } from "../../src/query.js";
import { orderedSteps } from "./prototype.js";

export function growth(ordered: boolean, count = 100): Material {
  const seed = material([[0, 0]], { active: 1 });
  const child = (p: { x: number; y: number }) => ({
    position: [p.x + Math.cos(p.y * 0.1), p.y + 1],
    attributes: { active: 1 },
  });
  return ordered
    ? orderedSteps(seed, count, (_, current) => {
        const tips = current.points.filter((p) => p.active === 1);
        current.extend(tips, child);
        current.set(tips, { active: 0 });
      })
    : seed.steps(count, (prev, next) => {
        const tips = prev.points.filter((p) => p.active === 1);
        next.extrude(tips, child);
        next.set(tips, () => ({ active: 0 }));
      });
}
export function ring(ordered: boolean, count = 30): Material {
  const seed = curve(
    Array.from({ length: 40 }, (_, i) => [
      20 * Math.cos((i * Math.PI) / 20),
      20 * Math.sin((i * Math.PI) / 20),
    ]),
  );
  const makePush = (prev: Material) => {
    const attraction = force.attract(prev, {
      radius: 10,
      excludeConnected: true,
      strength: 0.1,
    });
    return (p: import("../../src/material.js").Vertex) => {
      const [x, y] = attraction(p);
      return [x + p.x * 0.03, y + p.y * 0.03];
    };
  };
  return ordered
    ? orderedSteps(seed, count, (prev, current) => {
        current.move(current.points, makePush(prev));
        current.splitEdges(current.edges.filter((e) => e.length > 4));
      })
    : seed.steps(count, (prev, next) => {
        next.move(prev.points, makePush(prev));
      }, (prev, next) => {
        next.splitEdges(prev.edges.filter((e) => e.length > 4));
      });
}
export function collisionSeed(count = 20): Material {
  const bar = curve(
    [
      [0, 0],
      [100, 0],
    ],
    { closed: false, active: 0 },
  );
  return append(
    bar,
    material(
      Array.from({ length: count }, (_, i) => [
        (100 * (i + 1)) / (count + 1),
        10,
      ]),
      { active: 1 },
    ),
  );
}
export function collisions(
  mode: "legacy" | "frozen" | "updated" | "grouped",
  count = 20,
): Material {
  const seed = collisionSeed(count);
  if (mode === "legacy")
    return seed.steps(1, (prev, next) => {
      const query = edgeQuery(prev),
        tips = prev.points.filter((p) => p.active === 1);
      next.extrude(tips,
        (p) => {
          const hit = query.firstHit(p, [p.x, -1], { excludeIncident: p })!;
          return {
            to: next.split(hit.edge, { at: hit.t, point: { active: 0 } }),
          };
        },
      );
      next.set(tips, () => ({ active: 0 }));
    });
  if (mode === "grouped")
    return orderedSteps(seed, 1, (prev, current) => {
      const query = edgeQuery(prev);
      const hits = prev.points
        .filter((p) => p.active === 1)
        .map((p) => ({
          tip: p,
          hit: query.firstHit(p, [p.x, -1], { excludeIncident: p })!,
        }));
      const groups = new Map<number, typeof hits>();
      for (const hit of hits) {
        const group = groups.get(hit.hit.edge.index) ?? [];
        group.push(hit);
        groups.set(hit.hit.edge.index, group);
      }
      for (const group of groups.values()) {
        const junctions = current.split(group[0].hit.edge, {
          at: group.map((h) => h.hit.t),
          point: { active: 0 },
        });
        group.forEach((h, i) => current.connect(h.tip, junctions[i]));
      }
      current.set(
        prev.points.filter((p) => p.active === 1),
        { active: 0 },
      );
    });
  return orderedSteps(seed, 1, (prev, current) => {
    const tips = current.points.filter((p) => p.active === 1);
    const frozen = edgeQuery(prev);
    current.extend(tips, (p) => {
      // Explicit rebuild exposes the cost and semantics of querying edited geometry.
      const query = mode === "updated" ? edgeQuery(current.snapshot()) : frozen;
      const hit = query.firstHit(p, [p.x, -1])!;
      return {
        to: current.split(hit.edge, { at: hit.t, point: { active: 0 } }),
      };
    });
    current.set(tips, { active: 0 });
  });
}
/** Compare geometry independent of the engines' different compact row orders. */
export function geometry(m: Material) {
  const point = (p: { x: number; y: number }) =>
    `${p.x.toFixed(9)},${p.y.toFixed(9)}`;
  return {
    points: m.points.map(point).sort(),
    edges: m.edges.map((e) => [point(e.a), point(e.b)].sort().join(":")).sort(),
  };
}
