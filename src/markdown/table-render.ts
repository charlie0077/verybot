/**
 * Table rendering for Markdown IR.
 * Extracted from ir.ts to keep modules under ~500 LOC.
 */

import type { MarkdownStyle, MarkdownStyleSpan, MarkdownLinkSpan } from "./ir.js";

/** Minimal target interface for appending rendered table output. */
export type TableTarget = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};

type OpenStyle = {
  style: MarkdownStyle;
  start: number;
};

type LinkState = {
  href: string;
  labelStart: number;
};

/** A render target with open style tracking (used during cell parsing). */
export type CellRenderTarget = TableTarget & {
  openStyles: OpenStyle[];
  linkStack: LinkState[];
};

export type TableCell = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};

export type TableState = {
  headers: TableCell[];
  rows: TableCell[][];
  currentRow: TableCell[];
  currentCell: CellRenderTarget | null;
  inHeader: boolean;
};

export function initTableState(): TableState {
  return {
    headers: [],
    rows: [],
    currentRow: [],
    currentCell: null,
    inHeader: false,
  };
}

export function initCellTarget(): CellRenderTarget {
  return {
    text: "",
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
  };
}

function closeRemainingStyles(target: CellRenderTarget) {
  for (let i = target.openStyles.length - 1; i >= 0; i -= 1) {
    const open = target.openStyles[i];
    const end = target.text.length;
    if (end > open.start) {
      target.styles.push({
        start: open.start,
        end,
        style: open.style,
      });
    }
  }
  target.openStyles = [];
}

export function finishTableCell(cell: CellRenderTarget): TableCell {
  closeRemainingStyles(cell);
  return {
    text: cell.text,
    styles: cell.styles,
    links: cell.links,
  };
}

export function trimCell(cell: TableCell): TableCell {
  const text = cell.text;
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start] ?? "")) {
    start += 1;
  }
  while (end > start && /\s/.test(text[end - 1] ?? "")) {
    end -= 1;
  }
  if (start === 0 && end === text.length) {
    return cell;
  }
  const trimmedText = text.slice(start, end);
  const trimmedLength = trimmedText.length;
  const trimmedStyles: MarkdownStyleSpan[] = [];
  for (const span of cell.styles) {
    const sliceStart = Math.max(0, span.start - start);
    const sliceEnd = Math.min(trimmedLength, span.end - start);
    if (sliceEnd > sliceStart) {
      trimmedStyles.push({ start: sliceStart, end: sliceEnd, style: span.style });
    }
  }
  const trimmedLinks: MarkdownLinkSpan[] = [];
  for (const span of cell.links) {
    const sliceStart = Math.max(0, span.start - start);
    const sliceEnd = Math.min(trimmedLength, span.end - start);
    if (sliceEnd > sliceStart) {
      trimmedLinks.push({ start: sliceStart, end: sliceEnd, href: span.href });
    }
  }
  return { text: trimmedText, styles: trimmedStyles, links: trimmedLinks };
}

function appendCell(target: TableTarget, cell: TableCell) {
  if (!cell.text) {
    return;
  }
  const start = target.text.length;
  target.text += cell.text;
  for (const span of cell.styles) {
    target.styles.push({
      start: start + span.start,
      end: start + span.end,
      style: span.style,
    });
  }
  for (const link of cell.links) {
    target.links.push({
      start: start + link.start,
      end: start + link.end,
      href: link.href,
    });
  }
}

export function renderTableAsBullets(target: TableTarget, table: TableState) {
  const headers = table.headers.map(trimCell);
  const rows = table.rows.map((row) => row.map(trimCell));

  if (headers.length === 0 && rows.length === 0) {
    return;
  }

  const useFirstColAsLabel = headers.length > 1 && rows.length > 0;

  if (useFirstColAsLabel) {
    for (const row of rows) {
      if (row.length === 0) {
        continue;
      }
      const rowLabel = row[0];
      if (rowLabel?.text) {
        const labelStart = target.text.length;
        appendCell(target, rowLabel);
        const labelEnd = target.text.length;
        if (labelEnd > labelStart) {
          target.styles.push({ start: labelStart, end: labelEnd, style: "bold" });
        }
        target.text += "\n";
      }
      for (let i = 1; i < row.length; i++) {
        const header = headers[i];
        const value = row[i];
        if (!value?.text) {
          continue;
        }
        target.text += "\u2022 ";
        if (header?.text) {
          appendCell(target, header);
          target.text += ": ";
        } else {
          target.text += `Column ${i}: `;
        }
        appendCell(target, value);
        target.text += "\n";
      }
      target.text += "\n";
    }
  } else {
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const header = headers[i];
        const value = row[i];
        if (!value?.text) {
          continue;
        }
        target.text += "\u2022 ";
        if (header?.text) {
          appendCell(target, header);
          target.text += ": ";
        }
        appendCell(target, value);
        target.text += "\n";
      }
      target.text += "\n";
    }
  }
}

export function renderTableAsCode(target: TableTarget, table: TableState, inList: boolean) {
  const headers = table.headers.map(trimCell);
  const rows = table.rows.map((row) => row.map(trimCell));

  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length));
  if (columnCount === 0) {
    return;
  }

  const widths = Array.from({ length: columnCount }, () => 0);
  const updateWidths = (cells: TableCell[]) => {
    for (let i = 0; i < columnCount; i += 1) {
      const cell = cells[i];
      const width = cell?.text.length ?? 0;
      if (widths[i]! < width) {
        widths[i] = width;
      }
    }
  };
  updateWidths(headers);
  for (const row of rows) {
    updateWidths(row);
  }

  const codeStart = target.text.length;

  const appendRow = (cells: TableCell[]) => {
    target.text += "|";
    for (let i = 0; i < columnCount; i += 1) {
      target.text += " ";
      const cell = cells[i];
      if (cell) {
        appendCell(target, cell);
      }
      const pad = widths[i]! - (cell?.text.length ?? 0);
      if (pad > 0) {
        target.text += " ".repeat(pad);
      }
      target.text += " |";
    }
    target.text += "\n";
  };

  const appendDivider = () => {
    target.text += "|";
    for (let i = 0; i < columnCount; i += 1) {
      const dashCount = Math.max(3, widths[i]!);
      target.text += ` ${"-".repeat(dashCount)} |`;
    }
    target.text += "\n";
  };

  appendRow(headers);
  appendDivider();
  for (const row of rows) {
    appendRow(row);
  }

  const codeEnd = target.text.length;
  if (codeEnd > codeStart) {
    target.styles.push({ start: codeStart, end: codeEnd, style: "code_block" });
  }
  if (!inList) {
    target.text += "\n";
  }
}
