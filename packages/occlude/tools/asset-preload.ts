/**
 * Headless asset preloading for the CLI tools: reads the studio's
 * server-side assets/ dir and registers everything a sketch source
 * references, mirroring the browser loader (pngjs/jpeg-js stand in for
 * canvas decode; no resolution cap needed off the main thread).
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { assetTable, scanAssetNames, type AssetPixels, type AssetTable } from '../src/index.js';

const assetsDir = fileURLToPath(new URL('../../occlude-studio/assets/', import.meta.url));

/** Every asset a source names, decoded. `dir` reads another store's assets
 * — the coverage report reads the owner's, in the other checkout. */
export function assetsFromDisk(source: string, dir: string = assetsDir): AssetTable {
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  const entries: [string, { text: string } | { pixels: AssetPixels }][] = [];
  for (const name of scanAssetNames(source)) {
    const path = base + name;
    const ext = extname(name).toLowerCase();
    if (ext === '.svg' || ext === '.txt' || ext === '.json') {
      entries.push([name, { text: readFileSync(path, 'utf8') }]);
    } else if (ext === '.png') {
      const png = PNG.sync.read(readFileSync(path));
      entries.push([name, { pixels: {
        width: png.width,
        height: png.height,
        data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
      } }]);
    } else if (ext === '.jpg' || ext === '.jpeg') {
      const img = jpeg.decode(readFileSync(path), { useTArray: true });
      entries.push([name, { pixels: {
        width: img.width,
        height: img.height,
        data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length),
      } }]);
    } else {
      throw new Error(`asset '${name}': unsupported extension for headless tools`);
    }
  }
  return assetTable(entries);
}
