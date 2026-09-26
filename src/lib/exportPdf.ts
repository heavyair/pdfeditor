import {
  BlendMode,
  LineCapStyle,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObjectCopier,
  PDFRef,
  PDFString,
  degrees,
  rgb,
  type PDFPage,
} from 'pdf-lib'
import type { Engine } from './engine'
import { BASELINE, LINE_HEIGHT } from './fonts'
import type { FormValues, RedactRequest } from './mupdfOps'
import { TextPainter, type LineRasterizer } from './textLayer'
import type { Annot, PageModel } from './types'
import { dataUrlToBytes, hexToRgb01 } from './util'

export interface SourceBytes {
  id: string
  bytes: Uint8Array
}

export interface ExportOptions {
  engine?: Engine
  rasterize?: LineRasterizer
  /** form values per source id */
  formValues?: Record<string, FormValues>
  flattenForms?: boolean
}

const color = (hex: string) => rgb(...hexToRgb01(hex))

/**
 * Build the final PDF:
 * 1. fill form fields in each source (MuPDF regenerates appearances; optional flatten)
 * 2. copy the pages in the user's order, apply rotation, keep form fields working
 * 3. apply true redactions (MuPDF deletes the content under redaction boxes)
 * 4. draw annotations; add links, notes and OCR text layers
 */
export async function exportPdf(sources: SourceBytes[], pages: PageModel[], opts: ExportOptions = {}): Promise<Uint8Array> {
  const { engine } = opts

  // 1 ── forms
  const srcBytes = new Map<string, Uint8Array>()
  for (const s of sources) {
    const values = opts.formValues?.[s.id]
    if (values && Object.keys(values).length) {
      if (!engine) throw new Error('Form filling needs the PDF engine')
      srcBytes.set(s.id, await engine.fillForm(s.bytes, values, !!opts.flattenForms))
    } else if (opts.flattenForms && engine && pages.some((p) => p.srcId === s.id && p.fields?.length)) {
      srcBytes.set(s.id, await engine.fillForm(s.bytes, {}, true))
    } else {
      srcBytes.set(s.id, s.bytes)
    }
  }

  // 2 ── assemble
  let out = await PDFDocument.create()
  const loaded = new Map<string, PDFDocument>()
  const fieldRefs = new Map<string, PDFRef[]>()
  for (const pm of pages) {
    let page: PDFPage
    if (pm.srcId) {
      let src = loaded.get(pm.srcId)
      if (!src) {
        const bytes = srcBytes.get(pm.srcId)
        if (!bytes) throw new Error('Missing source document')
        src = await PDFDocument.load(bytes, { ignoreEncryption: true })
        loaded.set(pm.srcId, src)
      }
      const [copied] = await out.copyPages(src, [pm.srcIndex])
      page = out.addPage(copied)
      collectFields(out, page, pm.srcId, fieldRefs)
    } else {
      page = out.addPage([pm.width, pm.height])
    }
    page.setRotation(degrees((((pm.baseRotation + pm.rotation) % 360) + 360) % 360))
  }
  rebuildAcroForm(out, loaded, fieldRefs)

  // 3 ── true redaction
  const requests: RedactRequest[] = []
  pages.forEach((pm, index) => {
    const rects = pm.annots.flatMap((a) =>
      (a.type === 'rect' || a.type === 'ellipse') && a.redact ? [{ a, mode: a.redact }] : [],
    )
    if (!rects.length) return
    const box = out.getPage(index).getCropBox()
    requests.push({
      index,
      rects: rects.map(({ a, mode }) => ({
        rect: [box.x + a.x, box.y + box.height - a.y - a.h, box.x + a.x + a.w, box.y + box.height - a.y] as [number, number, number, number],
        mode,
      })),
    })
  })
  let redacted = false
  if (requests.length) {
    if (!engine) throw new Error('Redaction needs the PDF engine')
    out = await PDFDocument.load(await engine.redact(await out.save(), requests))
    redacted = true
  }

  // 4 ── annotations
  const painter = new TextPainter(out, engine, opts.rasterize)
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()
  const getImage = async (src: string) => {
    let img = images.get(src)
    if (!img) {
      const bytes = dataUrlToBytes(src)
      img = /^data:image\/jpe?g/i.test(src) ? await out.embedJpg(bytes) : await out.embedPng(bytes)
      images.set(src, img)
    }
    return img
  }
  const allPages = out.getPages()
  for (let i = 0; i < pages.length; i++) {
    const pm = pages[i]
    const page = allPages[i]
    const box = page.getCropBox()
    const X = (x: number) => box.x + x
    const Y = (y: number) => box.y + box.height - y
    for (const a of pm.annots) await drawAnnot(out, page, allPages, a, X, Y, getImage, painter, redacted)
    // OCR words hidden under a cover / whiteout / redaction are dropped from the text layer
    const covers = pm.annots.filter((a) => (a.type === 'rect' || a.type === 'ellipse') && (a.redact || (a.fill && a.opacity >= 0.99 && !a.highlight))) as { x: number; y: number; w: number; h: number }[]
    const hidden = (w: { x: number; y: number; w: number; h: number }) => {
      const cx = w.x + w.w / 2, cy = w.y + w.h / 2
      return covers.some((c) => cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h)
    }
    for (const w of (pm.ocr?.words ?? []).filter((w) => !hidden(w))) {
      painter.add(page, { str: w.text, x: w.x, y: w.y + w.h * 0.8, size: w.h * 0.95, color: '#000000', width: w.w, invisible: true })
    }
  }
  await painter.flush()

  out.setProducer('Free PDF Editor')
  out.setCreator('Free PDF Editor')
  return out.save()
}

// ─────────────────────────────────────────────────────────── forms across copyPages

/** remember the top-level field of every widget on a copied page */
function collectFields(out: PDFDocument, page: PDFPage, srcId: string, acc: Map<string, PDFRef[]>) {
  const annots = page.node.Annots()
  if (!annots) return
  const list = acc.get(srcId) ?? []
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i)
    const found = out.context.lookup(ref)
    if (!(found instanceof PDFDict) || found.get(PDFName.of('Subtype'))?.toString() !== '/Widget') continue
    let dict: PDFDict = found
    let topRef = ref instanceof PDFRef ? ref : null
    for (let guard = 0; guard < 20; guard++) {
      const parent = dict.get(PDFName.of('Parent'))
      if (!(parent instanceof PDFRef)) break
      topRef = parent
      dict = out.context.lookup(parent) as PDFDict
    }
    if (topRef && !list.some((r) => r === topRef)) list.push(topRef)
  }
  acc.set(srcId, list)
}

/** copyPages keeps widgets but not the /AcroForm dictionary: recreate it so fields stay fillable */
function rebuildAcroForm(out: PDFDocument, loaded: Map<string, PDFDocument>, fieldRefs: Map<string, PDFRef[]>) {
  const refs = [...fieldRefs.values()].flat()
  if (!refs.length) return
  const fields = out.context.obj(refs) as PDFArray
  const acro = out.context.obj({ Fields: fields }) as PDFDict
  for (const [srcId] of fieldRefs) {
    const src = loaded.get(srcId)
    const srcAcro = src?.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
    if (!src || !srcAcro) continue
    const copier = PDFObjectCopier.for(src.context, out.context)
    for (const key of ['DA', 'DR', 'Q']) {
      const v = srcAcro.get(PDFName.of(key))
      if (v && !acro.get(PDFName.of(key))) acro.set(PDFName.of(key), copier.copy(v))
    }
  }
  out.catalog.set(PDFName.of('AcroForm'), out.context.register(acro))
}

// ─────────────────────────────────────────────────────────── drawing

async function drawAnnot(
  doc: PDFDocument,
  page: PDFPage,
  allPages: PDFPage[],
  a: Annot,
  X: (x: number) => number,
  Y: (y: number) => number,
  getImage: (src: string) => Promise<Awaited<ReturnType<PDFDocument['embedPng']>>>,
  painter: TextPainter,
  redacted: boolean,
) {
  switch (a.type) {
    case 'rect':
    case 'ellipse': {
      // content under a text-redaction box was deleted: no need to paint the preview cover
      if (a.redact === 'text' && redacted) return
      const common = {
        color: a.fill ? color(a.fill) : undefined,
        opacity: a.opacity,
        borderColor: a.stroke ? color(a.stroke) : undefined,
        borderWidth: a.stroke ? a.strokeWidth : 0,
        borderOpacity: a.opacity,
      }
      if (a.type === 'rect') {
        page.drawRectangle({ x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h, ...common, blendMode: a.highlight ? BlendMode.Multiply : undefined })
      } else {
        page.drawEllipse({ x: X(a.x + a.w / 2), y: Y(a.y + a.h / 2), xScale: a.w / 2, yScale: a.h / 2, ...common })
      }
      return
    }
    case 'image': {
      const img = await getImage(a.src)
      page.drawImage(img, { x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h })
      return
    }
    case 'draw': {
      if (a.points.length < 2) return
      const d = a.points.map(([px, py], i) => `${i ? 'L' : 'M'}${(px * a.w).toFixed(2)} ${(py * a.h).toFixed(2)}`).join(' ')
      // drawSvgPath uses SVG (y-down) coordinates relative to the given origin
      page.drawSvgPath(d, { x: X(a.x), y: Y(a.y), borderColor: color(a.color), borderWidth: a.strokeWidth, borderLineCap: LineCapStyle.Round })
      return
    }
    case 'line': {
      const x1 = X(a.x), y1 = Y(a.y), x2 = X(a.x + a.w), y2 = Y(a.y + a.h)
      const len = Math.hypot(x2 - x1, y2 - y1)
      const head = Math.max(6, a.strokeWidth * 4)
      let ex = x2, ey = y2
      if (a.arrow && len > head) {
        // stop the shaft at the base of the arrow head
        ex = x2 - ((x2 - x1) / len) * head * 0.8
        ey = y2 - ((y2 - y1) / len) * head * 0.8
      }
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: ex, y: ey }, thickness: a.strokeWidth, color: color(a.color), lineCap: LineCapStyle.Round })
      if (a.arrow && len > 0) {
        const ang = Math.atan2(y2 - y1, x2 - x1)
        const p = (da: number) => [x2 - head * Math.cos(ang + da), y2 - head * Math.sin(ang + da)]
        const [l, r] = [p(0.45), p(-0.45)]
        // drawSvgPath flips y, so give it coordinates relative to (0, 0) with y negated
        page.drawSvgPath(`M${x2} ${-y2} L${l[0]} ${-l[1]} L${r[0]} ${-r[1]} Z`, { x: 0, y: 0, color: color(a.color) })
      }
      return
    }
    case 'text': {
      a.text.split('\n').forEach((line, i) => {
        painter.add(page, {
          str: line,
          x: a.x,
          y: a.y + (i * LINE_HEIGHT + BASELINE[a.font]) * a.fontSize,
          size: a.fontSize,
          color: a.color,
          font: a.font,
          bold: a.bold,
          italic: a.italic,
        })
      })
      return
    }
    case 'link': {
      const x0 = X(a.x), y0 = Y(a.y + a.h), x1 = X(a.x + a.w), y1 = Y(a.y)
      const m = a.url.match(/^#(\d+)$/)
      let action: Record<string, unknown>
      if (m) {
        const target = allPages[Math.min(allPages.length, Math.max(1, parseInt(m[1], 10))) - 1]
        action = { Dest: [target.ref, 'Fit'] }
      } else {
        const url = /^[a-z][a-z0-9+.-]*:/i.test(a.url) ? a.url : `https://${a.url}`
        action = { A: { S: 'URI', URI: PDFString.of(url) } }
      }
      const ref = doc.context.register(
        doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x0, y0, x1, y1], Border: [0, 0, 0], ...action }),
      )
      page.node.addAnnot(ref)
      return
    }
    case 'note': {
      const ref = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [X(a.x), Y(a.y + 20), X(a.x + 20), Y(a.y)],
          Contents: PDFHexString.fromText(a.text),
          Name: 'Comment',
          C: hexToRgb01(a.color),
          T: PDFHexString.fromText('Free PDF Editor'),
          F: 4,
        }),
      )
      page.node.addAnnot(ref)
      return
    }
  }
}
