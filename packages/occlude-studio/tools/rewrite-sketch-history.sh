#!/usr/bin/env bash
# Apply the 2026-09-06 vocabulary migration to EVERY copy of every sketch
# in the store: the working files, every commit on every branch, every
# snapshot tag (annotated tags are re-created on the rewritten commits
# with their metadata messages intact), and every `.history/` save.
#
# Run tools/verify-sketch-migration.mjs FIRST — it proves the rewrite is
# output-identical on every one of these sources. This script only applies
# what that proved.
#
#   tools/rewrite-sketch-history.sh [store dir]
#
# A full bundle of the pre-rewrite repository is written next to the store
# before anything changes; `git bundle unbundle` restores it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE="$(cd "${1:-$HERE/../sketches}" && pwd)"
MIGRATE="$HERE/migrate-sketch-source.mjs"

cd "$STORE"
if [ -n "$(git status --porcelain --untracked-files=no -- '*.ts')" ]; then
  echo "sketch sources have uncommitted changes; commit or discard them first" >&2
  git status --short -- '*.ts' >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$STORE/../sketches-pre-rename-$STAMP.bundle"
git bundle create "$BACKUP" --all
echo "backup: $BACKUP"

# Non-sketch edits (pens.json, profiles.json) are the machine's live state:
# park them for the rewrite, restore after.
STASHED=0
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git stash push -q -m "rewrite-sketch-history parking" && STASHED=1
fi

export MIGRATE
git filter-branch -f --tag-name-filter cat --tree-filter '
  for f in *.ts; do
    [ -f "$f" ] || continue
    node "$MIGRATE" < "$f" > "$f.migrated" && mv "$f.migrated" "$f"
  done
' -- --all

# filter-branch keeps the old refs under refs/original; the bundle is the
# backup, so drop them and let gc reclaim.
git for-each-ref --format='%(refname)' refs/original/ | xargs -r -n1 git update-ref -d
git reflog expire --expire=now --all
git gc -q --prune=now

if [ "$STASHED" = 1 ]; then git stash pop -q; fi

# The file-based saves git ignores.
if [ -d .history ]; then
  for f in .history/*.ts; do
    [ -f "$f" ] || continue
    node "$MIGRATE" < "$f" > "$f.migrated" && mv "$f.migrated" "$f"
  done
fi

echo "rewritten: $(git rev-list --all --count) commits, $(git tag | wc -l) tags, $(ls .history/*.ts 2>/dev/null | wc -l) history saves"
