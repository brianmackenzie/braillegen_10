// braille-brf.mjs — convert Unicode braille to BRF (Braille Ready Format).
//
// BRF is the de-facto interchange format for braille embossers: plain ASCII
// where each character is the North American Braille Computer Code (NABCC)
// representation of one 6-dot cell. Pages are 25 lines of up to 40 cells,
// separated by form feeds, CRLF line endings.
//
// AGPL-3.0 — part of the BrailleGen fork.

// NABCC: index = 6-dot bitmask (bit 0..5 = dot 1..6), value = ASCII char.
// Verified against liblouis's en-us-brf.dis display table.
const NABCC = [
  ' ', 'A', '1', 'B', "'", 'K', '2', 'L',   // 0x00-0x07
  '@', 'C', 'I', 'F', '/', 'M', 'S', 'P',   // 0x08-0x0F
  '"', 'E', '3', 'H', '9', 'O', '6', 'R',   // 0x10-0x17
  '^', 'D', 'J', 'G', '>', 'N', 'T', 'Q',   // 0x18-0x1F
  ',', '*', '5', '<', '-', 'U', '8', 'V',   // 0x20-0x27
  '.', '%', '[', '$', '+', 'X', '!', '&',   // 0x28-0x2F
  ';', ':', '4', '\\', '0', 'Z', '7', '(',  // 0x30-0x37
  '_', '?', 'W', ']', '#', 'Y', ')', '=',   // 0x38-0x3F
];

/**
 * Convert Unicode braille lines to BRF text.
 * Dots 7/8 cannot be represented in 6-dot BRF; they are dropped per-cell and
 * reported so the UI can warn.
 * @param {string[]} lines - Unicode braille lines (already wrapped <= cellsPerLine).
 * @param {object} [opts]
 * @param {number} [opts.cellsPerLine=40]
 * @param {number} [opts.linesPerPage=25]
 * @returns {{brf: string, droppedDots: number}}
 */
export function brailleToBrf(lines, opts = {}) {
  const cellsPerLine = opts.cellsPerLine ?? 40;
  const linesPerPage = opts.linesPerPage ?? 25;

  let droppedDots = 0;
  const outLines = [];

  for (const line of lines) {
    let out = '';
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x2800 && cp <= 0x28FF) {
        const mask = cp - 0x2800;
        if (mask & 0xC0) droppedDots++;
        out += NABCC[mask & 0x3F];
      } else if (cp === 0x20 || cp === 0x09) {
        out += ' ';
      }
      // Anything else (shouldn't occur in translated output) is skipped.
    }
    // Hard-wrap defensively; translation should already respect the width.
    while (out.length > cellsPerLine) {
      outLines.push(out.slice(0, cellsPerLine));
      out = out.slice(cellsPerLine);
    }
    outLines.push(out);
  }

  const pages = [];
  for (let i = 0; i < outLines.length; i += linesPerPage) {
    pages.push(outLines.slice(i, i + linesPerPage).join('\r\n'));
  }

  return { brf: pages.join('\r\n\f') + '\r\n', droppedDots };
}
