import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { exportPdf } from './exportPdf'
import { mergePdfs, splitPdf } from './pageOps'
import type { PageModel } from './types'

// 1x1 red PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

async function makePdf(labels: string[], size: [number, number] = [300, 400]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const l of labels) {
    const p = doc.addPage(size)
    p.drawText(l, { x: 20, y: size[1] - 40, size: 20, font })
  }
  return doc.save()
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise
  const out: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent()
    out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim())
  }
  return out
}

describe('merge & split', () => {
  it('merges selected pages and images in order', async () => {
    const a = await makePdf(['A1', 'A2', 'A3'])
    const b = await makePdf(['B1'])
    const out = await mergePdfs([
      { kind: 'pdf', bytes: b },
      { kind: 'pdf', bytes: a, pages: [2, 0] },
      { kind: 'image', bytes: new Uint8Array(), src: PNG },
    ])
    expect(await pageTexts(out)).toEqual(['B1', 'A3', 'A1', ''])
  })

  it('splits into groups', async () => {
    const a = await makePdf(['P1', 'P2', 'P3', 'P4', 'P5'])
    const parts = await splitPdf(a, [[0, 1], [4], [2, 3]])
    expect(parts).toHaveLength(3)
    expect(await pageTexts(parts[0])).toEqual(['P1', 'P2'])
    expect(await pageTexts(parts[1])).toEqual(['P5'])
    expect(await pageTexts(parts[2])).toEqual(['P3', 'P4'])
  })
})

describe('exportPdf', () => {
  it('reorders, rotates, inserts blank pages and flattens annotations', async () => {
    const src = await makePdf(['First', 'Second'])
    const base = { width: 300, height: 400, baseRotation: 0, annots: [] }
    const pages: PageModel[] = [
      {
        ...base,
        id: 'p2',
        srcId: 's',
        srcIndex: 1,
        rotation: 90,
        annots: [
          { id: 't', type: 'text', x: 20, y: 100, text: 'Added line\nSecond line', fontSize: 12, color: '#ff0000', font: 'Times', bold: true, italic: false },
          { id: 'w', type: 'rect', x: 10, y: 10, w: 50, h: 20, fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 },
          { id: 'h', type: 'rect', x: 10, y: 50, w: 50, h: 20, fill: '#ffe14d', stroke: null, strokeWidth: 0, opacity: 0.5, highlight: true },
          { id: 'e', type: 'ellipse', x: 100, y: 200, w: 50, h: 30, fill: null, stroke: '#0000ff', strokeWidth: 2, opacity: 1 },
          { id: 'i', type: 'image', x: 100, y: 300, w: 40, h: 40, src: PNG },
          { id: 'd', type: 'draw', x: 150, y: 150, w: 60, h: 30, points: [[0, 0], [0.5, 1], [1, 0]], color: '#000000', strokeWidth: 2 },
        ],
      },
      { ...base, id: 'blank', srcId: null, srcIndex: 0, rotation: 0 },
      { ...base, id: 'p1', srcId: 's', srcIndex: 0, rotation: 0 },
    ]
    const out = await exportPdf([{ id: 's', bytes: src }], pages)
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(3)
    expect(doc.getPage(0).getRotation().angle).toBe(90)
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 400 })

    const texts = await pageTexts(out)
    expect(texts[0]).toContain('Second')
    expect(texts[0]).toContain('Added line')
    expect(texts[0]).toContain('Second line')
    expect(texts[1]).toBe('')
    expect(texts[2]).toBe('First')
  })

  it('positions text so its baseline matches the editor', async () => {
    const src = await makePdf(['x'])
    const out = await exportPdf(
      [{ id: 's', bytes: src }],
      [{ id: 'p', srcId: 's', srcIndex: 0, width: 300, height: 400, baseRotation: 0, rotation: 0,
        annots: [{ id: 't', type: 'text', x: 50, y: 100, text: 'Baseline', fontSize: 20, color: '#000000', font: 'Helvetica', bold: false, italic: false }] }],
    )
    const pdf = await getDocument({ data: out.slice() }).promise
    const tc = await (await pdf.getPage(1)).getTextContent()
    const item = tc.items.find((it) => 'str' in it && it.str === 'Baseline') as { transform: number[] }
    expect(item.transform[4]).toBeCloseTo(50, 1)
    // baseline (PDF y-up) = height - (y + 0.947 * fontSize)
    expect(item.transform[5]).toBeCloseTo(400 - (100 + 0.947 * 20), 1)
  })

  it('respects the source rotation and crop box offset', async () => {
    const doc = await PDFDocument.create()
    const p = doc.addPage([300, 400])
    p.setRotation(degrees(180))
    p.setCropBox(10, 20, 200, 300)
    const src = await doc.save()
    const out = await exportPdf(
      [{ id: 's', bytes: src }],
      [{ id: 'p', srcId: 's', srcIndex: 0, width: 200, height: 300, baseRotation: 180, rotation: 90,
        annots: [{ id: 't', type: 'text', x: 0, y: 0, text: 'Corner', fontSize: 10, color: '#000000', font: 'Courier', bold: false, italic: false }] }],
    )
    const res = await PDFDocument.load(out)
    expect(res.getPage(0).getRotation().angle).toBe(270)
    const pdf = await getDocument({ data: out.slice() }).promise
    const tc = await (await pdf.getPage(1)).getTextContent()
    const item = tc.items.find((it) => 'str' in it && it.str === 'Corner') as { transform: number[] }
    expect(item.transform[4]).toBeCloseTo(10, 1)
    expect(item.transform[5]).toBeCloseTo(20 + 300 - 0.866 * 10, 1)
  })

  it('refuses non-Latin text without a rasterizer', async () => {
    const src = await makePdf(['x'])
    await expect(
      exportPdf(
        [{ id: 's', bytes: src }],
        [{ id: 'p', srcId: 's', srcIndex: 0, width: 300, height: 400, baseRotation: 0, rotation: 0,
          annots: [{ id: 't', type: 'text', x: 0, y: 0, text: '你好', fontSize: 10, color: '#000000', font: 'Helvetica', bold: false, italic: false }] }],
      ),
    ).rejects.toThrow(/cannot encode/)
  })
})

// ───────────────────────────────────────── with the MuPDF engine

import * as mupdf from 'mupdf'
import type { Engine } from './engine'
import * as ops from './mupdfOps'

const engine: Engine = {
  redact: async (b, r) => ops.redact(b, r),
  textOverlay: async (p) => ops.textOverlay(p),
  coverage: async (s) => ops.coverage(s),
  textWidth: async (s, n) => ops.textWidth(s, n),
  fillForm: async (b, v, f) => ops.fillForm(b, v, f),
}
const onePage = (annots: PageModel['annots'], extra: Partial<PageModel> = {}): PageModel[] => [
  { id: 'p', srcId: 's', srcIndex: 0, width: 300, height: 400, baseRotation: 0, rotation: 0, annots, ...extra },
]

describe('exportPdf + engine', () => {
  it('truly removes retyped text and embeds CJK replacement text', async () => {
    const src = await makePdf(['Total 1250'])
    // makePdf draws at x=20, baseline 360 (top-down y=40), size 20
    const out = await exportPdf([{ id: 's', bytes: src }], onePage([
      { id: 'c', type: 'rect', x: 18, y: 20, w: 150, h: 26, fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1, redact: 'text' },
      { id: 't', type: 'text', x: 20, y: 21, text: '合计 990', fontSize: 20, color: '#000000', font: 'Helvetica', bold: false, italic: false },
    ]), { engine })
    const t = (await pageTexts(out))[0]
    expect(t).not.toContain('1250')
    expect(t).toContain('合计 990')
  })

  it('redacts everything under a redaction box and paints it', async () => {
    const src = await makePdf(['Secret'])
    const out = await exportPdf([{ id: 's', bytes: src }], onePage([
      { id: 'r', type: 'rect', x: 10, y: 15, w: 200, h: 35, fill: '#000000', stroke: null, strokeWidth: 0, opacity: 1, redact: 'all' },
    ]), { engine })
    expect((await pageTexts(out))[0]).toBe('')
    const pix = mupdf.Document.openDocument(out, 'application/pdf').loadPage(0).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false)
    const px = pix.getPixels()
    const at = (x: number, y: number) => px[(y * pix.getWidth() + x) * 3]
    expect(at(100, 30)).toBeLessThan(20) // painted black
  })

  it('adds links, notes, lines and an invisible OCR layer', async () => {
    const src = await makePdf(['x', 'y'])
    const pages = onePage(
      [
        { id: 'l', type: 'link', x: 10, y: 10, w: 100, h: 20, url: 'example.com' },
        { id: 'l2', type: 'link', x: 10, y: 50, w: 100, h: 20, url: '#2' },
        { id: 'n', type: 'note', x: 200, y: 100, text: 'Please check 请检查', color: '#ffd400' },
        { id: 'a', type: 'line', x: 50, y: 200, w: 100, h: -50, color: '#ff0000', strokeWidth: 2, arrow: true },
      ],
      { ocr: { words: [{ text: 'Scanned', x: 20, y: 300, w: 80, h: 14 }], lines: [] } },
    )
    pages.push({ ...pages[0], id: 'p2', srcIndex: 1, annots: [], ocr: undefined })
    const out = await exportPdf([{ id: 's', bytes: src }], pages, { engine })
    const pdf = await getDocument({ data: out.slice() }).promise
    const annots = await (await pdf.getPage(1)).getAnnotations()
    const link = annots.find((a) => a.subtype === 'Link' && a.url)
    expect(link?.url).toBe('https://example.com/')
    expect(annots.some((a) => a.subtype === 'Link' && a.dest)).toBe(true)
    expect(annots.find((a) => a.subtype === 'Text')?.contentsObj?.str).toBe('Please check 请检查')
    expect((await pageTexts(out))[0]).toContain('Scanned')
  })

  it('keeps form fields fillable after reordering pages, and fills values', async () => {
    const d = await PDFDocument.create()
    d.addPage([300, 400])
    const p2 = d.addPage([300, 400])
    d.getForm().createTextField('email').addToPage(p2, { x: 20, y: 300, width: 200, height: 24 })
    const src = await d.save()
    const pages: PageModel[] = [
      { id: 'b', srcId: 's', srcIndex: 1, width: 300, height: 400, baseRotation: 0, rotation: 0, annots: [], fields: [] },
      { id: 'a', srcId: 's', srcIndex: 0, width: 300, height: 400, baseRotation: 0, rotation: 0, annots: [] },
    ]
    const out = await exportPdf([{ id: 's', bytes: src }], pages, { engine, formValues: { s: { email: 'a@b.co' } } })
    const form = (await PDFDocument.load(out)).getForm()
    expect(form.getTextField('email').getText()).toBe('a@b.co')

    const flat = await exportPdf([{ id: 's', bytes: src }], pages, { engine, formValues: { s: { email: 'a@b.co' } }, flattenForms: true })
    expect((await PDFDocument.load(flat)).getForm().getFields()).toHaveLength(0)
    expect((await pageTexts(flat))[0]).toContain('a@b.co')
  })
})

describe('OCR text layer', () => {
  it('drops OCR words covered by a replacement', async () => {
    const src = await makePdf([''])
    const out = await exportPdf([{ id: 's', bytes: src }], onePage(
      [{ id: 'c', type: 'rect', x: 18, y: 98, w: 104, h: 18, fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 }],
      { ocr: { words: [{ text: 'Old', x: 20, y: 100, w: 40, h: 14 }, { text: 'Kept', x: 20, y: 200, w: 40, h: 14 }], lines: [] } },
    ), { engine })
    const t = (await pageTexts(out))[0]
    expect(t).toContain('Kept')
    expect(t).not.toContain('Old')
  })
})
