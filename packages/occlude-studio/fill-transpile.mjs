/**
 * THE one transpile step for stored fill files (fills-fields-spec rule 8):
 * Node's built-in TypeScript type stripping, applied to the .ts source at
 * read time. The studio server strips on GET /api/fills/<name>/js for the
 * browser runtimes (studio worker, docs page); the node tools call this
 * same function in-process. Everything downstream — the ESM→CJS rewrite,
 * the occlude-only import check, evaluation, registration — is
 * `loadFillModule` in the occlude package, shared by all consumers.
 *
 * Strip-only mode: annotations become whitespace (line numbers survive
 * into stack traces); non-erasable syntax (enums, namespaces, parameter
 * properties) is refused with a clear error. No emit is ever stored — the
 * .ts file is the single source of truth, editable with any tool.
 */

import { stripTypeScriptTypes } from 'node:module';

export function stripFillTypes(source) {
  return stripTypeScriptTypes(source, { mode: 'strip' });
}
