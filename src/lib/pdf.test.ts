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
