/**
 * Server-side asset store (uploaded SVGs and images), shared by the Vite
 * middleware and the production server. Files persist under ./assets —
 * shared by every browser/device that reaches this server, like sketches.
 *
 *   GET    /api/assets         → [{ name, size, mtime }]
 *   GET    /api/assets/<name>  → file bytes (content-type by extension)
 *   PUT    /api/assets/<name>  → save body bytes
 *   DELETE /api/assets/<name>  → remove
 */

import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { extname, join } from 'node:path';

const safe = (name) => (/^[a-zA-Z0-9 ._-]{1,80}$/.test(name) && !name.includes('..') ? name : null);

const MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

export function createAssetHandler(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/assets')) {
      if (next) return next();
      res.statusCode = 404;
      return res.end('{"error":"not found"}');
    }
    const send = (status, body, type = 'application/json') => {
      res.statusCode = status;
      res.setHeader('content-type', type);
      res.end(body);
    };
    try {
      const rest = url.pathname.slice('/api/assets'.length).replace(/^\//, '');
      if (rest === '') {
        if (req.method !== 'GET') return send(405, '{"error":"method"}');
        const files = await fs.readdir(dir);
        const list = await Promise.all(
          files.map(async (f) => {
            const st = await fs.stat(join(dir, f));
            return st.isFile() ? { name: f, size: st.size, mtime: st.mtimeMs } : null;
          }),
        );
        return send(200, JSON.stringify(list.filter(Boolean).sort((a, b) => b.mtime - a.mtime)));
      }
      const name = safe(decodeURIComponent(rest));
      if (!name) return send(400, '{"error":"bad name"}');
      const file = join(dir, name);
      if (req.method === 'GET') {
        const bytes = await fs.readFile(file).catch(() => null);
        if (bytes === null) return send(404, '{"error":"not found"}');
        return send(200, bytes, MIME[extname(name).toLowerCase()] ?? 'application/octet-stream');
      }
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        if (body.length > 32 * 1024 * 1024) return send(413, '{"error":"too large (32MB max)"}');
        await fs.writeFile(file, body);
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
