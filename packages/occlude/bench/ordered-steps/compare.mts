/** pnpm --filter occlude exec tsx bench/ordered-steps/compare.mts */
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import assert from "node:assert/strict";
import { growth, ring, collisions, geometry } from "./fixtures.js";
import type { Material } from "../../src/material.js";

console.log(
  JSON.stringify({
    runtime: process.version,
    cpu: cpus()[0].model,
    date: new Date().toISOString(),
    warmup: 2,
    samples: 7,
  }),
);
const cases: [string, () => Material, () => Material][] = [
  ["tips-100", () => growth(false, 100), () => growth(true, 100)],
  ["ring-30", () => ring(false, 30), () => ring(true, 30)],
  ["ring-70", () => ring(false, 70), () => ring(true, 70)],
  [
    "collisions-300-lineage",
    () => collisions("legacy", 300),
    () => collisions("frozen", 300),
  ],
  [
    "collisions-300-grouped",
    () => collisions("legacy", 300),
    () => collisions("grouped", 300),
  ],
  ...[20, 100, 300].map(
    (n) =>
      [
        `collisions-${n}`,
        () => collisions("legacy", n),
        () => collisions("updated", n),
      ] as [string, () => Material, () => Material],
  ),
];
for (const [name, old, fresh] of cases) {
  const a = old(),
    b = fresh();
  assert.deepEqual(geometry(a), geometry(b));
  const time = (fn: () => Material) => {
    for (let i = 0; i < 2; i++) fn();
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      fn();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { medianMs: samples[3], tailMs: samples[6] };
  };
  console.log(
    JSON.stringify({
      fixture: name,
      points: b.n,
      edges: b.edgeCount,
      geometry: "matches-to-1e-9",
      legacy: time(old),
      ordered: time(fresh),
    }),
  );
}
