/**
 * The Assets page: browse, upload (button or drag-drop), and delete the
 * server-side asset store, with thumbnails and copy-paste reference
 * snippets for sketches.
 */

import './style.css';
import './wa.js';
import {
  deleteAsset, listAssets, renameAsset, uploadAsset, type AssetInfo,
} from './assetApi.js';
import { confirmDialog, notify, promptDialog } from './wa.js';
import { iconButton, setIcon } from './icons.js';
import { mountShell } from './shell.js';
mountShell('assets');

const grid = document.getElementById('assets-grid')!;

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const SVG_EXT = /\.svg$/i;

function snippetFor(name: string): string {
  if (SVG_EXT.test(name)) return `svg(asset('${name}'), { x: 0, y: 0, width: b.w })`;
  return `image('${name}', { x: 0, y: 0, width: 100 })`;
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function refresh(): Promise<void> {
  let assets: AssetInfo[];
  try {
    assets = await listAssets();
  } catch {
    grid.textContent = 'asset store unavailable';
    return;
  }
  grid.innerHTML = '';
  if (assets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'assets-hint';
    empty.textContent = 'No assets yet — drop an SVG or image anywhere on this page.';
    grid.append(empty);
    return;
  }
  for (const a of assets) {
    const card = document.createElement('div');
    card.className = 'asset-card';

    const thumb = document.createElement('div');
    thumb.className = 'asset-thumb';
    if (IMAGE_EXT.test(a.name) || SVG_EXT.test(a.name)) {
      const img = document.createElement('img');
      img.src = `/api/assets/${encodeURIComponent(a.name)}`;
      img.alt = a.name;
      img.loading = 'lazy';
      thumb.append(img);
    } else {
      thumb.textContent = a.name.split('.').pop()?.toUpperCase() ?? '?';
    }
    card.append(thumb);

    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    const nm = document.createElement('div');
    nm.className = 'asset-name';
    nm.textContent = a.name;
    nm.title = a.name;
    const size = document.createElement('div');
    size.className = 'asset-size';
    size.textContent = fmtSize(a.size);
    meta.append(nm, size);
    card.append(meta);

    const actions = document.createElement('div');
    actions.className = 'asset-actions';
    const rename = iconButton('rename', 'Rename', async () => {
      const to = (await promptDialog({ title: 'Rename asset', body: 'Extension included.', placeholder: a.name, confirm: 'Rename' }))?.trim();
      if (!to || to === a.name) return;
      try {
        await renameAsset(a.name, to);
        await refresh();
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), 'danger');
      }
    });
    const copy = iconButton('copy', `Copy the reference: ${snippetFor(a.name)}`, async () => {
      await navigator.clipboard.writeText(snippetFor(a.name));
      setIcon(copy, 'check', 'Copied');
      setTimeout(() => setIcon(copy, 'copy', `Copy the reference: ${snippetFor(a.name)}`), 1200);
    });
    const del = iconButton('trash', 'Delete this asset', async () => {
      if (!(await confirmDialog({ title: 'Delete asset', body: `Delete '${a.name}' from the server?`, confirm: 'Delete', danger: true }))) return;
      await deleteAsset(a.name);
      await refresh();
    });
    actions.append(rename, copy, del);
    card.append(actions);

    grid.append(card);
  }
}

async function uploadFiles(files: Iterable<File>): Promise<void> {
  try {
    for (const file of files) await uploadAsset(file);
    await refresh();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), 'danger');
  }
}

document.getElementById('btn-upload')!.onclick = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svg,.png,.jpg,.jpeg,.webp,.gif';
  input.multiple = true;
  input.onchange = () => void uploadFiles(input.files ?? []);
  input.click();
};

// Drag-drop anywhere on the page.
document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dropping');
});
document.body.addEventListener('dragleave', () => {
  document.body.classList.remove('dropping');
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  if (e.dataTransfer?.files.length) void uploadFiles(e.dataTransfer.files);
});

void refresh();
