/**
 * `occlude/fonts` — the faces that travel with the library, as module data
 * rather than uploaded assets, so a sketch that sets type needs no store:
 *
 *   import { sketch, strokes } from 'occlude';
 *   import { relief } from 'occlude/fonts';
 *
 *   export default sketch({ aspect: [2, 1] }, (t) =>
 *     strokes(t.text('Relief', { font: relief, size: 30, at: [8, 60] })));
 *
 * Five are Hershey's, digitized at the U. S. National Bureau of Standards
 * and in the public domain on the acknowledgements each module carries
 * (the whole notice is in HERSHEY-NOTICE.txt beside them). One is Relief
 * SingleLine, under the SIL Open Font License 1.1 (RELIEF-LICENSE.txt).
 * Each face is its own module with its own source string, and parses the
 * first time it is asked anything.
 */

export { hersheySimplex, ROWMANS_JHF } from './hersheySimplex.js';
export { hersheyDuplex, ROWMAND_JHF } from './hersheyDuplex.js';
export { hersheyTriplex, ROWMANT_JHF } from './hersheyTriplex.js';
export { hersheyScript, SCRIPTS_JHF } from './hersheyScript.js';
export { hersheyGothic, GOTHICENG_JHF } from './hersheyGothic.js';
export { relief, RELIEF_SVG } from './relief.js';
