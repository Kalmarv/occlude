import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { emitInspection } from './inspectionEmit.js';
import { runSketch, currentDraws } from './runner.js';
import { DEFAULT_PENS, getInspectionIndex, setInspectHint } from 'occlude';
import { tagDraws } from '../../occlude/src/draws.js';

const options = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS };
const emit = (source: string) => emitInspection(ts, source, 'file:///sketch.ts', '7', options);
const execute = (source: string) => {
  const captures: { value: unknown; source: { start: number; label: string }; id: string }[] = [];
  const result = new Function('__occlude_inspect', emit(source))((id: string, value: unknown, source: { start: number; label: string }) => {
    captures.push({ value, source, id }); return value;
  });
  return { captures, result };
};
describe('source-mapped inspection emit', () => {
  it('associates shadowed declarations with their exact original source offsets', () => {
    const source = 'const points = 1; { const points = 2; } return points;';
    const { captures, result } = execute(source);
    expect(result).toBe(1);
    expect(captures.map(c => c.value)).toEqual([1, 2]);
    expect(captures.map(c => c.source.start)).toEqual([source.indexOf('points'), source.lastIndexOf('const points') + 6]);
    expect(new Set(captures.map(c => c.id)).size).toBe(2);
  });
  it('preserves evaluation order and evaluates nested initializers once', () => {
    const source = 'let n = 0; const a = ++n, b = (() => { const inner = ++n; return inner; })(); return [a,b,n];';
    expect(execute(source).result).toEqual([1, 2, 2]);
  });
  it('preserves inferred function names, templates, and for-loop behavior', () => {
    expect(execute('const named = () => 1; let sum = 0; for(let i=0;i<3;i++) { const x=i; sum+=x; } const text=`x${sum}`; return [named.name,sum,text];').result).toEqual(['named',3,'x3']);
  });
  it('preserves source-map-looking text inside template strings', () => {
    const result = execute('const text = `first\n//# sourceMappingURL=not-a-map\nlast`; return text;').result;
    expect(result).toBe('first\n//# sourceMappingURL=not-a-map\nlast');
  });
  it('keeps draw addresses identical to the ordinary emitted program', () => {
    const source = 'const t={rnd:(x:any)=>x}; const x=t.rnd(() => { const nested=1; return nested; });';
    const plain = ts.transpileModule(source, { compilerOptions: options }).outputText;
    const ids = tagDraws(plain).sites.map(s => s.id);
    const inspected = emit(source);
    for (const id of ids) expect(inspected).toContain(JSON.stringify(id));
    expect(ids.length).toBeGreaterThan(0);
  });
  it('does not confuse imports or destructured bindings with named declarations', () => {
    const output = emit('import { circle } from "occlude"; const {x}={x:1}; const shape=circle(0,0,1);');
    expect(output).toContain('"label":"shape"');
    expect(output).not.toContain('"label":"circle"');
    expect(output).not.toContain('"label":"x"');
  });
});

describe('inspected execution equivalence', () => {
  it('preserves scene bytes and addressed randomness while separating repeated scoped captures', () => {
    const source = `import { sketch, circle, strokes } from 'occlude';
      export default sketch({seed:42}, t => {
        const points = t.sample(circle(50,50,t.rnd(20,30)), {count:8});
        function inner() { const points = t.sample(circle(50,50,t.rnd(5,10)), {count:3}); return strokes(points); }
        return [strokes(points), inner(), inner()];
      });`;
    const cfg = { pens: DEFAULT_PENS, paper: 'A4', landscape: false, defaultMarginPct: 5, coarsen: 1, draws: true };
    const plain = runSketch(ts.transpileModule(source, {compilerOptions:options}).outputText, cfg);
    const draws = currentDraws();
    const inspected = runSketch(emit(source), {...cfg, inspect:true, inspectionCompiled:true});
    expect(plain.error).toBeNull();
    expect(inspected.error).toBeNull();
    expect(inspected.scene).toEqual(plain.scene);
    expect(currentDraws()).toEqual(draws);
    const captures = getInspectionIndex();
    expect(captures.map(c => [c.points,c.occurrences])).toEqual([[8,1],[3,2]]);
    expect(new Set(captures.map(c=>c.source!.start)).size).toBe(2);
    setInspectHint(false);
  });
});
