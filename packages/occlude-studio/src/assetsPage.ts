/**
 * The Assets page: browse, upload (button or drag-drop), and delete the
 * server-side asset store, with thumbnails and copy-paste reference
 * snippets for sketches.
 */

import './style.css';
import { deleteAsset, listAssets, uploadAsset, type AssetInfo } from './assetApi.js';

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
    const copy = document.createElement('button');
    copy.textContent = 'copy ref';
    copy.title = snippetFor(a.name);
    copy.onclick = async () => {
      await navigator.clipboard.writeText(snippetFor(a.name));
      copy.textContent = 'copied!';
      setTimeout(() => (copy.textContent = 'copy ref'), 1200);
    };
    const del = document.createElement('button');
    del.textContent = 'delete';
    del.onclick = async () => {
      if (!confirm(`Delete asset '${a.name}' from the server?`)) return;
      await deleteAsset(a.name);
      await refresh();
    };
    actions.append(copy, del);
    card.append(actions);

    grid.append(card);
  }
}

async function uploadFiles(files: Iterable<File>): Promise<void> {
  try {
    for (const file of files) await uploadAsset(file);
    await refresh();
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
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
