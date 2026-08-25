/**
 * Server-side store, shared by the Vite dev/preview middleware and the
 * production server (server.mjs). Named sketches persist as .ts files under
 * ./sketches and the pen library as ./sketches/pens.json — shared by every
 * browser/device that reaches this server.
 *
 *   GET    /api/sketches         → [{ name, mtime }]
 *   GET    /api/sketches/<name>  → source text
 *   PUT    /api/sketches/<name>  → save body as source
 *   DELETE /api/sketches/<name>  → remove
 *   GET    /api/pens             → pen library JSON (404 before first save)
 *   PUT    /api/pens             → save pen library JSON
 */

import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { join } from 'node:path';

const safe = (name) => (/^[a-zA-Z0-9 _-]{1,64}$/.test(name) ? name : null);

/**
 * Returns a connect-style handler: (req, res, next) => void.
 * Calls next() (when given) for non-/api/sketches paths, else 404s.
 */
export function createSketchHandler(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    const isPens = url.pathname === '/api/pens';
    if (!url.pathname.startsWith('/api/sketches') && !isPens) {
      if (next) return next();
      res.statusCode = 404;
      return res.end('{"error":"not found"}');
    }
    const send = (status, body, type = 'application/json') => {
      res.statusCode = status;
      res.setHeader('content-type', `${type}; charset=utf-8`);
      res.end(body);
    };
    try {
      if (isPens) {
        const file = join(dir, 'pens.json');
        if (req.method === 'GET') {
          const src = await fs.readFile(file, 'utf8').catch(() => null);
          if (src === null) return send(404, '{"error":"no pens saved yet"}');
          return send(200, src);
        }
        if (req.method === 'PUT') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = Buffer.concat(chunks).toString('utf8');
          JSON.parse(body); // reject invalid JSON before persisting
          await fs.writeFile(file, body);
          return send(200, '{"ok":true}');
        }
        return send(405, '{"error":"method"}');
      }
      const rest = url.pathname.slice('/api/sketches'.length).replace(/^\//, '');
      if (rest === '') {
        if (req.method !== 'GET') return send(405, '{"error":"method"}');
        const files = await fs.readdir(dir);
        const list = await Promise.all(
          files
            .filter((f) => f.endsWith('.ts'))
            .map(async (f) => {
              const st = await fs.stat(join(dir, f));
              return { name: f.slice(0, -3), mtime: st.mtimeMs };
            }),
        );
        list.sort((a, b) => b.mtime - a.mtime);
        return send(200, JSON.stringify(list));
      }
      const name = safe(decodeURIComponent(rest));
      if (!name) return send(400, '{"error":"bad name"}');
      const file = join(dir, `${name}.ts`);
      if (req.method === 'GET') {
        const src = await fs.readFile(file, 'utf8').catch(() => null);
        if (src === null) return send(404, '{"error":"not found"}');
        return send(200, src, 'text/plain');
      }
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        await fs.writeFile(file, Buffer.concat(chunks));
        return send(200, '{"ok":true}');
      }
      if (req.method === 'DELETE') {
        await fs.unlink(file).catch(() => undefined);
        return send(200, '{"ok":true}');
      }
      return send(405, '{"error":"method"}');
    } catch (e) {
      return send(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
}
