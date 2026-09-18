/**
 * Server-side graph store, shared by the Vite dev/preview middleware and the
 * production server (server.mjs). A named graph is one JSON document under
 * ./graphs, beside the sketches and never inside them: the sketch library is
 * a git repository, and a graph is not a sketch. Shared by every
 * browser/device that reaches this server.
 *
 *   GET    /api/graphs          → [{ name, mtime }], newest first
 *   GET    /api/graphs/<name>   → the graph JSON (404 when absent)
 *   PUT    /api/graphs/<name>   → save body; rejected unless it parses as JSON
 *   DELETE /api/graphs/<name>   → remove
 *
 * Names are ^[a-zA-Z0-9 _-]{1,64}$ (the sketch store's rule).
 */

import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { join } from 'node:path';

const safe = (name) => (/^[a-zA-Z0-9 _-]{1,64}$/.test(name) ? name : null);

const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};

/**
 * Returns a connect-style handler: (req, res, next) => void.
 * Calls next() (when given) for non-/api/graphs paths, else 404s.
 */
export function createGraphHandler(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/graphs')) {
      if (next) return next();
      res.statusCode = 404;
      return res.end('{"error":"not found"}');
    }
    const send = (status, body, type = 'application/json') => {
      res.statusCode = status;
      res.setHeader('content-type', `${type}; charset=utf-8`);
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    };
    try {
      // There are no sub-resources: whatever follows /api/graphs IS the name.
      const rest = url.pathname.slice('/api/graphs'.length).replace(/^\//, '');
      if (rest === '') {
        if (req.method !== 'GET') return send(405, '{"error":"method"}');
        const files = await fs.readdir(dir);
        const list = await Promise.all(
          files
            .filter((f) => f.endsWith('.json'))
            .map(async (f) => {
              const st = await fs.stat(join(dir, f));
              return { name: f.slice(0, -'.json'.length), mtime: st.mtimeMs };
            }),
        );
        list.sort((a, b) => b.mtime - a.mtime);
        return send(200, JSON.stringify(list));
      }
      let name = null;
      try {
        name = safe(decodeURIComponent(rest));
      } catch {
        // Malformed percent-encoding is a bad name, not a server error.
      }
      if (!name) return send(400, '{"error":"bad name"}');
      const file = join(dir, `${name}.json`);
      if (req.method === 'GET') {
        const src = await fs.readFile(file, 'utf8').catch(() => null);
        if (src === null) return send(404, '{"error":"not found"}');
        return send(200, src);
      }
      if (req.method === 'PUT') {
        const body = (await readBody(req)).toString('utf8');
        try {
          JSON.parse(body);
        } catch (e) {
          // Reject before persisting: a half-written document would make the
          // graph unopenable, and the store has no history to fall back on.
          return send(400, JSON.stringify({ error: `invalid JSON: ${e.message}` }));
        }
        await fs.writeFile(file, body);
        return send(200, '{"ok":true}');
      }
      if (req.method === 'DELETE') {
        await fs.rm(file, { force: true });
        return send(200, '{"ok":true}');
      }
      return send(405, '{"error":"method"}');
    } catch (e) {
      return send(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
}