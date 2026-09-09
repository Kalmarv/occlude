import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';
import { analyzeGeometry } from './geometryAnalysis.js';

const fileName = resolve('geometry-hints-fixture.ts');
const source = `
import { material as make, circle, type Material as Network, type Station, type FieldFn, type VectorFieldFn } from '../occlude/src/index.js';
const spines = make([[0, 0], [1, 1]]);
const renamed = spines;
const packed = {spines};
function helper() { return make([[2, 3]]); }
const fromHelper = helper();
const stations = spines.along();
const selected = spines.points.filter(p => p.x > 0);
const edgeSelection = spines.edges;
const regions = spines.faces();
const shape = circle(0, 0, 1);
const many = [shape];
const nested = [[shape], [shape]];
const polyline = spines.curves()[0];
declare const maybe: Network | undefined;
const optional = maybe;
declare const mixed: Network | string;
const ambiguous = mixed;
declare const anything: any;
const untyped = anything;
const unrelated = { points: [], edges: [] };
const customVector = (x: number, y: number): [number, number] => [x, y];
const vector: VectorFieldFn = customVector;
const scalar: FieldFn = (x, y) => x + y;
type Alias = Network;
const throughAlias: Alias = spines;
const readonlyStations: readonly Station[] = stations;
function outer() {
  const points = spines.points;
  function inner() { const points = spines.edges; return points; }
  return inner();
}
namespace Unrelated {
  export class Material { }
  const impostor = new Material();
}
`;
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true };
const host = ts.createCompilerHost(options);
const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
host.readFile = path => path === fileName ? source : read(path);
host.fileExists = path => path === fileName || exists(path);
const program = ts.createProgram([fileName], options, host);
const annotations = analyzeGeometry(ts, program, fileName, [{ start: 0, end: source.length }]);
const named = (name: string) => annotations.filter(a => a.role === 'declaration' && source.slice(a.start, a.end) === name);

describe('geometry classification from actual Occlude types', () => {
  it('recognizes aliases, helper results and source-independent variable names', () => {
    for (const name of ['spines', 'renamed', 'fromHelper', 'throughAlias']) expect(named(name)[0]?.kind, name).toBe('material');
  });
  it('keeps selections, faces and contours distinct', () => {
    expect(named('selected')[0]?.kind).toBe('points');
    expect(named('edgeSelection')[0]?.kind).toBe('edges');
    expect(named('regions')[0]?.kind).toBe('faces');
    expect(named('polyline')[0]?.kind).toBe('contour');
  });
  it('recognizes arrays and nullable types without claiming runtime contents', () => {
    expect(named('stations')[0]?.kind).toBe('stations');
    expect(named('readonlyStations')[0]?.kind).toBe('stations');
    expect(named('many')[0]).toMatchObject({ kind: 'shape', array: true });
    expect(named('nested')[0]).toMatchObject({kind:'shape',array:true,arrayDepth:2});
    expect(named('optional')[0]).toMatchObject({ kind: 'material', optional: true });
  });
  it('does not guess from structural lookalikes, names, any, or mixed unions', () => {
    for (const name of ['impostor', 'unrelated', 'untyped', 'ambiguous', 'customVector']) expect(named(name), name).toEqual([]);
    expect(named('vector')[0]?.kind).toBe('vector');
    expect(named('scalar')[0]?.kind).toBe('scalar');
  });
  it('distinguishes identically named declarations by source range', () => {
    const points = named('points');
    expect(points.map(p => p.kind)).toEqual(['points', 'edges']);
    expect(points[0].start).not.toBe(points[1].start);
  });
  it('highlights calls by result and references by value, including callback parameters', () => {
    const tokens = (name: string) => annotations.filter(a => source.slice(a.start, a.end) === name);
    expect(tokens('make').every(a => a.role === 'call' && a.kind === 'material')).toBe(true);
    expect(tokens('make')).toHaveLength(2);
    expect(tokens('along')[0]).toMatchObject({ role: 'call', kind: 'stations' });
    expect(tokens('filter')[0]).toMatchObject({ role: 'call', kind: 'points' });
    expect(tokens('p').map(a => a.role)).toEqual(['declaration', 'value']);
    expect(tokens('spines').some(a => a.role === 'value')).toBe(true);
    expect(annotations.find(a => a.start === source.indexOf('spines};'))?.sourceStart).toBe(named('spines')[0].start);
    expect(tokens('Network')).toEqual([]);
    expect(tokens('helper')).toHaveLength(1);
    expect(tokens('helper')[0].role).toBe('call');
  });
  it('only classifies tokens in requested ranges', () => {
    const position = source.indexOf('const shape');
    const result = analyzeGeometry(ts, program, fileName, [{ start: position, end: position + 30 }]);
    expect(result.map(a => source.slice(a.start, a.end))).toEqual(['shape', 'circle']);
    expect(analyzeGeometry(ts, program, fileName, [])).toEqual([]);
  });
});
