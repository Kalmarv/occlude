import { expect, it } from 'vitest';
import ts from 'typescript';
import type { Camera3 } from 'occlude';
import { cameraConfigEdit } from './cameraConfig.js';

const camera: Camera3 = { kind: 'orthographic', span: 4, eye: [1,2,3], target: [0,0,0], near: .1, far: 10 };
function evaluate(source: string) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: Record<string, any> = {};
  const sketch = (config: unknown, fn: unknown) => ({ config, fn });
  new Function('require','exports',js)(() => ({ sketch, sketchAsync: sketch }),exports);
  return exports;
}

it.each([
  `import { sketch } from 'occlude'; export default sketch({ seed: 42 /* keep */ }, () => 'model');`,
  `import { sketchAsync as make } from 'occlude'; const cfg = {seed:42}; const def = make(cfg, () => 'model'); export default def;`,
  `import * as o from 'occlude'; export const definition = o.sketch({seed:42}, () => 'model');`,
  `import { sketch } from 'occlude'; const make = () => sketch({seed:42}, () => 'model'); export default make();`,
  `import { sketch } from 'occlude'; const args = [{seed:42}, () => 'model'] as const; export default sketch(...args);`,
  `import { sketch } from 'occlude'; const cameras3 = {}; export default sketch({seed:42, cameras3}, () => 'model');`,
  `import { sketch } from 'occlude'; export default sketch({seed:42, get cameras3(){return {};}}, () => 'model');`,
  `const config = {seed:42}; export default {config, fn: () => 'model'};`,
  `export default {get config(){return {seed:42};}, fn: () => 'model'};`,
  `const original={fn:()=> 'model'};const cfg={seed:42};export default globalThis.Object.create(original,{config:{get:()=>cfg}});`,
  `const original={fn:()=> 'model'};export default globalThis.Object.create(original,{config:{get:()=>{return {seed:42};}}});`,
])('writes portable configuration and replaces it on the next commit: %s', async source => {
  const first = (await cameraConfigEdit(source))({ main: camera });
  const def = Object.values(evaluate(first))[0];
  expect(def.config.seed).toBe(42); expect(def.fn()).toBe('model');
  expect(def.config.cameras3).toEqual({ main: camera });
  const changed = { ...camera, span: 8 };
  const second = (await cameraConfigEdit(first))({ main: changed });
  expect(Object.values(evaluate(second))[0].config.cameras3).toEqual({ main: changed });
  expect(second.length).toBe(first.length);
  if (source.includes('/* keep */')) expect(second).toContain('/* keep */');
});

it('does not evaluate config expressions twice or lose a later-spread override', async () => {
  const source = `import { sketch } from 'occlude'; let calls = 0; const cfg = () => {calls++;return {seed:42,cameras3:{old:{}}};}; export default sketch({...cfg(), ...{cameras3:{later:{}}}}, () => calls);`;
  const changed = (await cameraConfigEdit(source))({ main: camera });
  const def = evaluate(changed).default;
  expect(def.fn()).toBe(1); expect(def.config.cameras3).toEqual({ main: camera });
});

it('keeps prototype-like scene names as own configuration entries', async () => {
  const source = `import { sketch } from 'occlude'; export default sketch({}, () => []);`;
  const cameras = Object.fromEntries([['__proto__',camera]]);
  const def = evaluate((await cameraConfigEdit(source))(cameras)).default;
  expect(Object.keys(def.config.cameras3)).toEqual(['__proto__']);
});


it('reads a default definition configuration getter only once', async () => {
  const source = `let calls=0; export default {get config(){calls++;return {seed:42};},fn:()=>calls};`;
  const def = evaluate((await cameraConfigEdit(source))({main:camera})).default;
  expect(def.fn()).toBe(0);
  expect(def.config.seed).toBe(42);
  expect(def.fn()).toBe(1);
});


it('preserves deferred configuration access and inherited sketch properties', async () => {
  const source = `let seed=1; const original=Object.create({get config(){return {seed};},fn(){return this.config.seed;}}); export default original; seed=42;`;
  const first=(await cameraConfigEdit(source))({main:camera});
  const def=evaluate(first).default;
  expect(def.config.seed).toBe(42);expect(def.fn()).toBe(42);
  const second=(await cameraConfigEdit(first))({main:camera});
  expect(second).toBe(first);
});

it('refuses to guess which named export produced the rendered definition', async () => {
  const source = `import {sketch} from 'occlude';const make=()=>sketch({},()=>[]);export const first=make();export const second=sketch({},()=>[]);`;
  await expect(cameraConfigEdit(source)).rejects.toThrow('default export');
});
