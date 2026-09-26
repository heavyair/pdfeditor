import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import type { Engine } from './engine'
import * as ops from './mupdfOps'
import * as tools from './pageTools'

const engine: Engine = {
  redact: async (b, r) => ops.redact(b, r),
  textOverlay: async (p) => ops.textOverlay(p),
  coverage: async (s) => ops.coverage(s),
  textWidth: async (s, n) => ops.textWidth(s, n),
  fillForm: async (b, v, f) => ops.fillForm(b, v, f),
}

async function make(n: number, rotations: number[] = []): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const f = await d.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < n; i++) {
    const p = d.addPage([300, 400])
    p.drawText(`P${i + 1}`, { x: 140, y: 200, size: 20, font: f })
    if (rotations[i]) p.setRotation(degrees(rotations[i]))
  }
  return d.save()
}

/** text items with their position in *visual* (rotated, top-down) page space */
async function items(bytes: Uint8Array, pageNo = 1) {
  const pdf = await getDocument({ data: bytes.slice() }).promise
  const page = await pdf.getPage(pageNo)
  const vp = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  return {
    vw: vp.width,
    vh: vp.height,
    list: tc.items.flatMap((it) => {
      if (!('str' in it) || !it.str.trim()) return []
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5])
      // text direction in viewport space: upright text runs left -> right
      const [x2, y2] = vp.convertToViewportPoint(it.transform[4] + it.transform[0], it.transform[5] + it.transform[1])
      return [{ str: it.str, x, y, dx: x2 - x, dy: y2 - y }]
    }),
  }
}

describe('page numbers', () => {
  it('puts upright numbers at the visual bottom-right, also on rotated pages', async () => {
    const src = await make(3, [0, 90, 270])
    const out = await tools.addPageNumbers(src, { template: 'Page {n} of {total}', position: 'bottom-right', size: 10, color: '#000000', margin: 20, startAt: 1 })
    for (let i = 1; i <= 3; i++) {
      const { vw, vh, list } = await items(out, i)
      const it = list.find((x) => x.str.startsWith('Page'))!
      expect(it.str).toBe(`Page ${i} of 3`)
      expect(it.x).toBeGreaterThan(vw / 2)
      expect(it.y).toBeGreaterThan(vh - 30)
      expect(it.dx).toBeGreaterThan(0) // reads left to right on screen
      expect(Math.abs(it.dy)).toBeLessThan(0.01)
    }
  })
  it('supports Chinese templates', async () => {
    const out = await tools.addPageNumbers(await make(2), { template: '第 {n} 页', position: 'bottom-center', size: 10, color: '#000000', margin: 20, startAt: 1 }, engine)
    expect((await items(out, 2)).list.map((x) => x.str).join('')).toContain('第 2 页')
  })
})

describe('watermark', () => {
  it('stamps centred diagonal text', async () => {
    const out = await tools.addWatermark(await make(1, [90]), { kind: 'text', text: 'CONFIDENTIAL', size: 40, color: '#ff0000', opacity: 0.3, angle: 45, layout: 'center', imageScale: 0.5 })
    const { vw, vh, list } = await items(out)
    const it = list.find((x) => x.str === 'CONFIDENTIAL')!
    expect(it.dx).toBeGreaterThan(0)
    expect(it.dy).toBeLessThan(0) // rising to the right on screen
    expect(Math.abs(it.x - vw / 2)).toBeLessThan(vw / 2)
    expect(Math.abs(it.y - vh / 2)).toBeLessThan(vh / 2)
  })
  it('tiles Chinese watermarks through the engine', async () => {
    const out = await tools.addWatermark(await make(1), { kind: 'text', text: '内部资料', size: 30, color: '#888888', opacity: 0.2, angle: 30, layout: 'tile', imageScale: 0.5 }, engine)
    expect((await items(out)).list.filter((x) => x.str.includes('内部资料')).length).toBeGreaterThan(3)
  })
})

describe('rotate / crop / n-up / metadata', () => {
  it('rotates selected pages', async () => {
    const out = await tools.rotatePages(await make(3), 90, [1])
    const d = await PDFDocument.load(out)
    expect(d.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 0])
  })
  it('crops visual margins', async () => {
    const out = await tools.cropPages(await make(1, [90]), { top: 10, right: 20, bottom: 30, left: 40 })
    const box = (await PDFDocument.load(out)).getPage(0).getCropBox()
    // visual page is 400x300; after crop it is 340x260 visually => unrotated 260 x 340
    expect(Math.round(box.width)).toBe(260)
    expect(Math.round(box.height)).toBe(340)
  })
  it('lays out 4 pages per sheet in reading order, handling rotated pages', async () => {
    const out = await tools.nUp(await make(5, [0, 90, 0, 0, 0]), 4, 'A4')
    const d = await PDFDocument.load(out)
    expect(d.getPageCount()).toBe(2)
    const { vw, vh, list } = await items(out, 1)
    const pos = Object.fromEntries(list.map((x) => [x.str, x]))
    expect(pos.P1.x).toBeLessThan(vw / 2)
    expect(pos.P1.y).toBeLessThan(vh / 2)
    expect(pos.P2.x).toBeGreaterThan(vw / 2)
    expect(pos.P2.y).toBeLessThan(vh / 2)
    expect(pos.P3.y).toBeGreaterThan(vh / 2)
    expect(pos.P4.x).toBeGreaterThan(vw / 2)
    // P2's page was rotated 90°: its text is displayed rotated too
    expect(Math.abs(pos.P2.dx)).toBeLessThan(0.01)
  })
  it('reads and writes metadata', async () => {
    const out = await tools.writeMetadata(await make(1), { title: '报告', author: 'Ada', subject: 's', keywords: 'a, b', creator: 'c', producer: 'p' })
    const m = await tools.readMetadata(out)
    expect(m.title).toBe('报告')
    expect(m.author).toBe('Ada')
    expect(m.keywords).toBe('a b')
  })
})
