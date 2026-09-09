import { describe, expect, it } from 'vitest';
import { circle, compileSketch, drawAt, formatSeed, getDrawLog, getOverrideReport, parseSeed, sketch, tagDraws } from '../src/index.js';

describe('seed with overrides', () => {
  it('parses and formats the one-string form; a plain seed has no tail', () => {
    expect(parseSeed('42')).toEqual({ seed: '42', overrides: {} });
    expect(parseSeed(42)).toEqual({ seed: '42', overrides: {} });
    expect(parseSeed('42~c3f1x0.0=0.25,9a20zz.5=0.5')).toEqual({ seed: '42', overrides: { 'c3f1x0:0': 0.25, '9a20zz:5': 0.5 } });
    expect(formatSeed('42', { '9a20zz:5': 0.5, 'c3f1x0:0': 0.25 })).toBe('42~9a20zz.5=0.5,c3f1x0.0=0.25');
    expect(formatSeed(42, {})).toBe('42');
    expect(() => parseSeed('42~bad')).toThrow(/site\.k=f/);
    expect(() => parseSeed('42~a.0=1')).toThrow(/unit float/);
  });
});

describe('tagDraws', () => {
  it('wraps draw calls with a site id from their text, receiver included', () => {
    const src = `const a = t.rnd(10, 100); const b = legs.rnd(0, a); const c = rnd(); const d = t.pick([1, 2]); const e = t.chance(0.5);`;
    const { js, sites } = tagDraws(src);
    expect(sites.map((s) => s.text)).toEqual(['t.rnd(10, 100)', 'legs.rnd(0, a)', 'rnd()', 't.pick([1, 2])', 't.chance(0.5)']);
    for (const s of sites) expect(js).toContain(`__occlude_draw("${s.id}", () => ${s.text})`);
    for (const s of sites) expect(src.slice(s.start, s.end)).toBe(s.text); // offsets point at the call in the input
    expect(new Set(sites.map((s) => s.id)).size).toBe(5);
  });

  it('identical calls get distinct ids by ordinal; other lines do not move an id', () => {
    const a = tagDraws('const x = t.rnd(1, 5); const y = t.rnd(1, 5);').sites;
    expect(a[0].id).not.toBe(a[1].id);
    const b = tagDraws('const q = t.noise(1, 2);\nconst zz = 4;\nconst x = t.rnd(1, 5); const y = t.rnd(1, 5);').sites;
    expect(b.map((s) => s.id)).toEqual(a.map((s) => s.id));
    // editing the call itself is a new site
    expect(tagDraws('const x = t.rnd(1, 6);').sites[0].id).not.toBe(a[0].id);
  });

  it('leaves strings, comments, definitions and complex receivers alone', () => {
    const src = `// t.rnd(1, 2)\nconst s = "t.rnd(3, 4)"; function rnd(a) { return a; } const v = t.stream('a').rnd(1, 2); const w = t.rnd(rnd(1), 2);`;
    const { js, sites } = tagDraws(src);
    expect(sites.map((s) => s.text).sort()).toEqual(['rnd(1)', 't.rnd(rnd(1), 2)'].sort()); // the nested draw gets its own site
    expect(js).toContain('__occlude_draw("');
    expect(js.match(/__occlude_draw\(/g)).toHaveLength(2);
    const inner = sites.find((s) => s.text === 'rnd(1)')!;
    expect(src.slice(inner.start, inner.end)).toBe('rnd(1)'); // a nested site's offsets are absolute too
    expect(js).toContain('function rnd(a) { return a; }');
    expect(js).toContain(`t.stream('a').rnd(1, 2)`);
    expect(js).toContain('"t.rnd(3, 4)"');
  });
});

describe('addressed draws at run time', () => {
  const run = (seed: string, body: (t: import('../src/index.js').Toolkit) => number[]) => {
    let out: number[] = [];
    compileSketch(sketch({ seed }, (t) => { out = body(t); return circle(50, 50, 10); }));
    return out;
  };
  it('an override answers one address and leaves every other draw as the seed made it', () => {
    const body = (t: import('../src/index.js').Toolkit) => [
      drawAt('s1', () => t.rnd(10, 100)),
      drawAt('s2', () => t.rnd(10, 100)),
      drawAt('s2', () => t.rnd(10, 100)),
      t.rnd(), // untagged: never addressed
    ];
    const plain = run('7', body);
    const log = getDrawLog();
    expect(log.map((d) => d.addr)).toEqual(['s1:0', 's2:0', 's2:1']);
    expect(log[0].value).toBe(plain[0]); // what the call made of its float
    expect(getOverrideReport()).toEqual({ overrides: {}, hit: [], dropped: [] });
    const evolved = run('7~s2.1=0.5', body);
    expect(evolved[0]).toBe(plain[0]);
    expect(evolved[1]).toBe(plain[1]);
    expect(evolved[2]).toBe(55); // 10 + 0.5 * 90
    expect(evolved[3]).toBe(plain[3]); // the stream still advanced past the override
    expect(getOverrideReport()).toEqual({ overrides: { 's2:1': 0.5 }, hit: ['s2:1'], dropped: [] });
    expect(getDrawLog()[2]).toEqual({ addr: 's2:1', f: 0.5, value: 55 });
  });

  it('a stale address is reported dropped; named streams address on their own', () => {
    const body = (t: import('../src/index.js').Toolkit) => {
      const legs = t.stream('legs');
      return [drawAt('a', () => legs.rnd(0, 1)), drawAt('a', () => t.pick([0, 1, 2, 3])), drawAt('b', () => (t.chance(0.5) ? 1 : 0))];
    };
    run('3~zz.0=0.1,a.1=0.99,b.0=0.01', body);
    const r = getOverrideReport();
    expect(r.hit).toEqual(['a:1', 'b:0']);
    expect(r.dropped).toEqual(['zz:0']);
    const v = run('3~a.1=0.99,b.0=0.01', body);
    expect(v[1]).toBe(3); // pick index floor(0.99 * 4)
    expect(v[2]).toBe(1); // 0.01 < 0.5
    expect(getDrawLog().map((d) => d.value)).toEqual([expect.any(Number), 3, true]);
  });
});
