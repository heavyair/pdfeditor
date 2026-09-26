import { StandardFonts } from 'pdf-lib'
import type { FontKey } from './types'

export const LINE_HEIGHT = 1.2

export const FONT_LABELS: Record<FontKey, string> = {
  Helvetica: 'Sans (Helvetica)',
  Times: 'Serif (Times)',
  Courier: 'Mono (Courier)',
}

/** CSS stacks with metrics close to the PDF standard 14 fonts, so the editor is WYSIWYG. */
export const CSS_FONT: Record<FontKey, string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", "Noto Serif", "Songti SC", SimSun, serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
}

/**
 * Distance from the top of a CSS line box (line-height 1.2) to the baseline, as a
 * fraction of the font size. Derived from the ascent/descent of Arial, Times New Roman
 * and Courier New, the usual stand-ins for the standard 14 fonts.
 */
export const BASELINE: Record<FontKey, number> = {
  Helvetica: 0.947,
  Times: 0.934,
  Courier: 0.866,
}

export function standardFont(font: FontKey, bold: boolean, italic: boolean): StandardFonts {
  const table: Record<FontKey, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
    Helvetica: [
      StandardFonts.Helvetica,
      StandardFonts.HelveticaBold,
      StandardFonts.HelveticaOblique,
      StandardFonts.HelveticaBoldOblique,
    ],
    Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
    Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  }
  return table[font][(bold ? 1 : 0) + (italic ? 2 : 0)]
}

/** Guess one of our three families from a PDF font name like "ABCDEF+Arial-BoldItalicMT". */
export function guessFont(name: string, fallbackFamily = ''): { font: FontKey; bold: boolean; italic: boolean } {
  const n = name.toLowerCase()
  const fam = fallbackFamily.toLowerCase()
  let font: FontKey = 'Helvetica'
  if (/courier|mono|consol|menlo/.test(n) || fam === 'monospace') font = 'Courier'
  else if (/times|serif|georgia|garamond|roman|song|ming|cambria|minion/.test(n.replace('sans-serif', '')) && !/sans/.test(n))
    font = 'Times'
  else if (fam === 'serif') font = 'Times'
  return {
    font,
    bold: /bold|black|heavy|semibold|demi|w[6-9]\b/.test(n),
    italic: /italic|oblique/.test(n),
  }
}
