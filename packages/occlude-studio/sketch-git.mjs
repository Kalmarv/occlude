/**
 * Git underneath the sketch library. The sketches directory is its own
 * repository: every save is a commit, a snapshot is an annotated tag
 * (seed + label frozen with the source), a fork is a new file whose first
 * line names its parent. The studio only reads what git keeps; this module
 * is the whole of the git surface (plain `git` on PATH, no dependencies).
 */

import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Create the repository on first use and commit whatever is already there. */
export async function ensureRepo(dir) {
  if (existsSync(join(dir, '.git'))) return;
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.name', 'occlude studio']);
  await git(dir, ['config', 'user.email', 'studio@occlude.local']);
  // Thumbnails and the plot log are derived/append-only: not history.
  writeFileSync(join(dir, '.gitignore'), '.history/\n.thumbs/\n*.jsonl\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'import existing sketches']).catch(() => undefined);
}

/** Stage `paths` and commit them if anything changed. Returns the short
 * sha of HEAD afterwards. */
export async function commit(dir, paths, message) {
  await git(dir, ['add', '-A', '--', ...paths]);
  const staged = await git(dir, ['diff', '--cached', '--name-only', '--', ...paths]);
  if (staged.trim() !== '') await git(dir, ['commit', '-q', '-m', message, '--', ...paths]);
  return head(dir);
}

export async function remove(dir, path, message) {
  await git(dir, ['rm', '-q', '--ignore-unmatch', '--', path]);
  const staged = await git(dir, ['diff', '--cached', '--name-only', '--', path]);
  if (staged.trim() !== '') await git(dir, ['commit', '-q', '-m', message, '--', path]);
}

export async function head(dir) {
  return (await git(dir, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim();
}

/** The fork header: first line of a forked file. */
export const FORK_HEADER = /^\/\/ fork of ([a-zA-Z0-9 _-]+) @ (\S+)/;

export function forkHeader(parent, ref) {
  return `// fork of ${parent} @ ${ref}\n`;
}

export function parentOf(source) {
  const m = source.match(FORK_HEADER);
  return m ? { parent: m[1], ref: m[2] } : null;
}

const tagOf = (name, id) => `snap/${name}/${id}`;

/** Freeze the sketch's current commit as a snapshot: an annotated tag whose
 * message carries the seed and label as one JSON line. */
export async function snapshot(dir, name, meta) {
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  await git(dir, ['tag', '-a', tagOf(name, id), '-m', JSON.stringify(meta)]);
  return id;
}

/** Every snapshot in the repo, newest first: { name, id, sha, meta }. */
export async function snapshots(dir, name) {
  const pattern = name ? tagOf(name, '*') : 'snap/*';
  const out = await git(dir, [
    'tag', '-l', pattern, '--sort=-creatordate',
    '--format=%(refname:short)%09%(objectname:short)%09%(*objectname:short)%09%(contents:subject)',
  ]).catch(() => '');
  const list = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, tagSha, commitSha, subject] = line.split('\t');
    const parts = ref.split('/');
    if (parts.length !== 3) continue;
    let meta = {};
    try {
      meta = JSON.parse(subject);
    } catch {
      meta = { label: subject };
    }
    list.push({ name: parts[1], id: parts[2], sha: commitSha || tagSha, meta });
  }
  return list;
}

export async function snapshotSource(dir, name, id) {
  return git(dir, ['show', `${tagOf(name, id)}:${name}.ts`]);
}

export async function deleteSnapshot(dir, name, id) {
  await git(dir, ['tag', '-d', tagOf(name, id)]);
}

/** Commit history of one file, newest first: { sha, time, subject }. */
export async function history(dir, name) {
  const out = await git(dir, ['log', '--format=%h%x09%ct%x09%s', '--', `${name}.ts`]).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, time, subject] = l.split('\t');
      return { sha, time: Number(time) * 1000, subject };
    });
}
