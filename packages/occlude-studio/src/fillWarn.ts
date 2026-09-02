/**
 * The warn-on-edit dialog (spec rule 8): saving a fill that saved sketches
 * reference is, transitively, an edit to those sketches. The actual list
 * of using sketches (scanned by the server at that moment), Clone as the
 * default (Enter), Edit-anyway the deliberate one. No versioning, no
 * locks — and never a sketch edit on the artist's behalf: Clone saves the
 * copy and stops.
 */

import { FILL_NAME_RE } from 'occlude';

export type WarnChoice = { action: 'clone'; name: string } | { action: 'edit' } | { action: 'cancel' };

export function warnOnEdit(
  name: string,
  uses: string[],
  suggested: string,
  taken: Set<string>,
): Promise<WarnChoice> {
  return new Promise((resolve) => {
    let result: WarnChoice = { action: 'cancel' };
    const dlg = document.createElement('dialog');
    dlg.className = 'fill-warn';
    const h = document.createElement('h3');
    h.textContent = `'${name}' is used by ${uses.length} saved sketch${uses.length === 1 ? '' : 'es'}`;
    const p = document.createElement('p');
    p.textContent =
      'Saving changes their ink the next time they render or plot — same seed, ' +
      'different marks. Clone keeps them exactly as plotted; your sketches are not touched either way.';
    const ul = document.createElement('ul');
    for (const u of uses) {
      const li = document.createElement('li');
      li.textContent = u;
      ul.append(li);
    }
    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'clone as';
    const nameInput = document.createElement('input');
    nameInput.value = suggested;
    nameInput.spellcheck = false;
    nameRow.append(nameLabel, nameInput);
    const err = document.createElement('div');
    err.className = 'err';
    const actions = document.createElement('div');
    actions.className = 'fill-warn-actions';
    const btn = (label: string, onclick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = onclick;
      return b;
    };
    const cancel = btn('Cancel', () => dlg.close());
    const edit = btn('Edit anyway', () => {
      result = { action: 'edit' };
      dlg.close();
    });
    edit.className = 'danger';
    edit.title = `Overwrite '${name}' — the listed sketches change`;
    const clone = btn('Clone', () => {
      const n = nameInput.value.trim();
      if (!FILL_NAME_RE.test(n)) {
        err.textContent = 'letters, digits, - and _ only';
        return;
      }
      if (taken.has(n)) {
        err.textContent = `'${n}' already exists`;
        return;
      }
      result = { action: 'clone', name: n };
      dlg.close();
    });
    clone.className = 'primary';
    clone.autofocus = true;
    clone.title = 'Save under a new name; the listed sketches keep the original';
    actions.append(cancel, edit, clone);
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clone.click();
      }
    };
    dlg.append(h, p, ul, nameRow, err, actions);
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}
