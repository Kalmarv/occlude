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
import { registerImageAsset, registerTextAsset, scanAssetNames } from '../src/index.js';

const assetsDir = fileURLToPath(new URL('../../occlude-studio/assets/', import.meta.url));

export function preloadAssetsFromDisk(source: string): void {
  for (const name of scanAssetNames(source)) {
    const path = assetsDir + name;
    const ext = extname(name).toLowerCase();
    if (ext === '.svg' || ext === '.txt' || ext === '.json') {
      registerTextAsset(name, readFileSync(path, 'utf8'));
    } else if (ext === '.png') {
      const png = PNG.sync.read(readFileSync(path));
      registerImageAsset(name, {
        width: png.width,
        height: png.height,
        data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
      });
    } else if (ext === '.jpg' || ext === '.jpeg') {
      const img = jpeg.decode(readFileSync(path), { useTArray: true });
      registerImageAsset(name, {
        width: img.width,
        height: img.height,
        data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length),
      });
    } else {
      throw new Error(`asset '${name}': unsupported extension for headless tools`);
    }
  }
}
