import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { Engine } from './engine'
import { standardFont } from './fonts'
import type { OverlayItem } from './mupdfOps'
import type { FontKey } from './types'
import { dataUrlToBytes, hexToRgb01 } from './util'

/** One line of text, positioned in unrotated top-down page units relative to the crop box. */
export interface PlacedText {
  str: string
  /** start of the baseline */
  x: number
  y: number
  size: number
  color: string
  opacity?: number
  /** counter-clockwise degrees, as seen on the unrotated page */
  angle?: number
  font?: FontKey
  bold?: boolean
  italic?: boolean
  /** squeeze/stretch to this width (OCR words) */
  width?: number
  /** searchable but not painted (OCR text layer) */
  invisible?: boolean
}

/** Renders a line the PDF fonts can't show (e.g. emoji) to a PNG: returns size in page units and baseline offset. */
export type LineRasterizer = (t: PlacedText) => Promise<{ src: string; w: number; h: number; ascent: number }>

/**
 * Collects text for many pages and draws it in the cheapest faithful way:
 * - WinAnsi text -> pdf-lib with the standard 14 fonts (tiny, selectable)
 * - other scripts (CJK, Cyrillic, ...) -> MuPDF overlay with an embedded subset font (selectable)
 * - glyphs no font has (emoji) -> raster image fallback
 */
export class TextPainter {
  private items: { page: PDFPage; t: PlacedText }[] = []
  private fonts = new Map<string, PDFFont>()
  private doc: PDFDocument
  private engine?: Engine
  private rasterize?: LineRasterizer

  constructor(doc: PDFDocument, engine?: Engine, rasterize?: LineRasterizer) {
    this.doc = doc
    this.engine = engine
    this.rasterize = rasterize
  }

  add(page: PDFPage, t: PlacedText) {
    if (t.str.trim()) this.items.push({ page, t })
  }

  private async font(t: PlacedText) {
    const key = standardFont(t.font ?? 'Helvetica', !!t.bold, !!t.italic)
    let f = this.fonts.get(key)
    if (!f) {
      f = await this.doc.embedFont(key)
      this.fonts.set(key, f)
    }
    return f
  }

  async flush() {
    const overlay: { page: PDFPage; t: PlacedText }[] = []
    for (const it of this.items) {
      const f = await this.font(it.t)
      let ok = !it.t.invisible
      if (ok) {
        try {
          f.encodeText(it.t.str)
        } catch {
          ok = false
        }
      }
      if (!ok) {
        overlay.push(it)
        continue
      }
      const box = it.page.getCropBox()
      const [r, g, b] = hexToRgb01(it.t.color)
      it.page.drawText(it.t.str, {
        x: box.x + it.t.x,
        y: box.y + box.height - it.t.y,
        size: it.t.size,
        font: f,
        color: rgb(r, g, b),
        opacity: it.t.opacity ?? 1,
        rotate: degrees(it.t.angle ?? 0),
      })
    }
    this.items = []
    if (!overlay.length) return

    // which lines can the embedded Unicode font show?
    let covered: boolean[] = overlay.map(() => false)
    if (this.engine) {
      try {
        covered = await this.engine.coverage(overlay.map((o) => o.t.str))
      } catch {
        covered = overlay.map(() => false)
      }
    }
    const byPage = new Map<PDFPage, OverlayItem[]>()
    for (let i = 0; i < overlay.length; i++) {
      const { page, t } = overlay[i]
      if (covered[i]) {
        const list = byPage.get(page) ?? []
        list.push({
          str: t.str,
          x: t.x,
          y: t.y,
          size: t.size,
          color: hexToRgb01(t.color),
          alpha: t.invisible ? 0 : (t.opacity ?? 1),
          angle: t.angle,
          width: t.width,
        })
        byPage.set(page, list)
      } else if (t.invisible) {
        continue // an OCR word we can't encode: skipping it only costs searchability
      } else if (this.rasterize) {
        const img = await this.rasterize(t)
        const png = await this.doc.embedPng(dataUrlToBytes(img.src))
        const box = page.getCropBox()
        page.drawImage(png, {
          x: box.x + t.x,
          y: box.y + box.height - t.y - (img.h - img.ascent),
          width: img.w,
          height: img.h,
          opacity: t.opacity ?? 1,
          rotate: degrees(t.angle ?? 0),
        })
      } else {
        throw new Error('Text contains characters the standard PDF fonts cannot encode')
      }
    }
    if (!byPage.size) return
    const pages = [...byPage.keys()]
    const bytes = await this.engine!.textOverlay(
      pages.map((p) => {
        const box = p.getCropBox()
        return { width: box.width, height: box.height, items: byPage.get(p)! }
      }),
    )
    const embedded = await this.doc.embedPdf(bytes, pages.map((_, i) => i))
    pages.forEach((p, i) => {
      const box = p.getCropBox()
      p.drawPage(embedded[i], { x: box.x, y: box.y })
    })
  }
}

/** Visual (as displayed, rotation applied) point -> unrotated top-down coordinates, plus angle offset. */
export function fromVisual(page: PDFPage, vx: number, vy: number): { x: number; y: number; angleOffset: number; } {
  const r = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270
  const { width: w, height: h } = page.getCropBox()
  switch (r) {
    case 90:
      return { x: vy, y: h - vx, angleOffset: 90 }
    case 180:
      return { x: w - vx, y: h - vy, angleOffset: 180 }
    case 270:
      return { x: w - vy, y: vx, angleOffset: 270 }
    default:
      return { x: vx, y: vy, angleOffset: 0 }
  }
}

/** Page size as displayed (width/height swapped for 90° / 270°). */
export function visualSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = page.getCropBox()
  const r = ((page.getRotation().angle % 360) + 360) % 360
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height }
}
