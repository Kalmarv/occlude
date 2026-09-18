import { mkdtempSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS module shared with the server
import { createGraphHandler } from '../../graph-store.mjs';

type Handler = (req: unknown, res: unknown, next?: () => void) => Promise<void>;

/** Drive the connect-style handler with a fake req/res (as resultStore.test.ts). */
async function call(
  h: Handler,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: Buffer; type: string }> {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  const req = { method, url: path, [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
  let status = 0;
  const headers: Record<string, string> = {};
  let out: Buffer = Buffer.alloc(0);
  const res = {
    set statusCode(v: number) { status = v; },
    get statusCode() { return status; },
    setHeader: (k: string, v: string) => { headers[k] = v; },
    end: (b?: string | Buffer) => { out = Buffer.isBuffer(b) ? b : Buffer.from(b ?? ''); },
  };
  await h(req, res);
  return { status, body: out, type: headers['content-type'] ?? '' };
}

const bloom = '{"version":1,"name":"bloom","config":{},"nodes":[]}';
const spaced = '{"version":1,"name":"my graph","config":{},"nodes":[]}';

describe('graph store', () => {
  it('saves, loads and deletes a graph, and lists newest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occlude-graphs-'));
    const h = createGraphHandler(dir) as Handler;
    expect(JSON.parse((await call(h, 'GET', '/api/graphs')).body.toString())).toEqual([]);

    expect((await call(h, 'PUT', '/api/graphs/bloom', bloom)).status).toBe(200);
    const read = await call(h, 'GET', '/api/graphs/bloom');
    expect(read.status).toBe(200);
    expect(read.type).toContain('application/json');
    expect(read.body.toString()).toBe(bloom);

    // A space in the name survives the round trip.
    expect((await call(h, 'PUT', '/api/graphs/my%20graph', spaced)).status).toBe(200);
    expect(existsSync(join(dir, 'my graph.json'))).toBe(true);

    // Newest first, by mtime: `my graph` was written last.
    utimesSync(join(dir, 'bloom.json'), new Date(2000, 0, 1), new Date(2000, 0, 1));
    utimesSync(join(dir, 'my graph.json'), new Date(2001, 0, 1), new Date(2001, 0, 1));
    const list = JSON.parse((await call(h, 'GET', '/api/graphs')).body.toString()) as { name: string; mtime: number }[];
    expect(list.map((g) => g.name)).toEqual(['my graph', 'bloom']);
    expect(list[0].mtime).toBeGreaterThan(list[1].mtime);

    expect((await call(h, 'DELETE', '/api/graphs/bloom')).status).toBe(200);
    expect((await call(h, 'GET', '/api/graphs/bloom')).status).toBe(404);
    // Deleting a graph that is not there is not an error.
    expect((await call(h, 'DELETE', '/api/graphs/bloom')).status).toBe(200);
  });

  it('refuses a name that leaves the library, and an unknown method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occlude-graphs-'));
    const h = createGraphHandler(dir) as Handler;
    for (const bad of ['..%2Fescape', 'a/b', 'a.json', 'x'.repeat(65), '%zz']) {
      expect((await call(h, 'GET', `/api/graphs/${bad}`)).status, bad).toBe(400);
    }
    expect(existsSync(join(dir, '..', 'escape.json'))).toBe(false);
    expect((await call(h, 'POST', '/api/graphs/bloom', bloom)).status).toBe(405);
    expect((await call(h, 'POST', '/api/graphs')).status).toBe(405);
  });

  it('rejects a body that is not JSON without writing the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occlude-graphs-'));
    const h = createGraphHandler(dir) as Handler;
    const res = await call(h, 'PUT', '/api/graphs/bloom', '{ not json');
    expect(res.status).toBe(400);
    expect((JSON.parse(res.body.toString()) as { error: string }).error).toContain('invalid JSON');
    expect(existsSync(join(dir, 'bloom.json'))).toBe(false);
  });

  it('passes a path that is not its own to the next middleware', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occlude-graphs-'));
    const h = createGraphHandler(dir) as Handler;
    let passed = 0;
    await h({ method: 'GET', url: '/api/sketches/x' }, { end: () => undefined }, () => { passed++; });
    expect(passed).toBe(1);
    // Without a next, it answers for itself rather than hanging.
    expect((await call(h, 'GET', '/api/sketches/x')).status).toBe(404);
  });
});
