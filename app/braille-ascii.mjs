// braille-ascii.mjs — Braille ASCII (NABCC) to Unicode braille, one character
// per cell.
//
// Braille ASCII is how transcribers type braille directly: each of the 64
// characters 0x20–0x5F names one 6-dot cell (the same encoding BRF files use).
// Typing 'g' or 'G' produces dots 1-2-4-5 (⠛, the letter g); the Nemeth
// equals sign is the two-cell sequence typed '.k' (dots 46, then 13). Direct
// entry is what makes Nemeth math and other hand-transcribed codes possible
// here: the text is NOT translated, it IS the braille.
//
// Layout is preserved exactly — lines are never re-wrapped and every input
// character advances exactly one cell — because spatial arrangements (Nemeth
// worked problems, tables, poetry) carry meaning in their columns.
//
// AGPL-3.0 — part of the BrailleGen fork.

import { NABCC } from './braille-brf.mjs';

// ASCII char -> braille codepoint. Lowercase letters fold to the same cells
// as uppercase (BRF readers and editors treat case as interchangeable).
const CELL = new Map();
NABCC.forEach((ch, mask) => CELL.set(ch, 0x2800 + mask));
for (let c = 65; c <= 90; c++) {
  CELL.set(String.fromCharCode(c + 32), CELL.get(String.fromCharCode(c)));
}

// Word processors silently swap these for ASCII characters; restore them so a
// paste from Word/Docs still means what the transcriber typed.
const SMART = new Map([
  ['‘', "'"], ['’', "'"],        // curly single quotes
  ['“', '"'], ['”', '"'],        // curly double quotes
  ['–', '-'], ['—', '-'],        // en/em dash
  ['…', '...'],                        // ellipsis (expands to three cells)
  [' ', ' '],                          // non-breaking space
]);

/**
 * Convert Braille ASCII text to Unicode braille lines.
 *
 * Characters outside the NABCC set become blank cells INSTEAD of being
 * dropped: dropping would shift every following cell left, silently
 * corrupting spatial layouts. The blank keeps columns true and the returned
 * `invalid` list lets the UI point at the exact spots.
 *
 * Unicode braille characters in the input (U+2800–U+28FF) pass through
 * unchanged, so pasting existing braille alongside ASCII entry works.
 *
 * @param {string} text
 * @returns {{lines: string[], invalid: {ch: string, line: number, col: number}[],
 *            smartFixes: number}}
 */
export function asciiToBraille(text) {
  const lines = [];
  const invalid = [];
  let smartFixes = 0;

  // Zero-width characters ride along invisibly in pastes; they are neither
  // cells nor errors, so they are removed before mapping.
  const cleaned = text.replace(/[​‌‍﻿]/g, '').replace(/\r\n?/g, '\n');

  for (const [li, raw] of cleaned.split('\n').entries()) {
    let out = '';
    let col = 0;
    for (let ch of raw) {
      col++;
      const cp = ch.codePointAt(0);
      if (cp >= 0x2800 && cp <= 0x28FF) { out += ch; continue; }
      if (SMART.has(ch)) { ch = SMART.get(ch); smartFixes++; }
      for (const c of ch) {                // SMART entries may expand ('…' -> '...')
        const cell = CELL.get(c);
        if (cell === undefined) {
          invalid.push({ ch: c, line: li + 1, col });
          out += '⠀';
        } else {
          out += String.fromCodePoint(cell);
        }
      }
    }
    // Trailing blanks carry no braille meaning; leading blanks are layout.
    lines.push(out.replace(/⠀+$/, ''));
  }
  return { lines, invalid, smartFixes };
}

/** Human-readable summary of invalid-character positions, capped for alerts. */
export function describeInvalid(invalid) {
  if (!invalid.length) return '';
  const spots = invalid.slice(0, 5)
    .map(x => `“${x.ch}” at line ${x.line}, column ${x.col}`).join('; ');
  const more = invalid.length > 5 ? ` and ${invalid.length - 5} more` : '';
  return `${invalid.length} character${invalid.length === 1 ? '' : 's'} outside the Braille ASCII set became blank cells: ${spots}${more}. Braille ASCII uses letters, digits and the symbols found on BRF keyboards.`;
}
