import { describe, expect, it } from 'vitest';
import { instrumentDeclarations } from './instrument.js';

const H = '__occlude_inspect';
const hook = (name: string): string => ` ${H}("${name}", ${name});`;

describe('instrumentDeclarations', () => {
  it('registers simple const, let and var declarations after their statement', () => {
    expect(instrumentDeclarations('const a = f(1);\nlet b = a;\nvar c = 2;')).toBe(
      `const a = f(1);${hook('a')}\nlet b = a;${hook('b')}\nvar c = 2;${hook('c')}`,
    );
  });

  it('leaves for heads, destructuring, multi-declarators and uninitialised declarations alone', () => {
    const src = [
      'for (let i = 0; i < 3; i++) { const q = g(i); }',
      'for (const p of pts) { total += p; }',
      'const { x, y } = pt;',
      'const [a, b] = pair;',
      'const m = 1, k = 2;',
      'let later;',
    ].join('\n');
    expect(instrumentDeclarations(src)).toBe(src.replace('const q = g(i);', `const q = g(i);${hook('q')}`));
  });

  it('does not read declarations inside strings, templates, comments or regex literals', () => {
    const src = [
      "const s = 'const fake = 1;';",
      'const t = `const x = ${a ? `y; z` : "q;"}; end`;',
      '// const inComment = 1;',
      '/* const inBlock = 2; */',
      'const r = /const [;]+ = 1;/g.test(s);',
      'const d = 10 / 2 / 5;',
    ].join('\n');
    const out = instrumentDeclarations(src);
    expect(out).toContain(`'const fake = 1;';${hook('s')}`);
    expect(out).toContain(`end\`;${hook('t')}`);
    expect(out).not.toContain('"inComment"');
    expect(out).not.toMatch(/"inBlock"/);
    expect(out).toContain(`.test(s);${hook('r')}`);
    expect(out).toContain(`10 / 2 / 5;${hook('d')}`);
    expect(out).not.toContain('"fake"');
    expect(out).not.toContain('"x"');
  });

  it('finds the statement end through nested brackets, arrows and inner statements', () => {
    const src = [
      'const web = start.steps(30, (cur, next, k) => {',
      '  const tips = cur.selectPoints((p) => p.active === 1);',
      '  next.set(() => ({ active: 0 }), { where: tips });',
      '  if (k > 2) { const z = [1, 2].map((v) => v * 2); return z; }',
      '});',
      'const f = (p) => p.x >= 1;',
      'const eq = a == b;',
    ].join('\n');
    const out = instrumentDeclarations(src);
    expect(out).toContain(`p.active === 1);${hook('tips')}`);
    expect(out).toContain(`(v) => v * 2);${hook('z')}`);
    expect(out).toContain(`});${hook('web')}`);
    expect(out).toContain(`p.x >= 1;${hook('f')}`);
    expect(out).toContain(`a == b;${hook('eq')}`);
    // Nothing was injected inside the where-object or the arrow parameter list.
    expect(out).not.toContain('where: tips });' + H);
  });

  it('survives TypeScript emit shapes: exports, requires, semicolon-less last lines', () => {
    const src = 'const { sketch, material } = require("occlude");\nconst m = material([[1, 2]]);\nexports.default = sketch({}, (t) => m);\n';
    const out = instrumentDeclarations(src);
    expect(out).toBe(`const { sketch, material } = require("occlude");\nconst m = material([[1, 2]]);${hook('m')}\nexports.default = sketch({}, (t) => m);\n`);
    expect(instrumentDeclarations('const x = 1')).toBe('const x = 1');
    expect(() => new Function(H, instrumentDeclarations('const x = 1; const y = { a: [x, `t${x}`] };'))(() => undefined)).not.toThrow();
  });
});
