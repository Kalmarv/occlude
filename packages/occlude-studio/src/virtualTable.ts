/**
 * A windowed table: any number of rows, only the visible ones in the DOM.
 * Rows are a fixed height, so the scroll position maps to a row range and
 * the body is one tall spacer with the window absolutely placed inside it.
 * The caller describes rows by index; the table never holds the data.
 */

export interface VirtualColumn {
  key: string;
  label: string;
  /** Right-align numbers; the first column is left-aligned by default. */
  align?: 'left' | 'right';
}

export interface VirtualTableOptions {
  columns: VirtualColumn[];
  rowCount: number;
  /** The cells of one row, in column order (text, or an element for a swatch). */
  cell(row: number, col: number): string | Node;
  rowClass?(row: number): string;
  onRowClick?(row: number): void;
  onRowHover?(row: number | null): void;
  onHeaderClick?(key: string): void;
  /** A header marker (sort arrow) per column key. */
  headerMark?(key: string): string;
}

const ROW_H = 22;
const OVERSCAN = 8;

export class VirtualTable {
  readonly root = document.createElement('div');
  private readonly head = document.createElement('table');
  private readonly scroller = document.createElement('div');
  private readonly spacer = document.createElement('div');
  private readonly body = document.createElement('table');
  private opts: VirtualTableOptions | null = null;
  private raf = 0;
  private hovered: number | null = null;

  constructor() {
    this.root.className = 'vtable';
    this.head.className = 'vtable-head';
    this.scroller.className = 'vtable-scroll';
    this.spacer.className = 'vtable-spacer';
    this.body.className = 'vtable-body';
    this.spacer.append(this.body);
    this.scroller.append(this.spacer);
    this.root.append(this.head, this.scroller);
    this.scroller.addEventListener('scroll', () => this.schedule());
    this.body.addEventListener('click', (e) => {
      const row = this.rowOf(e.target);
      if (row !== null) this.opts?.onRowClick?.(row);
    });
    this.body.addEventListener('mouseover', (e) => {
      const row = this.rowOf(e.target);
      if (row !== this.hovered) { this.hovered = row; this.opts?.onRowHover?.(row); }
    });
    this.body.addEventListener('mouseleave', () => {
      if (this.hovered !== null) { this.hovered = null; this.opts?.onRowHover?.(null); }
    });
    this.head.addEventListener('click', (e) => {
      const th = (e.target as HTMLElement).closest('th');
      if (th?.dataset.key !== undefined) this.opts?.onHeaderClick?.(th.dataset.key);
    });
  }

  private rowOf(target: EventTarget | null): number | null {
    const tr = (target as HTMLElement | null)?.closest?.('tr');
    const row = tr?.dataset.row;
    return row === undefined ? null : Number(row);
  }

  /** Describe (or re-describe) the table; the scroll position is kept. */
  set(opts: VirtualTableOptions): void {
    this.opts = opts;
    const tr = document.createElement('tr');
    for (const c of opts.columns) {
      const th = document.createElement('th');
      th.dataset.key = c.key;
      th.textContent = c.label + (opts.headerMark?.(c.key) ?? '');
      if (c.align === 'right') th.className = 'num';
      tr.append(th);
    }
    this.head.replaceChildren(tr);
    this.spacer.style.height = `${opts.rowCount * ROW_H}px`;
    this.render();
  }

  /** Bring a row into view (nearest edge), as a selection would. */
  scrollToRow(row: number): void {
    const top = row * ROW_H;
    const view = this.scroller.clientHeight;
    const at = this.scroller.scrollTop;
    if (top < at) this.scroller.scrollTop = top;
    else if (top + ROW_H > at + view) this.scroller.scrollTop = top + ROW_H - view;
    this.render();
  }

  /** Repaint the window (a selection or colouring changed, not the rows). */
  refresh(): void {
    this.render();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private render(): void {
    const o = this.opts;
    if (!o) { this.body.replaceChildren(); return; }
    const view = this.scroller.clientHeight || 300;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(o.rowCount, Math.ceil((this.scroller.scrollTop + view) / ROW_H) + OVERSCAN);
    this.body.style.transform = `translateY(${first * ROW_H}px)`;
    const rows: HTMLTableRowElement[] = [];
    for (let r = first; r < last; r++) {
      const tr = document.createElement('tr');
      tr.dataset.row = String(r);
      const cls = o.rowClass?.(r);
      if (cls) tr.className = cls;
      o.columns.forEach((c, i) => {
        const td = document.createElement('td');
        if (c.align === 'right') td.className = 'num';
        td.append(o.cell(r, i));
        tr.append(td);
      });
      rows.push(tr);
    }
    this.body.replaceChildren(...rows);
  }
}
