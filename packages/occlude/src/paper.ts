/** Paper presets, portrait mm. Orientation is applied by the caller. */

export interface Paper {
  name: string;
  /** Width × height in mm, portrait. */
  w: number;
  h: number;
}

export const PAPERS: Record<string, Paper> = {
  A3: { name: 'A3', w: 297, h: 420 },
  A4: { name: 'A4', w: 210, h: 297 },
  A5: { name: 'A5', w: 148, h: 210 },
  A6: { name: 'A6', w: 105, h: 148 },
  Letter: { name: 'Letter', w: 215.9, h: 279.4 },
  Square20: { name: 'Square20', w: 200, h: 200 },
};

export interface PaperChoice {
  /** Preset name or explicit size. */
  paper: keyof typeof PAPERS | { w: number; h: number };
  landscape?: boolean;
}

export function paperSize(choice: PaperChoice): { w: number; h: number } {
  const base =
    typeof choice.paper === 'string' ? PAPERS[choice.paper] : choice.paper;
  if (!base) {
    throw new Error(`unknown paper '${String(choice.paper)}'`);
  }
  return choice.landscape ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
}
