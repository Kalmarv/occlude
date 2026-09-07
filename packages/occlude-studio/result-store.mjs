/**
 * Saved results: a chosen ordered drawing kept as resolved output, so it
 * can be shown, exported and plotted later without executing the sketch
 * again. Shared by the Vite middleware and server.mjs. Each result is an
 * immutable, versioned record directory under ./results:
 *
 *   results/<id>/result.json   meta: plan hash + selection identity, settings,
 *                              pens, paper, profile, timing, schema, build,
 *                              provenance (sketch, source hash, seed), the
 *                              author's request and the computed ETA
 *   results/<id>/plan.bin      the SELECTED plan's exact bytes (float64 LE)
 *   results/<id>/drawing.svg   frozen SVG generated from that selection
 *
 * A record is published only once every file is written: the save lands
 * in results/.tmp-<id> and is renamed into place, so an interrupted save
 * never advertises a record with a missing plan or SVG. Records are never
 * overwritten; DELETE is the only edit.
 *
 *   GET    /api/results            → [{ id, ...meta }] newest first
 *   POST   /api/results            {meta, svg, plan: base64} → { id }
 *   GET    /api/results/<id>       → meta JSON
 *   GET    /api/results/<id>/svg   → image/svg+xml
 *   GET    /api/results/<id>/plan  → application/octet-stream (float64 LE)
 *   DELETE /api/results/<id>
 */

import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { join } from 'node:path';

const ID = /^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4}$/;
const safe = (id) => (ID.test(id) ? id : null);
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};

export function newResultId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${stamp}-${rand}`;
}

/** Fields a record must carry before it is worth publishing. */
const REQUIRED = ['schemaVersion', 'planHash', 'sourcePlanHash', 'selection', 'settings', 'pens', 'paper', 'build'];

export function createResultHandler(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const list = async () => {
    const names = (await fs.readdir(dir).catch(() => [])).filter((n) => safe(n)).sort().reverse();
    const out = [];
    for (const id of names) {
      const meta = await fs.readFile(join(dir, id, 'result.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (meta) out.push({ id, ...meta });
    }
    return out;
  };

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/results')) {
      if (next) return next();
      res.statusCode = 404;
      return res.end('{"error":"not found"}');
    }
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.statusCode = status;
      res.setHeader('content-type', type);
      res.end(body);
    };
    try {
      const rest = url.pathname.slice('/api/results'.length).replace(/^\//, '').split('/');
      if (rest[0] === '') {
        if (req.method === 'GET') return send(200, JSON.stringify(await list()));
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8'));
          const { meta, svg, plan } = body;
          if (!meta || typeof svg !== 'string' || typeof plan !== 'string') return send(400, '{"error":"need meta, svg and plan (base64)"}');
          for (const k of REQUIRED) if (!(k in meta)) return send(400, JSON.stringify({ error: `meta.${k} is required` }));
          const bytes = Buffer.from(plan, 'base64');
          if (bytes.length === 0 || bytes.length % 8 !== 0) return send(400, '{"error":"plan bytes must be non-empty float64"}');
          if (!svg.includes('<svg')) return send(400, '{"error":"svg does not look like an SVG"}');
          let id = newResultId();
          while (existsSync(join(dir, id))) id = newResultId();
          const tmp = join(dir, `.tmp-${id}`);
          await fs.mkdir(tmp, { recursive: true });
          const record = { ...meta, id, savedAt: new Date().toISOString(), planBytes: bytes.length, svgBytes: Buffer.byteLength(svg) };
          await fs.writeFile(join(tmp, 'plan.bin'), bytes);
          await fs.writeFile(join(tmp, 'drawing.svg'), svg);
          await fs.writeFile(join(tmp, 'result.json'), JSON.stringify(record, null, 2));
          await fs.rename(tmp, join(dir, id)); // publish: all or nothing
          return send(201, JSON.stringify({ id }));
        }
        return send(405, '{"error":"method"}');
      }
      const id = safe(rest[0]);
      if (!id) return send(400, '{"error":"bad result id"}');
      const base = join(dir, id);
      if (!existsSync(join(base, 'result.json'))) return send(404, '{"error":"no such result"}');
      if (rest.length === 1) {
        if (req.method === 'GET') return send(200, await fs.readFile(join(base, 'result.json'), 'utf8'));
        if (req.method === 'DELETE') {
          await fs.rm(base, { recursive: true, force: true });
          return send(200, '{"ok":true}');
        }
        return send(405, '{"error":"method"}');
      }
      if (req.method !== 'GET') return send(405, '{"error":"method"}');
      if (rest[1] === 'svg') return send(200, await fs.readFile(join(base, 'drawing.svg')), 'image/svg+xml; charset=utf-8');
      if (rest[1] === 'plan') {
        const bytes = await fs.readFile(join(base, 'plan.bin'));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', String(bytes.length));
        return res.end(bytes);
      }
      return send(404, '{"error":"not found"}');
    } catch (e) {
      return send(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
}
