import { BlendMode, LineCapStyle, PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { BASELINE, LINE_HEIGHT, standardFont } from './fonts'
import type { Annot, PageModel, TextAnnot } from './types'
import { dataUrlToBytes, hexToRgb01 } from './util'

export interface SourceBytes {
  id: string
  bytes: Uint8Array
}

/** Renders text that the standard fonts cannot encode (CJK, emoji, ...) to a PNG. */
export type TextRasterizer = (a: TextAnnot) => Promise<{ src: string; w: number; h: number }>

const color = (hex: string) => rgb(...hexToRgb01(hex))

/**
 * Build the final PDF: copy every page (in the user's order) from its source document,
 * apply rotation, then flatten all annotations into the page content.
 */
export async function exportPdf(
  sources: SourceBytes[],
  pages: PageModel[],
  rasterizeText?: TextRasterizer,
): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  const loaded = new Map<string, PDFDocument>()
  const fonts = new Map<string, PDFFont>()
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()

  const getFont = async (a: TextAnnot) => {
    const key = standardFont(a.font, a.bold, a.italic)
    let f = fonts.get(key)
    if (!f) {
      f = await out.embedFont(key)
      fonts.set(key, f)
    }
    return f
  }
  const getImage = async (src: string) => {
    let img = images.get(src)
    if (!img) {
      const bytes = dataUrlToBytes(src)
      img = /^data:image\/jpe?g/i.test(src) ? await out.embedJpg(bytes) : await out.embedPng(bytes)
      images.set(src, img)
    }
    return img
  }

  for (const pm of pages) {
    let page: PDFPage
    if (pm.srcId) {
      let src = loaded.get(pm.srcId)
      if (!src) {
        const s = sources.find((x) => x.id === pm.srcId)
        if (!s) throw new Error('Missing source document')
        src = await PDFDocument.load(s.bytes, { ignoreEncryption: true })
        loaded.set(pm.srcId, src)
      }
      const [copied] = await out.copyPages(src, [pm.srcIndex])
      page = out.addPage(copied)
    } else {
      page = out.addPage([pm.width, pm.height])
    }
    page.setRotation(degrees((((pm.baseRotation + pm.rotation) % 360) + 360) % 360))

    const box = page.getCropBox()
    // editor coordinates are top-down from the crop box's top-left corner
    const X = (x: number) => box.x + x
    const Y = (y: number) => box.y + box.height - y

    for (const a of pm.annots) {
      await drawAnnot(page, a, X, Y, getFont, getImage, rasterizeText)
    }
  }
  out.setProducer('Free PDF Editor')
  out.setCreator('Free PDF Editor')
  return out.save()
}

async function drawAnnot(
  page: PDFPage,
  a: Annot,
  X: (x: number) => number,
  Y: (y: number) => number,
  getFont: (a: TextAnnot) => Promise<PDFFont>,
  getImage: (src: string) => Promise<Awaited<ReturnType<PDFDocument['embedPng']>>>,
  rasterizeText?: TextRasterizer,
) {
  switch (a.type) {
    case 'rect':
      page.drawRectangle({
        x: X(a.x),
        y: Y(a.y + a.h),
        width: a.w,
        height: a.h,
        color: a.fill ? color(a.fill) : undefined,
        opacity: a.opacity,
        borderColor: a.stroke ? color(a.stroke) : undefined,
        borderWidth: a.stroke ? a.strokeWidth : 0,
        borderOpacity: a.opacity,
        blendMode: a.highlight ? BlendMode.Multiply : undefined,
      })
      return
    case 'ellipse':
      page.drawEllipse({
        x: X(a.x + a.w / 2),
        y: Y(a.y + a.h / 2),
        xScale: a.w / 2,
        yScale: a.h / 2,
        color: a.fill ? color(a.fill) : undefined,
        opacity: a.opacity,
        borderColor: a.stroke ? color(a.stroke) : undefined,
        borderWidth: a.stroke ? a.strokeWidth : 0,
        borderOpacity: a.opacity,
      })
      return
    case 'image': {
      const img = await getImage(a.src)
      page.drawImage(img, { x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h })
      return
    }
    case 'draw': {
      if (a.points.length < 2) return
      const d = a.points
        .map(([px, py], i) => `${i ? 'L' : 'M'}${(px * a.w).toFixed(2)} ${(py * a.h).toFixed(2)}`)
        .join(' ')
      // drawSvgPath uses SVG (y-down) coordinates relative to the given origin
      page.drawSvgPath(d, {
        x: X(a.x),
        y: Y(a.y),
        borderColor: color(a.color),
        borderWidth: a.strokeWidth,
        borderLineCap: LineCapStyle.Round,
      })
      return
    }
    case 'text': {
      if (!a.text.trim()) return
      const font = await getFont(a)
      const lines = a.text.split('\n')
      let encodable = true
      try {
        for (const l of lines) font.encodeText(l)
      } catch {
        encodable = false
      }
      if (encodable) {
        lines.forEach((line, i) => {
          if (!line) return
          page.drawText(line, {
            x: X(a.x),
            y: Y(a.y + (i * LINE_HEIGHT + BASELINE[a.font]) * a.fontSize),
            size: a.fontSize,
            font,
            color: color(a.color),
          })
        })
      } else if (rasterizeText) {
        const r = await rasterizeText(a)
        const img = await getImage(r.src)
        page.drawImage(img, { x: X(a.x), y: Y(a.y + r.h), width: r.w, height: r.h })
      } else {
        throw new Error('Text contains characters the standard PDF fonts cannot encode')
      }
      return
    }
  }
}
