/**
 * Simple text chunker for splitting outbound messages into platform-sized pieces.
 * Simple text chunker — only the core chunkText function.
 */

/**
 * Split text into chunks up to `limit` characters.
 * Prefers breaking at newlines, then whitespace, then hard-splits.
 */
export function chunkText(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // 1) Prefer a newline break inside the window.
    let breakIdx = window.lastIndexOf("\n");

    // 2) Otherwise prefer the last whitespace (word boundary).
    if (breakIdx <= 0) {
      for (let i = window.length - 1; i >= 0; i--) {
        if (/\s/.test(window[i]!)) {
          breakIdx = i;
          break;
        }
      }
    }

    // 3) Fallback: hard break exactly at the limit.
    if (breakIdx <= 0) {
      breakIdx = limit;
    }

    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // If we broke on whitespace/newline, skip that separator.
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]!);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }

  if (remaining.length) {
    chunks.push(remaining);
  }

  return chunks;
}
