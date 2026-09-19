import { describe, expect, it } from 'vitest';
import { cloneNode, parseGraph, type GraphNode } from './model.js';

const node = (id: string, from?: [string, string]): GraphNode => ({
  id, kind: 'code', x: 10, y: 20,
  inputs: { a: from ? { from } : { value: 1 } },
  outputs: { out: 'Number' },
  body: 'return { out: a };',
});

describe('cloneNode', () => {
  it('shares nothing with the node it came from', () => {
    const one = node('n1');
    const copy = cloneNode(one);
    copy.inputs.a = { value: 99 };
    copy.x = 0;
    expect(one.inputs.a).toEqual({ value: 1 });
    expect(one.x).toBe(10);
  });

  it('copies a node whose wire leaves the set — a clipping is made of these', () => {
    const copy = cloneNode(node('n1', ['gone', 'out']));
    expect(copy.inputs.a?.from).toEqual(['gone', 'out']);
  });
});

describe('parseGraph', () => {
  it('still refuses a document whose wire lands nowhere', () => {
    const doc = { version: 1, name: 'x', config: {}, nodes: [node('n1', ['gone', 'out'])] };
    expect(() => parseGraph(JSON.parse(JSON.stringify(doc)))).toThrow(/missing node/);
  });
});
