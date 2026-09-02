/**
 * Server-side fill library, shared by the Vite middleware and the production
 * server (server.mjs). Custom fills persist as .ts files under ./fills —
 * beside the sketches, shared by every browser/device that reaches this
 * server. Built-in fills (hatch, crosshatch, stipple, solid) NEVER live
 * here: they resolve from the occlude package and are ink-immutable.
 *
 *   GET    /api/fills               → [{ name, mtime }]
 *   GET    /api/fills/<name>        → TS source
 *   GET    /api/fills/<name>/js     → type-stripped JS (fill-transpile.mjs)
 *   GET    /api/fills/<name>/uses   → saved sketches referencing fill('<name>')
 *                                     — scanned NOW, never a maintained index
 *   PUT    /api/fills/<name>        → save body as source (history kept)
 *   DELETE /api/fills/<name>        → remove (history kept)
 */

import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { stripFillTypes } from './fill-transpile.mjs';

/** Fill names are `fill('name')` literals: no spaces, no quotes. */
const safe = (name) => (/^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : null);

/** Mirrors BUILTIN_FILL_NAMES in packages/occlude/src/fills.ts (this file is
 * dependency-free plain node); a studio test keeps the two lists equal. */
export const BUILTIN_FILL_NAMES = ['hatch', 'crosshatch', 'solid', 'stipple'];

const HISTORY_KEEP = 20;
async function keepHistory(dir, name, file, newBody) {
  const prev = await fs.readFile(file, 'utf8').catch(() => null);
  if (prev === null || prev === newBody) return;
  const hist = join(dir, '.history');
  if (!existsSync(hist)) mkdirSync(hist, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(join(hist, `${name}@${stamp}.ts`), prev);
  const old = (await fs.readdir(hist)).filter((f) => f.startsWith(`${name}@`)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) {
    await fs.unlink(join(hist, f)).catch(() => undefined);
  }
}

/** Does this sketch source use fill('<name>')? Literal names only (single or
 * double quotes) — the same contract the runtime scan keys on. */
export function sketchUsesFill(source, name) {
  const q = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bfill\\(\\s*['"]${q}['"]`).test(source);
}

/** Names of saved sketches whose source references the fill — read at call
 * time from the sketches directory. */
export async function scanFillUses(sketchesDir, name) {
  const files = await fs.readdir(sketchesDir).catch(() => []);
  const uses = [];
  for (const f of files.filter((f) => f.endsWith('.ts')).sort()) {
    const src = await fs.readFile(join(sketchesDir, f), 'utf8').catch(() => '');
    if (sketchUsesFill(src, name)) uses.push(f.slice(0, -3));
  }
  return uses;
}

export function createFillHandler(dir, sketchesDir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/fills')) {
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
      const rest = url.pathname.slice('/api/fills'.length).replace(/^\//, '');
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
        list.sort((a, b) => a.name.localeCompare(b.name));
        return send(200, JSON.stringify(list));
      }
      const [rawName, sub] = rest.split('/');
      const name = safe(decodeURIComponent(rawName));
      if (!name) return send(400, '{"error":"bad name"}');
      if (BUILTIN_FILL_NAMES.includes(name)) {
        return send(400, JSON.stringify({
          error: `'${name}' is a built-in fill — built-ins never live in the library; clone it under a new name`,
        }));
      }
      const file = join(dir, `${name}.ts`);
      if (sub === 'uses') {
        if (req.method !== 'GET') return send(405, '{"error":"method"}');
        return send(200, JSON.stringify(await scanFillUses(sketchesDir, name)));
      }
      if (sub === 'js') {
        if (req.method !== 'GET') return send(405, '{"error":"method"}');
        const src = await fs.readFile(file, 'utf8').catch(() => null);
        if (src === null) return send(404, '{"error":"not found"}');
        try {
          return send(200, stripFillTypes(src), 'text/javascript');
        } catch (e) {
          return send(422, JSON.stringify({
            error: `fill '${name}': ${e instanceof Error ? e.message : String(e)}`,
          }));
        }
      }
      if (sub !== undefined) return send(404, '{"error":"not found"}');
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
