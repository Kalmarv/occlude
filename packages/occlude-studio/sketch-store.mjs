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

/** Keep the last versions per sketch under ./sketches/.history — a save
 * that overwrites different content (or a delete) snapshots the old file
 * first, so one reflexive Ctrl+S can never destroy work. Capped per name. */
const HISTORY_KEEP = 20;
async function keepHistory(dir, name, file, newBody) {
  const prev = await fs.readFile(file, 'utf8').catch(() => null);
  if (prev === null || prev === newBody) return;
  const hist = join(dir, '.history');
  if (!existsSync(hist)) mkdirSync(hist, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(join(hist, `${name}@${stamp}.ts`), prev);
  const old = (await fs.readdir(hist))
    .filter((f) => f.startsWith(`${name}@`))
    .sort();
  for (const f of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) {
    await fs.unlink(join(hist, f)).catch(() => undefined);
  }
}

/**
 * Returns a connect-style handler: (req, res, next) => void.
 * Calls next() (when given) for non-/api/sketches paths, else 404s.
 */
export function createSketchHandler(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    const isPens = url.pathname === '/api/pens';
    const isProfiles = url.pathname === '/api/profiles';
    const isPlotLog = url.pathname === '/api/plotlog';
    if (!url.pathname.startsWith('/api/sketches') && !isPens && !isProfiles && !isPlotLog) {
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
      if (isPlotLog) {
        const file = join(dir, 'plots.jsonl');
        if (req.method === 'GET') {
          const src = await fs.readFile(file, 'utf8').catch(() => '');
          return send(200, src, 'text/plain');
        }
        if (req.method === 'POST') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = Buffer.concat(chunks).toString('utf8');
          JSON.parse(body); // one valid JSON record per line
          await fs.appendFile(file, body.trimEnd() + '\n');
          return send(200, '{"ok":true}');
        }
        return send(405, '{"error":"method"}');
      }
      if (isProfiles) {
        const file = join(dir, 'profiles.json');
        if (req.method === 'GET') {
          const src = await fs.readFile(file, 'utf8').catch(() => null);
          if (src === null) return send(404, '{"error":"no profiles saved yet"}');
          return send(200, src);
        }
        if (req.method === 'PUT') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = Buffer.concat(chunks).toString('utf8');
          JSON.parse(body);
          await fs.writeFile(file, body);
          return send(200, '{"ok":true}');
        }
        return send(405, '{"error":"method"}');
      }
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
        const body = Buffer.concat(chunks);
        await keepHistory(dir, name, file, body.toString('utf8'));
        await fs.writeFile(file, body);
        return send(200, '{"ok":true}');
      }
      if (req.method === 'DELETE') {
        // Deletes go to history too — nothing in the store is ever lost.
        const prev = await fs.readFile(file, 'utf8').catch(() => null);
        if (prev !== null) await keepHistory(dir, name, file, null);
        await fs.unlink(file).catch(() => undefined);
        return send(200, '{"ok":true}');
      }
      return send(405, '{"error":"method"}');
    } catch (e) {
      return send(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
}
