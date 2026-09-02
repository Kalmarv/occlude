/**
 * Server-side store, shared by the Vite dev/preview middleware and the
 * production server (server.mjs). Named sketches persist as .ts files under
 * ./sketches — a git repository (sketch-git.mjs): every save is a commit,
 * forks are files with a `// fork of` header, snapshots are annotated tags
 * — and the pen library as ./sketches/pens.json. Shared by every
 * browser/device that reaches this server.
 *
 *   GET    /api/sketches                        → [{ name, mtime, parent, snapshots }]
 *   GET    /api/sketches/<name>                 → source text
 *   PUT    /api/sketches/<name>                 → save (commit) body as source
 *   DELETE /api/sketches/<name>                 → remove (commit)
 *   POST   /api/sketches/<name>/fork {to}       → new file `to` with a fork header
 *   GET    /api/sketches/<name>/history         → [{ sha, time, subject }]
 *   GET    /api/sketches/<name>/snapshots       → [{ id, sha, meta }]
 *   POST   /api/sketches/<name>/snapshots {seed,label} → { id }
 *   GET    /api/sketches/<name>/snapshots/<id>  → { source, meta }
 *   DELETE /api/sketches/<name>/snapshots/<id>
 *   POST   /api/sketches/<name>/snapshots/<id>/fork {to}
 *   GET/PUT /api/sketches/<name>/thumb          → PNG (also …/snapshots/<id>/thumb)
 *   GET    /api/pens             → pen library JSON (404 before first save)
 *   PUT    /api/pens             → save pen library JSON
 */

import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import * as sg from './sketch-git.mjs';

const safe = (name) => (/^[a-zA-Z0-9 _-]{1,64}$/.test(name) ? name : null);
const SNAP_ID = /^[0-9TZ]{8,20}$/;
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};

/**
 * Returns a connect-style handler: (req, res, next) => void.
 * Calls next() (when given) for non-/api/sketches paths, else 404s.
 */
export function createSketchHandler(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const thumbs = join(dir, '.thumbs');
  if (!existsSync(thumbs)) mkdirSync(thumbs, { recursive: true });
  const repo = sg.ensureRepo(dir).catch((e) => {
    console.error(`sketch library: git unavailable (${e.message}) — saves still write files`);
  });

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
      await repo;
      const rest = url.pathname.slice('/api/sketches'.length).replace(/^\//, '');
      if (rest === '') {
        if (req.method !== 'GET') return send(405, '{"error":"method"}');
        const files = await fs.readdir(dir);
        const snaps = await sg.snapshots(dir).catch(() => []);
        const list = await Promise.all(
          files
            .filter((f) => f.endsWith('.ts'))
            .map(async (f) => {
              const st = await fs.stat(join(dir, f));
              const name = f.slice(0, -3);
              // The fork header is the first line; read only that much.
              const fh = await fs.open(join(dir, f));
              const { bytesRead, buffer } = await fh.read(Buffer.alloc(160), 0, 160, 0);
              await fh.close();
              const parent = sg.parentOf(buffer.toString('utf8', 0, bytesRead));
              return {
                name,
                mtime: st.mtimeMs,
                parent: parent?.parent ?? null,
                snapshots: snaps.filter((s) => s.name === name).length,
                thumb: existsSync(join(thumbs, `${name}.png`)),
              };
            }),
        );
        list.sort((a, b) => b.mtime - a.mtime);
        return send(200, JSON.stringify(list));
      }
      const [rawName, sub, snapId, sub2] = rest.split('/');
      const name = safe(decodeURIComponent(rawName));
      if (!name) return send(400, '{"error":"bad name"}');
      const file = join(dir, `${name}.ts`);
      const png = (status, bytes) => {
        res.statusCode = status;
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'no-store');
        res.end(bytes);
      };
      if (sub === 'thumb') {
        const tp = join(thumbs, `${name}.png`);
        if (req.method === 'GET') {
          const bytes = await fs.readFile(tp).catch(() => null);
          return bytes ? png(200, bytes) : send(404, '{"error":"no thumb"}');
        }
        if (req.method === 'PUT') {
          await fs.writeFile(tp, await readBody(req));
          return send(200, '{"ok":true}');
        }
        return send(405, '{"error":"method"}');
      }
      if (sub === 'history') {
        if (req.method !== 'GET') return send(405, '{"error":"method"}');
        const commits = await sg.history(dir, name);
        const snaps = await sg.snapshots(dir, name);
        return send(200, JSON.stringify({ commits, snapshots: snaps }));
      }
      if (sub === 'fork') {
        if (req.method !== 'POST') return send(405, '{"error":"method"}');
        const { to } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const target = safe(String(to ?? ''));
        if (!target) return send(400, '{"error":"bad fork name"}');
        if (existsSync(join(dir, `${target}.ts`))) return send(409, '{"error":"a sketch of that name exists"}');
        const src = await fs.readFile(file, 'utf8').catch(() => null);
        if (src === null) return send(404, '{"error":"not found"}');
        const ref = await sg.head(dir);
        await fs.writeFile(join(dir, `${target}.ts`), sg.forkHeader(name, ref) + src);
        await sg.commit(dir, [`${target}.ts`], `fork ${target} from ${name} @ ${ref}`).catch(() => undefined);
        return send(200, JSON.stringify({ ok: true, name: target }));
      }
      if (sub === 'snapshots') {
        if (snapId === undefined) {
          if (req.method === 'GET') return send(200, JSON.stringify(await sg.snapshots(dir, name)));
          if (req.method === 'POST') {
            if (!existsSync(file)) return send(404, '{"error":"not found"}');
            const meta = JSON.parse((await readBody(req)).toString('utf8') || '{}');
            // Make sure the tag points at the source as saved.
            await sg.commit(dir, [`${name}.ts`], `save ${name}`);
            const id = await sg.snapshot(dir, name, {
              seed: meta.seed ?? null,
              label: String(meta.label ?? ''),
              at: new Date().toISOString(),
            });
            return send(200, JSON.stringify({ ok: true, id }));
          }
          return send(405, '{"error":"method"}');
        }
        if (!SNAP_ID.test(snapId)) return send(400, '{"error":"bad snapshot id"}');
        if (sub2 === 'thumb') {
          const tp = join(thumbs, `${name}@${snapId}.png`);
          if (req.method === 'GET') {
            const bytes = await fs.readFile(tp).catch(() => null);
            return bytes ? png(200, bytes) : send(404, '{"error":"no thumb"}');
          }
          if (req.method === 'PUT') {
            await fs.writeFile(tp, await readBody(req));
            return send(200, '{"ok":true}');
          }
          return send(405, '{"error":"method"}');
        }
        if (sub2 === 'fork') {
          if (req.method !== 'POST') return send(405, '{"error":"method"}');
          const { to } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const target = safe(String(to ?? ''));
          if (!target) return send(400, '{"error":"bad fork name"}');
          if (existsSync(join(dir, `${target}.ts`))) return send(409, '{"error":"a sketch of that name exists"}');
          const src = await sg.snapshotSource(dir, name, snapId).catch(() => null);
          if (src === null) return send(404, '{"error":"snapshot not found"}');
          await fs.writeFile(join(dir, `${target}.ts`), sg.forkHeader(name, `snapshot ${snapId}`) + src);
          await sg.commit(dir, [`${target}.ts`], `fork ${target} from ${name} @ snapshot ${snapId}`).catch(() => undefined);
          return send(200, JSON.stringify({ ok: true, name: target }));
        }
        if (req.method === 'GET') {
          const src = await sg.snapshotSource(dir, name, snapId).catch(() => null);
          if (src === null) return send(404, '{"error":"snapshot not found"}');
          const meta = (await sg.snapshots(dir, name)).find((s) => s.id === snapId)?.meta ?? {};
          return send(200, JSON.stringify({ source: src, meta }));
        }
        if (req.method === 'DELETE') {
          await sg.deleteSnapshot(dir, name, snapId).catch(() => undefined);
          await fs.unlink(join(thumbs, `${name}@${snapId}.png`)).catch(() => undefined);
          return send(200, '{"ok":true}');
        }
        return send(405, '{"error":"method"}');
      }
      if (sub !== undefined) return send(404, '{"error":"not found"}');
      if (req.method === 'GET') {
        const src = await fs.readFile(file, 'utf8').catch(() => null);
        if (src === null) return send(404, '{"error":"not found"}');
        return send(200, src, 'text/plain');
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        await fs.writeFile(file, body);
        // Every save is a commit; git is the history (.history retired).
        await sg.commit(dir, [`${name}.ts`], `save ${name}`).catch(() => undefined);
        return send(200, '{"ok":true}');
      }
      if (req.method === 'DELETE') {
        // The file, its snapshots (tags + thumbs), and its thumb go; the
        // commits stay — git is the history.
        for (const s of await sg.snapshots(dir, name).catch(() => [])) {
          await sg.deleteSnapshot(dir, name, s.id).catch(() => undefined);
          await fs.unlink(join(thumbs, `${name}@${s.id}.png`)).catch(() => undefined);
        }
        await sg.remove(dir, `${name}.ts`, `delete ${name}`).catch(() => undefined);
        await fs.unlink(file).catch(() => undefined);
        await fs.unlink(join(thumbs, `${name}.png`)).catch(() => undefined);
        return send(200, '{"ok":true}');
      }
      return send(405, '{"error":"method"}');
    } catch (e) {
      return send(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
}
