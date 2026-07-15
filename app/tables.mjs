// tables.mjs — curated liblouis table registry for the UI.
//
// Every filename exists in the bundled liblouis 3.36.0 table set, and the
// test suite verifies each one loads and translates on the shipped engine.
// The full 461-table catalog remains addressable via
// engine/tables-manifest.json; this list is the curated dropdown subset.
//
// `lang` is the BCP-47 tag applied to echoed source text (WCAG 3.1.2).
// AGPL-3.0 — part of the BrailleGen fork.

export const TABLE_GROUPS = [
  {
    group: 'English',
    tables: [
      { file: 'en-ueb-g2.ctb', name: 'English — UEB Grade 2 (contracted)', lang: 'en', default: true },
      { file: 'en-ueb-g1.ctb', name: 'English — UEB Grade 1 (uncontracted)', lang: 'en' },
      { file: 'en-us-comp8-ext.utb', name: 'English — U.S. 8-dot computer braille', lang: 'en', eightDot: true },
    ],
  },
  {
    group: 'European languages',
    tables: [
      { file: 'es-g1.ctb', name: 'Spanish — Grade 1', lang: 'es' },
      { file: 'es-g2.ctb', name: 'Spanish — Grade 2 (contracted)', lang: 'es' },
      { file: 'fr-bfu-comp6.utb', name: 'French — uncontracted (BFU)', lang: 'fr' },
      { file: 'fr-bfu-g2.ctb', name: 'French — Grade 2 (abrégé)', lang: 'fr' },
      { file: 'de-g0.utb', name: 'German — uncontracted (Basisschrift)', lang: 'de' },
      { file: 'de-g2.ctb', name: 'German — contracted (Kurzschrift)', lang: 'de' },
      { file: 'it.tbl', name: 'Italian', lang: 'it' },
      { file: 'pt-pt-g1.utb', name: 'Portuguese — uncontracted', lang: 'pt' },
      { file: 'pt-pt-g2.ctb', name: 'Portuguese — contracted', lang: 'pt' },
      { file: 'nl-NL-g0.utb', name: 'Dutch', lang: 'nl' },
      { file: 'sv-g0.utb', name: 'Swedish — uncontracted', lang: 'sv' },
      { file: 'no-no-g0.utb', name: 'Norwegian — uncontracted', lang: 'no' },
      { file: 'da-dk-g26.ctb', name: 'Danish — contracted (2022)', lang: 'da' },
      { file: 'fi.utb', name: 'Finnish', lang: 'fi' },
      { file: 'pl.tbl', name: 'Polish', lang: 'pl' },
      { file: 'cs.tbl', name: 'Czech', lang: 'cs' },
      { file: 'hu-hu-g2.ctb', name: 'Hungarian — contracted', lang: 'hu' },
      { file: 'el.ctb', name: 'Greek', lang: 'el' },
      { file: 'ru-litbrl-detailed.utb', name: 'Russian — literary (capital marks)', lang: 'ru' },
      { file: 'uk.utb', name: 'Ukrainian', lang: 'uk' },
      { file: 'tr.tbl', name: 'Turkish', lang: 'tr' },
    ],
  },
  {
    group: 'Middle East & Africa',
    tables: [
      { file: 'ar.tbl', name: 'Arabic — Grade 1', lang: 'ar', rtl: true },
      { file: 'ar-ar-g2.ctb', name: 'Arabic — Grade 2 (contracted)', lang: 'ar', rtl: true },
      { file: 'he-IL.utb', name: 'Hebrew (Israeli)', lang: 'he', rtl: true },
      { file: 'fa-ir-g1.utb', name: 'Persian (Farsi) — Grade 1', lang: 'fa', rtl: true },
      { file: 'afr-za-g2.ctb', name: 'Afrikaans — contracted', lang: 'af' },
      { file: 'sw-ke-g2.ctb', name: 'Swahili — contracted', lang: 'sw' },
    ],
  },
  {
    group: 'Asian languages',
    tables: [
      { file: 'hi.tbl', name: 'Hindi (Bharati braille)', lang: 'hi' },
      { file: 'zhcn-g1.ctb', name: 'Chinese — Mandarin, with tones', lang: 'zh-CN' },
      { file: 'zh-tw.ctb', name: 'Chinese — Taiwan (bopomofo)', lang: 'zh-TW' },
      { file: 'ko-2006-g2.ctb', name: 'Korean — contracted (2006)', lang: 'ko' },
      // The -ucs2 variant is required on 16-bit-widechar liblouis builds (ours).
      { file: 'ja-kantenji-ucs2.utb', name: 'Japanese — Kantenji (kanji braille, specialist)', lang: 'ja', eightDot: true },
      { file: 'ms-my-g2.ctb', name: 'Malay — contracted', lang: 'ms' },
    ],
  },
];

export const DEFAULT_TABLE = 'en-ueb-g2.ctb';

const flat = new Map();
for (const g of TABLE_GROUPS) for (const t of g.tables) flat.set(t.file, t);

export function tableInfo(file) {
  return flat.get(file) ?? { file, name: file, lang: 'und' };
}

export function allCuratedTables() {
  return [...flat.values()];
}
