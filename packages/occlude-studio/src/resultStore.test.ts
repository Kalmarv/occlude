import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS module shared with the server
import { createResultHandler, newResultId } from '../result-store.mjs';

type Handler = (req: unknown, res: unknown) => Promise<void>;
/** Drive the connect-style handler with a fake req/res. */
async function call(h: Handler, method: string, path: string, body?: unknown): Promise<{ status: number; body: Buffer; type: string }> {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
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
const meta = { schemaVersion: 1, planHash: 'abc', sourcePlanHash: 'def', selection: { from: 0, to: 2 }, settings: {}, pens: [], paper: { w: 1, h: 1 }, build: 'test' };
const planB64 = Buffer.from(new Float64Array([1, 2, 0, 0, 0, 0]).buffer).toString('base64');

describe('result store', () => {
  it('publishes a complete record, lists newest first, serves parts, never overwrites, deletes on request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occlude-results-'));
    const h = createResultHandler(dir) as Handler;
    expect(JSON.parse((await call(h, 'GET', '/api/results')).body.toString())).toEqual([]);
    const made = await call(h, 'POST', '/api/results', { meta, svg: '<svg></svg>', plan: planB64 });
    expect(made.status).toBe(201);
    const { id } = JSON.parse(made.body.toString()) as { id: string };
    expect(id).toMatch(/^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4}$/);
    expect(existsSync(join(dir, id, 'plan.bin')) && existsSync(join(dir, id, 'drawing.svg')) && existsSync(join(dir, id, 'result.json'))).toBe(true);
    expect(readdirSync(dir).some((n) => n.startsWith('.tmp-'))).toBe(false);
    const listed = JSON.parse((await call(h, 'GET', '/api/results')).body.toString()) as { id: string; planBytes: number }[];
    expect(listed[0].id).toBe(id);
    expect(listed[0].planBytes).toBe(48);
    const plan = await call(h, 'GET', `/api/results/${id}/plan`);
    expect(plan.type).toBe('application/octet-stream');
    expect(new Float64Array(plan.body.buffer.slice(plan.body.byteOffset, plan.body.byteOffset + 48))[1]).toBe(2);
    expect((await call(h, 'GET', `/api/results/${id}/svg`)).type).toContain('image/svg+xml');
    // a second save is a second record: nothing is replaced in place
    const again = await call(h, 'POST', '/api/results', { meta, svg: '<svg>2</svg>', plan: planB64 });
    expect(JSON.parse(again.body.toString()).id).not.toBe(id);
    expect((await call(h, 'PUT', `/api/results/${id}`)).status).toBe(405);
    expect((await call(h, 'DELETE', `/api/results/${id}`)).status).toBe(200);
    expect((await call(h, 'GET', `/api/results/${id}`)).status).toBe(404);
  });

  it('rejects incomplete saves and hides an interrupted one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occlude-results-'));
    const h = createResultHandler(dir) as Handler;
    expect((await call(h, 'POST', '/api/results', { meta: { planHash: 'x' }, svg: '<svg/>', plan: planB64 })).status).toBe(400);
    expect((await call(h, 'POST', '/api/results', { meta, svg: 'nope', plan: planB64 })).status).toBe(400);
    expect((await call(h, 'POST', '/api/results', { meta, svg: '<svg/>', plan: '' })).status).toBe(400);
    // a crashed save leaves .tmp-<id>: never listed, never served
    const id = newResultId() as string;
    mkdirSync(join(dir, `.tmp-${id}`));
    writeFileSync(join(dir, `.tmp-${id}`, 'result.json'), JSON.stringify(meta));
    expect(JSON.parse((await call(h, 'GET', '/api/results')).body.toString())).toEqual([]);
    expect((await call(h, 'GET', `/api/results/${id}`)).status).toBe(404);
    expect((await call(h, 'GET', '/api/results/../etc')).status).not.toBe(200); // URL parsing folds the traversal away; nothing is served
  });
});
