import { PDFDocument, degrees, type PDFPage } from 'pdf-lib'
import type { Engine } from './engine'
import { standardFont } from './fonts'
import { TextPainter, fromVisual, visualSize, type LineRasterizer } from './textLayer'
import { dataUrlToBytes } from './util'

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { ignoreEncryption: true })
const pick = (doc: PDFDocument, pages?: number[]) => (pages ? pages.map((i) => doc.getPage(i)) : doc.getPages())

/** Width of a single line of text in the font that will actually be used. */
async function measure(doc: PDFDocument, str: string, size: number, engine?: Engine, bold = false): Promise<number> {
  try {
    const f = await doc.embedFont(standardFont('Helvetica', bold, false))
    f.encodeText(str)
    return f.widthOfTextAtSize(str, size)
  } catch {
    if (engine) return engine.textWidth(str, size)
    return str.length * size
  }
}

/** Place text at a visual anchor point (rotation-aware) and queue it on the painter. */
async function placeVisual(
  doc: PDFDocument,
  painter: TextPainter,
  page: PDFPage,
  o: { str: string; vx: number; vy: number; size: number; color: string; opacity: number; angle: number; align: 'start' | 'middle' | 'end'; valign: 'baseline' | 'middle'; bold?: boolean },
  engine?: Engine,
) {
  const w = await measure(doc, o.str, o.size, engine, o.bold)
  const t = (o.angle * Math.PI) / 180
  // text direction and "down" direction in visual (y-down) space for a ccw angle
  const dir = [Math.cos(t), -Math.sin(t)]
  const down = [Math.sin(t), Math.cos(t)]
  const k = o.align === 'start' ? 0 : o.align === 'middle' ? 0.5 : 1
  const drop = o.valign === 'middle' ? o.size * 0.35 : 0
  const vx = o.vx - dir[0] * w * k + down[0] * drop
  const vy = o.vy - dir[1] * w * k + down[1] * drop
  const p = fromVisual(page, vx, vy)
  painter.add(page, { str: o.str, x: p.x, y: p.y, size: o.size, color: o.color, opacity: o.opacity, angle: o.angle + p.angleOffset, bold: o.bold })
}

// ──────────────────────────────────────────────────────── watermark

export interface WatermarkOptions {
  kind: 'text' | 'image'
  text: string
  image?: { src: string; width: number; height: number }
  size: number
  color: string
  opacity: number
  angle: number
  layout: 'center' | 'tile'
  /** image width as a fraction of the page width */
  imageScale: number
  pages?: number[]
}

export async function addWatermark(bytes: Uint8Array, o: WatermarkOptions, engine?: Engine, raster?: LineRasterizer): Promise<Uint8Array> {
  const doc = await load(bytes)
  const painter = new TextPainter(doc, engine, raster)
  const img = o.kind === 'image' && o.image
    ? /^data:image\/jpe?g/i.test(o.image.src) ? await doc.embedJpg(dataUrlToBytes(o.image.src)) : await doc.embedPng(dataUrlToBytes(o.image.src))
    : null
  for (const page of pick(doc, o.pages)) {
    const { width: VW, height: VH } = visualSize(page)
    const points: [number, number][] = []
    if (o.layout === 'center') points.push([VW / 2, VH / 2])
    else {
      const step = img ? VW * o.imageScale * 1.6 : Math.max(o.size * o.text.length * 0.55, o.size * 4) * 1.1
      const stepY = img ? step * (o.image!.height / o.image!.width) * 1.4 : o.size * 5
      for (let y = stepY / 2; y < VH + stepY; y += stepY) for (let x = 0; x < VW + step; x += step) points.push([x + ((y / stepY) % 2) * step * 0.5, y])
    }
    for (const [vx, vy] of points) {
      if (img) {
        const w = VW * o.imageScale
        const h = (w * img.height) / img.width
        drawImageVisual(page, img, vx, vy, w, h, o.angle, o.opacity)
      } else {
        await placeVisual(doc, painter, page, { str: o.text, vx, vy, size: o.size, color: o.color, opacity: o.opacity, angle: o.angle, align: 'middle', valign: 'middle', bold: true }, engine)
      }
    }
  }
  await painter.flush()
  return doc.save()
}

function drawImageVisual(page: PDFPage, img: Awaited<ReturnType<PDFDocument['embedPng']>>, vcx: number, vcy: number, w: number, h: number, angle: number, opacity: number) {
  const c = fromVisual(page, vcx, vcy)
  const box = page.getCropBox()
  const ucx = box.x + c.x
  const ucy = box.y + box.height - c.y
  const phi = ((angle + c.angleOffset) * Math.PI) / 180
  // pdf-lib rotates around the lower-left corner: move it so the centre stays put
  const x = ucx - (Math.cos(phi) * w) / 2 + (Math.sin(phi) * h) / 2
  const y = ucy - (Math.sin(phi) * w) / 2 - (Math.cos(phi) * h) / 2
  page.drawImage(img, { x, y, width: w, height: h, rotate: degrees(angle + c.angleOffset), opacity })
}

// ──────────────────────────────────────────────────────── page numbers / header & footer

export type Position = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'

export interface NumberingOptions {
  /** e.g. "{n}", "Page {n} of {total}", "第 {n} 页", "CONFIDENTIAL · {date}" */
  template: string
  position: Position
  size: number
  color: string
  margin: number
  startAt: number
  pages?: number[]
  fileName?: string
}

export function formatTemplate(t: string, n: number, total: number, fileName = '') {
  return t
    .replace(/\{n\}/g, String(n))
    .replace(/\{total\}/g, String(total))
    .replace(/\{date\}/g, new Date().toLocaleDateString())
    .replace(/\{file\}/g, fileName)
}

export async function addPageNumbers(bytes: Uint8Array, o: NumberingOptions, engine?: Engine, raster?: LineRasterizer): Promise<Uint8Array> {
  const doc = await load(bytes)
  const painter = new TextPainter(doc, engine, raster)
  const targets = o.pages ?? doc.getPageIndices()
  const total = targets.length + o.startAt - 1
  for (let k = 0; k < targets.length; k++) {
    const page = doc.getPage(targets[k])
    const { width: VW, height: VH } = visualSize(page)
    const [v, h] = o.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right']
    const vx = h === 'left' ? o.margin : h === 'right' ? VW - o.margin : VW / 2
    const vy = v === 'top' ? o.margin + o.size * 0.75 : VH - o.margin
    const str = formatTemplate(o.template, o.startAt + k, total, o.fileName)
    await placeVisual(doc, painter, page, { str, vx, vy, size: o.size, color: o.color, opacity: 1, angle: 0, align: h === 'left' ? 'start' : h === 'right' ? 'end' : 'middle', valign: 'baseline' }, engine)
  }
  await painter.flush()
  return doc.save()
}

// ──────────────────────────────────────────────────────── rotate / crop / n-up

export async function rotatePages(bytes: Uint8Array, angle: number, pages?: number[]): Promise<Uint8Array> {
  const doc = await load(bytes)
  for (const p of pick(doc, pages)) p.setRotation(degrees((((p.getRotation().angle + angle) % 360) + 360) % 360))
  return doc.save()
}

/** Margins are visual (as the page is displayed), in points. */
export async function cropPages(bytes: Uint8Array, m: { top: number; right: number; bottom: number; left: number }, pages?: number[]): Promise<Uint8Array> {
  const doc = await load(bytes)
  for (const page of pick(doc, pages)) {
    const { width: VW, height: VH } = visualSize(page)
    if (m.left + m.right >= VW - 10 || m.top + m.bottom >= VH - 10) throw new Error('CROP_TOO_LARGE')
    const box = page.getCropBox()
    const a = fromVisual(page, m.left, m.top)
    const b = fromVisual(page, VW - m.right, VH - m.bottom)
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y) // top-down
    page.setCropBox(box.x + x0, box.y + box.height - y1, x1 - x0, y1 - y0)
  }
  return doc.save()
}

export async function nUp(bytes: Uint8Array, perSheet: 2 | 4 | 6 | 9, sheet: 'A4' | 'Letter' | 'auto', margin = 18): Promise<Uint8Array> {
  const src = await load(bytes)
  const out = await PDFDocument.create()
  const [cols, rows] = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3] }[perSheet]
  const first = visualSize(src.getPage(0))
  let [sw, sh] = sheet === 'A4' ? [595.28, 841.89] : sheet === 'Letter' ? [612, 792] : [first.width, first.height]
  // orient the sheet so the cells match the page orientation
  const portrait = first.height >= first.width
  const wantLandscapeSheet = portrait ? cols > rows : rows > cols
  if (wantLandscapeSheet !== sw > sh) [sw, sh] = [sh, sw]
  const cw = (sw - margin * (cols + 1)) / cols
  const ch = (sh - margin * (rows + 1)) / rows
  const embedded = await out.embedPdf(src, src.getPageIndices())
  for (let i = 0; i < embedded.length; i += perSheet) {
    const sheetPage = out.addPage([sw, sh])
    for (let k = 0; k < perSheet && i + k < embedded.length; k++) {
      const e = embedded[i + k]
      const rot = ((src.getPage(i + k).getRotation().angle % 360) + 360) % 360
      const [pw, ph] = rot === 90 || rot === 270 ? [e.height, e.width] : [e.width, e.height]
      const s = Math.min(cw / pw, ch / ph)
      const col = k % cols
      const row = Math.floor(k / cols)
      const cx = margin + col * (cw + margin) + cw / 2
      const cy = sh - (margin + row * (ch + margin) + ch / 2)
      const w = e.width * s, h = e.height * s
      // place the (unrotated) page so that, after rotating it clockwise by `rot`, it is centred in its cell
      const pos = {
        0: { x: cx - w / 2, y: cy - h / 2 },
        90: { x: cx - h / 2, y: cy + w / 2 },
        180: { x: cx + w / 2, y: cy + h / 2 },
        270: { x: cx + h / 2, y: cy - w / 2 },
      }[rot as 0 | 90 | 180 | 270]
      sheetPage.drawPage(e, { x: pos.x, y: pos.y, width: w, height: h, rotate: degrees(-rot) })
    }
  }
  return out.save()
}

// ──────────────────────────────────────────────────────── metadata

export interface Metadata {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
  producer: string
}

export async function readMetadata(bytes: Uint8Array): Promise<Metadata> {
  const doc = await load(bytes)
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
  }
}

export async function writeMetadata(bytes: Uint8Array, m: Metadata): Promise<Uint8Array> {
  const doc = await load(bytes)
  doc.setTitle(m.title)
  doc.setAuthor(m.author)
  doc.setSubject(m.subject)
  doc.setKeywords(m.keywords ? m.keywords.split(/[,;，]\s*/) : [])
  doc.setCreator(m.creator)
  doc.setProducer(m.producer)
  return doc.save({ updateFieldAppearances: false })
}

// ──────────────────────────────────────────────────────── reverse / delete

export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const src = await load(bytes)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, order)
  copied.forEach((p) => out.addPage(p))
  return out.save()
}
