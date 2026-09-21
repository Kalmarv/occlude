/**
 * The certified rejection stage in front of the exact contact routine
 * (src/three/curves/contactFilter.ts). Everything it rejects must be a pair
 * the exact routine calls a non-contact, and the coastline it leaves behind
 * must be the same coastline, coordinate for coordinate.
 */
import { describe, expect, it } from 'vitest';
import { orient3d } from 'robust-predicates';
import { separatedTriangles3 } from '../src/three/curves/contactFilter.js';
import { triangleContact3 } from '../src/three/curves/contact.js';
import { intersectionContacts3 } from '../src/three/curves/intersectionContacts.js';
import { intersectionAtomsJob3 } from '../src/three/curves/intersectionAtoms.js';
import { intersectionGraphInputJob3 } from '../src/three/curves/intersectionGraph.js';
import { intersectionsJob3 } from '../src/three/curves/intersections.js';
import { surfaceCurveNetworkJob3 } from '../src/three/curves/network.js';
import { bindingTriangle3 } from '../src/three/curves/network.js';
import { runGeometryJob3 } from '../src/three/geometry/job.js';
import { point } from '../src/three/geometry/exact.js';
import type { Vec3 } from '../src/three/math.js';
import { globeShells } from '../tools/coastline-filter/shells.js';

type Tri = readonly [readonly number[], readonly number[], readonly number[]];
const pack = (t: Tri) => Float64Array.from([...t[0], ...t[1], ...t[2]]);
const exact = (t: Tri) => t.map((p) => point(Object.freeze([...p]) as unknown as Vec3)) as unknown as readonly [any, any, any];
/** The first stage on its own: the three signs of one triangle's corners
 * against the other's plane, both ways. True when one triple is strictly of
 * one sign, which is the plane-side rejection. */
function sixSignRejects(a: Tri, b: Tri): boolean {
  const sides = (t: Tri, u: Tri) => u.map((p) => Math.sign(orient3d(...(t[0] as [number, number, number]), ...(t[1] as [number, number, number]), ...(t[2] as [number, number, number]), ...(p as [number, number, number]))));
  const one = (s: number[]) => s.every((v) => v > 0) || s.every((v) => v < 0);
  return one(sides(b, a)) || one(sides(a, b));
}
const separated = (a: Tri, b: Tri) => separatedTriangles3(pack(a), 0, pack(b), 0);
const contactOf = (a: Tri, b: Tri) => triangleContact3(exact(a), exact(b));

describe('the coastline contact filter', () => {
  it('rejects the both-straddle counterexample by orientation, never by the six signs', () => {
    // working/globe-followup-report.md §4.1: both triples straddle, the AABBs
    // overlap, and on the planes' common line A holds x in [-4/3, 4/3] while
    // B holds x in [5/2, 3].
    const a: Tri = [[-2, -1, 0], [2, -1, 0], [0, 2, 0]];
    const b: Tri = [[3, 0, -1], [3, 0, 1], [1, 0, 3]];
    expect(sixSignRejects(a, b)).toBe(false);
    expect(separated(a, b)).toBe(true);
    expect(contactOf(a, b)).toBeNull();
  });

  it('keeps a genuinely intersecting pair through both stages', () => {
    const a: Tri = [[-1, -1, 0], [2, -1, 0], [0, 2, 0]];
    const b: Tri = [[0, 0, -1], [1, 0.25, 1], [0.2, 0.7, 1]];
    expect(sixSignRejects(a, b)).toBe(false);
    expect(separated(a, b)).toBe(false);
    expect(contactOf(a, b)).not.toBeNull();
  });

  it('falls through on a zero sign: a shared vertex, and an edge lying on a face', () => {
    const face: Tri = [[-1, -1, 0], [2, -1, 0], [0, 2, 0]];
    const sharedVertex: Tri = [[-1, -1, 0], [0, 0, 1], [1, 0, 1]];
    expect(separated(face, sharedVertex)).toBe(false);
    expect(contactOf(face, sharedVertex)).not.toBeNull();
    const edgeOnFace: Tri = [[0, 0, 0], [1, 0, 0], [0.5, 0.5, 1]];
    expect(separated(face, edgeOnFace)).toBe(false);
    expect(contactOf(face, edgeOnFace)).not.toBeNull();
  });

  it('agrees with the exact routine over a random population of 2,000 pairs', () => {
    let state = 0x9e3779b9 >>> 0;
    const random = () => { state = (Math.imul(state ^ (state >>> 15), 0x2545f491) + 0x6d2b79f5) >>> 0; return state / 0x100000000; };
    const triangle = (spread: number): Tri => {
      const base = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
      return [0, 1, 2].map(() => base.map((v) => v + (random() * 2 - 1) * spread)) as unknown as Tri;
    };
    let rejected = 0, kept = 0, contacts = 0;
    for (let i = 0; i < 2000; i++) {
      const a = triangle(0.8), b = triangle(0.8), hit = contactOf(a, b) !== null;
      if (hit) contacts++;
      if (separated(a, b)) { rejected++; expect(hit).toBe(false); } else kept++;
    }
    // A population that exercises both answers, not 2,000 trivial rejections.
    expect(contacts).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(500);
    expect(kept).toBeGreaterThanOrEqual(contacts);
  });

  it('leaves the globe coastline identical, contact for contact and node for node', async () => {
    const { water, terrain } = await globeShells({ frequency: 10 });
    const filtered = intersectionContacts3(water, terrain).value;
    expect(filtered.stats.rejected).toBeGreaterThan(0);
    expect(filtered.stats.rejected + filtered.contacts.length).toBeLessThanOrEqual(filtered.stats.candidates);

    // The same candidate enumeration, every pair handed to the exact routine:
    // the unfiltered answer, built from the filtered run's own index.
    const [left, right] = filtered.sources;
    const unfiltered: { a: number; b: number; contact: unknown }[] = [];
    let candidates = 0;
    for (let i = 0; i < left.bounds.length; i++) for (const j of right.index.query(left.bounds[i])) {
      candidates++;
      const contact = triangleContact3(bindingTriangle3(water, i), bindingTriangle3(terrain, j));
      if (contact) unfiltered.push({ a: i, b: j, contact });
    }
    expect(candidates).toBe(filtered.stats.candidates);
    expect(filtered.contacts.map((r) => [r.a, r.b])).toEqual(unfiltered.map((r) => [r.a, r.b]));
    expect(filtered.contacts.map((r) => r.contact)).toEqual(unfiltered.map((r) => r.contact));

    // And the network the rest of the pipeline builds from each of them.
    const network = (contacts: typeof filtered) => runGeometryJob3((function* () {
      const atoms = yield* intersectionAtomsJob3(contacts);
      const draft = yield* intersectionGraphInputJob3([water, terrain], atoms.segments, atoms.points);
      return yield* surfaceCurveNetworkJob3(draft);
    })()).value;
    const baseline = network({ ...filtered, contacts: unfiltered } as unknown as typeof filtered);
    const live = runGeometryJob3(intersectionsJob3(water, terrain)).value.network;
    expect(live.nodes.length).toBe(baseline.nodes.length);
    expect(live.segments.length).toBe(baseline.segments.length);
    expect(live.nodes.map((n) => n.exact)).toEqual(baseline.nodes.map((n) => n.exact));
    expect(live.nodes.map((n) => n.id)).toEqual(baseline.nodes.map((n) => n.id));
    expect(live.segments.map((s) => [s.a, s.b])).toEqual(baseline.segments.map((s) => [s.a, s.b]));
  }, 600_000);
});
